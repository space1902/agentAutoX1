import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { buildClaudeArgs, DISALLOWED_BUILTINS, locateClaude, sanitizeEnv } from './claude-cli.js';

test('sanitizeEnv removes API keys, other providers and nested-session markers, keeps the login', () => {
  const env = sanitizeEnv({
    PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\x', ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://x',
    ANTHROPIC_API_KEY_SCRIPTS: 'k', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_ENTRYPOINT: 'cli', AWS_BEARER_TOKEN_BEDROCK: 'b', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe', CLAUDE_CONFIG_DIR: 'C:\\cfg',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'PATH', 'USERPROFILE']);
});

test('locateClaude: override first, then PATH (exe before shim), then the install folders', () => {
  const present = new Set([
    'C:\\custom\\claude.exe', 'C:\\bin\\claude.cmd', 'C:\\bin\\node_modules\\@anthropic-ai\\claude-code\\cli.js', 'C:\\Users\\x\\.local\\bin\\claude.exe',
  ]);
  const fileExists = (f) => present.has(f);
  const base = { platform: 'win32', home: 'C:\\Users\\x', env: { PATH: 'C:\\bin', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, fileExists };
  // path.join on this platform decides separators; normalise through it for the fake file system.
  const norm = (f) => f.replace(/\\/g, path.sep);
  const fs2 = new Set([...present].map(norm));
  const opts = { ...base, fileExists: (f) => fs2.has(norm(f)) };
  assert.equal(locateClaude({ ...opts, override: 'C:\\custom\\claude.exe' }).path, 'C:\\custom\\claude.exe');
  const shim = locateClaude(opts);
  assert.equal(shim.command, process.execPath);
  assert.match(shim.prefixArgs[0], /cli\.js$/);
  const home = locateClaude({ ...opts, env: { PATH: '' } });
  assert.match(home.command, /claude\.exe$/);
  assert.equal(locateClaude({ ...opts, fileExists: () => false }), null);
});

test('buildClaudeArgs isolates the agent: our MCP only, allowlisted tools, no permission bypass', () => {
  const args = buildClaudeArgs({ mcpConfigFile: 'm.json', toolNames: ['query_sql', 'metrics'], web: true, model: 'sonnet', resume: 'sid-1', appendSystemPrompt: 'reglas' });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], '-p');
  assert.equal(at('--output-format'), 'stream-json');
  assert.ok(args.includes('--verbose') && args.includes('--include-partial-messages') && args.includes('--strict-mcp-config'));
  assert.equal(at('--mcp-config'), 'm.json');
  assert.equal(at('--tools'), 'WebSearch,WebFetch');
  assert.equal(at('--allowedTools'), 'mcp__analista__query_sql,mcp__analista__metrics,WebSearch,WebFetch');
  assert.equal(at('--permission-mode'), 'dontAsk');
  assert.equal(at('--setting-sources'), 'project');
  assert.equal(at('--model'), 'sonnet');
  assert.equal(at('--resume'), 'sid-1');
  assert.equal(at('--append-system-prompt'), 'reglas');
  for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit']) assert.ok(DISALLOWED_BUILTINS.includes(tool));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('buildClaudeArgs without web leaves no built-in tool at all', () => {
  const args = buildClaudeArgs({ mcpConfigFile: 'm.json', toolNames: ['metrics'], web: false, model: '', resume: null, appendSystemPrompt: 'x' });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__analista__metrics');
  assert.ok(!args.includes('--model') && !args.includes('--resume'));
});
