import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createStore, openStoreAt } from './store.js';

const row = (date, adId, gasto, extra = {}) => ({
  date, adId, adName: `Ad ${adId}`, campaignId: 'c1', campaignName: 'CT01 - ventas', adsetId: 's1', adsetName: 'Set', gasto, impressions: 100, clicks: 5, mensajes: 3, ...extra,
});
const ad = (adId, extra = {}) => ({
  adId, name: `Ad ${adId}`, createdTime: '2026-10-25T10:00:00-0500', effectiveStatus: 'ACTIVE', campaignId: 'c1', campaignName: 'CT01 - ventas',
  campaignDailyBudget: null, campaignLifetimeBudget: null, adsetId: 's1', adsetName: 'Set', adsetDailyBudget: 5000000, adsetLifetimeBudget: null, ...extra,
});

test('upsertInsights keeps past days and updates a day in place', () => {
  const s = createStore();
  s.upsertInsights([row('2026-10-27', 'A', 1000), row('2026-10-28', 'A', 500)], 1);
  s.upsertInsights([row('2026-10-28', 'A', 800)], 2);
  const rows = s.insightsBetween('2026-10-01', '2026-10-31');
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.date === '2026-10-28').gasto, 800);
  assert.equal(rows.find((r) => r.date === '2026-10-27').gasto, 1000);
  assert.deepEqual(s.insightsBetween('2026-10-28', '2026-10-28').map((r) => r.date), ['2026-10-28']);
});

test('identities returns the latest names per ad', () => {
  const s = createStore();
  s.upsertInsights([row('2026-10-27', 'A', 1, { adName: 'Viejo' }), row('2026-10-28', 'A', 1, { adName: 'Nuevo' })], 1);
  assert.equal(s.identities().A.adName, 'Nuevo');
  assert.equal(s.identities().A.campaignName, 'CT01 - ventas');
});

test('upsertAds stores metadata and exposes it as a map', () => {
  const s = createStore();
  s.upsertAds([ad('A'), ad('B', { effectiveStatus: 'PAUSED' })], 1);
  s.upsertAds([ad('B', { effectiveStatus: 'ACTIVE' })], 2);
  const map = s.adsMap();
  assert.equal(map.A.createdTime, '2026-10-25T10:00:00-0500');
  assert.equal(map.B.effectiveStatus, 'ACTIVE');
});

test('budget history records only changes with their first_seen timestamp', () => {
  const s = createStore();
  s.recordBudgets([ad('A')], '2026-10-27', 1000);
  s.recordBudgets([ad('A')], '2026-10-28', 2000);
  s.recordBudgets([ad('A', { adsetDailyBudget: 7500000 })], '2026-10-29', 3000);
  s.recordBudgets([ad('A', { adsetDailyBudget: 7500000 })], '2026-10-29', 4000);
  const hist = s.budgetHistory('adset', 's1');
  assert.equal(hist.length, 2);
  assert.deepEqual(hist.map((h) => [h.date, h.dailyBudget, h.firstSeen]), [['2026-10-27', 5000000, 1000], ['2026-10-29', 7500000, 3000]]);
});

test('budget history ignores entities without a budget and tracks campaign budgets separately', () => {
  const s = createStore();
  s.recordBudgets([ad('A', { adsetDailyBudget: null, campaignDailyBudget: 9000000 })], '2026-10-27', 1);
  assert.equal(s.budgetHistory('adset', 's1').length, 0);
  assert.equal(s.budgetHistory('campaign', 'c1')[0].dailyBudget, 9000000);
});

test('replaceComprobantes swaps the whole cache atomically', () => {
  const s = createStore();
  const c = (date, valor) => ({ registered: `${date} 10:00`, date, result: 'Pago válido', phone: '573001234567', valor, bank: 'Nequi', flow: 'Bebidas - aporte', adId: 'A', adLossy: false, adUrl: '' });
  s.replaceComprobantes([c('2026-10-27', 1000), c('2026-10-28', 2000)], 1);
  s.replaceComprobantes([c('2026-10-28', 3000)], 2);
  const rows = s.comprobantesBetween('2026-10-01', '2026-10-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].valor, 3000);
  assert.equal(rows[0].adLossy, false);
  assert.equal(rows[0].phone, '573001234567');
});

test('kv stores JSON values and counts summarise the tables', () => {
  const s = createStore();
  assert.equal(s.getKv('x'), null);
  s.setKv('x', { a: 1 });
  s.setKv('x', { a: 2 });
  assert.deepEqual(s.getKv('x'), { a: 2 });
  s.upsertInsights([row('2026-10-28', 'A', 1)], 1);
  assert.deepEqual(s.counts(), { insights: 1, ads: 0, comprobantes: 0, budgets: 0 });
});

test('openStoreAt creates <data dir>/ads/ads.db and reopens it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-store-'));
  const a = openStoreAt(dir);
  a.upsertInsights([row('2026-10-28', 'A', 10)], 1);
  a.close();
  assert.equal(fs.existsSync(path.join(dir, 'ads', 'ads.db')), true);
  const b = openStoreAt(dir);
  assert.equal(b.insightsBetween('2026-10-28', '2026-10-28')[0].gasto, 10);
  b.close();
});
