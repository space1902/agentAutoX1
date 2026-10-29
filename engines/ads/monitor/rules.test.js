import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, filterAlerts, shouldSendSummary, buildSummary, cpaColor } from './rules.js';
import { DEFAULT_CONFIG } from './config.js';

const TZ = 'America/Bogota';
// 2026-10-25 15:00 in Bogota
const NOW = Date.parse('2026-10-25T20:00:00Z');
const min = (n) => n * 60_000;

const ad = (over = {}) => ({
  id: 'a1', name: 'Video 1', campaignId: 'c1', campaignName: 'CT01', adsetId: 's1', status: 'ACTIVE',
  spend: 0, impressions: 0, clicks: 0, frequency: 1, purchases: 0, conversations: 0, ...over,
});

const snap = (over = {}) => ({
  account: { status: 1, disableReason: 0, spendCap: 0, amountSpent: 0 },
  ads: [ad()],
  sales: { accountLastTs: NOW - min(10), ads: {} },
  windows: { spend2h: null, conversations3h: null, purchases3h: null },
  ...over,
});

const run = (snapshot, extra = {}) =>
  evaluate({ now: NOW, tz: TZ, config: DEFAULT_CONFIG, baseline: null, snapshot, ...extra });
const byType = (alerts, type) => alerts.filter((a) => a.type === type);

test('no alerts for a healthy account', () => {
  assert.deepEqual(run(snap({ ads: [ad({ spend: 500, purchases: 1 })], sales: { accountLastTs: NOW - min(5), ads: { a1: { ts: NOW - min(5), spendAt: 0 } } } })), []);
});

test('ad with spend since last sale >= target warns (worry)', () => {
  const alerts = run(snap({ ads: [ad({ spend: 2600 })] }));
  const a = byType(alerts, 'ad_no_sale');
  assert.equal(a.length, 1);
  assert.equal(a[0].level, 'worry');
  assert.equal(a[0].severity, 1);
  assert.equal(a[0].adName, 'Video 1');
  assert.equal(a[0].spentSinceSale, 2600);
  assert.equal(a[0].actions, undefined);
});

test('spend since last sale counts only what was spent after that sale', () => {
  const s = snap({
    ads: [ad({ spend: 4000, purchases: 1 })],
    sales: { accountLastTs: NOW - min(5), ads: { a1: { ts: NOW - min(5), spendAt: 3000 } } },
  });
  assert.equal(byType(run(s), 'ad_no_sale').length, 0);
});

test('ad with spend since last sale >= review requests pausing it', () => {
  const alerts = run(snap({ ads: [ad({ spend: 5200 })] }));
  const a = byType(alerts, 'ad_no_sale')[0];
  assert.equal(a.level, 'action');
  assert.equal(a.severity, 2);
  assert.deepEqual(a.actions, [{ kind: 'pause_adset', targetId: 's1', adId: 'a1', label: 'Video 1' }]);
  assert.equal(byType(alerts, 'ad_no_sale').length, 1, 'escalation replaces the lower level');
});

test('paused ads never trigger no-sale alerts', () => {
  const alerts = run(snap({ ads: [ad({ spend: 9000, status: 'PAUSED' })] }));
  assert.equal(byType(alerts, 'ad_no_sale').length, 0);
});

test('family key changes with the last sale so a new episode can alert again', () => {
  const a = byType(run(snap({ ads: [ad({ spend: 2600 })] })), 'ad_no_sale')[0];
  const b = byType(
    run(snap({ ads: [ad({ spend: 6000, purchases: 1 })], sales: { accountLastTs: NOW - min(5), ads: { a1: { ts: 111, spendAt: 3000 } } } })),
    'ad_no_sale',
  )[0];
  assert.notEqual(a.family, b.family);
});

test('account gap: 45 min without sales is a worry', () => {
  const alerts = run(snap({ sales: { accountLastTs: NOW - min(50), ads: {} } }));
  const g = byType(alerts, 'account_gap');
  assert.equal(g.length, 1);
  assert.equal(g[0].level, 'worry');
  assert.equal(g[0].minutes, 50);
  assert.equal(g[0].thresholdMin, 45);
});

test('account gap: 60 min asks for confirmation and suggests ads to pause', () => {
  const s = snap({
    ads: [ad({ id: 'a1', name: 'Uno', spend: 3000 }), ad({ id: 'a2', name: 'Dos', spend: 4500 }), ad({ id: 'a3', name: 'Tres', spend: 100 })],
    sales: { accountLastTs: NOW - min(65), ads: {} },
  });
  const g = byType(run(s), 'account_gap')[0];
  assert.equal(g.level, 'action');
  assert.deepEqual(g.actions.map((x) => x.adId), ['a2', 'a1']);
  assert.equal(g.actions[0].kind, 'pause_adset');
});

test('account gap uses the adaptive thresholds from the baseline', () => {
  const baseline = { days: 5, account: { bandSalesPerHour: Array(24).fill(0.5) }, ads: {} };
  const quiet = run(snap({ sales: { accountLastTs: NOW - min(65), ads: {} } }), { baseline });
  assert.equal(byType(quiet, 'account_gap').length, 0, 'floors would alert at 65 min, the adaptive 90 does not');
  const alerts = run(snap({ sales: { accountLastTs: NOW - min(95), ads: {} } }), { baseline });
  const g = byType(alerts, 'account_gap')[0];
  assert.equal(g.level, 'worry');
  assert.equal(g.thresholdMin, 90);
  const far = run(snap({ sales: { accountLastTs: NOW - min(125), ads: {} } }), { baseline });
  assert.equal(byType(far, 'account_gap')[0].level, 'action');
});

test('account gap is silent outside active hours', () => {
  const night = Date.parse('2026-10-25T09:00:00Z'); // 04:00 Bogota
  const alerts = evaluate({
    now: night, tz: TZ, config: DEFAULT_CONFIG, baseline: null,
    snapshot: snap({ sales: { accountLastTs: night - min(300), ads: {} } }),
  });
  assert.equal(byType(alerts, 'account_gap').length, 0);
});

test('account gap with no sale today counts from the start of active hours', () => {
  // 15:00 local, active start 07:00 -> 480 min
  const g = byType(run(snap({ sales: { accountLastTs: null, ads: {} } })), 'account_gap')[0];
  assert.equal(g.minutes, 480);
});

test('account gap is silent when no ad is active', () => {
  const alerts = run(snap({ ads: [ad({ status: 'PAUSED' })], sales: { accountLastTs: NOW - min(200), ads: {} } }));
  assert.equal(byType(alerts, 'account_gap').length, 0);
});

test('disapproved and with-issues ads raise critical alerts', () => {
  const alerts = run(snap({ ads: [ad({ status: 'DISAPPROVED' }), ad({ id: 'a2', name: 'Dos', status: 'WITH_ISSUES' })] }));
  const s = byType(alerts, 'ad_status');
  assert.equal(s.length, 2);
  assert.ok(s.every((a) => a.level === 'critical'));
});

test('account not active raises a critical alert', () => {
  const alerts = run(snap({ account: { status: 2, disableReason: 1, spendCap: 0, amountSpent: 0 } }));
  assert.equal(byType(alerts, 'account_status')[0].level, 'critical');
});

test('spend cap reached raises a critical alert', () => {
  const alerts = run(snap({ account: { status: 1, disableReason: 0, spendCap: 1000000, amountSpent: 1000000 } }));
  assert.equal(byType(alerts, 'spend_cap').length, 1);
  const ok = run(snap({ account: { status: 1, disableReason: 0, spendCap: 1000000, amountSpent: 10 } }));
  assert.equal(byType(ok, 'spend_cap').length, 0);
});

test('active ad with no spend for 2h inside active hours', () => {
  const alerts = run(snap({ windows: { spend2h: { a1: 0 }, conversations3h: null, purchases3h: null } }));
  assert.equal(byType(alerts, 'ad_no_spend').length, 1);
  const spending = run(snap({ windows: { spend2h: { a1: 300 }, conversations3h: null, purchases3h: null } }));
  assert.equal(byType(spending, 'ad_no_spend').length, 0);
  const unknown = run(snap());
  assert.equal(byType(unknown, 'ad_no_spend').length, 0);
});

test('conversations without purchases for 3h signals broken tracking', () => {
  const alerts = run(snap({ windows: { spend2h: null, conversations3h: 25, purchases3h: 0 } }));
  assert.equal(byType(alerts, 'pixel_suspect').length, 1);
  assert.equal(byType(run(snap({ windows: { spend2h: null, conversations3h: 25, purchases3h: 2 } })), 'pixel_suspect').length, 0);
  assert.equal(byType(run(snap({ windows: { spend2h: null, conversations3h: 3, purchases3h: 0 } })), 'pixel_suspect').length, 0);
});

const baseline = {
  days: 5, account: { bandSalesPerHour: Array(24).fill(4) },
  ads: { a1: { cpa: 2000, costPerConversation: 400, ctr: 2, cpm: 5000 } },
};

test('cost per conversation above 1.5x baseline', () => {
  const s = snap({ ads: [ad({ spend: 3100, conversations: 5, purchases: 1, impressions: 5000 })], sales: { accountLastTs: NOW - min(2), ads: { a1: { ts: NOW - min(2), spendAt: 2900 } } } });
  const a = byType(run(s, { baseline }), 'cost_per_conversation');
  assert.equal(a.length, 1);
  assert.equal(a[0].current, 620);
  assert.equal(a[0].baseline, 400);
  const fine = snap({ ads: [ad({ spend: 2000, conversations: 5, purchases: 1, impressions: 5000 })], sales: s.sales });
  assert.equal(byType(run(fine, { baseline }), 'cost_per_conversation').length, 0);
});

test('cost per conversation needs a minimum of conversations', () => {
  const s = snap({ ads: [ad({ spend: 3000, conversations: 2, purchases: 1 })], sales: { accountLastTs: NOW - min(2), ads: { a1: { ts: NOW - min(2), spendAt: 2900 } } } });
  assert.equal(byType(run(s, { baseline }), 'cost_per_conversation').length, 0);
});

test('frequency above the limit', () => {
  const s = snap({ ads: [ad({ frequency: 2.8, impressions: 2000 })] });
  assert.equal(byType(run(s), 'frequency').length, 1);
  assert.equal(byType(run(snap({ ads: [ad({ frequency: 2.4, impressions: 2000 })] })), 'frequency').length, 0);
});

test('CTR below 60% of baseline and CPM above 140%', () => {
  const lowCtr = snap({ ads: [ad({ impressions: 5000, clicks: 50, spend: 100 })] }); // ctr 1.0 vs 2 -> 50%
  assert.equal(byType(run(lowCtr, { baseline }), 'ctr_drop').length, 1);
  const okCtr = snap({ ads: [ad({ impressions: 5000, clicks: 80, spend: 100 })] }); // 1.6 -> 80%
  assert.equal(byType(run(okCtr, { baseline }), 'ctr_drop').length, 0);
  const highCpm = snap({ ads: [ad({ impressions: 5000, clicks: 100, spend: 40000 })] }); // cpm 8000 vs 5000 -> 160%
  assert.equal(byType(run(highCpm, { baseline }), 'cpm_rise').length, 1);
});

test('CTR and CPM comparisons need a minimum of impressions', () => {
  const few = snap({ ads: [ad({ impressions: 200, clicks: 1, spend: 5000 })] });
  assert.equal(byType(run(few, { baseline }), 'ctr_drop').length, 0);
  assert.equal(byType(run(few, { baseline }), 'cpm_rise').length, 0);
});

test('every alert has family, severity and level', () => {
  const alerts = run(snap({ ads: [ad({ spend: 6000, status: 'DISAPPROVED', frequency: 3, impressions: 3000 })] }));
  for (const a of alerts) {
    assert.ok(a.family && a.type && a.level && [1, 2].includes(a.severity), JSON.stringify(a));
  }
});

// --- de-duplication -------------------------------------------------------

test('filterAlerts suppresses the same family inside the cooldown', () => {
  const alert = { family: 'f', severity: 1, type: 't' };
  const last = { f: { ts: NOW - min(30), severity: 1 } };
  assert.equal(filterAlerts([alert], last, NOW, 60).length, 0);
  assert.equal(filterAlerts([alert], { f: { ts: NOW - min(61), severity: 1 } }, NOW, 60).length, 1);
  assert.equal(filterAlerts([alert], {}, NOW, 60).length, 1);
});

test('filterAlerts lets an escalation through and blocks a downgrade', () => {
  const worry = { family: 'f', severity: 1 };
  const action = { family: 'f', severity: 2 };
  assert.equal(filterAlerts([action], { f: { ts: NOW - min(5), severity: 1 } }, NOW, 60).length, 1);
  assert.equal(filterAlerts([worry], { f: { ts: NOW - min(5), severity: 2 } }, NOW, 60).length, 0);
});

// --- summary --------------------------------------------------------------

test('cpaColor follows the thresholds', () => {
  const t = DEFAULT_CONFIG.thresholds;
  assert.equal(cpaColor(2500, t), 'green');
  assert.equal(cpaColor(2501, t), 'yellow');
  assert.equal(cpaColor(5000, t), 'yellow');
  assert.equal(cpaColor(5001, t), 'red');
  assert.equal(cpaColor(null, t), 'none');
});

test('shouldSendSummary fires once per active hour', () => {
  assert.equal(shouldSendSummary({ now: NOW, tz: TZ, config: DEFAULT_CONFIG, lastKey: null }).send, true);
  const key = shouldSendSummary({ now: NOW, tz: TZ, config: DEFAULT_CONFIG, lastKey: null }).key;
  assert.equal(shouldSendSummary({ now: NOW, tz: TZ, config: DEFAULT_CONFIG, lastKey: key }).send, false);
  const night = Date.parse('2026-10-25T09:00:00Z');
  assert.equal(shouldSendSummary({ now: night, tz: TZ, config: DEFAULT_CONFIG, lastKey: null }).send, false);
});

test('buildSummary lists ads with spend or sales and totals', () => {
  const s = buildSummary({
    config: DEFAULT_CONFIG,
    ads: [
      ad({ id: 'a1', name: 'Uno', spend: 5000, purchases: 4 }),
      ad({ id: 'a2', name: 'Dos', spend: 9000, purchases: 1 }),
      ad({ id: 'a3', name: 'Tres', spend: 3000, purchases: 0 }),
      ad({ id: 'a4', name: 'Cuatro', spend: 0, purchases: 0 }),
    ],
  });
  assert.equal(s.rows.length, 3);
  assert.equal(s.rows[0].adName, 'Dos', 'sorted by spend desc');
  assert.equal(s.rows.find((r) => r.adName === 'Uno').color, 'green');
  assert.equal(s.rows.find((r) => r.adName === 'Dos').color, 'red');
  assert.equal(s.rows.find((r) => r.adName === 'Tres').color, 'yellow');
  assert.equal(s.totals.spend, 17000);
  assert.equal(s.totals.purchases, 5);
  assert.equal(s.totals.cpa, 3400);
  assert.equal(s.totals.color, 'yellow');
});
