// Analista settings (<data dir>/analista/settings.json). Never holds secrets: the agent runs on the Claude Code login.
import fs from 'node:fs';
import path from 'node:path';

import { settingsPath } from './paths.js';

export const MODEL_ALIASES = ['', 'sonnet', 'opus', 'haiku'];

export const DEFAULT_SETTINGS = Object.freeze({
  // Empty = auto-detect (PATH, ~/.local/bin, npm global).
  claudePath: '',
  // Empty = the CLI's own default model.
  model: '',
  web: true,
  // Master switch of the learning loop: recommendations, outcomes, lessons injected into the agent.
  learning: true,
});

export class SettingsError extends Error {}

export function mergeSettings(partial = {}, base = DEFAULT_SETTINGS) {
  const p = partial ?? {};
  const out = { ...base };
  if (p.claudePath !== undefined) {
    const v = String(p.claudePath ?? '').trim();
    if (v.length > 400 || /[\r\n\0"]/.test(v)) throw new SettingsError('La ruta de Claude Code no es válida.');
    out.claudePath = v;
  }
  if (p.model !== undefined) {
    const v = String(p.model ?? '').trim();
    if (!MODEL_ALIASES.includes(v) && !/^claude-[a-z0-9.\-[\]]{3,60}$/i.test(v)) throw new SettingsError('El modelo debe ser sonnet, opus, haiku, un nombre completo o vacío.');
    out.model = v;
  }
  if (p.web !== undefined) out.web = Boolean(p.web);
  if (p.learning !== undefined) out.learning = Boolean(p.learning);
  return out;
}

export function loadSettings(dataDir) {
  try {
    return mergeSettings(JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8').replace(/^﻿/, '')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(dataDir, partial) {
  const next = mergeSettings(partial, loadSettings(dataDir));
  const file = settingsPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}
