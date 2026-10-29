// One chat turn: store the user message, run Claude Code headless against our MCP server, stream normalized events,
// check the figures of the answer against the turn's tool results, and persist everything in agent.db.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { openAgentStore } from './agent-db.js';
import { buildClaudeArgs, childEnv, locateClaude } from './claude-cli.js';
import { ungroundedFigures, uniqueRaw } from './grounding.js';
import { systemPromptAppend, workspaceClaudeMd } from './knowledge.js';
import { accountToday } from './metrics.js';
import { analistaDir, workspaceDir } from './paths.js';
import { loadSettings } from './settings.js';
import { createStreamParser } from './stream-parser.js';
import { BASE_TOOL_NAMES, LEARNING_TOOL_NAMES } from './tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MCP_SERVER_FILE = path.join(HERE, 'ads-mcp.js');
const TITLE_MAX = 60;

export function ensureWorkspace(dataDir, settings) {
  const dir = workspaceDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  // Rewritten every turn so it always matches this version of the app.
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), workspaceClaudeMd({ web: settings.web, learning: settings.learning }), 'utf8');
  return dir;
}

export function writeMcpConfig(dataDir, { turnId, sessionId, question, learning, toolsEnv = {} }) {
  const file = path.join(analistaDir(dataDir), `mcp-${turnId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const config = {
    mcpServers: {
      analista: {
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', MCP_SERVER_FILE],
        env: {
          AGENTAUTO_DATA_DIR: dataDir,
          AGENTAUTO_SESSION_ID: sessionId,
          AGENTAUTO_QUESTION: String(question ?? '').slice(0, 500),
          AGENTAUTO_LEARNING: learning ? '1' : '0',
          ...toolsEnv,
        },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config), 'utf8');
  return file;
}

// Kills one process tree (only that pid): taskkill on Windows, SIGKILL elsewhere.
export function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

const titleOf = (text) => {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
};

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {string} [o.sessionId] existing chat (a new one is created when missing)
 * @param {string} o.text user message
 * @param {(event: object) => void} o.emit
 * @param {(cancel: () => void) => void} [o.registerCancel]
 * @param {{ command: string, prefixArgs: string[] }} [o.claude] override (tests)
 * @param {object} [o.hooks] learning hooks (see learning.js)
 * @returns {Promise<{ ok: boolean, sessionId: string, messageId?: number, cancelled?: boolean, error?: string }>}
 */
export async function runTurn({ dataDir, sessionId, text, emit, registerCancel, claude, settings, now = Date.now, spawnFn = spawn, locate = locateClaude, store: given, hooks = {} }) {
  const store = given ?? openAgentStore(dataDir);
  const own = !given;
  const cfg = settings ?? loadSettings(dataDir);
  const turnId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  let mcpFile = null;
  try {
    if (!String(text ?? '').trim()) throw new Error('Escribe una pregunta.');
    let session = sessionId ? store.getSession(sessionId) : null;
    if (sessionId && !session) throw new Error('No encuentro ese chat.');
    if (!session) {
      sessionId = store.createSession(titleOf(text));
      session = store.getSession(sessionId);
    } else if (session.title === 'Nuevo chat') store.renameSession(sessionId, titleOf(text));
    const userMessageId = store.addMessage({ sessionId, role: 'user', text });
    hooks.onUserMessage?.({ store, sessionId, userMessageId, text });
    emit({ type: 'turn_start', sessionId, userMessageId });

    const located = claude ?? locate({ override: cfg.claudePath });
    if (!located) {
      throw new Error('No encuentro Claude Code en este equipo. Instálalo (claude.ai/download) o indica la ruta de claude.exe en los ajustes del Analista.');
    }

    ensureWorkspace(dataDir, cfg);
    mcpFile = writeMcpConfig(dataDir, { turnId, sessionId, question: text, learning: cfg.learning });
    const lessons = cfg.learning && hooks.lessons ? hooks.lessons({ store }) : [];
    const args = [
      ...located.prefixArgs,
      ...buildClaudeArgs({
        mcpConfigFile: mcpFile, toolNames: [...BASE_TOOL_NAMES, ...(cfg.learning ? LEARNING_TOOL_NAMES : [])], web: cfg.web, model: cfg.model, resume: session.claudeSessionId,
        appendSystemPrompt: systemPromptAppend({ today: accountToday(dataDir, now()), lessons, web: cfg.web, learning: cfg.learning }),
      }),
    ];

    const parser = createStreamParser();
    const steps = [];
    let streamText = '';
    let result = null;
    let plan = null;
    let cancelled = false;
    let stderrTail = '';

    const child = spawnFn(located.command, args, { cwd: workspaceDir(dataDir), env: childEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    registerCancel?.(() => {
      cancelled = true;
      killTree(child);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(text);
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-2000);
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      // Diagnostics only: AGENTAUTO_TRACE_FILE keeps the raw stream-json lines of the CLI (never set in normal use).
      if (process.env.AGENTAUTO_TRACE_FILE) fs.appendFileSync(process.env.AGENTAUTO_TRACE_FILE, `${line}
`);
      for (const ev of parser.feed(line)) {
        if (ev.type === 'message_start') streamText = '';
        if (ev.type === 'text') streamText += ev.delta;
        if (ev.type === 'step') steps.push({ id: ev.id, tool: ev.tool, label: ev.label, ok: null, summary: '' });
        if (ev.type === 'step_done') {
          const step = steps.find((s) => s.id === ev.id);
          if (step) Object.assign(step, { ok: ev.ok, summary: ev.summary });
        }
        if (ev.type === 'result') result = ev;
        if (ev.type === 'plan') plan = ev;
        emit(ev);
      }
    });
    const rlClosed = new Promise((r) => rl.once('close', r));
    const exit = await new Promise((resolve) => {
      child.once('error', (e) => resolve({ code: -1, spawnError: e }));
      child.once('close', (code) => resolve({ code }));
    });
    await rlClosed;

    if (exit.spawnError) throw new Error(`No se pudo iniciar Claude Code: ${exit.spawnError.message}`);

    if (cancelled) {
      const partial = streamText.trim();
      const messageId = store.addMessage({ sessionId, role: 'assistant', text: partial || '(Respuesta cancelada)', meta: { cancelled: true, steps } });
      emit({ type: 'cancelled', sessionId, messageId });
      return { ok: false, cancelled: true, sessionId, messageId };
    }
    if (!result) {
      const reason = stderrTail.trim().split(/\r?\n/).slice(-2).join(' ') || `Claude Code terminó sin respuesta (código ${exit.code}).`;
      throw new Error(reason);
    }
    if (!result.ok) {
      if (/no conversation found/i.test(String(result.error))) store.setClaudeSessionId(sessionId, null);
      throw new Error(result.error);
    }

    const answer = (result.text || parser.lastAssistantText || '').trim();
    const sources = [text, ...store.sourcesForSession(sessionId), ...parser.toolResults.map((r) => r.text)];
    const figures = ungroundedFigures(answer, sources);
    for (const r of parser.toolResults) store.addSource({ sessionId, tool: r.tool, text: r.text });
    if (result.claudeSessionId) store.setClaudeSessionId(sessionId, result.claudeSessionId);
    const meta = {
      usage: result.usage, durationMs: result.durationMs, turns: result.turns, steps, plan: plan ? { fiveHour: plan.fiveHour, resetsAt: plan.resetsAt, status: plan.status } : null, ungrounded: uniqueRaw(figures), model: cfg.model || 'predeterminado',
    };
    const messageId = store.addMessage({ sessionId, role: 'assistant', text: answer, meta });
    store.attachSources(sessionId, messageId);
    const extra = hooks.onTurnDone?.({ store, sessionId, messageId, userMessageId, text: answer, meta }) ?? {};
    emit({ type: 'done', sessionId, messageId, text: answer, meta, ...extra });
    return { ok: true, sessionId, messageId };
  } catch (error) {
    const message = String(error?.message ?? error);
    emit({ type: 'error', sessionId: sessionId ?? null, error: message });
    return { ok: false, sessionId: sessionId ?? null, error: message };
  } finally {
    if (mcpFile) fs.rmSync(mcpFile, { force: true });
    if (own) store.close();
  }
}
