// Command layer of the agents (used by agent-cli.js and the tests). Every command takes an `agentId` (default: analista).
import fs from 'node:fs';

import { openAgentStore } from './agent-db.js';
import { locateClaude } from './claude-cli.js';
import { adsDbPath, agentDbPath } from './paths.js';
import { getAgent, publicAgents, UnknownAgentError } from './registry.js';
import { loadSettings, saveSettings, SettingsError } from './settings.js';
import { editLesson, learningSummary, recordFeedback, runLearningCycle, setLessonStatus } from './learning.js';
import { runTurn } from './turn.js';
import { bankForUi, estimateRun, runEval } from './evals/runner.js';
import { loadDataset } from './metrics.js';

export class AgentError extends Error {}

export const STREAMING = ['turn', 'eval-run'];
const COMMANDS = ['agents-list', 'status', 'sessions', 'session-new', 'session-rename', 'session-delete', 'messages', 'settings-get', 'settings-set', 'queries', 'lessons', 'lesson-set', 'lesson-edit', 'learning-get', 'learning-run', 'feedback', 'recommendations', 'eval-bank', 'eval-runs', 'eval-run-detail'];

const ADS_ONLY = ['queries', 'recommendations', 'learning-run', 'eval-runs', 'eval-run-detail'];

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
  if (command === 'eval-bank') {
    need(agent.id === 'analista', 'Las evaluaciones solo existen para el Analista.');
    const ds = loadDataset(dataDir);
    return { questions: bankForUi(ds), estimate: estimateRun(ds), today: ds.today };
  }
  // Ads-metrics commands only make sense for the agent that reads the ads database.
  need(!ADS_ONLY.includes(command) || agent.usesAdsData, 'Ese comando solo existe para el Analista.');
  const store = openAgentStore(dataDir, undefined, agent);
  try {
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
      return runLearningCycle({ dataDir, store, force: true });
    }
    if (command === 'queries') return { queries: store.recentQueries(Math.min(Number(payload.limit) || 50, 200)) };
  } finally {
    store.close();
  }
  throw new AgentError(`Comando del Analista no permitido: ${command}.`);
}
