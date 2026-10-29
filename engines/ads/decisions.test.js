import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeChanges } from './budget.js';
import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { evaluateDue, isDue, postBudgetVerdict, testVerdict } from './decisions.js';
import { addDays } from './time.js';

const T = DEFAULT_CONFIG.thresholds;
const L = DEFAULT_CONFIG.lifecycle;
const m = (o) => ({ gasto: 0, mensajes: 0, ventas: 0, valor: 0, roas: 0, costoVenta: 0, conversion: 0, ...o });

test('isDue: on the day at/after the time; late up to lateDays; never before or too late', () => {
  const at = (date, h, min = 0) => ({ date, minutes: h * 60 + min });
  assert.deepEqual(isDue(at('2026-10-28', 19, 59), '2026-10-28', '20:00', 2), { due: false, late: false });
  assert.deepEqual(isDue(at('2026-10-28', 20, 0), '2026-10-28', '20:00', 2), { due: true, late: false });
  assert.deepEqual(isDue(at('2026-10-27', 23, 0), '2026-10-28', '20:00', 2), { due: false, late: false });
  assert.deepEqual(isDue(at('2026-10-29', 8, 0), '2026-10-28', '20:00', 2), { due: true, late: true });
  assert.deepEqual(isDue(at('2026-10-30', 8, 0), '2026-10-28', '20:00', 2), { due: true, late: true });
  assert.deepEqual(isDue(at('2026-10-31', 8, 0), '2026-10-28', '20:00', 2), { due: false, late: false });
});

test('testVerdict applies the configured thresholds and explains itself in Spanish', () => {
  const dup = testVerdict(m({ gasto: 40000, ventas: 5, valor: 136000, roas: 3.4, costoVenta: 8000 }), 4, T);
  assert.equal(dup.action.label, 'Escalar y duplicar');
  assert.match(dup.reason, /ROAS 3,4 con 5 ventas en 4 días/);
  assert.equal(testVerdict(m({ gasto: 40000, ventas: 1, valor: 20000, roas: 0.5 }), 4, T).action.label, 'Apagar');
  const wait = testVerdict(m({ gasto: 9000 }), 4, T);
  assert.equal(wait.action.label, 'Esperar');
  assert.match(wait.reason, /mínimo/);
  assert.match(testVerdict(m({ gasto: 40000, ventas: 1, valor: 52000, roas: 1.3 }), 4, T).reason, /1 venta /);
});

test('postBudgetVerdict: raise, hold and lower', () => {
  const before = m({ gasto: 60000, ventas: 3, valor: 180000, roas: 3, costoVenta: 20000 });
  const raise = postBudgetVerdict(m({ gasto: 40000, ventas: 2, valor: 130000, roas: 3.25, costoVenta: 20000 }), before, L, T, { pct: 20 });
  assert.equal(raise.verdict.key, 'raise');
  assert.equal(raise.suggestedPct, 20);

  const hold = postBudgetVerdict(m({ gasto: 20000, ventas: 1, valor: 80000, roas: 4, costoVenta: 20000 }), before, L, T, { pct: 20 });
  assert.equal(hold.verdict.key, 'hold');
  assert.equal(hold.suggestedPct, null);

  const lowRoas = postBudgetVerdict(m({ gasto: 40000, ventas: 1, valor: 20000, roas: 0.5, costoVenta: 40000 }), before, L, T, { pct: 20 });
  assert.equal(lowRoas.verdict.key, 'lower');

  const worseCpa = postBudgetVerdict(m({ gasto: 64000, ventas: 2, valor: 160000, roas: 2.5, costoVenta: 32000 }), before, L, T, { pct: 20 });
  assert.equal(worseCpa.verdict.key, 'lower');

  const middling = postBudgetVerdict(m({ gasto: 56000, ventas: 2, valor: 140000, roas: 2.5, costoVenta: 28000 }), before, L, T, { pct: 20 });
  assert.equal(middling.verdict.key, 'hold', 'CPA 40% worse is between +25% and +50%');
});

test('postBudgetVerdict never suggests more than maxRaisePct and handles no baseline sales', () => {
  const life = { ...L, raisePct: 50, maxRaisePct: 20 };
  const out = postBudgetVerdict(m({ gasto: 40000, ventas: 3, valor: 140000, roas: 3.5, costoVenta: 13000 }), m({ gasto: 10000 }), life, T, { pct: 20 });
  assert.equal(out.verdict.key, 'raise');
  assert.equal(out.suggestedPct, 20);
  assert.equal(postBudgetVerdict(m({}), m({}), L, T, { pct: 20 }).verdict.key, 'hold');
});

// ---------------------------------------------------------------- evaluateDue scenarios

const ins = (date, adId, gasto, extra = {}) => ({
  date, adId, adName: `Ad ${adId}`, campaignId: 'c1', campaignName: 'CT01 - ventas', adsetId: 's1', adsetName: 'Set 1', gasto, mensajes: 10, ...extra,
});
const pay = (date, adId, valor) => ({ registered: `${date} 10:00`, date, result: 'Pago válido', phone: '573001234567', valor, bank: 'Nequi', flow: 'Bebidas - aporte', adId, adLossy: false, adUrl: '' });
const days = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));

function testScenario() {
  const insights = days('2026-10-25', 4).map((d) => ins(d, 'A', 10000));
  const comprobantes = ['2026-10-26', '2026-10-27', '2026-10-28'].map((d) => pay(d, 'A', 60000));
  return { insights, comprobantes, identities: { A: { adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas' } }, ads: { A: { firstSpendDate: '2026-10-25' } }, changes: [] };
}
const base = (over) => ({ config: DEFAULT_CONFIG, existing: new Set(), ...testScenario(), ...over });
const clock = (date, h) => ({ date, minutes: h * 60 });

test('day 4 at 20:00 creates the ad and CT verdicts over days 1..4', () => {
  const out = evaluateDue(base({ now: clock('2026-10-28', 20) }));
  const ad = out.find((d) => d.kind === 'test');
  assert.equal(ad.entityId, 'A');
  assert.equal(ad.dayN, 4);
  assert.equal(ad.late, false);
  assert.equal(ad.verdict.label, 'Escalar y duplicar');
  assert.equal(ad.metrics.gasto, 40000);
  assert.equal(ad.metrics.ventas, 3);
  assert.equal(ad.metrics.valor, 180000);
  assert.match(ad.reason, /ROAS 4,5 con 3 ventas en 4 días/);
  assert.deepEqual(ad.range, { from: '2026-10-25', to: '2026-10-28' });
  const ct = out.find((d) => d.kind === 'ct_test');
  assert.equal(ct.label, 'CT 01');
  assert.equal(ct.metrics.valor, 180000);
});

test('nothing is created before 20:00 or when the kind is off', () => {
  assert.equal(evaluateDue(base({ now: clock('2026-10-28', 19) })).length, 0);
  const off = mergeConfig({ lifecycle: { testEnabled: false } });
  assert.equal(evaluateDue(base({ now: clock('2026-10-28', 21), config: off })).length, 0);
});

test('each decision is issued once (dedupe by key) and catch-up is flagged late with the same window', () => {
  const first = evaluateDue(base({ now: clock('2026-10-28', 20) }));
  const again = evaluateDue(base({ now: clock('2026-10-28', 21), existing: new Set(first.map((d) => d.key)) }));
  assert.equal(again.length, 0);

  const withMore = { ...testScenario() };
  withMore.insights = [...withMore.insights, ins('2026-10-29', 'A', 99999)];
  const late = evaluateDue({ ...withMore, config: DEFAULT_CONFIG, existing: new Set(), now: clock('2026-10-29', 9) });
  const ad = late.find((d) => d.kind === 'test');
  assert.equal(ad.late, true);
  assert.equal(ad.metrics.gasto, 40000, 'day 5 spend must not leak into the day 1..4 verdict');
});

test('ads that never spent, old ads and ads outside the prefix get no test verdict', () => {
  const s = testScenario();
  assert.equal(evaluateDue(base({ now: clock('2026-11-10', 21) })).length, 0, 'too late to catch up');
  assert.equal(evaluateDue(base({ ads: { A: {} }, now: clock('2026-10-28', 21) })).length, 0);
  const other = { ...s, identities: { A: { adName: 'A', campaignId: 'c9', campaignName: 'Branding' } }, insights: s.insights.map((r) => ({ ...r, campaignName: 'Branding' })) };
  assert.equal(evaluateDue({ ...other, config: DEFAULT_CONFIG, existing: new Set(), now: clock('2026-10-28', 21) }).length, 0);
});

function budgetScenario({ afterVentas = 2, afterGasto = 20000 } = {}) {
  const before = days('2026-10-24', 3).map((d) => ins(d, 'X', 20000));
  const after = days('2026-10-27', 2).map((d) => ins(d, 'X', afterGasto));
  const comprobantes = [
    ...days('2026-10-24', 3).map((d) => pay(d, 'X', 60000)),
    ...days('2026-10-27', afterVentas).map((d) => pay(d, 'X', 65000)),
  ];
  const changes = computeChanges({
    histories: { 'adset|s1': [{ date: '2026-10-20', dailyBudget: 5000000, lifetimeBudget: null, firstSeen: 0 }, { date: '2026-10-27', dailyBudget: 6000000, lifetimeBudget: null, firstSeen: 1 }] },
    events: [],
  });
  return { insights: [...before, ...after], comprobantes, identities: { X: { adName: 'Ad X', campaignId: 'c1', campaignName: 'CT01 - ventas' } }, ads: { X: { firstSpendDate: '2026-10-01' } }, changes };
}

test('post-budget check on day 2 at 20:00 compares against the 3 days before the change', () => {
  const out = evaluateDue({ ...budgetScenario(), config: DEFAULT_CONFIG, existing: new Set(), now: clock('2026-10-28', 20) });
  const b = out.find((d) => d.kind === 'budget');
  assert.equal(b.dayN, 2);
  assert.equal(b.entityType, 'adset');
  assert.equal(b.label, 'Set 1');
  assert.equal(b.verdict.label, 'Subir más');
  assert.equal(b.extra.suggestedPct, 20);
  assert.equal(b.extra.exact, false);
  assert.equal(Math.round(b.extra.changePct), 20);
  assert.deepEqual(b.range, { from: '2026-10-27', to: '2026-10-28' });
  assert.deepEqual(b.extra.beforeRange, { from: '2026-10-24', to: '2026-10-26' });
  assert.equal(b.extra.before.roas, 3);
  assert.equal(b.key, 'budget:adset:s1:2026-10-27:6000000:d2');
});

test('post-budget check says lower when ROAS collapses and hold with little data', () => {
  const lower = evaluateDue({ ...budgetScenario({ afterVentas: 0, afterGasto: 30000 }), config: DEFAULT_CONFIG, existing: new Set(), now: clock('2026-10-28', 20) });
  assert.equal(lower.find((d) => d.kind === 'budget').verdict.label, 'Bajar presupuesto');
  const hold = evaluateDue({ ...budgetScenario({ afterVentas: 1 }), config: DEFAULT_CONFIG, existing: new Set(), now: clock('2026-10-28', 20) });
  assert.equal(hold.find((d) => d.kind === 'budget').verdict.label, 'Mantener y esperar');
});

test('post-budget notes the previous change of the same entity', () => {
  const s = budgetScenario();
  s.changes = computeChanges({
    histories: { 'adset|s1': [{ date: '2026-10-10', dailyBudget: 4000000, lifetimeBudget: null, firstSeen: 0 }, { date: '2026-10-20', dailyBudget: 5000000, lifetimeBudget: null, firstSeen: 1 }, { date: '2026-10-27', dailyBudget: 6000000, lifetimeBudget: null, firstSeen: 2 }] },
    events: [],
  });
  const out = evaluateDue({ ...s, config: DEFAULT_CONFIG, existing: new Set(), now: clock('2026-10-28', 20) });
  const b = out.find((d) => d.kind === 'budget' && d.extra.changeDate === '2026-10-27');
  assert.equal(b.extra.previous.date, '2026-10-20');
  assert.equal(b.extra.daysSincePrevious, 7);
  assert.match(b.reason, /último cambio/i);
});
