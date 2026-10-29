// SQLite persistence (built-in node:sqlite, Node >= 22.13): daily insights per ad, ad metadata, budget history
// and the payments cache. Daily insights are upserted, so past days survive even if Meta later changes them.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { adsDir } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS insights (
  date TEXT NOT NULL, ad_id TEXT NOT NULL, ad_name TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL,
  adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, gasto REAL NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL,
  mensajes INTEGER NOT NULL, synced_at INTEGER NOT NULL, PRIMARY KEY (date, ad_id)
);
CREATE INDEX IF NOT EXISTS insights_ad ON insights (ad_id, date);
CREATE TABLE IF NOT EXISTS ads (
  ad_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_time TEXT NOT NULL, effective_status TEXT NOT NULL,
  campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, adset_id TEXT NOT NULL, adset_name TEXT NOT NULL, updated_at INTEGER NOT NULL
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
  ad_url TEXT NOT NULL, synced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comprobantes_date ON comprobantes (date);
`;

export function createStore(file = ':memory:') {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
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
    close: () => db.close(),

    getKv(key) {
      const r = q('SELECT value FROM kv WHERE key = ?').get(key);
      return r ? JSON.parse(r.value) : null;
    },
    setKv(key, value) {
      q('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value ?? null));
    },

    upsertInsights(rows, now) {
      const stmt = q(`INSERT INTO insights (date, ad_id, ad_name, campaign_id, campaign_name, adset_id, adset_name, gasto, impressions, clicks, mensajes, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, ad_id) DO UPDATE SET ad_name = excluded.ad_name, campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name,
          adset_id = excluded.adset_id, adset_name = excluded.adset_name, gasto = excluded.gasto, impressions = excluded.impressions,
          clicks = excluded.clicks, mensajes = excluded.mensajes, synced_at = excluded.synced_at`);
      tx(() => {
        for (const r of rows) stmt.run(r.date, r.adId, r.adName, r.campaignId, r.campaignName, r.adsetId, r.adsetName, r.gasto, r.impressions, r.clicks, r.mensajes, now);
      });
    },
    insightsBetween: (from, to) =>
      q('SELECT * FROM insights WHERE date >= ? AND date <= ? ORDER BY date, ad_id').all(from, to).map((r) => ({
        date: r.date, adId: r.ad_id, adName: r.ad_name, campaignId: r.campaign_id, campaignName: r.campaign_name,
        adsetId: r.adset_id, adsetName: r.adset_name, gasto: r.gasto, impressions: r.impressions, clicks: r.clicks, mensajes: r.mensajes,
      })),
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
    adsMap() {
      const rows = q('SELECT * FROM ads').all();
      return Object.fromEntries(
        rows.map((r) => [r.ad_id, { name: r.name, createdTime: r.created_time, effectiveStatus: r.effective_status, campaignId: r.campaign_id, adsetId: r.adset_id }]),
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

    replaceComprobantes(rows, now) {
      const insert = q('INSERT INTO comprobantes (date, registered, result, phone, valor, bank, flow, ad_id, ad_lossy, ad_url, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      tx(() => {
        db.exec('DELETE FROM comprobantes');
        for (const c of rows) insert.run(c.date, c.registered, c.result, c.phone, c.valor, c.bank, c.flow, c.adId, c.adLossy ? 1 : 0, c.adUrl, now);
      });
    },
    comprobantesBetween: (from, to) =>
      q('SELECT * FROM comprobantes WHERE date >= ? AND date <= ? ORDER BY date, id').all(from, to).map((r) => ({
        registered: r.registered, date: r.date, result: r.result, phone: r.phone, valor: r.valor, bank: r.bank, flow: r.flow,
        adId: r.ad_id, adLossy: r.ad_lossy === 1, adUrl: r.ad_url,
      })),

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
