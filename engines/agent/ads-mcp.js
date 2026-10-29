// MCP stdio server for the Analista (spawned by Claude Code from the per-turn mcp config).
//   env: AGENTAUTO_DATA_DIR (required), AGENTAUTO_SESSION_ID, AGENTAUTO_QUESTION, AGENTAUTO_LEARNING ("0" disables learning tools)
// stdout carries ONLY protocol messages; diagnostics go to stderr.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openAgentStore } from './agent-db.js';
import { createMcpServer, serveStdio } from './mcp-protocol.js';
import { createTools } from './tools.js';
import { buildLearningTools } from './learning-tools.js';
import { resolveDataDir } from '../warmup/data-dir.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const dataDir = resolveDataDir(path.join(ROOT, '..', 'warmup'));

let store = null;
const getStore = () => (store ??= openAgentStore(dataDir));

const ctx = {
  dataDir,
  sessionId: process.env.AGENTAUTO_SESSION_ID || null,
  question: process.env.AGENTAUTO_QUESTION || null,
  learning: process.env.AGENTAUTO_LEARNING !== '0',
  getStore,
};
Object.assign(ctx, buildLearningTools(ctx));

const server = createMcpServer({ name: 'analista', version: '1.0.0', tools: createTools(ctx) });
await serveStdio(server);
store?.close();
