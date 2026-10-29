import assert from 'node:assert/strict';
import test from 'node:test';

import { createStreamParser, friendlyError, stepLabel, summarizeResult } from './stream-parser.js';

const line = (o) => JSON.stringify(o);

test('parses a full tool turn into normalized events', () => {
  const p = createStreamParser();
  const events = [
    { type: 'system', subtype: 'init', session_id: 's1', mcp_servers: [{ name: 'analista', status: 'connected' }], tools: ['x'] },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hola' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__analista__query_sql', input: { purpose: 'ventas de CT 07' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"filas":[{"a":1}],"filas_devueltas":1,"truncado":false}' }] }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Listo', session_id: 's1', duration_ms: 900, num_turns: 3, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 10 } },
  ].flatMap((o) => p.feed(line(o)));
  assert.deepEqual(events.map((e) => e.type), ['init', 'message_start', 'text', 'step', 'step_done', 'result']);
  assert.equal(events[3].label, 'Consultando ventas de CT 07…');
  assert.equal(events[4].summary, '1 fila');
  assert.equal(events[4].ok, true);
  assert.deepEqual(events[5].usage, { input: 5, output: 7, cacheRead: 10, cacheCreate: 0, total: 22 });
  assert.equal(p.toolResults[0].tool, 'query_sql');
  assert.equal(p.claudeSessionId, 's1');
});

test('reads the plan usage window from rate_limit_event', () => {
  const p = createStreamParser();
  const [plan] = p.feed(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1, unifiedWindows: { five_hour: { utilization: 0.29, resetsAt: 99 } } } }));
  assert.deepEqual(plan, { type: 'plan', status: 'allowed', fiveHour: 0.29, resetsAt: 99 });
});

test('ignores junk lines and unknown types', () => {
  const p = createStreamParser();
  assert.deepEqual(p.feed('not json'), []);
  assert.deepEqual(p.feed('{broken'), []);
  assert.deepEqual(p.feed(line({ type: 'future_event' })), []);
  assert.deepEqual(p.feed(''), []);
});

test('tool errors are flagged and summarized', () => {
  const p = createStreamParser();
  p.feed(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__analista__query_sql', input: {} }] } }));
  const [done] = p.feed(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: '{"error":"Relación no permitida: kv"}' }] } }));
  assert.equal(done.ok, false);
  assert.match(done.summary, /Relación no permitida/);
});

test('failed results carry a friendly error', () => {
  const p = createStreamParser();
  const [res] = p.feed(line({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', usage: {} }));
  assert.equal(res.ok, false);
  assert.match(res.error, /sesión/);
  assert.match(friendlyError('usage limit reached'), /límite/);
});

test('progress labels are friendly Spanish', () => {
  assert.equal(stepLabel('mcp__analista__list_views', {}), 'Revisando qué datos tengo disponibles…');
  assert.equal(stepLabel('mcp__analista__metrics', { kind: 'budget_compare', ct: 'CT 07' }), 'Comparando antes y después de la subida de presupuesto de CT 07…');
  assert.equal(stepLabel('WebSearch', { query: 'benchmark CPM Meta' }), 'Buscando en la web: benchmark CPM Meta…');
  assert.equal(stepLabel('WebFetch', { url: 'https://example.com/a' }), 'Leyendo example.com…');
  assert.equal(summarizeResult('metrics', '{"cambios":[1,2]}', false), '2 cambios de presupuesto');
});
