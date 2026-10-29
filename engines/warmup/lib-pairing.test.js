import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startClient, stopAllClients } from './lib.js';

class FakeClient extends EventEmitter {
  constructor(options, script) {
    super();
    this.options = options;
    this.phone = options.phone;
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

function authRoot({ session = null, backup = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-'));
  const creds = (dir, meId) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ me: { id: meId } }));
  };
  if (session) creds(path.join(root, session.id), session.meId);
  if (backup) creds(path.join(root, '_logged_out', `${backup.id}-2026-10-29T13-38-53`), backup.meId);
  return root;
}

async function captured(fn) {
  const lines = { log: [], warn: [], error: [] };
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(lines)) console[level] = (...args) => lines[level].push(args.join(' '));
  try {
    return { result: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    Object.assign(console, originals);
    await stopAllClients();
  }
}

const makeFactory = (script) => {
  const created = [];
  const clientFactory = (options) => {
    const client = new FakeClient(options, script);
    created.push(client);
    return client;
  };
  return { created, clientFactory };
};

const noopPersist = () => ({ status: 'saved' });

test('a tester with no phone anywhere is skipped with a clear error and never shows a QR', async () => {
  const root = authRoot();
  const { created, clientFactory } = makeFactory((c) => c.emit('qr', 'QR-DATA'));

  const { error, lines } = await captured(() =>
    startClient('tester9', { authRoot: root, clientFactory, config: { testers: ['tester9'] }, persistPhone: noopPersist }),
  );

  assert.equal(error.code, 'NO_PHONE');
  assert.equal(created.length, 0);
  assert.deepEqual(lines.error, ['[tester9] needs a phone number to link by code: set it in the app (Editar instancia / Números)']);
  assert.equal(lines.log.some((line) => /Scan this QR/.test(line)), false);
});

test('the phone comes from a logged-out backup, the client is built for pairing codes and the phone is persisted', async () => {
  const root = authRoot({ backup: { id: 'tester1', meId: '573162135114:12@s.whatsapp.net' } });
  const { created, clientFactory } = makeFactory((c) => {
    c.emit('pairing_code', 'ABCD-1234');
    c.emit('ready');
  });
  const saved = [];

  const { result, lines } = await captured(() =>
    startClient('tester1', {
      authRoot: root,
      clientFactory,
      config: { testers: ['tester1'] },
      persistPhone: (args) => {
        saved.push(args);
        return { status: 'saved' };
      },
    }),
  );

  assert.equal(result, created[0]);
  assert.equal(created[0].options.phone, '573162135114');
  assert.equal(created[0].options.qrFallback, false);
  assert.deepEqual(saved.map(({ id, phone }) => ({ id, phone })), [{ id: 'tester1', phone: '573162135114' }]);
  assert.ok(lines.log.includes('\n[tester1] Pairing code: ABCD-1234'));
  assert.ok(lines.log.some((line) => line.startsWith('On the phone for "tester1" (+573162135114)')));
});

test('a phone that already lives in config.json is not persisted again', async () => {
  const root = authRoot();
  const { clientFactory } = makeFactory((c) => c.emit('ready'));
  let calls = 0;

  await captured(() =>
    startClient('tester1', {
      authRoot: root,
      clientFactory,
      config: { testers: [{ id: 'tester1', phone: '3162135114' }] },
      persistPhone: () => {
        calls++;
        return { status: 'saved' };
      },
    }),
  );

  assert.equal(calls, 0);
});

test('an expired pairing code is replaced by a new one, with a log line, until the session is linked', async () => {
  const root = authRoot();
  const { clientFactory } = makeFactory((c) => {
    c.emit('pairing_code', 'AAAA-1111');
    c.emit('pairing_code', 'BBBB-2222');
    c.emit('ready');
  });

  const { result, lines } = await captured(() =>
    startClient('tester1', { authRoot: root, clientFactory, config: { testers: [{ id: 'tester1', phone: '3162135114' }] } }),
  );

  assert.ok(result);
  assert.ok(lines.log.includes('\n[tester1] Pairing code: AAAA-1111'));
  assert.ok(lines.log.includes('\n[tester1] Pairing code: BBBB-2222'));
  assert.ok(lines.log.some((line) => line === '[tester1] Pairing code expired; requested a new one (2/5)'));
});

test('it gives up after the maximum number of codes without the user entering one', async () => {
  const root = authRoot();
  const { created, clientFactory } = makeFactory((c) => {
    for (const code of ['A', 'B', 'C', 'D']) c.emit('pairing_code', `${code}${code}${code}${code}-1111`);
  });

  const { error, lines } = await captured(() =>
    startClient('tester1', {
      authRoot: root,
      clientFactory,
      config: { testers: [{ id: 'tester1', phone: '3162135114' }] },
      maxPairingAttempts: 3,
    }),
  );

  assert.match(error.message, /\[tester1\] pairing code expired 3 times/);
  assert.equal(error.code, 'PAIRING_EXPIRED');
  assert.equal(created[0].destroyed, true);
  assert.equal(lines.log.some((line) => line.includes('DDDD-1111')), false);
});

test('failed code requests count as attempts and are logged, without ever falling back to a QR', async () => {
  const root = authRoot();
  const { clientFactory } = makeFactory((c) => {
    c.emit('pairing_failed', new Error('rate limited'));
    c.emit('pairing_code', 'AAAA-1111');
    c.emit('ready');
  });

  const { result, lines } = await captured(() =>
    startClient('tester1', { authRoot: root, clientFactory, config: { testers: [{ id: 'tester1', phone: '3162135114' }] } }),
  );

  assert.ok(result);
  assert.ok(lines.warn.some((line) => line.startsWith('[tester1] could not get a pairing code (rate limited)')));
});

test('LINK_MODE=qr brings the terminal QR back as an explicit escape hatch', async () => {
  const root = authRoot();
  const { created, clientFactory } = makeFactory((c) => {
    c.emit('qr', 'QR-DATA');
    c.emit('ready');
  });

  const { result, lines } = await captured(() =>
    startClient('tester9', { authRoot: root, clientFactory, config: { testers: ['tester9'] }, linkMode: 'qr' }),
  );

  assert.ok(result);
  assert.equal(created[0].options.qrFallback, true);
  assert.ok(lines.log.some((line) => /\[tester9\] Scan this QR/.test(line)));
});

test('the app can pass a phone for a session that has none anywhere else', async () => {
  const root = authRoot();
  const { created, clientFactory } = makeFactory((c) => c.emit('ready'));

  await captured(() =>
    startClient('tester3', {
      authRoot: root,
      clientFactory,
      config: { testers: ['tester3'] },
      hints: { tester3: '3003334444' },
      persistPhone: noopPersist,
    }),
  );

  assert.equal(created[0].options.phone, '573003334444');
});

test('an already linked session starts without needing any phone', async () => {
  const root = authRoot({ session: { id: 'tester5', meId: '573005550000:3@s.whatsapp.net' } });
  const { created, clientFactory } = makeFactory((c) => c.emit('ready'));
  let persisted = 0;

  const { result } = await captured(() =>
    startClient('tester5', {
      authRoot: root,
      clientFactory,
      config: { testers: ['tester5'] },
      persistPhone: () => {
        persisted++;
        return { status: 'saved' };
      },
    }),
  );

  assert.ok(result);
  assert.equal(created[0].options.phone, '573005550000');
  assert.equal(persisted, 0, 'no config write when nothing needs linking');
});
