// Command layer of the Analista (used by agent-cli.js and the tests).
import fs from 'node:fs';

import { openAgentStore } from './agent-db.js';
import { locateClaude } from './claude-cli.js';
import { adsDbPath, agentDbPath, workspaceDir } from './paths.js';
import { loadSettings, saveSettings, SettingsError } from './settings.js';
import { runTurn } from './turn.js';

export class AgentError extends Error {}

export const STREAMING = ['turn'];
const COMMANDS = ['status', 'sessions', 'session-new', 'session-rename', 'session-delete', 'messages', 'settings-get', 'settings-set', 'queries'];

const need = (cond, message) => {
  if (!cond) throw new AgentError(message);
};

export async function runStreaming(command, payload, { dataDir, emit, registerCancel, hooks }) {
  if (command === 'turn') {
    need(typeof payload.text === 'string' && payload.text.trim(), 'Escribe una pregunta.');
    need(payload.text.length <= 8000, 'La pregunta es demasiado larga (máximo 8000 caracteres).');
    return runTurn({ dataDir, sessionId: payload.sessionId || undefined, text: payload.text, emit, registerCancel, hooks });
  }
  throw new AgentError(`Comando del Analista no permitido: ${command}.`);
}

export async function runCommand(command, payload, { dataDir }) {
  need(COMMANDS.includes(command), `Comando del Analista no permitido: ${command}.`);
  if (command === 'settings-get') return { settings: loadSettings(dataDir) };
  if (command === 'settings-set') {
    try {
      return { settings: saveSettings(dataDir, payload ?? {}) };
    } catch (error) {
      if (error instanceof SettingsError) throw new AgentError(error.message);
      throw error;
    }
  }
  if (command === 'status') {
    const settings = loadSettings(dataDir);
    const claude = locateClaude({ override: settings.claudePath });
    return {
      claude: claude ? { found: true, path: claude.path } : { found: false, path: null },
      adsDb: fs.existsSync(adsDbPath(dataDir)),
      agentDb: fs.existsSync(agentDbPath(dataDir)),
      workspace: workspaceDir(dataDir),
      settings,
    };
  }
  const store = openAgentStore(dataDir);
  try {
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
    if (command === 'queries') return { queries: store.recentQueries(Math.min(Number(payload.limit) || 50, 200)) };
  } finally {
    store.close();
  }
  throw new AgentError(`Comando del Analista no permitido: ${command}.`);
}
