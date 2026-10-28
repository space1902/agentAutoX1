import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanMessage,
  generateLocal,
  generateUsableMessage,
  isUsableMessage,
  resolveLocalModel,
} from './local-model.js';

test('resolveLocalModel applies defaults and config overrides', () => {
  assert.deepEqual(resolveLocalModel({}), {
    url: 'http://localhost:11434',
    model: 'qwen2.5:7b',
  });
  assert.deepEqual(
    resolveLocalModel({ localModel: { model: 'llama3.1:8b', url: 'http://pc:11434' } }),
    { url: 'http://pc:11434', model: 'llama3.1:8b' },
  );
});

test('cleanMessage trims and strips wrapping quotes', () => {
  assert.equal(cleanMessage('  "hola a todos"  '), 'hola a todos');
  assert.equal(cleanMessage(undefined), '');
});

test('isUsableMessage rejects empty text and tester ids', () => {
  assert.equal(isUsableMessage('¿Ustedes qué opinan?'), true);
  assert.equal(isUsableMessage(''), false);
  assert.equal(isUsableMessage('¿Y vos, tester12, qué piensas?'), false);
  assert.equal(isUsableMessage('Hola Tester3'), false);
});

test('isUsableMessage rejects Spain-only forms', () => {
  assert.equal(isUsableMessage('¿Y vosotros qué hicisteis?'), false);
  assert.equal(isUsableMessage('Chicas, ¿vosotras vais?'), false);
  assert.equal(isUsableMessage('¿Qué os pareció el partido?'), false);
  assert.equal(isUsableMessage('Los osos del zoológico son lindos'), true);
});

test('generateLocal posts to Ollama and returns the cleaned message', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        message: { content: '"Qué rico ese caldo"' },
        prompt_eval_count: 300,
        eval_count: 12,
      }),
    };
  };

  const result = await generateLocal({
    url: 'http://localhost:11434',
    model: 'qwen2.5:7b',
    system: 'sys',
    prompt: 'write',
    maxTokens: 120,
    fetchImpl,
  });

  assert.equal(request.url, 'http://localhost:11434/api/chat');
  assert.equal(request.body.model, 'qwen2.5:7b');
  assert.equal(request.body.stream, false);
  assert.equal(request.body.options.num_predict, 120);
  assert.deepEqual(request.body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'write' },
  ]);
  assert.equal(result, 'Qué rico ese caldo');
});

test('generateLocal throws on a non-OK response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'model not found' });
  await assert.rejects(
    generateLocal({ url: 'http://x', model: 'm', system: 's', prompt: 'p', fetchImpl }),
    /Ollama 404/,
  );
});

test('generateUsableMessage returns the first usable local message', async () => {
  const outputs = ['Hola tester4', 'Qué buena serie'];
  const text = await generateUsableMessage({
    generate: async () => outputs.shift(),
    warn: () => {},
  });
  assert.equal(text, 'Qué buena serie');
});

test('generateUsableMessage returns null after two failed attempts', async () => {
  const warnings = [];
  let calls = 0;
  const text = await generateUsableMessage({
    generate: async () => {
      calls++;
      throw new Error('connect ECONNREFUSED');
    },
    warn: (message) => warnings.push(message),
  });
  assert.equal(text, null);
  assert.equal(calls, 2);
  assert.equal(warnings.length, 2);
});
