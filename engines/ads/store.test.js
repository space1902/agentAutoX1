import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

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

const voucher = (date, valor, extra = {}) => ({ registered: `${date} 10:00:00`, date, result: 'Pago válido', phone: '573001234567', valor, bank: 'Nequi', flow: 'Bebidas - aporte', adId: 'A', adLossy: false, adUrl: '', ...extra });

test('syncComprobantes upserts by stable key, never deletes, and flags rows that left the sheet', () => {
  const s = createStore();
  s.syncComprobantes([voucher('2026-10-27', 1000), voucher('2026-10-28', 2000)], 1);
  s.syncComprobantes([voucher('2026-10-28', 2000, { result: 'Comprobante inválido' })], 2);
  const rows = s.comprobantesBetween('2026-10-01', '2026-10-31');
  assert.equal(rows.length, 2, 'the vanished row is kept');
  assert.equal(rows.find((r) => r.date === '2026-10-27').gone, true);
  const kept = rows.find((r) => r.date === '2026-10-28');
  assert.equal(kept.gone, false);
  assert.equal(kept.result, 'Comprobante inválido', 'a corrected row keeps its identity and takes the new value');
  s.syncComprobantes([voucher('2026-10-27', 1000), voucher('2026-10-28', 2000)], 3);
  assert.equal(s.comprobantesBetween('2026-10-01', '2026-10-31').filter((r) => r.gone).length, 0, 'a returning row is no longer flagged');
});

test('identical payments of the same person and second get distinct keys', () => {
  const s = createStore();
  s.syncComprobantes([voucher('2026-10-28', 1000), voucher('2026-10-28', 1000)], 1);
  const keys = s.comprobantesBetween('2026-10-01', '2026-10-31').map((r) => r.key);
  assert.equal(new Set(keys).size, 2);
  s.syncComprobantes([voucher('2026-10-28', 1000), voucher('2026-10-28', 1000)], 2);
  assert.equal(s.counts().comprobantes, 2);
});

test('stored and manual countries: the override wins, survives a re-sync and can be removed', () => {
  const s = createStore();
  s.syncComprobantes([voucher('2026-10-28', 1000)], 1);
  const [{ key }] = s.comprobantesBetween('2026-10-01', '2026-10-31');
  s.setComprobanteCountries([{ key, country: 'CO', source: 'telefono' }]);
  assert.deepEqual(s.comprobantesBetween('2026-10-01', '2026-10-31').map((r) => [r.country, r.countrySource]), [['CO', 'telefono']]);
  s.setCountryOverride(key, 'MX', 5);
  s.syncComprobantes([voucher('2026-10-28', 1000)], 6);
  assert.deepEqual(s.comprobantesBetween('2026-10-01', '2026-10-31').map((r) => [r.country, r.countrySource]), [['MX', 'manual']]);
  s.setCountryOverride(key, '', 7);
  assert.equal(s.comprobantesBetween('2026-10-01', '2026-10-31')[0].countrySource, 'telefono');
});

test('insights keep a country split, and a restated ad-day replaces its previous rows', () => {
  const s = createStore();
  s.upsertInsights([row('2026-10-28', 'A', 600, { country: 'CO' }), row('2026-10-28', 'A', 400, { country: 'MX' }), row('2026-10-28', 'B', 100)], 1);
  assert.equal(s.insightsBetween('2026-10-28', '2026-10-28').length, 3);
  s.upsertInsights([row('2026-10-28', 'A', 1200, { country: 'CO' })], 2);
  const a = s.insightsBetween('2026-10-28', '2026-10-28').filter((r) => r.adId === 'A');
  assert.deepEqual(a.map((r) => [r.country, r.gasto]), [['CO', 1200]], 'MX row of the same ad-day is gone, B untouched');
  assert.equal(s.insightsBetween('2026-10-28', '2026-10-28').length, 2);
});

test('historyStats reports the stored span', () => {
  const s = createStore();
  s.upsertInsights([row('2026-10-01', 'A', 1), row('2026-10-03', 'A', 1), row('2026-10-03', 'B', 1)], 1);
  s.syncComprobantes([voucher('2026-09-20', 1)], 1);
  const h = s.historyStats();
  assert.deepEqual([h.insightsFrom, h.insightsTo, h.insightDays, h.vouchersFrom, h.voucherRows], ['2026-10-01', '2026-10-03', 2, '2026-09-20', 1]);
});

test('an old database (no country, no keys) is migrated in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-migrate-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE insights (date TEXT NOT NULL, ad_id TEXT NOT NULL, ad_name TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL,
      adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, gasto REAL NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL,
      mensajes INTEGER NOT NULL, synced_at INTEGER NOT NULL, PRIMARY KEY (date, ad_id));
    CREATE TABLE comprobantes (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, registered TEXT NOT NULL, result TEXT NOT NULL, phone TEXT NOT NULL,
      valor REAL NOT NULL, bank TEXT NOT NULL, flow TEXT NOT NULL, ad_id TEXT NOT NULL, ad_lossy INTEGER NOT NULL, ad_url TEXT NOT NULL, synced_at INTEGER NOT NULL);`);
  old.prepare("INSERT INTO insights VALUES ('2026-10-28','A','a','c','CT01','s','S',500,1,1,1,1)").run();
  const ins = old.prepare("INSERT INTO comprobantes (date, registered, result, phone, valor, bank, flow, ad_id, ad_lossy, ad_url, synced_at) VALUES ('2026-10-28','28/10/2026 10:00:00','Pago válido','573001234567',1000,'N','Bebidas','A',0,'',1)");
  ins.run();
  ins.run();
  old.close();

  const s = createStore(file);
  assert.equal(s.insightsRebuilt, true);
  assert.equal(s.insightsBetween('2026-10-28', '2026-10-28')[0].country, '');
  const keys = s.comprobantesBetween('2026-10-01', '2026-10-31').map((r) => r.key);
  assert.equal(new Set(keys).size, 2);
  assert.ok(keys.every(Boolean));
  s.syncComprobantes([voucher('2026-10-28', 1000, { registered: '28/10/2026 10:00:00' }), voucher('2026-10-28', 1000, { registered: '28/10/2026 10:00:00' })], 9);
  assert.equal(s.counts().comprobantes, 2, 'migrated keys match the keys a fresh sync computes');
  s.close();
});

test('the names are migrated into an old comprobantes table and a re-sync backfills them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-names-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE comprobantes (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, registered TEXT NOT NULL, result TEXT NOT NULL, phone TEXT NOT NULL,
      valor REAL NOT NULL, bank TEXT NOT NULL, flow TEXT NOT NULL, ad_id TEXT NOT NULL, ad_lossy INTEGER NOT NULL, ad_url TEXT NOT NULL, synced_at INTEGER NOT NULL);`);
  old.prepare("INSERT INTO comprobantes (date, registered, result, phone, valor, bank, flow, ad_id, ad_lossy, ad_url, synced_at) VALUES ('2026-10-28','28/10/2026 10:00:00','Pago válido','573001234567',1000,'N','Bebidas','A',0,'',1)").run();
  old.close();

  const s = createStore(file);
  const before = s.comprobantesBetween('2026-10-01', '2026-10-31');
  assert.equal(before.length, 1);
  assert.equal(before[0].clientName, '');
  assert.equal(before[0].payerName, '');
  s.syncComprobantes([voucher('2026-10-28', 1000, { registered: '28/10/2026 10:00:00', clientName: 'Ana Chat', payerName: 'Ana Titular' })], 5);
  const after = s.comprobantesBetween('2026-10-01', '2026-10-31');
  assert.equal(after.length, 1, 'same payment, updated in place');
  assert.equal(after[0].clientName, 'Ana Chat');
  assert.equal(after[0].payerName, 'Ana Titular');
  s.close();
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

test('decisions are unique by key, keep their payload and can change status', () => {
  const s = createStore();
  const d = { key: 'test:A:2026-10-25:d4', kind: 'test', entityType: 'ad', entityId: 'A', label: 'Ad A', dayN: 4, dueDate: '2026-10-28', late: false, verdict: { label: 'Escalar' }, reason: 'x' };
  const id = s.insertDecision(d, 100);
  assert.ok(id > 0);
  assert.equal(s.insertDecision(d, 200), null);
  assert.deepEqual([...s.decisionKeys()], [d.key]);
  assert.equal(s.setDecisionStatus(id, 'done', 300), true);
  assert.equal(s.setDecisionStatus(999, 'done', 300), false);
  const [stored] = s.decisions();
  assert.equal(stored.status, 'done');
  assert.equal(stored.verdict.label, 'Escalar');
  assert.equal(stored.createdAt, 100);
});

test('budget events and the WhatsApp outbox round trip', () => {
  const s = createStore();
  const e = { entityType: 'adset', entityId: 's1', time: 5, date: '2026-10-27', oldBudget: 1, newBudget: 2 };
  s.upsertBudgetEvents([e, e]);
  assert.deepEqual(s.budgetEvents(), [e]);
  s.enqueueWhatsapp('hola', 'decision', 10);
  assert.equal(s.pendingWhatsapp().length, 1);
  s.markWhatsappSent(s.pendingWhatsapp()[0].id, 20);
  assert.equal(s.pendingWhatsapp().length, 0);
});
