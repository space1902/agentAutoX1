// Non-interactive profile operations shared by the desktop app and the terminal rules:
// list / create / update / delete / set-group / registry. Every command takes a plain payload and
// returns plain data (or throws SelectionError with a Spanish message the UI can show as-is).
// Writes are atomic (temp + rename) and keep a timestamped copy of the previous file in <data>/backups/.
import fs from 'node:fs';
import path from 'node:path';

import { buildUpdatedConfig, normalizePhone, writeJsonAtomic } from './profile-creation.js';
import { buildLineHealth } from './line-health.js';
import { botKeys, buildRegistry, phoneKey } from './registry.js';
import { readActivity } from './wa-activity.js';
import {
  SelectionError,
  addProfile,
  hasSavedSession,
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

function decorateProfile(name, profile, config, pods, hasSession) {
  const entries = new Map(testerIds(config.testers).map((id) => [id, testerEntry(config, id)]));
  const podByKey = new Map(pods.filter((p) => phoneKey(p.phone)).map((p) => [phoneKey(p.phone), p.name]));
  return {
    name,
    groupName: clean(profile?.groupName) || null,
    effectiveGroup: profileGroupName(profile, config) || null,
    createdAt: profile?.createdAt ?? null,
    testers: (profile?.testers ?? []).map((id) => {
      const entry = entries.get(id);
      const phone = typeof entry === 'object' && entry ? clean(entry.phone) || null : null;
      return { id, phone, linked: hasSession(id), podName: phone ? (podByKey.get(phoneKey(phone)) ?? null) : null };
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

  list(payload, { dataDir }) {
    const { configFile, profilesFile, authDir } = paths(dataDir);
    const config = readConfig(configFile);
    const profiles = loadProfiles(profilesFile);
    const pods = payload.pods ?? [];
    const hasSession = (id) => hasSavedSession(authDir, id);
    return {
      defaultGroup: clean(config.groupName) || null,
      botNumber: clean(config.botNumber) || null,
      profiles: Object.entries(profiles).map(([name, profile]) => decorateProfile(name, profile, config, pods, hasSession)),
      registry: buildRegistry({ config, profiles, pods, hasSession }),
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
