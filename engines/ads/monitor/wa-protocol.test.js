import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJid, jidDigits, classifyDisconnect, reconnectDelayMs, normalizeIncoming, isFromAllowed } from './wa-protocol.js';

test('toJid and jidDigits', () => {
  assert.equal(toJid('573001234567'), '573001234567@s.whatsapp.net');
  assert.equal(toJid('+57 300 123 4567'), '573001234567@s.whatsapp.net');
  assert.equal(toJid(''), '');
  assert.equal(jidDigits('573001234567:12@s.whatsapp.net'), '573001234567');
  assert.equal(jidDigits('999@lid'), '');
});

test('classifyDisconnect and reconnect delay', () => {
  assert.equal(classifyDisconnect(401), 'logged-out');
  assert.equal(classifyDisconnect(515), 'restart');
  assert.equal(classifyDisconnect(440), 'replaced');
  assert.equal(classifyDisconnect(undefined), 'retry');
  assert.equal(reconnectDelayMs(0), 1000);
  assert.equal(reconnectDelayMs(10), 30000);
});

const raw = (over = {}) => ({
  key: { remoteJid: '573001234567@s.whatsapp.net', fromMe: false, id: 'M1' },
  message: { conversation: 'SI 12' },
  ...over,
});

test('normalizeIncoming extracts plain and extended text from 1:1 chats', () => {
  assert.deepEqual(normalizeIncoming(raw()), { id: 'M1', senderDigits: '573001234567', text: 'SI 12', fromMe: false, isGroup: false });
  const ext = normalizeIncoming(raw({ message: { extendedTextMessage: { text: 'estado' } } }));
  assert.equal(ext.text, 'estado');
});

test('normalizeIncoming resolves LID chats through the alternate phone JID', () => {
  const n = normalizeIncoming(raw({ key: { remoteJid: '1234@lid', remoteJidAlt: '573001234567@s.whatsapp.net', fromMe: false, id: 'M2' } }));
  assert.equal(n.senderDigits, '573001234567');
});

test('normalizeIncoming flags groups and returns null for non-text envelopes', () => {
  assert.equal(normalizeIncoming(raw({ key: { remoteJid: '1@g.us', fromMe: false, id: 'M3' } })).isGroup, true);
  assert.equal(normalizeIncoming(raw({ message: { imageMessage: {} } })), null);
  assert.equal(normalizeIncoming({ key: { id: 'x' } }), null);
});

test('isFromAllowed accepts only the configured number', () => {
  assert.equal(isFromAllowed({ senderDigits: '573001234567', fromMe: false, isGroup: false }, '+57 300 123 4567'), true);
  assert.equal(isFromAllowed({ senderDigits: '573009999999', fromMe: false, isGroup: false }, '573001234567'), false);
  assert.equal(isFromAllowed({ senderDigits: '573001234567', fromMe: true, isGroup: false }, '573001234567'), false);
  assert.equal(isFromAllowed({ senderDigits: '573001234567', fromMe: false, isGroup: true }, '573001234567'), false);
  assert.equal(isFromAllowed({ senderDigits: '', fromMe: false, isGroup: false }, '573001234567'), false);
  assert.equal(isFromAllowed({ senderDigits: '573001234567', fromMe: false, isGroup: false }, 'PONER_NUMERO_DESTINO'), false);
  assert.equal(isFromAllowed({ senderDigits: '573001234567', fromMe: false, isGroup: false }, ''), false);
});
