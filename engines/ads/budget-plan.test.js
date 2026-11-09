import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG } from './config.js';
import {
  MIN_MEASURED_RAISES, buildBudgetPlan, collectChanges, evaluateChange, planDataStart, roundBudget, suggestNext, summarizeLearning, windowMetrics,
} from './budget-plan.js';

const life = DEFAULT_CONFIG.lifecycle;
const thresholds = DEFAULT_CONFIG.thresholds;

// { '2026-11-01': [gasto, valor, ventas, mensajes] } -> Map date -> daily point (no IVA, so spendNet = gasto).
const daily = (rows) => new Map(Object.entries(rows).map(([date, [gasto, valor, ventas = 0, mensajes = 0]]) => [date, { date, gasto, spendNet: gasto, valor, ventas, mensajes }]));
const flat = (from, to, row) => {
  const out = {};
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) out[new Date(d).toISOString().slice(0, 10)] = row;
  return out;
};
const raise = (date, oldBudget, newBudget, extra = {}) => ({ entityType: 'campaign', entityId: 'c1', date, time: Date.parse(`${date}T15:00:00Z`), oldBudget, newBudget, exact: true, ...extra });

// ---------- roundBudget ----------

test('roundBudget rounds COP to the nearest 1.000 and refines tiny budgets; other currencies use their own unit', () => {
  assert.equal(roundBudget(17250, 'COP'), 17000);
  assert.equal(roundBudget(14400, 'COP'), 14000);
  assert.equal(roundBudget(17500, 'COP'), 18000);
  assert.equal(roundBudget(2400, 'COP'), 2400, 'a 2.400 budget cannot be rounded to 1.000 without a 40 % jump');
  assert.equal(roundBudget(12.4, 'USD'), 12);
  assert.equal(roundBudget(235, 'MXN'), 240);
  assert.equal(roundBudget(1234, ''), 1234, 'unknown currency is not rounded');
});

// ---------- collectChanges ----------

test('collectChanges keeps raises AND cuts from the activity log, with the exact time', () => {
  const out = collectChanges({ events: [raise('2026-11-04', 10000, 12000), raise('2026-11-10', 12000, 9000)] });
  assert.deepEqual(out.map((c) => [c.date, c.oldBudget, c.newBudget, c.exact]), [['2026-11-04', 10000, 12000, true], ['2026-11-10', 12000, 9000, true]]);
});

test('collectChanges derives changes from budget snapshots (raises and cuts) only when the log does not know them', () => {
  const histories = {
    'campaign|c1': [
      { date: '2026-11-01', dailyBudget: 10000, firstSeen: 1 },
      { date: '2026-11-03', dailyBudget: 12000, firstSeen: 2 },
      { date: '2026-11-06', dailyBudget: 9000, firstSeen: 3 },
      { date: '2026-11-07', dailyBudget: null, firstSeen: 4 },
    ],
  };
  const out = collectChanges({ histories, events: [raise('2026-11-03', 10000, 12000)] });
  assert.equal(out.length, 2, 'the 12000 raise is covered by the log; the cut is only in the snapshots');
  assert.deepEqual(out.map((c) => [c.date, c.newBudget, c.exact]), [['2026-11-03', 12000, true], ['2026-11-06', 9000, false]]);
});

test('collectChanges merges several changes of the same day into the net one and drops a net zero', () => {
  const merged = collectChanges({ events: [raise('2026-11-04', 10000, 12000, { time: 1 }), raise('2026-11-04', 12000, 14000, { time: 2 })] });
  assert.deepEqual(merged.map((c) => [c.oldBudget, c.newBudget]), [[10000, 14000]]);
  assert.deepEqual(collectChanges({ events: [raise('2026-11-04', 10000, 12000, { time: 1 }), raise('2026-11-04', 12000, 10000, { time: 2 })] }), []);
});

test('collectChanges divides snapshot amounts by the minor unit of the account (events are whole units)', () => {
  const histories = { 'campaign|c1': [{ date: '2026-11-01', dailyBudget: 1000, firstSeen: 1 }, { date: '2026-11-03', dailyBudget: 1200, firstSeen: 2 }] };
  const out = collectChanges({ histories, divisorOf: () => 100 });
  assert.deepEqual(out.map((c) => [c.oldBudget, c.newBudget]), [[10, 12]]);
});

// ---------- windowMetrics ----------

test('windowMetrics sums the days that exist, counts days with spend and uses spend without IVA for ROAS', () => {
  const d = daily({ '2026-11-01': [10000, 30000, 2, 20], '2026-11-03': [10000, 0, 0, 10] });
  d.get('2026-11-01').spendNet = 8000;
  const m = windowMetrics(d, '2026-11-01', '2026-11-03');
  assert.equal(m.days, 2, 'the missing 11-02 does not count as a day with data');
  assert.equal(m.gasto, 20000);
  assert.equal(m.roas, 30000 / 18000);
  assert.equal(m.costoVenta, 10000);
  assert.equal(m.conversion, 2 / 30);
});

test('windowMetrics of an empty window is all zeros', () => {
  const m = windowMetrics(new Map(), '2026-11-01', '2026-11-03');
  assert.deepEqual([m.days, m.gasto, m.roas, m.costoVenta, m.conversion], [0, 0, 0, 0, 0]);
});

// ---------- evaluateChange ----------

const BEFORE = flat('2026-11-01', '2026-11-03', [10000, 30000, 2, 20]); // ROAS 3, cost per sale 5.000
const ev = (rows, today, change = raise('2026-11-04', 10000, 12000), otherDates = []) =>
  evaluateChange(change, { daily: daily({ ...BEFORE, ...rows }), today, life, thresholds, otherDates });

test('a change is "en evaluación (día N de 3)" until its 3 days (the day of the change is day 1) are over', () => {
  const r = ev(flat('2026-11-04', '2026-11-05', [12000, 36000, 2, 20]), '2026-11-05');
  assert.equal(r.status.key, 'evaluating');
  assert.equal(r.status.label, 'en evaluación (día 2 de 3)');
  assert.equal(r.measured, false);
  assert.equal(r.daysSince, 1);
  assert.deepEqual([r.after.from, r.after.to, r.before.from, r.before.to], ['2026-11-04', '2026-11-06', '2026-11-01', '2026-11-03']);
  assert.equal(ev({}, '2026-11-04').status.label, 'en evaluación (día 1 de 3)');
});

test('the 3-day window closes on day 4 and the change is measured when ROAS holds and cost per sale does not worsen over 25 %', () => {
  const r = ev(flat('2026-11-04', '2026-11-06', [12000, 36000, 2, 20]), '2026-11-07');
  assert.equal(r.status.key, 'worked');
  assert.equal(r.status.label, 'funcionó');
  assert.equal(r.measured, true);
  assert.equal(r.success, true);
  assert.ok(Math.abs(r.worsenPct - 20) < 1e-9);
  assert.equal(r.pct, 20);
});

test('a change is "empeoró" when ROAS falls below keepRoas or the cost per sale worsens over lowerCpaWorsenPct', () => {
  const lowRoas = ev(flat('2026-11-04', '2026-11-06', [12000, 12000, 1, 20]), '2026-11-07');
  assert.equal(lowRoas.status.label, 'empeoró');
  assert.equal(lowRoas.success, false);
  assert.equal(lowRoas.measured, true);
  const dearer = ev(flat('2026-11-04', '2026-11-06', [24000, 72000, 3, 20]), '2026-11-07');
  assert.equal(dearer.status.label, 'empeoró', 'ROAS 3 but cost per sale 8.000 vs 5.000 (+60 %)');
});

test('a change between both extremes is neither worked nor worsened', () => {
  const r = ev(flat('2026-11-04', '2026-11-06', [12000, 19200, 2, 20]), '2026-11-07');
  assert.equal(r.status.key, 'stable');
  assert.equal(r.success, false);
});

test('a cut is labelled BAJÓ, never measured, and keeps both windows', () => {
  const r = ev(flat('2026-11-04', '2026-11-06', [8000, 24000, 2, 10]), '2026-11-07', raise('2026-11-04', 10000, 8000));
  assert.equal(r.kind, 'cut');
  assert.equal(r.status.label, 'BAJÓ');
  assert.equal(r.measured, false);
  assert.equal(r.pct, -20);
  assert.equal(r.after.gasto, 24000);
});

test('another change inside the window (days 2-3) mixes the result: it is excluded from the measurement', () => {
  const rows = flat('2026-11-04', '2026-11-06', [12000, 36000, 2, 20]);
  const mixed = ev(rows, '2026-11-07', undefined, ['2026-11-05']);
  assert.equal(mixed.status.key, 'overlap');
  assert.equal(mixed.measured, false);
  const sameDay = ev(rows, '2026-11-07', undefined, ['2026-11-04']);
  assert.equal(sameDay.status.key, 'overlap', 'an ad set change the same day also mixes it');
  const ladder = ev(rows, '2026-11-07', undefined, ['2026-11-01', '2026-11-07']);
  assert.equal(ladder.measured, true, 'the previous raise of the ladder and the next one do not mix this window');
});

test('a change without spend after it has no data and is not measured', () => {
  const r = ev({}, '2026-11-08');
  assert.equal(r.status.key, 'nodata');
  assert.equal(r.measured, false);
});

test('missing days inside the window do not break the evaluation', () => {
  const r = ev({ '2026-11-04': [12000, 36000, 2, 20], '2026-11-06': [12000, 36000, 2, 20] }, '2026-11-07');
  assert.equal(r.after.days, 2);
  assert.equal(r.measured, true);
});

test('the window wraps month and year boundaries', () => {
  const r = evaluateChange(raise('2026-12-31', 10000, 12000), { daily: daily(flat('2026-12-28', '2027-01-02', [10000, 30000, 2, 20])), today: '2027-01-03', life, thresholds, otherDates: [] });
  assert.deepEqual([r.before.from, r.before.to, r.after.from, r.after.to], ['2026-12-28', '2026-12-30', '2026-12-31', '2027-01-02']);
  assert.equal(r.measured, true);
});

// ---------- learning ----------

const measuredRaise = (pct, success, worsenPct = 10) => ({ kind: 'raise', measured: true, pct, success, worsenPct });
const many = (n, pct, successes) => Array.from({ length: n }, (_, i) => measuredRaise(pct, i < successes));

test('with fewer than 8 measured raises it is learning mode, with 8 it is learned', () => {
  assert.equal(MIN_MEASURED_RAISES, 8);
  const seven = summarizeLearning(many(7, 20, 5), { life, thresholds });
  assert.equal(seven.mode, 'learning');
  assert.equal(seven.measured, 7);
  assert.equal(seven.text, 'Aprendiendo (7 de 8 subidas medidas): sugerencia estándar +20 % cada 3 días');
  const eight = summarizeLearning(many(8, 20, 5), { life, thresholds });
  assert.equal(eight.mode, 'learned');
  assert.equal(summarizeLearning([], { life, thresholds }).text, 'Aprendiendo (0 de 8 subidas medidas): sugerencia estándar +20 % cada 3 días');
});

test('only measured raises count: cuts, evaluating and mixed changes are ignored', () => {
  const noise = [{ kind: 'cut', measured: false }, { kind: 'raise', measured: false, pct: 20 }, ...many(3, 20, 3)];
  assert.equal(summarizeLearning(noise, { life, thresholds }).measured, 3);
});

test('learned mode picks the bucket that keeps ROAS most often and explains it with the numbers', () => {
  const l = summarizeLearning([...many(7, 15, 6), ...many(2, 25, 1)], { life, thresholds });
  assert.equal(l.mode, 'learned');
  assert.deepEqual(l.buckets.map((b) => [b.label, b.n, b.successes]), [['≤15 %', 7, 6], ['16–25 %', 2, 1]]);
  assert.equal(l.best.pct, 15);
  assert.equal(l.sentence, 'Según lo aprendido: de 9 subidas, ≤15 % mantuvo el ROAS en 6 de 7; 16–25 % en 1 de 2.');
});

test('a tie in success rate goes to the smaller bucket and a single case is not enough evidence for a bucket', () => {
  const tie = summarizeLearning([...many(4, 10, 3), ...many(4, 22, 3)], { life, thresholds });
  assert.equal(tie.best.key, 'le15');
  const lucky = summarizeLearning([...many(7, 15, 4), ...many(1, 40, 1)], { life, thresholds });
  assert.equal(lucky.best.key, 'le15', '1 of 1 is not enough to beat 4 of 7');
});

test('buckets are ranked by the Wilson lower bound: a big sample beats a tiny perfect one; fewer than 3 cases never win', () => {
  const a = summarizeLearning([...many(3, 10, 3), ...many(30, 22, 20)], { life, thresholds });
  assert.equal(a.best.key, 'mid', '20 of 30 is more reliable than 3 of 3');
  const b = summarizeLearning([...many(6, 10, 3), ...many(2, 22, 2)], { life, thresholds });
  assert.equal(b.best.key, 'le15', '2 of 2 has too few cases');
  const same = summarizeLearning([...many(4, 30, 3), ...many(4, 12, 3)], { life, thresholds });
  assert.equal(same.best.key, 'le15', 'same score and same n: the smaller size wins');
  const bigger = summarizeLearning([...many(3, 10, 3), ...many(3, 22, 3), ...many(3, 30, 3)], { life, thresholds });
  assert.equal(bigger.best.key, 'le15', 'a full tie goes to the smaller size');
});

test('median change of cost per sale is reported by bucket', () => {
  const rows = [10, 20, 40].map((w, i) => measuredRaise(15, true, w));
  const l = summarizeLearning([...rows, ...many(5, 22, 3)], { life, thresholds });
  assert.equal(l.buckets[0].medianCpaChangePct, 20);
});

// ---------- suggestNext ----------

const TODAY = '2026-11-10';
const GOOD = [12000, 36000, 3, 30];
const learningState = summarizeLearning([], { life, thresholds });
const campaign = (rows, changes, extra = {}) => ({
  active: true, currentBudget: 12000, currency: 'COP', changes, lastAnyChangeDate: changes.at(-1)?.date ?? null, daily: daily(rows), ...extra,
});
const sug = (c, learning = learningState) => suggestNext({ campaign: c, today: TODAY, life, thresholds, learning });
const lastRaise = { kind: 'raise', date: '2026-11-07', oldBudget: 10000, newBudget: 12000, pct: 20, before: windowMetrics(daily({ ...flat('2026-11-04', '2026-11-06', [10000, 30000, 2, 20]) }), '2026-11-04', '2026-11-06') };

test('standard rule: 3 days since the change, ROAS ok and cost per sale stable -> +20 % rounded to 1.000 on day 4', () => {
  const s = sug(campaign(flat('2026-11-07', '2026-11-09', GOOD), [lastRaise]));
  assert.equal(s.mode, 'learning');
  assert.equal(s.action.key, 'raise');
  assert.equal(s.suggestedPct, 17, 'the real change after rounding (12.000 -> 14.000), not the nominal 20 %');
  assert.equal(s.nominalPct, 20);
  assert.equal(s.suggestedBudget, 14000);
  assert.equal(s.action.label, 'Subir 17 % → $14.000');
  assert.match(s.reason, /ROAS/);
});

test('before day 4 it asks to wait and says which day of the window it is', () => {
  const s = sug(campaign(flat('2026-11-08', '2026-11-09', GOOD), [{ ...lastRaise, date: '2026-11-08' }]));
  assert.equal(s.action.key, 'wait');
  assert.equal(s.action.label, 'Esperar (día 3 de 3)');
  assert.equal(s.suggestedBudget, null);
});

test('a worse result suggests going back to the previous budget', () => {
  const lowRoas = sug(campaign(flat('2026-11-07', '2026-11-09', [12000, 12000, 1, 30]), [lastRaise]));
  assert.equal(lowRoas.action.key, 'lower');
  assert.equal(lowRoas.suggestedBudget, 10000);
  assert.equal(lowRoas.action.label, 'Bajar a $10.000');
  const dearer = sug(campaign(flat('2026-11-07', '2026-11-09', [24000, 72000, 3, 30]), [lastRaise]));
  assert.equal(dearer.action.key, 'lower', 'cost per sale +60 % > lowerCpaWorsenPct');
});

test('in between it keeps the budget', () => {
  const s = sug(campaign(flat('2026-11-07', '2026-11-09', [12000, 19200, 3, 30]), [lastRaise]));
  assert.equal(s.action.key, 'hold');
  assert.equal(s.action.label, 'Mantener');
  const dearer25 = sug(campaign(flat('2026-11-07', '2026-11-09', [19500, 58500, 3, 30]), [lastRaise]));
  assert.equal(dearer25.action.key, 'hold', 'ROAS 3 but cost per sale +30 % (over 25, under 50): no raise, no revert');
});

test('after a cut it never reverts the cut: it holds, or raises only with good ROAS and sales', () => {
  const cut = { kind: 'cut', date: '2026-11-07', oldBudget: 14000, newBudget: 12000, pct: -14.3, before: lastRaise.before };
  const bad = sug(campaign(flat('2026-11-07', '2026-11-09', [12000, 12000, 1, 30]), [cut]));
  assert.equal(bad.action.key, 'hold');
  assert.equal(bad.suggestedBudget, null);
  const good = sug(campaign(flat('2026-11-07', '2026-11-09', GOOD), [cut]));
  assert.equal(good.action.key, 'raise');
});

test('a campaign with no change on record is judged on its last 3 complete days', () => {
  const s = sug(campaign(flat('2026-11-07', '2026-11-09', GOOD), []));
  assert.equal(s.action.key, 'raise');
  const none = sug(campaign(flat('2026-11-07', '2026-11-09', [12000, 12000, 1, 30]), []));
  assert.equal(none.action.key, 'hold', 'nothing to go back to');
});

test('an ad set change in the last 3 days also asks to wait', () => {
  const s = sug(campaign(flat('2026-11-07', '2026-11-09', GOOD), [lastRaise], { lastAnyChangeDate: '2026-11-09' }));
  assert.equal(s.action.key, 'wait');
});

test('no spend in the last 3 days -> hold with a data reason; paused or inactive campaigns get no suggestion', () => {
  assert.equal(sug(campaign({}, [lastRaise])).action.key, 'hold');
  assert.equal(sug(campaign(flat('2026-11-07', '2026-11-09', GOOD), [lastRaise], { active: false })), null);
});

test('an unknown current budget still gives the percentage but no amount; lowering without a known budget is exact', () => {
  const s = sug(campaign(flat('2026-11-07', '2026-11-09', GOOD), [lastRaise], { currentBudget: null }));
  assert.equal(s.action.key, 'raise');
  assert.equal(s.suggestedBudget, null);
  assert.equal(s.action.label, 'Subir 20 %');
});

test('a raise always moves at least one unit: 1 USD + 20 % -> 2 USD; amounts use the currency of the account', () => {
  const s = sug(campaign(flat('2026-11-07', '2026-11-09', GOOD), [lastRaise], { currentBudget: 1, currency: 'USD' }));
  assert.equal(s.suggestedBudget, 2);
  assert.equal(s.action.label, 'Subir 100 % → USD 2');
});

test('learned mode suggests the size of the best bucket (capped by maxRaisePct) and shows the evidence', () => {
  const learned = summarizeLearning([...many(7, 15, 6), ...many(2, 25, 1)], { life, thresholds });
  const s = sug(campaign(flat('2026-11-07', '2026-11-09', GOOD), [lastRaise], { currentBudget: 15000 }), learned);
  assert.equal(s.mode, 'learned');
  assert.equal(s.suggestedPct, 13, '15.000 -> 17.000 is +13 %');
  assert.equal(s.nominalPct, 15);
  assert.equal(s.suggestedBudget, 17000);
  assert.equal(s.reason, 'Según lo aprendido: de 9 subidas, ≤15 % mantuvo el ROAS en 6 de 7; 16–25 % en 1 de 2. Sugerido: +13 % → $17.000');
  assert.equal(s.evidence, 9);
  const capped = summarizeLearning([...many(5, 40, 5), ...many(4, 10, 1)], { life, thresholds });
  const c = sug(campaign(flat('2026-11-07', '2026-11-09', GOOD), [lastRaise], { currentBudget: 10000 }), capped);
  assert.equal(c.suggestedPct, 20, 'the learned 40 % is capped by maxRaisePct');
});

test('learning mode never claims to have learned', () => {
  const s = sug(campaign(flat('2026-11-07', '2026-11-09', GOOD), [lastRaise]));
  assert.equal(s.mode, 'learning');
  assert.match(s.reason, /Aprendiendo \(0 de 8 subidas medidas\)/);
  assert.doesNotMatch(s.reason, /Según lo aprendido/);
  assert.equal(s.evidence, 0);
});

// ---------- planDataStart + buildBudgetPlan (integration through the real report) ----------

const CFG = { ...DEFAULT_CONFIG, spendVatPct: 0, campaignPrefix: 'all', enabledCountries: ['CO', 'MX'] };
const TODAY2 = '2026-11-10';
const ins = (date, adId, campaignId, campaignName, gasto, mensajes, extra = {}) => ({ date, adId, adName: `Video ${adId}`, campaignId, campaignName, adsetId: `s-${campaignId}`, adsetName: 'Set', gasto, mensajes, country: 'CO', accountId: 'act_1', ...extra });
const sale = (date, adId, valor) => ({ registered: `${date} 10:00`, date, result: 'Pago válido', phone: '573001234567', valor, bank: 'Nequi', flow: 'Bebidas - aporte', adId, adLossy: false, adUrl: '', key: `${date}${adId}${valor}`.padEnd(20, '0').slice(0, 20) });
const identities = {
  A: { adName: 'Video A', campaignId: 'c1', campaignName: 'Cena navideña', accountId: 'act_1' },
  B: { adName: 'Video B', campaignId: 'c2', campaignName: 'Postres', accountId: 'act_2' },
};
const days = (from, to) => Object.keys(flat(from, to, 0));

function fixture() {
  const insights = [];
  const comprobantes = [];
  for (const d of days('2026-11-01', '2026-11-09')) {
    const after = d >= '2026-11-04';
    insights.push(ins(d, 'A', 'c1', 'Cena navideña', after ? 12000 : 10000, 20));
    comprobantes.push(sale(d, 'A', after ? 18000 : 15000), sale(d, 'A', after ? 18000 : 15000));
    insights.push(ins(d, 'B', 'c2', 'Postres', 5000, 5, { accountId: 'act_2', country: 'MX' }));
  }
  return {
    insights, comprobantes, identities, ads: {}, config: CFG, today: TODAY2, from: '2026-11-01', to: TODAY2,
    events: [raise('2026-11-04', 10000, 12000)],
    histories: { 'campaign|c1': [{ date: '2026-11-04', dailyBudget: 12000, firstSeen: Date.parse('2026-11-04T16:00:00Z') }], 'campaign|c2': [{ date: '2026-11-01', dailyBudget: 7000, firstSeen: 1 }] },
    accountMeta: { act_1: { name: 'Cuenta 1', currency: 'COP' }, act_2: { name: 'Cuenta 2', currency: 'COP' } },
    accounts: null,
  };
}

test('planDataStart reaches the windowDays before the oldest change, never before the loaded range', () => {
  const start = planDataStart({ changes: [{ date: '2026-10-20' }], from: '2026-11-01', today: '2026-11-10', life });
  assert.equal(start, '2026-10-17');
  assert.equal(planDataStart({ changes: [], from: '2026-11-01', today: '2026-11-10', life }), '2026-10-29');
});

test('buildBudgetPlan lists one timeline per campaign with before/after metrics, current budget and days since the last change', () => {
  const plan = buildBudgetPlan(fixture());
  const c1 = plan.campaigns.find((c) => c.campaignId === 'c1');
  assert.equal(c1.name, 'Cena navideña');
  assert.equal(c1.currentBudget, 12000);
  assert.equal(c1.daysSinceLastChange, 6);
  assert.equal(c1.lastChangeDate, '2026-11-04');
  assert.equal(c1.changes.length, 1);
  const ch = c1.changes[0];
  assert.equal(ch.status.key, 'worked');
  assert.equal(ch.before.gasto, 30000);
  assert.equal(ch.after.gasto, 36000);
  assert.equal(ch.before.ventas, 6);
  assert.equal(ch.after.valor, 108000);
  assert.ok(Math.abs(ch.after.roas - 3) < 1e-9);
  assert.equal(ch.after.costoVenta, 6000);
  assert.equal(plan.currency, 'COP');
  assert.equal(plan.learning.mode, 'learning');
  assert.equal(plan.learning.measured, 1);
});

test('buildBudgetPlan suggests for active campaigns only and never changes anything (pure)', () => {
  const data = fixture();
  const before = JSON.stringify(data);
  const plan = buildBudgetPlan(data);
  assert.equal(JSON.stringify(data), before, 'inputs are not mutated');
  const c1 = plan.campaigns.find((c) => c.campaignId === 'c1');
  assert.equal(c1.suggestion.action.key, 'raise');
  assert.equal(c1.suggestion.suggestedBudget, 14000);
  assert.equal(c1.suggestion.mode, 'learning');
  const stale = buildBudgetPlan({ ...data, insights: data.insights.filter((r) => r.campaignId !== 'c1' || r.date < '2026-11-05') });
  assert.equal(stale.campaigns.find((c) => c.campaignId === 'c1').suggestion, null, 'stopped spending 5 days ago -> not active');
});

test('buildBudgetPlan respects the account, country and search filters', () => {
  const data = fixture();
  assert.deepEqual(buildBudgetPlan(data).campaigns.map((c) => c.campaignId).sort(), ['c1', 'c2']);
  assert.deepEqual(buildBudgetPlan({ ...data, accounts: { all: false, ids: ['act_2'] } }).campaigns.map((c) => c.campaignId), ['c2']);
  assert.deepEqual(buildBudgetPlan({ ...data, country: 'MX' }).campaigns.map((c) => c.campaignId), ['c2']);
  assert.deepEqual(buildBudgetPlan({ ...data, names: ['postres'] }).campaigns.map((c) => c.campaignId), ['c2']);
  assert.deepEqual(buildBudgetPlan({ ...data, names: ['video a'] }).campaigns.map((c) => c.campaignId), ['c1'], 'search also matches ad names');
});

test('the search narrows the campaigns but the learning keeps using every campaign in the account scope', () => {
  const data = fixture();
  assert.equal(buildBudgetPlan({ ...data, names: ['postres'] }).learning.measured, 1);
});

test('the date range limits the timeline, not the learning or the "last change" of the campaign', () => {
  const data = fixture();
  const plan = buildBudgetPlan({ ...data, from: '2026-11-08', to: '2026-11-10' });
  const c1 = plan.campaigns.find((c) => c.campaignId === 'c1');
  assert.equal(c1.changes.length, 0);
  assert.equal(c1.lastChangeDate, '2026-11-04');
  assert.equal(plan.learning.measured, 1);
});

test('campaign cuts show up in the timeline as BAJÓ and are not counted as measured raises', () => {
  const data = fixture();
  const plan = buildBudgetPlan({ ...data, events: [...data.events, raise('2026-11-06', 12000, 9000)] });
  const c1 = plan.campaigns.find((c) => c.campaignId === 'c1');
  assert.deepEqual(c1.changes.map((c) => c.kind), ['cut', 'raise'], 'newest first');
  assert.equal(c1.changes[0].status.label, 'BAJÓ');
  assert.equal(c1.changes.find((c) => c.kind === 'raise').status.key, 'overlap', 'the cut came inside the window of the raise');
  assert.equal(plan.learning.measured, 0);
});

test('an ad set budget change of the campaign mixes the campaign raise', () => {
  const data = fixture();
  const adsetChange = { entityType: 'adset', entityId: 's-c1', date: '2026-11-05', time: 1, oldBudget: 5000, newBudget: 6000, exact: true };
  const plan = buildBudgetPlan({ ...data, events: [...data.events, adsetChange] });
  assert.equal(plan.campaigns.find((c) => c.campaignId === 'c1').changes[0].status.key, 'overlap');
});

test('budget amounts keep the currency of the account while metrics use the base currency', () => {
  const data = fixture();
  const plan = buildBudgetPlan({ ...data, accountMeta: { ...data.accountMeta, act_2: { name: 'Cuenta 2', currency: 'USD' } }, fxRates: {} });
  const c2 = plan.campaigns.find((c) => c.campaignId === 'c2');
  assert.equal(c2, undefined, 'without a USD -> COP rate the spend cannot be converted, so the campaign has no data (a warning is reported)');
  assert.ok(plan.warnings.length >= 1);
});

test('buildBudgetPlan with no budget data at all returns an empty plan with the learning state', () => {
  const plan = buildBudgetPlan({ ...fixture(), events: [], histories: {}, insights: [], comprobantes: [] });
  assert.deepEqual(plan.campaigns, []);
  assert.equal(plan.learning.measured, 0);
});
