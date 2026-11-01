// What the Agente creativo learns from. Same loop as the Analista (candidate lessons the user certifies, signals with a 30-day
// half-life, a distiller needing >= 3 cases and >= 75 % agreement) over the creativo's own outcomes:
//   - approved vs rejected generation proposals           (user decisions in the approval card)
//   - assets the user marks as used / discarded           (creative_outputs.status)
//   - real ad results of assets mapped to a CT            (read-only bridge to the Analista's data, ads-bridge.js)
// Corrections on texts and images come through the thumbs / "Esto está mal" feedback and chat corrections (learning.js).
import { ctResult } from './ads-bridge.js';
import { MIN_EVIDENCE, STRONG } from './distiller.js';
import { storeCandidates } from './learning.js';

export const CREATIVO_LEARNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS creative_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, product TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE, proposal_item_id INTEGER, status TEXT NOT NULL DEFAULT 'generated', ct_code TEXT, marked_at INTEGER
);
CREATE INDEX IF NOT EXISTS creative_outputs_status ON creative_outputs (status);
`;

export const OUTPUT_KINDS = Object.freeze({ generate_image: 'imagen', design_pdf_asset: 'arte de PDF', generate_voice: 'audio' });
export const OUTPUT_STATUSES = Object.freeze(['generated', 'used', 'discarded']);

const row = (r) => ({
  id: r.id, ts: r.ts, product: r.product, country: r.country, kind: r.kind, path: r.path, proposalItemId: r.proposal_item_id, status: r.status, ctCode: r.ct_code, markedAt: r.marked_at,
});

/** `db` is a node:sqlite DatabaseSync that already ran CREATIVO_LEARNING_SCHEMA. */
export function createOutputs(db, { now = Date.now } = {}) {
  const q = (sql) => db.prepare(sql);
  return {
    /** Remembers a file a generation tool produced. Idempotent by path. */
    record({ tool, args = {}, result = {}, proposalItemId = null }) {
      const file = String(result.ruta ?? '');
      if (!file || !OUTPUT_KINDS[tool]) return null;
      const known = q('SELECT id FROM creative_outputs WHERE path = ?').get(file);
      if (known) return Number(known.id);
      return Number(q('INSERT INTO creative_outputs (ts, product, country, kind, path, proposal_item_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(now(), String(args.product ?? '').slice(0, 80), String(args.country ?? '').slice(0, 40), OUTPUT_KINDS[tool], file, proposalItemId).lastInsertRowid);
    },
    list: ({ status, limit = 100 } = {}) => q(`SELECT * FROM creative_outputs ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(status ? [status, limit] : [limit])).map(row),
    get: (id) => {
      const r = q('SELECT * FROM creative_outputs WHERE id = ?').get(Number(id));
      return r ? row(r) : null;
    },
    /** The user's verdict on an asset; ctCode (optional) links it to an ad code so the Analista's results can feed the lessons. */
    setStatus(id, status, { ctCode } = {}) {
      if (!OUTPUT_STATUSES.includes(status)) return { error: `status debe ser ${OUTPUT_STATUSES.join(', ')}.` };
      const cur = q('SELECT * FROM creative_outputs WHERE id = ?').get(Number(id));
      if (!cur) return { error: 'No encuentro ese archivo.' };
      let ct = cur.ct_code;
      if (ctCode !== undefined) {
        if (ctCode === '' || ctCode === null) ct = null;
        else {
          const m = /(\d{1,3})/.exec(String(ctCode));
          if (!m) return { error: 'El código CT no es válido (por ejemplo CT 07).' };
          ct = `CT ${m[1].padStart(2, '0')}`;
        }
      }
      q('UPDATE creative_outputs SET status = ?, ct_code = ?, marked_at = ? WHERE id = ?').run(status, ct, now(), Number(id));
      return { output: this.get(id), changed: cur.status !== status };
    },
  };
}

// ---------------------------------------------------------------- cases and distillation

/**
 * Every labeled case the creativo can learn from, as { group, label: 'acierto' | 'fallo' }.
 * `adsResults` is optional: a map ctCode -> ctResult() (injected by tests and by the refresh).
 */
export function collectCases(db, { adsResults = new Map() } = {}) {
  const cases = [];
  for (const r of db.prepare("SELECT tool, status FROM proposal_items WHERE status != 'pending'").all()) {
    if (r.status === 'rejected') cases.push({ group: `aprobacion:${r.tool}`, label: 'fallo' });
    else if (r.status !== 'expired') cases.push({ group: `aprobacion:${r.tool}`, label: 'acierto' });
  }
  for (const o of db.prepare('SELECT kind, status, ct_code FROM creative_outputs').all()) {
    if (o.status === 'used') cases.push({ group: `uso:${o.kind}`, label: 'acierto' });
    else if (o.status === 'discarded') cases.push({ group: `uso:${o.kind}`, label: 'fallo' });
    const res = o.ct_code ? adsResults.get(o.ct_code) : null;
    if (res?.available && (res.label === 'acierto' || res.label === 'fallo')) cases.push({ group: `ads:${o.kind}`, label: res.label });
  }
  return cases;
}

const TOOL_NAME = { generate_image: 'imágenes', design_pdf_asset: 'arte de PDF', generate_voice: 'audios' };
const times = (k, n) => `${k} de ${n} ${n === 1 ? 'vez' : 'veces'}`;

function phrase(group, direction, a, f, n) {
  const [type, what] = group.split(':');
  if (type === 'aprobacion') {
    const name = TOOL_NAME[what] ?? what;
    return direction === 'neg' ? `Las propuestas de ${name} se rechazaron ${times(f, n)}.` : `Las propuestas de ${name} se aprobaron ${times(a, n)}.`;
  }
  if (type === 'uso') {
    return direction === 'neg' ? `Los archivos de tipo ${what} se descartaron ${times(f, n)}.` : `Los archivos de tipo ${what} se usaron ${times(a, n)}.`;
  }
  return direction === 'neg' ? `Los archivos de tipo ${what} ligados a un CT quedaron con ROAS menor a 1 en ${times(f, n)}.` : `Los archivos de tipo ${what} ligados a un CT llegaron a ROAS de 2 o más en ${times(a, n)}.`;
}

/** Deterministic and idempotent (stable keys): >= 3 cases and >= 75 % agreement, otherwise nothing. */
export function distillCases(cases, { minEvidence = MIN_EVIDENCE, strong = STRONG } = {}) {
  const groups = new Map();
  for (const c of cases) {
    const e = groups.get(c.group) ?? { acierto: 0, fallo: 0 };
    e[c.label] += 1;
    groups.set(c.group, e);
  }
  const out = [];
  for (const [group, e] of [...groups.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const n = e.acierto + e.fallo;
    if (n < minEvidence) continue;
    const direction = e.fallo / n >= strong ? 'neg' : e.acierto / n >= strong ? 'pos' : null;
    if (!direction) continue;
    out.push({
      key: `creativo:${group}:${direction}`, text: phrase(group, direction, e.acierto, e.fallo, n), scope: group, kind: 'rule', source: 'distiller', weight: n,
      evidence: { support: n, acierto: e.acierto, fallo: e.fallo },
    });
  }
  return out;
}

/** Ad results of every CT-linked asset (read-only, from the Analista's data). */
export function adsResultsFor(db, dataDir, { now = Date.now(), resultFn = ctResult } = {}) {
  const out = new Map();
  for (const o of db.prepare("SELECT ct_code, MIN(ts) AS since FROM creative_outputs WHERE ct_code IS NOT NULL AND status != 'discarded' GROUP BY ct_code").all()) {
    out.set(o.ct_code, resultFn(dataDir, o.ct_code, { since: o.since, now }));
  }
  return out;
}

/** The creativo's learning cycle: re-read the outcomes and store new candidates. */
export function refreshCreativoLessons({ store, dataDir, now = Date.now(), resultFn } = {}) {
  const adsResults = dataDir ? adsResultsFor(store.db, dataDir, { now, resultFn }) : new Map();
  return storeCandidates(store, distillCases(collectCases(store.db, { adsResults })));
}
