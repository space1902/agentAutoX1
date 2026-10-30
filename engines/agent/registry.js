// Registry of the agents the app can run. The engine receives an `agentId` and resolves everything agent-specific
// from here: data folder, workspace, MCP server, tool allowlists, prompts, progress labels and learning hooks.
// Adding an agent means adding one entry; claude-cli.js, turn.js, paths.js and agent-api.js stay generic.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { creativoPrompt, creativoStepLabel } from './creativo-prompt.js';
import { BASH_ALLOW, CREATIVO_SKILLS, creativoRoot, prepareCreativoLaunch, scrubSecrets } from './creativo-workspace.js';
import { makeHooks } from './learning.js';
import { systemPromptAppend, workspaceClaudeMd } from './knowledge.js';
import { accountToday } from './metrics.js';
import { LEGACY_AGENT_ID, workspaceDir } from './paths.js';
import { stepLabel as analistaStepLabel } from './stream-parser.js';
import { BASE_TOOL_NAMES, LEARNING_TOOL_NAMES } from './tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function defineAgent(entry) {
  // An agent may have no MCP server of its own (the Agente creativo only uses Higgsfield's, added at launch).
  const [mcpServer] = Object.keys(entry.mcpServers);
  return Object.freeze({
    builtinTools: [], skills: [], tabs: ['chat', 'ajustes'], starters: [], usesAdsData: false, ...entry, mcpServer, mcpServerFile: mcpServer ? path.join(HERE, entry.mcpServers[mcpServer]) : null,
  });
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
    tabs: ['chat', 'lecciones', 'recomendaciones', 'calidad', 'ajustes'],
    starters: ['¿Qué CT debería escalar esta semana?', '¿Cómo le fue a CT 07 desde la subida de presupuesto?', 'Compara Colombia vs Venezuela este mes', '¿Qué anuncios debería apagar hoy?'],
    welcome: { title: 'Pregúntame por tus anuncios y ventas', text: 'Consulto tus datos reales de solo lectura, hago las cuentas con código y te explico. No cambio nada en Meta.' },
    usesAdsData: true,
  }),
  creativo: defineAgent({
    id: 'creativo',
    name: 'Agente creativo',
    shortName: 'Agente creativo',
    description: 'Te ayuda con PDF, guiones, textos de anuncios y adaptación por país usando tus skills. No gasta créditos por su cuenta.',
    icon: 'Clapperboard',
    dataSubdir: 'agents/creativo',
    // The workspace of the products themselves (not a private folder): access is confined by the guard hook.
    cwd: () => creativoRoot(),
    mcpServers: {},
    toolNames: () => [],
    builtinTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Skill'],
    skills: [...CREATIVO_SKILLS],
    // Only these Bash patterns replace the bare `Bash` in --allowedTools.
    bashPatterns: BASH_ALLOW,
    workspaceMd: null,
    systemPrompt: ({ lessons }) => creativoPrompt({ root: creativoRoot(), lessons }),
    stepLabel: creativoStepLabel,
    grounding: false,
    makeHooks: () => ({}),
    launch: ({ dataDir }) => prepareCreativoLaunch({ dataDir }),
    sanitizeEnv: scrubSecrets,
    // Lessons, recommendations and quality checks belong to later phases (6) or to the ads analyst.
    tabs: ['chat', 'ajustes'],
    starters: [
      'Usa la skill de redacción para proponer 3 títulos para el PDF 06 de bebidas típicas venezolanas',
      '¿Qué le falta a Bebidas Venezuela para poder lanzarse?',
      'Escribe 3 hooks distintos para un anuncio de michelada',
      'Revisa el saldo de Higgsfield',
    ],
    welcome: { title: 'Cuéntame qué quieres crear', text: 'Trabajo con tus skills y los archivos de Producto Bebidas. No gasto créditos ni toco el código de las apps: antes de cualquier gasto te aviso el costo.' },
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
export const publicAgents = () => Object.values(AGENTS).map(({ id, name, shortName, description, icon, tabs, starters, welcome, usesAdsData }) => ({
  id, name, shortName, description, icon, tabs: [...tabs], starters: [...starters], welcome: { ...welcome }, usesAdsData,
}));
