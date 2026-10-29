import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { WaClient } from './wa.js';

function fakeBaileys({ linked = false, codeError = null } = {}) {
  const sockets = [];
  const baileys = {
    useMultiFileAuthState: async () => ({ state: { creds: linked ? { me: { id: '573001234567:1@s.whatsapp.net' } } : {} }, saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    makeWASocket: () => {
      const sock = { ev: new EventEmitter(), requested: [], end() {}, sendMessage: async () => ({ key: { id: 'm1' } }) };
      sock.ev.on = sock.ev.addListener.bind(sock.ev);
      sock.requestPairingCode = async (phone) => {
        sock.requested.push(phone);
        if (codeError) throw codeError;
        return 'ABCD1234';
      };
      sockets.push(sock);
      return sock;
    },
  };
  return { baileys, sockets };
}

async function connected(options, fake) {
  const wa = new WaClient({ authDir: 'x', load: async () => fake.baileys, ...options });
  const events = [];
  for (const name of ['qr', 'pairing_code', 'pairing_failed', 'ready']) wa.on(name, (payload) => events.push([name, payload]));
  await wa.connect();
  return { wa, events, sock: fake.sockets.at(-1) };
}

test('an unlinked session with a phone asks for ONE pairing code and never emits a QR', async () => {
  const { events, sock } = await connected({ pairingPhone: '+57 300 123 4567' }, fakeBaileys());
  sock.ev.emit('connection.update', { qr: 'qr-data' });
  sock.ev.emit('connection.update', { qr: 'qr-data-2' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sock.requested, ['573001234567']);
  assert.deepEqual(events, [['pairing_code', 'ABCD-1234']]);
});

test('without a phone nothing is requested and the QR is dropped', async () => {
  const { events, sock } = await connected({}, fakeBaileys());
  sock.ev.emit('connection.update', { qr: 'qr-data' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sock.requested, []);
  assert.deepEqual(events, []);
});

test('an already linked session does not ask for a code', async () => {
  const { events, sock, wa } = await connected({ pairingPhone: '573001234567' }, fakeBaileys({ linked: true }));
  sock.ev.emit('connection.update', { qr: 'qr-data' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sock.requested, []);
  assert.equal(wa.linked, true);
  assert.deepEqual(events, []);
});

test('a failed pairing request is reported', async () => {
  const { events, sock } = await connected({ pairingPhone: '573001234567' }, fakeBaileys({ codeError: new Error('rate limited') }));
  sock.ev.emit('connection.update', { qr: 'qr-data' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events[0][0], 'pairing_failed');
  assert.match(events[0][1].message, /rate limited/);
});

test('ready is emitted when the connection opens and messages can be sent', async () => {
  const { wa, events, sock } = await connected({ pairingPhone: '573001234567' }, fakeBaileys({ linked: true }));
  sock.ev.emit('connection.update', { connection: 'open' });
  assert.deepEqual(events, [['ready', undefined]]);
  assert.equal(await wa.sendText('573001234567@s.whatsapp.net', 'hola'), 'm1');
  await wa.destroy();
});
