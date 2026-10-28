// Voice notes: free Microsoft Edge neural TTS (msedge-tts) converted to OGG/Opus with ffmpeg.
// The pure helpers at the top are unit-tested; synthesizeVoiceNote needs network and ffmpeg.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SYNTHESIS_TIMEOUT_MS = 45_000;
const FFMPEG_TIMEOUT_MS = 20_000;
const MAX_SPEECH_CHARS = 700;

export const DEFAULT_AUDIO = { enabled: true, chance: 0.12 };

// Latin American Spanish neural voices (verified against the Edge voice list), alternating
// female/male so that neighbouring picks tend to differ in gender as well as accent.
export const DEFAULT_VOICE_POOL = [
  'es-CO-SalomeNeural',
  'es-MX-JorgeNeural',
  'es-AR-ElenaNeural',
  'es-CO-GonzaloNeural',
  'es-VE-PaolaNeural',
  'es-AR-TomasNeural',
  'es-PE-CamilaNeural',
  'es-MX-DaliaNeural',
  'es-CL-CatalinaNeural',
  'es-VE-SebastianNeural',
  'es-UY-ValentinaNeural',
  'es-PE-AlexNeural',
  'es-EC-AndreaNeural',
  'es-CL-LorenzoNeural',
];

export const DEFAULT_BOT_VOICE = 'es-CO-SalomeNeural';

// FNV-1a: stable across runs and platforms, so a session keeps its voice between restarts.
function hashString(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

// Maps each session id to a voice. Each id starts at a hash-based slot of the pool and moves
// forward to the next unused voice, so voices stay distinct until the pool runs out.
// Overrides win and are reserved first so nobody else lands on them.
export function assignVoices(sessionIds, voicePool = DEFAULT_VOICE_POOL, overrides = {}) {
  const pool = (Array.isArray(voicePool) ? voicePool : []).map(clean).filter(Boolean);
  const result = {};
  const used = new Set();

  for (const id of sessionIds) {
    const forced = clean(overrides?.[id]);
    if (forced) used.add(forced);
  }

  for (const id of sessionIds) {
    const forced = clean(overrides?.[id]);
    if (forced) {
      result[id] = forced;
      continue;
    }

    if (!pool.length) {
      result[id] = null;
      continue;
    }

    const start = hashString(id) % pool.length;
    let pick = null;
    for (let step = 0; step < pool.length; step++) {
      const candidate = pool[(start + step) % pool.length];
      if (!used.has(candidate)) {
        pick = candidate;
        break;
      }
    }

    // Pool exhausted: reuse the hashed slot (still deterministic).
    result[id] = pick ?? pool[start];
    used.add(result[id]);
  }

  return result;
}

export function shouldSendAudio(chance, rng = Math.random) {
  const value = Number(chance);
  if (!Number.isFinite(value) || value <= 0) return false;
  if (value >= 1) return true;
  return rng() < value;
}

// Removes what a speech engine would read aloud badly: emojis, URLs and markdown symbols.
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}‍️⃣\u{1f3fb}-\u{1f3ff}]/gu, '')
    .replace(/^\s*[-*+•]\s+/gm, ' ')
    .replace(/^\s*#{1,6}\s+/gm, ' ')
    .replace(/[*_`~#>[\]|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const clampChance = (value) => Math.min(1, Math.max(0, value));

// Effective audio settings for one tester: global "audio" block plus per-tester overrides.
export function audioSettings(config, sessionId) {
  const audio = config?.audio ?? {};
  const enabled = audio.enabled !== false;

  const rawGlobal = Number(audio.chance);
  let chance = Number.isFinite(rawGlobal) ? clampChance(rawGlobal) : DEFAULT_AUDIO.chance;

  const entry = (config?.testers ?? []).find(
    (item) => item && typeof item === 'object' && item.id === sessionId,
  );
  if (entry && entry.audioChance !== undefined && entry.audioChance !== null) {
    const own = Number(entry.audioChance);
    if (Number.isFinite(own)) chance = clampChance(own);
  }

  return {
    enabled,
    chance: enabled ? chance : 0,
    voice: clean(audio.voices?.[sessionId]) || null,
  };
}

// Rough speaking time (about 2.5 words per second), used for the "recording" pause.
export function estimateSpeechSeconds(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  return Math.min(90, Math.max(1, Math.round(words / 2.5)));
}

function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', input, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', output],
      { timeout: FFMPEG_TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`ffmpeg failed: ${String(stderr || error.message).trim()}`));
        else resolve();
      },
    );
  });
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Text -> OGG/Opus mono 48k Buffer. Throws on empty text, timeout, network or ffmpeg errors.
export async function synthesizeVoiceNote(text, voice, timeoutMs = SYNTHESIS_TIMEOUT_MS) {
  const speech = cleanForSpeech(text).slice(0, MAX_SPEECH_CHARS);
  if (!speech) throw new Error('Nothing speakable in the text.');
  if (!voice) throw new Error('No voice configured.');

  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-note-'));
  const tts = new MsEdgeTTS();
  let timer;

  try {
    const work = (async () => {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(speech);
      const mp3 = await readStream(audioStream);
      if (!mp3.length) throw new Error('The speech service returned no audio.');

      const input = path.join(dir, 'speech.mp3');
      const output = path.join(dir, 'speech.ogg');
      fs.writeFileSync(input, mp3);
      await runFfmpeg(input, output);
      return fs.readFileSync(output);
    })();
    // Avoid an unhandled rejection if the timeout wins the race and work fails afterwards.
    work.catch(() => {});

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Voice synthesis timed out after ${timeoutMs / 1000}s`)),
        timeoutMs,
      );
    });

    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    try {
      tts.close();
    } catch {
      // Closing the socket is best effort.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
