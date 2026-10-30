// Everything the Agente creativo needs on disk and on the command line, built at run time:
//   - the local plugin <data>/agents/creativo/plugin/ with a whitelist of the user's skills (copied, refreshed when newer)
//   - the --settings file with the deny rules and the PreToolUse guard hook (creativo-guard.js)
//   - the Higgsfield MCP entry (URL read from ~/.claude.json at run time; no token is ever copied)
//   - the child environment without any key-like variable
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HIGGSFIELD_READ_TOOLS, PLUGIN_NAME } from './creativo-guard.js';
import { agentDir } from './paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const slash = (p) => String(p).replace(/\\/g, '/');

export const DEFAULT_ROOT = 'C:\\Users\\victo\\Proyectos\\ventas automaticas';
// Skills copied into the plugin. leona-receipts is deliberately NOT here.
export const CREATIVO_SKILLS = Object.freeze(['new-product', 'adapt-country', 'redaccion-infoproducto', 'ads-infoproductos', 'compress-pdf', 'usage-higgsfield']);

export const creativoRoot = (env = process.env) => (env.AGENTAUTO_CREATIVO_ROOT && env.AGENTAUTO_CREATIVO_ROOT.trim()) || DEFAULT_ROOT;
export const userSkillsDir = (home = os.homedir()) => path.join(home, '.claude', 'skills');
export const pluginDirOf = (dataDir) => path.join(agentDir(dataDir, 'creativo'), 'plugin');

// ---- plugin ----------------------------------------------------------------------------------------------------

const SKIP = new Set(['__pycache__', 'node_modules', '.git']);

/** Newest mtime (ms) in a tree, ignoring caches; 0 when missing. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.endsWith('.pyc')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  try {
    walk(dir);
  } catch {
    return 0;
  }
  return newest;
}

/**
 * Builds or refreshes the plugin. A skill is copied when it is not there yet or when anything in the source is newer
 * (SKILL.md included). Skills missing at the source are logged and skipped; skills in the plugin that are not on the
 * whitelist are removed. Returns { pluginDir, included, missing, refreshed, removed }.
 */
export function buildCreativoPlugin({ dataDir, skillsSource = userSkillsDir(), skills = CREATIVO_SKILLS, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const pluginDir = pluginDirOf(dataDir);
  const skillsDir = path.join(pluginDir, 'skills');
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  const manifest = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  const body = `${JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', description: 'Skills del Agente creativo (copia generada por la app; no la edites).' }, null, 2)}\n`;
  if (!fs.existsSync(manifest) || fs.readFileSync(manifest, 'utf8') !== body) fs.writeFileSync(manifest, body, 'utf8');

  const included = [];
  const missing = [];
  const refreshed = [];
  for (const name of skills) {
    const src = path.join(skillsSource, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
      missing.push(name);
      log(`[creativo] skill "${name}" no encontrada en ${skillsSource}: se omite.`);
      continue;
    }
    const dest = path.join(skillsDir, name);
    // 1 s of slack: copied timestamps are not bit-identical on every file system.
    const stale = !fs.existsSync(path.join(dest, 'SKILL.md')) || newestMtime(src) > newestMtime(dest) + 1000;
    if (stale) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true, filter: (from) => !SKIP.has(path.basename(from)) && !from.endsWith('.pyc') });
      refreshed.push(name);
    }
    included.push(name);
  }
  const removed = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (included.includes(entry.name)) continue;
    fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return { pluginDir, included, missing, refreshed, removed };
}

// ---- Higgsfield ------------------------------------------------------------------------------------------------

/** { type, url } of the user's Higgsfield MCP from ~/.claude.json, or null. Only those two fields are ever read out. */
export function readHiggsfieldServer({ home = os.homedir(), readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  try {
    const json = JSON.parse(readFile(path.join(home, '.claude.json')).replace(/^﻿/, ''));
    const entry = json?.mcpServers?.higgsfield;
    const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
    if (!/^https:\/\/[^\s"']+$/.test(url)) return null;
    return { type: 'http', url };
  } catch {
    return null;
  }
}

export const higgsfieldAllowedTools = () => HIGGSFIELD_READ_TOOLS.map((t) => `mcp__higgsfield__${t}`);

// ---- permissions -----------------------------------------------------------------------------------------------

// Bash patterns the CLI itself matches (the hook is stricter and quote-aware; both must agree).
export const BASH_ALLOW = Object.freeze(['Bash(python *)', 'Bash(python3 *)', 'Bash(py *)', 'Bash(ffmpeg *)', 'Bash(ffprobe *)', 'Bash(yt-dlp *)', 'Bash(dir)', 'Bash(dir *)', 'Bash(ls)', 'Bash(ls *)']);
const BASH_DENY = ['rm', 'del', 'erase', 'rmdir', 'rd', 'Remove-Item', 'git', 'curl', 'wget', 'Invoke-WebRequest', 'iwr', 'Invoke-RestMethod', 'powershell', 'pwsh', 'cmd'].map((b) => `Bash(${b} *)`);
const DENIED_PATHS = ['**/agentAutoX1/**', '**/whatsapp-*/**', '**/meta-ads-monitor/**', '**/.env*', '**/*Token*.txt', '**/apikey*', '**/codigos-recuperac*', '**/.baileys_auth/**', '**/.wwebjs_auth/**', '**/node_modules/**', '**/*.pem', '**/id_rsa*', '**/.ssh/**', '**/.aws/**', '**/credentials*', '**/.git/**'];

/** Content of the --settings file: deny rules (first line of defence) and the guard hook (second, with the real logic). */
export function buildGuardSettings({ root, pluginDir, skillsDir, nodePath = process.execPath, guardFile = path.join(HERE, 'creativo-guard.js') }) {
  const command = `"${slash(nodePath)}" "${slash(guardFile)}" --root "${slash(root)}" --plugin "${slash(pluginDir)}" --skills "${slash(skillsDir)}"`;
  const fileDeny = DENIED_PATHS.flatMap((p) => [`Read(${p})`, `Edit(${p})`]);
  return {
    permissions: { deny: [...fileDeny, ...BASH_DENY, 'Skill(leona-receipts)', 'Bash(*elevenlabs*)', 'Bash(*tts_elevenlabs*)', 'Bash(*gen_image_fal*)', 'Bash(python -c *)', 'Bash(python3 -c *)', 'Bash(python -m *)', 'Bash(py -c *)'] },
    hooks: { PreToolUse: [{ matcher: 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|Bash|Skill|mcp__.*', hooks: [{ type: 'command', command, timeout: 15 }] }] },
  };
}

// ---- environment -----------------------------------------------------------------------------------------------

const KEEP_ENV = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CONFIG_DIR']);
const SECRET_ENV = /(api[_-]?key|token|secret|passw|credential|private[_-]?key|^eleven|^xi_|^fal_|^groq|^deepseek|^openai|^higgsfield|^leona|^xpag|^meta_|^fb_|^aws_|^gh_|^github_)/i;

/** Drops every key-like variable from the child env (scripts must not find ElevenLabs, fal, Meta or other keys there). */
export function scrubSecrets(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!KEEP_ENV.has(key.toUpperCase()) && SECRET_ENV.test(key)) continue;
    out[key] = value;
  }
  return { ...out, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}

// ---- launch ----------------------------------------------------------------------------------------------------

/**
 * Prepares one turn: refreshes the plugin, writes the settings file and resolves the MCP entry.
 * Returns the extras buildClaudeArgs / writeMcpConfig / runTurn merge in.
 */
export function prepareCreativoLaunch({ dataDir, root = creativoRoot(), skillsSource, home = os.homedir(), log, nodePath } = {}) {
  const plugin = buildCreativoPlugin({ dataDir, skillsSource: skillsSource ?? userSkillsDir(home), log });
  const dir = agentDir(dataDir, 'creativo');
  const settingsFile = path.join(dir, 'guard-settings.json');
  const skillsDir = userSkillsDir(home);
  fs.writeFileSync(settingsFile, `${JSON.stringify(buildGuardSettings({ root, pluginDir: plugin.pluginDir, skillsDir, ...(nodePath ? { nodePath } : {}) }), null, 2)}\n`, 'utf8');
  const higgsfield = readHiggsfieldServer({ home });
  return {
    pluginDir: plugin.pluginDir,
    settingsFile,
    allowedTools: [...BASH_ALLOW, ...(higgsfield ? higgsfieldAllowedTools() : [])],
    mcpServers: higgsfield ? { higgsfield } : {},
    plugin,
  };
}
