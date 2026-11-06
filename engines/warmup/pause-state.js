// Persistent per-number pause state (<data dir>/warmup-pauses.json).
//
// A paused number sends nothing and its socket stays closed. Pauses come from three places:
//   reason 'logged_out'            source 'engine'  WhatsApp ended the session (401); stays until a human resumes it
//   reason 'repeated_disconnects'  source 'engine'  the disconnect brake; timed (6 h, doubling, max 48 h)
//   reason 'manual'                source 'user'    Pausar in the app
// The file is written by two processes (the engine and the app's short-lived helper), always as a
// synchronous read-modify-write followed by an atomic rename, and every reader tolerates a missing or
// corrupt file: it logs a warning and carries on with "nothing paused" instead of crashing a long run.
import fs from 'node:fs';
import path from 'node:path';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const PAUSE_FILE_NAME = 'warmup-pauses.json';

// Named constants of the disconnect brake (see disconnect-brake.js for the counting rules).
export const BRAKE_PAUSE = Object.freeze({
  baseMs: 6 * HOUR_MS,
  maxMs: 48 * HOUR_MS,
  // A brake pause older than this no longer makes the next one longer.
  strikeMemoryMs: 7 * DAY_MS,
});

export const emptyState = () => ({ version: 1, paused: {}, strikes: {} });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asIso = (ms) => new Date(ms).toISOString();
const parseMs = (value) => {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};

// Keeps what is usable. An unreadable `until` is kept as given: parseMs() then fails and the pause is
// treated as indefinite (fail safe: a damaged entry never silently resumes a number).
function sanitizeEntry(key, raw) {
  if (!isObject(raw)) return null;
  const session = String(raw.session ?? key ?? '').trim();
  if (!session) return null;
  return {
    session,
    number: raw.number ? String(raw.number).replace(/\D/g, '') || null : null,
    reason: String(raw.reason ?? 'unknown'),
    source: String(raw.source ?? 'unknown'),
    since: raw.since ?? null,
    until: raw.until ?? null,
    ...(raw.detail ? { detail: String(raw.detail) } : {}),
  };
}

function sanitizeState(raw) {
  const state = emptyState();
  if (!isObject(raw)) return { state, valid: false };
  if (!isObject(raw.paused) && raw.paused !== undefined) return { state, valid: false };

  for (const [key, value] of Object.entries(raw.paused ?? {})) {
    const entry = sanitizeEntry(key, value);
    if (entry) state.paused[entry.session] = entry;
  }
  if (isObject(raw.strikes)) {
    for (const [key, value] of Object.entries(raw.strikes)) {
      const count = Math.floor(Number(value?.count));
      if (Number.isFinite(count) && count > 0 && parseMs(value?.last) !== null) {
        state.strikes[key] = { count, last: value.last };
      }
    }
  }
  return { state, valid: true };
}

// { state, corrupt }. Never throws.
export function loadPauseState(file, { warn = console.warn } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: emptyState(), corrupt: false };
    warn(`[pause] could not read ${path.basename(file)} (${error?.message || error}); treating it as empty.`);
    return { state: emptyState(), corrupt: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    warn(`[pause] ${path.basename(file)} is not valid JSON (${error?.message || error}); treating it as empty.`);
    return { state: emptyState(), corrupt: true };
  }

  const { state, valid } = sanitizeState(parsed);
  if (!valid) {
    warn(`[pause] ${path.basename(file)} has an unexpected shape; treating it as empty.`);
    return { state, corrupt: true };
  }
  return { state, corrupt: false };
}

// Windows refuses a rename for a moment while an antivirus or the other process has the file open.
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const SAVE_ATTEMPTS = 6;
const SAVE_RETRY_MS = 40;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Temp file + rename, so a reader never sees half a file. Retries briefly on EPERM/EBUSY; throws if it
// still cannot save.
export function savePauseState(file, state, { rename = fs.renameSync, sleep = sleepSync } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    for (let attempt = 1; ; attempt++) {
      try {
        rename(temp, file);
        return;
      } catch (error) {
        if (attempt >= SAVE_ATTEMPTS || !RETRYABLE.has(error?.code)) throw error;
        sleep(SAVE_RETRY_MS * attempt);
      }
    }
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing more to clean up.
    }
    throw error;
  }
}

// The entry while the session is paused at nowMs, otherwise null.
export function activePause(state, session, nowMs) {
  const entry = state.paused[session];
  if (!entry) return null;
  const until = entry.until === null || entry.until === undefined ? null : parseMs(entry.until);
  if (until === null) return entry; // indefinite, or an unreadable date (fail safe)
  return nowMs < until ? entry : null;
}

// New state with `session` paused. durationMs null = until a human resumes it.
// countStrike records a brake pause so the next one is longer.
export function withPause(state, { session, number = null, reason, source, nowMs, durationMs = null, detail = null, countStrike = false }) {
  const entry = {
    session,
    number: number ? String(number).replace(/\D/g, '') || null : null,
    reason,
    source,
    since: asIso(nowMs),
    until: durationMs === null ? null : asIso(nowMs + durationMs),
    ...(detail ? { detail: String(detail) } : {}),
  };
  const next = { ...state, paused: { ...state.paused, [session]: entry }, strikes: { ...state.strikes } };
  if (countStrike) {
    const prior = brakeDurationMs(state, session, nowMs).strikes;
    next.strikes[session] = { count: prior + 1, last: asIso(nowMs) };
  }
  return next;
}

export function withoutPause(state, session) {
  if (!state.paused[session]) return state;
  const paused = { ...state.paused };
  delete paused[session];
  return { ...state, paused };
}

// How long the next brake pause lasts: base * 2^(recent brake pauses), capped.
export function brakeDurationMs(state, session, nowMs, config = BRAKE_PAUSE) {
  const strike = state.strikes?.[session];
  const last = strike ? parseMs(strike.last) : null;
  const strikes = strike && last !== null && nowMs - last < config.strikeMemoryMs ? strike.count : 0;
  return { durationMs: Math.min(config.maxMs, config.baseMs * 2 ** strikes), strikes };
}

// Sessions whose timed pause is over at nowMs.
export function expiredSessions(state, nowMs) {
  return Object.keys(state.paused).filter((session) => activePause(state, session, nowMs) === null);
}

// File-backed store. Reloads when the file changed on disk (the app pauses and resumes from another
// process); keeps the in-memory state if a save fails, so a pause still holds for this run.
// strict (the app): a failed save throws, so the UI never reports a pause that is not on disk. The engine
// keeps strict off: it warns and the pause still holds in memory.
export function createPauseStore({ file, now = Date.now, warn = console.warn, strict = false, sleep = undefined } = {}) {
  let state = emptyState();
  let signature = null; // 'missing' | `${mtimeMs}:${size}` of the last file we loaded or wrote
  let corrupt = false;
  let loaded = false;

  const currentSignature = () => {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'missing';
    }
  };

  function reload() {
    const result = loadPauseState(file, { warn });
    state = result.state;
    corrupt = result.corrupt;
    signature = currentSignature();
    loaded = true;
  }

  function refresh() {
    if (!loaded || currentSignature() !== signature) reload();
  }

  function persist() {
    try {
      if (corrupt) {
        // Keep the unreadable file for the user before replacing it.
        try {
          fs.copyFileSync(file, `${file}.corrupt-${now()}`);
        } catch {
          // Nothing to keep (or no permission): saving the new state matters more.
        }
      }
      savePauseState(file, state, sleep ? { sleep } : undefined);
      corrupt = false;
      signature = currentSignature();
    } catch (error) {
      if (strict) throw new Error(`Could not save ${path.basename(file)} (${error?.message || error}).`);
      warn(`[pause] could not save ${path.basename(file)} (${error?.message || error}); the pause only holds until this run ends.`);
    }
  }

  // Read-modify-write: reload first so a change made by the other process is not overwritten.
  function mutate(change) {
    refresh();
    const before = state;
    state = change(state);
    if (state === before) return;
    try {
      persist();
    } catch (error) {
      state = before;
      throw error;
    }
  }

  return {
    file,

    get(session) {
      refresh();
      return activePause(state, session, now());
    },

    list() {
      refresh();
      return Object.keys(state.paused)
        .map((session) => activePause(state, session, now()))
        .filter(Boolean);
    },

    pause({ session, number = null, reason, source, durationMs = null, detail = null, countStrike = false }) {
      mutate((current) => withPause(current, { session, number, reason, source, nowMs: now(), durationMs, detail, countStrike }));
      return state.paused[session];
    },

    // True when the session was paused (including a finished timed pause that was still on file).
    resume(session) {
      refresh();
      if (!state.paused[session]) return false;
      mutate((current) => withoutPause(current, session));
      return true;
    },

    // Removes timed pauses that ended; returns their session ids.
    expire() {
      refresh();
      const ended = expiredSessions(state, now());
      if (ended.length) mutate((current) => ended.reduce((acc, session) => withoutPause(acc, session), current));
      return ended;
    },

    brakeDuration(session) {
      refresh();
      return brakeDurationMs(state, session, now());
    },
  };
}
