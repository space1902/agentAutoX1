// Gone-from-sheet payments and manual rejection: neither counts anywhere; both stay visible in the list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AdsError, runAdsCommand } from './ads-api.js';
import { DEFAULT_CONFIG } from './config.js';
import { evaluateDue } from './decisions.js';
import { todaySales } from './monitor/sheet-sales.js';
import { buildReport } from './report.js';
import { createStore, keyRows, openStoreAt } from './store.js';

const NO_VAT = { ...DEFAULT_CONFIG, spendVatPct: 0 };
const row = (registered, date, result, extra = {}) => ({
  registered, date, result, phone: '573001234567', valor: 60000, bank: 'Nequi', flow: 'Bebidas - aporte', adId: 'A', adLossy: false, adUrl: '', ...extra,
});
const V1 = row('28/10/2026 11:00:00', '2026-10-28', 'Pago válido', { phone: '573009998888' });
const V2 = row('28/10/2026 12:00:00', '2026-10-28', 'Pago válido', { phone: '573007776666' });
const REVIEW = row('28/10/2026 10:00:00', '2026-10-28', 'Nombre a revisar');
const identities = { A: { adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas' } };
const insights = [{ date: '2026-10-28', adId: 'A', adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas', adsetId: 's', adsetName: 'S', gasto: 30000, mensajes: 10, country: '' }];
const all = (store) => store.comprobantesBetween('2026-10-01', '2026-10-31');
const report = (store, over = {}) => buildReport({
  insights, comprobantes: all(store), identities, config: NO_VAT, from: '2026-10-28', to: '2026-10-28', today: '2026-10-29', ...over,
});
const keyOf = (store, phone) => all(store).find((c) => c.phone === phone).key;
const NO_KEY = '0'.repeat(20);

test('a payment gone from the sheet stops counting everywhere but stays listed; it counts again when it reappears', () => {
  const store = createStore(':memory:');
  store.syncComprobantes([V1, V2], 1);
  assert.equal(report(store).kpis.ventas, 2);
  store.syncComprobantes([V1], 2);
  const r = report(store);
  assert.equal(r.kpis.ventas, 1);
  assert.equal(r.kpis.valor, 60000);
  assert.equal(r.rows[0].ventas, 1);
  assert.equal(r.daily.find((d) => d.date === '2026-10-28').ventas, 1);
  assert.equal(r.campaignDaily[0].daily.find((d) => d.date === '2026-10-28').valor, 60000);
  assert.equal(r.comprobantes.length, 2, 'the gone one is still listed');
  assert.equal(r.comprobantes.find((c) => c.phone === '573007776666').gone, true);
  assert.equal(r.reviewCount, 0, 'gone rows are not pending');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM v_sales').get().n, 1);
  store.syncComprobantes([V1, V2], 3);
  assert.equal(report(store).kpis.ventas, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM v_sales').get().n, 2);
});

test('an accepted payment that is gone from the sheet does not count either', () => {
  const store = createStore(':memory:');
  store.syncComprobantes([V1, REVIEW], 1);
  store.setAccepted(keyOf(store, REVIEW.phone), true, 2);
  assert.equal(report(store).kpis.ventas, 2);
  store.syncComprobantes([V1], 3);
  assert.equal(report(store).kpis.ventas, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM v_sales').get().n, 1);
});

test('setRejected: unknown keys return false, rejection survives re-syncs and wins over acceptance', () => {
  const store = createStore(':memory:');
  store.syncComprobantes([V1, REVIEW], 1);
  assert.equal(store.setRejected(NO_KEY, true, 2), false);
  const key = keyOf(store, V1.phone);
  assert.equal(store.setRejected(key, true, 2), true);
  store.syncComprobantes([V1, REVIEW], 3);
  assert.equal(all(store).find((c) => c.key === key).rejected, true);
  const r = report(store);
  assert.equal(r.kpis.ventas, 0);
  assert.equal(r.kpis.valor, 0);
  const item = r.comprobantes.find((c) => c.key === key);
  assert.equal(item.rejected, true);
  assert.equal(item.status, 'rejected');
  assert.equal(r.reviewCount, 1, 'only the review row is pending');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM v_sales').get().n, 0);

  // Reject wins over accept (defensive: the engine command refuses to accept a rejected payment).
  const reviewKey = keyOf(store, REVIEW.phone);
  store.setAccepted(reviewKey, true, 4);
  store.setRejected(reviewKey, true, 5);
  assert.equal(report(store).kpis.ventas, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM v_sales').get().n, 0);

  assert.equal(store.setRejected(key, false, 6), true);
  assert.equal(report(store).kpis.ventas, 1);
  assert.equal(store.rejectedKeys().has(key), false);
});

test('decisions ignore gone and rejected payments', () => {
  const store = createStore(':memory:');
  const days = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'];
  const spend = days.map((d) => ({ ...insights[0], date: d, gasto: 10000 }));
  const valid = ['2026-10-26', '2026-10-27', '2026-10-28'].map((d, i) => row(`${d.slice(8)}/10/2026 10:00:00`, d, 'Pago válido', { phone: `57300000000${i}` }));
  store.syncComprobantes(valid, 1);
  const data = () => ({
    insights: spend, comprobantes: store.comprobantesBetween('2000-01-01', '2999-12-31'), identities, ads: { A: { firstSpendDate: '2026-10-25' } }, changes: [],
    config: NO_VAT, existing: new Set(), now: { date: '2026-10-28', minutes: 20 * 60 },
  });
  assert.equal(evaluateDue(data()).find((d) => d.kind === 'test').metrics.ventas, 3);
  store.setRejected(store.comprobantesBetween('2000-01-01', '2999-12-31')[0].key, true, 2);
  store.syncComprobantes(valid.slice(0, 2), 3);
  assert.equal(evaluateDue(data()).find((d) => d.kind === 'test').metrics.ventas, 1);
});

test('the alerts monitor skips rejected sheet rows', () => {
  const store = createStore(':memory:');
  store.syncComprobantes([V1, V2], 1);
  store.setRejected(keyOf(store, V1.phone), true, 2);
  const rejected = store.rejectedKeys();
  const sheet = keyRows([V1, V2]).map((r) => ({ ...r, rejected: rejected.has(r.key) }));
  assert.equal(todaySales(sheet, { today: '2026-10-28', flowPrefix: 'Bebidas', validResult: 'Pago válido' }).total, 1);
});

test('regression: with no gone or rejected rows the totals are unchanged and every row carries rejected=false', () => {
  const store = createStore(':memory:');
  store.syncComprobantes([V1, V2, REVIEW], 1);
  const r = report(store);
  assert.equal(r.kpis.ventas, 2);
  assert.equal(r.kpis.valor, 120000);
  assert.equal(r.kpis.roas, 4);
  assert.equal(r.reviewCount, 1);
  assert.ok(r.comprobantes.every((c) => c.rejected === false && c.gone === false));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM v_sales').get().n, 2);
});

test('comprobante-reject rejects, undoes, validates, and accepting a rejected payment requires undoing first', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-reject-'));
  const store = openStoreAt(dataDir);
  store.syncComprobantes([V1, REVIEW], 1);
  const key = keyOf(store, V1.phone);
  const reviewKey = keyOf(store, REVIEW.phone);
  store.close();
  const c = { dataDir, env: {}, fetchImpl: async () => { throw new Error('no network'); }, now: () => Date.parse('2026-10-29T15:00:00Z') };
  const range = { from: '2026-10-28', to: '2026-10-28' };

  assert.deepEqual(await runAdsCommand('comprobante-reject', { key }, c), { key, rejected: true });
  const v = await runAdsCommand('vouchers', range, c);
  assert.equal(v.comprobantes.find((x) => x.key === key).status, 'rejected');
  assert.equal((await runAdsCommand('report', { ...range, group: 'ct' }, c)).kpis.ventas, 0);

  await runAdsCommand('comprobante-reject', { key: reviewKey }, c);
  await assert.rejects(runAdsCommand('comprobante-accept', { key: reviewKey }, c), AdsError);
  await runAdsCommand('comprobante-reject', { key: reviewKey, undo: true }, c);
  assert.deepEqual(await runAdsCommand('comprobante-accept', { key: reviewKey }, c), { key: reviewKey, accepted: true });

  assert.deepEqual(await runAdsCommand('comprobante-reject', { key, undo: true }, c), { key, rejected: false });
  assert.equal((await runAdsCommand('report', { ...range, group: 'ct' }, c)).kpis.ventas, 2);
  await assert.rejects(runAdsCommand('comprobante-reject', { key: 'nope' }, c), AdsError);
  await assert.rejects(runAdsCommand('comprobante-reject', { key: NO_KEY }, c), AdsError);
});
