// Validates (sql-guard) and executes a free-form query on a read-only connection with a hard timeout and a row cap.
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateSql } from './sql-guard.js';

export const MAX_ROWS = 200;
export const QUERY_TIMEOUT_MS = 5000;
const WORKER_FILE = fileURLToPath(new URL('./query-worker.js', import.meta.url));

// Every table/view that exists, so the guard can name internal ones in its refusal.
export function listRelations(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((r) => r.name);
  } finally {
    db.close();
  }
}

// The query runs in a child process that is killed on timeout (only THAT pid): a runaway query cannot keep burning CPU.
export function runWorker(file, sql, { timeoutMs = QUERY_TIMEOUT_MS, maxRows = MAX_ROWS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', WORKER_FILE], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    let timedOut = false;
    // Kill first, answer once the process is really gone (its file handle would otherwise linger on Windows).
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.once('error', (e) => done({ ok: false, error: String(e?.message ?? e) }));
    child.once('close', () => {
      if (timedOut) return done({ ok: false, timeout: true, error: `La consulta tardó más de ${Math.round(timeoutMs / 1000)} s y se canceló. Simplifícala o acota el rango de fechas.` });
      try {
        done(JSON.parse(out.trim().split('\n').pop() || '{}'));
      } catch {
        done({ ok: false, error: 'La consulta no devolvió un resultado legible.' });
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ file, sql, maxRows }));
  });
}

/**
 * @returns {Promise<{ ok: true, columns: string[], rows: object[], rowCount: number, truncated: boolean, ms: number, sql: string }
 *   | { ok: false, rejected?: boolean, layer?: string, error: string, ms: number }>}
 */
export async function runQuery(file, rawSql, { timeoutMs, maxRows = MAX_ROWS } = {}) {
  const started = Date.now();
  let known = [];
  try {
    known = listRelations(file);
  } catch (error) {
    return { ok: false, error: `No se pudo abrir la base de datos de anuncios: ${error.message}`, ms: Date.now() - started };
  }
  const check = validateSql(rawSql, { knownTables: known });
  if (!check.ok) return { ok: false, rejected: true, layer: check.layer, error: check.reason, ms: Date.now() - started };
  const res = await runWorker(file, check.sql, { timeoutMs, maxRows });
  const ms = Date.now() - started;
  if (!res.ok) return { ok: false, error: res.error, timeout: res.timeout === true, layer: res.timeout ? 'tiempo' : 'ejecucion', ms };
  const truncated = res.rows.length > maxRows;
  const rows = truncated ? res.rows.slice(0, maxRows) : res.rows;
  return { ok: true, columns: res.columns, rows, rowCount: rows.length, truncated, ms, sql: check.sql };
}
