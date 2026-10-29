// Where the Analista keeps things, all under <data dir>/analista (the ads database stays in <data dir>/ads).
import path from 'node:path';

export const analistaDir = (dataDir) => path.join(dataDir, 'analista');
export const agentDbPath = (dataDir) => path.join(analistaDir(dataDir), 'agent.db');
export const workspaceDir = (dataDir) => path.join(analistaDir(dataDir), 'workspace');
export const settingsPath = (dataDir) => path.join(analistaDir(dataDir), 'settings.json');
export const adsDbPath = (dataDir) => path.join(dataDir, 'ads', 'ads.db');
