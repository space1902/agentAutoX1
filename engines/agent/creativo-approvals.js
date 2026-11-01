// "Propose, then confirm" for the Agente creativo: a generation (image, PDF asset, voice) can only run after the user
// approved exactly those arguments in the chat. Three pieces enforce it in code, not in the prompt:
//   1. propose_generation (MCP, free) stores a proposal with one item per generation; each item has a hash of its arguments.
//   2. The user clicks "Aprobar" in the app (command proposal-decide): items go pending -> approved.
//   3. The PreToolUse hook (creativo-guard.js) lets a generation tool through only if an approved item with the same
//      tool and argument hash exists, and spends it (approved -> consumed) atomically: single use.
// The MCP handler repeats the check (consumed -> running -> done|failed), so a misconfigured hook cannot spend anything.
import crypto from 'node:crypto';

export const APPROVAL_TTL_MS = 6 * 60 * 60 * 1000;
export const GENERATION_TOOLS = Object.freeze(['generate_image', 'design_pdf_asset', 'generate_voice']);

export const APPROVAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT, summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS proposal_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id INTEGER NOT NULL, tool TEXT NOT NULL, args_hash TEXT NOT NULL, args_json TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '', units_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
  consumed_at INTEGER, finished_at INTEGER, result_json TEXT
);
CREATE INDEX IF NOT EXISTS proposal_items_hash ON proposal_items (tool, args_hash, status);
CREATE INDEX IF NOT EXISTS proposal_items_proposal ON proposal_items (proposal_id);
`;

/** Arguments reduced to what identifies the request: no empty values, trimmed strings, keys sorted. */
export function normalizeArgs(value) {
  if (Array.isArray(value)) return value.map(normalizeArgs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = normalizeArgs(value[key]);
      if (v === undefined || v === null || v === '') continue;
      out[key] = v;
    }
    return out;
  }
  if (typeof value === 'string') return value.trim().replace(/\r\n/g, '\n');
  return value;
}

export const argsHash = (tool, args) => crypto.createHash('sha256').update(`${tool}\n${JSON.stringify(normalizeArgs(args ?? {}))}`).digest('hex');

const itemRow = (r) => ({
  id: r.id, proposalId: r.proposal_id, tool: r.tool, hash: r.args_hash, args: JSON.parse(r.args_json), label: r.label, units: JSON.parse(r.units_json), status: r.status,
  consumedAt: r.consumed_at, finishedAt: r.finished_at, result: r.result_json ? JSON.parse(r.result_json) : null,
});

/** `db` is a node:sqlite DatabaseSync that already ran APPROVAL_SCHEMA. */
export function createApprovals(db, { now = Date.now } = {}) {
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const itemsOf = (proposalId) => q('SELECT * FROM proposal_items WHERE proposal_id = ? ORDER BY id').all(proposalId).map(itemRow);
  const proposalRow = (r) => ({ id: r.id, ts: r.ts, sessionId: r.session_id, summary: r.summary, status: r.status, decidedAt: r.decided_at, items: itemsOf(r.id) });
  return {
    /** items: [{ tool, args, label, units }]. Returns the stored proposal. */
    propose({ sessionId = null, summary = '', items }) {
      if (!Array.isArray(items) || !items.length) throw new Error('La propuesta no tiene nada que generar.');
      return tx(() => {
        const id = Number(q('INSERT INTO proposals (ts, session_id, summary) VALUES (?, ?, ?)').run(now(), sessionId, String(summary).slice(0, 500)).lastInsertRowid);
        for (const item of items) {
          if (!GENERATION_TOOLS.includes(item.tool)) throw new Error(`Herramienta no permitida en una propuesta: ${item.tool}.`);
          q('INSERT INTO proposal_items (proposal_id, tool, args_hash, args_json, label, units_json) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, item.tool, argsHash(item.tool, item.args), JSON.stringify(normalizeArgs(item.args)), String(item.label ?? '').slice(0, 300), JSON.stringify(item.units ?? {}));
        }
        return proposalRow(q('SELECT * FROM proposals WHERE id = ?').get(id));
      });
    },
    get: (id) => {
      const r = q('SELECT * FROM proposals WHERE id = ?').get(Number(id));
      return r ? proposalRow(r) : null;
    },
    list: ({ status, limit = 50 } = {}) => q(`SELECT * FROM proposals ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(status ? [status, limit] : [limit])).map(proposalRow),
    /** The user's decision. Only a pending proposal can be decided, once. */
    decide(id, approve) {
      return tx(() => {
        const p = q('SELECT * FROM proposals WHERE id = ?').get(Number(id));
        if (!p) return { ok: false, error: 'No encuentro esa propuesta.' };
        if (p.status !== 'pending') return { ok: false, error: 'Esa propuesta ya fue resuelta.' };
        const next = approve ? 'approved' : 'rejected';
        q('UPDATE proposals SET status = ?, decided_at = ? WHERE id = ?').run(next, now(), p.id);
        q("UPDATE proposal_items SET status = ? WHERE proposal_id = ? AND status = 'pending'").run(next, p.id);
        return { ok: true, status: next };
      });
    },
    /** Hook side: spends one approved, unexpired item with this tool and hash. */
    consume(tool, hash) {
      return tx(() => {
        const row = q("SELECT i.id, p.decided_at FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id WHERE i.tool = ? AND i.args_hash = ? AND i.status = 'approved' ORDER BY i.id LIMIT 1").get(tool, hash);
        if (!row) {
          const used = q("SELECT status FROM proposal_items WHERE tool = ? AND args_hash = ? ORDER BY id DESC LIMIT 1").get(tool, hash);
          if (!used) return { ok: false, reason: 'Esa generación no fue propuesta. Usa propose_generation con estos mismos argumentos y espera la aprobación del usuario.' };
          if (used.status === 'pending') return { ok: false, reason: 'El usuario todavía no aprobó esta generación. Termina tu turno y espera su respuesta.' };
          if (used.status === 'rejected') return { ok: false, reason: 'El usuario rechazó esta generación.' };
          return { ok: false, reason: 'La aprobación de esta generación ya se usó (cada aprobación vale una sola vez). Propón de nuevo si hace falta repetirla.' };
        }
        if (now() - (row.decided_at ?? 0) > APPROVAL_TTL_MS) {
          q("UPDATE proposal_items SET status = 'expired' WHERE id = ?").run(row.id);
          return { ok: false, reason: 'La aprobación venció. Propón la generación otra vez.' };
        }
        q("UPDATE proposal_items SET status = 'consumed', consumed_at = ? WHERE id = ?").run(now(), row.id);
        return { ok: true, itemId: Number(row.id) };
      });
    },
    /** Tool side: takes the spent approval to run it (consumed -> running). Null when there is none. */
    begin(tool, hash) {
      return tx(() => {
        const row = q("SELECT id FROM proposal_items WHERE tool = ? AND args_hash = ? AND status = 'consumed' ORDER BY id LIMIT 1").get(tool, hash);
        if (!row) return null;
        q("UPDATE proposal_items SET status = 'running' WHERE id = ?").run(row.id);
        return Number(row.id);
      });
    },
    finish(itemId, { ok, result }) {
      q('UPDATE proposal_items SET status = ?, finished_at = ?, result_json = ? WHERE id = ?').run(ok ? 'done' : 'failed', now(), JSON.stringify(result ?? null).slice(0, 4000), itemId);
    },
  };
}
