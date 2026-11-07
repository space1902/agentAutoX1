// SQLite persistence (built-in node:sqlite, Node >= 22.13): daily insights per ad, ad metadata, budget history
// and the payments cache. Daily insights are upserted, so past days survive even if Meta later changes them.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { adsDir, loadConfig } from './config.js';
import { installViews, refreshAdCt, syncCountryRates, syncExcludedAccounts, syncSpendVat } from './views.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Live exchange rates to COP: one row per currency and calendar day (the last fetch of that day wins), so past days
-- keep the rate they had. rate_to_cop = COP per 1 unit of the currency.
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT NOT NULL, date TEXT NOT NULL, rate_to_cop REAL NOT NULL, fetched_at INTEGER NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (currency, date)
);
CREATE TABLE IF NOT EXISTS insights (
  date TEXT NOT NULL, ad_id TEXT NOT NULL, ad_name TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL,
  adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, gasto REAL NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL,
  mensajes INTEGER NOT NULL, synced_at INTEGER NOT NULL, country TEXT NOT NULL DEFAULT '',
  -- Ad ids are unique across Meta, so the account does not need to be part of the key.
  account_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (date, ad_id, country)
);
CREATE INDEX IF NOT EXISTS insights_ad ON insights (ad_id, date);
CREATE TABLE IF NOT EXISTS ads (
  ad_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_time TEXT NOT NULL, effective_status TEXT NOT NULL,
  campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, updated_at INTEGER NOT NULL,
  first_spend_date TEXT, -- first day with spend > 0: "day 1" of the ad (created_time is only a reference)
  account_id TEXT NOT NULL DEFAULT ''
);
-- Budgets are stored as Meta returns them (currency minor units). A row is appended only when the value changes.
CREATE TABLE IF NOT EXISTS budget_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, date TEXT NOT NULL,
  daily_budget REAL, lifetime_budget REAL, first_seen INTEGER NOT NULL, account_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS budget_entity ON budget_history (entity_type, entity_id, id);
CREATE TABLE IF NOT EXISTS comprobantes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, registered TEXT NOT NULL, result TEXT NOT NULL, phone TEXT NOT NULL,
  valor REAL NOT NULL, bank TEXT NOT NULL, flow TEXT NOT NULL, ad_id TEXT NOT NULL, ad_lossy INTEGER NOT NULL,
  ad_url TEXT NOT NULL, synced_at INTEGER NOT NULL,
  key TEXT, first_seen INTEGER, missing_since INTEGER, country TEXT NOT NULL DEFAULT '', country_source TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '', payer_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS comprobantes_date ON comprobantes (date);
-- Manual country of a payment, kept apart so a re-sync never overwrites it.
CREATE TABLE IF NOT EXISTS comprobante_overrides (key TEXT PRIMARY KEY, country TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- Manual ad of a payment (when the sheet did not capture it), kept apart so a re-sync never overwrites it.
CREATE TABLE IF NOT EXISTS comprobante_ad_overrides (key TEXT PRIMARY KEY, ad_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- Payments the user accepted by hand although the sheet's result is not the valid one. Never written to the sheet;
-- kept apart so a re-sync never overwrites it. Redundant (but harmless) once the sheet itself says "Pago válido".
CREATE TABLE IF NOT EXISTS comprobante_accepts (key TEXT PRIMARY KEY, accepted_at INTEGER NOT NULL);
-- Exact budget changes read from the account activity log (when Meta exposes it).
CREATE TABLE IF NOT EXISTS budget_events (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, time INTEGER NOT NULL, date TEXT NOT NULL,
  old_budget REAL NOT NULL, new_budget REAL NOT NULL, account_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (entity_type, entity_id, time, new_budget)
);
-- Issued decisions. The key makes each one unique: (kind, entity, window start, day).
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  label TEXT NOT NULL, day_n INTEGER NOT NULL, due_date TEXT NOT NULL, late INTEGER NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, notified_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_created ON decisions (created_at);
-- Messages waiting for the WhatsApp channel (sent by the alerts monitor when it is connected).
CREATE TABLE IF NOT EXISTS wa_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER
);
`;

// Stable identity of a payment row: when it arrived + who paid (+ the n-th identical one). Mutable fields such as
// the result or the ad id are NOT part of it, so a corrected row keeps its history.
export function comprobanteKey(row, occurrence = 0) {
  return createHash('sha1').update(`${row.registered}|${row.phone}#${occurrence}`).digest('hex').slice(0, 20);
}

// Rows with their stable `key` (same rule as syncComprobantes), for callers that read the sheet directly.
export function keyRows(rows) {
  const seen = new Map();
  return rows.map((c) => {
    const base = `${c.registered}|${c.phone}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...c, key: c.key ?? comprobanteKey(c, n) };
  });
}

// ADD COLUMN that tolerates another process having added it between our check and our ALTER.
function addColumn(db, table, ddl) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (error) {
    if (!/duplicate column/i.test(String(error?.message))) throw error;
  }
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

const ACCOUNT_TABLES = ['insights', 'ads', 'budget_history', 'budget_events'];

// account_id on every Meta table. Rows from before accounts existed (account_id = '') belong to the principal account,
// and its stored info / backfill markers are copied to the per-account keys. Safe to repeat: it only touches '' rows.
function migrateAccounts(db, defaultAccountId) {
  for (const table of ACCOUNT_TABLES) {
    if (!columns(db, table).includes('account_id')) addColumn(db, table, "account_id TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS insights_account ON insights (account_id, date)');
  if (!defaultAccountId) return;
  const kv = (key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ACCOUNT_TABLES) db.prepare(`UPDATE ${table} SET account_id = ? WHERE account_id = ''`).run(defaultAccountId);
    const put = db.prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)');
    for (const [from, to] of [['account', `account:${defaultAccountId}`], ['backfillDone', `backfillDone:${defaultAccountId}`]]) {
      const value = kv(from);
      if (value !== undefined) put.run(to, value);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Brings databases created by earlier versions up to date. Returns true when insights had to be rebuilt.
function migrate(db, defaultAccountId = '') {
  let rebuilt = false;
  if (!columns(db, 'insights').includes('country')) {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ALTER TABLE insights RENAME TO insights_old');
    db.exec(`CREATE TABLE insights (
      date TEXT NOT NULL, ad_id TEXT NOT NULL, ad_name TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL,
      adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, gasto REAL NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL,
      mensajes INTEGER NOT NULL, synced_at INTEGER NOT NULL, country TEXT NOT NULL DEFAULT '', PRIMARY KEY (date, ad_id, country)
    )`);
    db.exec(`INSERT INTO insights SELECT date, ad_id, ad_name, campaign_id, campaign_name, adset_id, adset_name, gasto, impressions, clicks,
      mensajes, synced_at, '' FROM insights_old`);
    db.exec('DROP TABLE insights_old');
    db.exec('CREATE INDEX IF NOT EXISTS insights_ad ON insights (ad_id, date)');
    db.exec('COMMIT');
    rebuilt = true;
  }
  const cols = columns(db, 'comprobantes');
  for (const [name, ddl] of [
    ['key', 'key TEXT'], ['first_seen', 'first_seen INTEGER'], ['missing_since', 'missing_since INTEGER'],
    ['country', "country TEXT NOT NULL DEFAULT ''"], ['country_source', "country_source TEXT NOT NULL DEFAULT ''"],
    ['client_name', "client_name TEXT NOT NULL DEFAULT ''"], ['payer_name', "payer_name TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!cols.includes(name)) addColumn(db, 'comprobantes', ddl);
  }
  const loose = db.prepare('SELECT id, registered, phone FROM comprobantes WHERE key IS NULL ORDER BY id').all();
  if (loose.length) {
    const seen = new Map();
    const set = db.prepare('UPDATE comprobantes SET key = ?, first_seen = COALESCE(first_seen, synced_at) WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    for (const r of loose) {
      const base = `${r.registered}|${r.phone}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      set.run(comprobanteKey(r, n), r.id);
    }
    db.exec('COMMIT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS comprobantes_key ON comprobantes (key)');
  // Meta reports "unknown" when it cannot place an impression: store that as no country.
  migrateAccounts(db, defaultAccountId);
  db.exec("UPDATE insights SET country = '' WHERE country = 'unknown' AND NOT EXISTS (SELECT 1 FROM insights i2 WHERE i2.date = insights.date AND i2.ad_id = insights.ad_id AND i2.country = '')");
  return rebuilt;
}

// `readOnly`: opens an existing database for reading only (no schema, migration or view work). Used by the Analista.
// `defaultAccountId`: the account that rows from before accounts existed belong to (the principal account).
export function createStore(file = ':memory:', { readOnly = false, defaultAccountId = '' } = {}) {
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  let insightsRebuilt = false;
  if (!readOnly) {
    // Several processes (the app's ticks and syncs) can open a not-yet-migrated database at once: wait for each other.
    db.exec('PRAGMA busy_timeout = 15000;');
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    insightsRebuilt = migrate(db, defaultAccountId);
    if (!db.prepare('PRAGMA table_info(ads)').all().some((c) => c.name === 'first_spend_date')) addColumn(db, 'ads', 'first_spend_date TEXT');
    // Analysis views for the Analista (helper tables + views); rebuilt only when their version changes.
    if (installViews(db) || db.prepare('SELECT COUNT(*) n FROM ad_ct').get().n === 0) refreshAdCt(db);
  }
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    db, // raw handle: tests and the read-only analysis tools
    close: () => db.close(),

    getKv(key) {
      const r = q('SELECT value FROM kv WHERE key = ?').get(key);
      return r ? JSON.parse(r.value) : null;
    },
    setKv(key, value) {
      q('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value ?? null));
    },
    // { name, timezone, currency } of an account (account:<act_id>), falling back to the legacy single record.
    accountInfo(accountId) {
      return (accountId ? this.getKv(`account:${accountId}`) : null) ?? this.getKv('account');
    },
    // `primary` also refreshes the legacy `account` record that single-account readers (the Analista) still use.
    setAccountInfo(accountId, info, { primary = false } = {}) {
      this.setKv(`account:${accountId}`, info);
      if (primary) this.setKv('account', info);
    },

    // Replaces every row of each (date, ad) in the batch, so Meta restating a day (or the country split appearing)
    // never double counts. Days Meta does not return are left untouched.
    upsertInsights(rows, now, accountId = '') {
      const remove = q('DELETE FROM insights WHERE date = ? AND ad_id = ?');
      const insert = q(`INSERT INTO insights (date, ad_id, ad_name, campaign_id, campaign_name, adset_id, adset_name, gasto, impressions, clicks, mensajes, synced_at, country, account_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, ad_id, country) DO UPDATE SET ad_name = excluded.ad_name, campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name,
          adset_id = excluded.adset_id, adset_name = excluded.adset_name, gasto = gasto + excluded.gasto, impressions = impressions + excluded.impressions,
          clicks = clicks + excluded.clicks, mensajes = mensajes + excluded.mensajes, synced_at = excluded.synced_at, account_id = excluded.account_id`);
      tx(() => {
        const groups = new Set(rows.map((r) => `${r.date}|${r.adId}`));
        for (const g of groups) remove.run(...g.split('|'));
        for (const r of rows) insert.run(r.date, r.adId, r.adName, r.campaignId, r.campaignName, r.adsetId, r.adsetName, r.gasto, r.impressions, r.clicks, r.mensajes, now, r.country ?? '', r.accountId ?? accountId);
      });
      refreshAdCt(db);
    },
    saveFxRate: ({ currency, date, rate, fetchedAt, source }) => {
      q(`INSERT INTO fx_rates (currency, date, rate_to_cop, fetched_at, source) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(currency, date) DO UPDATE SET rate_to_cop = excluded.rate_to_cop, fetched_at = excluded.fetched_at, source = excluded.source`).run(currency, date, rate, fetchedAt, source);
    },
    // { MXN: [{ date, rate, fetchedAt, source }, ...] } ascending by date.
    fxRates() {
      const out = {};
      for (const r of q('SELECT currency, date, rate_to_cop, fetched_at, source FROM fx_rates ORDER BY currency, date').all()) {
        (out[r.currency] ??= []).push({ date: r.date, rate: r.rate_to_cop, fetchedAt: r.fetched_at, source: r.source });
      }
      return out;
    },
    setCountryRates: (countries) => syncCountryRates(db, countries),
    setSpendVat: (pct) => syncSpendVat(db, pct),
    setExcludedAccounts: (ids) => syncExcludedAccounts(db, ids),
    // `accounts`: null = every account; a list (possibly empty) limits the rows to those accounts.
    insightsBetween: (from, to, accounts = null) =>
      (accounts
        ? q('SELECT * FROM insights WHERE date >= ? AND date <= ? AND account_id IN (SELECT value FROM json_each(?)) ORDER BY date, ad_id, country').all(from, to, JSON.stringify(accounts))
        : q('SELECT * FROM insights WHERE date >= ? AND date <= ? ORDER BY date, ad_id, country').all(from, to)
      ).map((r) => ({
        date: r.date, adId: r.ad_id, adName: r.ad_name, campaignId: r.campaign_id, campaignName: r.campaign_name,
        adsetId: r.adset_id, adsetName: r.adset_name, gasto: r.gasto, impressions: r.impressions, clicks: r.clicks, mensajes: r.mensajes, country: r.country, accountId: r.account_id ?? '',
      })),
    insightsRebuilt,
    // What the database holds: first/last day with data and how many days are stored.
    historyStats() {
      const i = q('SELECT MIN(date) AS first, MAX(date) AS last, COUNT(DISTINCT date) AS days FROM insights').get();
      const c = q('SELECT MIN(date) AS first, MAX(date) AS last, COUNT(*) AS rows FROM comprobantes').get();
      return { insightsFrom: i.first, insightsTo: i.last, insightDays: i.days, vouchersFrom: c.first, vouchersTo: c.last, voucherRows: c.rows };
    },
    // Latest known names per ad (any day), so payments of days without spend can still be attributed.
    identities() {
      const rows = q(`SELECT i.* FROM insights i
        JOIN (SELECT ad_id, MAX(date) AS date FROM insights GROUP BY ad_id) m ON i.ad_id = m.ad_id AND i.date = m.date`).all();
      return Object.fromEntries(rows.map((r) => [r.ad_id, { adName: r.ad_name, campaignId: r.campaign_id, campaignName: r.campaign_name, accountId: r.account_id ?? '' }]));
    },

    upsertAds(ads, now, accountId = '') {
      const stmt = q(`INSERT INTO ads (ad_id, name, created_time, effective_status, campaign_id, campaign_name, adset_id, adset_name, updated_at, account_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ad_id) DO UPDATE SET name = excluded.name, created_time = excluded.created_time, effective_status = excluded.effective_status,
          campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name, adset_id = excluded.adset_id, adset_name = excluded.adset_name,
          updated_at = excluded.updated_at, account_id = excluded.account_id`);
      tx(() => {
        for (const a of ads) stmt.run(a.adId, a.name, a.createdTime, a.effectiveStatus, a.campaignId, a.campaignName, a.adsetId, a.adsetName, now, a.accountId ?? accountId);
      });
    },
    // Stores the first day with spend > 0 of every ad that has insights. Past rows are never deleted, so it is stable.
    refreshFirstSpend() {
      q('UPDATE ads SET first_spend_date = (SELECT MIN(date) FROM insights i WHERE i.ad_id = ads.ad_id AND i.gasto > 0)').run();
    },
    firstSpendMap() {
      const rows = q('SELECT ad_id, MIN(date) AS d FROM insights WHERE gasto > 0 GROUP BY ad_id').all();
      return Object.fromEntries(rows.map((r) => [r.ad_id, r.d]));
    },
    // Ad metadata plus `firstSpendDate` (day 1), also for ads missing from the ads table.
    adsWithFirstSpend() {
      const out = { ...this.adsMap() };
      for (const [id, date] of Object.entries(this.firstSpendMap())) out[id] = { ...(out[id] ?? {}), firstSpendDate: date };
      return out;
    },
    adsMap() {
      const rows = q('SELECT * FROM ads').all();
      return Object.fromEntries(
        rows.map((r) => [r.ad_id, { name: r.name, createdTime: r.created_time, effectiveStatus: r.effective_status, campaignId: r.campaign_id, campaignName: r.campaign_name, adsetId: r.adset_id, firstSpendDate: r.first_spend_date, accountId: r.account_id ?? '' }]),
      );
    },

    // Appends a budget row for each ad set / campaign whose budget differs from the last one seen.
    recordBudgets(ads, date, now, accountId = '') {
      const last = q('SELECT daily_budget, lifetime_budget FROM budget_history WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1');
      const insert = q('INSERT INTO budget_history (entity_type, entity_id, date, daily_budget, lifetime_budget, first_seen, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const done = new Set();
      const record = (type, id, daily, lifetime) => {
        const key = `${type}|${id}`;
        if (!id || done.has(key) || (daily == null && lifetime == null)) return;
        done.add(key);
        const prev = last.get(type, id);
        if (prev && prev.daily_budget === daily && prev.lifetime_budget === lifetime) return;
        insert.run(type, id, date, daily, lifetime, now, accountId);
      };
      tx(() => {
        for (const a of ads) {
          record('adset', a.adsetId, a.adsetDailyBudget ?? null, a.adsetLifetimeBudget ?? null);
          record('campaign', a.campaignId, a.campaignDailyBudget ?? null, a.campaignLifetimeBudget ?? null);
        }
      });
    },
    budgetHistory: (type, id) =>
      q('SELECT * FROM budget_history WHERE entity_type = ? AND entity_id = ? ORDER BY id').all(type, id).map((r) => ({
        entityType: r.entity_type, entityId: r.entity_id, date: r.date, dailyBudget: r.daily_budget, lifetimeBudget: r.lifetime_budget, firstSeen: r.first_seen,
      })),

    // Upserts the sheet rows by stable key. Rows that are no longer in the sheet are kept and flagged (missing_since):
    // history is never deleted.
    syncComprobantes(rows, now) {
      const find = q('SELECT id FROM comprobantes WHERE key = ?');
      const insert = q(`INSERT INTO comprobantes (key, date, registered, result, phone, valor, bank, flow, ad_id, ad_lossy, ad_url, client_name, payer_name, synced_at, first_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const update = q(`UPDATE comprobantes SET date = ?, registered = ?, result = ?, phone = ?, valor = ?, bank = ?, flow = ?, ad_id = ?, ad_lossy = ?,
        ad_url = ?, client_name = ?, payer_name = ?, synced_at = ?, missing_since = NULL WHERE key = ?`);
      const markGone = q('UPDATE comprobantes SET missing_since = ? WHERE missing_since IS NULL AND key NOT IN (SELECT value FROM json_each(?))');
      tx(() => {
        const seen = new Map();
        const keys = [];
        for (const c of rows) {
          const base = `${c.registered}|${c.phone}`;
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          const key = c.key ?? comprobanteKey(c, n);
          keys.push(key);
          const args = [c.date, c.registered, c.result, c.phone, c.valor, c.bank, c.flow, c.adId, c.adLossy ? 1 : 0, c.adUrl, c.clientName ?? '', c.payerName ?? '', now];
          if (find.get(key)) update.run(...args, key);
          else insert.run(key, ...args, now);
        }
        markGone.run(now, JSON.stringify(keys));
      });
    },
    setComprobanteCountries(list) {
      const stmt = q('UPDATE comprobantes SET country = ?, country_source = ? WHERE key = ?');
      tx(() => list.forEach((c) => stmt.run(c.country, c.source, c.key)));
    },
    setCountryOverride(key, country, now) {
      if (!country) q('DELETE FROM comprobante_overrides WHERE key = ?').run(key);
      else q('INSERT INTO comprobante_overrides (key, country, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET country = excluded.country, updated_at = excluded.updated_at').run(key, country, now);
    },
    // Assign (or with an empty id, remove) the ad of a payment by hand. Returns false when the payment is not stored.
    setAdOverride(key, adId, now) {
      if (!q('SELECT 1 FROM comprobantes WHERE key = ?').get(key)) return false;
      if (!adId) q('DELETE FROM comprobante_ad_overrides WHERE key = ?').run(key);
      else q('INSERT INTO comprobante_ad_overrides (key, ad_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET ad_id = excluded.ad_id, updated_at = excluded.updated_at').run(key, adId, now);
      return true;
    },
    // Accept (or undo) a payment by hand. Returns false when the payment is not stored.
    setAccepted(key, accepted, now) {
      if (!q('SELECT 1 FROM comprobantes WHERE key = ?').get(key)) return false;
      if (accepted) q('INSERT INTO comprobante_accepts (key, accepted_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, now);
      else q('DELETE FROM comprobante_accepts WHERE key = ?').run(key);
      return true;
    },
    acceptedKeys: () => new Set(q('SELECT key FROM comprobante_accepts').all().map((r) => r.key)),
    comprobantesBetween: (from, to) =>
      q(`SELECT c.*, o.country AS override_country, a.key AS accepted_key, m.ad_id AS override_ad FROM comprobantes c LEFT JOIN comprobante_overrides o ON o.key = c.key
        LEFT JOIN comprobante_accepts a ON a.key = c.key LEFT JOIN comprobante_ad_overrides m ON m.key = c.key
        WHERE c.date >= ? AND c.date <= ? ORDER BY c.date, c.id`).all(from, to).map((r) => ({
        key: r.key, registered: r.registered, date: r.date, result: r.result, phone: r.phone, valor: r.valor, bank: r.bank, flow: r.flow,
        adId: r.override_ad ?? r.ad_id, adSource: r.override_ad ? 'manual' : 'hoja', adLossy: r.override_ad ? false : r.ad_lossy === 1, adUrl: r.ad_url, clientName: r.client_name, payerName: r.payer_name, gone: r.missing_since != null, accepted: r.accepted_key != null,
        country: r.override_country ?? r.country, countrySource: r.override_country ? 'manual' : r.country_source,
      })),

    upsertBudgetEvents(events, accountId = '') {
      const stmt = q('INSERT OR IGNORE INTO budget_events (entity_type, entity_id, time, date, old_budget, new_budget, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      tx(() => {
        for (const e of events) stmt.run(e.entityType, e.entityId, e.time, e.date, e.oldBudget, e.newBudget, e.accountId ?? accountId);
      });
    },
    budgetEvents: () =>
      q('SELECT * FROM budget_events ORDER BY time').all().map((r) => ({
        entityType: r.entity_type, entityId: r.entity_id, time: r.time, date: r.date, oldBudget: r.old_budget, newBudget: r.new_budget,
      })),
    // { "adset|s1": [rows in order] }
    budgetHistories() {
      const out = {};
      for (const r of q('SELECT * FROM budget_history ORDER BY id').all()) {
        (out[`${r.entity_type}|${r.entity_id}`] ??= []).push({ date: r.date, dailyBudget: r.daily_budget, lifetimeBudget: r.lifetime_budget, firstSeen: r.first_seen });
      }
      return out;
    },

    // Returns the stored decision (with id) or null when the key already exists.
    insertDecision(d, now) {
      const res = q('INSERT OR IGNORE INTO decisions (key, kind, entity_type, entity_id, label, day_n, due_date, late, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(d.key, d.kind, d.entityType, d.entityId, d.label, d.dayN, d.dueDate, d.late ? 1 : 0, JSON.stringify(d), now, now);
      return res.changes ? Number(res.lastInsertRowid) : null;
    },
    decisionKeys: () => new Set(q('SELECT key FROM decisions').all().map((r) => r.key)),
    decisions(limit = 300) {
      return q('SELECT * FROM decisions ORDER BY created_at DESC, id DESC LIMIT ?').all(limit).map((r) => ({
        ...JSON.parse(r.payload), id: r.id, status: r.status, createdAt: r.created_at, notifiedAt: r.notified_at, updatedAt: r.updated_at,
      }));
    },
    setDecisionStatus(id, status, now) {
      return Number(q('UPDATE decisions SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id).changes) > 0;
    },
    markNotified(ids, now) {
      const stmt = q('UPDATE decisions SET notified_at = ? WHERE id = ?');
      tx(() => ids.forEach((id) => stmt.run(now, id)));
    },

    enqueueWhatsapp(text, source, now) {
      q('INSERT INTO wa_outbox (text, source, created_at) VALUES (?, ?, ?)').run(text, source, now);
    },
    pendingWhatsapp: () => q('SELECT * FROM wa_outbox WHERE sent_at IS NULL ORDER BY id').all(),
    markWhatsappSent(id, now) {
      q('UPDATE wa_outbox SET sent_at = ? WHERE id = ?').run(now, id);
    },

    counts: () => ({
      insights: q('SELECT COUNT(*) n FROM insights').get().n,
      ads: q('SELECT COUNT(*) n FROM ads').get().n,
      comprobantes: q('SELECT COUNT(*) n FROM comprobantes').get().n,
      budgets: q('SELECT COUNT(*) n FROM budget_history').get().n,
    }),
  };
}

// <data dir>/ads/ads.db
export function openStoreAt(dataDir) {
  fs.mkdirSync(adsDir(dataDir), { recursive: true });
  // Rows saved before accounts existed belong to the account the single-account config pointed at.
  return createStore(path.join(adsDir(dataDir), 'ads.db'), { defaultAccountId: loadConfig(dataDir).adAccountId });
}

// Read-only handle on an existing ads.db (the Analista never writes to it).
export function openStoreReadOnly(dataDir) {
  return createStore(path.join(adsDir(dataDir), 'ads.db'), { readOnly: true });
}
