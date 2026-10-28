import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WaClient } from './wa-client.js';

const GROUP = '120363000000000000@g.us';

// A stand-in for the Baileys module: records every socket it creates and lets tests drive events.
function fakeBaileys({ me = { id: '573001112233:7@s.whatsapp.net', name: 'Tester One' } } = {}) {
  const sockets = [];
  const authState = { creds: { me }, keys: {} };
  let credsSaves = 0;

  const makeWASocket = (config) => {
    const bus = new EventEmitter();
    const sock = {
      config,
      ended: false,
      sent: [],
      presence: [],
      user: me,
      ev: { on: (event, handler) => bus.on(event, handler) },
      fire: (event, payload) => bus.emit(event, payload),
      end() {
        sock.ended = true;
      },
      async sendMessage(jid, content) {
        const key = { remoteJid: jid, fromMe: true, id: `SENT${sock.sent.length + 1}` };
        sock.sent.push({ jid, content });
        return { key, message: { conversation: content.text ?? '' }, messageTimestamp: 1_700_000_000 };
      },
      pairingRequests: [],
      async requestPairingCode(phone) {
        sock.pairingRequests.push(phone);
        if (sock.pairingError) throw sock.pairingError;
        return 'ABCD1234';
      },
      async sendPresenceUpdate(state, jid) {
        sock.presence.push({ state, jid });
      },
      groupCalls: [],
      participants: [],
      addResult: null,
      inviteError: null,
      joinError: null,
      async groupMetadata(jid) {
        sock.groupCalls.push(['metadata', jid]);
        return { id: jid, subject: 'Warm Up Group', participants: sock.participants };
      },
      async groupParticipantsUpdate(jid, jids, action) {
        sock.groupCalls.push(['update', jid, jids, action]);
        return jids.map((item) => ({ status: sock.addResult?.(item) ?? '200', jid: item }));
      },
      async groupInviteCode(jid) {
        sock.groupCalls.push(['invite', jid]);
        if (sock.inviteError) throw sock.inviteError;
        return 'INVITECODE';
      },
      async groupAcceptInvite(code) {
        sock.groupCalls.push(['accept', code]);
        if (sock.joinError) throw sock.joinError;
        return GROUP;
      },
      async groupFetchAllParticipating() {
        return {
          [GROUP]: { id: GROUP, subject: 'Warm Up Group' },
          '120363111111111111@g.us': { id: '120363111111111111@g.us', subject: 'Other' },
        };
      },
    };
    sockets.push(sock);
    return sock;
  };

  return {
    sockets,
    authState,
    credsSaves: () => credsSaves,
    load: async () => ({
      makeWASocket,
      useMultiFileAuthState: async () => ({
        state: authState,
        saveCreds: async () => {
          credsSaves++;
        },
      }),
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    }),
  };
}

function setup(options = {}) {
  const baileys = fakeBaileys(options.baileys);
  const activityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-client-'));
  const client = new WaClient({
    id: 'tester1',
    authDir: path.join(activityDir, 'auth'),
    activityDir,
    loadBaileys: baileys.load,
    reconnectDelay: () => 0,
    ...options.client,
  });
  const cleanup = async () => {
    await client.destroy();
    fs.rmSync(activityDir, { recursive: true, force: true });
  };
  return { baileys, client, activityDir, cleanup };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

const incoming = (text, id = 'IN1') => ({
  key: { remoteJid: GROUP, fromMe: false, id, participant: '573009998877@s.whatsapp.net' },
  pushName: 'Ana',
  messageTimestamp: 1_700_000_000,
  message: { conversation: text },
});

test('connect creates a lightweight socket: no history sync, no online presence, no own events', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    const config = baileys.sockets[0].config;
    assert.equal(config.markOnlineOnConnect, false);
    assert.equal(config.syncFullHistory, false);
    assert.equal(config.emitOwnEvents, false);
    assert.equal(config.shouldSyncHistoryMessage(), false);
    assert.deepEqual(config.version, [2, 3000, 1]);
    assert.equal(config.auth, baileys.authState);
    assert.equal(config.agent, undefined);
    assert.equal(config.printQRInTerminal, undefined);
  } finally {
    await cleanup();
  }
});

test('connect wires the proxy agent into the socket and the media fetcher', async () => {
  const agent = { name: 'fake-agent' };
  let requestedProxy = null;
  const { baileys, client, cleanup } = setup({
    client: {
      proxy: 'http://user:pw@host:8080',
      createProxyAgent: async (url) => {
        requestedProxy = url;
        return agent;
      },
    },
  });
  try {
    await client.connect();
    const config = baileys.sockets[0].config;
    assert.equal(requestedProxy, 'http://user:pw@host:8080');
    assert.equal(config.agent, agent);
    assert.equal(config.fetchAgent, agent);
  } finally {
    await cleanup();
  }
});

test('with a phone, an unlinked session asks for one pairing code per socket and emits no qr', async () => {
  const { baileys, client, cleanup } = setup({ client: { phone: '573001234567' } });
  try {
    baileys.authState.creds.registered = false;
    const events = [];
    client.on('qr', (qr) => events.push(['qr', qr]));
    client.on('pairing_code', (code) => events.push(['pairing_code', code]));

    await client.connect();
    const sock = baileys.sockets[0];
    sock.fire('connection.update', { qr: 'QR-1' });
    sock.fire('connection.update', { qr: 'QR-2' });
    await tick();
    sock.fire('connection.update', { qr: 'QR-3' });
    await tick();

    assert.deepEqual(sock.pairingRequests, ['573001234567']);
    assert.deepEqual(events, [['pairing_code', 'ABCD-1234']]);
  } finally {
    await cleanup();
  }
});

test('without a phone the qr is emitted as before and no pairing code is requested', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    baileys.authState.creds.registered = false;
    const events = [];
    client.on('qr', (qr) => events.push(qr));
    client.on('pairing_code', () => events.push('pairing'));

    await client.connect();
    baileys.sockets[0].fire('connection.update', { qr: 'QR-DATA' });
    await tick();

    assert.deepEqual(events, ['QR-DATA']);
    assert.deepEqual(baileys.sockets[0].pairingRequests, []);
  } finally {
    await cleanup();
  }
});

test('an already registered session never requests a pairing code', async () => {
  const { baileys, client, cleanup } = setup({ client: { phone: '573001234567' } });
  try {
    baileys.authState.creds.registered = true;
    const events = [];
    client.on('qr', (qr) => events.push(qr));
    client.on('pairing_code', () => events.push('pairing'));

    await client.connect();
    baileys.sockets[0].fire('connection.update', { qr: 'QR-DATA' });
    await tick();

    assert.deepEqual(baileys.sockets[0].pairingRequests, []);
    assert.deepEqual(events, ['QR-DATA']);
  } finally {
    await cleanup();
  }
});

test('if the pairing code request fails, the qr is emitted instead', async () => {
  const { baileys, client, cleanup } = setup({ client: { phone: '573001234567' } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    baileys.authState.creds.registered = false;
    const events = [];
    client.on('qr', (qr) => events.push(['qr', qr]));
    client.on('pairing_code', (code) => events.push(['pairing_code', code]));

    await client.connect();
    const sock = baileys.sockets[0];
    sock.pairingError = new Error('rate limited');
    sock.fire('connection.update', { qr: 'QR-1' });
    await tick();

    assert.deepEqual(events, [['qr', 'QR-1']]);
  } finally {
    console.warn = warn;
    await cleanup();
  }
});

test('connection updates emit qr and ready, and expose the linked account info', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    const events = [];
    client.on('qr', (qr) => events.push(['qr', qr]));
    client.on('ready', () => events.push(['ready']));

    await client.connect();
    baileys.sockets[0].fire('connection.update', { qr: 'QR-DATA' });
    baileys.sockets[0].fire('connection.update', { connection: 'open' });

    assert.deepEqual(events, [['qr', 'QR-DATA'], ['ready']]);
    assert.deepEqual(client.info, {
      pushname: 'Tester One',
      wid: { user: '573001112233' },
      platform: 'baileys',
    });
  } finally {
    await cleanup();
  }
});

test('incoming messages are normalized, emitted and logged as metadata only', async () => {
  const { baileys, client, activityDir, cleanup } = setup();
  try {
    const seen = [];
    const created = [];
    client.on('message', (msg) => seen.push(msg));
    client.on('message_create', (msg) => created.push(msg));

    await client.connect();
    const own = {
      key: { remoteJid: GROUP, fromMe: true, id: 'OWN1' },
      messageTimestamp: 1_700_000_001,
      message: { conversation: '#setup' },
    };
    baileys.sockets[0].fire('messages.upsert', {
      type: 'notify',
      messages: [incoming('hola'), own],
    });
    // History or appended messages are not live traffic.
    baileys.sockets[0].fire('messages.upsert', { type: 'append', messages: [incoming('viejo', 'OLD')] });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].body, 'hola');
    assert.equal(seen[0].pushName, 'Ana');
    assert.equal(seen[0].author, '573009998877');
    assert.deepEqual(
      created.map((msg) => msg.body),
      ['hola', '#setup'],
    );

    const activity = fs.readFileSync(path.join(activityDir, 'activity-tester1.jsonl'), 'utf8');
    assert.equal(activity.trim().split('\n').length, 2);
    assert.ok(!activity.includes('hola'));
    assert.deepEqual(client.readActivity(0).messages.map((m) => m.fromMe), [false, true]);
  } finally {
    await cleanup();
  }
});

test('a broken listener never stops message processing', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    const seen = [];
    client.on('message', () => {
      throw new Error('listener bug');
    });
    client.on('message', (msg) => seen.push(msg.body));

    await client.connect();
    baileys.sockets[0].fire('messages.upsert', { type: 'notify', messages: [incoming('uno'), incoming('dos', 'IN2')] });
    assert.deepEqual(seen, ['uno', 'dos']);
  } finally {
    await cleanup();
  }
});

test('logout stops reconnecting and reports logged_out', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    const events = [];
    client.on('logged_out', () => events.push('logged_out'));
    client.on('disconnected', (reason) => events.push(`disconnected:${reason}`));

    await client.connect();
    baileys.sockets[0].fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await tick();

    assert.deepEqual(events, ['logged_out', 'disconnected:LOGOUT']);
    assert.equal(baileys.sockets.length, 1);
  } finally {
    await cleanup();
  }
});

test('restart-required (right after pairing) reconnects silently with a fresh socket', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    const events = [];
    client.on('disconnected', (reason) => events.push(reason));

    await client.connect();
    baileys.sockets[0].fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await tick();

    assert.equal(baileys.sockets.length, 2);
    assert.equal(baileys.sockets[0].ended, true);
    assert.deepEqual(events, []);
  } finally {
    await cleanup();
  }
});

test('a dropped connection of a linked number is reported and retried', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    const events = [];
    client.on('disconnected', (reason) => events.push(reason));

    await client.connect();
    baileys.sockets[0].fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    await tick();

    assert.equal(baileys.sockets.length, 2);
    assert.deepEqual(events, ['428']);
  } finally {
    await cleanup();
  }
});

test('QR expiry before the number is linked does not count as an incident', async () => {
  const { baileys, client, cleanup } = setup({ baileys: { me: null } });
  try {
    const events = [];
    client.on('disconnected', (reason) => events.push(reason));

    await client.connect();
    baileys.sockets[0].fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await tick();

    assert.equal(baileys.sockets.length, 2);
    assert.deepEqual(events, []);
  } finally {
    await cleanup();
  }
});

test('a replaced session or a fatal code stops reconnecting', async () => {
  for (const [code, reason] of [[440, 'CONFLICT'], [403, 'FATAL:403']]) {
    const { baileys, client, cleanup } = setup();
    try {
      const events = [];
      client.on('disconnected', (r) => events.push(r));
      client.on('fatal', (r) => events.push(`fatal:${r}`));

      await client.connect();
      baileys.sockets[0].fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: code } } },
      });
      await tick();

      assert.equal(baileys.sockets.length, 1, `code ${code} must not reconnect`);
      assert.ok(events.includes(reason) || events.includes(`fatal:${reason}`), `${code}: ${events}`);
    } finally {
      await cleanup();
    }
  }
});

test('events from a replaced socket are ignored', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    const seen = [];
    client.on('message', (msg) => seen.push(msg.body));

    await client.connect();
    const first = baileys.sockets[0];
    first.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await tick();

    first.fire('messages.upsert', { type: 'notify', messages: [incoming('fantasma')] });
    baileys.sockets[1].fire('messages.upsert', { type: 'notify', messages: [incoming('real')] });
    assert.deepEqual(seen, ['real']);
  } finally {
    await cleanup();
  }
});

test('creds updates are persisted', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    baileys.sockets[0].fire('creds.update', {});
    await tick();
    assert.equal(baileys.credsSaves(), 1);
  } finally {
    await cleanup();
  }
});

test('sendText sends plain text, returns the inner id and registers activity', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    baileys.sockets[0].fire('connection.update', { connection: 'open' });

    const sent = await client.sendText(GROUP, 'buenas');
    assert.deepEqual(baileys.sockets[0].sent, [{ jid: GROUP, content: { text: 'buenas' } }]);
    assert.equal(sent.id.id, 'SENT1');

    const activity = client.readActivity(0);
    assert.equal(activity.messages.length, 1);
    assert.equal(activity.messages[0].fromMe, true);
    assert.equal(activity.earliestSent, activity.messages[0].timestamp);
  } finally {
    await cleanup();
  }
});

test('sent messages stay available for retry requests through getMessage', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    baileys.sockets[0].fire('connection.update', { connection: 'open' });
    await client.sendText(GROUP, 'recuerdame');

    const found = await baileys.sockets[0].config.getMessage({ remoteJid: GROUP, id: 'SENT1' });
    assert.deepEqual(found, { conversation: 'recuerdame' });
    assert.equal(await baileys.sockets[0].config.getMessage({ remoteJid: GROUP, id: 'nope' }), undefined);
  } finally {
    await cleanup();
  }
});

test('sendVoice sends a push-to-talk OGG/Opus note', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    baileys.sockets[0].fire('connection.update', { connection: 'open' });

    const ogg = Buffer.from('ogg');
    const sent = await client.sendVoice(GROUP, ogg);
    const { content } = baileys.sockets[0].sent[0];
    assert.equal(content.audio.toString(), 'ogg');
    assert.equal(content.mimetype, 'audio/ogg; codecs=opus');
    assert.equal(content.ptt, true);
    assert.equal(sent.id.id, 'SENT1');
  } finally {
    await cleanup();
  }
});

test('sendImage sends the picture with its caption', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    baileys.sockets[0].fire('connection.update', { connection: 'open' });
    await client.sendImage(GROUP, Buffer.from('png'), 'image abc');
    const { content } = baileys.sockets[0].sent[0];
    assert.equal(content.image.toString(), 'png');
    assert.equal(content.caption, 'image abc');
  } finally {
    await cleanup();
  }
});

test('setPresence forwards typing and recording states', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    baileys.sockets[0].fire('connection.update', { connection: 'open' });
    await client.setPresence(GROUP, 'composing');
    await client.setPresence(GROUP, 'recording');
    assert.deepEqual(baileys.sockets[0].presence, [
      { state: 'composing', jid: GROUP },
      { state: 'recording', jid: GROUP },
    ]);
  } finally {
    await cleanup();
  }
});

test('sending waits for the connection to open and fails after the wait limit', async () => {
  const { baileys, client, cleanup } = setup({ client: { readyWaitMs: 40 } });
  try {
    await client.connect();
    const pending = client.sendText(GROUP, 'tarde');
    setTimeout(() => baileys.sockets[0].fire('connection.update', { connection: 'open' }), 10);
    assert.equal((await pending).id.id, 'SENT1');

    baileys.sockets[0].fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await tick();
    await assert.rejects(client.sendText(GROUP, 'nunca'), /not connected/i);
  } finally {
    await cleanup();
  }
});

test('listGroups returns id and name, and feeds the group metadata cache', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    baileys.sockets[0].fire('connection.update', { connection: 'open' });

    const groups = await client.listGroups();
    assert.deepEqual(groups, [
      { id: GROUP, name: 'Warm Up Group' },
      { id: '120363111111111111@g.us', name: 'Other' },
    ]);

    const config = baileys.sockets[0].config;
    assert.equal((await config.cachedGroupMetadata(GROUP)).subject, 'Warm Up Group');

    baileys.sockets[0].fire('group-participants.update', { id: GROUP, participants: [], action: 'add' });
    assert.equal(await config.cachedGroupMetadata(GROUP), undefined);
  } finally {
    await cleanup();
  }
});

test('destroy ends the socket, saves pending credentials and prevents reconnects', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    const socket = baileys.sockets[0];
    socket.fire('creds.update', {});
    await client.destroy();
    assert.equal(socket.ended, true);
    assert.equal(baileys.credsSaves(), 1);

    socket.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    await tick();
    assert.equal(baileys.sockets.length, 1);
  } finally {
    await cleanup();
  }
});

test('groupMembers reports phone numbers from phone jids and from @lid participants with phoneNumber', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    const sock = baileys.sockets[0];
    sock.fire('connection.update', { connection: 'open' });
    sock.participants = [
      { id: '573001112233@s.whatsapp.net', lid: '1111@lid', admin: 'admin' },
      { id: '2222@lid', phoneNumber: '573004445566@s.whatsapp.net' },
      { id: '3333:5@lid' },
    ];
    const members = await client.groupMembers(GROUP);
    assert.deepEqual(members.phones, ['573001112233', '573004445566']);
    assert.deepEqual(members.lids, ['1111', '2222', '3333']);
    assert.deepEqual(await client.groupParticipants(GROUP), ['573001112233', '573004445566']);
  } finally {
    await cleanup();
  }
});

test('addToGroup sends phone jids with action add and returns the status of each participant', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    const sock = baileys.sockets[0];
    sock.fire('connection.update', { connection: 'open' });
    sock.addResult = (jid) => (jid.startsWith('5730011') ? '403' : '200');
    const results = await client.addToGroup(GROUP, ['573001112222', '573003334444']);
    assert.deepEqual(sock.groupCalls.at(-1), [
      'update', GROUP, ['573001112222@s.whatsapp.net', '573003334444@s.whatsapp.net'], 'add',
    ]);
    assert.deepEqual(results.map((r) => r.status), ['403', '200']);
  } finally {
    await cleanup();
  }
});

test('inviteCode and joinByInvite wrap the invite-link calls', async () => {
  const { baileys, client, cleanup } = setup();
  try {
    await client.connect();
    const sock = baileys.sockets[0];
    sock.fire('connection.update', { connection: 'open' });
    assert.equal(await client.inviteCode(GROUP), 'INVITECODE');
    assert.equal(await client.joinByInvite('INVITECODE'), GROUP);
    assert.deepEqual(sock.groupCalls, [['invite', GROUP], ['accept', 'INVITECODE']]);
    sock.joinError = new Error('forbidden');
    await assert.rejects(client.joinByInvite('X'), /forbidden/);
  } finally {
    await cleanup();
  }
});

test('info exposes the own lid when the account has one', async () => {
  const { baileys, client, cleanup } = setup({
    baileys: { me: { id: '573001112233:7@s.whatsapp.net', lid: '9988776:7@lid', name: 'T' } },
  });
  try {
    await client.connect();
    baileys.sockets[0].fire('connection.update', { connection: 'open' });
    assert.equal(client.info.wid.user, '573001112233');
    assert.equal(client.info.wid.lid, '9988776');
  } finally {
    await cleanup();
  }
});
