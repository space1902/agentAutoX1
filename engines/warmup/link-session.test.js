import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { linkSession } from './link-session.js';

class FakeClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
  }
  async connect() {
    this.connected = true;
  }
  async destroy() {
    this.destroyed = true;
  }
}

function setup({ linked = false, phone = '573001112233' } = {}) {
  const events = [];
  const state = { linked, clients: [] };
  const clientFactory = (options) => {
    const client = new FakeClient(options);
    state.clients.push(client);
    return client;
  };
  const run = (extra = {}) =>
    linkSession({
      id: 'tester7',
      phone,
      authRoot: '/auth',
      resultsDir: '/results',
      clientFactory,
      hasSession: () => state.linked,
      emit: (e) => events.push(e),
      timeoutMs: 1000,
      readyCheckMs: 0,
      sleep: async () => {},
      ...extra,
    });
  return { events, state, run };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('an already linked tester is reported and no client is created', async () => {
  const t = setup({ linked: true });
  const result = await t.run();
  assert.equal(result.status, 'already-linked');
  assert.deepEqual(t.events.map((e) => e.event), ['already-linked']);
  assert.equal(t.state.clients.length, 0);
});

test('without a phone number there is nothing to pair', async () => {
  const t = setup({ phone: null });
  const result = await t.run();
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NO_PHONE');
});

test('requests a pairing code, emits it, and finishes when the session is saved', async () => {
  const t = setup();
  const done = t.run();
  await tick();
  const client = t.state.clients[0];
  assert.equal(client.options.phone, '573001112233');
  assert.equal(client.options.authDir.replaceAll('\\', '/'), '/auth/tester7');
  assert.equal(client.connected, true);

  client.emit('pairing_code', 'ABCD-1234');
  client.emit('pairing_code', 'WXYZ-9876'); // WhatsApp rotated the code
  t.state.linked = true; // creds.json now holds the paired account
  client.emit('ready');

  const result = await done;
  assert.equal(result.status, 'linked');
  assert.deepEqual(
    t.events.map((e) => [e.event, e.code]),
    [
      ['code', 'ABCD-1234'],
      ['code', 'WXYZ-9876'],
      ['linked', undefined],
    ],
  );
  assert.equal(client.destroyed, true);
});

test('ready without saved credentials is not reported as success', async () => {
  const t = setup();
  const done = t.run({ timeoutMs: 500 });
  await tick();
  const client = t.state.clients[0];
  client.emit('ready'); // linked stays false
  const result = await done;
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NOT_SAVED');
  assert.equal(client.destroyed, true);
});

test('if WhatsApp refuses the pairing code (qr fallback) it fails with PAIRING_REFUSED', async () => {
  const t = setup();
  const done = t.run();
  await tick();
  t.state.clients[0].emit('qr', 'qr-data');
  const result = await done;
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PAIRING_REFUSED');
  assert.equal(t.state.clients[0].destroyed, true);
});

test('times out when the code is never typed', async () => {
  const t = setup();
  const done = t.run({ timeoutMs: 30 });
  await tick();
  t.state.clients[0].emit('pairing_code', 'ABCD-1234');
  const result = await done;
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(t.state.clients[0].destroyed, true);
});

test('a fatal error while linking is reported with its reason', async () => {
  const t = setup();
  const done = t.run();
  await tick();
  t.state.clients[0].emit('fatal', 'CONFLICT');
  const result = await done;
  assert.equal(result.code, 'FATAL');
  assert.match(result.message, /CONFLICT/);
});

test('a client that cannot connect fails cleanly', async () => {
  const t = setup();
  const result = await t.run({
    clientFactory: () => ({
      on() {},
      async connect() {
        throw new Error('network down');
      },
      async destroy() {},
    }),
  });
  assert.equal(result.code, 'CONNECT_FAILED');
  assert.match(result.message, /network down/);
});
