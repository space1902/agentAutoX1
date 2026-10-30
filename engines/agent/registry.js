// Registry of the agents the app can run. The engine receives an `agentId` and resolves everything agent-specific
// from here: data folder, workspace, MCP server, tool allowlists, prompts, progress labels and learning hooks.
// Adding an agent means adding one entry; claude-cli.js, turn.js, paths.js and agent-api.js stay generic.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeHooks } from './learning.js';
import { systemPromptAppend, workspaceClaudeMd } from './knowledge.js';
import { accountToday } from './metrics.js';
import { LEGACY_AGENT_ID, workspaceDir } from './paths.js';
import { stepLabel as analistaStepLabel } from './stream-parser.js';
import { BASE_TOOL_NAMES, LEARNING_TOOL_NAMES } from './tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function defineAgent(entry) {
  const [mcpServer] = Object.keys(entry.mcpServers);
  return Object.freeze({ builtinTools: [], skills: [], ...entry, mcpServer, mcpServerFile: path.join(HERE, entry.mcpServers[mcpServer]) });
}

export const AGENTS = Object.freeze({
  analista: defineAgent({
    id: 'analista',
    name: 'Analista de publicidad',
    shortName: 'Analista',
    description: 'Analiza tus anuncios de Meta, explica qué pasa y aprende de los resultados.',
    icon: 'BarChart3',
    // Legacy location: <data>/analista/agent.db, settings.json and workspace are kept where they already are (no migration).
    dataSubdir: 'analista',
    cwd: (dataDir) => workspaceDir(dataDir, LEGACY_AGENT_ID),
    mcpServers: { analista: 'ads-mcp.js' },
    toolNames: (settings) => [...BASE_TOOL_NAMES, ...(settings.learning ? LEARNING_TOOL_NAMES : [])],
    builtinTools: ['WebSearch', 'WebFetch'],
    skills: [],
    workspaceMd: (settings) => workspaceClaudeMd({ web: settings.web, learning: settings.learning }),
    systemPrompt: ({ dataDir, now, lessons, settings }) => systemPromptAppend({ today: accountToday(dataDir, now), lessons, web: settings.web, learning: settings.learning }),
    stepLabel: analistaStepLabel,
    // Figures in the answer are checked against the turn's tool results (valid for ads numbers only).
    grounding: true,
    makeHooks,
  }),
});

export const AGENT_IDS = Object.freeze(Object.keys(AGENTS));

export class UnknownAgentError extends Error {}

/** Registry entry for an id; a missing id means the Analista (legacy callers). Throws for anything unregistered. */
export function getAgent(agentId = LEGACY_AGENT_ID) {
  const id = agentId || LEGACY_AGENT_ID;
  if (!Object.hasOwn(AGENTS, id)) throw new UnknownAgentError(`Agente desconocido: ${String(id).slice(0, 40)}.`);
  return AGENTS[id];
}

/** What the UI may know about each agent (no functions, no paths). */
export const publicAgents = () => Object.values(AGENTS).map(({ id, name, description, icon }) => ({ id, name, description, icon }));
