// agent.db: the Analista's own SQLite (<data dir>/analista/agent.db). It is the ONLY database the agent can write to,
// and only through the code paths in this module. The ads database stays read-only for everything in this folder.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { agentDbPath } from './paths.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, claude_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_session ON messages (session_id, id);
-- Tool results of each turn: the sources the figure grounding check looks numbers up in (also for later turns).
CREATE TABLE IF NOT EXISTS turn_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, message_id INTEGER, tool TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_sources_session ON turn_sources (session_id, id);
CREATE TABLE IF NOT EXISTS query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT, question TEXT, purpose TEXT, sql TEXT NOT NULL,
  status TEXT NOT NULL, layer TEXT, reason TEXT, rows INTEGER, ms INTEGER
);
CREATE INDEX IF NOT EXISTS query_log_ts ON query_log (ts);
`;

const MAX_SOURCE_CHARS = 120_000;

export function createAgentStore(file = ':memory:', { now = Date.now } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const store = {
    db,
    tx,
    now,
    close: () => db.close(),

    getKv(key) {
      const r = q('SELECT value FROM kv WHERE key = ?').get(key);
      return r ? JSON.parse(r.value) : null;
    },
    setKv(key, value) {
      q('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value ?? null));
    },

    createSession(title = 'Nuevo chat') {
      const id = randomUUID();
      const t = now();
      q('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, t, t);
      return id;
    },
    listSessions: () =>
      q('SELECT id, title, claude_session_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC, created_at DESC').all().map((r) => ({
        id: r.id, title: r.title, claudeSessionId: r.claude_session_id, createdAt: r.created_at, updatedAt: r.updated_at,
      })),
    getSession(id) {
      const r = q('SELECT id, title, claude_session_id, created_at, updated_at FROM sessions WHERE id = ?').get(id);
      return r ? { id: r.id, title: r.title, claudeSessionId: r.claude_session_id, createdAt: r.created_at, updatedAt: r.updated_at } : null;
    },
    renameSession(id, title) {
      return Number(q('UPDATE sessions SET title = ? WHERE id = ?').run(String(title).slice(0, 120), id).changes) > 0;
    },
    setClaudeSessionId(id, claudeSessionId) {
      q('UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?').run(claudeSessionId, now(), id);
    },
    touchSession(id) {
      q('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), id);
    },
    deleteSession(id) {
      tx(() => {
        q('DELETE FROM turn_sources WHERE session_id = ?').run(id);
        q('DELETE FROM messages WHERE session_id = ?').run(id);
        q('DELETE FROM sessions WHERE id = ?').run(id);
      });
    },

    addMessage({ sessionId, role, text, meta = {} }) {
      const res = q('INSERT INTO messages (session_id, role, text, ts, meta) VALUES (?, ?, ?, ?, ?)').run(sessionId, role, text, now(), JSON.stringify(meta));
      store.touchSession(sessionId);
      return Number(res.lastInsertRowid);
    },
    updateMessage(id, { text, meta }) {
      if (text !== undefined) q('UPDATE messages SET text = ? WHERE id = ?').run(text, id);
      if (meta !== undefined) q('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
    },
    getMessage(id) {
      const r = q('SELECT * FROM messages WHERE id = ?').get(id);
      return r ? { id: r.id, sessionId: r.session_id, role: r.role, text: r.text, ts: r.ts, meta: JSON.parse(r.meta) } : null;
    },
    messages: (sessionId) =>
      q('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(sessionId).map((r) => ({
        id: r.id, sessionId: r.session_id, role: r.role, text: r.text, ts: r.ts, meta: JSON.parse(r.meta),
      })),

    addSource({ sessionId, messageId = null, tool, text }) {
      q('INSERT INTO turn_sources (session_id, message_id, tool, text, ts) VALUES (?, ?, ?, ?, ?)').run(sessionId, messageId, tool, String(text).slice(0, MAX_SOURCE_CHARS), now());
    },
    // Tool results of this session (newest last), used as grounding sources for follow-up questions.
    sourcesForSession: (sessionId, limit = 200) =>
      q('SELECT text FROM (SELECT id, text FROM turn_sources WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(sessionId, limit).map((r) => r.text),
    attachSources(sessionId, messageId) {
      q('UPDATE turn_sources SET message_id = ? WHERE session_id = ? AND message_id IS NULL').run(messageId, sessionId);
    },

    logQuery({ sessionId = null, question = null, purpose = null, sql, status, layer = null, reason = null, rows = null, ms = null }) {
      q('INSERT INTO query_log (ts, session_id, question, purpose, sql, status, layer, reason, rows, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        now(), sessionId, question ? String(question).slice(0, 500) : null, purpose ? String(purpose).slice(0, 200) : null, String(sql).slice(0, 4000), status, layer, reason, rows, ms,
      );
    },
    recentQueries: (limit = 100) => q('SELECT * FROM query_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ ...r })),
  };
  return store;
}

export function openAgentStore(dataDir, options) {
  return createAgentStore(agentDbPath(dataDir), options);
}
