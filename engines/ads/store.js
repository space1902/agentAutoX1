// SQLite persistence (built-in node:sqlite, Node >= 22.13): daily insights per ad, ad metadata, budget history
// and the payments cache. Daily insights are upserted, so past days survive even if Meta later changes them.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { adsDir } from './config.js';
import { installViews, refreshAdCt, syncCountryRates } from './views.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS insights (
  date TEXT NOT NULL, ad_id TEXT NOT NULL, ad_name TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL,
  adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, gasto REAL NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL,
  mensajes INTEGER NOT NULL, synced_at INTEGER NOT NULL, country TEXT NOT NULL DEFAULT '', PRIMARY KEY (date, ad_id, country)
);
CREATE INDEX IF NOT EXISTS insights_ad ON insights (ad_id, date);
CREATE TABLE IF NOT EXISTS ads (
  ad_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_time TEXT NOT NULL, effective_status TEXT NOT NULL,
  campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, updated_at INTEGER NOT NULL,
  first_spend_date TEXT -- first day with spend > 0: "day 1" of the ad (created_time is only a reference)
);
-- Budgets are stored as Meta returns them (currency minor units). A row is appended only when the value changes.
CREATE TABLE IF NOT EXISTS budget_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, date TEXT NOT NULL,
  daily_budget REAL, lifetime_budget REAL, first_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS budget_entity ON budget_history (entity_type, entity_id, id);
CREATE TABLE IF NOT EXISTS comprobantes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, registered TEXT NOT NULL, result TEXT NOT NULL, phone TEXT NOT NULL,
  valor REAL NOT NULL, bank TEXT NOT NULL, flow TEXT NOT NULL, ad_id TEXT NOT NULL, ad_lossy INTEGER NOT NULL,
  ad_url TEXT NOT NULL, synced_at INTEGER NOT NULL,
  key TEXT, first_seen INTEGER, missing_since INTEGER, country TEXT NOT NULL DEFAULT '', country_source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS comprobantes_date ON comprobantes (date);
-- Manual country of a payment, kept apart so a re-sync never overwrites it.
CREATE TABLE IF NOT EXISTS comprobante_overrides (key TEXT PRIMARY KEY, country TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- Exact budget changes read from the account activity log (when Meta exposes it).
CREATE TABLE IF NOT EXISTS budget_events (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, time INTEGER NOT NULL, date TEXT NOT NULL,
  old_budget REAL NOT NULL, new_budget REAL NOT NULL, PRIMARY KEY (entity_type, entity_id, time, new_budget)
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

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// Brings databases created by earlier versions up to date. Returns true when insights had to be rebuilt.
function migrate(db) {
  let rebuilt = false;
  if (!columns(db, 'insights').includes('country')) {
    db.exec('BEGIN');
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
  ]) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE comprobantes ADD COLUMN ${ddl}`);
  }
  const loose = db.prepare('SELECT id, registered, phone FROM comprobantes WHERE key IS NULL ORDER BY id').all();
  if (loose.length) {
    const seen = new Map();
    const set = db.prepare('UPDATE comprobantes SET key = ?, first_seen = COALESCE(first_seen, synced_at) WHERE id = ?');
    db.exec('BEGIN');
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
  db.exec("UPDATE insights SET country = '' WHERE country = 'unknown' AND NOT EXISTS (SELECT 1 FROM insights i2 WHERE i2.date = insights.date AND i2.ad_id = insights.ad_id AND i2.country = '')");
  return rebuilt;
}

// `readOnly`: opens an existing database for reading only (no schema, migration or view work). Used by the Analista.
export function createStore(file = ':memory:', { readOnly = false } = {}) {
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  let insightsRebuilt = false;
  if (!readOnly) {
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    insightsRebuilt = migrate(db);
    if (!db.prepare('PRAGMA table_info(ads)').all().some((c) => c.name === 'first_spend_date')) db.exec('ALTER TABLE ads ADD COLUMN first_spend_date TEXT');
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

    // Replaces every row of each (date, ad) in the batch, so Meta restating a day (or the country split appearing)
    // never double counts. Days Meta does not return are left untouched.
    upsertInsights(rows, now) {
      const remove = q('DELETE FROM insights WHERE date = ? AND ad_id = ?');
      const insert = q(`INSERT INTO insights (date, ad_id, ad_name, campaign_id, campaign_name, adset_id, adset_name, gasto, impressions, clicks, mensajes, synced_at, country)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, ad_id, country) DO UPDATE SET ad_name = excluded.ad_name, campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name,
          adset_id = excluded.adset_id, adset_name = excluded.adset_name, gasto = gasto + excluded.gasto, impressions = impressions + excluded.impressions,
          clicks = clicks + excluded.clicks, mensajes = mensajes + excluded.mensajes, synced_at = excluded.synced_at`);
      tx(() => {
        const groups = new Set(rows.map((r) => `${r.date}|${r.adId}`));
        for (const g of groups) remove.run(...g.split('|'));
        for (const r of rows) insert.run(r.date, r.adId, r.adName, r.campaignId, r.campaignName, r.adsetId, r.adsetName, r.gasto, r.impressions, r.clicks, r.mensajes, now, r.country ?? '');
      });
      refreshAdCt(db);
    },
    setCountryRates: (countries) => syncCountryRates(db, countries),
    insightsBetween: (from, to) =>
      q('SELECT * FROM insights WHERE date >= ? AND date <= ? ORDER BY date, ad_id, country').all(from, to).map((r) => ({
        date: r.date, adId: r.ad_id, adName: r.ad_name, campaignId: r.campaign_id, campaignName: r.campaign_name,
        adsetId: r.adset_id, adsetName: r.adset_name, gasto: r.gasto, impressions: r.impressions, clicks: r.clicks, mensajes: r.mensajes, country: r.country,
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
      const rows = q(`SELECT i.ad_id, i.ad_name, i.campaign_id, i.campaign_name FROM insights i
        JOIN (SELECT ad_id, MAX(date) AS date FROM insights GROUP BY ad_id) m ON i.ad_id = m.ad_id AND i.date = m.date`).all();
      return Object.fromEntries(rows.map((r) => [r.ad_id, { adName: r.ad_name, campaignId: r.campaign_id, campaignName: r.campaign_name }]));
    },

    upsertAds(ads, now) {
      const stmt = q(`INSERT INTO ads (ad_id, name, created_time, effective_status, campaign_id, campaign_name, adset_id, adset_name, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ad_id) DO UPDATE SET name = excluded.name, created_time = excluded.created_time, effective_status = excluded.effective_status,
          campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name, adset_id = excluded.adset_id, adset_name = excluded.adset_name,
          updated_at = excluded.updated_at`);
      tx(() => {
        for (const a of ads) stmt.run(a.adId, a.name, a.createdTime, a.effectiveStatus, a.campaignId, a.campaignName, a.adsetId, a.adsetName, now);
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
        rows.map((r) => [r.ad_id, { name: r.name, createdTime: r.created_time, effectiveStatus: r.effective_status, campaignId: r.campaign_id, adsetId: r.adset_id, firstSpendDate: r.first_spend_date }]),
      );
    },

    // Appends a budget row for each ad set / campaign whose budget differs from the last one seen.
    recordBudgets(ads, date, now) {
      const last = q('SELECT daily_budget, lifetime_budget FROM budget_history WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1');
      const insert = q('INSERT INTO budget_history (entity_type, entity_id, date, daily_budget, lifetime_budget, first_seen) VALUES (?, ?, ?, ?, ?, ?)');
      const done = new Set();
      const record = (type, id, daily, lifetime) => {
        const key = `${type}|${id}`;
        if (!id || done.has(key) || (daily == null && lifetime == null)) return;
        done.add(key);
        const prev = last.get(type, id);
        if (prev && prev.daily_budget === daily && prev.lifetime_budget === lifetime) return;
        insert.run(type, id, date, daily, lifetime, now);
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
      const insert = q(`INSERT INTO comprobantes (key, date, registered, result, phone, valor, bank, flow, ad_id, ad_lossy, ad_url, synced_at, first_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const update = q(`UPDATE comprobantes SET date = ?, registered = ?, result = ?, phone = ?, valor = ?, bank = ?, flow = ?, ad_id = ?, ad_lossy = ?,
        ad_url = ?, synced_at = ?, missing_since = NULL WHERE key = ?`);
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
          const args = [c.date, c.registered, c.result, c.phone, c.valor, c.bank, c.flow, c.adId, c.adLossy ? 1 : 0, c.adUrl, now];
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
    comprobantesBetween: (from, to) =>
      q(`SELECT c.*, o.country AS override_country FROM comprobantes c LEFT JOIN comprobante_overrides o ON o.key = c.key
        WHERE c.date >= ? AND c.date <= ? ORDER BY c.date, c.id`).all(from, to).map((r) => ({
        key: r.key, registered: r.registered, date: r.date, result: r.result, phone: r.phone, valor: r.valor, bank: r.bank, flow: r.flow,
        adId: r.ad_id, adLossy: r.ad_lossy === 1, adUrl: r.ad_url, gone: r.missing_since != null,
        country: r.override_country ?? r.country, countrySource: r.override_country ? 'manual' : r.country_source,
      })),

    upsertBudgetEvents(events) {
      const stmt = q('INSERT OR IGNORE INTO budget_events (entity_type, entity_id, time, date, old_budget, new_budget) VALUES (?, ?, ?, ?, ?, ?)');
      tx(() => {
        for (const e of events) stmt.run(e.entityType, e.entityId, e.time, e.date, e.oldBudget, e.newBudget);
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
  return createStore(path.join(adsDir(dataDir), 'ads.db'));
}

// Read-only handle on an existing ads.db (the Analista never writes to it).
export function openStoreReadOnly(dataDir) {
  return createStore(path.join(adsDir(dataDir), 'ads.db'), { readOnly: true });
}
