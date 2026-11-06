import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startClient, stopAllClients } from './lib.js';
import { createDisconnectTracker } from './disconnect-brake.js';
import { createPauseStore } from './pause-state.js';
import { LOGGED_OUT_DIR } from './session-archive.js';
import { createSupervisor } from './session-supervisor.js';

class FakeClient extends EventEmitter {
  constructor(script) {
    super();
    this.script = script;
    this.destroyed = false;
  }
  connect() {
    setImmediate(() => this.script(this));
    return Promise.resolve();
  }
  async destroy() {
    this.destroyed = true;
    this.stopped = true;
  }
}

function setup(id, { linked = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-'));
  if (linked) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'creds.json'), JSON.stringify({ me: { id: '573000000001:2@s.whatsapp.net' } }));
  }
  const store = createPauseStore({ file: path.join(root, 'warmup-pauses.json'), warn: () => {} });
  const events = [];
  const supervisor = createSupervisor({
    store,
    tracker: createDisconnectTracker(),
    logEvent: (session, event, detail) => events.push({ session, event, detail }),
    stopSession: () => {},
    fleetSize: () => 5,
    warn: () => {},
  });
  return { root, store, supervisor, events };
}

const CONFIG = { testers: ['relink-a', 'relink-b', 'relink-c'].map((id) => ({ id, phone: '3000000001' })) };

const quiet = async (fn) => {
  const originals = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, originals);
    await stopAllClients();
  }
};

const start = (id, t, clientFactory) =>
  startClient(id, { authRoot: t.root, clientFactory, config: CONFIG, persistPhone: () => ({ status: 'saved' }), supervisor: t.supervisor });

test('a linked session that gets logged out is paused, never archived and never linked again', async () => {
  const id = 'relink-a';
  const t = setup(id);
  let calls = 0;
  const clientFactory = () => {
    calls++;
    return new FakeClient((c) => c.emit('logged_out'));
  };

  try {
    await assert.rejects(
      quiet(() => start(id, t, clientFactory)),
      (error) => error.code === 'LOGGED_OUT' && /paused/i.test(error.message),
    );
    assert.equal(calls, 1, 'no second client: no automatic QR or pairing code');
    assert.equal(fs.existsSync(path.join(t.root, LOGGED_OUT_DIR)), false, 'nothing archived');
    assert.equal(fs.existsSync(path.join(t.root, id, 'creds.json')), true, 'the saved session is untouched');

    const pause = t.store.get(id);
    assert.equal(pause.reason, 'logged_out');
    assert.equal(pause.until, null);
    assert.equal(t.events.filter((e) => e.event === 'paused').length, 1);
    assert.equal(t.events.some((e) => e.event === 'logged_out_relink'), false);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('trying again after a logout still does not archive or relink', async () => {
  const id = 'relink-b';
  const t = setup(id);
  let calls = 0;
  const clientFactory = () => {
    calls++;
    return new FakeClient((c) => c.emit('logged_out'));
  };

  try {
    await assert.rejects(quiet(() => start(id, t, clientFactory)), /logged/i);
    await assert.rejects(quiet(() => start(id, t, clientFactory)), /logged/i);
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(path.join(t.root, id, 'creds.json')), true, 'saved session kept');
    assert.equal(fs.existsSync(path.join(t.root, LOGGED_OUT_DIR)), false);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('an unlinked session that gets logged out fails without archiving or pausing anything', async () => {
  const id = 'relink-c';
  const t = setup(id, { linked: false });
  let calls = 0;
  const clientFactory = () => {
    calls++;
    return new FakeClient((c) => c.emit('logged_out'));
  };

  try {
    await assert.rejects(quiet(() => start(id, t, clientFactory)), /logged/i);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(path.join(t.root, LOGGED_OUT_DIR)), false);
    assert.equal(t.store.get(id), null);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('a logout AFTER the session was ready also pauses it and keeps the session data', async () => {
  const id = 'relink-a';
  const t = setup(id);
  const clients = [];
  const clientFactory = () => {
    const client = new FakeClient((c) => c.emit('ready'));
    clients.push(client);
    return client;
  };

  try {
    const client = await quiet(() => start(id, t, clientFactory));
    client.emit('logged_out');
    client.emit('disconnected', 'LOGOUT');
    assert.equal(t.store.get(id).reason, 'logged_out');
    assert.equal(fs.existsSync(path.join(t.root, id, 'creds.json')), true);
    assert.equal(fs.existsSync(path.join(t.root, LOGGED_OUT_DIR)), false);
    assert.equal(clients.length, 1);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('reconnectable disconnects are reported to the brake; LOGOUT, CONFLICT and FATAL are not', async () => {
  const id = 'relink-a';
  const t = setup(id);
  const seen = [];
  t.supervisor.onDisconnect = (session, reason) => seen.push([session, reason]);
  const clientFactory = () => new FakeClient((c) => c.emit('ready'));

  try {
    const client = await quiet(() => start(id, t, clientFactory));
    for (const reason of ['408', '503', 'closed', 'LOGOUT', 'CONFLICT', 'FATAL:500']) client.emit('disconnected', reason);
    assert.deepEqual(seen, [[id, '408'], [id, '503'], [id, 'closed']]);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});
