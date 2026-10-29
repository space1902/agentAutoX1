// SQLite persistence (built-in node:sqlite, no native dependencies).
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS samples (
  ts INTEGER NOT NULL, ad_id TEXT NOT NULL, spend REAL NOT NULL, purchases INTEGER NOT NULL, conversations INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ad_id TEXT NOT NULL, count INTEGER NOT NULL, spend_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS sales_ts ON sales (ts);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
  created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, family TEXT NOT NULL, severity INTEGER NOT NULL,
  type TEXT NOT NULL, text TEXT NOT NULL, sent INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS actions_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, target_id TEXT,
  request_id INTEGER, ok INTEGER NOT NULL, result TEXT
);
`;

const json = (value) => JSON.stringify(value ?? null);

export function createStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);
  const requestRow = (row) =>
    row && { id: row.id, kind: row.kind, payload: JSON.parse(row.payload), status: row.status, createdTs: row.created_ts, expiresTs: row.expires_ts };

  return {
    close: () => db.close(),

    getKv(key) {
      const row = q('SELECT value FROM kv WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : null;
    },
    setKv(key, value) {
      q('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, json(value));
    },

    addSamples(ts, ads) {
      const insert = q('INSERT INTO samples (ts, ad_id, spend, purchases, conversations) VALUES (?, ?, ?, ?, ?)');
      for (const ad of ads) insert.run(ts, ad.id, ad.spend, ad.purchases, ad.conversations);
    },
    latestSamples() {
      const rows = q(
        'SELECT s.* FROM samples s JOIN (SELECT ad_id, MAX(ts) AS ts FROM samples GROUP BY ad_id) m ON s.ad_id = m.ad_id AND s.ts = m.ts',
      ).all();
      return Object.fromEntries(rows.map((r) => [r.ad_id, { ts: r.ts, spend: r.spend, purchases: r.purchases, conversations: r.conversations }]));
    },
    // The poll closest to (and not after) `ts`, as { adId: {...} }, or null when there is none.
    samplesAtOrBefore(ts) {
      const top = q('SELECT MAX(ts) AS ts FROM samples WHERE ts <= ?').get(ts);
      if (top?.ts == null) return null;
      const rows = q('SELECT * FROM samples WHERE ts = ?').all(top.ts);
      return Object.fromEntries(rows.map((r) => [r.ad_id, { ts: r.ts, spend: r.spend, purchases: r.purchases, conversations: r.conversations }]));
    },
    oldestSampleTs: () => q('SELECT MIN(ts) AS ts FROM samples').get()?.ts ?? null,
    pruneSamples(beforeTs) {
      q('DELETE FROM samples WHERE ts < ?').run(beforeTs);
    },

    addSale({ adId, count, spendAt, ts }) {
      q('INSERT INTO sales (ts, ad_id, count, spend_at) VALUES (?, ?, ?, ?)').run(ts, adId, count, spendAt);
    },
    lastSales(sinceTs) {
      const rows = q('SELECT ts, ad_id, spend_at FROM sales WHERE ts >= ? ORDER BY ts ASC, id ASC').all(sinceTs);
      const ads = {};
      let accountLastTs = null;
      for (const r of rows) {
        ads[r.ad_id] = { ts: r.ts, spendAt: r.spend_at };
        accountLastTs = r.ts;
      }
      return { accountLastTs, ads };
    },
    salesBetween: (fromTs, toTs) => q('SELECT * FROM sales WHERE ts >= ? AND ts <= ? ORDER BY ts').all(fromTs, toTs),

    createRequest({ kind, payload, now, ttlMin }) {
      const res = q('INSERT INTO requests (kind, payload, status, created_ts, expires_ts) VALUES (?, ?, ?, ?, ?)').run(
        kind, json(payload), 'pending', now, now + ttlMin * 60_000,
      );
      return Number(res.lastInsertRowid);
    },
    getRequest: (id) => requestRow(q('SELECT * FROM requests WHERE id = ?').get(id)) ?? null,
    pendingRequests: (now) =>
      q("SELECT * FROM requests WHERE status = 'pending' AND expires_ts > ? ORDER BY id").all(now).map(requestRow),
    queuedRequests: () => q("SELECT * FROM requests WHERE status = 'queued' ORDER BY id").all().map(requestRow),
    expireRequests(now) {
      const res = q("UPDATE requests SET status = 'expired' WHERE status IN ('pending', 'queued') AND expires_ts <= ?").run(now);
      return Number(res.changes);
    },
    setRequestStatus(id, status, { expiresTs } = {}) {
      if (expiresTs != null) q('UPDATE requests SET status = ?, expires_ts = ? WHERE id = ?').run(status, expiresTs, id);
      else q('UPDATE requests SET status = ? WHERE id = ?').run(status, id);
    },

    logAlert({ ts, family, severity, type, text, sent }) {
      q('INSERT INTO alerts_log (ts, family, severity, type, text, sent) VALUES (?, ?, ?, ?, ?, ?)').run(ts, family, severity, type, text, sent ? 1 : 0);
    },
    // Latest SENT alert per family since `sinceTs` (suppressed alerts do not start a cooldown).
    lastSentByFamily(sinceTs) {
      const rows = q('SELECT family, severity, ts FROM alerts_log WHERE sent = 1 AND ts >= ? ORDER BY ts ASC, id ASC').all(sinceTs);
      const out = {};
      for (const r of rows) out[r.family] = { ts: r.ts, severity: r.severity };
      return out;
    },
    recentAlerts: (limit) =>
      q('SELECT id, ts, family, severity, type, text, sent FROM alerts_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
        id: r.id, ts: r.ts, family: r.family, severity: r.severity, type: r.type, text: r.text, sent: r.sent === 1,
      })),
    countAlerts: () => q('SELECT COUNT(*) AS n FROM alerts_log').get().n,

    logAction({ ts, kind, targetId, requestId, ok, result }) {
      q('INSERT INTO actions_log (ts, kind, target_id, request_id, ok, result) VALUES (?, ?, ?, ?, ?, ?)').run(
        ts, kind, targetId ?? null, requestId ?? null, ok ? 1 : 0, json(result),
      );
    },
    recentActions: (limit) =>
      q('SELECT * FROM actions_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
        id: r.id, ts: r.ts, kind: r.kind, targetId: r.target_id, requestId: r.request_id, ok: r.ok === 1, result: JSON.parse(r.result),
      })),
  };
}
