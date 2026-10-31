// Manual acceptance of payments: stored apart from the sheet, counted like "Pago válido" everywhere.
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

// Legacy expectations are written without IVA; the IVA behavior has its own tests.
const NO_VAT = { ...DEFAULT_CONFIG, spendVatPct: 0 };

const row = (registered, date, result, extra = {}) => ({
  registered, date, result, phone: '573001234567', valor: 60000, bank: 'Nequi', flow: 'Bebidas - aporte', adId: 'A', adLossy: false, adUrl: '', ...extra,
});
const REVIEW = row('28/10/2026 10:00:00', '2026-10-28', 'Nombre a revisar');
const VALID = row('28/10/2026 11:00:00', '2026-10-28', 'Pago válido', { phone: '573009998888' });
const INVALID = row('28/10/2026 12:00:00', '2026-10-28', 'Comprobante inválido', { phone: '573007776666' });
const identities = { A: { adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas' } };
const insights = [{ date: '2026-10-28', adId: 'A', adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas', adsetId: 's', adsetName: 'S', gasto: 30000, mensajes: 10, country: '' }];
const NO_KEY = '0'.repeat(20);

const report = (store, over = {}) => buildReport({
  insights, comprobantes: store.comprobantesBetween('2026-10-01', '2026-10-31'), identities, config: NO_VAT, from: '2026-10-28', to: '2026-10-28', today: '2026-10-29', ...over,
});
const keyOf = (store, result) => store.comprobantesBetween('2026-10-01', '2026-10-31').find((c) => c.result === result).key;
const seeded = () => {
  const store = createStore(':memory:');
  store.syncComprobantes([REVIEW, VALID, INVALID], 1);
  return store;
};

test('an accepted payment survives re-syncs, even when the sheet drops the row', () => {
  const store = seeded();
  const key = keyOf(store, 'Nombre a revisar');
  assert.equal(store.setAccepted(key, true, 5), true);
  store.syncComprobantes([REVIEW, VALID, INVALID], 10);
  assert.equal(store.comprobantesBetween('2026-10-01', '2026-10-31').find((c) => c.key === key).accepted, true);
  store.syncComprobantes([VALID], 20);
  const gone = store.comprobantesBetween('2026-10-01', '2026-10-31').find((c) => c.key === key);
  assert.equal(gone.accepted, true);
  assert.equal(gone.gone, true);
  assert.equal(store.setAccepted(NO_KEY, true, 5), false, 'unknown payments cannot be accepted');
});

test('accepted payments count like valid ones in KPIs, ROAS, rows, daily series and the CT chart', () => {
  const store = seeded();
  const before = report(store);
  assert.equal(before.kpis.ventas, 1);
  assert.equal(before.kpis.valor, 60000);

  store.setAccepted(keyOf(store, 'Nombre a revisar'), true, 5);
  const after = report(store);
  assert.equal(after.kpis.ventas, 2);
  assert.equal(after.kpis.valor, 120000);
  assert.equal(after.kpis.roas, 4);
  assert.equal(after.rows[0].ventas, 2);
  assert.equal(after.daily.find((d) => d.date === '2026-10-28').ventas, 2);
  assert.equal(after.ctDaily[0].daily.find((d) => d.date === '2026-10-28').valor, 120000);
});

test('the pending counter excludes valid and accepted payments: drops on accept, rises on undo', () => {
  const store = seeded();
  assert.equal(report(store).reviewCount, 2, 'review + invalid are pending');
  const key = keyOf(store, 'Nombre a revisar');
  store.setAccepted(key, true, 5);
  const accepted = report(store);
  assert.equal(accepted.reviewCount, 1);
  const item = accepted.comprobantes.find((c) => c.key === key);
  assert.equal(item.status, 'accepted');
  assert.equal(item.accepted, true);
  assert.equal(item.result, 'Nombre a revisar', 'the sheet result is shown untouched');

  store.setAccepted(key, false, 6);
  const undone = report(store);
  assert.equal(undone.reviewCount, 2);
  assert.equal(undone.kpis.ventas, 1);
  assert.equal(undone.comprobantes.find((c) => c.key === key).status, 'review');
});

test('the pending counter counts any non-valid result, within the range and the enabled countries', () => {
  const store = seeded();
  store.syncComprobantes([REVIEW, VALID, INVALID, row('28/10/2026 13:00:00', '2026-10-28', 'Algo nuevo', { phone: '573005554444' })], 2);
  assert.equal(report(store).reviewCount, 3);
  assert.equal(report(store, { from: '2026-10-29', to: '2026-10-29' }).reviewCount, 0);
  const mx = report(store, { config: { ...NO_VAT, enabledCountries: ['MX'] } });
  assert.equal(mx.reviewCount, 0, 'Colombian payments are out of scope when only MX is enabled');
});

test('once the sheet marks the row as valid the acceptance is redundant and counted once', () => {
  const store = seeded();
  const key = keyOf(store, 'Nombre a revisar');
  store.setAccepted(key, true, 5);
  store.syncComprobantes([{ ...REVIEW, result: 'Pago válido' }, VALID, INVALID], 10);
  const r = report(store);
  assert.equal(r.kpis.ventas, 2);
  assert.equal(r.comprobantes.find((c) => c.key === key).status, 'valid');
  assert.equal(r.reviewCount, 1);
});

test('decisions count accepted payments in the verdict metrics', () => {
  const store = createStore(':memory:');
  const days = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'];
  const spend = days.map((d) => ({ ...insights[0], date: d, gasto: 10000 }));
  const pending = ['2026-10-26', '2026-10-27', '2026-10-28'].map((d, i) => row(`${d.slice(8)}/10/2026 10:00:00`, d, 'Nombre a revisar', { phone: `57300000000${i}` }));
  store.syncComprobantes(pending, 1);
  const data = () => ({
    insights: spend, comprobantes: store.comprobantesBetween('2000-01-01', '2999-12-31'), identities, ads: { A: { firstSpendDate: '2026-10-25' } }, changes: [],
    config: NO_VAT, existing: new Set(), now: { date: '2026-10-28', minutes: 20 * 60 },
  });
  assert.equal(evaluateDue(data()).find((d) => d.kind === 'test').metrics.ventas, 0);
  for (const c of store.comprobantesBetween('2000-01-01', '2999-12-31')) store.setAccepted(c.key, true, 5);
  const some = evaluateDue(data()).find((d) => d.kind === 'test');
  assert.equal(some.metrics.ventas, 3);
  assert.equal(some.metrics.valor, 180000);
});

test('v_sales includes accepted payments and flags them', () => {
  const store = seeded();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM v_sales').get().n, 1);
  const key = keyOf(store, 'Nombre a revisar');
  store.setAccepted(key, true, 5);
  const rows = store.db.prepare('SELECT result, accepted_manually FROM v_sales ORDER BY accepted_manually').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ result: 'Pago válido', accepted_manually: 0 }, { result: 'Nombre a revisar', accepted_manually: 1 }]);
  store.setAccepted(key, false, 6);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM v_sales').get().n, 1);
});

test('the alerts monitor counts accepted sheet rows as sales (keys match the store)', () => {
  const store = seeded();
  store.setAccepted(keyOf(store, 'Nombre a revisar'), true, 5);
  const accepted = store.acceptedKeys();
  const sheet = keyRows([REVIEW, VALID, INVALID]).map((r) => ({ ...r, accepted: accepted.has(r.key) }));
  const sold = todaySales(sheet, { today: '2026-10-28', flowPrefix: 'Bebidas', validResult: 'Pago válido' });
  assert.equal(sold.total, 2);
});

test('comprobante-accept accepts, undoes and validates without any network access', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-accept-'));
  const store = openStoreAt(dataDir);
  store.syncComprobantes([REVIEW, VALID], 1);
  const key = keyOf(store, 'Nombre a revisar');
  store.close();
  const c = { dataDir, env: {}, fetchImpl: async () => { throw new Error('no network'); }, now: () => Date.parse('2026-10-29T15:00:00Z') };
  const range = { from: '2026-10-28', to: '2026-10-28' };

  assert.equal((await runAdsCommand('vouchers', range, c)).reviewCount, 1);
  assert.deepEqual(await runAdsCommand('comprobante-accept', { key }, c), { key, accepted: true });
  const v = await runAdsCommand('vouchers', range, c);
  assert.equal(v.reviewCount, 0);
  assert.equal(v.comprobantes.find((x) => x.key === key).status, 'accepted');
  assert.equal((await runAdsCommand('report', { ...range, group: 'ct' }, c)).kpis.ventas, 2);

  assert.deepEqual(await runAdsCommand('comprobante-accept', { key, undo: true }, c), { key, accepted: false });
  assert.equal((await runAdsCommand('vouchers', range, c)).reviewCount, 1);
  await assert.rejects(runAdsCommand('comprobante-accept', { key: 'nope' }, c), AdsError);
  await assert.rejects(runAdsCommand('comprobante-accept', { key: NO_KEY }, c), AdsError);
});
