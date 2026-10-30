import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AgentError, runCommand } from './agent-api.js';
import { createAgentStore, openAgentStore } from './agent-db.js';
import { buildClaudeArgs } from './claude-cli.js';
import { agentDbPath, agentDir, settingsPath, workspaceDir } from './paths.js';
import { AGENT_IDS, AGENTS, getAgent, publicAgents } from './registry.js';
import { makeDataDir } from './seed-fixture.js';
import { loadSettings, saveSettings } from './settings.js';
import { createStreamParser } from './stream-parser.js';
import { BASE_TOOL_NAMES, LEARNING_TOOL_NAMES } from './tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Captured from buildClaudeArgs BEFORE the registry refactor: the Analista's exact args must never change.
const GOLDEN = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'analista-args.golden.json'), 'utf8'));
const argsFor = (web, learning, agent) => buildClaudeArgs({
  ...(agent ? { agent } : {}), mcpConfigFile: 'mcp.json', toolNames: [...BASE_TOOL_NAMES, ...(learning ? LEARNING_TOOL_NAMES : [])], web, model: 'sonnet', resume: 'sid-1', appendSystemPrompt: 'PROMPT',
});

test('the Analista claude args are byte-for-byte what they were before the registry', () => {
  for (const web of [true, false]) {
    for (const learning of [true, false]) {
      const key = `web=${web},learning=${learning}`;
      assert.deepEqual(argsFor(web, learning), GOLDEN[key], key);
      assert.deepEqual(argsFor(web, learning, AGENTS.analista), GOLDEN[key], `${key} (explicit agent)`);
    }
  }
  const bare = buildClaudeArgs({ mcpConfigFile: 'mcp.json', toolNames: ['metrics'], web: true, model: '', resume: null, appendSystemPrompt: 'PROMPT' });
  assert.deepEqual(bare, GOLDEN.nomodel);
});

test('the registry holds the Analista and the Agente creativo and rejects unknown ids', () => {
  assert.deepEqual(AGENT_IDS, ['analista', 'creativo']);
  assert.equal(getAgent().id, 'analista');
  assert.equal(getAgent('').id, 'analista');
  assert.equal(getAgent('creativo').id, 'creativo');
  assert.throws(() => getAgent('constructor'), /desconocido/);
  assert.throws(() => getAgent('../x'), /desconocido/);
  assert.deepEqual(publicAgents().map((a) => a.id), ['analista', 'creativo']);
  assert.equal(publicAgents()[0].name, 'Analista de publicidad');
  assert.equal(publicAgents()[1].name, 'Agente creativo');
  assert.deepEqual(publicAgents()[1].tabs, ['chat', 'ajustes']);
  assert.ok(publicAgents()[0].tabs.includes('recomendaciones'));
  // The UI gets plain data only: no functions or paths.
  assert.ok(!JSON.stringify(publicAgents()).includes('\\'));
  assert.ok(publicAgents().every((a) => Object.values(a).every((v) => typeof v !== 'function')));
});

test('paths: the Analista stays in the legacy folder, other agents go under agents/<id>', () => {
  const root = path.join('data');
  assert.equal(agentDbPath(root), path.join(root, 'analista', 'agent.db'));
  assert.equal(agentDbPath(root, 'analista'), path.join(root, 'analista', 'agent.db'));
  assert.equal(agentDbPath(root, AGENTS.analista), path.join(root, 'analista', 'agent.db'));
  assert.equal(settingsPath(root), path.join(root, 'analista', 'settings.json'));
  assert.equal(workspaceDir(root), path.join(root, 'analista', 'workspace'));
  assert.equal(agentDir(root, 'creativo'), path.join(root, 'agents', 'creativo'));
  assert.equal(agentDbPath(root, 'creativo'), path.join(root, 'agents', 'creativo', 'agent.db'));
  assert.throws(() => agentDir(root, '../evil'), /no válido/);
});

test('a legacy <data>/analista/agent.db opens as-is through the registry, with nothing created for other agents', () => {
  const fx = makeDataDir();
  try {
    const legacy = path.join(fx.dataDir, 'analista', 'agent.db');
    const old = createAgentStore(legacy);
    const sid = old.createSession('Chat antiguo');
    old.addMessage({ sessionId: sid, role: 'user', text: 'hola' });
    old.close();
    saveSettings(fx.dataDir, { model: 'haiku' });

    for (const store of [openAgentStore(fx.dataDir), openAgentStore(fx.dataDir, undefined, 'analista'), openAgentStore(fx.dataDir, undefined, AGENTS.analista)]) {
      assert.equal(store.listSessions().length, 1);
      assert.equal(store.getSession(sid).title, 'Chat antiguo');
      assert.equal(store.messages(sid)[0].text, 'hola');
      store.close();
    }
    assert.equal(loadSettings(fx.dataDir, AGENTS.analista).model, 'haiku');
    assert.equal(fs.existsSync(path.join(fx.dataDir, 'agents')), false);
  } finally {
    fx.cleanup();
  }
});

test('a non-Analista agent gets its own database and settings and leaves the legacy ones alone', () => {
  const fx = makeDataDir();
  try {
    const store = openAgentStore(fx.dataDir, undefined, 'creativo');
    store.createSession('x');
    store.close();
    saveSettings(fx.dataDir, { model: 'opus' }, 'creativo');
    assert.ok(fs.existsSync(path.join(fx.dataDir, 'agents', 'creativo', 'agent.db')));
    assert.equal(loadSettings(fx.dataDir, 'creativo').model, 'opus');
    assert.equal(loadSettings(fx.dataDir).model, '');
    assert.equal(fs.existsSync(path.join(fx.dataDir, 'analista', 'agent.db')), false);
  } finally {
    fx.cleanup();
  }
});

test('buildClaudeArgs reads the built-in tools and the skills switch from the agent entry', () => {
  const other = { id: 'x', mcpServer: 'xsrv', builtinTools: ['Read', 'Skill', 'WebSearch'], skills: ['one'] };
  const args = buildClaudeArgs({ agent: other, mcpConfigFile: 'm.json', toolNames: ['t1'], web: false, model: '', resume: null, appendSystemPrompt: 'p' });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--tools'), 'Read,Skill');
  assert.equal(at('--allowedTools'), 'mcp__xsrv__t1,Read,Skill');
  assert.ok(!at('--disallowedTools').split(',').includes('Read'));
  assert.ok(!at('--disallowedTools').split(',').includes('Skill'));
  assert.ok(at('--disallowedTools').split(',').includes('Bash'));
  assert.ok(!args.includes('--disable-slash-commands'));
});

test('createStreamParser takes the step label from the agent', () => {
  const p = createStreamParser({ stepLabel: (name) => `paso ${name}` });
  const events = p.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__x__foo', input: {} }] } }));
  assert.equal(events[0].label, 'paso mcp__x__foo');
});

test('agent-api rejects unknown agents and lists the registry', async () => {
  const fx = makeDataDir();
  try {
    await assert.rejects(runCommand('sessions', {}, { dataDir: fx.dataDir, agentId: 'nope' }), AgentError);
    assert.equal((await runCommand('agents-list', {}, { dataDir: fx.dataDir })).agents[0].id, 'analista');
    assert.deepEqual((await runCommand('sessions', {}, { dataDir: fx.dataDir, agentId: 'analista' })).sessions, []);
    await assert.rejects(runCommand('eval-bank', {}, { dataDir: fx.dataDir, agentId: 'nope' }), AgentError);
    await assert.rejects(runCommand('learning-run', {}, { dataDir: fx.dataDir, agentId: 'creativo' }), /solo existe para el Analista/);
    assert.deepEqual((await runCommand('sessions', {}, { dataDir: fx.dataDir, agentId: 'creativo' })).sessions, []);
  } finally {
    fx.cleanup();
  }
});
