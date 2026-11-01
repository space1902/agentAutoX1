// Access guard of the Investigador de productos (a Claude Code PreToolUse hook, also a pure module so every decision is tested).
// The agent browses the Meta Ad Library with a few Claude-in-Chrome tools and reads its own skill and past reports. Nothing else:
//   - files: Read only, inside the reports folder and the plugin copy of the skill (never writes: reports go through save_research)
//   - browser: tabs and page text, and `navigate` ONLY to the Ad Library (read-only: no clicks, no typing, no scripts, no screenshots of
//     logged-in pages, no downloads). A page that asks for a login or a CAPTCHA is reported to the user, never solved
//   - MCP: its own server; any other server is refused. Bash, Task and the rest do not exist for it
//   - Skill: only the plugin's own skills
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fileToolDecision, hookOutput, makeContext } from './creativo-guard.js';

export const INVESTIGADOR_PLUGIN = 'investigador';
export const INVESTIGADOR_SERVER = 'investigador';
const OWN_PREFIX = `mcp__${INVESTIGADOR_SERVER}__`;
const CHROME_PREFIX = 'mcp__claude-in-chrome__';
// The only browser tools the agent gets (see INVESTIGADOR_BROWSER_TOOLS in investigador-workspace.js).
export const BROWSER_TOOLS = Object.freeze(['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp', 'navigate', 'get_page_text']);
export const AD_LIBRARY = /^https:\/\/(www\.)?facebook\.com\/ads\/library\/(\?|$)/i;
const OWN_TOOLS = ['library_url', 'list_research', 'save_research', 'mark_launched', 'propose_threshold_update', 'get_lessons', 'propose_lesson', 'propose_rule'];

const deny = (reason) => ({ decision: 'deny', reason });
const PASS = { decision: 'pass' };

export function browserDecision(short, input) {
  if (!BROWSER_TOOLS.includes(short)) return deny(`El navegador solo se usa para leer la Biblioteca de anuncios (herramienta ${short} no permitida).`);
  if (short === 'navigate' || (short === 'tabs_create_mcp' && input.url)) {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!AD_LIBRARY.test(url)) return deny('Solo puedes abrir la Biblioteca de anuncios de Meta (https://www.facebook.com/ads/library/). No abras otras páginas ni inicies sesión.');
    // Not in --allowedTools: only this explicit allow lets a page open (a hook that fails or times out leaves it denied).
    return { decision: 'allow' };
  }
  if (short === 'tabs_create_mcp') return { decision: 'allow' };
  return PASS;
}

export function decide(event, ctxOptions) {
  const tool = String(event?.tool_name ?? '');
  const input = event?.tool_input ?? {};
  if (tool.startsWith(OWN_PREFIX)) return OWN_TOOLS.includes(tool.slice(OWN_PREFIX.length)) ? PASS : deny(`La herramienta "${tool.slice(OWN_PREFIX.length)}" no existe para este agente.`);
  if (tool.startsWith(CHROME_PREFIX)) return browserDecision(tool.slice(CHROME_PREFIX.length), input);
  if (tool.startsWith('mcp__')) return deny('Ese servidor externo no está permitido para este agente.');
  if (tool === 'Skill') {
    const name = String(input.skill ?? input.name ?? '');
    return name.startsWith(`${INVESTIGADOR_PLUGIN}:`) ? PASS : deny(`Solo puedes usar las skills del plugin "${INVESTIGADOR_PLUGIN}" (por ejemplo ${INVESTIGADOR_PLUGIN}:investigacion-mercado).`);
  }
  if (tool === 'Read') {
    const ctx = makeContext({ ...ctxOptions, cwd: event?.cwd || ctxOptions.root });
    // Reads stay inside the reports folder and the plugin copy (makeContext also lists the user's skills folder: not here).
    return fileToolDecision('Read', input, { ...ctx, readRoots: [ctx.root, ctx.pluginRoot].filter(Boolean) }) ?? PASS;
  }
  if (tool === 'WebSearch') return PASS;
  return deny(`La herramienta ${tool || 'desconocida'} no está disponible para este agente.`);
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
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    const root = get('--root');
    if (!root) throw new Error('missing --root');
    out = hookOutput(decide(event, { root, pluginDir: get('--plugin'), skillsDir: '' }));
  } catch (error) {
    out = hookOutput(deny(`El guardián de acceso falló y por seguridad se bloquea la acción (${String(error?.message ?? error).slice(0, 120)}).`));
  }
  if (out) process.stdout.write(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
