// Text generation for the warm-up: a local Ollama model (default) or an external OpenAI-compatible API.
// The API key is read from AGENTAUTO_AI_KEY only; it is never stored in config.json nor printed.
// Spend is tracked per call in <data>/ai-usage.json and enforces a daily budget.
import { PRESETS, estimateCost, findModel, priceAt } from './ai-presets.js';
import { UsageLedger } from './ai-usage.js';
import { cleanMessage, generateLocal, resolveLocalModel } from './local-model.js';

export const KEY_ENV = 'AGENTAUTO_AI_KEY';
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_BUDGET_USD = 1;

export class MissingKeyError extends Error {
  constructor(label) {
    super(`Falta la API key de ${label}: guárdala en la sección IA de la app (se pasa al motor por ${KEY_ENV}).`);
    this.name = 'MissingKeyError';
  }
}

// Fatal for the run: callers must not retry after it.
export class BudgetStopError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetStopError';
    this.fatal = true;
  }
}

const trimSlash = (url) => String(url).replace(/\/+$/, '');
const usd = (value) => `$${value.toFixed(2)}`;

// Normalizes config.json into what the engine needs. Without an `ai` key it is exactly the old localModel.
export function resolveAiConfig(config = {}) {
  const ai = config?.ai;
  const local = resolveLocalModel(config);

  if (!ai || ai.provider !== 'openai-compatible') {
    return {
      provider: 'ollama',
      baseUrl: ai?.baseUrl || local.url,
      model: ai?.model || local.model,
      label: `${ai?.model || local.model} (local, Ollama; no paid API)`,
      local,
    };
  }

  const preset = Object.hasOwn(PRESETS, ai.preset) ? PRESETS[ai.preset] : PRESETS.custom;
  const known = findModel(ai.preset, ai.model);
  const modelInfo = {
    inUsd: 0,
    outUsd: 0,
    ...(known ?? {}),
    ...(ai.prices ?? {}),
    extraBody: { ...(known?.extraBody ?? {}), ...(ai.extraBody ?? {}) },
  };
  const fallbackModel = ai.fallbackLocalModel || local.model;
  return {
    provider: 'openai-compatible',
    preset: ai.preset || 'custom',
    presetLabel: preset.label,
    keyOptional: Boolean(preset.keyOptional),
    baseUrl: ai.baseUrl || preset.baseUrl,
    model: ai.model,
    modelInfo,
    dailyBudgetUsd: Number.isFinite(Number(ai.dailyBudgetUsd)) ? Number(ai.dailyBudgetUsd) : DEFAULT_BUDGET_USD,
    onBudgetExceeded: ai.onBudgetExceeded === 'stop' ? 'stop' : 'fallback-local',
    fallbackLocal: { url: local.url, model: fallbackModel },
    label: `${ai.model} (API externa: ${preset.label})`,
    local,
  };
}

function redact(text, key) {
  const value = String(text ?? '');
  return key ? value.split(key).join('***') : value;
}

const textOf = (value) => (typeof value === 'string' ? value : '');

// One OpenAI-style chat completion. Returns { text, promptTokens, completionTokens }.
export async function chatCompletion({ settings, key, system, prompt, maxTokens, fetchImpl }) {
  const info = settings.modelInfo;
  const body = {
    model: settings.model,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    ...(info.noTemperature ? {} : { temperature: 0.9 }),
    [info.tokenParam || 'max_tokens']: maxTokens,
    ...info.extraBody,
  };
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;

  let response;
  try {
    response = await fetchImpl(`${trimSlash(settings.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(redact(`${settings.presetLabel}: ${error?.message || error}`, key));
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(redact(`${settings.presetLabel} ${response.status}: ${detail}`, key).slice(0, 400).trim());
  }

  const data = await response.json();
  const text = cleanMessage(textOf(data.choices?.[0]?.message?.content));
  const usage = data.usage;
  const promptTokens = Number.isFinite(usage?.prompt_tokens)
    ? usage.prompt_tokens
    : Math.ceil((system.length + prompt.length) / 4);
  const completionTokens = Number.isFinite(usage?.completion_tokens)
    ? usage.completion_tokens
    : Math.ceil(text.length / 4);
  return { text, promptTokens, completionTokens };
}

export function createAi({
  config,
  env = process.env,
  dataDir,
  fetchImpl = fetch,
  log = console.log,
  now = () => new Date(),
  // Ends the run (same path as Ctrl+C: closes the WhatsApp sessions cleanly).
  onStop = () => process.emit('SIGINT'),
}) {
  const settings = resolveAiConfig(config);

  if (settings.provider === 'ollama') {
    return {
      label: settings.label,
      settings,
      generate: ({ system, prompt, maxTokens = 120 }) =>
        generateLocal({ url: settings.baseUrl, model: settings.model, system, prompt, maxTokens, fetchImpl }),
    };
  }

  const key = String(env?.[KEY_ENV] ?? '').trim();
  if (!key && !settings.keyOptional) throw new MissingKeyError(settings.presetLabel);

  const ledger = new UsageLedger(dataDir, { now });
  let announced = false;
  let stopped = false;

  const overBudget = () => settings.dailyBudgetUsd > 0 && ledger.todayUsd() >= settings.dailyBudgetUsd;

  function announce() {
    if (announced) return;
    announced = true;
    const spent = usd(ledger.todayUsd());
    const limit = usd(settings.dailyBudgetUsd);
    if (settings.onBudgetExceeded === 'stop') {
      log(`[ai] Daily AI budget reached (${spent} of ${limit}): stopping the run.`);
    } else {
      log(
        `[ai] Daily AI budget reached (${spent} of ${limit}): switching to the local model ${settings.fallbackLocal.model} for the rest of the day.`,
      );
    }
  }

  return {
    label: settings.label,
    settings,
    async generate({ system, prompt, maxTokens = 120 }) {
      if (overBudget()) {
        announce();
        if (settings.onBudgetExceeded === 'stop') {
          if (!stopped) {
            stopped = true;
            onStop();
          }
          throw new BudgetStopError('Daily AI budget reached.');
        }
        return generateLocal({
          url: settings.fallbackLocal.url,
          model: settings.fallbackLocal.model,
          system,
          prompt,
          maxTokens,
          fetchImpl,
        });
      }

      const result = await chatCompletion({ settings, key, system, prompt, maxTokens, fetchImpl });
      ledger.record({
        provider: settings.preset,
        model: settings.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        usd: estimateCost(priceAt(settings.modelInfo, now()), result.promptTokens, result.completionTokens),
      });
      return result.text;
    },
  };
}
