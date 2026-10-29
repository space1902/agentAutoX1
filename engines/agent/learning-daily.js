// Entry used by the ads scheduler tick: runs the learning cycle at most once a day, only when learning is on and the
// Analista has been used (agent.db exists). Synchronous and quiet on purpose.
import fs from 'node:fs';

import { openAgentStore } from './agent-db.js';
import { runLearningCycle } from './learning.js';
import { agentDbPath } from './paths.js';
import { loadSettings } from './settings.js';

export function runDailyLearning({ dataDir, now = Date.now() }) {
  if (!loadSettings(dataDir).learning) return { skipped: 'aprendizaje desactivado' };
  if (!fs.existsSync(agentDbPath(dataDir))) return { skipped: 'sin uso del Analista' };
  const store = openAgentStore(dataDir, { now: () => now });
  try {
    return runLearningCycle({ dataDir, store, now });
  } finally {
    store.close();
  }
}
