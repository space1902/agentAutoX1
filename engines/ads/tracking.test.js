import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeChanges } from './budget.js';
import { DEFAULT_CONFIG } from './config.js';
import { buildTracking, raisesByAd } from './tracking.js';

const ins = (date, adId, campaignName, adsetId, gasto = 1000) => ({ date, adId, adName: `Ad ${adId}`, campaignId: `c-${adId}`, campaignName, adsetId, adsetName: `Set ${adsetId}`, gasto });
const insights = [
  ins('2026-10-26', 'A', 'CT01 Col', 's1'), ins('2026-10-27', 'A', 'CT01 Col', 's1'), ins('2026-10-28', 'A', 'CT01 Col', 's1'), ins('2026-10-29', 'A', 'CT01 Col', 's1'),
  ins('2026-10-28', 'B', 'CT01 Col', 's2'), ins('2026-10-29', 'B', 'CT01 Col', 's2'),
  ins('2026-10-01', 'OLD', 'CT09 Col', 's9'), ins('2026-10-05', 'OLD', 'CT09 Col', 's9'),
  ins('2026-10-27', 'X', 'Branding', 's5'), ins('2026-10-29', 'X', 'Branding', 's5'),
];
const ads = { A: { firstSpendDate: '2026-10-26' }, B: { firstSpendDate: '2026-10-28' }, OLD: { firstSpendDate: '2026-10-01' }, X: { firstSpendDate: '2026-10-27' } };
const hist = (date, daily) => ({ date, dailyBudget: daily, lifetimeBudget: null, firstSeen: 0 });
const changes = computeChanges({ histories: { 'adset|s1': [hist('2026-10-20', 10000), hist('2026-10-27', 13000)] }, events: [] });
const base = { insights, ads, changes, config: DEFAULT_CONFIG, today: '2026-10-29' };

test('every ad that is still spending gets "day N since it started to spend"', () => {
  const t = buildTracking(base);
  const a = t.items.find((i) => i.kind === 'ad' && i.id === 'A');
  assert.equal(a.dayN, 4);
  assert.equal(a.firstSpendDate, '2026-10-26');
  assert.equal(t.items.find((i) => i.kind === 'ad' && i.id === 'B').dayN, 2);
});

test('ads still in the test show when the automatic verdict will come', () => {
  const t = buildTracking(base);
  const b = t.items.find((i) => i.kind === 'ad' && i.id === 'B');
  assert.equal(b.inTest, true);
  assert.equal(b.testDays, 5);
  assert.equal(b.verdictDay, 4);
  assert.equal(b.verdictAt, '20:00');
  assert.equal(b.verdictDate, '2026-10-31');
  assert.equal(t.items.find((i) => i.kind === 'ad' && i.id === 'A').inTest, true);
});

test('stopped ads and ads outside the prefix are not listed', () => {
  const ids = buildTracking(base).items.map((i) => `${i.kind}:${i.id}`);
  assert.equal(ids.includes('ad:OLD'), false);
  assert.equal(ids.includes('ad:X'), false);
});

test('a CT counts from the first day any of its ads spent', () => {
  const ct = buildTracking(base).items.find((i) => i.kind === 'ct' && i.id === 'CT 01');
  assert.equal(ct.dayN, 4);
  assert.equal(ct.firstSpendDate, '2026-10-26');
});

test('budget raises add "day N since the raise (date, +%)" to the ads and to their own item', () => {
  const t = buildTracking(base);
  const a = t.items.find((i) => i.kind === 'ad' && i.id === 'A');
  assert.deepEqual([a.raise.date, a.raise.dayN, Math.round(a.raise.pct), a.raise.exact], ['2026-10-27', 3, 30, false]);
  assert.equal(t.items.find((i) => i.kind === 'ad' && i.id === 'B').raise, null, 'a different ad set is not affected');
  const raise = t.items.find((i) => i.kind === 'budget');
  assert.equal(raise.label, 'Set s1');
  assert.equal(raise.dayN, 3);
  assert.equal(raise.checkDay, 2);
  assert.equal(raise.checkAt, '20:00');
});

test('old raises disappear from the follow-up', () => {
  const old = computeChanges({ histories: { 'adset|s1': [hist('2026-09-01', 10000), hist('2026-09-05', 13000)] }, events: [] });
  const t = buildTracking({ ...base, changes: old });
  assert.equal(t.items.some((i) => i.kind === 'budget'), false);
  assert.equal(t.items.find((i) => i.kind === 'ad' && i.id === 'A').raise, null);
});

test('raisesByAd maps ad sets and campaigns (CBO) to their ads and keeps the latest', () => {
  const cbo = computeChanges({ histories: { 'campaign|c-B': [hist('2026-10-20', 1), hist('2026-10-28', 2)], 'adset|s2': [hist('2026-10-20', 1), hist('2026-10-26', 2)] }, events: [] });
  const map = raisesByAd({ insights, changes: cbo, today: '2026-10-29', maxAgeDays: 14 });
  assert.equal(map.B.date, '2026-10-28', 'the latest of the ad set and campaign raises');
  assert.equal(map.B.dayN, 2);
  assert.equal(map.A, undefined);
});
