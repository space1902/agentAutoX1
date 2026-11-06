import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { runAdsCommand } from './ads-api.js';
import { buildReport } from './report.js';
import { loadConfig } from './config.js';
import { openStoreAt } from './store.js';

// A data dir exactly as the single-account app left it: config with adAccountId only, a database without account_id.
function legacyDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-legacy-'));
  fs.mkdirSync(path.join(dir, 'ads'));
  fs.writeFileSync(path.join(dir, 'ads', 'config.json'), JSON.stringify({ adAccountId: 'act_1962423981398837', flowPrefix: 'Bebidas' }));
  const db = new DatabaseSync(path.join(dir, 'ads', 'ads.db'));
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE insights (date TEXT NOT NULL, ad_id TEXT NOT NULL, ad_name TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL,
      adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, gasto REAL NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL,
      mensajes INTEGER NOT NULL, synced_at INTEGER NOT NULL, country TEXT NOT NULL DEFAULT '', PRIMARY KEY (date, ad_id, country));
    CREATE TABLE ads (ad_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_time TEXT NOT NULL, effective_status TEXT NOT NULL,
      campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, updated_at INTEGER NOT NULL, first_spend_date TEXT);
    CREATE TABLE comprobantes (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, registered TEXT NOT NULL, result TEXT NOT NULL, phone TEXT NOT NULL,
      valor REAL NOT NULL, bank TEXT NOT NULL, flow TEXT NOT NULL, ad_id TEXT NOT NULL, ad_lossy INTEGER NOT NULL, ad_url TEXT NOT NULL, synced_at INTEGER NOT NULL);`);
  db.exec(`INSERT INTO kv VALUES ('account', '{"name":"X1 Pro Max","timezone":"America/Bogota","currency":"COP"}');
    INSERT INTO insights VALUES ('2026-10-28','5255001','CT01 video','c1','CT01 - ventas','s1','S',20000,100,10,40,1,'CO');
    INSERT INTO insights VALUES ('2026-10-28','5255002','Otro video','c2','CT02 - otra','s2','S',10000,100,10,5,1,'CO');
    INSERT INTO ads VALUES ('5255001','CT01 video','2026-10-25','ACTIVE','c1','CT01 - ventas','s1','S',1,'2026-10-28');
    INSERT INTO comprobantes (date, registered, result, phone, valor, bank, flow, ad_id, ad_lossy, ad_url, synced_at)
      VALUES ('2026-10-28','28/10/2026 10:00:00','Pago válido','573001234567',60000,'N','Bebidas - aporte','5255001',0,'',1);
    INSERT INTO comprobantes (date, registered, result, phone, valor, bank, flow, ad_id, ad_lossy, ad_url, synced_at)
      VALUES ('2026-10-28','28/10/2026 11:00:00','Pago válido','573009998888',15000,'N','Bebidas - aporte','',0,'',1);`);
  db.close();
  return dir;
}

const ARGS = { from: '2026-10-28', to: '2026-10-28', group: 'ad' };
const env = {};
const ctx = (dataDir) => ({ dataDir, env, fetchImpl: async () => { throw new Error('no network'); }, now: () => Date.parse('2026-10-29T15:00:00Z') });

test('legacy config + legacy DB: "Todas" with no name filter reports exactly the pre-portfolio numbers', async () => {
  const dir = legacyDir();
  // What the old engine computed: buildReport over the stored rows with no scope at all.
  const store = openStoreAt(dir);
  const config = loadConfig(dir);
  const before = buildReport({
    insights: store.insightsBetween('2026-10-28', '2026-10-28'), comprobantes: store.comprobantesBetween('2026-10-28', '2026-10-28'),
    identities: store.identities(), ads: store.adsWithFirstSpend(), config, from: '2026-10-28', to: '2026-10-28', group: 'ad', today: '2026-10-29',
  });
  store.close();
  const strip = (r) => ({ kpis: r.kpis, rows: r.rows, daily: r.daily, countries: r.countries, comprobantes: r.comprobantes, reviewCount: r.reviewCount });

  for (const extra of [{}, { accounts: 'all' }, { accounts: 'all', name: '' }]) {
    const now = await runAdsCommand('report', { ...ARGS, ...extra }, ctx(dir));
    assert.deepEqual(strip(now), strip(before), JSON.stringify(extra));
  }
  const r = await runAdsCommand('report', ARGS, ctx(dir));
  assert.equal(r.kpis.spendNet, 30000);
  assert.equal(r.kpis.gasto, 35700); // 19 % IVA
  assert.equal(r.kpis.valor, 75000, 'the payment without an ad still counts with every account selected');
  assert.equal(r.kpis.ventas, 2);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.warnings, []);
  const v = await runAdsCommand('vouchers', ARGS, ctx(dir));
  assert.equal(v.comprobantes.length, 2);
});

test('the migration is additive: every legacy row survives, the account is the old one, the old token entry name is untouched', async () => {
  const dir = legacyDir();
  const out = await runAdsCommand('config-get', {}, ctx(dir));
  assert.equal(out.config.adAccountId, 'act_1962423981398837');
  assert.equal(out.config.portfolios[0].id, 'principal');
  assert.equal(out.config.flowPrefix, 'Bebidas', 'other settings are kept');
  const status = await runAdsCommand('status', {}, ctx(dir));
  assert.equal(status.counts.insights, 2);
  assert.equal(status.counts.comprobantes, 2);
  assert.equal(status.account.name, 'X1 Pro Max', 'the legacy account record is still there');
  const db = new DatabaseSync(path.join(dir, 'ads', 'ads.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM insights WHERE account_id = 'act_1962423981398837'").get().n, 2);
  assert.ok(db.prepare("SELECT 1 FROM kv WHERE key = 'account'").get(), 'the legacy kv record is kept');
  db.close();
});
