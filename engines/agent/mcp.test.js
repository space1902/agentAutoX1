import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAgentStore } from './agent-db.js';
import { createMcpServer } from './mcp-protocol.js';
import { createTools } from './tools.js';
import { makeDataDir } from './seed-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('protocol: initialize, tools/list, unknown method and notifications', async () => {
  const server = createMcpServer({
    name: 't', version: '1', tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' }, handler: (a) => ({ got: a }) }, { name: 'boom', description: 'd', inputSchema: { type: 'object' }, handler: () => { throw new Error('x'); } }],
  });
  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((t) => t.name), ['echo', 'boom']);
  const call = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
  assert.deepEqual(JSON.parse(call.result.content[0].text), { got: { a: 1 } });
  const boom = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } });
  assert.equal(boom.result.isError, true);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 5, method: 'nope' })).error.code, -32601);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'zzz' } })).error.code, -32602);
});

test('tools: query_sql logs every attempt and refuses internal tables', async () => {
  const fx = makeDataDir();
  try {
    const store = createAgentStore(':memory:');
    const tools = Object.fromEntries(createTools({ dataDir: fx.dataDir, sessionId: 's1', question: '¿Cuánto gasté?', getStore: () => store, now: () => fx.now }).map((t) => [t.name, t]));
    const ok = await tools.query_sql.handler({ sql: 'SELECT ct, SUM(spend) AS gasto FROM v_ads_daily GROUP BY ct ORDER BY ct', purpose: 'gasto por CT' });
    assert.deepEqual(ok.filas.map((r) => [r.ct, r.gasto]), [['CT 07', 100000], ['CT 08', 50000]]);
    const bad = await tools.query_sql.handler({ sql: 'SELECT * FROM comprobantes', purpose: 'x' });
    assert.match(bad.error, /Relación no permitida|interna/);
    const log = store.recentQueries();
    assert.deepEqual(log.map((l) => l.status).reverse(), ['ok', 'rejected']);
    assert.equal(log[1].question, '¿Cuánto gasté?');
    assert.equal(log[1].rows, 2);
    const metrics = await tools.metrics.handler({ kind: 'kpis', ct: 'CT 07', from: '2026-10-01', to: '2026-10-10' });
    assert.equal(metrics.totales.roas, 3);
    assert.match((await tools.metrics.handler({ kind: 'kpis', ct: 'zzz' })).error, /CT/);
    assert.ok((await tools.list_views.handler({})).vistas.some((v) => v.nombre === 'v_sales'));
  } finally {
    fx.cleanup();
  }
});

test('stdio: the real server process answers JSON-RPC over stdin/stdout', async () => {
  const fx = makeDataDir();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, 'ads-mcp.js')], {
    env: { ...process.env, AGENTAUTO_DATA_DIR: fx.dataDir, AGENTAUTO_SESSION_ID: 'sess-1', AGENTAUTO_QUESTION: 'q' },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const lines = [];
  let buffer = '';
  const waiters = [];
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (id) => {
    for (;;) {
      const found = lines.find((l) => l.id === id);
      if (found) return found;
      await new Promise((r) => waiters.push(r));
    }
  };
  const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    assert.equal((await next(1)).result.serverInfo.name, 'analista');
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    const names = (await next(2)).result.tools.map((t) => t.name);
    assert.ok(['list_views', 'query_sql', 'metrics', 'get_lessons'].every((n) => names.includes(n)), names.join());
    send({ id: 3, method: 'tools/call', params: { name: 'query_sql', arguments: { sql: 'SELECT COUNT(*) AS n FROM v_sales', purpose: 'ventas' } } });
    const result = await next(3);
    assert.deepEqual(JSON.parse(result.result.content[0].text).filas, [{ n: 15 }]);
    send({ id: 4, method: 'tools/call', params: { name: 'query_sql', arguments: { sql: 'DROP TABLE kv', purpose: 'x' } } });
    assert.equal((await next(4)).result.isError, true);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.once('close', r));
    fx.cleanup();
  }
});
