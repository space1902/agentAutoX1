import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECOMMENDED_MODELS,
  deleteOllamaModel,
  detectServers,
  fitHint,
  listOllamaModels,
  psOllama,
  pullModel,
  validateModelTag,
} from './ai-local.js';

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => '' };

function router(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    const handler = routes[url];
    if (!handler) throw new Error('ECONNREFUSED');
    return typeof handler === 'function' ? handler(options) : handler;
  };
  impl.calls = calls;
  return impl;
}

test('recommended models list size and the three suggested tags', () => {
  assert.deepEqual(
    RECOMMENDED_MODELS.map((m) => [m.id, m.sizeGb]),
    [
      ['gemma3:4b', 3.4],
      ['qwen2.5:3b', 1.9],
      ['gemma3:1b', 0.8],
    ],
  );
});

test('detectServers finds Ollama and LM Studio and lists their models', async () => {
  const fetchImpl = router({
    'http://localhost:11434/api/version': json({ version: '0.12.3' }),
    'http://localhost:11434/api/tags': json({ models: [{ name: 'qwen2.5:7b' }, { name: 'gemma3:4b' }] }),
    'http://localhost:1234/v1/models': json({ data: [{ id: 'qwen2.5-7b-instruct' }] }),
  });
  const servers = await detectServers({ fetchImpl });
  assert.deepEqual(servers.map((s) => s.id), ['ollama', 'lmstudio']);
  assert.equal(servers[0].version, '0.12.3');
  assert.deepEqual(servers[0].models, ['qwen2.5:7b', 'gemma3:4b']);
  assert.equal(servers[0].kind, 'ollama');
  assert.equal(servers[1].baseUrl, 'http://localhost:1234/v1');
  assert.equal(servers[1].kind, 'openai-compatible');
  assert.deepEqual(servers[1].models, ['qwen2.5-7b-instruct']);
});

test('port 8080 is llama.cpp when /health answers, LocalAI otherwise', async () => {
  const llama = await detectServers({
    fetchImpl: router({
      'http://localhost:8080/health': json({ status: 'ok' }),
      'http://localhost:8080/v1/models': json({ data: [{ id: 'm.gguf' }] }),
    }),
  });
  assert.deepEqual(llama.map((s) => s.name), ['llama.cpp']);
  const localai = await detectServers({
    fetchImpl: router({ 'http://localhost:8080/v1/models': json({ data: [{ id: 'x' }] }) }),
  });
  assert.deepEqual(localai.map((s) => s.name), ['LocalAI']);
});

test('detectServers probes Jan, vLLM, llama.cpp 9931 and a user URL', async () => {
  const fetchImpl = router({
    'http://localhost:1337/v1/models': json({ data: [] }),
    'http://localhost:8000/v1/models': json({ data: [{ id: 'v' }] }),
    'http://localhost:9931/health': json({ status: 'ok' }),
    'http://localhost:9931/v1/models': json({ data: [] }),
    'http://pc:5000/v1/models': json({ data: [{ id: 'custom-model' }] }),
  });
  const servers = await detectServers({ fetchImpl, extraUrl: 'http://pc:5000/' });
  assert.deepEqual(servers.map((s) => s.id), ['jan', 'vllm', 'llamacpp-9931', 'custom']);
  assert.equal(servers[3].baseUrl, 'http://pc:5000/v1');
  assert.deepEqual(servers[3].models, ['custom-model']);
});

test('a user URL that already ends in /v1 is not doubled, and Ollama URLs are recognised', async () => {
  const fetchImpl = router({ 'http://pc:5000/v1/models': json({ data: [{ id: 'a' }] }) });
  const servers = await detectServers({ fetchImpl, extraUrl: 'http://pc:5000/v1' });
  assert.equal(servers[0].baseUrl, 'http://pc:5000/v1');
  const ollama = await detectServers({
    fetchImpl: router({ 'http://pc:11434/api/tags': json({ models: [{ name: 'm' }] }) }),
    extraUrl: 'http://pc:11434',
  });
  assert.equal(ollama[0].kind, 'ollama');
  assert.equal(ollama[0].baseUrl, 'http://pc:11434');
});

test('detectServers returns an empty list when nothing answers', async () => {
  assert.deepEqual(await detectServers({ fetchImpl: router({}) }), []);
});

test('listOllamaModels maps size, parameters, quantization and date', async () => {
  const fetchImpl = router({
    'http://localhost:11434/api/tags': json({
      models: [
        {
          name: 'qwen2.5:7b',
          size: 4683087332,
          modified_at: '2026-10-16T09:48:14-05:00',
          details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
        },
        { name: 'bare:latest', size: 10 },
      ],
    }),
  });
  const models = await listOllamaModels({ baseUrl: 'http://localhost:11434', fetchImpl });
  assert.deepEqual(models[0], {
    name: 'qwen2.5:7b',
    sizeBytes: 4683087332,
    parameterSize: '7.6B',
    quantization: 'Q4_K_M',
    modified: '2026-10-16T09:48:14-05:00',
  });
  assert.equal(models[1].parameterSize, '');
});

test('psOllama reports GPU and CPU share of each loaded model', async () => {
  const fetchImpl = router({
    'http://localhost:11434/api/ps': json({
      models: [
        { name: 'qwen2.5:7b', size: 6_000_000_000, size_vram: 4_500_000_000, expires_at: '2026-10-29T13:00:00Z' },
        { name: 'gemma3:1b', size: 1_000_000_000, size_vram: 0 },
      ],
    }),
  });
  const loaded = await psOllama({ baseUrl: 'http://localhost:11434', fetchImpl });
  assert.deepEqual(
    loaded.map((m) => [m.name, m.percentGpu, m.percentCpu]),
    [
      ['qwen2.5:7b', 75, 25],
      ['gemma3:1b', 0, 100],
    ],
  );
});

test('deleteOllamaModel sends DELETE /api/delete with the model name', async () => {
  const fetchImpl = router({ 'http://localhost:11434/api/delete': { ok: true, status: 200, text: async () => '' } });
  await deleteOllamaModel({ baseUrl: 'http://localhost:11434', model: 'gemma3:1b', fetchImpl });
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'DELETE');
  assert.deepEqual(JSON.parse(call.body), { model: 'gemma3:1b' });
});

test('deleteOllamaModel refuses blocked models without calling Ollama', async () => {
  const fetchImpl = router({});
  await assert.rejects(
    deleteOllamaModel({ baseUrl: 'http://x', model: 'qwen2.5:7b', blocked: ['qwen2.5:7b'], fetchImpl }),
    /en uso/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('deleteOllamaModel surfaces Ollama errors', async () => {
  const fetchImpl = router({ 'http://x/api/delete': { ok: false, status: 404, text: async () => 'model not found' } });
  await assert.rejects(deleteOllamaModel({ baseUrl: 'http://x', model: 'nope:1b', fetchImpl }), /404/);
});

test('validateModelTag accepts Ollama tags and rejects junk', () => {
  for (const tag of ['gemma3:4b', 'qwen2.5:3b', 'llama3.1', 'library/phi4:14b-q4_K_M', 'hf.co/user/repo:Q4_K_M']) {
    assert.equal(validateModelTag(tag), tag, tag);
  }
  assert.equal(validateModelTag('  gemma3:4b '), 'gemma3:4b');
  for (const tag of ['', 'a b', 'x;rm', '-bad', 'a'.repeat(201), ':4b', 'a//b', 'a:b:c']) {
    assert.throws(() => validateModelTag(tag), /etiqueta/i, JSON.stringify(tag));
  }
});

function ndjsonResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

test('pullModel streams NDJSON progress, even when lines are split across chunks', async () => {
  const lines = [
    '{"status":"pulling manifest"}\n',
    '{"status":"pulling abc","digest":"sha256:abc","total":1000,"completed":250}\n',
    '{"status":"pulling abc","digest":"sha256:abc","total":1000,"completed":1000}\n',
    '{"status":"success"}\n',
  ];
  const joined = lines.join('');
  const chunks = [joined.slice(0, 50), joined.slice(50, 140), joined.slice(140)];
  const fetchImpl = router({ 'http://localhost:11434/api/pull': ndjsonResponse(chunks) });
  const seen = [];
  const result = await pullModel({
    baseUrl: 'http://localhost:11434',
    model: 'gemma3:1b',
    fetchImpl,
    onProgress: (p) => seen.push(p),
  });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { model: 'gemma3:1b', stream: true });
  assert.deepEqual(seen.map((p) => p.percent), [null, 25, 100, 100]);
  assert.equal(seen[1].status, 'pulling abc');
  assert.equal(seen.at(-1).done, true);
  assert.deepEqual(result, { ok: true });
});

test('pullModel throws on an error line, on HTTP errors and when aborted', async () => {
  await assert.rejects(
    pullModel({
      baseUrl: 'http://x',
      model: 'nope:1b',
      fetchImpl: router({ 'http://x/api/pull': ndjsonResponse(['{"error":"pull model manifest: file does not exist"}\n']) }),
      onProgress: () => {},
    }),
    /file does not exist/,
  );
  await assert.rejects(
    pullModel({
      baseUrl: 'http://x',
      model: 'm',
      fetchImpl: router({ 'http://x/api/pull': { ok: false, status: 500, text: async () => 'boom' } }),
      onProgress: () => {},
    }),
    /500/,
  );
  await assert.rejects(
    pullModel({ baseUrl: 'http://x', model: 'bad tag', fetchImpl: router({}), onProgress: () => {} }),
    /etiqueta/i,
  );
});

test('fitHint compares the model size with the video memory', () => {
  const gpu = { kind: 'dedicated', totalMb: 8151 };
  assert.deepEqual(fitHint(4_683_087_332, [gpu]), { fits: true, text: 'cabe en tu tarjeta' });
  assert.deepEqual(fitHint(9_000_000_000, [gpu]), { fits: false, text: 'no cabe, usará RAM' });
  assert.deepEqual(fitHint(1_000_000_000, []), { fits: false, text: 'usará procesador y RAM' });
  assert.deepEqual(fitHint(1_000_000_000, [{ kind: 'integrated', totalMb: null }]), {
    fits: false,
    text: 'usará procesador y RAM',
  });
});
