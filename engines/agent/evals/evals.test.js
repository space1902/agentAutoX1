import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openAgentStore } from '../agent-db.js';
import { loadDataset } from '../metrics.js';
import { makeDataDir } from '../seed-fixture.js';
import { BANK, materialize } from './bank.js';
import { compareAnswer } from './compare.js';
import { judgeArgs, parseVerdict } from './judge.js';
import { estimateRun, runEval } from './runner.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-claude.js');
const claude = { command: process.execPath, prefixArgs: [FAKE] };
const at = (d) => Date.parse(`2026-10-${String(d).padStart(2, '0')}T15:00:00Z`);

// ---- comparator
test('compare: numbers are matched by kind and tolerance, in any written format', () => {
  const nums = [{ label: 'gasto', value: 1234567, kind: 'money' }];
  assert.equal(compareAnswer('Gastaste $1.234.567 en total.', nums).pass, true);
  assert.equal(compareAnswer('Gastaste 1,2 M aprox.', nums).pass, false, '1,2 M is about 3 % off');
  assert.equal(compareAnswer('Gastaste $1.230.000', nums).pass, true, 'within 1 %');
  assert.equal(compareAnswer('Gastaste $1.500.000', nums).pass, false);
  assert.equal(compareAnswer('ROAS de 2,62', [{ label: 'roas', value: 2.6197, kind: 'ratio' }]).pass, true);
  assert.equal(compareAnswer('ROAS de 2,7', [{ label: 'roas', value: 2.6197, kind: 'ratio' }]).pass, false);
  assert.equal(compareAnswer('Hubo 12 ventas', [{ label: 'ventas', value: 12, kind: 'count' }]).pass, true);
  assert.equal(compareAnswer('Hubo 13 ventas', [{ label: 'ventas', value: 12, kind: 'count' }]).pass, false);
  assert.equal(compareAnswer('El margen fue de 35,2 %', [{ label: 'm', value: 35.2, kind: 'pct' }]).pass, true);
});

test('compare: names must be mentioned (accent, case and CT spacing insensitive); nothing to check never passes', () => {
  assert.equal(compareAnswer('El CT07 fue el mejor', [], ['CT 07']).pass, true);
  assert.equal(compareAnswer('El ct 7 fue el mejor', [], ['CT 07']).pass, true);
  assert.equal(compareAnswer('Fue México', [], ['México']).pass, true);
  assert.equal(compareAnswer('Fue el CT 08', [], ['CT 07']).pass, false);
  assert.equal(compareAnswer('algo', [], []).pass, false);
});

// ---- judge
test('judge: reads the verdict leniently and defaults to undecidable', () => {
  assert.deepEqual(parseVerdict('{"verdict":"pass","reason":"ok"}'), { verdict: 'pass', reason: 'ok' });
  assert.equal(parseVerdict('```json\n{"verdict":"fail","reason":"inventó"}\n```').verdict, 'fail');
  assert.equal(parseVerdict('no sé').verdict, 'undecidable');
  assert.equal(parseVerdict('{"verdict":"maybe"}').verdict, 'undecidable');
  const args = judgeArgs();
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
});

// ---- bank
test('bank: truth is computed from the live data, never stored', () => {
  const fx = makeDataDir();
  try {
    const ds = loadDataset(fx.dataDir, at(11));
    const q = Object.fromEntries(materialize(ds).map((x) => [x.id, x]));
    assert.equal(BANK.length, 19);
    assert.deepEqual(q['q01-gasto-semana'].numbers, [{ label: 'gasto total', value: 90000, kind: 'money' }]);
    assert.equal(q['q05-ct-mas-gasto'].mention[0], 'CT 07');
    assert.match(q['q14-que-apagar'].rubric, /CT 08/);
    assert.match(q['q16-entidad-inexistente'].rubric, /NO existe/);
    assert.equal(q['q11-subidas-presupuesto'].numbers[0].value, 1);
    assert.ok(Object.values(q).every((x) => x.skip || x.question));
    assert.deepEqual(estimateRun(ds, ['q01-gasto-semana', 'q15-fuera-de-alcance']), { questions: 2, claudeRuns: 2, judgeRuns: 1, skipped: 0 });
  } finally {
    fx.cleanup();
  }
});

// ---- runner
async function run(text, ids, judge) {
  const fx = makeDataDir();
  process.env.FAKE_CLAUDE_SCENARIO = 'text';
  process.env.FAKE_CLAUDE_TEXT = text;
  const events = [];
  try {
    const res = await runEval({ dataDir: fx.dataDir, ids, emit: (e) => events.push(e), claude, now: () => at(11), judge });
    const store = openAgentStore(fx.dataDir);
    const out = { res, events, runs: store.evalRuns(), results: store.evalResults(res.runId), sessions: store.listSessions(), recs: store.recommendations() };
    store.close();
    return out;
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
    delete process.env.FAKE_CLAUDE_TEXT;
    fx.cleanup();
  }
}

test('runner: numeric questions are graded by code and leave no chats or recommendations behind', async () => {
  const good = await run('Gastaste $90.000 entre el 2026-10-05 y el 2026-10-11.', ['q01-gasto-semana'], async () => ({ verdict: 'pass', reason: '' }));
  assert.equal(good.results[0].status, 'pass');
  assert.equal(good.runs[0].passRate, 1);
  assert.equal(good.sessions.length, 0, 'temporary chats are deleted');
  assert.equal(good.recs.length, 0, 'learning is off while evaluating');
  assert.ok(good.events.some((e) => e.type === 'eval_start' && e.estimate.claudeRuns === 1));

  const bad = await run('Gastaste $95.000.', ['q01-gasto-semana'], async () => ({ verdict: 'pass', reason: '' }));
  assert.equal(bad.results[0].status, 'fail');
  assert.match(bad.results[0].detail, /gasto total/);
  assert.match(bad.results[0].expected, /90000/);
});

test('runner: judged questions use the verdict; undecidable ones leave the denominator', async () => {
  const mixed = await run(
    'Gastaste $90.000.',
    ['q01-gasto-semana', 'q15-fuera-de-alcance', 'q17-prediccion', 'q18-datos-privados'],
    async ({ question }) => (question.includes('capital') ? { verdict: 'fail', reason: 'inventó' } : question.includes('ROAS') ? { verdict: 'undecidable', reason: 'poco claro' } : { verdict: 'pass', reason: 'bien' }),
  );
  const by = Object.fromEntries(mixed.results.map((r) => [r.questionId, r.status]));
  assert.deepEqual(by, { 'q01-gasto-semana': 'pass', 'q15-fuera-de-alcance': 'fail', 'q17-prediccion': 'excluded', 'q18-datos-privados': 'pass' });
  const first = mixed.runs[0];
  assert.deepEqual([first.passed, first.failed, first.excluded], [2, 1, 1]);
  assert.equal(Math.round(first.passRate * 100), 67);
  assert.equal(mixed.events.find((e) => e.type === 'eval_done').status, 'done');
});

test('runner: a failed turn is excluded, not counted as a failure', async () => {
  const fx = makeDataDir();
  process.env.FAKE_CLAUDE_SCENARIO = 'login';
  try {
    const res = await runEval({ dataDir: fx.dataDir, ids: ['q01-gasto-semana'], emit: () => undefined, claude, now: () => at(11), judge: async () => ({ verdict: 'pass', reason: '' }) });
    assert.deepEqual([res.passed, res.failed, res.excluded], [0, 0, 1]);
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
    fx.cleanup();
  }
});
