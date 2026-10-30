// Where each agent keeps things. The Analista is the legacy agent and stays under <data dir>/analista (existing
// agent.db, settings.json and workspace are never moved); every other agent lives under <data dir>/agents/<id>.
// The ads database stays in <data dir>/ads.
import path from 'node:path';

export const LEGACY_AGENT_ID = 'analista';
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// `agent` is an agent id (string), a registry entry ({ id, dataSubdir? }) or nothing (= the Analista).
export function agentDir(dataDir, agent = LEGACY_AGENT_ID) {
  const id = typeof agent === 'string' ? agent : (agent?.id ?? LEGACY_AGENT_ID);
  if (!ID_RE.test(id)) throw new Error(`Identificador de agente no válido: ${id}.`);
  if (agent && typeof agent === 'object' && agent.dataSubdir) return path.join(dataDir, ...agent.dataSubdir.split('/'));
  return id === LEGACY_AGENT_ID ? path.join(dataDir, 'analista') : path.join(dataDir, 'agents', id);
}

export const analistaDir = (dataDir) => agentDir(dataDir, LEGACY_AGENT_ID);
export const agentDbPath = (dataDir, agent) => path.join(agentDir(dataDir, agent), 'agent.db');
export const workspaceDir = (dataDir, agent) => path.join(agentDir(dataDir, agent), 'workspace');
export const settingsPath = (dataDir, agent) => path.join(agentDir(dataDir, agent), 'settings.json');
export const adsDbPath = (dataDir) => path.join(dataDir, 'ads', 'ads.db');
