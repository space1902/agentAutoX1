// Registry of the agents the app can run. The engine receives an `agentId` and resolves everything agent-specific
// from here: data folder, workspace, MCP server, tool allowlists, prompts, progress labels and learning hooks.
// Adding an agent means adding one entry; claude-cli.js, turn.js, paths.js and agent-api.js stay generic.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CREATIVO_SCHEMA } from './creativo-schema.js';
import { refreshCreativoLessons } from './creativo-learning.js';
import { AGENT_LEARNING_TOOL_NAMES } from './learning-tools.js';
import { startKeyBroker } from './creativo-keybroker.js';
import { FREE_MCP_TOOLS, LEARNING_MCP_TOOLS } from './creativo-guard.js';
import { getProductMap } from './creativo-map.js';
import { creativoPrompt, creativoStepLabel } from './creativo-prompt.js';
import { BASH_ALLOW, CREATIVO_DEFAULT_SETTINGS, ELEVEN_KEY_ENV, CREATIVO_SETTINGS_SCHEMA, CREATIVO_SKILLS, creativoRoot, prepareCreativoLaunch, scrubSecrets } from './creativo-workspace.js';
import { makeHooks } from './learning.js';
import { systemPromptAppend, workspaceClaudeMd } from './knowledge.js';
import { accountToday } from './metrics.js';
import { agentDir, LEGACY_AGENT_ID, workspaceDir } from './paths.js';
import { INVESTIGADOR_DEFAULT_SETTINGS, INVESTIGADOR_SKILLS, prepareInvestigadorLaunch, researchDirOf } from './investigador-workspace.js';
import { investigadorPrompt, investigadorStepLabel } from './investigador-prompt.js';
import { INVESTIGADOR_TOOL_NAMES, proposeUpdates } from './investigador-tools.js';
import { createResearch, localDate, RESEARCH_SCHEMA } from './research-store.js';
import { activeThresholds } from './research-thresholds.js';
import { stepLabel as analistaStepLabel } from './stream-parser.js';
import { BASE_TOOL_NAMES, LEARNING_TOOL_NAMES } from './tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function defineAgent(entry) {
  // An agent may have no MCP server of its own.
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
    starters: ['¿Qué campaña debería escalar esta semana?', '¿Cómo le fue a mi campaña principal desde la subida de presupuesto?', 'Compara Colombia vs Venezuela este mes', '¿Qué anuncios debería apagar hoy?'],
    welcome: { title: 'Pregúntame por tus anuncios y ventas', text: 'Consulto tus datos reales de solo lectura, hago las cuentas con código y te explico. No cambio nada en Meta.' },
    usesAdsData: true,
  }),
  creativo: defineAgent({
    id: 'creativo',
    name: 'Agente creativo',
    shortName: 'Agente creativo',
    description: 'Te ayuda con PDF, guiones, anuncios, imágenes con GPT, audios con ElevenLabs y videos de referencia. Antes de generar algo te pide que lo apruebes.',
    icon: 'Clapperboard',
    dataSubdir: 'agents/creativo',
    // The workspace of the products themselves (not a private folder): access is confined by the guard hook.
    cwd: () => creativoRoot(),
    mcpServers: { creativo: 'creativo-mcp.js' },
    // Free tools only; the generation tools are not allowlisted and run only with a user approval (see creativo-guard.js).
    toolNames: (settings = {}) => [...FREE_MCP_TOOLS.filter((t) => !LEARNING_MCP_TOOLS.includes(t)), ...(settings.learning === false ? [] : AGENT_LEARNING_TOOL_NAMES)],
    builtinTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Skill'],
    skills: [...CREATIVO_SKILLS],
    // Only these Bash patterns replace the bare `Bash` in --allowedTools.
    bashPatterns: BASH_ALLOW,
    // Sonnet by default (the CLI's own default model reads a much larger context); Codex options for image generation.
    defaultSettings: CREATIVO_DEFAULT_SETTINGS,
    settingsSchema: CREATIVO_SETTINGS_SCHEMA,
    schemaExtra: CREATIVO_SCHEMA,
    workspaceMd: null,
    systemPrompt: ({ dataDir, lessons }) => {
      const root = creativoRoot();
      return creativoPrompt({ root, lessons, productMap: getProductMap({ root, cacheFile: path.join(agentDir(dataDir, 'creativo'), 'product-map.json') }) });
    },
    stepLabel: creativoStepLabel,
    grounding: false,
    // Same loop as the Analista, over the creativo's own outcomes (see creativo-learning.js).
    makeHooks: () => makeHooks({ chatCorrections: true, refresh: ({ store, dataDir }) => refreshCreativoLessons({ store, dataDir }) }),
    learningCycle: ({ dataDir, store }) => ({ candidates: refreshCreativoLessons({ store, dataDir }) }),
    launch: async ({ dataDir, settings }) => {
      const launch = prepareCreativoLaunch({ dataDir, settings });
      // The ElevenLabs key (from the keyring, through the app) is handed to the MCP server once, over loopback: never in Claude Code's env.
      const key = process.env[ELEVEN_KEY_ENV];
      if (!key) return launch;
      const broker = await startKeyBroker({ key });
      return { ...launch, toolsEnv: { ...launch.toolsEnv, AGENTAUTO_KEY_PORT: String(broker.port), AGENTAUTO_KEY_NONCE: broker.nonce }, cleanup: () => broker.close() };
    },
    sanitizeEnv: scrubSecrets,
    tabs: ['chat', 'lecciones', 'hoja', 'ajustes'],
    starters: [
      '¿Qué le falta al producto Bebidas en Venezuela?',
      'Usa la skill de redacción para proponer 3 títulos para el PDF 06 de bebidas típicas venezolanas',
      'Escribe 3 hooks distintos para un anuncio de michelada',
      'Busca videos de referencia de micheladas en TikTok y descarga el mejor',
    ],
    welcome: { title: 'Cuéntame qué quieres crear', text: 'Trabajo con tus skills y los archivos de tus productos. Las imágenes usan tu plan de ChatGPT y los audios créditos de ElevenLabs: antes de generar algo te muestro qué y cuánto, y solo sigo cuando lo apruebes.' },
  }),
  investigador: defineAgent({
    id: 'investigador',
    name: 'Investigador de productos',
    shortName: 'Investigador',
    description: 'Mide la competencia en la Biblioteca de anuncios de Meta, clasifica cada ángulo, estima si sería rentable y aprende de los productos que lanzas.',
    icon: 'Search',
    dataSubdir: 'agents/investigador',
    // Private workspace: the agent writes nothing there (reports go through save_research into the owner's investigaciones folder).
    cwd: (dataDir) => workspaceDir(dataDir, 'investigador'),
    mcpServers: { investigador: 'investigador-mcp.js' },
    toolNames: (settings = {}) => [...INVESTIGADOR_TOOL_NAMES, ...(settings.learning === false ? [] : AGENT_LEARNING_TOOL_NAMES)],
    // Read for its own skill and past reports, the web tools (the browser tools come from agent.launch); everything is confined by investigador-guard.js.
    builtinTools: ['Read', 'Skill', 'WebSearch', 'WebFetch'],
    skills: [...INVESTIGADOR_SKILLS],
    defaultSettings: INVESTIGADOR_DEFAULT_SETTINGS,
    schemaExtra: RESEARCH_SCHEMA,
    workspaceMd: null,
    systemPrompt: ({ now, lessons, settings }) => investigadorPrompt({
      researchDir: researchDirOf(), thresholds: activeThresholds(lessons.filter((l) => typeof l === 'object')), lessons: settings.learning === false ? [] : lessons, today: localDate(now),
    }),
    stepLabel: investigadorStepLabel,
    grounding: false,
    makeHooks: () => makeHooks({ chatCorrections: true }),
    // "Medir ahora" in Lecciones: re-check the launched products and store the threshold candidates that follow.
    learningCycle: ({ dataDir, store }) => {
      const ctx = { dataDir, getStore: () => store, research: createResearch(store.db, { researchDir: researchDirOf() }), learning: true };
      const res = proposeUpdates(ctx);
      return { candidates: res.nuevas ?? 0, faltan_resultados: res.faltan_resultados ?? 0 };
    },
    launch: async ({ dataDir }) => prepareInvestigadorLaunch({ dataDir }),
    sanitizeEnv: scrubSecrets,
    tabs: ['chat', 'lecciones', 'informes', 'ajustes'],
    starters: [
      'Mide cuántos anuncios activos hay de «recetas air fryer» en Colombia y México',
      '¿Qué ángulos de infoproducto de cocina están saturados y cuáles tienen hueco?',
      'Revisa la competencia de «oraciones cristianas» en los países hispanos',
      '¿Cómo les fue a los productos que investigamos y lanzamos?',
    ],
    welcome: { title: 'Cuéntame qué idea quieres validar', text: 'Mido cuántos anuncios activos hay en la Biblioteca de anuncios de Meta (solo lectura, sin iniciar sesión), clasifico el ángulo, estimo la rentabilidad y guardo un informe. Necesito tu Chrome abierto con la extensión de Claude.' },
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
