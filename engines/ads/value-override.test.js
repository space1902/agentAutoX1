// Manual correction of a payment's amount: stored apart from the synced rows, never written to the sheet.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AdsError, runAdsCommand } from './ads-api.js';
import { DEFAULT_CONFIG } from './config.js';
import { buildReport } from './report.js';
import { createStore, openStoreAt } from './store.js';

const NO_VAT = { ...DEFAULT_CONFIG, spendVatPct: 0 };
const row = (registered, phone, valor) => ({
  registered, date: '2026-10-28', result: 'Pago válido', phone, valor, bank: 'Nequi', flow: 'Bebidas - aporte', adId: 'A', adLossy: false, adUrl: '',
});
const V1 = row('28/10/2026 11:00:00', '573009998888', 60000);
const V2 = row('28/10/2026 12:00:00', '573007776666', 30000);
const identities = { A: { adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas' } };
const insights = [{ date: '2026-10-28', adId: 'A', adName: 'Ad A', campaignId: 'c1', campaignName: 'CT01 - ventas', adsetId: 's', adsetName: 'S', gasto: 30000, mensajes: 10, country: '' }];
const all = (store) => store.comprobantesBetween('2026-10-01', '2026-10-31');
const report = (store) => buildReport({ insights, comprobantes: all(store), identities, config: NO_VAT, from: '2026-10-28', to: '2026-10-28', today: '2026-10-29' });
const keyOf = (store, phone) => all(store).find((c) => c.phone === phone).key;

test('a corrected amount replaces the sheet value everywhere and can be restored', () => {
  const store = createStore(':memory:');
  store.syncComprobantes([V1, V2], 1);
  const key = keyOf(store, V1.phone);
  assert.equal(store.setValueOverride(key, 45000, 2), true);
  const c = all(store).find((x) => x.key === key);
  assert.equal(c.valor, 45000);
  assert.equal(c.valorSheet, 60000);
  assert.equal(c.valueOverridden, true);
  const r = report(store);
  assert.equal(r.kpis.valor, 75000);
  const v = r.comprobantes.find((x) => x.key === key);
  assert.equal(v.valor, 45000);
  assert.equal(v.valorSheet, 60000);
  assert.equal(v.valueOverridden, true);
  assert.equal(store.db.prepare('SELECT SUM(value) AS n FROM v_sales').get().n, 75000);
  assert.equal(store.db.prepare('SELECT SUM(value_cop) AS n FROM v_sales').get().n, 75000);
  assert.equal(store.setValueOverride(key, null, 3), true);
  assert.equal(report(store).kpis.valor, 90000);
  assert.equal(all(store).find((x) => x.key === key).valueOverridden, false);
});

test('the override survives a re-sync that changes the sheet value, and stays out of the synced table', () => {
  const store = createStore(':memory:');
  store.syncComprobantes([V1], 1);
  const key = keyOf(store, V1.phone);
  store.setValueOverride(key, 45000, 2);
  store.syncComprobantes([{ ...V1, valor: 61000 }], 3);
  const c = all(store)[0];
  assert.equal(c.valor, 45000);
  assert.equal(c.valorSheet, 61000);
  assert.equal(store.db.prepare('SELECT valor FROM comprobantes WHERE key = ?').get(key).valor, 61000);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM comprobante_value_overrides').get().n, 1);
});

test('an unknown payment cannot be corrected', () => {
  const store = createStore(':memory:');
  store.syncComprobantes([V1], 1);
  assert.equal(store.setValueOverride('0'.repeat(20), 1000, 2), false);
});

test('comprobante-value validates the amount, corrects and restores through the command layer', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-value-'));
  try {
    const store = openStoreAt(dataDir);
    store.syncComprobantes([V1], 1);
    const key = keyOf(store, V1.phone);
    store.close();
    const run = (args) => runAdsCommand('comprobante-value', args, { dataDir, env: {}, now: () => 5 });
    assert.deepEqual(await run({ key, valor: '45000' }), { key, valor: 45000 });
    for (const bad of ['0', '-5', '1.5', 'abc', '100000001', '1e5']) await assert.rejects(() => run({ key, valor: bad }), AdsError, bad);
    await assert.rejects(() => run({ key: 'zz', valor: '5000' }), AdsError);
    await assert.rejects(() => run({ key: '0'.repeat(20), valor: '5000' }), /No encuentro/);
    assert.deepEqual(await run({ key, valor: '100000000' }), { key, valor: 100000000 });
    assert.deepEqual(await run({ key, valor: true }), { key, valor: null });
    assert.deepEqual(await run({ key }), { key, valor: null });
    const check = openStoreAt(dataDir);
    assert.equal(check.db.prepare('SELECT COUNT(*) n FROM comprobante_value_overrides').get().n, 0);
    check.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
