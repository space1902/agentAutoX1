// Command layer of the agents (used by agent-cli.js and the tests). Every command takes an `agentId` (default: analista).
import fs from 'node:fs';

import { openAgentStore } from './agent-db.js';
import { locateClaude } from './claude-cli.js';
import { adsDbPath, agentDbPath, agentDir } from './paths.js';
import { getAgent, publicAgents, UnknownAgentError } from './registry.js';
import { loadSettings, saveSettings, SettingsError } from './settings.js';
import { createApprovals } from './creativo-approvals.js';
import { creativoRoot } from './creativo-workspace.js';
import { createOutputs, refreshCreativoLessons } from './creativo-learning.js';
import { createRoadmap } from './creativo-roadmap.js';
import { researchDirOf } from './investigador-workspace.js';
import { markLaunched } from './investigador-tools.js';
import { createResearch } from './research-store.js';
import { activeThresholds } from './research-thresholds.js';
import { SIGNAL_WEIGHTS } from './signals.js';
import { codexEnv, CodexError, ensureChatGptLogin, locateCodex, resolveCodexHome } from './creativo-codex.js';
import { editLesson, learningSummary, recordFeedback, runLearningCycle, setLessonStatus } from './learning.js';
import { runTurn } from './turn.js';
import { bankForUi, estimateRun, runEval } from './evals/runner.js';
import { loadDataset } from './metrics.js';

export class AgentError extends Error {}

export const STREAMING = ['turn', 'eval-run'];
const COMMANDS = ['agents-list', 'status', 'sessions', 'session-new', 'session-rename', 'session-delete', 'messages', 'settings-get', 'settings-set', 'queries', 'lessons', 'lesson-set', 'lesson-edit', 'learning-get', 'learning-run', 'feedback', 'recommendations', 'eval-bank', 'eval-runs', 'eval-run-detail', 'proposals', 'proposal-decide', 'codex-status', 'roadmap-get', 'item-set', 'assets', 'asset-set', 'research-list', 'research-launch'];
// Generation approvals and the Codex check exist only for the agent that generates files.
const CREATIVO_ONLY = ['proposals', 'proposal-decide', 'codex-status', 'roadmap-get', 'item-set', 'assets', 'asset-set'];
const INVESTIGADOR_ONLY = ['research-list', 'research-launch'];

const ADS_ONLY = ['queries', 'recommendations', 'eval-runs', 'eval-run-detail'];

const need = (cond, message) => {
  if (!cond) throw new AgentError(message);
};

// Registry lookup that reports an unknown id as a regular command error.
function resolveAgent(agentId) {
  try {
    return getAgent(agentId);
  } catch (error) {
    if (error instanceof UnknownAgentError) throw new AgentError(error.message);
    throw error;
  }
}

export async function runStreaming(command, payload, { dataDir, emit, registerCancel, hooks, agentId }) {
  const agent = resolveAgent(agentId);
  if (command === 'turn') {
    need(typeof payload.text === 'string' && payload.text.trim(), 'Escribe una pregunta.');
    need(payload.text.length <= 8000, 'La pregunta es demasiado larga (máximo 8000 caracteres).');
    const learning = loadSettings(dataDir, agent).learning;
    return runTurn({ dataDir, agentId: agent.id, sessionId: payload.sessionId || undefined, text: payload.text, emit, registerCancel, hooks: hooks ?? (learning ? agent.makeHooks() : {}) });
  }
  if (command === 'eval-run') {
    need(agent.id === 'analista', 'Las evaluaciones solo existen para el Analista.');
    const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : undefined;
    return runEval({ dataDir, ids, emit, registerCancel });
  }
  throw new AgentError(`Comando del Analista no permitido: ${command}.`);
}

export async function runCommand(command, payload, { dataDir, agentId }) {
  need(COMMANDS.includes(command), `Comando del Analista no permitido: ${command}.`);
  if (command === 'agents-list') return { agents: publicAgents() };
  const agent = resolveAgent(agentId);
  if (command === 'settings-get') return { settings: loadSettings(dataDir, agent) };
  if (command === 'settings-set') {
    try {
      return { settings: saveSettings(dataDir, payload ?? {}, agent) };
    } catch (error) {
      if (error instanceof SettingsError) throw new AgentError(error.message);
      throw error;
    }
  }
  if (command === 'status') {
    const settings = loadSettings(dataDir, agent);
    const claude = locateClaude({ override: settings.claudePath });
    return {
      claude: claude ? { found: true, path: claude.path } : { found: false, path: null },
      adsDb: fs.existsSync(adsDbPath(dataDir)),
      agentDb: fs.existsSync(agentDbPath(dataDir, agent)),
      workspace: agent.cwd(dataDir),
      settings,
    };
  }
  if (command === 'codex-status') {
    need(agent.id === 'creativo', 'Ese comando solo existe para el Agente creativo.');
    return codexStatus(loadSettings(dataDir, agent));
  }
  if (command === 'eval-bank') {
    need(agent.id === 'analista', 'Las evaluaciones solo existen para el Analista.');
    const ds = loadDataset(dataDir);
    return { questions: bankForUi(ds), estimate: estimateRun(ds), today: ds.today };
  }
  // Ads-metrics commands only make sense for the agent that reads the ads database.
  need(!ADS_ONLY.includes(command) || agent.usesAdsData, 'Ese comando solo existe para el Analista.');
  need(!CREATIVO_ONLY.includes(command) || agent.id === 'creativo', 'Ese comando solo existe para el Agente creativo.');
  need(!INVESTIGADOR_ONLY.includes(command) || agent.id === 'investigador', 'Ese comando solo existe para el Investigador de productos.');
  const store = openAgentStore(dataDir, undefined, agent);
  try {
    if (command === 'proposals') return { proposals: createApprovals(store.db, { now: store.now }).list({ status: payload.status ? String(payload.status) : undefined, limit: Math.min(Number(payload.limit) || 30, 100) }) };
    if (command === 'proposal-decide') {
      const approvals = createApprovals(store.db, { now: store.now });
      const res = approvals.decide(Number(payload.id), payload.approve === true);
      need(res.ok, res.error);
      // The decision is learning material: approvals and rejections weigh on what the creativo proposes next.
      const kind = res.status === 'approved' ? 'generacion_aprobada' : 'generacion_rechazada';
      store.addSignal({ sessionId: approvals.get(payload.id)?.sessionId ?? null, kind, weight: SIGNAL_WEIGHTS[kind], note: String(approvals.get(payload.id)?.summary ?? '').slice(0, 200) || null });
      return { id: Number(payload.id), status: res.status };
    }
    if (command === 'roadmap-get' || command === 'item-set') {
      const roadmap = createRoadmap(store.db, { root: creativoRoot(), agentDirPath: agentDir(dataDir, agent), now: store.now });
      if (command === 'item-set') {
        const res = roadmap.mark({ id: Number(payload.id), status: String(payload.status), note: payload.note, evidencePath: payload.evidencePath, by: 'usuario' });
        need(!res.error, res.error);
        return res;
      }
      const seeded = roadmap.seed();
      // `next` = what to do now (dependencies met), computed in code like the propose_next tool.
      return { seeded, board: roadmap.board({ product: payload.product ? String(payload.product) : undefined }).map((b) => ({ ...b, next: roadmap.proposeNext({ product: b.id, limit: 6 }) })) };
    }
    if (command === 'assets') return { assets: createOutputs(store.db, { now: store.now }).list({ status: payload.status ? String(payload.status) : undefined, limit: Math.min(Number(payload.limit) || 60, 200) }) };
    if (command === 'asset-set') {
      const res = createOutputs(store.db, { now: store.now }).setStatus(Number(payload.id), String(payload.status), { ctCode: payload.ctCode });
      need(!res.error, res.error);
      const kind = { used: 'activo_usado', discarded: 'activo_descartado' }[res.output.status];
      if (kind && res.changed) store.addSignal({ kind, weight: SIGNAL_WEIGHTS[kind], note: res.output.path.split(/[\\/]/).pop() });
      if (loadSettings(dataDir, agent).learning) refreshCreativoLessons({ store, dataDir });
      return res;
    }
    if (command === 'research-list' || command === 'research-launch') {
      const ctx = { dataDir, getStore: () => store, research: createResearch(store.db, { researchDir: researchDirOf() }), learning: true };
      if (command === 'research-launch') {
        const res = markLaunched(ctx, { ...payload, report_id: payload.reportId });
        need(!res.error, res.error);
        return res;
      }
      const launches = new Map(ctx.research.launches().map((l) => [l.reportId, l]));
      return {
        reports: ctx.research.reports({ limit: Math.min(Number(payload.limit) || 50, 200) }).map((r) => ({ ...r, measurements: ctx.research.measurements(r.id), launch: launches.get(r.id) ?? null })),
        thresholds: activeThresholds(store.lessons('certified')),
      };
    }
    if (command === 'eval-runs') return { runs: store.evalRuns() };
    if (command === 'eval-run-detail') return { run: store.evalRuns(500).find((r) => r.id === Number(payload.runId)) ?? null, results: store.evalResults(Number(payload.runId)) };
    if (command === 'sessions') return { sessions: store.listSessions() };
    if (command === 'session-new') return { sessionId: store.createSession() };
    if (command === 'session-rename') {
      need(store.getSession(payload.sessionId), 'No encuentro ese chat.');
      store.renameSession(payload.sessionId, String(payload.title ?? '').trim() || 'Nuevo chat');
      return { sessionId: payload.sessionId };
    }
    if (command === 'session-delete') {
      need(store.getSession(payload.sessionId), 'No encuentro ese chat.');
      store.deleteSession(payload.sessionId);
      return { sessionId: payload.sessionId };
    }
    if (command === 'messages') {
      need(store.getSession(payload.sessionId), 'No encuentro ese chat.');
      return { messages: store.messages(payload.sessionId) };
    }
    if (command === 'lessons') return { lessons: store.lessons() };
    if (command === 'learning-get') {
      const ids = Array.isArray(payload.ids) ? payload.ids.map(Number) : null;
      return { summary: learningSummary(store), lessons: store.lessons().filter((l) => !ids || ids.includes(l.id)) };
    }
    if (command === 'lesson-set') {
      const res = setLessonStatus(store, Number(payload.id), String(payload.action));
      need(!res.error, res.error);
      return res;
    }
    if (command === 'lesson-edit') {
      const res = editLesson(store, Number(payload.id), payload.text);
      need(!res.error, res.error);
      return res;
    }
    if (command === 'feedback') {
      const res = recordFeedback(store, { messageId: Number(payload.messageId), kind: String(payload.kind), comment: payload.comment });
      need(!res.error, res.error);
      return res;
    }
    if (command === 'recommendations') return { recommendations: store.recommendations(Number(payload.limit) || 200) };
    if (command === 'learning-run') {
      need(loadSettings(dataDir, agent).learning, 'El aprendizaje está desactivado en los ajustes.');
      if (agent.usesAdsData) return runLearningCycle({ dataDir, store, force: true });
      need(agent.learningCycle, 'Ese agente no mide resultados todavía.');
      return agent.learningCycle({ dataDir, store });
    }
    if (command === 'queries') return { queries: store.recentQueries(Math.min(Number(payload.limit) || 50, 200)) };
  } finally {
    store.close();
  }
  throw new AgentError(`Comando del Analista no permitido: ${command}.`);
}

/** Is Codex installed and logged in with the ChatGPT plan, with the CODEX_HOME this app would use? */
export async function codexStatus(settings, { env = process.env, runFn } = {}) {
  const codexHome = resolveCodexHome({ override: settings.codexHome, env });
  const codex = locateCodex({ override: settings.codexPath, env });
  if (!codex) return { found: false, loggedIn: false, codexHome, message: 'No encuentro Codex en este equipo. Instálalo con `npm i -g @openai/codex`.' };
  try {
    await ensureChatGptLogin(codex, { env: codexEnv({ env, codexHome }), ...(runFn ? { runFn } : {}) });
    return { found: true, loggedIn: true, codexHome, message: 'Codex está listo y usa tu plan de ChatGPT.' };
  } catch (error) {
    if (!(error instanceof CodexError)) throw error;
    return { found: true, loggedIn: false, codexHome, message: error.message };
  }
}
