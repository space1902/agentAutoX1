import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VOICE_POOL,
  assignVoices,
  audioSettings,
  cleanForSpeech,
  estimateSpeechSeconds,
  shouldSendAudio,
} from './voice.js';

const POOL = ['v-a', 'v-b', 'v-c', 'v-d', 'v-e'];

test('assignVoices gives each session a distinct voice while the pool lasts', () => {
  const ids = ['tester1', 'tester2', 'tester3', 'tester4', 'tester5'];
  const result = assignVoices(ids, POOL);
  assert.deepEqual(Object.keys(result), ids);
  assert.equal(new Set(Object.values(result)).size, ids.length);
  for (const voice of Object.values(result)) assert.ok(POOL.includes(voice));
});

test('assignVoices is deterministic', () => {
  const ids = ['tester1', 'tester2', 'tester3'];
  assert.deepEqual(assignVoices(ids, POOL), assignVoices(ids, POOL));
});

test('assignVoices keeps a session on the same voice when others are added after it', () => {
  const first = assignVoices(['tester1'], POOL);
  const more = assignVoices(['tester1', 'tester2'], POOL);
  assert.equal(first.tester1, more.tester1);
});

test('assignVoices reuses voices only once the pool is exhausted', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const result = assignVoices(ids, POOL);
  assert.equal(new Set(Object.values(result)).size, POOL.length);
  assert.equal(Object.keys(result).length, ids.length);
});

test('assignVoices honors overrides and keeps others off those voices', () => {
  const ids = ['tester1', 'tester2', 'tester3'];
  const result = assignVoices(ids, POOL, { tester2: 'custom-voice' });
  assert.equal(result.tester2, 'custom-voice');
  assert.equal(new Set(Object.values(result)).size, 3);
  assert.ok(!['tester1', 'tester3'].some((id) => result[id] === 'custom-voice'));
});

test('assignVoices ignores blank overrides and tolerates an empty pool', () => {
  const result = assignVoices(['a'], POOL, { a: '  ' });
  assert.ok(POOL.includes(result.a));
  assert.deepEqual(assignVoices(['a'], []), { a: null });
});

test('default voice pool mixes genders across Latin American Spanish locales', () => {
  assert.ok(DEFAULT_VOICE_POOL.length >= 10);
  assert.equal(new Set(DEFAULT_VOICE_POOL).size, DEFAULT_VOICE_POOL.length);
  assert.ok(DEFAULT_VOICE_POOL.every((name) => /^es-[A-Z]{2}-\w+Neural$/.test(name)));
  assert.ok(DEFAULT_VOICE_POOL.every((name) => !name.startsWith('es-ES')));
});

test('shouldSendAudio follows the chance with an injected rng', () => {
  assert.equal(shouldSendAudio(0.1, () => 0.05), true);
  assert.equal(shouldSendAudio(0.1, () => 0.5), false);
  assert.equal(shouldSendAudio(0.1, () => 0.1), false);
});

test('shouldSendAudio handles the edges', () => {
  assert.equal(shouldSendAudio(0, () => 0), false);
  assert.equal(shouldSendAudio(-1, () => 0), false);
  assert.equal(shouldSendAudio(1, () => 0.999), true);
  assert.equal(shouldSendAudio(2, () => 0.999), true);
  assert.equal(shouldSendAudio(NaN, () => 0), false);
  assert.equal(shouldSendAudio(undefined, () => 0), false);
});

test('cleanForSpeech strips emojis', () => {
  assert.equal(cleanForSpeech('Hola 😀 qué tal 👍🏽 ❤️'), 'Hola qué tal');
});

test('cleanForSpeech strips URLs', () => {
  assert.equal(cleanForSpeech('mira https://example.com/a?b=1 esto'), 'mira esto');
  assert.equal(cleanForSpeech('entra a www.ejemplo.co ya'), 'entra a ya');
});

test('cleanForSpeech strips markdown symbols but keeps the words', () => {
  assert.equal(cleanForSpeech('**Hola** _amigo_ `code` ~~no~~'), 'Hola amigo code no');
  assert.equal(cleanForSpeech('# Titulo\n- uno\n- dos'), 'Titulo uno dos');
});

test('cleanForSpeech collapses whitespace and keeps punctuation and accents', () => {
  assert.equal(cleanForSpeech('  ¿Cómo   vas?\n\n  Bien,  gracias. '), '¿Cómo vas? Bien, gracias.');
});

test('cleanForSpeech returns an empty string for nothing speakable', () => {
  assert.equal(cleanForSpeech('😀😀 https://x.co'), '');
  assert.equal(cleanForSpeech(null), '');
});

test('audioSettings applies defaults when the config has no audio block', () => {
  const settings = audioSettings({}, 'tester1');
  assert.equal(settings.enabled, true);
  assert.equal(settings.chance, 0.12);
  assert.equal(settings.voice, null);
});

test('audioSettings reads global chance and voice overrides', () => {
  const config = { audio: { enabled: true, chance: 0.3, voices: { tester2: 'es-MX-JorgeNeural' } } };
  assert.equal(audioSettings(config, 'tester1').chance, 0.3);
  assert.equal(audioSettings(config, 'tester1').voice, null);
  assert.equal(audioSettings(config, 'tester2').voice, 'es-MX-JorgeNeural');
});

test('audioSettings lets a tester entry override the chance', () => {
  const config = {
    audio: { chance: 0.12 },
    testers: ['tester1', { id: 'tester2', audioChance: 0.5 }, { id: 'tester3' }],
  };
  assert.equal(audioSettings(config, 'tester1').chance, 0.12);
  assert.equal(audioSettings(config, 'tester2').chance, 0.5);
  assert.equal(audioSettings(config, 'tester3').chance, 0.12);
});

test('audioSettings clamps chances and ignores invalid values', () => {
  const config = { audio: { chance: 7 }, testers: [{ id: 'a', audioChance: -2 }, { id: 'b', audioChance: 'x' }] };
  assert.equal(audioSettings(config, 'zzz').chance, 1);
  assert.equal(audioSettings(config, 'a').chance, 0);
  assert.equal(audioSettings(config, 'b').chance, 1);
});

test('audioSettings reports chance 0 when audio is disabled', () => {
  const config = { audio: { enabled: false, chance: 0.5 }, testers: [{ id: 'a', audioChance: 0.9 }] };
  const settings = audioSettings(config, 'a');
  assert.equal(settings.enabled, false);
  assert.equal(settings.chance, 0);
});

test('estimateSpeechSeconds scales with word count and stays within bounds', () => {
  assert.ok(estimateSpeechSeconds('hola') >= 1);
  assert.ok(estimateSpeechSeconds('una dos tres cuatro cinco seis siete ocho nueve diez') > estimateSpeechSeconds('hola amigo'));
  assert.ok(estimateSpeechSeconds('palabra '.repeat(500)) <= 90);
});
