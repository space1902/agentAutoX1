// Everything about launching the locally installed Claude Code CLI headless with the USER'S SUBSCRIPTION:
// finding the binary, a child environment that can never fall back to a paid API key, and the isolated argument list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENTS } from './registry.js';
import { SERVER_NAME } from './stream-parser.js';

// Variables that would switch Claude Code to a paid API / another provider, or make it think it is nested inside
// another Claude Code session. They are removed from the child env no matter how the app was started.
const KEEP = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CONFIG_DIR']);
const STRIP = [/^ANTHROPIC_/i, /^CLAUDE_CODE_/i, /^CLAUDECODE$/i, /^CLAUDE_PID$/i, /^CLAUDE_EFFORT$/i, /^AI_AGENT$/i, /^AWS_BEARER_TOKEN_BEDROCK$/i, /^OPENAI_API_KEY$/i];

export function sanitizeEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!KEEP.has(key.toUpperCase()) && STRIP.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

// Env of the child: sanitized, plus switches that stop Claude Code from loading ANY CLAUDE.md / auto-memory
// (verified live: --setting-sources alone still let the user-level CLAUDE.md through). The rules travel in the
// appended system prompt instead, so nothing of the user's own Claude Code persona reaches the Analista.
export function childEnv(env = process.env) {
  return { ...sanitizeEnv(env), CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
}

const exists = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Finds the Claude Code executable. Order: explicit override, PATH (claude.exe before the npm shim), then the usual
 * install folders. Returns { command, prefixArgs } or null. An npm `.cmd` shim is resolved to the package it wraps,
 * because Node cannot spawn `.cmd` files directly.
 */
export function locateClaude({ override = '', env = process.env, platform = process.platform, home = os.homedir(), fileExists = exists } = {}) {
  const win = platform === 'win32';
  const candidates = [];
  if (override && override.trim()) candidates.push(override.trim());
  const pathDirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of pathDirs) for (const name of names) candidates.push(path.join(dir, name));
  if (win) {
    candidates.push(path.join(home, '.local', 'bin', 'claude.exe'));
    if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'npm', 'claude.cmd'));
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
  } else {
    candidates.push(path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude');
  }
  for (const file of candidates) {
    if (!fileExists(file)) continue;
    if (/\.cmd$/i.test(file)) {
      const pkg = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code');
      const native = path.join(pkg, 'bin', 'claude.exe');
      const js = path.join(pkg, 'cli.js');
      if (fileExists(native)) return { command: native, prefixArgs: [], path: native };
      if (fileExists(js)) return { command: process.execPath, prefixArgs: [js], path: js };
      continue;
    }
    if (/\.(js|mjs|cjs)$/i.test(file)) return { command: process.execPath, prefixArgs: [file], path: file };
    return { command: file, prefixArgs: [], path: file };
  }
  return null;
}

// Every built-in tool Claude Code may offer that an agent could be denied. An agent is denied all of them except the
// ones its registry entry lists in `builtinTools` (the Analista lists none, so its denied list is exactly this one).
export const ALL_BUILTINS = ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'Task', 'Agent', 'TodoWrite', 'KillShell', 'BashOutput', 'SlashCommand', 'Skill'];
export const DISALLOWED_BUILTINS = ALL_BUILTINS;

// Web tools are also gated by the per-agent `web` setting.
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

export const mcpToolName = (tool, server = SERVER_NAME) => `mcp__${server}__${tool}`;

/**
 * Argument list for one headless turn. The prompt travels through stdin (no quoting or length problems).
 * Isolation: only OUR MCP server (--strict-mcp-config), only the allowlisted tools (--tools + --allowedTools, anything
 * else is denied without asking), no user/local settings or skills, no persisted system prompt.
 * `agent` is a registry entry (default: the Analista) and supplies the MCP server name and the built-in tool allowlist.
 */
export function buildClaudeArgs({ agent = AGENTS.analista, mcpConfigFile, toolNames, web, model, resume, appendSystemPrompt }) {
  const builtins = agent.builtinTools.filter((t) => web || !WEB_TOOLS.includes(t));
  const allowed = [...toolNames.map((t) => mcpToolName(t, agent.mcpServer)), ...builtins];
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config', mcpConfigFile,
    '--strict-mcp-config',
    '--tools', builtins.join(','),
    '--allowedTools', allowed.join(','),
    '--disallowedTools', ALL_BUILTINS.filter((t) => !agent.builtinTools.includes(t)).join(','),
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project',
    ...(agent.skills.length ? [] : ['--disable-slash-commands']),
    '--system-prompt-snapshot', 'off',
    '--append-system-prompt', appendSystemPrompt,
  ];
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  return args;
}
