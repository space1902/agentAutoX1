import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openAgentStore } from './agent-db.js';
import { runTurn } from './turn.js';
import { workspaceDir } from './paths.js';
import { makeDataDir } from './seed-fixture.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.js');
const claude = { command: process.execPath, prefixArgs: [FAKE] };

function setup(scenario) {
  const fx = makeDataDir();
  const dump = path.join(os.tmpdir(), `dump-${Math.random().toString(36).slice(2)}.json`);
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  process.env.FAKE_CLAUDE_DUMP = dump;
  const events = [];
  return { fx, dump, events, emit: (e) => events.push(e), done: () => { fx.cleanup(); fs.rmSync(dump, { force: true }); delete process.env.FAKE_CLAUDE_SCENARIO; delete process.env.FAKE_CLAUDE_DUMP; } };
}

test('a normal turn streams events, persists messages and keeps the claude session id', async () => {
  const t = setup('ok');
  try {
    const res = await runTurn({ dataDir: t.fx.dataDir, text: '¿Cuánto gastó CT 07?', emit: t.emit, claude, now: () => t.fx.now });
    assert.equal(res.ok, true);
    assert.deepEqual([...new Set(t.events.map((e) => e.type))], ['turn_start', 'init', 'message_start', 'step', 'step_done', 'text', 'result', 'done']);
    const done = t.events.find((e) => e.type === 'done');
    assert.match(done.text, /CT 07 gastó \$100\.000/);
    assert.deepEqual(done.meta.ungrounded, []);
    assert.equal(done.meta.usage.output, 80);
    assert.equal(done.meta.durationMs, 1234);
    assert.equal(done.meta.steps[0].summary, '1 fila');

    const store = openAgentStore(t.fx.dataDir);
    const session = store.getSession(res.sessionId);
    assert.equal(session.claudeSessionId, 'fake-session-1');
    assert.equal(session.title, '¿Cuánto gastó CT 07?');
    assert.deepEqual(store.messages(res.sessionId).map((m) => m.role), ['user', 'assistant']);
    store.close();

    // Second turn resumes the same Claude session.
    await runTurn({ dataDir: t.fx.dataDir, sessionId: res.sessionId, text: 'y de CT 08?', emit: () => undefined, claude, now: () => t.fx.now });
    const dump = JSON.parse(fs.readFileSync(t.dump, 'utf8'));
    assert.equal(dump.argv[dump.argv.indexOf('--resume') + 1], 'fake-session-1');
    assert.equal(dump.prompt, 'y de CT 08?');
  } finally {
    t.done();
  }
});

test('the child runs isolated: workspace cwd, no API keys, no leftover MCP config, rules written', async () => {
  const t = setup('ok');
  process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
  try {
    await runTurn({ dataDir: t.fx.dataDir, text: 'hola', emit: t.emit, claude, now: () => t.fx.now });
    const dump = JSON.parse(fs.readFileSync(t.dump, 'utf8'));
    assert.ok(!dump.envKeys.some((k) => /^ANTHROPIC_/i.test(k)), 'no ANTHROPIC_* in the child env');
    assert.ok(dump.envKeys.includes('CLAUDE_CODE_DISABLE_CLAUDE_MDS'), 'user CLAUDE.md files are switched off');
    assert.equal(path.resolve(dump.cwd), path.resolve(workspaceDir(t.fx.dataDir)));
    assert.match(fs.readFileSync(path.join(workspaceDir(t.fx.dataDir), 'CLAUDE.md'), 'utf8'), /Cómo lo calculé/);
    const mcpFlag = dump.argv[dump.argv.indexOf('--mcp-config') + 1];
    assert.equal(fs.existsSync(mcpFlag), false, 'per-turn MCP config removed');
    const appended = dump.argv[dump.argv.indexOf('--append-system-prompt') + 1];
    assert.match(appended, /Fecha de hoy en la cuenta: 2026-10-11/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    t.done();
  }
});

test('figures that are not in any tool result are flagged, not removed', async () => {
  const t = setup('ungrounded');
  try {
    await runTurn({ dataDir: t.fx.dataDir, text: '¿ROAS de CT 07?', emit: t.emit, claude, now: () => t.fx.now });
    const done = t.events.find((e) => e.type === 'done');
    assert.deepEqual(done.meta.ungrounded, ['7,35']);
    assert.match(done.text, /7,35/);
  } finally {
    t.done();
  }
});

test('login problems become a friendly error and no assistant message', async () => {
  const t = setup('login');
  try {
    const res = await runTurn({ dataDir: t.fx.dataDir, text: 'hola', emit: t.emit, claude, now: () => t.fx.now });
    assert.equal(res.ok, false);
    assert.match(t.events.at(-1).error, /sesión/);
    const store = openAgentStore(t.fx.dataDir);
    assert.deepEqual(store.messages(res.sessionId).map((m) => m.role), ['user']);
    store.close();
  } finally {
    t.done();
  }
});

test('a crash without a result reports the stderr tail', async () => {
  const t = setup('noresult');
  try {
    const res = await runTurn({ dataDir: t.fx.dataDir, text: 'hola', emit: t.emit, claude, now: () => t.fx.now });
    assert.equal(res.ok, false);
    assert.match(res.error, /boom/);
  } finally {
    t.done();
  }
});

test('cancel kills only the child, keeps the partial text and emits cancelled', async () => {
  const t = setup('hang');
  try {
    let cancel;
    const events = t.events;
    const run = runTurn({
      dataDir: t.fx.dataDir, text: 'tarda', claude, now: () => t.fx.now, registerCancel: (fn) => (cancel = fn),
      emit: (e) => {
        events.push(e);
        if (e.type === 'text') cancel();
      },
    });
    const res = await run;
    assert.equal(res.cancelled, true);
    assert.ok(events.some((e) => e.type === 'cancelled'));
    const store = openAgentStore(t.fx.dataDir);
    const last = store.messages(res.sessionId).at(-1);
    assert.equal(last.text, 'Pensando...');
    assert.equal(last.meta.cancelled, true);
    store.close();
  } finally {
    t.done();
  }
});

test('a missing Claude Code gives actionable guidance', async () => {
  const t = setup('ok');
  try {
    const res = await runTurn({ dataDir: t.fx.dataDir, text: 'hola', emit: t.emit, locate: () => null, now: () => t.fx.now });
    assert.equal(res.ok, false);
    assert.match(res.error, /No encuentro Claude Code/);
  } finally {
    t.done();
  }
});
