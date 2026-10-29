import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BudgetStopError, MissingKeyError, createAi, resolveAiConfig } from './ai-provider.js';
import { generateUsableMessage } from './local-model.js';

const KEY = 'sk-test-SECRET-1234567890';
const NOON_UTC_THURSDAY = new Date('2026-10-29T12:00:00Z'); // off-peak for DeepSeek

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-provider-'));
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    const call = { url, headers: options.headers, body: JSON.parse(options.body) };
    calls.push(call);
    return handler(call, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const okChat = (content, usage = { prompt_tokens: 1400, completion_tokens: 70 }) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }], usage }),
});

const ollamaChat = (content) => ({ ok: true, json: async () => ({ message: { content } }) });

function make(ai, overrides = {}) {
  const logs = [];
  const fetchImpl = overrides.fetchImpl ?? fakeFetch(() => okChat('Qué buena serie'));
  const instance = createAi({
    config: { ai, localModel: overrides.localModel },
    env: 'env' in overrides ? overrides.env : { AGENTAUTO_AI_KEY: KEY },
    dataDir: overrides.dataDir ?? tempDir(),
    fetchImpl,
    log: (line) => logs.push(line),
    now: () => overrides.now ?? NOON_UTC_THURSDAY,
    onStop: overrides.onStop ?? (() => {}),
  });
  return { ai: instance, logs, fetchImpl };
}

test('without an ai key the engine behaves as before with localModel', () => {
  const resolved = resolveAiConfig({ localModel: { model: 'llama3.1:8b', url: 'http://pc:11434' } });
  assert.equal(resolved.provider, 'ollama');
  assert.equal(resolved.model, 'llama3.1:8b');
  assert.equal(resolved.baseUrl, 'http://pc:11434');
  assert.equal(resolveAiConfig({}).model, 'qwen2.5:7b');
});

test('ollama generation posts to /api/chat and records no spend', async () => {
  const dir = tempDir();
  const fetchImpl = fakeFetch(() => ollamaChat('"Hola a todos"'));
  const { ai } = make(undefined, { fetchImpl, dataDir: dir });
  const text = await ai.generate({ system: 's', prompt: 'p', maxTokens: 120 });
  assert.equal(text, 'Hola a todos');
  assert.equal(fetchImpl.calls[0].url, 'http://localhost:11434/api/chat');
  assert.equal(fs.existsSync(path.join(dir, 'ai-usage.json')), false);
});

test('ai.provider ollama uses its own model and falls back to localModel', () => {
  assert.equal(resolveAiConfig({ ai: { provider: 'ollama', model: 'gemma3:4b' }, localModel: { model: 'x' } }).model, 'gemma3:4b');
  assert.equal(resolveAiConfig({ ai: { provider: 'ollama' }, localModel: { model: 'x' } }).model, 'x');
});

test('openai-compatible preset fills base URL and prices', () => {
  const resolved = resolveAiConfig({ ai: { provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano' } });
  assert.equal(resolved.baseUrl, 'https://api.openai.com/v1');
  assert.equal(resolved.dailyBudgetUsd, 1);
  assert.equal(resolved.onBudgetExceeded, 'fallback-local');
  assert.equal(resolved.modelInfo.inUsd, 0.05);
  const custom = resolveAiConfig({
    ai: { provider: 'openai-compatible', preset: 'custom', baseUrl: 'https://x/v1', model: 'm', prices: { inUsd: 1, outUsd: 2 } },
  });
  assert.deepEqual([custom.modelInfo.inUsd, custom.modelInfo.outUsd], [1, 2]);
});

test('openai-compatible request carries the key header, short max_tokens and extras', async () => {
  const fetchImpl = fakeFetch(() => okChat(' "Qué rico" '));
  const { ai } = make({ provider: 'openai-compatible', preset: 'deepseek', model: 'deepseek-flash' }, { fetchImpl });
  const text = await ai.generate({ system: 'sys', prompt: 'user', maxTokens: 120 });
  assert.equal(text, 'Qué rico');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  assert.equal(call.body.max_tokens, 120);
  assert.equal(call.body.stream, false);
  assert.deepEqual(call.body.thinking, { type: 'disabled' });
  assert.deepEqual(call.body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user' },
  ]);
});

test('reasoning models send minimal effort and max_completion_tokens', async () => {
  const fetchImpl = fakeFetch(() => okChat('hola'));
  const { ai } = make({ provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano' }, { fetchImpl });
  await ai.generate({ system: 's', prompt: 'p', maxTokens: 120 });
  const body = fetchImpl.calls[0].body;
  assert.equal(body.reasoning_effort, 'minimal');
  assert.equal(body.max_completion_tokens, 120);
  assert.equal('max_tokens' in body, false);
  assert.equal('temperature' in body, false);
});

test('trailing slash in the base URL does not double up (Gemini)', async () => {
  const fetchImpl = fakeFetch(() => okChat('hola'));
  const { ai } = make({ provider: 'openai-compatible', preset: 'gemini', model: 'gemini-2.5-flash-lite' }, { fetchImpl });
  await ai.generate({ system: 's', prompt: 'p' });
  assert.equal(
    fetchImpl.calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  );
});

test('a missing key is a clear error that does not mention any secret', () => {
  assert.throws(
    () => make({ provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano' }, { env: {} }),
    MissingKeyError,
  );
  // Local OpenAI-compatible servers do not need one.
  assert.doesNotThrow(() =>
    make({ provider: 'openai-compatible', preset: 'local-openai', model: 'qwen', baseUrl: 'http://localhost:1234/v1' }, { env: {} }),
  );
});

test('usage is converted to dollars and persisted; estimates chars/4 when usage is missing', async () => {
  const dir = tempDir();
  const answers = [
    okChat('hola', { prompt_tokens: 1_000_000, completion_tokens: 0 }),
    { ok: true, json: async () => ({ choices: [{ message: { content: 'abcdefgh' } }] }) },
  ];
  const { ai } = make(
    { provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano', dailyBudgetUsd: 100 },
    { fetchImpl: fakeFetch(() => answers.shift()), dataDir: dir },
  );
  await ai.generate({ system: 'x'.repeat(40), prompt: 'y'.repeat(40) });
  await ai.generate({ system: 'x'.repeat(40), prompt: 'y'.repeat(40) });
  const day = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'ai-usage.json'), 'utf8')))[0];
  const entry = day['openai/gpt-5-nano'];
  assert.equal(entry.calls, 2);
  // 1M prompt tokens at $0.05 plus the estimated second call (80 chars in -> 20 tokens, 8 chars out -> 2).
  assert.equal(entry.promptTokens, 1_000_020);
  assert.equal(entry.completionTokens, 2);
  assert.ok(Math.abs(entry.usd - 0.05) < 1e-5);
});

test('DeepSeek is billed at the off-peak or the peak rate depending on the hour', async () => {
  const run = async (when) => {
    const dir = tempDir();
    const { ai } = make(
      { provider: 'openai-compatible', preset: 'deepseek', model: 'deepseek-flash', dailyBudgetUsd: 100 },
      {
        fetchImpl: fakeFetch(() => okChat('hola', { prompt_tokens: 1_000_000, completion_tokens: 0 })),
        dataDir: dir,
        now: when,
      },
    );
    await ai.generate({ system: 's', prompt: 'p' });
    return Object.values(Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'ai-usage.json'), 'utf8')))[0])[0].usd;
  };
  assert.equal(await run(new Date('2026-10-29T07:00:00Z')), 0.3);
  assert.equal(await run(new Date('2026-10-29T12:00:00Z')), 0.15);
});

test('over budget with fallback-local switches to the local model once and logs it', async () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'ai-usage.json'),
    JSON.stringify({ '2026-10-29': { 'openai/gpt-5-nano': { calls: 9, promptTokens: 1, completionTokens: 1, usd: 1.5 } } }),
  );
  const fetchImpl = fakeFetch(() => ollamaChat('Respuesta local'));
  const { ai, logs } = make(
    { provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano', dailyBudgetUsd: 1, fallbackLocalModel: 'gemma3:1b' },
    { fetchImpl, dataDir: dir, now: new Date(2026, 9, 29, 12) },
  );
  assert.equal(await ai.generate({ system: 's', prompt: 'p' }), 'Respuesta local');
  await ai.generate({ system: 's', prompt: 'p' });
  assert.equal(fetchImpl.calls[0].url, 'http://localhost:11434/api/chat');
  assert.equal(fetchImpl.calls[0].body.model, 'gemma3:1b');
  assert.equal(logs.filter((line) => line.includes('Daily AI budget')).length, 1);
  assert.match(logs[0], /\$1\.00/);
  assert.ok(!logs.join('\n').includes(KEY));
});

test('crossing the budget during a run switches on the next call', async () => {
  const dir = tempDir();
  const fetchImpl = fakeFetch((call) =>
    call.url.endsWith('/api/chat') ? ollamaChat('local') : okChat('api', { prompt_tokens: 1_000_000, completion_tokens: 0 }),
  );
  const { ai } = make(
    { provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano', dailyBudgetUsd: 0.04 },
    { fetchImpl, dataDir: dir },
  );
  assert.equal(await ai.generate({ system: 's', prompt: 'p' }), 'api'); // $0.05 spent
  assert.equal(await ai.generate({ system: 's', prompt: 'p' }), 'local');
});

test('over budget with stop ends the run: logs, calls onStop once and refuses to generate', async () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'ai-usage.json'),
    JSON.stringify({ '2026-10-29': { 'a/b': { calls: 1, promptTokens: 1, completionTokens: 1, usd: 2 } } }),
  );
  let stops = 0;
  const fetchImpl = fakeFetch(() => okChat('nope'));
  const { ai, logs } = make(
    { provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano', dailyBudgetUsd: 1, onBudgetExceeded: 'stop' },
    { fetchImpl, dataDir: dir, now: new Date(2026, 9, 29, 12), onStop: () => stops++ },
  );
  await assert.rejects(ai.generate({ system: 's', prompt: 'p' }), BudgetStopError);
  await assert.rejects(ai.generate({ system: 's', prompt: 'p' }), BudgetStopError);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(stops, 1);
  assert.equal(logs.filter((line) => line.includes('stopping')).length, 1);
});

test('HTTP errors are reported without the API key', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 401, text: async () => `bad key ${KEY}` }));
  const { ai } = make({ provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano' }, { fetchImpl });
  await assert.rejects(ai.generate({ system: 's', prompt: 'p' }), (error) => {
    assert.match(error.message, /401/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
});

test('empty content (reasoning ate the tokens) yields an empty string for the validator', async () => {
  const { ai } = make(
    { provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano' },
    { fetchImpl: fakeFetch(() => okChat(null)) },
  );
  assert.equal(await ai.generate({ system: 's', prompt: 'p' }), '');
});

test('generateUsableMessage does not retry after a budget stop', async () => {
  let calls = 0;
  const text = await generateUsableMessage({
    generate: async () => {
      calls++;
      throw new BudgetStopError('limit');
    },
    warn: () => {},
  });
  assert.equal(text, null);
  assert.equal(calls, 1);
});
