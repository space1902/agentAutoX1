import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBaseline, adaptiveGaps, recommendThresholds } from './baseline.js';
import { DEFAULT_CONFIG } from './config.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// 5 days. Ad a1: 2 sales at hour 10 and 1 at hour 11, spend 4000 in each of those hours.
// Ad a2: no sales, spend 1000 at hour 11.
const rows = [];
for (let d = 20; d <= 24; d++) {
  const date = `2026-10-${d}`;
  rows.push({ date, hour: 10, adId: 'a1', adName: 'A1', spend: 4000, impressions: 1000, clicks: 20, purchases: 2, conversations: 6 });
  rows.push({ date, hour: 11, adId: 'a1', adName: 'A1', spend: 4000, impressions: 1000, clicks: 10, purchases: 1, conversations: 3 });
  rows.push({ date, hour: 11, adId: 'a2', adName: 'A2', spend: 1000, impressions: 500, clicks: 5, purchases: 0, conversations: 1 });
}

test('computeBaseline derives per-hour account sales and per-ad figures', () => {
  const b = computeBaseline(rows);
  assert.equal(b.days, 5);
  assert.equal(b.account.salesPerHour[10], 2);
  assert.equal(b.account.salesPerHour[11], 1);
  assert.equal(b.account.salesPerHour[3], 0);
  assert.equal(b.account.salesPerDay, 3);
  close(b.account.cpa, 9000 / 3);
  const a1 = b.ads.a1;
  close(a1.cpa, 8000 / 3);
  close(a1.costPerConversation, 8000 / 9);
  close(a1.ctr, (150 / 10000) * 100);
  close(a1.cpm, (40000 / 10000) * 1000);
  assert.equal(b.ads.a2.cpa, null);
});

test('computeBaseline with no rows reports zero days', () => {
  const b = computeBaseline([]);
  assert.equal(b.days, 0);
  assert.equal(b.account.salesPerHour.length, 24);
});

test('band rate smooths each hour with its neighbours', () => {
  const b = computeBaseline(rows);
  close(b.account.bandSalesPerHour[10], 1); // (0 + 2 + 1) / 3
});

test('adaptiveGaps never goes below the configured floors', () => {
  const b = { days: 5, account: { bandSalesPerHour: Array(24).fill(4) } };
  const g = adaptiveGaps(b, 12, DEFAULT_CONFIG);
  assert.equal(g.worryMin, 45);
  assert.equal(g.actionMin, 60);
});

test('adaptiveGaps widens when fewer than 1 sale per hour is expected, capped at 3h', () => {
  const half = { days: 5, account: { bandSalesPerHour: Array(24).fill(0.5) } };
  const g = adaptiveGaps(half, 12, DEFAULT_CONFIG);
  assert.equal(g.expectedGapMin, 120);
  assert.equal(g.actionMin, 120);
  assert.equal(g.worryMin, 90);
  const none = { days: 5, account: { bandSalesPerHour: Array(24).fill(0) } };
  const g2 = adaptiveGaps(none, 12, DEFAULT_CONFIG);
  assert.equal(g2.actionMin, 180);
  assert.equal(g2.worryMin, 135);
});

test('adaptiveGaps falls back to the floors without baseline data', () => {
  assert.deepEqual(
    [adaptiveGaps(null, 12, DEFAULT_CONFIG).worryMin, adaptiveGaps(null, 12, DEFAULT_CONFIG).actionMin],
    [45, 60],
  );
  const g2 = adaptiveGaps({ days: 0, account: { bandSalesPerHour: Array(24).fill(0) } }, 12, DEFAULT_CONFIG);
  assert.equal(g2.actionMin, 60);
});

test('adaptiveGaps respects raised floors', () => {
  const cfg = { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds, gapWorryMin: 60, gapActionMin: 90 } };
  const b = { days: 5, account: { bandSalesPerHour: Array(24).fill(4) } };
  const g = adaptiveGaps(b, 12, cfg);
  assert.equal(g.worryMin, 60);
  assert.equal(g.actionMin, 90);
});

test('recommendThresholds suggests values only when they differ meaningfully', () => {
  const recs = recommendThresholds(computeBaseline(rows), DEFAULT_CONFIG);
  const target = recs.find((r) => r.name === 'targetCpa');
  assert.ok(target);
  assert.equal(target.current, 2500);
  assert.equal(target.recommended, 3300); // 3000 * 1.1
  const review = recs.find((r) => r.name === 'reviewCpa');
  assert.equal(review.recommended, 6600); // keeps review = 2x target
});

test('recommendThresholds skips values within 10% of the current ones', () => {
  const close2500 = rows.map((r) => ({ ...r, spend: r.spend * 0.75 })); // cpa 2250 -> target 2500
  const recs = recommendThresholds(computeBaseline(close2500), DEFAULT_CONFIG);
  assert.equal(recs.find((r) => r.name === 'targetCpa'), undefined);
});

test('recommendThresholds returns nothing without enough data', () => {
  assert.deepEqual(recommendThresholds(computeBaseline([]), DEFAULT_CONFIG), []);
});

test('recommendThresholds proposes tighter floors when sales volume is high', () => {
  const dense = [];
  for (let d = 20; d <= 24; d++) {
    for (let h = 7; h < 23; h++) {
      dense.push({ date: `2026-10-${d}`, hour: h, adId: 'a1', adName: 'A1', spend: 2000, impressions: 1000, clicks: 20, purchases: 2, conversations: 3 });
    }
  }
  const worry = recommendThresholds(computeBaseline(dense), DEFAULT_CONFIG).find((r) => r.name === 'gapWorryMin');
  assert.ok(worry && worry.recommended < 45);
});
