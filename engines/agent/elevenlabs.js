// ElevenLabs client: request builders (pure), a small client with an injectable fetch, credit estimates and the voice
// presets file. The API key only ever arrives as a function argument (the callers read it from the child env that the
// Rust side fills from the Windows keyring); it is never logged, stored or put in an error message.
import fs from 'node:fs';
import path from 'node:path';

export const API_BASE = 'https://api.elevenlabs.io';
export const DEFAULT_MODEL = 'eleven_multilingual_v2';
export const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
export const MAX_TEXT_CHARS = 10_000;

// Models that bill half a credit per character; every other model bills one.
const HALF_PRICE = new Set(['eleven_flash_v2_5', 'eleven_flash_v2', 'eleven_turbo_v2_5', 'eleven_turbo_v2']);
export const KNOWN_MODELS = Object.freeze(['eleven_multilingual_v2', 'eleven_v3', 'eleven_flash_v2_5', 'eleven_turbo_v2_5']);

export class ElevenError extends Error {}

export const creditsPerChar = (modelId) => (HALF_PRICE.has(modelId) ? 0.5 : 1);

/** { chars, credits } a text will cost with a model. Credits are rounded up. */
export function estimateVoice({ text, modelId = DEFAULT_MODEL }) {
  const chars = [...String(text ?? '')].length;
  return { chars, credits: Math.ceil(chars * creditsPerChar(modelId)), modelId };
}

const clamp01 = (n, fallback) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
};

/** Voice settings with defaults and the 0..1 range enforced. */
export function voiceSettings(s = {}) {
  return {
    stability: clamp01(s.stability, 0.5),
    similarity_boost: clamp01(s.similarity ?? s.similarity_boost, 0.75),
    style: clamp01(s.style, 0),
    use_speaker_boost: s.speakerBoost ?? s.use_speaker_boost ?? true,
  };
}

const validVoiceId = (id) => /^[A-Za-z0-9]{8,40}$/.test(String(id ?? ''));

// ---- request builders -------------------------------------------------------------------------------------------

const headers = (key, extra = {}) => ({ 'xi-api-key': key, ...extra });

export const voicesRequest = (key) => ({ url: `${API_BASE}/v1/voices`, init: { method: 'GET', headers: headers(key, { accept: 'application/json' }) } });
export const subscriptionRequest = (key) => ({ url: `${API_BASE}/v1/user/subscription`, init: { method: 'GET', headers: headers(key, { accept: 'application/json' }) } });

export function ttsRequest(key, { voiceId, text, modelId = DEFAULT_MODEL, settings, outputFormat = DEFAULT_OUTPUT_FORMAT }) {
  if (!validVoiceId(voiceId)) throw new ElevenError('El ID de voz no es válido.');
  const body = String(text ?? '');
  if (!body.trim()) throw new ElevenError('El texto está vacío.');
  if ([...body].length > MAX_TEXT_CHARS) throw new ElevenError(`El texto supera ${MAX_TEXT_CHARS} caracteres; divídelo en partes.`);
  if (!/^[a-z0-9_]{3,40}$/.test(modelId)) throw new ElevenError('El modelo no es válido.');
  if (!/^[a-z0-9_]{3,30}$/.test(outputFormat)) throw new ElevenError('El formato de audio no es válido.');
  return {
    url: `${API_BASE}/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`,
    init: { method: 'POST', headers: headers(key, { 'content-type': 'application/json', accept: 'audio/mpeg' }), body: JSON.stringify({ text: body, model_id: modelId, voice_settings: voiceSettings(settings) }) },
  };
}

// ---- responses ---------------------------------------------------------------------------------------------------

export function normalizeVoices(json) {
  return (Array.isArray(json?.voices) ? json.voices : []).map((v) => ({
    id: String(v.voice_id ?? ''), name: String(v.name ?? ''), category: String(v.category ?? ''), description: String(v.description ?? '').slice(0, 200),
    labels: v.labels && typeof v.labels === 'object' ? v.labels : {}, previewUrl: typeof v.preview_url === 'string' && /^https:\/\//.test(v.preview_url) ? v.preview_url : null,
  })).filter((v) => v.id);
}

export function normalizeSubscription(json) {
  const used = Number(json?.character_count ?? 0);
  const limit = Number(json?.character_limit ?? 0);
  return {
    tier: String(json?.tier ?? ''), status: String(json?.status ?? ''), used, limit, remaining: Math.max(0, limit - used),
    resetsAt: Number(json?.next_character_count_reset_unix ?? 0) || null,
  };
}

function friendlyStatus(status, detail) {
  if (status === 401) return 'ElevenLabs rechazó la clave (401). Revisa que esté completa y vigente.';
  if (status === 402 || /quota|credits/i.test(detail)) return 'Te quedaste sin créditos de ElevenLabs para este texto. Revisa tu plan o el saldo.';
  if (status === 404) return 'ElevenLabs no encontró esa voz o ese recurso (404).';
  if (status === 422) return `ElevenLabs no aceptó los datos enviados (422): ${detail.slice(0, 160)}`;
  if (status === 429) return 'ElevenLabs pide esperar un momento (demasiadas solicitudes). Intenta de nuevo en unos segundos.';
  return `ElevenLabs respondió con un error (${status}).`;
}

/** Client over an injectable fetch. `key` is required and never leaves this closure. */
export function createClient({ key, fetchFn = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  if (!key || !String(key).trim()) throw new ElevenError('Falta la clave de ElevenLabs. Guárdala en la sección Voces.');
  const secret = String(key).trim();
  async function call({ url, init }, as) {
    let res;
    try {
      res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ElevenError(`No pude conectar con ElevenLabs: ${String(error?.message ?? error).split(secret).join('***').slice(0, 160)}`);
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).split(secret).join('***');
      } catch {
        /* no body */
      }
      throw new ElevenError(friendlyStatus(res.status, detail));
    }
    return as === 'bytes' ? Buffer.from(await res.arrayBuffer()) : res.json();
  }
  return {
    voices: async () => normalizeVoices(await call(voicesRequest(secret), 'json')),
    subscription: async () => normalizeSubscription(await call(subscriptionRequest(secret), 'json')),
    tts: (args) => call(ttsRequest(secret, args), 'bytes'),
  };
}

// ---- presets -----------------------------------------------------------------------------------------------------

export const presetsPath = (dataDir) => path.join(dataDir, 'voices', 'presets.json');

const text = (v, max) => String(v ?? '').trim().slice(0, max);

/** One preset, validated: { id, name, voiceId, modelId, stability, similarity, style, speakerBoost, product, country }. */
export function validatePreset(p) {
  const name = text(p?.name, 60);
  if (!name) throw new ElevenError('El preset necesita un nombre.');
  if (!validVoiceId(p?.voiceId)) throw new ElevenError('El ID de voz del preset no es válido.');
  const modelId = text(p?.modelId, 40) || DEFAULT_MODEL;
  if (!/^[a-z0-9_]{3,40}$/.test(modelId)) throw new ElevenError('El modelo del preset no es válido.');
  const s = voiceSettings(p);
  return {
    id: /^[a-z0-9-]{3,40}$/.test(String(p?.id ?? '')) ? p.id : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name, voiceId: p.voiceId, modelId, stability: s.stability, similarity: s.similarity_boost, style: s.style, speakerBoost: s.use_speaker_boost === true,
    product: text(p?.product, 60), country: text(p?.country, 30).toLowerCase(), note: text(p?.note, 200),
  };
}

export function loadPresets(dataDir) {
  try {
    const json = JSON.parse(fs.readFileSync(presetsPath(dataDir), 'utf8').replace(/^﻿/, ''));
    return (Array.isArray(json?.presets) ? json.presets : []).flatMap((p) => {
      try {
        return [validatePreset(p)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function savePresets(dataDir, presets) {
  const clean = presets.map(validatePreset);
  const file = presetsPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ presets: clean }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return clean;
}

/** The preset a request names: by id or exact name, else the one saved for that product and country. */
export function findPreset(presets, { preset, product, country } = {}) {
  const wanted = text(preset, 60).toLowerCase();
  if (wanted) return presets.find((p) => p.id === wanted || p.name.toLowerCase() === wanted) ?? null;
  const c = text(country, 30).toLowerCase();
  const prod = text(product, 60).toLowerCase().replace(/^producto\s+/, '');
  return presets.find((p) => p.country === c && (!p.product || p.product.toLowerCase().replace(/^producto\s+/, '') === prod)) ?? null;
}
