import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createStore } from './store.js';
import { VIEW_NAMES, VIEWS } from './views.js';

const insight = (o) => ({
  date: '2026-10-01', adId: 'a1', adName: 'Video 1', campaignId: 'c1', campaignName: 'CT07 Colombia', adsetId: 's1', adsetName: 'Set 1',
  gasto: 10000, impressions: 1000, clicks: 50, mensajes: 5, country: 'CO', ...o,
});
const sale = (o) => ({
  registered: '2026-10-01 10:00', date: '2026-10-01', result: 'Pago válido', phone: '573001112233', valor: 25000, bank: 'Nequi', flow: 'Bebidas Colombia',
  adId: 'a1', adLossy: false, adUrl: '', ...o,
});

function seeded() {
  const store = createStore(':memory:');
  store.upsertInsights([insight({}), insight({ date: '2026-10-02', gasto: 20000 }), insight({ adId: 'a2', adName: 'Otro', campaignId: 'c2', campaignName: 'Otra', gasto: 500 })], 1);
  store.upsertAds(
    [{ adId: 'a1', name: 'Video 1', createdTime: '2026-09-30', effectiveStatus: 'ACTIVE', campaignId: 'c1', campaignName: 'CT07 Colombia', adsetId: 's1', adsetName: 'Set 1' }],
    1,
  );
  store.refreshFirstSpend();
  store.recordBudgets([{ adsetId: 's1', adsetDailyBudget: 30000, campaignId: 'c1' }], '2026-10-01', 1);
  store.syncComprobantes([sale({}), sale({ registered: '2026-10-02 09:00', date: '2026-10-02', valor: 100, phone: '584121112233', flow: 'Bebidas Venezuela' }), sale({ registered: '2026-10-02 11:00', date: '2026-10-02', result: 'Inválido' })], 1);
  const keys = store.comprobantesBetween('2026-10-01', '2026-10-02').map((c) => c.key);
  store.setComprobanteCountries([{ key: keys[0], country: 'CO', source: 'telefono' }, { key: keys[1], country: 'VE', source: 'telefono' }]);
  store.setCountryRates({ CO: { currency: 'COP', rateToCop: 1 }, VE: { currency: 'USD', rateToCop: 4000 } });
  return store;
}

test('every view can be selected and exposes the documented columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'views-'));
  const file = path.join(dir, 'ads.db');
  const store = createStore(file);
  store.close();
  const db = new DatabaseSync(file, { readOnly: true });
  for (const name of VIEW_NAMES) {
    const cols = db.prepare(`SELECT * FROM ${name} LIMIT 0`).columns().map((c) => c.name);
    assert.deepEqual(cols, VIEWS[name].columns.map(([n]) => n), name);
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v_ads_daily derives the CT and labels a missing country', () => {
  const store = seeded();
  store.setSpendVat(0);
  const rows = store.db.prepare('SELECT ct, country, SUM(spend) AS spend FROM v_ads_daily GROUP BY ct, country ORDER BY ct').all();
  assert.deepEqual(rows.map((r) => [r.ct, r.country, r.spend]), [['CT 07', 'CO', 30000], ['Sin CT', 'CO', 500]]);
});

test('spend in the views includes the IVA; spend_net and vat are exposed without double counting', () => {
  const store = seeded();
  assert.equal(store.db.prepare('SELECT pct FROM spend_vat').get().pct, 19); // default until the config is mirrored
  const day = store.db.prepare("SELECT spend, spend_net, vat FROM v_ads_daily WHERE date = '2026-10-01' AND ad_id = 'a1'").get();
  assert.deepEqual({ ...day }, { spend: 11900, spend_net: 10000, vat: 1900 });
  store.setSpendVat(10);
  const ct = store.db.prepare("SELECT spend, spend_net, vat, roas FROM v_campaign_daily WHERE date = '2026-10-01' AND campaign_id = 'c1'").get();
  assert.equal(ct.spend, 11000);
  assert.equal(ct.spend_net, 10000);
  assert.equal(ct.vat, 1000);
  assert.equal(ct.roas, 25000 / 10000);
  assert.equal(store.setSpendVat(10), false);
});

test('v_sales keeps only valid payments and converts to COP', () => {
  const store = seeded();
  const rows = store.db.prepare('SELECT ct, country, value_cop FROM v_sales ORDER BY date').all();
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0] }, { ct: 'CT 07', country: 'CO', value_cop: 25000 });
  assert.equal(rows[1].value_cop, 400000);
});

test('v_ads reports the day counter and the current budget', () => {
  const store = seeded();
  const row = store.db.prepare("SELECT * FROM v_ads WHERE ad_id = 'a1'").get();
  assert.equal(row.ct, 'CT 07');
  assert.equal(row.first_spend_date, '2026-10-01');
  assert.equal(row.day_n, 2);
  assert.equal(row.current_budget, 30000);
});

test('v_campaign_daily joins spend and sales per day and per real campaign', () => {
  const store = seeded();
  const row = store.db.prepare("SELECT * FROM v_campaign_daily WHERE campaign_id = 'c1' AND date = '2026-10-01'").get();
  assert.equal(row.campaign, 'CT07 Colombia');
  assert.equal(row.spend, 11900); // 10000 + 19 % IVA
  assert.equal(row.sales, 1);
  assert.equal(row.revenue_cop, 25000);
  assert.equal(row.roas, 25000 / 10000);
});

test('read-only stores skip migrations and cannot write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'));
  const file = path.join(dir, 'ads.db');
  createStore(file).close();
  const ro = createStore(file, { readOnly: true });
  assert.equal(ro.counts().insights, 0);
  assert.throws(() => ro.setKv('x', 1));
  ro.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('campaigns that share a CT code are separate in the views, and sales follow their ad to the campaign', () => {
  const store = createStore(':memory:');
  store.setSpendVat(0);
  store.upsertInsights([
    insight({ adId: 'x1', campaignId: 'k1', campaignName: 'CT 01 Col 2 - ventas', gasto: 17106 }),
    insight({ adId: 'x2', campaignId: 'k2', campaignName: 'CT 01 Col 2', gasto: 13011 }),
    insight({ adId: 'x3', campaignId: 'k3', campaignName: 'Branding', gasto: 100 }),
  ], 1);
  store.upsertAds([{ adId: 'x4', name: 'Sin gasto', createdTime: '2026-09-30', effectiveStatus: 'ACTIVE', campaignId: 'k2', campaignName: 'CT 01 Col 2', adsetId: 's9', adsetName: 'S' }], 1);
  store.syncComprobantes([sale({ adId: 'x1', valor: 50000 }), sale({ registered: '2026-10-01 11:00', adId: 'x4', valor: 7000 }), sale({ registered: '2026-10-01 12:00', adId: '', valor: 1000 })], 1);
  const rows = store.db.prepare('SELECT campaign_id, campaign, ROUND(SUM(spend)) AS spend, SUM(sales) AS sales, SUM(revenue_cop) AS revenue FROM v_campaign_daily GROUP BY campaign_id ORDER BY campaign_id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { campaign_id: '', campaign: 'Sin anuncio', spend: 0, sales: 1, revenue: 1000 },
    { campaign_id: 'k1', campaign: 'CT 01 Col 2 - ventas', spend: 17106, sales: 1, revenue: 50000 },
    { campaign_id: 'k2', campaign: 'CT 01 Col 2', spend: 13011, sales: 1, revenue: 7000 },
    { campaign_id: 'k3', campaign: 'Branding', spend: 100, sales: 0, revenue: 0 },
  ]);
  const sales = store.db.prepare('SELECT ad_id, campaign_id, campaign FROM v_sales ORDER BY value').all().map((r) => ({ ...r }));
  assert.equal(sales.find((r) => r.ad_id === 'x4').campaign, 'CT 01 Col 2');
  assert.equal(store.db.prepare("SELECT campaign_id FROM v_ads WHERE ad_id = 'x4'").get().campaign_id, 'k2');
});
