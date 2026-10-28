import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VOICE_MIMETYPE,
  classifyDisconnect,
  createRecentMap,
  fakeWaveform,
  isGroupJid,
  jidDigits,
  normalizeMessage,
  reconnectDelayMs,
  resolveSessionPhone,
  resolveSessionProxy,
  toJid,
  voiceNoteContent,
  lidDigits,
} from './wa-messages.js';

const GROUP = '120363000000000000@g.us';

const rawGroupText = (overrides = {}) => ({
  key: {
    remoteJid: GROUP,
    fromMe: false,
    id: 'MSG1',
    participant: '573001112233@s.whatsapp.net',
  },
  pushName: 'Ana',
  messageTimestamp: 1_700_000_000,
  message: { conversation: 'hola grupo' },
  ...overrides,
});

test('toJid builds user JIDs from phone numbers and keeps existing JIDs', () => {
  assert.equal(toJid('+57 300 111 2233'), '573001112233@s.whatsapp.net');
  assert.equal(toJid(GROUP), GROUP);
  assert.equal(toJid(''), '');
  assert.equal(toJid(null), '');
});

test('isGroupJid recognises group chats only', () => {
  assert.equal(isGroupJid(GROUP), true);
  assert.equal(isGroupJid('573001112233@s.whatsapp.net'), false);
  assert.equal(isGroupJid(undefined), false);
});

test('jidDigits returns the phone number of a phone JID and ignores device suffixes', () => {
  assert.equal(jidDigits('573001112233@s.whatsapp.net'), '573001112233');
  assert.equal(jidDigits('573001112233:12@s.whatsapp.net'), '573001112233');
  assert.equal(jidDigits('98765432100@lid'), '');
  assert.equal(jidDigits(GROUP), '');
  assert.equal(jidDigits(undefined), '');
});

test('normalizeMessage maps a group text message to the shape the bots use', () => {
  const msg = normalizeMessage(rawGroupText());
  assert.deepEqual(msg, {
    id: { id: 'MSG1' },
    from: GROUP,
    author: '573001112233',
    pushName: 'Ana',
    fromMe: false,
    body: 'hola grupo',
    type: 'chat',
    hasMedia: false,
    timestamp: 1_700_000_000,
  });
});

test('normalizeMessage reads extended text, captions and unwraps ephemeral messages', () => {
  assert.equal(
    normalizeMessage(rawGroupText({ message: { extendedTextMessage: { text: 'con enlace' } } })).body,
    'con enlace',
  );

  const image = normalizeMessage(
    rawGroupText({ message: { imageMessage: { caption: 'foto', mimetype: 'image/png' } } }),
  );
  assert.equal(image.body, 'foto');
  assert.equal(image.type, 'image');
  assert.equal(image.hasMedia, true);

  const wrapped = normalizeMessage(
    rawGroupText({ message: { ephemeralMessage: { message: { conversation: 'efimero' } } } }),
  );
  assert.equal(wrapped.body, 'efimero');
  assert.equal(wrapped.type, 'chat');
});

test('normalizeMessage tells voice notes from other audio', () => {
  const ptt = normalizeMessage(rawGroupText({ message: { audioMessage: { ptt: true } } }));
  assert.equal(ptt.type, 'ptt');
  assert.equal(ptt.body, '');
  assert.equal(ptt.hasMedia, true);

  const audio = normalizeMessage(rawGroupText({ message: { audioMessage: { ptt: false } } }));
  assert.equal(audio.type, 'audio');
});

test('normalizeMessage prefers the phone number over a LID participant', () => {
  const lid = normalizeMessage(
    rawGroupText({
      key: {
        remoteJid: GROUP,
        fromMe: false,
        id: 'M2',
        participant: '98765432100@lid',
        participantAlt: '573009998877@s.whatsapp.net',
      },
    }),
  );
  assert.equal(lid.author, '573009998877');

  const onlyLid = normalizeMessage(
    rawGroupText({
      key: { remoteJid: GROUP, fromMe: false, id: 'M3', participant: '98765432100@lid' },
    }),
  );
  assert.equal(onlyLid.author, '');
});

test('normalizeMessage handles Long-like timestamps and own messages in private chats', () => {
  const msg = normalizeMessage(
    rawGroupText({
      key: { remoteJid: '573001112233@s.whatsapp.net', fromMe: true, id: 'M4' },
      messageTimestamp: { toNumber: () => 1_700_000_123 },
    }),
  );
  assert.equal(msg.timestamp, 1_700_000_123);
  assert.equal(msg.fromMe, true);
  assert.equal(msg.author, '');
  assert.equal(msg.from, '573001112233@s.whatsapp.net');
});

test('normalizeMessage drops protocol and empty envelopes', () => {
  assert.equal(normalizeMessage(null), null);
  assert.equal(normalizeMessage(rawGroupText({ message: undefined })), null);
  assert.equal(
    normalizeMessage(rawGroupText({ message: { protocolMessage: { type: 0 } } })),
    null,
  );
  assert.equal(
    normalizeMessage(rawGroupText({ message: { senderKeyDistributionMessage: {} } })),
    null,
  );
});

test('normalizeMessage keeps unknown content as an empty "other" message', () => {
  const msg = normalizeMessage(rawGroupText({ message: { reactionMessage: { text: '+1' } } }));
  assert.equal(msg.type, 'other');
  assert.equal(msg.body, '');
});

test('voiceNoteContent sends OGG/Opus as push-to-talk with a waveform', () => {
  const buffer = Buffer.from('ogg-bytes');
  const content = voiceNoteContent(buffer);
  assert.equal(content.audio, buffer);
  assert.equal(content.mimetype, VOICE_MIMETYPE);
  assert.equal(content.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(content.ptt, true);
  assert.equal(content.waveform.length, 64);
});

test('voiceNoteContent copies typed arrays into a Buffer', () => {
  const content = voiceNoteContent(new Uint8Array([1, 2, 3]));
  assert.ok(Buffer.isBuffer(content.audio));
  assert.deepEqual([...content.audio], [1, 2, 3]);
});

test('fakeWaveform stays inside the 0-100 range and is smooth', () => {
  let n = 0;
  const rng = () => ((n++ * 37) % 100) / 100;
  const wave = fakeWaveform(rng);
  assert.equal(wave.length, 64);
  for (const value of wave) assert.ok(value >= 0 && value <= 100);
  const maxStep = Math.max(...wave.slice(1).map((v, i) => Math.abs(v - wave[i])));
  assert.ok(maxStep <= 35, `waveform jumps by ${maxStep}`);
});

test('classifyDisconnect separates logout, conflicts, restarts and retries', () => {
  assert.equal(classifyDisconnect(401), 'logged-out');
  assert.equal(classifyDisconnect(440), 'replaced');
  assert.equal(classifyDisconnect(515), 'restart');
  assert.equal(classifyDisconnect(403), 'fatal');
  assert.equal(classifyDisconnect(500), 'fatal');
  assert.equal(classifyDisconnect(428), 'retry');
  assert.equal(classifyDisconnect(408), 'retry');
  assert.equal(classifyDisconnect(undefined), 'retry');
});

test('reconnectDelayMs grows exponentially up to a cap', () => {
  assert.equal(reconnectDelayMs(0), 1000);
  assert.equal(reconnectDelayMs(1), 2000);
  assert.equal(reconnectDelayMs(3), 8000);
  assert.equal(reconnectDelayMs(10), 30_000);
  assert.equal(reconnectDelayMs(-5), 1000);
});

test('resolveSessionProxy reads the proxy of the bot or of a tester entry', () => {
  const config = {
    bot: { sessionId: 'bot', proxy: ' http://user:pw@host:8080 ' },
    testers: ['tester1', { id: 'tester2', proxy: 'socks5://h:1080' }, { id: 'tester3' }],
  };
  assert.equal(resolveSessionProxy(config, 'bot'), 'http://user:pw@host:8080');
  assert.equal(resolveSessionProxy(config, 'tester2'), 'socks5://h:1080');
  assert.equal(resolveSessionProxy(config, 'tester1'), null);
  assert.equal(resolveSessionProxy(config, 'tester3'), null);
  assert.equal(resolveSessionProxy(config, 'unknown'), null);
  assert.equal(resolveSessionProxy({}, 'bot'), null);
  assert.equal(resolveSessionProxy(null, 'bot'), null);
});

test('resolveSessionProxy uses the default bot session id when none is configured', () => {
  assert.equal(resolveSessionProxy({ bot: { proxy: 'http://h:1' } }, 'bot'), 'http://h:1');
});

test('resolveSessionPhone reads the number of the bot or of a tester entry, digits only', () => {
  const config = {
    botNumber: '573167585233',
    bot: { sessionId: 'bot' },
    testers: ['tester1', { id: 'tester2', phone: '+57 300-123 4567' }, { id: 'tester3' }, { id: 'tester4', phone: '123' }],
  };
  assert.equal(resolveSessionPhone(config, 'bot'), '573167585233');
  assert.equal(resolveSessionPhone({ ...config, bot: { phone: '+52 55 1234 5678' } }, 'bot'), '525512345678');
  assert.equal(resolveSessionPhone(config, 'tester2'), '573001234567');
  assert.equal(resolveSessionPhone(config, 'tester1'), null);
  assert.equal(resolveSessionPhone(config, 'tester3'), null);
  assert.equal(resolveSessionPhone(config, 'tester4'), null);
  assert.equal(resolveSessionPhone(config, 'unknown'), null);
  assert.equal(resolveSessionPhone({}, 'bot'), null);
  assert.equal(resolveSessionPhone(null, 'bot'), null);
  assert.equal(resolveSessionPhone({ botNumber: 573167585233 }, 'bot'), '573167585233');
});

test('createRecentMap is bounded and evicts the oldest entries first', () => {
  const map = createRecentMap(2);
  map.set('a', 1);
  map.set('b', 2);
  map.set('c', 3);
  assert.equal(map.get('a'), undefined);
  assert.equal(map.get('b'), 2);
  assert.equal(map.get('c'), 3);
  assert.equal(map.size(), 2);
});

test('lidDigits extracts the number of an @lid jid and ignores phone jids and groups', () => {
  assert.equal(lidDigits('2087654321:12@lid'), '2087654321');
  assert.equal(lidDigits('2087654321@lid'), '2087654321');
  assert.equal(lidDigits('573001112233@s.whatsapp.net'), '');
  assert.equal(lidDigits('120363000@g.us'), '');
  assert.equal(lidDigits(undefined), '');
});
