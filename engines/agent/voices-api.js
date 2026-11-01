// Command layer of the "Voces" section (ElevenLabs): key test, voice list, subscription, presets, estimates and manual
// generation. The key is only read from the process env (AGENTAUTO_ELEVEN_KEY, filled by the Rust side from the Windows
// keyring); it is never returned, logged or written. Every function takes its dependencies so tests can fake fetch.
import fs from 'node:fs';
import path from 'node:path';

import { listProducts } from './creativo-map.js';
import { MediaError, outputDir, safeStem, writeWithoutOverwrite } from './creativo-media.js';
import { creativoRoot } from './creativo-workspace.js';
import { createClient, DEFAULT_MODEL, ElevenError, estimateVoice, findPreset, KNOWN_MODELS, loadPresets, MAX_TEXT_CHARS, savePresets } from './elevenlabs.js';

export class VoicesError extends Error {}

export const COMMANDS = ['key-test', 'voices', 'subscription', 'presets-get', 'presets-set', 'estimate', 'generate', 'audio-read', 'context'];
/** Commands that call ElevenLabs (the Rust side injects the key only for these). */
export const NEEDS_KEY = ['key-test', 'voices', 'subscription', 'generate'];

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const need = (cond, message) => {
  if (!cond) throw new VoicesError(message);
};

function resolveVoice({ dataDir, payload }) {
  const presets = loadPresets(dataDir);
  const preset = payload.presetId ? findPreset(presets, { preset: payload.presetId }) : null;
  need(!payload.presetId || preset, 'No encuentro ese preset.');
  const voiceId = payload.voiceId || preset?.voiceId;
  need(voiceId, 'Elige un preset o una voz.');
  return {
    voiceId,
    modelId: payload.modelId || preset?.modelId || DEFAULT_MODEL,
    settings: preset ? { stability: preset.stability, similarity: preset.similarity, style: preset.style, speakerBoost: preset.speakerBoost } : {},
    preset,
  };
}

/**
 * @param {string} command one of COMMANDS
 * @param {object} payload
 * @param {{ dataDir: string, env?: object, fetchFn?: Function, root?: string }} deps
 */
export async function runVoicesCommand(command, payload, { dataDir, env = process.env, fetchFn, root = creativoRoot(env) }) {
  need(COMMANDS.includes(command), `Comando de voces no permitido: ${command}.`);
  const client = () => {
    try {
      return createClient({ key: env.AGENTAUTO_ELEVEN_KEY, fetchFn });
    } catch (error) {
      throw new VoicesError(error.message);
    }
  };
  try {
    switch (command) {
      case 'context':
        return { root, products: listProducts(root), models: KNOWN_MODELS, defaultModel: DEFAULT_MODEL, maxChars: MAX_TEXT_CHARS };
      case 'key-test': {
        const sub = await client().subscription();
        return { ok: true, tier: sub.tier, remaining: sub.remaining, limit: sub.limit };
      }
      case 'voices':
        return { voices: await client().voices() };
      case 'subscription':
        return { subscription: await client().subscription() };
      case 'presets-get':
        return { presets: loadPresets(dataDir) };
      case 'presets-set': {
        need(Array.isArray(payload.presets) && payload.presets.length <= 200, 'Los presets no son válidos.');
        return { presets: savePresets(dataDir, payload.presets) };
      }
      case 'estimate': {
        const preset = payload.presetId ? findPreset(loadPresets(dataDir), { preset: payload.presetId }) : null;
        return estimateVoice({ text: payload.text, modelId: payload.modelId || preset?.modelId || DEFAULT_MODEL });
      }
      case 'generate': {
        const text = String(payload.text ?? '');
        need(text.trim(), 'Escribe el texto del audio.');
        need([...text].length <= MAX_TEXT_CHARS, `El texto supera ${MAX_TEXT_CHARS} caracteres; divídelo en partes.`);
        const voice = resolveVoice({ dataDir, payload });
        // The estimate shown to the user must match what is spent: the caller confirms it before sending `confirmed`.
        const estimate = estimateVoice({ text, modelId: voice.modelId });
        need(payload.confirmed === true && Number(payload.confirmedCredits) === estimate.credits, 'Confirma primero el costo estimado en créditos.');
        let dir;
        if (payload.outputDir) {
          dir = path.resolve(String(payload.outputDir));
          need(path.isAbsolute(dir) && !/[\0\r\n]/.test(dir), 'La carpeta de destino no es válida.');
        } else {
          dir = outputDir({ root, product: payload.product, country: payload.country, kind: 'audio' });
        }
        const bytes = await client().tts({ voiceId: voice.voiceId, text, modelId: voice.modelId, settings: voice.settings });
        const file = writeWithoutOverwrite(bytes, dir, safeStem(payload.filename, `audio-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`), '.mp3');
        return { file, chars: estimate.chars, credits: estimate.credits, preset: voice.preset?.name ?? null };
      }
      case 'audio-read': {
        const file = path.resolve(String(payload.path ?? ''));
        need(/\.mp3$/i.test(file) && fs.existsSync(file), 'Solo puedo reproducir archivos .mp3 existentes.');
        need(fs.statSync(file).size <= MAX_AUDIO_BYTES, 'El audio es demasiado grande para reproducirlo aquí.');
        return { dataUrl: `data:audio/mpeg;base64,${fs.readFileSync(file).toString('base64')}` };
      }
      default:
        throw new VoicesError(`Comando de voces no permitido: ${command}.`);
    }
  } catch (error) {
    if (error instanceof VoicesError) throw error;
    // ElevenLabs, media and preset validation errors are user-readable Spanish already.
    if (error instanceof ElevenError || error instanceof MediaError) throw new VoicesError(error.message);
    throw error;
  }
}
