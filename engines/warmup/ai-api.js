// Commands behind the app's "IA" section (ai-cli.js prints their result as JSON).
// The API key is never part of any payload or result: it only arrives through AGENTAUTO_AI_KEY.
import fs from 'node:fs';
import path from 'node:path';

import {
  RECOMMENDED_MODELS,
  deleteOllamaModel,
  detectServers,
  fitHint,
  listOllamaModels,
  psOllama,
  pullModel,
} from './ai-local.js';
import { KEY_ENV, MissingKeyError, chatCompletion, resolveAiConfig } from './ai-provider.js';
import { DAILY_PROFILE, PRESETS, PRICES_AS_OF, estimateCost, estimateDaily, priceAt } from './ai-presets.js';
import { bestGpu, defaultExec, detectGpus, gpuBanner, readResources } from './ai-system.js';
import { summarize } from './ai-usage.js';
import { generateLocal, isUsableMessage } from './local-model.js';
import { backupFile } from './profile-api.js';
import { writeJsonAtomic } from './profile-creation.js';
import { SelectionError } from './session-selection.js';

const SAMPLE_COUNT = 5;
const AI_FIELDS = [
  'provider',
  'preset',
  'baseUrl',
  'model',
  'dailyBudgetUsd',
  'onBudgetExceeded',
  'fallbackLocalModel',
  'localGpu',
  'prices',
  'extraBody',
];

const SAMPLE_SYSTEM =
  'Generate varied, coherent simulated WhatsApp test messages. The conversation is a casual chat between friends.';
const SAMPLE_PROMPT = [
  'You are Camila, 28, from Medellín, chatting in a WhatsApp group of friends.',
  'Topic: weekend plans.',
  'Write in Colombian Spanish, one or two short sentences, no markdown. Use "ustedes", never "vosotros" or "os".',
  'Return only the message to send.',
].join('\n');

function readConfig(dataDir) {
  const file = path.join(dataDir, 'config.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new SelectionError(`No encuentro config.json en ${dataDir}. Revisa la carpeta de datos en Ajustes.`);
  }
  try {
    return { file, config: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (error) {
    throw new SelectionError(`config.json no es un JSON válido: ${error.message}`);
  }
}

function ollamaUrl(config, payload) {
  const settings = resolveAiConfig(config);
  return String(payload.baseUrl || (settings.provider === 'ollama' ? settings.baseUrl : settings.local.url)).replace(/\/+$/, '');
}

// Local models the current config would use (blocked from deletion while a profile runs).
function activeLocalModels(config) {
  const settings = resolveAiConfig(config);
  return [settings.provider === 'ollama' ? settings.model : settings.fallbackLocal.model];
}

function sanitizeAi(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SelectionError('Falta la configuración de IA.');
  for (const field of Object.keys(input)) {
    if (/key|token|secret|password/i.test(field)) {
      throw new SelectionError('La API key no se guarda en config.json: va en el Administrador de credenciales de Windows.');
    }
  }
  const ai = {};
  for (const field of AI_FIELDS) if (input[field] !== undefined && input[field] !== null && input[field] !== '') ai[field] = input[field];

  if (!['ollama', 'openai-compatible'].includes(ai.provider)) throw new SelectionError('El proveedor de IA no es válido.');
  if (ai.provider === 'openai-compatible' && !String(ai.model ?? '').trim()) throw new SelectionError('Elige un modelo.');
  if (ai.dailyBudgetUsd !== undefined && !(Number.isFinite(Number(ai.dailyBudgetUsd)) && Number(ai.dailyBudgetUsd) >= 0)) {
    throw new SelectionError('El presupuesto diario debe ser un número mayor o igual a 0.');
  }
  if (ai.dailyBudgetUsd !== undefined) ai.dailyBudgetUsd = Number(ai.dailyBudgetUsd);
  if (ai.onBudgetExceeded !== undefined && !['fallback-local', 'stop'].includes(ai.onBudgetExceeded)) {
    throw new SelectionError('Qué hacer cuando se excede el presupuesto no es válido.');
  }
  if (ai.localGpu !== undefined && !['auto', 'cpu'].includes(ai.localGpu)) throw new SelectionError('La opción de tarjeta de video no es válida.');
  return ai;
}

function presets() {
  return {
    pricesAsOf: PRICES_AS_OF,
    profile: DAILY_PROFILE,
    presets: Object.entries(PRESETS).map(([id, preset]) => ({
      id,
      label: preset.label,
      recommended: Boolean(preset.recommended),
      baseUrl: preset.baseUrl,
      keyHint: preset.keyHint,
      keyOptional: Boolean(preset.keyOptional),
      models: preset.models.map((model) => ({
        id: model.id,
        label: model.label,
        inUsd: model.inUsd,
        outUsd: model.outUsd,
        offPeak: model.offPeak ?? null,
        ...estimateDaily(model),
      })),
    })),
  };
}

async function sampleOnce(call) {
  const started = Date.now();
  try {
    const { text, promptTokens, completionTokens, usd } = await call();
    return { ok: isUsableMessage(text), text, latencyMs: Date.now() - started, promptTokens, completionTokens, usd };
  } catch (error) {
    return { ok: false, text: '', error: String(error?.message || error), latencyMs: Date.now() - started, promptTokens: 0, completionTokens: 0, usd: 0 };
  }
}

async function aiTest(payload, { dataDir, env, fetchImpl, now }) {
  const { config } = readConfig(dataDir);
  const settings = resolveAiConfig({ ...config, ai: payload.ai });
  let call;
  let estimate = { usdDay: 0, usdMonth: 0 };

  if (settings.provider === 'ollama') {
    call = async () => ({
      text: await generateLocal({
        url: settings.baseUrl,
        model: settings.model,
        system: SAMPLE_SYSTEM,
        prompt: SAMPLE_PROMPT,
        cpuOnly: settings.local.cpuOnly,
        fetchImpl,
      }),
      promptTokens: null,
      completionTokens: null,
      usd: 0,
    });
  } else {
    const key = String(env?.[KEY_ENV] ?? '').trim();
    if (!key && !settings.keyOptional) throw new MissingKeyError(settings.presetLabel);
    estimate = estimateDaily(settings.modelInfo);
    call = async () => {
      const result = await chatCompletion({ settings, key, system: SAMPLE_SYSTEM, prompt: SAMPLE_PROMPT, maxTokens: 120, fetchImpl });
      return { ...result, usd: estimateCost(priceAt(settings.modelInfo, now), result.promptTokens, result.completionTokens) };
    };
  }

  const samples = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) samples.push(await sampleOnce(call));
  const okSamples = samples.filter((sample) => sample.ok);
  return {
    label: settings.label,
    samples,
    okCount: okSamples.length,
    avgLatencyMs: Math.round(samples.reduce((sum, sample) => sum + sample.latencyMs, 0) / samples.length),
    estimate: { ...estimate, ...DAILY_PROFILE },
  };
}

async function localDetect(payload, { dataDir, fetchImpl, exec }) {
  const { config } = readConfig(dataDir);
  const [servers, gpus] = await Promise.all([
    detectServers({ fetchImpl, extraUrl: payload.extraUrl }),
    detectGpus({ exec }),
  ]);
  const gpu = gpuBanner(gpus);
  const active = activeLocalModels(config);
  const ollamaServer = servers.find((server) => server.id === 'ollama');

  let installedModels = [];
  if (ollamaServer) {
    installedModels = (await listOllamaModels({ baseUrl: ollamaServer.baseUrl, fetchImpl }).catch(() => [])).map((model) => ({
      ...model,
      fit: fitHint(model.sizeBytes, gpus),
      inUse: active.includes(model.name),
    }));
  }
  const names = new Set(installedModels.map((model) => model.name));
  return {
    servers,
    gpus,
    gpu: { ...gpu, card: bestGpu(gpus) },
    ollama: ollamaServer ? { baseUrl: ollamaServer.baseUrl, version: ollamaServer.version, installedModels } : null,
    recommended: RECOMMENDED_MODELS.map((model) => ({
      ...model,
      installed: names.has(model.id),
      fit: fitHint(model.sizeGb * 1024 ** 3, gpus),
    })),
    suggestedForCpu: gpu.hasDedicated ? [] : ['gemma3:1b', 'qwen2.5:3b'],
    activeModels: active,
  };
}

async function localResources(payload, { dataDir, fetchImpl, exec }) {
  const { config } = readConfig(dataDir);
  const [loaded, resources] = await Promise.all([
    psOllama({ baseUrl: ollamaUrl(config, payload), fetchImpl }).catch(() => []),
    readResources({ exec }),
  ]);
  return { loaded, resources };
}

const COMMANDS = {
  presets: () => presets(),
  'config-get': (_payload, { dataDir }) => {
    const { config } = readConfig(dataDir);
    return { ai: config.ai ?? null, localModel: config.localModel ?? null };
  },
  'config-save': (payload, { dataDir, now }) => {
    const ai = sanitizeAi(payload.ai);
    const { file, config } = readConfig(dataDir);
    backupFile(file, now);
    writeJsonAtomic(file, { ...config, ai });
    return { ai };
  },
  'ai-usage': (_payload, { dataDir, now }) => summarize(dataDir, now),
  'ai-test': aiTest,
  'local-detect': localDetect,
  'local-resources': localResources,
  'local-delete': async (payload, { dataDir, fetchImpl }) => {
    const { config } = readConfig(dataDir);
    const blocked = String(payload.running ?? '').trim() ? activeLocalModels(config) : [];
    return deleteOllamaModel({ baseUrl: ollamaUrl(config, payload), model: String(payload.model ?? ''), blocked, fetchImpl });
  },
};

export async function runAiCommand(command, payload = {}, context = {}) {
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!handler) throw new SelectionError(`Comando desconocido: ${command}. Disponibles: ${Object.keys(COMMANDS).join(', ')}.`);
  return handler(payload ?? {}, {
    now: new Date(),
    env: process.env,
    fetchImpl: fetch,
    exec: defaultExec,
    ...context,
  });
}

// Streams a model download as NDJSON lines through `write` (the app turns them into a progress bar).
// Aborting `signal` (the app kills this process) cancels the download.
export async function runPull(payload, { dataDir, fetchImpl = fetch, write, signal }) {
  const { config } = readConfig(dataDir);
  await pullModel({
    baseUrl: ollamaUrl(config, payload),
    model: payload.model,
    fetchImpl,
    signal,
    onProgress: (progress) => write({ type: 'progress', model: String(payload.model).trim(), ...progress }),
  });
  write({ type: 'done', model: String(payload.model).trim(), percent: 100, done: true });
}
