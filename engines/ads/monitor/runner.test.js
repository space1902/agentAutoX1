import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createStore as createAdsStore } from '../store.js';
import { createStore as createMonitorStore } from './store.js';
import { authDirOf, flushOutbox, maskPhones, readWaStatus } from './runner.js';

test('maskPhones hides long digit runs but keeps ordinary numbers', () => {
  assert.equal(maskPhones('Enviado a 573167585233 ok'), 'Enviado a ••••5233 ok');
  assert.equal(maskPhones('+57 300 123 4567 y 573001234567@s.whatsapp.net'), '+57 300 123 4567 y ••••4567@s.whatsapp.net');
  assert.equal(maskPhones('gasto 15000 en 4 días, 12.500'), 'gasto 15000 en 4 días, 12.500');
});

test('flushOutbox sends queued texts in order and marks them sent', async () => {
  const store = createAdsStore();
  store.enqueueWhatsapp('uno', 'decision', 1);
  store.enqueueWhatsapp('dos', 'decision', 2);
  const sent = [];
  const out = await flushOutbox({ adsStore: store, send: async (t) => { sent.push(t); }, now: () => 99, log: () => {} });
  assert.deepEqual(sent, ['uno', 'dos']);
  assert.equal(out.sent, 2);
  assert.equal(store.pendingWhatsapp().length, 0);
});

test('flushOutbox stops at the first failure and keeps the rest for the next round', async () => {
  const store = createAdsStore();
  ['a', 'b', 'c'].forEach((t, i) => store.enqueueWhatsapp(t, 'decision', i));
  let calls = 0;
  const out = await flushOutbox({
    adsStore: store, now: () => 1, log: () => {},
    send: async () => { calls++; if (calls === 2) throw new Error('not connected'); },
  });
  assert.equal(out.sent, 1);
  assert.equal(out.failed, true);
  assert.deepEqual(store.pendingWhatsapp().map((r) => r.text), ['b', 'c']);
});

test('readWaStatus reads only the linked state and a masked number from creds.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-wa-'));
  assert.deepEqual(readWaStatus(dir), { linked: false, phoneMasked: '' });
  fs.mkdirSync(authDirOf(dir), { recursive: true });
  fs.writeFileSync(path.join(authDirOf(dir), 'creds.json'), JSON.stringify({ me: { id: '573001234567:12@s.whatsapp.net', name: 'Secreto' }, noiseKey: 'x' }));
  const status = readWaStatus(dir);
  assert.deepEqual(status, { linked: true, phoneMasked: '••••4567' });
  assert.equal(JSON.stringify(status).includes('Secreto'), false);
  fs.writeFileSync(path.join(authDirOf(dir), 'creds.json'), '{broken');
  assert.deepEqual(readWaStatus(dir), { linked: false, phoneMasked: '' });
});

test('the monitor store lists recent alerts newest first', () => {
  const store = createMonitorStore(':memory:');
  store.logAlert({ ts: 1, family: 'a', severity: 1, type: 'ad_no_sale', text: 'uno', sent: true });
  store.logAlert({ ts: 2, family: 'b', severity: 2, type: 'frequency', text: 'dos', sent: false });
  const [first, second] = store.recentAlerts(10);
  assert.equal(first.text, 'dos');
  assert.equal(first.sent, false);
  assert.equal(second.type, 'ad_no_sale');
});
