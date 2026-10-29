// Stand-in for the Claude Code CLI in unit tests: prints canned stream-json lines. No network, no API.
//   FAKE_CLAUDE_SCENARIO: ok | ungrounded | hang | login | noresult | recommend   (default ok)
//   FAKE_CLAUDE_DUMP: file where argv, the prompt and the env keys are written (to assert isolation)
import fs from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');

if (process.env.FAKE_CLAUDE_DUMP) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify({ argv: process.argv.slice(2), prompt, envKeys: Object.keys(process.env), cwd: process.cwd() }));
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const scenario = process.env.FAKE_CLAUDE_SCENARIO || 'ok';
const sid = 'fake-session-1';
const usage = { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };

const toolTurn = (text) => {
  out({ type: 'system', subtype: 'init', session_id: sid, mcp_servers: [{ name: 'analista', status: 'connected' }], tools: ['mcp__analista__query_sql'] });
  out({ type: 'stream_event', session_id: sid, event: { type: 'message_start' } });
  out({
    type: 'assistant', session_id: sid,
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__analista__query_sql', input: { sql: 'SELECT 1', purpose: 'ventas de CT 07' } }] },
  });
  out({
    type: 'user', session_id: sid,
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: JSON.stringify({ columnas: ['gasto', 'ventas'], filas: [{ gasto: 100000, ventas: 10 }], filas_devueltas: 1, truncado: false }) }] }] },
  });
  out({ type: 'stream_event', session_id: sid, event: { type: 'message_start' } });
  for (const part of text.match(/.{1,12}/g)) out({ type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, duration_ms: 1234, num_turns: 2, usage, total_cost_usd: 0.01 });
};

if (scenario === 'ok') toolTurn('CT 07 gastó $100.000 y vendió 10 veces.\n\nCómo lo calculé: query_sql sobre v_ads_daily.');
else if (scenario === 'ungrounded') toolTurn('CT 07 gastó $100.000, vendió 10 veces y tuvo un ROAS de 7,35.\n\nCómo lo calculé: query_sql.');
else if (scenario === 'hang') {
  out({ type: 'system', subtype: 'init', session_id: sid, mcp_servers: [], tools: [] });
  out({ type: 'stream_event', session_id: sid, event: { type: 'message_start' } });
  out({ type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Pensando...' } } });
  setInterval(() => undefined, 1000);
} else if (scenario === 'login') {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: sid, duration_ms: 5, num_turns: 1, usage });
} else if (scenario === 'noresult') {
  process.stderr.write('boom: something broke\n');
  process.exitCode = 3;
}
