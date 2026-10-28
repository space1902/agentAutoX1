import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startClient, stopAllClients } from './lib.js';
import { LOGGED_OUT_DIR } from './session-archive.js';

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
  }
}

function setup(id, { linked = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-'));
  if (linked) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'creds.json'), JSON.stringify({ me: { id: '1:2@s.whatsapp.net' } }));
  }
  return root;
}

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

test('a linked session that gets logged out is archived and started again once', async () => {
  const id = 'relink-a';
  const root = setup(id);
  const scripts = [(c) => c.emit('logged_out'), (c) => c.emit('ready')];
  const created = [];
  const clientFactory = () => {
    const client = new FakeClient(scripts[created.length]);
    created.push(client);
    return client;
  };

  try {
    const client = await quiet(() => startClient(id, { authRoot: root, clientFactory }));
    assert.equal(created.length, 2);
    assert.equal(client, created[1]);
    assert.equal(created[0].destroyed, true);
    const archived = fs.readdirSync(path.join(root, LOGGED_OUT_DIR));
    assert.equal(archived.length, 1);
    assert.match(archived[0], new RegExp(`^${id}-`));
    assert.equal(fs.existsSync(path.join(root, id)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second logout in the same run is not relinked again', async () => {
  const id = 'relink-b';
  const root = setup(id);
  let calls = 0;
  const clientFactory = () => {
    calls++;
    return new FakeClient((c) => c.emit('logged_out'));
  };

  try {
    await assert.rejects(quiet(() => startClient(id, { authRoot: root, clientFactory })), /logged/i);
    assert.equal(calls, 2);
    // A later attempt (the caller retries) must not relink again in this run.
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'creds.json'), JSON.stringify({ me: { id: 'x' } }));
    await assert.rejects(quiet(() => startClient(id, { authRoot: root, clientFactory })), /logged/i);
    assert.equal(calls, 3);
    assert.equal(fs.existsSync(path.join(root, id, 'creds.json')), true, 'saved session kept');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unlinked session that gets logged out fails without archiving anything', async () => {
  const id = 'relink-c';
  const root = setup(id, { linked: false });
  let calls = 0;
  const clientFactory = () => {
    calls++;
    return new FakeClient((c) => c.emit('logged_out'));
  };

  try {
    await assert.rejects(quiet(() => startClient(id, { authRoot: root, clientFactory })), /logged/i);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(path.join(root, LOGGED_OUT_DIR)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
