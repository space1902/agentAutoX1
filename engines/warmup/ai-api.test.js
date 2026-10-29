import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAiCommand, runPull } from './ai-api.js';

const KEY = 'sk-test-SECRET-9999';

function dataDir(config = { groupName: 'G', testers: ['tester1'] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-api-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

function ctx(dir, overrides = {}) {
  return { dataDir: dir, now: new Date(2026, 9, 29, 12), env: { AGENTAUTO_AI_KEY: KEY }, ...overrides };
}

test('unknown commands are rejected with the list of available ones', async () => {
  await assert.rejects(runAiCommand('nope', {}, ctx(dataDir())), /Comando desconocido/);
});

test('presets lists data-driven providers with daily and monthly estimates', async () => {
  const data = await runAiCommand('presets', {}, ctx(dataDir()));
  assert.equal(data.pricesAsOf, '2026-10-29');
  assert.deepEqual(data.presets.slice(0, 2).map((p) => [p.id, p.recommended]), [
    ['openrouter', true],
    ['mistral', true],
  ]);
  const nemo = data.presets[0].models.find((m) => m.id === 'mistralai/mistral-nemo');
  assert.ok(Math.abs(nemo.usdDay - 0.1708) < 1e-9);
  assert.deepEqual(data.profile, { messages: 4000, promptTokens: 1400, completionTokens: 70 });
});

test('config-save writes ai atomically with a backup and keeps the rest of config.json', async () => {
  const dir = dataDir({ groupName: 'G', testers: ['tester1'], localModel: { model: 'qwen2.5:7b' } });
  const ai = {
    provider: 'openai-compatible',
    preset: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'mistralai/mistral-nemo',
    dailyBudgetUsd: 2,
    onBudgetExceeded: 'stop',
  };
  await runAiCommand('config-save', { ai }, ctx(dir));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(saved.ai, ai);
  assert.equal(saved.groupName, 'G');
  assert.equal(saved.localModel.model, 'qwen2.5:7b');
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  assert.deepEqual((await runAiCommand('config-get', {}, ctx(dir))).ai, ai);
});

test('config-save never stores an API key', async () => {
  const dir = dataDir();
  await assert.rejects(
    runAiCommand('config-save', { ai: { provider: 'openai-compatible', model: 'm', apiKey: KEY } }, ctx(dir)),
    /API key/,
  );
  const saved = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!saved.includes(KEY));
});

test('config-save validates provider, budget and exceed policy', async () => {
  const dir = dataDir();
  await assert.rejects(runAiCommand('config-save', { ai: { provider: 'x', model: 'm' } }, ctx(dir)), /proveedor/i);
  await assert.rejects(
    runAiCommand('config-save', { ai: { provider: 'openai-compatible', model: 'm', dailyBudgetUsd: -1 } }, ctx(dir)),
    /presupuesto/i,
  );
  await assert.rejects(
    runAiCommand('config-save', { ai: { provider: 'openai-compatible', model: 'm', onBudgetExceeded: 'boom' } }, ctx(dir)),
    /excede/i,
  );
  await assert.rejects(runAiCommand('config-save', { ai: { provider: 'openai-compatible', model: '' } }, ctx(dir)), /modelo/i);
});

test('ai-usage returns today and the last seven days', async () => {
  const dir = dataDir();
  fs.writeFileSync(
    path.join(dir, 'ai-usage.json'),
    JSON.stringify({ '2026-10-29': { 'openai/gpt-5-nano': { calls: 3, promptTokens: 10, completionTokens: 2, usd: 0.25 } } }),
  );
  const usage = await runAiCommand('ai-usage', {}, ctx(dir));
  assert.equal(usage.todayUsd, 0.25);
  assert.equal(usage.days.length, 7);
});

test('ai-test makes 5 calls, reports latency, tokens, cost and the daily estimate, and writes no ledger', async () => {
  const dir = dataDir();
  let n = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers });
    n++;
    return json({
      choices: [{ message: { content: `Mensaje de prueba ${n}` } }],
      usage: { prompt_tokens: 1400, completion_tokens: 70 },
    });
  };
  const result = await runAiCommand(
    'ai-test',
    { ai: { provider: 'openai-compatible', preset: 'openrouter', model: 'mistralai/mistral-nemo' } },
    ctx(dir, { fetchImpl }),
  );
  assert.equal(calls.length, 5);
  assert.equal(result.samples.length, 5);
  assert.equal(result.samples[0].text, 'Mensaje de prueba 1');
  assert.equal(result.samples[0].promptTokens, 1400);
  assert.ok(result.avgLatencyMs >= 0);
  assert.ok(Math.abs(result.estimate.usdDay - 0.1708) < 1e-9);
  assert.ok(result.samples[0].usd > 0);
  assert.equal(fs.existsSync(path.join(dir, 'ai-usage.json')), false);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('ai-test flags unusable samples and reports failures without leaking the key', async () => {
  const dir = dataDir();
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => `invalid ${KEY}` });
  const result = await runAiCommand(
    'ai-test',
    { ai: { provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano' } },
    ctx(dir, { fetchImpl }),
  );
  assert.equal(result.samples.length, 5);
  assert.equal(result.samples[0].ok, false);
  assert.match(result.samples[0].error, /401/);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.equal(result.okCount, 0);
});

test('ai-test without a key explains what is missing', async () => {
  await assert.rejects(
    runAiCommand(
      'ai-test',
      { ai: { provider: 'openai-compatible', preset: 'openai', model: 'gpt-5-nano' } },
      ctx(dataDir(), { env: {} }),
    ),
    /API key/,
  );
});

test('ai-test on a local Ollama model measures latency with zero cost', async () => {
  const fetchImpl = async () => json({ message: { content: 'Hola, qué tal' }, prompt_eval_count: 300, eval_count: 9 });
  const result = await runAiCommand('ai-test', { ai: { provider: 'ollama', model: 'gemma3:4b' } }, ctx(dataDir(), { fetchImpl }));
  assert.equal(result.samples.length, 5);
  assert.equal(result.estimate.usdDay, 0);
  assert.equal(result.samples[0].usd, 0);
});

test('local-detect combines servers, models with fit hints, GPU banner and recommendations', async () => {
  const routes = {
    'http://localhost:11434/api/version': json({ version: '0.12.3' }),
    'http://localhost:11434/api/tags': json({
      models: [{ name: 'qwen2.5:7b', size: 4683087332, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' } }],
    }),
  };
  const fetchImpl = async (url) => {
    if (!routes[url]) throw new Error('ECONNREFUSED');
    return routes[url];
  };
  const exec = async (file) => {
    if (file === 'nvidia-smi') return 'NVIDIA GeForce RTX 5070 Laptop GPU, 8151 MiB, 100 MiB\n';
    return '[]';
  };
  const dir = dataDir({ groupName: 'G', localModel: { model: 'qwen2.5:7b' } });
  const data = await runAiCommand('local-detect', {}, ctx(dir, { fetchImpl, exec }));
  assert.deepEqual(data.servers.map((s) => s.id), ['ollama']);
  assert.equal(data.ollama.installedModels[0].fit.text, 'cabe en tu tarjeta');
  assert.equal(data.ollama.installedModels[0].inUse, true);
  assert.equal(data.gpu.hasDedicated, true);
  assert.match(data.gpu.text, /^Tienes tarjeta de video/);
  assert.deepEqual(data.recommended.map((m) => [m.id, m.installed]), [
    ['gemma3:4b', false],
    ['qwen2.5:3b', false],
    ['gemma3:1b', false],
  ]);
});

test('local-detect recommends light models when there is no dedicated card', async () => {
  const exec = async () => {
    throw new Error('missing');
  };
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const data = await runAiCommand('local-detect', {}, ctx(dataDir(), { fetchImpl, exec }));
  assert.equal(data.gpu.hasDedicated, false);
  assert.deepEqual(data.suggestedForCpu, ['gemma3:1b', 'qwen2.5:3b']);
  assert.equal(data.servers.length, 0);
});

test('local-resources returns loaded models and memory usage', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/ps')) return json({ models: [{ name: 'qwen2.5:7b', size: 100, size_vram: 100 }] });
    throw new Error('x');
  };
  const exec = async () => 'NVIDIA GeForce RTX 5070 Laptop GPU, 8151 MiB, 5000 MiB\n';
  const data = await runAiCommand('local-resources', {}, ctx(dataDir(), { fetchImpl, exec }));
  assert.equal(data.loaded[0].percentGpu, 100);
  assert.equal(data.resources.gpus[0].usedMb, 5000);
  assert.ok(data.resources.ram.totalMb > 0);
});

test('local-delete blocks the model of the running profile and deletes others', async () => {
  const dir = dataDir({ groupName: 'G', localModel: { model: 'qwen2.5:7b' } });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options?.method });
    return { ok: true, status: 200, text: async () => '' };
  };
  await assert.rejects(
    runAiCommand('local-delete', { model: 'qwen2.5:7b', running: 'cal mex4' }, ctx(dir, { fetchImpl })),
    /en uso/,
  );
  assert.equal(calls.length, 0);
  await runAiCommand('local-delete', { model: 'qwen2.5:7b' }, ctx(dir, { fetchImpl }));
  await runAiCommand('local-delete', { model: 'gemma3:1b', running: 'cal mex4' }, ctx(dir, { fetchImpl }));
  assert.deepEqual(calls.map((c) => c.method), ['DELETE', 'DELETE']);
});

test('runPull writes progress lines and a final done line', async () => {
  const encoder = new TextEncoder();
  const fetchImpl = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"status":"pulling a","total":200,"completed":100}
{"status":"success"}
'));
        controller.close();
      },
    }),
  });
  const lines = [];
  await runPull({ model: 'gemma3:1b' }, { dataDir: dataDir(), fetchImpl, write: (line) => lines.push(line) });
  assert.deepEqual(lines.map((l) => [l.type, l.percent]), [['progress', 50], ['progress', 100], ['done', 100]]);
  assert.equal(lines[0].model, 'gemma3:1b');
});
