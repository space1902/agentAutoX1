// Access guard of the Agente creativo. It runs as a Claude Code PreToolUse hook (see creativo-workspace.js) and is also
// a pure module so every decision is unit-tested.
//
// Why a hook and not only --add-dir: the spike showed --add-dir does NOT confine reads, so the workspace (which also
// holds the app's own code, bot sessions and credential files) is protected here:
//   - file tools: path allow-roots + a list of protected places (code of the apps, secrets, auth sessions, node_modules)
//   - Bash: a small allowlist of programs, quote-aware, no inline code, no deletion, no git, no free network, no ElevenLabs
//   - Higgsfield: default-deny; only read/free tools pass, everything that can spend credits is refused
//   - Skill: only the plugin's own skills
// Decisions: { decision: 'deny', reason } | { decision: 'allow' } (only for validated Bash / Higgsfield reads) | { decision: 'pass' }
// ('pass' = no opinion, the normal permission flow with --allowedTools applies).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'creativo';

// Higgsfield tools the agent may call in this phase: read-only or free. Everything else (generate_*, execute_preset,
// upscale/outpaint/reframe/remove_background, dubbing, voices, apps, websites...) is refused by default.
export const HIGGSFIELD_READ_TOOLS = Object.freeze([
  'balance', 'models_explore', 'get_presets', 'jobs_wait',
  'list_folders', 'list_projects', 'list_project_assets', 'list_voices', 'list_websites', 'list_website_categories', 'list_workspaces',
  'show_characters', 'show_credit_reset', 'show_generation_by_ids', 'show_generations', 'show_katana_result', 'show_marketing_studio_generations',
  'show_medias', 'show_plans_and_credits', 'show_reference_elements', 'show_result',
]);
// show_* / list_* tools that exist but open a generation flow: never allowed.
const HIGGSFIELD_NEVER = new Set(['show_marketing_studio_v2']);
const HIGGSFIELD_PREFIX = 'mcp__higgsfield__';

export function isHiggsfieldRead(shortName) {
  if (HIGGSFIELD_NEVER.has(shortName)) return false;
  return HIGGSFIELD_READ_TOOLS.includes(shortName) || /^(list|show)_[a-z0-9_]+$/.test(shortName);
}

// ---- paths -----------------------------------------------------------------------------------------------------

const PROTECTED_SEGMENTS = new Set(['agentautox1', 'meta-ads-monitor', 'node_modules', '.baileys_auth', '.wwebjs_auth', '.git', '.ssh', '.aws', '.gnupg', '.azure', '.kube']);
const PROTECTED_BASENAME = [
  /^\.env/, /token.*\.txt$/, /^api[-_ ]?key/, /^codigos-recuperac/, /^id_(rsa|dsa|ecdsa|ed25519)/, /\.(pem|key|pfx|p12|ppk|kdbx|keystore)$/,
  /^(credentials?|secrets?)(\.|$)/, /^\.(npmrc|netrc|pypirc|git-credentials)$/, /^\.credentials\.json$/, /^\.claude\.json$/, /^auth_info/,
];
// Same things as free text, for Glob patterns and Bash command lines.
const PROTECTED_TEXT = [
  /agentautox1/, /meta-ads-monitor/, /whatsapp-(bot-tester|pods)/, /\.baileys_auth/, /\.wwebjs_auth/, /node_modules/, /codigos-recuperac/, /api[-_ ]?key/,
  /token[^/"'\n]{0,40}\.txt/, /(^|[^a-z0-9])\.env([^a-z0-9]|$)/, /\.(pem|ppk|pfx|p12|kdbx)\b/, /id_(rsa|dsa|ecdsa|ed25519)/, /\.credentials\.json/, /\.claude\.json/,
  /(^|[\s/"'])\.(ssh|aws|gnupg|git)(\/|[\s"']|$)/,
];

const slash = (p) => String(p ?? '').replace(/\\/g, '/');

/** Absolute, lower-cased, forward-slash path ('' when it cannot be resolved). Handles git-bash `/c/...` and `~`. */
export function resolvePath(p, base, home) {
  let s = slash(p).trim().replace(/^\\\\\?\\/, '').replace(/^\/\/\?\//, '');
  if (!s) return '';
  if (s === '~' || s.startsWith('~/')) s = `${slash(home)}${s.slice(1)}`;
  const gitBash = /^\/([a-zA-Z])(\/|$)/.exec(s);
  if (gitBash) s = `${gitBash[1]}:${s.slice(2) || '/'}`;
  const absolute = /^[a-zA-Z]:\//.test(s) || s.startsWith('/');
  const joined = absolute ? s : `${slash(base).replace(/\/+$/, '')}/${s}`;
  return path.posix.normalize(joined).replace(/\/+$/, '').toLowerCase() || '/';
}

const segmentsOf = (resolved) => resolved.split('/').filter(Boolean);
const isInside = (child, parent) => !!parent && (child === parent || child.startsWith(`${parent}/`));

/** Why a resolved path is protected, or null. `root` is the workspace (lower-case, resolved). */
export function protectedReason(resolved, root) {
  const segs = segmentsOf(resolved);
  const base = segs[segs.length - 1] ?? '';
  const rel = isInside(resolved, root) ? segmentsOf(resolved.slice(root.length)) : [];
  if (segs.some((s) => PROTECTED_SEGMENTS.has(s))) return 'Esa ruta contiene código, sesiones o secretos de las apps y está bloqueada.';
  if (rel[0]?.startsWith('whatsapp-')) return 'Las carpetas de los bots de WhatsApp están bloqueadas.';
  if (segs.some((s) => s.startsWith('whatsapp-bot-tester'))) return 'Las carpetas de los bots de WhatsApp están bloqueadas.';
  if (PROTECTED_BASENAME.some((re) => re.test(base))) return 'Ese archivo parece contener claves o credenciales y está bloqueado.';
  const claudeAt = segs.indexOf('.claude');
  if (claudeAt >= 0 && segs[claudeAt + 1] !== 'skills') return 'La configuración de Claude Code está bloqueada.';
  return null;
}

/** Roots the file tools may touch. Reads: the workspace, the plugin copy of the skills, the user's skills folder. Writes: the workspace only. */
export function makeContext({ root, pluginDir = '', skillsDir = '', home = os.homedir(), cwd } = {}) {
  const r = resolvePath(root, root, home);
  return {
    root: r,
    cwd: resolvePath(cwd || root, r, home) || r,
    home: slash(home),
    // The plugin copy lives in the app's data folder, whose own name is on the protected list: it is exempt by explicit root.
    pluginRoot: resolvePath(pluginDir, r, home),
    readRoots: [r, resolvePath(pluginDir, r, home), resolvePath(skillsDir || `${slash(home)}/.claude/skills`, r, home)].filter(Boolean),
  };
}

/** Literal part of a glob before its first wildcard. */
const literalPrefix = (pattern) => {
  const parts = slash(pattern).split('/');
  const keep = [];
  for (const part of parts) {
    if (/[*?[\]{}]/.test(part)) break;
    keep.push(part);
  }
  return keep.join('/');
};

/** Lower-case text with the plugin folder's path blanked out (that folder sits inside the app's data dir, whose name is protected). */
const withoutPlugin = (text, ctx) => {
  const flat = slash(text).toLowerCase();
  return ctx.pluginRoot ? flat.split(ctx.pluginRoot).join('<plugin>') : flat;
};

const deny = (reason) => ({ decision: 'deny', reason });
const PASS = { decision: 'pass' };

function checkPath(raw, ctx, { write = false, recursive = false } = {}) {
  const resolved = resolvePath(raw, ctx.cwd, ctx.home);
  if (!resolved) return deny('Falta la ruta del archivo.');
  const inPlugin = isInside(resolved, ctx.pluginRoot);
  const bad = inPlugin && !write ? null : protectedReason(resolved, ctx.root);
  if (bad) return deny(bad);
  if (write) {
    if (!isInside(resolved, ctx.root)) return deny('Solo puedes escribir dentro de la carpeta de trabajo (ventas automaticas).');
    return null;
  }
  if (!ctx.readRoots.some((r) => isInside(resolved, r))) return deny('Solo puedes leer dentro de la carpeta de trabajo y de las skills.');
  // Searching from the workspace root (or above) in depth would walk through every protected folder.
  if (recursive && (resolved === ctx.root || ctx.root.startsWith(`${resolved}/`))) return deny('Indica una carpeta concreta (por ejemplo Producto Bebidas) en vez de buscar en toda la carpeta de trabajo.');
  return null;
}

function fileToolDecision(tool, input, ctx) {
  switch (tool) {
    case 'Read':
      return checkPath(input.file_path, ctx);
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const bad = checkPath(input.file_path, ctx, { write: true });
      if (bad) return bad;
      const segs = segmentsOf(resolvePath(input.file_path, ctx.cwd, ctx.home));
      if (segs.includes('.claude') || segs[segs.length - 1] === 'claude.md') return deny('No puedes crear ni cambiar configuración, hooks ni skills de Claude Code.');
      return null;
    }
    case 'NotebookEdit':
      return checkPath(input.notebook_path, ctx, { write: true });
    case 'Glob': {
      const pattern = String(input.pattern ?? '');
      if (PROTECTED_TEXT.some((re) => re.test(withoutPlugin(pattern, ctx)))) return deny('Ese patrón apunta a archivos bloqueados.');
      const basePath = input.path || ctx.cwd;
      const prefix = literalPrefix(pattern);
      const start = prefix ? `${slash(basePath).replace(/\/+$/, '')}/${prefix}` : basePath;
      return checkPath(start, ctx, { recursive: /\*\*/.test(pattern) });
    }
    case 'Grep': {
      if (input.glob && PROTECTED_TEXT.some((re) => re.test(slash(input.glob).toLowerCase()))) return deny('Ese patrón apunta a archivos bloqueados.');
      return checkPath(input.path || ctx.cwd, ctx, { recursive: true });
    }
    default:
      return null;
  }
}

// ---- Bash ------------------------------------------------------------------------------------------------------

/** Splits a command line into segments (separated by && || ; | & newline) of word tokens, honouring quotes. Returns null when it holds substitution. */
export function parseCommand(line) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  const endToken = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  const s = String(line);
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (c === '`' || (c === '$' && s[i + 1] === '(') || ((c === '<' || c === '>') && s[i + 1] === '(')) return null;
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && /["\\$]/.test(s[i + 1] ?? '')) {
        cur += s[i + 1];
        i += 1;
      } else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && s[i + 1] !== undefined && !/[a-zA-Z0-9:]/.test(s[i + 1])) {
      // escaped metacharacter; a backslash before a letter or drive colon is a Windows path separator and is kept.
      cur += s[i + 1];
      has = true;
      i += 1;
    } else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      if ((c === '|' || c === '&') && s[i + 1] === c) i += 1;
      endSegment();
    } else if (/\s/.test(c)) endToken();
    else {
      cur += c;
      has = true;
    }
  }
  if (quote) return null;
  endSegment();
  return segments;
}

const binName = (token) => slash(token).split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');

const FORBIDDEN_WHY = new Map([
  ...['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'unlink', 'shred'].map((b) => [b, 'Borrar archivos está desactivado para este agente.']),
  ...['git', 'gh'].map((b) => [b, 'Git no está disponible para este agente.']),
  ...['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'scp', 'ssh', 'ftp', 'nc', 'ncat'].map((b) => [b, 'Las descargas y llamadas de red a sitios arbitrarios están bloqueadas (usa WebFetch para leer una página).']),
  ...['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'wsl', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'reg', 'setx', 'taskkill', 'schtasks', 'sc', 'net', 'icacls', 'attrib', 'move', 'mv', 'ren', 'rename'].map((b) => [b, 'Ese programa no está permitido para este agente.']),
]);
const ALLOWED_BINS = new Set(['python', 'python3', 'py', 'ffmpeg', 'ffprobe', 'yt-dlp', 'dir', 'ls', 'eza', 'cd', 'mkdir']);
const PYTHON = new Set(['python', 'python3', 'py']);
const PY_SAFE_FLAGS = new Set(['-u', '-b', '-e', '-s', '-o', '-oo']);
const SPEND = [
  [/eleven|xi-api-key|tts_elevenlabs/, 'ElevenLabs gasta dinero y está bloqueado para este agente en esta fase.'],
  [/gen_image_fal|fal\.ai|fal_key|fal-key/, 'fal.ai gasta dinero y está bloqueado para este agente en esta fase.'],
  [/higgsfield\.ai|hf_api/, 'Higgsfield solo se consulta con sus herramientas de lectura, no desde la terminal.'],
];
const YT_FORBIDDEN = /^--?(exec|exec-before-download|cookies|cookies-from-browser|netrc|netrc-cmd|netrc-location|username|password|config-locations?|plugin-dirs|ap-mso|ap-username|ap-password|video-password)(=|$)/i;
const looksAbsolute = (t) => /^([a-zA-Z]:[\\/]|\/|\\\\|~)/.test(t) && !/^\/\d+$/.test(t);

/** Decision for one Bash command line. */
export function bashDecision(command, ctx) {
  const line = String(command ?? '');
  if (!line.trim()) return deny('Comando vacío.');
  const flat = withoutPlugin(line, ctx);
  for (const [re, why] of SPEND) if (re.test(flat)) return deny(why);
  if (PROTECTED_TEXT.some((re) => re.test(flat))) return deny('El comando toca archivos o carpetas bloqueados (código de las apps, sesiones o claves).');
  const segments = parseCommand(line);
  if (!segments) return deny('No se permiten sustituciones de comandos ni comillas sin cerrar.');
  if (!segments.length) return deny('Comando vacío.');
  for (const tokens of segments) {
    const bin = binName(tokens[0]);
    if (FORBIDDEN_WHY.has(bin)) return deny(FORBIDDEN_WHY.get(bin));
    if (!ALLOWED_BINS.has(bin)) return deny(`El programa "${bin}" no está en la lista permitida (python con un script, ffmpeg, yt-dlp, dir/ls).`);
    const args = tokens.slice(1);
    if (PYTHON.has(bin)) {
      let i = 0;
      while (i < args.length) {
        const a = args[i].toLowerCase();
        if (a === '-x') i += 2;
        else if (PY_SAFE_FLAGS.has(a) || /^-3(\.\d+)?(-\d+)?$/.test(a)) i += 1;
        else break;
      }
      const script = args[i];
      if (!script || !/\.py$/i.test(script)) return deny('Python solo puede ejecutar un archivo .py (sin -c, -m ni código en línea).');
      const bad = checkPath(script, ctx);
      if (bad) return bad;
    }
    if (bin === 'yt-dlp' && args.some((a) => YT_FORBIDDEN.test(a))) return deny('Esa opción de yt-dlp (cookies, credenciales o ejecutar comandos) está bloqueada.');
    for (const a of args) {
      const value = a.includes('=') && !/^[a-zA-Z]:[\\/]/.test(a) && a.startsWith('-') ? a.slice(a.indexOf('=') + 1) : a;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value === '/dev/null') continue; // URL or the null device
      if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return deny('No uses ".." para salir de la carpeta de trabajo.');
      if (looksAbsolute(value)) {
        const bad = checkPath(value, ctx, { write: bin === 'yt-dlp' || bin === 'mkdir' });
        if (bad) return bad;
      }
    }
  }
  return { decision: 'allow' };
}

// ---- entry point -----------------------------------------------------------------------------------------------

/** @param {{ tool_name: string, tool_input?: object, cwd?: string }} event hook input @param {object} ctxOptions see makeContext */
export function decide(event, ctxOptions) {
  const tool = String(event?.tool_name ?? '');
  const input = event?.tool_input ?? {};
  const ctx = makeContext({ ...ctxOptions, cwd: event?.cwd || ctxOptions.cwd });
  if (tool.startsWith(HIGGSFIELD_PREFIX)) {
    const short = tool.slice(HIGGSFIELD_PREFIX.length);
    return isHiggsfieldRead(short) ? { decision: 'allow' } : deny(`Higgsfield "${short}" puede gastar créditos: en esta fase solo se consulta (saldo, modelos, historial). Dile al usuario el costo estimado y espera.`);
  }
  if (tool.startsWith('mcp__')) return deny('Ese servidor externo no está permitido para este agente.');
  if (tool === 'Skill') {
    const name = String(input.skill ?? input.name ?? '');
    return name.startsWith(`${PLUGIN_NAME}:`) ? PASS : deny(`Solo puedes usar las skills del plugin "${PLUGIN_NAME}" (por ejemplo ${PLUGIN_NAME}:redaccion-infoproducto).`);
  }
  if (tool === 'Bash') return bashDecision(input.command, ctx);
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'].includes(tool)) return fileToolDecision(tool, input, ctx) ?? PASS;
  return PASS;
}

/** What the hook prints on stdout for a decision ('' = no opinion). */
export function hookOutput(result) {
  if (result.decision === 'pass') return '';
  const body = { hookEventName: 'PreToolUse', permissionDecision: result.decision };
  if (result.decision === 'deny') body.permissionDecisionReason = result.reason;
  return JSON.stringify({ hookSpecificOutput: body });
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : '';
  };
  let out;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));
    const root = get('--root');
    if (!root) throw new Error('missing --root');
    out = hookOutput(decide(event, { root, pluginDir: get('--plugin'), skillsDir: get('--skills') }));
  } catch (error) {
    // Fail closed: if the guard cannot decide, nothing runs.
    out = hookOutput(deny(`El guardián de acceso falló y por seguridad se bloquea la acción (${String(error?.message ?? error).slice(0, 120)}).`));
  }
  if (out) process.stdout.write(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
