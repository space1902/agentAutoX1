// MCP stdio server of the Investigador de productos (spawned by Claude Code from the per-turn mcp config).
//   env: AGENTAUTO_DATA_DIR (required), AGENTAUTO_SESSION_ID, AGENTAUTO_RESEARCH_DIR (where the reports are written),
//        AGENTAUTO_LEARNING ("0" disables the learning tools)
// stdout carries ONLY protocol messages; diagnostics go to stderr.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentStore } from './agent-db.js';
import { createInvestigadorTools } from './investigador-tools.js';
import { createMcpServer, serveStdio } from './mcp-protocol.js';
import { agentDbPath } from './paths.js';
import { createResearch, RESEARCH_SCHEMA } from './research-store.js';
import { resolveDataDir } from '../warmup/data-dir.js';

/** Context from the environment (what Claude Code gives this process). */
export function contextFromEnv(env = process.env) {
  const dataDir = env.AGENTAUTO_DATA_DIR || resolveDataDir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'warmup'));
  const store = createAgentStore(agentDbPath(dataDir, 'investigador'), { schemaExtra: RESEARCH_SCHEMA });
  const researchDir = env.AGENTAUTO_RESEARCH_DIR;
  return { dataDir, store, researchDir, research: createResearch(store.db, { researchDir }), getStore: () => store, sessionId: env.AGENTAUTO_SESSION_ID || null, learning: env.AGENTAUTO_LEARNING !== '0' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ctx = contextFromEnv();
  if (!ctx.researchDir) {
    process.stderr.write('AGENTAUTO_RESEARCH_DIR is missing\n');
    process.exit(1);
  }
  await serveStdio(createMcpServer({ name: 'investigador', version: '1.0.0', tools: createInvestigadorTools(ctx) }));
  ctx.store.close();
}
