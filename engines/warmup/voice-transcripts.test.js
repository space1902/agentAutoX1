import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTranscriptRegistry,
  formatVoiceLine,
  isVoiceMessage,
  waitForVoiceTranscript,
} from './voice-transcripts.js';

test('registry stores and returns transcripts by inner id', () => {
  const registry = createTranscriptRegistry();
  registry.remember('ABC', 'hola a todos');
  assert.equal(registry.lookup('ABC'), 'hola a todos');
  assert.equal(registry.lookup('missing'), undefined);
});

test('registry ignores empty ids and empty text', () => {
  const registry = createTranscriptRegistry();
  registry.remember('', 'x');
  registry.remember(null, 'x');
  registry.remember('A', '   ');
  assert.equal(registry.size(), 0);
});

test('registry is bounded and evicts the oldest entries first', () => {
  const registry = createTranscriptRegistry(3);
  for (const id of ['a', 'b', 'c', 'd']) registry.remember(id, `t-${id}`);
  assert.equal(registry.size(), 3);
  assert.equal(registry.lookup('a'), undefined);
  assert.equal(registry.lookup('d'), 't-d');
});

test('re-remembering an id refreshes its position', () => {
  const registry = createTranscriptRegistry(2);
  registry.remember('a', '1');
  registry.remember('b', '2');
  registry.remember('a', '1b');
  registry.remember('c', '3');
  assert.equal(registry.lookup('a'), '1b');
  assert.equal(registry.lookup('b'), undefined);
});

test('waitForVoiceTranscript returns immediately when already registered', async () => {
  const registry = createTranscriptRegistry();
  registry.remember('A', 'listo');
  assert.equal(await waitForVoiceTranscript('A', { registry, timeoutMs: 50, intervalMs: 5 }), 'listo');
});

test('waitForVoiceTranscript picks up a transcript registered while polling', async () => {
  const registry = createTranscriptRegistry();
  setTimeout(() => registry.remember('A', 'tarde'), 30);
  assert.equal(await waitForVoiceTranscript('A', { registry, timeoutMs: 500, intervalMs: 5 }), 'tarde');
});

test('waitForVoiceTranscript gives up with null after the timeout', async () => {
  const registry = createTranscriptRegistry();
  const started = Date.now();
  assert.equal(await waitForVoiceTranscript('A', { registry, timeoutMs: 40, intervalMs: 5 }), null);
  assert.ok(Date.now() - started >= 35);
});

test('formatVoiceLine includes the transcript when known', () => {
  assert.equal(formatVoiceLine('hola'), '[voice note] hola');
  assert.equal(formatVoiceLine(null), '[voice note]');
  assert.equal(formatVoiceLine('  '), '[voice note]');
});

test('isVoiceMessage detects ptt and audio only', () => {
  assert.equal(isVoiceMessage({ type: 'ptt' }), true);
  assert.equal(isVoiceMessage({ type: 'audio' }), true);
  assert.equal(isVoiceMessage({ type: 'chat' }), false);
  assert.equal(isVoiceMessage({ type: 'image' }), false);
  assert.equal(isVoiceMessage(null), false);
});
