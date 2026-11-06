// Non-interactive profile operations shared by the desktop app and the terminal rules:
// list / create / update / delete / set-group / registry. Every command takes a plain payload and
// returns plain data (or throws SelectionError with a Spanish message the UI can show as-is).
// Writes are atomic (temp + rename) and keep a timestamped copy of the previous file in <data>/backups/.
import fs from 'node:fs';
import path from 'node:path';

import { buildUpdatedConfig, normalizePhone, writeJsonAtomic } from './profile-creation.js';
import { buildLineHealth } from './line-health.js';
import { sessionAge } from './session-age.js';
import { botKeys, buildRegistry, phoneKey } from './registry.js';
import { readActivity } from './wa-activity.js';
import { dateKeyFor, evaluateGate, normalizeSchedule, resolveTimezone } from './activity-schedule.js';
import { appendEvent } from './event-log.js';
import { PAUSE_FILE_NAME, createPauseStore } from './pause-state.js';
import { countSentOnDay } from './send-gate.js';
import { resolveSessionPhone } from './wa-messages.js';
import {
  SelectionError,
  addProfile,
  hasSavedSession,
  readSessionPhone,
  loadProfiles,
  profileGroupName,
  removeProfile,
  testerIds,
} from './session-selection.js';

const clean = (value) => String(value ?? '').trim();

// "20261028-150405-123" (UTC), sortable and safe in file names.
const stamp = (now) => now.toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');

// Copies `file` into a sibling backups/ folder before it is overwritten. Returns the copy path or null.
export function backupFile(file, now = new Date()) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const { name, ext } = path.parse(file);
  const target = path.join(dir, `${name}.${stamp(now)}${ext}`);
  fs.copyFileSync(file, target);
  return target;
}

function readConfig(configFile) {
  let text;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch {
    throw new SelectionError(`No encuentro config.json en ${path.dirname(configFile)}. Revisa la carpeta de datos en Ajustes.`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new SelectionError(`config.json no es un JSON válido: ${error.message}`);
  }
}

function paths(dataDir) {
  return {
    configFile: path.join(dataDir, 'config.json'),
    profilesFile: path.join(dataDir, 'profiles.json'),
    authDir: path.join(dataDir, '.baileys_auth'),
  };
}

const eventsFile = (dataDir) => path.join(dataDir, 'results', 'events.jsonl');

// The pause file shared with the running engine (see pause-state.js). Problems go to `warnings`.
function pauseStoreFor(dataDir, now, warnings, strict = false) {
  return createPauseStore({
    file: path.join(dataDir, PAUSE_FILE_NAME),
    now: () => now.getTime(),
    warn: (message) => warnings.push(message),
    strict,
  });
}

// Pausar / Reanudar must never report success when the file did not change.
function saveFailed(error) {
  return new SelectionError(`No se pudo guardar la pausa: ${error?.message || error}. Cierra lo que tenga abierto ese archivo e inténtalo de nuevo.`);
}

// A tester id from config.json, or the bot session. Anything else is a typo in the UI call.
function knownSession(config, value) {
  const id = clean(value);
  const known = [...testerIds(config.testers), clean(config.bot?.sessionId) || 'bot'];
  if (!id || !known.includes(id)) throw new SelectionError(`No conozco el número «${id}» en config.json.`);
  return id;
}

function writeWithBackup(file, value, now) {
  backupFile(file, now);
  writeJsonAtomic(file, value);
}

function assertNotRunning(running, ...names) {
  const current = clean(running);
  if (current && names.map(clean).includes(current)) {
    throw new SelectionError(`El perfil «${current}» está en curso; detenlo antes de modificarlo.`);
  }
}

function validateName(name) {
  const key = clean(name);
  addProfile({}, key, ['x']); // throws for empty or reserved names
  return key;
}

const testerEntry = (config, id) =>
  (config.testers ?? []).find((entry) => (typeof entry === 'string' ? entry : entry?.id) === id);

const idNumber = (id) => {
  const match = /^tester(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
};

// Turns the UI selections ({ testerId } or { phone }) into tester ids, creating testers for phones that have none.
export function resolveSelections(config, profiles, selections) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new SelectionError('Elige al menos un número para el perfil.');
  }

  const bots = new Set(botKeys(config));
  const botError = () => new SelectionError('Ese es el número del bot: siempre se incluye como bot, elige otro distinto.');
  const known = testerIds(config.testers);
  const used = [...known, ...Object.values(profiles).flatMap((profile) => profile?.testers ?? [])];
  let next = Math.max(0, ...used.map(idNumber)) + 1;

  const ids = [];
  const created = [];
  const phones = {};

  for (const selection of selections) {
    if (selection?.testerId) {
      const id = clean(selection.testerId);
      const entry = testerEntry(config, id);
      if (!entry) throw new SelectionError(`El tester «${id}» no existe en config.json.`);
      if (bots.has(phoneKey(typeof entry === 'object' ? entry.phone : ''))) throw botError();
      ids.push(id);
      continue;
    }

    const phone = normalizePhone(selection?.phone);
    if (!phone) {
      throw new SelectionError(
        `«${clean(selection?.phone)}» no es un número válido: escribe entre 11 y 15 dígitos (con el 57 al inicio, o 10 dígitos que empiecen por 3).`,
      );
    }
    const key = phoneKey(phone);
    if (bots.has(key)) throw botError();

    const existing = testerIds(config.testers).find((id) => {
      const entry = testerEntry(config, id);
      return typeof entry === 'object' && phoneKey(entry.phone) === key;
    });
    if (existing) {
      ids.push(existing);
      continue;
    }

    const id = `tester${next++}`;
    created.push(id);
    phones[id] = phone;
    ids.push(id);
  }

  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) {
    throw new SelectionError(`Hay números repetidos en la selección (${[...new Set(duplicates)].join(', ')}).`);
  }
  return { ids, created, phones };
}

function decorateProfile(name, profile, config, pods, hasSession, registry) {
  const podByKey = new Map(pods.filter((p) => phoneKey(p.phone)).map((p) => [phoneKey(p.phone), p.name]));
  return {
    name,
    groupName: clean(profile?.groupName) || null,
    effectiveGroup: profileGroupName(profile, config) || null,
    createdAt: profile?.createdAt ?? null,
    testers: (profile?.testers ?? []).map((id) => {
      const info = registry.testers[id];
      const phone = info?.phone ?? null;
      return {
        id,
        phone,
        phoneSource: info?.phoneSource ?? null,
        sessionPhone: info?.sessionPhone ?? null,
        mismatch: info?.mismatch ?? false,
        duplicateOf: info?.duplicateOf ?? [],
        linked: hasSession(id),
        podName: phone ? (podByKey.get(phoneKey(phone)) ?? null) : null,
      };
    }),
  };
}

function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// results/run-*.csv texts (a CSV still being written is skipped, never fatal).
function readCsvTexts(resultsDir) {
  let names = [];
  try {
    names = fs.readdirSync(resultsDir).filter((name) => name.startsWith('run-') && name.endsWith('.csv'));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      return [fs.readFileSync(path.join(resultsDir, name), 'utf8')];
    } catch {
      return [];
    }
  });
}

const COMMANDS = {
  // Traffic light + strength score per tester id (see line-health.js and the README).
  'line-health'(payload, { dataDir, now }) {
    const { configFile, authDir } = paths(dataDir);
    const config = readConfig(configFile);
    const resultsDir = path.join(dataDir, 'results');
    const wanted = Array.isArray(payload.testers) ? payload.testers.map(clean).filter(Boolean) : null;
    const ids = testerIds(config.testers).filter((id) => !wanted || wanted.includes(id));
    const lines = buildLineHealth({
      testerIds: ids,
      linkedOf: (id) => hasSavedSession(authDir, id),
      events: readLines(path.join(resultsDir, 'events.jsonl')),
      activityOf: (id, sinceSeconds) => readActivity(resultsDir, id, sinceSeconds),
      csvTexts: readCsvTexts(resultsDir),
      now,
    });
    return { generatedAt: now.toISOString(), lines };
  },

  // Per-number schedule state for the app: paused / active / outside its window / at its daily cap, the
  // messages sent today and the cap. Read-only; the engine and this command use the same rules.
  'schedule-status'(payload, { dataDir, now }) {
    const { configFile } = paths(dataDir);
    const config = readConfig(configFile);
    const resultsDir = path.join(dataDir, 'results');
    const warnings = [];
    const store = pauseStoreFor(dataDir, now, warnings);
    const schedule = normalizeSchedule(config.schedule);
    const ids = testerIds(config.testers);
    const botId = clean(config.bot?.sessionId) || 'bot';
    const events = readLines(eventsFile(dataDir));

    const describe = (id, timezone, { days, incidents, flatCap }) => {
      const count = countSentOnDay({ resultsDir, session: id, dateKey: dateKeyFor(now.getTime(), timezone), timezone });
      const gate = evaluateGate({ sessionId: id, now: now.getTime(), count, days, incidents, flatCap, schedule, timezone });
      const pause = store.get(id);
      return {
        state: pause ? 'paused' : gate.state,
        pause: pause
          ? { reason: pause.reason, source: pause.source, since: pause.since, until: pause.until, detail: pause.detail ?? null }
          : null,
        count,
        cap: gate.cap,
        low: gate.low,
        window: gate.window
          ? { startAt: new Date(gate.window.startMs).toISOString(), endAt: new Date(gate.window.endMs).toISOString() }
          : null,
        nextOpenAt: gate.nextOpenMs ? new Date(gate.nextOpenMs).toISOString() : null,
        timezone,
      };
    };

    const sessions = {};
    for (const id of ids) {
      sessions[id] = describe(id, resolveTimezone(schedule, testerEntry(config, id)), {
        // Same age source as the engine (session-age.js), so the cap shown is the cap applied.
        ...sessionAge({ session: id, events, earliestSentSeconds: readActivity(resultsDir, id, Number.MAX_SAFE_INTEGER).earliestSent, now }),
      });
    }
    sessions[botId] = describe(botId, resolveTimezone(schedule, { timezone: config.bot?.timezone }), {
      flatCap: schedule.botDailyCap,
    });

    return { generatedAt: now.toISOString(), enabled: schedule.enabled, sessions, warnings };
  },

  // Pausar: takes one number out of the cycle. The running engine notices within seconds and the pause
  // survives restarts. hours (optional) makes it a timed pause; otherwise it lasts until Reanudar.
  'pause-tester'(payload, { dataDir, now }) {
    const config = readConfig(paths(dataDir).configFile);
    const id = knownSession(config, payload.id);
    const hours = Number(payload.hours);
    const durationMs = Number.isFinite(hours) && hours > 0 ? Math.min(Math.max(hours, 1), 720) * 3_600_000 : null;
    const warnings = [];
    const store = pauseStoreFor(dataDir, now, warnings, true);

    const existing = store.get(id);
    if (existing) return { paused: false, alreadyPaused: true, pause: existing, warnings };

    let pause;
    try {
      pause = store.pause({ session: id, number: resolveSessionPhone(config, id), reason: 'manual', source: 'user', durationMs });
    } catch (error) {
      throw saveFailed(error);
    }
    appendEvent(eventsFile(dataDir), id, 'paused', `manual; source=user${pause.until ? `; until ${pause.until}` : ''}`, now);
    return { paused: true, pause, warnings };
  },

  'resume-tester'(payload, { dataDir, now }) {
    const config = readConfig(paths(dataDir).configFile);
    const id = knownSession(config, payload.id);
    const warnings = [];
    let resumed;
    try {
      resumed = pauseStoreFor(dataDir, now, warnings, true).resume(id);
    } catch (error) {
      throw saveFailed(error);
    }
    if (resumed) appendEvent(eventsFile(dataDir), id, 'resumed', 'source=user', now);
    return { resumed, warnings };
  },

  list(payload, { dataDir }) {
    const { configFile, profilesFile, authDir } = paths(dataDir);
    const config = readConfig(configFile);
    const profiles = loadProfiles(profilesFile);
    const pods = payload.pods ?? [];
    const hasSession = (id) => hasSavedSession(authDir, id);
    const registry = buildRegistry({ config, profiles, pods, hasSession, sessionPhoneOf: (id) => readSessionPhone(authDir, id) });
    return {
      defaultGroup: clean(config.groupName) || null,
      botNumber: clean(config.botNumber) || null,
      profiles: Object.entries(profiles).map(([name, profile]) => decorateProfile(name, profile, config, pods, hasSession, registry)),
      registry,
    };
  },

  registry(payload, { dataDir }) {
    const { configFile, profilesFile, authDir } = paths(dataDir);
    const config = readConfig(configFile);
    return buildRegistry({
      config,
      profiles: loadProfiles(profilesFile),
      pods: payload.pods ?? [],
      hasSession: (id) => hasSavedSession(authDir, id),
      sessionPhoneOf: (id) => readSessionPhone(authDir, id),
    });
  },

  create(payload, { dataDir, now }) {
    const { configFile, profilesFile } = paths(dataDir);
    const config = readConfig(configFile);
    const profiles = loadProfiles(profilesFile);
    assertNotRunning(payload.running, payload.name);

    const name = validateName(payload.name);
    if (profiles[name]) throw new SelectionError(`El perfil «${name}» ya existe; elige otro nombre.`);

    const { ids, created, phones } = resolveSelections(config, profiles, payload.selections);
    const groupName = clean(payload.group) || clean(config.groupName);
    const nextProfiles = addProfile(profiles, name, ids, { groupName, now });

    if (created.length) writeWithBackup(configFile, buildUpdatedConfig(config, { ids, created, phones }), now);
    writeWithBackup(profilesFile, nextProfiles, now);
    return { profile: { name, ...nextProfiles[name] }, createdTesters: created };
  },

  update(payload, { dataDir, now }) {
    const { configFile, profilesFile } = paths(dataDir);
    const config = readConfig(configFile);
    const profiles = loadProfiles(profilesFile);
    const name = clean(payload.name);
    const current = profiles[name];
    if (!current) removeProfile(profiles, name); // throws the standard "no existe" message

    const newName = clean(payload.newName) || name;
    assertNotRunning(payload.running, name, newName);
    if (newName !== name) {
      validateName(newName);
      if (profiles[newName]) throw new SelectionError(`El perfil «${newName}» ya existe; elige otro nombre.`);
    }

    let ids = current.testers ?? [];
    let created = [];
    let nextConfig = null;
    if (payload.selections !== undefined) {
      const resolved = resolveSelections(config, profiles, payload.selections);
      ids = resolved.ids;
      created = resolved.created;
      if (created.length) nextConfig = buildUpdatedConfig(config, resolved);
    }

    const groupName = clean(payload.group) || clean(current.groupName);
    const updated = { ...current, testers: [...ids] };
    if (groupName) updated.groupName = groupName;

    // Keep the original key order: replace the entry in place when renaming.
    const nextProfiles = {};
    for (const [key, value] of Object.entries(profiles)) nextProfiles[key === name ? newName : key] = key === name ? updated : value;

    if (nextConfig) writeWithBackup(configFile, nextConfig, now);
    writeWithBackup(profilesFile, nextProfiles, now);
    return { profile: { name: newName, ...updated }, createdTesters: created };
  },

  delete(payload, { dataDir, now }) {
    const { profilesFile } = paths(dataDir);
    const profiles = loadProfiles(profilesFile);
    const name = clean(payload.name);
    assertNotRunning(payload.running, name);
    const next = removeProfile(profiles, name);
    writeWithBackup(profilesFile, next, now);
    return { deleted: name };
  },

  'set-group'(payload, { dataDir, now }) {
    const { profilesFile } = paths(dataDir);
    const profiles = loadProfiles(profilesFile);
    const name = clean(payload.name);
    assertNotRunning(payload.running, name);
    const group = clean(payload.group);
    if (!profiles[name]) removeProfile(profiles, name);
    if (!group) throw new SelectionError('Indica el nombre del grupo.');
    const next = { ...profiles, [name]: { ...profiles[name], groupName: group } };
    writeWithBackup(profilesFile, next, now);
    return { profile: { name, ...next[name] } };
  },
};

export function runCommand(command, payload = {}, { dataDir, now = new Date() }) {
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!handler) throw new SelectionError(`Comando desconocido: ${command}. Disponibles: ${Object.keys(COMMANDS).join(', ')}.`);
  return handler(payload ?? {}, { dataDir, now });
}
