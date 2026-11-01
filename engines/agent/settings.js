// Agent settings (<data dir>/analista/settings.json for the Analista, <data dir>/agents/<id>/settings.json for the rest). Never holds secrets: the agent runs on the Claude Code login.
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

/**
 * `extra` = { key: validator } for settings only some agents have (e.g. the creativo's Codex options); a validator returns the
 * cleaned value or throws SettingsError.
 */
export function mergeSettings(partial = {}, base = DEFAULT_SETTINGS, extra = {}) {
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
  for (const [key, check] of Object.entries(extra)) if (p[key] !== undefined) out[key] = check(p[key]);
  return out;
}

// An agent may bring its own defaults (`defaultSettings`) and extra validated keys (`settingsSchema`); the Analista has neither.
const baseOf = (agent) => ({ ...DEFAULT_SETTINGS, ...(agent && typeof agent === 'object' ? agent.defaultSettings : {}) });
const schemaOf = (agent) => (agent && typeof agent === 'object' ? (agent.settingsSchema ?? {}) : {});

export function loadSettings(dataDir, agent) {
  try {
    return mergeSettings(JSON.parse(fs.readFileSync(settingsPath(dataDir, agent), 'utf8').replace(/^﻿/, '')), baseOf(agent), schemaOf(agent));
  } catch {
    return { ...baseOf(agent) };
  }
}

export function saveSettings(dataDir, partial, agent) {
  const next = mergeSettings(partial, loadSettings(dataDir, agent), schemaOf(agent));
  const file = settingsPath(dataDir, agent);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}
