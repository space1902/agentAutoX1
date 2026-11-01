// What the Investigador needs on disk and on the command line, built at run time (same approach as the creativo):
//   - the local plugin <data>/agents/investigador/plugin/ with a copy of the skill investigacion-mercado
//   - the --settings file with deny rules and the PreToolUse guard hook (investigador-guard.js)
//   - the Claude-in-Chrome switch and its allowlist (the only browser the Ad Library needs; verified live with headless claude -p, haiku, the subscription and ANTHROPIC_* stripped)
//   - the env of the investigador MCP server (where the reports go)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSkillsPlugin, creativoRoot, scrubSecrets, userSkillsDir } from './creativo-workspace.js';
import { BROWSER_TOOLS, INVESTIGADOR_PLUGIN } from './investigador-guard.js';
import { agentDir } from './paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const slash = (p) => String(p).replace(/\\/g, '/');

export const INVESTIGADOR_SKILLS = Object.freeze(['investigacion-mercado']);
export const INVESTIGADOR_BROWSER_TOOLS = Object.freeze(BROWSER_TOOLS.map((t) => `mcp__claude-in-chrome__${t}`));
// navigate / tabs_create_mcp are NOT pre-allowed: the guard hook allows them only for Ad Library URLs.
export const INVESTIGADOR_ALLOWED_BROWSER = Object.freeze(INVESTIGADOR_BROWSER_TOOLS.filter((t) => !/__(navigate|tabs_create_mcp)$/.test(t)));
export const INVESTIGADOR_DEFAULT_SETTINGS = Object.freeze({ model: 'sonnet' });

export const pluginDirOf = (dataDir) => path.join(agentDir(dataDir, 'investigador'), 'plugin');
/** Folder of the reports: <workspace>/producto ideas/investigaciones unless AGENTAUTO_RESEARCH_DIR says otherwise. */
export const researchDirOf = (env = process.env) => (env.AGENTAUTO_RESEARCH_DIR && env.AGENTAUTO_RESEARCH_DIR.trim()) || path.join(creativoRoot(env), 'producto ideas', 'investigaciones');

export const buildInvestigadorPlugin = ({ dataDir, skillsSource = userSkillsDir(), skills = INVESTIGADOR_SKILLS, log = (m) => process.stderr.write(`${m}\n`) } = {}) =>
  buildSkillsPlugin({ pluginDir: pluginDirOf(dataDir), pluginName: INVESTIGADOR_PLUGIN, description: 'Skill del Investigador de productos (copia generada por la app; no la edites).', skillsSource, skills, log, label: 'investigador' });

const DENIED_PATHS = ['**/agentAutoX1/**', '**/whatsapp-*/**', '**/meta-ads-monitor/**', '**/.env*', '**/*Token*.txt', '**/apikey*', '**/node_modules/**', '**/*.pem', '**/id_rsa*', '**/.ssh/**', '**/.aws/**', '**/credentials*', '**/.git/**'];

export function buildGuardSettings({ researchDir, pluginDir, nodePath = process.execPath, guardFile = path.join(HERE, 'investigador-guard.js') }) {
  const command = `"${slash(nodePath)}" --disable-warning=ExperimentalWarning "${slash(guardFile)}" --root "${slash(researchDir)}" --plugin "${slash(pluginDir)}"`;
  return {
    permissions: { deny: DENIED_PATHS.map((p) => `Read(${p})`) },
    hooks: { PreToolUse: [{ matcher: 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|Bash|PowerShell|Skill|WebFetch|WebSearch|mcp__.*', hooks: [{ type: 'command', command, timeout: 15 }] }] },
  };
}

/** Prepares one turn: refreshes the plugin, writes the settings file and builds the env of the MCP server. */
export function prepareInvestigadorLaunch({ dataDir, root = creativoRoot(), skillsSource, home = os.homedir(), log, nodePath, env = process.env } = {}) {
  const plugin = buildInvestigadorPlugin({ dataDir, skillsSource: skillsSource ?? userSkillsDir(home), log });
  const researchDir = researchDirOf({ ...env, AGENTAUTO_CREATIVO_ROOT: root });
  fs.mkdirSync(researchDir, { recursive: true });
  const settingsFile = path.join(agentDir(dataDir, 'investigador'), 'guard-settings.json');
  fs.writeFileSync(settingsFile, `${JSON.stringify(buildGuardSettings({ researchDir, pluginDir: plugin.pluginDir, ...(nodePath ? { nodePath } : {}) }), null, 2)}\n`, 'utf8');
  return {
    pluginDir: plugin.pluginDir,
    settingsFile,
    allowedTools: [...INVESTIGADOR_ALLOWED_BROWSER],
    // `--chrome` loads the Claude-in-Chrome tools into the headless run (the user's Chrome with the extension must be open).
    flags: ['--chrome'],
    mcpServers: {},
    toolsEnv: { AGENTAUTO_RESEARCH_DIR: researchDir },
    plugin,
  };
}

export { scrubSecrets };
