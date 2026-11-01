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

-- Learning from real outcomes. baseline_json is computed by code at record time, never by the model.
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, rec_date TEXT NOT NULL, session_id TEXT, message_id INTEGER,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, entity_label TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, params_json TEXT NOT NULL DEFAULT '{}',
  rationale TEXT NOT NULL DEFAULT '', baseline_json TEXT NOT NULL, eval_after_days INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'pending', followed TEXT NOT NULL DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS recommendations_status ON recommendations (status, rec_date);
CREATE TABLE IF NOT EXISTS outcomes (
  rec_id INTEGER PRIMARY KEY, evaluated_at INTEGER NOT NULL, after_json TEXT NOT NULL, label TEXT NOT NULL, explanation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, text TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'general', kind TEXT NOT NULL DEFAULT 'rule',
  source TEXT NOT NULL DEFAULT 'distiller', evidence_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'candidate', weight REAL NOT NULL DEFAULT 1,
  created INTEGER NOT NULL, updated INTEGER NOT NULL, certified_at INTEGER, shown INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT, message_id INTEGER, kind TEXT NOT NULL, weight REAL NOT NULL, note TEXT
);
CREATE INDEX IF NOT EXISTS signals_ts ON signals (ts);

-- Quality evaluation: runs and per-question results (expected values are computed at run time and stored only as evidence).
CREATE TABLE IF NOT EXISTS eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL, passed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '', usage_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS eval_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, question_id TEXT NOT NULL, category TEXT NOT NULL, question TEXT NOT NULL,
  status TEXT NOT NULL, expected TEXT NOT NULL DEFAULT '', answer TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', ms INTEGER NOT NULL DEFAULT 0, ungrounded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS eval_results_run ON eval_results (run_id);
`;

const recRow = (r) => ({
  id: r.id, ts: r.ts, recDate: r.rec_date, sessionId: r.session_id, messageId: r.message_id, entityType: r.entity_type, entityId: r.entity_id, entityLabel: r.entity_label,
  action: r.action, params: JSON.parse(r.params_json), rationale: r.rationale, baseline: JSON.parse(r.baseline_json), evalAfterDays: r.eval_after_days, status: r.status,
  followed: r.followed, outcome: r.label ? { evaluatedAt: r.evaluated_at, after: JSON.parse(r.after_json), label: r.label, explanation: r.explanation } : null,
});

const lessonRow = (r) => ({
  id: r.id, key: r.key, text: r.text, scope: r.scope, kind: r.kind, source: r.source, evidence: JSON.parse(r.evidence_json), status: r.status, weight: r.weight,
  created: r.created, updated: r.updated, certifiedAt: r.certified_at, shown: r.shown === 1,
});

const MAX_SOURCE_CHARS = 120_000;

export function createAgentStore(file = ':memory:', { now = Date.now, schemaExtra = '' } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Tables only one agent owns (e.g. the creativo's generation approvals); the Analista's database never gets them.
  if (schemaExtra) db.exec(schemaExtra);
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

    // ---- recommendations / outcomes
    addRecommendation(r) {
      const res = q(`INSERT INTO recommendations (ts, rec_date, session_id, message_id, entity_type, entity_id, entity_label, action, params_json, rationale, baseline_json, eval_after_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        now(), r.recDate, r.sessionId ?? null, r.messageId ?? null, r.entityType, r.entityId, r.entityLabel ?? '', r.action, JSON.stringify(r.params ?? {}),
        r.rationale ?? '', JSON.stringify(r.baseline), r.evalAfterDays,
      );
      return Number(res.lastInsertRowid);
    },
    findPendingRecommendation: (sessionId, entityType, entityId, action, recDate) => {
      const r = q("SELECT id FROM recommendations WHERE session_id IS ? AND entity_type = ? AND entity_id = ? AND action = ? AND rec_date = ? AND status = 'pending'").get(sessionId ?? null, entityType, entityId, action, recDate);
      return r ? r.id : null;
    },
    attachRecommendations(sessionId, messageId) {
      q('UPDATE recommendations SET message_id = ? WHERE session_id = ? AND message_id IS NULL').run(messageId, sessionId);
    },
    recommendations: (limit = 200) =>
      q('SELECT r.*, o.evaluated_at, o.after_json, o.label, o.explanation FROM recommendations r LEFT JOIN outcomes o ON o.rec_id = r.id ORDER BY r.id DESC LIMIT ?').all(limit).map(recRow),
    pendingRecommendations: () => q("SELECT * FROM recommendations WHERE status = 'pending' ORDER BY id").all().map((r) => recRow({ ...r })),
    saveOutcome({ recId, afterJson, label, explanation, followed }) {
      tx(() => {
        q('INSERT INTO outcomes (rec_id, evaluated_at, after_json, label, explanation) VALUES (?, ?, ?, ?, ?) ON CONFLICT(rec_id) DO UPDATE SET evaluated_at = excluded.evaluated_at, after_json = excluded.after_json, label = excluded.label, explanation = excluded.explanation')
          .run(recId, now(), JSON.stringify(afterJson), label, explanation);
        q("UPDATE recommendations SET status = 'evaluated', followed = ? WHERE id = ?").run(followed, recId);
      });
    },
    labeledOutcomes: () =>
      q('SELECT r.*, o.evaluated_at, o.after_json, o.label, o.explanation FROM recommendations r JOIN outcomes o ON o.rec_id = r.id ORDER BY r.id').all().map(recRow),

    // ---- lessons
    lessons: (status) =>
      q(`SELECT * FROM lessons ${status ? 'WHERE status = ?' : ''} ORDER BY CASE status WHEN 'candidate' THEN 0 WHEN 'certified' THEN 1 ELSE 2 END, weight DESC, id DESC`).all(...(status ? [status] : [])).map(lessonRow),
    getLesson(id) {
      const r = q('SELECT * FROM lessons WHERE id = ?').get(id);
      return r ? lessonRow(r) : null;
    },
    getLessonByKey(key) {
      const r = q('SELECT * FROM lessons WHERE key = ?').get(key);
      return r ? lessonRow(r) : null;
    },
    insertLesson(l) {
      const t = now();
      const res = q('INSERT INTO lessons (key, text, scope, kind, source, evidence_json, status, weight, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(l.key, l.text, l.scope ?? 'general', l.kind ?? 'rule', l.source ?? 'distiller', JSON.stringify(l.evidence ?? {}), 'candidate', l.weight ?? 1, t, t);
      return Number(res.lastInsertRowid);
    },
    updateLesson(id, patch) {
      const cur = store.getLesson(id);
      if (!cur) return false;
      const next = { ...cur, ...patch };
      q('UPDATE lessons SET text = ?, evidence_json = ?, weight = ?, status = ?, certified_at = ?, shown = ?, updated = ? WHERE id = ?')
        .run(next.text, JSON.stringify(next.evidence), next.weight, next.status, next.certifiedAt ?? null, next.shown ? 1 : 0, now(), id);
      return true;
    },
    unshownCandidates: () => q("SELECT * FROM lessons WHERE status = 'candidate' AND shown = 0 ORDER BY id").all().map(lessonRow),
    markShown(ids) {
      const stmt = q('UPDATE lessons SET shown = 1 WHERE id = ?');
      tx(() => ids.forEach((id) => stmt.run(id)));
    },

    // ---- signals
    addSignal({ sessionId = null, messageId = null, kind, weight, note = null }) {
      q('INSERT INTO signals (ts, session_id, message_id, kind, weight, note) VALUES (?, ?, ?, ?, ?, ?)').run(now(), sessionId, messageId, kind, weight, note);
    },
    removeSignals(messageId, kinds) {
      q(`DELETE FROM signals WHERE message_id = ? AND kind IN (${kinds.map(() => '?').join(',')})`).run(messageId, ...kinds);
    },
    signals: (since = 0) =>
      q('SELECT * FROM signals WHERE ts >= ? ORDER BY id').all(since).map((r) => ({ id: r.id, ts: r.ts, sessionId: r.session_id, messageId: r.message_id, kind: r.kind, weight: r.weight, note: r.note })),

    // ---- quality evaluation
    createEvalRun: ({ total, model }) => Number(q('INSERT INTO eval_runs (ts, total, model) VALUES (?, ?, ?)').run(now(), total, model ?? '').lastInsertRowid),
    addEvalResult(r) {
      q('INSERT INTO eval_results (run_id, question_id, category, question, status, expected, answer, detail, ms, ungrounded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(r.runId, r.questionId, r.category, r.question, r.status, r.expected ?? '', String(r.answer ?? '').slice(0, 8000), r.detail ?? '', r.ms ?? 0, r.ungrounded ?? 0);
    },
    finishEvalRun(id, { status, passed, failed, excluded, usage }) {
      q('UPDATE eval_runs SET finished_at = ?, status = ?, passed = ?, failed = ?, excluded = ?, usage_json = ? WHERE id = ?').run(now(), status, passed, failed, excluded, JSON.stringify(usage ?? {}), id);
    },
    evalRuns: (limit = 50) =>
      q('SELECT * FROM eval_runs ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
        id: r.id, ts: r.ts, finishedAt: r.finished_at, status: r.status, total: r.total, passed: r.passed, failed: r.failed, excluded: r.excluded, model: r.model, usage: JSON.parse(r.usage_json),
        passRate: r.passed + r.failed > 0 ? r.passed / (r.passed + r.failed) : null,
      })),
    evalResults: (runId) =>
      q('SELECT * FROM eval_results WHERE run_id = ? ORDER BY id').all(runId).map((r) => ({
        id: r.id, runId: r.run_id, questionId: r.question_id, category: r.category, question: r.question, status: r.status, expected: r.expected, answer: r.answer, detail: r.detail, ms: r.ms, ungrounded: r.ungrounded,
      })),

    logQuery({ sessionId = null, question = null, purpose = null, sql, status, layer = null, reason = null, rows = null, ms = null }) {
      q('INSERT INTO query_log (ts, session_id, question, purpose, sql, status, layer, reason, rows, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        now(), sessionId, question ? String(question).slice(0, 500) : null, purpose ? String(purpose).slice(0, 200) : null, String(sql).slice(0, 4000), status, layer, reason, rows, ms,
      );
    },
    recentQueries: (limit = 100) => q('SELECT * FROM query_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ ...r })),
  };
  return store;
}

// `agent` = id or registry entry; omitted = the Analista (legacy <data>/analista/agent.db, opened as-is).
export function openAgentStore(dataDir, options, agent) {
  return createAgentStore(agentDbPath(dataDir, agent), { schemaExtra: typeof agent === 'object' ? agent?.schemaExtra : undefined, ...options });
}
