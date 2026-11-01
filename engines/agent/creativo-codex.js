// Image generation through the Codex CLI, logged in with the user's ChatGPT plan (never an API key).
// Facts verified on this PC (codex-cli 0.166.0): `codex exec --json` ignores the save path asked in the prompt; the image
// lands in $CODEX_HOME/generated_images/<thread>/<file>.png and its path comes back as the last agent_message.
// So: run Codex in a scratch folder, read the JSONL, find that path (or fall back to the thread's folder), validate it
// lives where Codex writes images, and let the caller copy it to the product folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class CodexError extends Error {}

export const DEFAULT_CODEX_MODEL = 'gpt-6.1-terra';
export const DEFAULT_CODEX_EFFORT = 'low';
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/** CODEX_HOME the way the user's shell resolves it: explicit setting, then the environment, then ~/.codex. */
export const resolveCodexHome = ({ override = '', env = process.env, home = os.homedir() } = {}) => (override && override.trim()) || (env.CODEX_HOME && env.CODEX_HOME.trim()) || path.join(home, '.codex');

const exists = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** { command, prefixArgs } to run codex (an npm `.cmd` shim is resolved to the package it wraps), or null. */
export function locateCodex({ override = '', env = process.env, platform = process.platform, home = os.homedir(), fileExists = exists } = {}) {
  const win = platform === 'win32';
  const candidates = [];
  if (override && override.trim()) candidates.push(override.trim());
  const pathDirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) for (const name of win ? ['codex.exe', 'codex.cmd'] : ['codex']) candidates.push(path.join(dir, name));
  if (win && env.APPDATA) candidates.push(path.join(env.APPDATA, 'npm', 'codex.cmd'));
  candidates.push(path.join(home, '.local', 'bin', win ? 'codex.exe' : 'codex'));
  for (const file of candidates) {
    if (!fileExists(file)) continue;
    if (/\.cmd$/i.test(file)) {
      const js = path.join(path.dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fileExists(js)) return { command: process.execPath, prefixArgs: [js] };
      continue;
    }
    if (/\.(js|mjs|cjs)$/i.test(file)) return { command: process.execPath, prefixArgs: [file] };
    return { command: file, prefixArgs: [] };
  }
  return null;
}

/** Env of the Codex child: the plan's login only. Any OpenAI/Codex API key is removed so nothing is billed to an API account. */
export function codexEnv({ env = process.env, codexHome } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(OPENAI_|CODEX_API_KEY|AZURE_OPENAI)/i.test(key)) continue;
    out[key] = value;
  }
  return { ...out, CODEX_HOME: codexHome };
}

// ---- JSONL ---------------------------------------------------------------------------------------------------------

const PATH_IN_TEXT = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|*?]*?\.(?:png|jpe?g|webp)/gi;

/** Parses the `codex exec --json` output (a string or an array of lines) into what the tool needs. Unknown events are ignored. */
export function parseCodexJsonl(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  const out = { threadId: null, messages: [], finalMessage: '', errors: [], usage: null, candidates: [] };
  const harvest = (value) => {
    if (typeof value === 'string') for (const m of value.matchAll(PATH_IN_TEXT)) out.candidates.push(m[0]);
    else if (Array.isArray(value)) value.forEach(harvest);
    else if (value && typeof value === 'object') Object.values(value).forEach(harvest);
  };
  for (const line of lines) {
    const t = String(line).trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.type === 'thread.started' && ev.thread_id) out.threadId = ev.thread_id;
    if (ev.type === 'item.completed' && ev.item) {
      if (ev.item.type === 'agent_message' && typeof ev.item.text === 'string') out.messages.push(ev.item.text);
      harvest(ev.item);
    }
    if (ev.type === 'turn.completed' && ev.usage) out.usage = ev.usage;
    if (ev.type === 'error' && ev.message) out.errors.push(String(ev.message));
    if (ev.type === 'turn.failed' && ev.error?.message) out.errors.push(String(ev.error.message));
  }
  out.finalMessage = out.messages[out.messages.length - 1] ?? '';
  return out;
}

const norm = (p) => path.resolve(String(p)).replace(/\\/g, '/').toLowerCase();
const isInside = (child, parent) => norm(child) === norm(parent) || norm(child).startsWith(`${norm(parent)}/`);

function newestImage(dir) {
  let best = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!IMAGE_EXT.test(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file: full, mtime: st.mtimeMs };
    }
  } catch {
    /* no folder */
  }
  return best?.file ?? null;
}

/**
 * The generated image's path: the one in the last message first, then any other path mentioned, then the newest image of
 * the thread's folder. Only files inside `<codexHome>/generated_images` (or the scratch folder) are accepted, so a path
 * Codex invents (or a prompt-injected one) can never make the tool copy some other file.
 */
export function findGeneratedImage(parsed, { codexHome, workDir }) {
  const allowed = [path.join(codexHome, 'generated_images'), ...(workDir ? [workDir] : [])];
  const ok = (file) => IMAGE_EXT.test(file) && allowed.some((a) => isInside(file, a)) && exists(file) && fs.statSync(file).size <= MAX_IMAGE_BYTES;
  const fromMessage = [...(parsed.finalMessage.match(PATH_IN_TEXT) ?? [])].reverse();
  for (const file of [...fromMessage, ...[...parsed.candidates].reverse()]) if (ok(file)) return path.resolve(file);
  if (parsed.threadId) {
    const near = newestImage(path.join(codexHome, 'generated_images', parsed.threadId));
    if (near && ok(near)) return near;
  }
  return null;
}

/** Width and height from a PNG header (null for other formats). */
export function pngSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    fs.closeSync(fd);
    if (head.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  }
}

// ---- running codex -------------------------------------------------------------------------------------------------

function run(codex, args, { env, cwd, stdin = '', timeoutMs, spawnFn = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(codex.command, [...codex.prefixArgs, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish(reject, new CodexError(`Codex tardó más de ${Math.round(timeoutMs / 1000)} s y se canceló.`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', (e) => finish(reject, new CodexError(`No se pudo iniciar Codex: ${e.message}`)));
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

/** Throws a Spanish, actionable error unless Codex is logged in with ChatGPT (not an API key). */
export async function ensureChatGptLogin(codex, { env, runFn = run } = {}) {
  const res = await runFn(codex, ['login', 'status'], { env, cwd: os.tmpdir(), timeoutMs: 30_000 });
  const text = `${res.stdout}\n${res.stderr}`;
  if (/chatgpt/i.test(text) && /logged in/i.test(text)) return true;
  if (/api key/i.test(text)) throw new CodexError('Codex está iniciado con una clave de API, no con tu plan de ChatGPT. Abre una terminal y ejecuta `codex login` para entrar con ChatGPT.');
  throw new CodexError('Codex no tiene la sesión iniciada. Abre una terminal y ejecuta `codex login` para entrar con tu cuenta de ChatGPT.');
}

/**
 * Generates one image. Returns { file, threadId, size, usage }. The file stays in Codex's own folder: copy it where it belongs.
 * `runFn` and `codex` are injectable for tests.
 */
export async function generateWithCodex({ instruction, codex, codexHome, model = DEFAULT_CODEX_MODEL, effort = DEFAULT_CODEX_EFFORT, env = process.env, timeoutMs = 300_000, runFn = run, checkLogin = true }) {
  if (!codex) throw new CodexError('No encuentro Codex en este equipo. Instálalo (npm i -g @openai/codex) y entra con `codex login`.');
  const childEnv = codexEnv({ env, codexHome });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentauto-codex-'));
  try {
    if (checkLogin) await ensureChatGptLogin(codex, { env: childEnv, runFn });
    const args = ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-C', workDir, '-m', model, '-c', `model_reasoning_effort=${effort}`, '-'];
    const res = await runFn(codex, args, { env: childEnv, cwd: workDir, stdin: instruction, timeoutMs });
    const parsed = parseCodexJsonl(res.stdout);
    if (parsed.errors.length && !parsed.finalMessage) throw new CodexError(`Codex falló: ${parsed.errors[parsed.errors.length - 1].slice(0, 300)}`);
    let file = findGeneratedImage(parsed, { codexHome, workDir });
    if (file && isInside(file, workDir)) {
      // The scratch folder is deleted below: keep the image somewhere that survives it.
      const keep = path.join(os.tmpdir(), `agentauto-img-${Date.now().toString(36)}${path.extname(file)}`);
      fs.copyFileSync(file, keep);
      file = keep;
    }
    if (!file) throw new CodexError(`Codex terminó pero no encontré la imagen generada. Respuesta: ${parsed.finalMessage.slice(0, 200) || '(vacía)'}`);
    return { file, threadId: parsed.threadId, size: pngSize(file), usage: parsed.usage };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
