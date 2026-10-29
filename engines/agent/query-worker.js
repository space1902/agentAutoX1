// Runs ONE read-only query in its own short-lived Node process so the parent can enforce a hard timeout by killing
// it (node:sqlite has no interrupt, and a worker thread stuck in native SQLite cannot be stopped).
// The connection is opened read-only AND with query_only, as two separate layers.
// stdin: JSON { file, sql, maxRows }.  stdout: one JSON line { ok, columns, rows } | { ok: false, error }.
import { DatabaseSync } from 'node:sqlite';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const { file, sql, maxRows } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  const stmt = db.prepare(`SELECT * FROM (${sql}) LIMIT ${Number(maxRows) + 1}`);
  const columns = stmt.columns().map((c) => c.name);
  const rows = stmt.all().map((r) => ({ ...r }));
  db.close();
  process.stdout.write(`${JSON.stringify({ ok: true, columns, rows })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
}
