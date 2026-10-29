// Phone resolution for linking by pairing code (the engine never shows a QR unless LINK_MODE=qr).
// Order: config tester phone > phone of the current session > phone of the newest _logged_out/_unlinked
// backup of that id > a phone passed in by the caller (LINK_PHONES). Only creds.json's `me.id` is read.
import fs from 'node:fs';
import path from 'node:path';

import { backupFile } from './profile-api.js';
import { writeJsonAtomic } from './profile-creation.js';
import { readSessionPhone } from './session-selection.js';
import { resolveSessionPhone } from './wa-messages.js';

const BACKUP_FOLDERS = ['_logged_out', '_unlinked'];
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

// "300 123 4567" -> "573001234567"; other numbers keep their digits. Null when it is not a plausible number.
export function normalizeLinkPhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) digits = `57${digits}`;
  return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS ? digits : null;
}

// Emergency escape hatch: only an explicit LINK_MODE=qr brings the terminal QR back.
export const isQrMode = (value) => String(value ?? '').trim().toLowerCase() === 'qr';

// LINK_PHONES='{"tester1":"3162135114"}': phones the app already knows (e.g. from a pod) for sessions
// that have none anywhere else. Anything malformed is ignored.
export function parsePhoneHints(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const hints = {};
    for (const [id, value] of Object.entries(parsed)) {
      const phone = normalizeLinkPhone(value);
      if (phone) hints[id] = phone;
    }
    return hints;
  } catch {
    return {};
  }
}

// Sortable key from "<id>-2026-10-29T13-38-53" or "<id>-20261029-083621"; null when the name is not a backup of `id`.
function backupKey(name, id) {
  if (!name.startsWith(`${id}-`)) return null;
  const match = /^(\d{4})-?(\d{2})-?(\d{2})[T-]?(\d{2})-?(\d{2})-?(\d{2})/.exec(name.slice(id.length + 1));
  return match ? match.slice(1).join('') : null;
}

// Phone of the most recent backup of this id that still has a usable me.id.
export function readBackupPhone(authRoot, id) {
  const candidates = [];
  for (const folder of BACKUP_FOLDERS) {
    let names;
    try {
      names = fs.readdirSync(path.join(authRoot, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      const key = backupKey(name, id);
      if (key) candidates.push({ key, folder, name });
    }
  }

  candidates.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : a.name < b.name ? 1 : -1));
  for (const { folder, name } of candidates) {
    const phone = readSessionPhone(path.join(authRoot, folder), name);
    if (phone) return phone;
  }
  return null;
}

// { phone, source } with source in config | session | backup | hint, or { phone: null, source: null }.
export function resolveLinkPhone({ config, id, authRoot, hints = {} }) {
  const fromConfig = normalizeLinkPhone(resolveSessionPhone(config, id));
  if (fromConfig) return { phone: fromConfig, source: 'config' };

  const fromSession = normalizeLinkPhone(readSessionPhone(authRoot, id));
  if (fromSession) return { phone: fromSession, source: 'session' };

  const fromBackup = normalizeLinkPhone(readBackupPhone(authRoot, id));
  if (fromBackup) return { phone: fromBackup, source: 'backup' };

  const fromHint = normalizeLinkPhone(hints?.[id]);
  if (fromHint) return { phone: fromHint, source: 'hint' };

  return { phone: null, source: null };
}

const entryId = (entry) => (typeof entry === 'string' ? entry : entry?.id);

// New config with `phone` on that tester, or null when the tester is unknown or already has a phone.
export function withTesterPhone(config, id, phone) {
  const testers = Array.isArray(config?.testers) ? config.testers : [];
  const index = testers.findIndex((entry) => entryId(entry) === id);
  if (index === -1) return null;
  const entry = testers[index];
  if (typeof entry === 'object' && entry && normalizeLinkPhone(entry.phone)) return null;

  const next = [...testers];
  next[index] = typeof entry === 'object' && entry ? { ...entry, id, phone } : { id, phone };
  return { ...config, testers: next };
}

// Saves a phone resolved from a session/backup into config.json (timestamped backup + atomic write).
// Synchronous read-modify-write: run it inside the engine process that owns config.json, so it cannot
// interleave with the engine's own writes (group id cache). Never throws; returns { status }.
export function persistTesterPhone({ configFile, id, phone, now = new Date() }) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    return { status: 'unreadable', error: error?.message ?? String(error) };
  }

  const testers = Array.isArray(config?.testers) ? config.testers : [];
  const entry = testers.find((item) => entryId(item) === id);
  if (entry === undefined) return { status: 'not-in-config' };
  if (typeof entry === 'object' && entry && normalizeLinkPhone(entry.phone)) return { status: 'has-phone' };

  // Another tester or the bot already uses this number: saving it would create a duplicate.
  const takenBy = [
    ...testers.filter((item) => entryId(item) !== id).map((item) => [entryId(item), item?.phone]),
    ['bot', config?.bot?.phone],
    ['bot', config?.botNumber],
  ].find(([, value]) => normalizeLinkPhone(value) === phone);
  if (takenBy) return { status: 'duplicate', owner: takenBy[0] };

  try {
    const next = withTesterPhone(config, id, phone);
    backupFile(configFile, now);
    writeJsonAtomic(configFile, next);
    return { status: 'saved' };
  } catch (error) {
    return { status: 'error', error: error?.message ?? String(error) };
  }
}
