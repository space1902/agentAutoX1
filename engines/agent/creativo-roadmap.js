// Roadmap board of the Agente creativo: product x country x checklist item, kept in the creativo's agent.db.
// The disk is the source of truth: seeding checks the files (roadmap-templates.js) instead of trusting a document, and the
// agent can only mark an item "hecho" with evidence that exists on disk (the user can mark anything). Marks made by the
// user are never overwritten by the agent or by a re-seed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listProducts } from './creativo-map.js';
import { protectedReason, resolvePath } from './creativo-guard.js';
import { DEFAULT_COUNTRY_SUFFIX, DEFAULT_TEMPLATES } from './roadmap-templates.js';

export const STATUSES = Object.freeze(['pendiente', 'en_progreso', 'hecho', 'no_aplica']);
export const MARKERS = Object.freeze(['usuario', 'agente', 'sistema']);
const MAX_NOTES = 2000;
const MAX_FILES = 20_000;

export const ROADMAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, kind TEXT, created INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS countries (code TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roadmap_templates (id TEXT PRIMARY KEY, phase TEXT, title TEXT NOT NULL, skill TEXT, scope TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, depends_json TEXT NOT NULL DEFAULT '[]', manual INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, country TEXT NOT NULL DEFAULT '', template_id TEXT NOT NULL, phase TEXT, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'en_progreso', 'hecho', 'no_aplica')),
  evidence_path TEXT, notes TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', marked_by TEXT NOT NULL DEFAULT 'sistema' CHECK (marked_by IN ('usuario', 'agente', 'sistema')),
  updated INTEGER NOT NULL, UNIQUE (product_id, country, template_id)
);
CREATE TABLE IF NOT EXISTS checklist_log (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, ts INTEGER NOT NULL, old TEXT, new TEXT NOT NULL, by TEXT NOT NULL, note TEXT);
`;

const slug = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleCase = (s) => String(s).replace(/(^|[-\s])(\p{L})/gu, (_, a, b) => `${a === '-' ? ' ' : a}${b.toUpperCase()}`);

// ---------------------------------------------------------------- config

/** Defaults merged with the owner's <agent dir>/roadmap.config.json (never required). */
export function loadRoadmapConfig(agentDirPath) {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(path.join(agentDirPath, 'roadmap.config.json'), 'utf8').replace(/^﻿/, ''));
  } catch {
    /* no overrides */
  }
  const byId = new Map(DEFAULT_TEMPLATES.map((t) => [t.id, t]));
  for (const t of Array.isArray(user.templates) ? user.templates : []) if (t && /^[a-z0-9-]{1,40}$/.test(String(t.id)) && t.title) byId.set(t.id, { scope: 'country', sort: 500, ...t });
  return { templates: [...byId.values()], countrySuffix: { ...DEFAULT_COUNTRY_SUFFIX, ...(user.countrySuffix ?? {}) } };
}

// ---------------------------------------------------------------- verification against the disk

function listFiles(dir, { recursive = true, excludeDirs = [] } = {}) {
  const out = [];
  const skip = new Set(['node_modules', '.git', '__pycache__', ...excludeDirs.map((d) => d.toLowerCase())]);
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (recursive && !skip.has(e.name.toLowerCase()) && !e.name.startsWith('.')) walk(path.join(d, e.name));
      } else if (e.isFile()) out.push(path.join(d, e.name));
    }
  };
  walk(dir);
  return out;
}

const fill = (text, tokens) => String(text).replace(/\{(c|sfx|p)\}/g, (_, k) => tokens[k] ?? '');
const rel = (root, file) => path.relative(root, file).replace(/\\/g, '/');

/** { status, evidence (relative to root), detail } for one verify rule. */
export function verifyRule(verify, { root, productDir, tokens }) {
  if (!verify) return { status: 'pendiente', evidence: null, detail: 'No se puede comprobar en disco: márcalo tú o con evidencia.', manual: true };
  if (verify.countries && !verify.countries.includes(tokens.c)) return { status: 'pendiente', evidence: null, detail: 'Sin comprobación para este país.' };
  const base = (p) => (String(p).startsWith('@root/') ? path.join(root, fill(String(p).slice(6), tokens)) : path.join(productDir, fill(p, tokens)));
  if (verify.type === 'any') {
    const results = verify.of.map((v) => verifyRule(v, { root, productDir, tokens }));
    const order = { hecho: 2, en_progreso: 1, pendiente: 0 };
    return results.reduce((best, r) => (order[r.status] > order[best.status] ? r : best), results[0]);
  }
  if (verify.type === 'file') {
    const file = base(verify.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { status: 'pendiente', evidence: null, detail: 'No existe el archivo.' };
    if (verify.placeholders) {
      const found = (fs.readFileSync(file, 'utf8').match(new RegExp(verify.placeholders, 'g')) ?? []).length;
      if (found) return { status: 'en_progreso', evidence: rel(root, file), detail: `Existe, con ${found} marcador${found === 1 ? '' : 'es'} por completar.` };
    }
    return { status: 'hecho', evidence: rel(root, file), detail: 'El archivo existe.' };
  }
  if (verify.type === 'files') {
    const dir = base(verify.dir);
    const re = new RegExp(fill(verify.match, tokens), 'i');
    const files = listFiles(dir, { recursive: verify.recursive !== false, excludeDirs: verify.excludeDirs }).filter((f) => re.test(path.basename(f)));
    const count = verify.distinct ? new Set(files.map((f) => path.basename(f).toLowerCase())).size : files.length;
    const expected = Math.max(1, verify.expected ?? 1);
    if (!count) return { status: 'pendiente', evidence: null, detail: `Sin archivos (se esperan ${expected}).` };
    const evidence = rel(root, expected > 1 || verify.recursive !== false ? dir : files[0]);
    return count >= expected
      ? { status: 'hecho', evidence, detail: `${count} de ${expected} archivos.` }
      : { status: 'en_progreso', evidence, detail: `${count} de ${expected} archivos.` };
  }
  return { status: 'pendiente', evidence: null, detail: 'Regla de comprobación desconocida.' };
}

// ---------------------------------------------------------------- store

const itemRow = (r, root) => {
  const evidenceBroken = Boolean(r.evidence_path) && !fs.existsSync(path.join(root ?? '', r.evidence_path));
  return {
    id: r.id, productId: r.product_id, country: r.country || null, templateId: r.template_id, phase: r.phase, title: r.title, status: r.status, evidencePath: r.evidence_path,
    notes: r.notes, detail: r.detail, markedBy: r.marked_by, updated: r.updated, evidenceBroken: root ? evidenceBroken : false,
  };
};

/** `db` is a node:sqlite DatabaseSync that already ran ROADMAP_SCHEMA. `root` is the workspace (products folder). */
export function createRoadmap(db, { root, agentDirPath, now = Date.now, home = os.homedir() } = {}) {
  const q = (sql) => db.prepare(sql);
  const log = (itemId, old, next, by, note) => q('INSERT INTO checklist_log (item_id, ts, old, new, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(itemId, now(), old, next, by, note ? String(note).slice(0, 300) : null);
  const templatesById = () => new Map(q('SELECT * FROM roadmap_templates').all().map((t) => [t.id, { ...t, depends: JSON.parse(t.depends_json) }]));

  const api = {
    /** Scans the disk and creates / refreshes the items nobody has marked by hand. Idempotent. */
    seed() {
      const config = loadRoadmapConfig(agentDirPath ?? '');
      const products = listProducts(root);
      const summary = { products: products.length, created: 0, refreshed: 0 };
      db.exec('BEGIN');
      try {
        for (const t of config.templates) {
          q('INSERT INTO roadmap_templates (id, phase, title, skill, scope, sort, depends_json, manual) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET phase = excluded.phase, title = excluded.title, skill = excluded.skill, scope = excluded.scope, sort = excluded.sort, depends_json = excluded.depends_json, manual = excluded.manual')
            .run(t.id, t.phase ?? null, t.title, t.skill ?? null, t.scope === 'product' ? 'product' : 'country', t.sort ?? 0, JSON.stringify(t.dependsOn ?? []), t.verify ? 0 : 1);
        }
        for (const p of products) {
          const pid = slug(p.name);
          q('INSERT INTO products (id, name, folder, kind, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, folder = excluded.folder').run(pid, p.name, p.folder, 'infoproducto', now());
          for (const c of p.countries) q('INSERT INTO countries (code, name) VALUES (?, ?) ON CONFLICT(code) DO NOTHING').run(c, titleCase(c));
          const productDir = path.join(root, p.folder);
          for (const t of config.templates) {
            const scopes = t.scope === 'product' ? [''] : p.countries;
            for (const country of scopes) {
              const tokens = { c: country, sfx: config.countrySuffix[country] ? `-${config.countrySuffix[country]}` : '', p: p.name.toLowerCase() };
              const res = t.countries && !t.countries.includes(country)
                ? { status: 'pendiente', evidence: null, detail: 'Sin datos para este país todavía.' }
                : verifyRule(t.verify, { root, productDir, tokens });
              const cur = q('SELECT * FROM checklist_items WHERE product_id = ? AND country = ? AND template_id = ?').get(pid, country, t.id);
              if (!cur) {
                const id = Number(q('INSERT INTO checklist_items (product_id, country, template_id, phase, title, status, evidence_path, detail, marked_by, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                  .run(pid, country, t.id, t.phase ?? null, t.title, res.status, res.evidence, res.detail, 'sistema', now()).lastInsertRowid);
                log(id, null, res.status, 'sistema', res.detail);
                summary.created += 1;
              } else if (cur.marked_by === 'sistema') {
                if (cur.status !== res.status || cur.evidence_path !== res.evidence || cur.detail !== res.detail || cur.title !== t.title) {
                  q('UPDATE checklist_items SET title = ?, status = ?, evidence_path = ?, detail = ?, updated = ? WHERE id = ?').run(t.title, res.status, res.evidence, res.detail, now(), cur.id);
                  if (cur.status !== res.status) log(cur.id, cur.status, res.status, 'sistema', res.detail);
                  summary.refreshed += 1;
                }
              } else if (cur.detail !== res.detail) q('UPDATE checklist_items SET detail = ? WHERE id = ?').run(res.detail, cur.id); // hand-marked: only the disk's opinion is refreshed
            }
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return summary;
    },

    items({ product, country, status } = {}) {
      const where = [];
      const args = [];
      if (product) {
        where.push('i.product_id = ?');
        args.push(slug(product));
      }
      if (country !== undefined && country !== null && country !== '') {
        where.push('i.country = ?');
        args.push(String(country).toLowerCase());
      }
      if (status) {
        where.push('i.status = ?');
        args.push(status);
      }
      return q(`SELECT i.*, t.sort FROM checklist_items i LEFT JOIN roadmap_templates t ON t.id = i.template_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.product_id, i.country, t.sort, i.id`)
        .all(...args).map((r) => itemRow(r, root));
    },
    get: (id) => {
      const r = q('SELECT * FROM checklist_items WHERE id = ?').get(Number(id));
      return r ? itemRow(r, root) : null;
    },

    /** Product x country board with the progress of each column. */
    board({ product } = {}) {
      const products = q('SELECT * FROM products WHERE archived = 0 ORDER BY name').all().filter((p) => !product || p.id === slug(product));
      const tpl = templatesById();
      return products.map((p) => {
        const items = api.items({ product: p.id });
        const countries = [...new Set(items.filter((i) => i.country).map((i) => i.country))].sort();
        const stats = (list) => {
          const applicable = list.filter((i) => i.status !== 'no_aplica');
          const done = applicable.filter((i) => i.status === 'hecho').length;
          return { total: applicable.length, done, pct: applicable.length ? Math.round((done / applicable.length) * 100) : 0 };
        };
        return {
          id: p.id, name: p.name, folder: p.folder, countries, progress: Object.fromEntries(countries.map((c) => [c, stats(items.filter((i) => i.country === c))])),
          rows: [...new Map(items.map((i) => [i.templateId, i])).values()].map((i) => ({ templateId: i.templateId, title: tpl.get(i.templateId)?.title ?? i.title, scope: i.country ? 'country' : 'product', sort: tpl.get(i.templateId)?.sort ?? 0, skill: tpl.get(i.templateId)?.skill ?? null, manual: tpl.get(i.templateId)?.manual === 1 }))
            .sort((a, b) => a.sort - b.sort),
          items,
        };
      });
    },

    /**
     * Marks an item. `by` is 'usuario' (the board) or 'agente' (MCP). The agent needs existing evidence for "hecho", cannot
     * touch what the user marked, and may only set "no_aplica" with a reason.
     */
    mark({ id, status, evidencePath, note, by }) {
      if (!STATUSES.includes(status)) return { error: `status debe ser ${STATUSES.join(', ')}.` };
      if (!['usuario', 'agente'].includes(by)) return { error: 'Quién marca debe ser usuario o agente.' };
      const cur = q('SELECT * FROM checklist_items WHERE id = ?').get(Number(id));
      if (!cur) return { error: 'No encuentro ese ítem del roadmap.' };
      let evidence = cur.evidence_path;
      if (by === 'agente') {
        if (cur.marked_by === 'usuario') return { error: 'Ese ítem lo marcó el usuario; solo él puede cambiarlo.' };
        if (status === 'no_aplica' && !String(note ?? '').trim()) return { error: 'Para marcar «no aplica» explica por qué en note.' };
        if (status === 'hecho' || evidencePath) {
          const candidate = evidencePath || cur.evidence_path;
          if (!candidate) return { error: 'Para marcar «hecho» indica evidence_path: un archivo o carpeta que exista (ruta relativa a la carpeta de trabajo).' };
          const resolved = resolvePath(candidate, root, home);
          const rootResolved = resolvePath(root, root, home);
          if (!resolved || !resolved.startsWith(`${rootResolved}/`) || /(^|\/)[^/]*(~\d|[. ]$)/.test(resolved.slice(rootResolved.length))) return { error: 'La evidencia debe estar dentro de la carpeta de trabajo.' };
          if (protectedReason(resolved, rootResolved)) return { error: 'Esa ruta está bloqueada y no sirve como evidencia.' };
          const absolute = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
          if (!fs.existsSync(absolute)) return { error: `No existe ${candidate}. Sin evidencia en disco no puedo marcarlo como hecho.` };
          evidence = rel(root, absolute);
        }
      } else if (evidencePath) evidence = String(evidencePath).slice(0, 400);
      const upd = q(`UPDATE checklist_items SET status = ?, evidence_path = ?, marked_by = ?, updated = ? WHERE id = ?${by === 'agente' ? " AND marked_by != 'usuario'" : ''}`).run(status, evidence, by, now(), cur.id);
      if (Number(upd.changes) === 0) return { error: 'Ese ítem lo marcó el usuario; solo él puede cambiarlo.' };
      if (note) api.addNote(cur.id, note, by, { silent: true });
      log(cur.id, cur.status, status, by, note);
      return { item: api.get(cur.id) };
    },

    addNote(id, text, by = 'agente', { silent = false } = {}) {
      const cur = q('SELECT * FROM checklist_items WHERE id = ?').get(Number(id));
      if (!cur) return { error: 'No encuentro ese ítem del roadmap.' };
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!clean) return { error: 'La nota está vacía.' };
      const line = `${new Date(now()).toISOString().slice(0, 10)} (${by}): ${clean}`;
      const notes = (cur.notes ? `${cur.notes}\n${line}` : line).slice(-MAX_NOTES);
      q('UPDATE checklist_items SET notes = ?, updated = ? WHERE id = ?').run(notes, now(), cur.id);
      if (!silent) log(cur.id, cur.status, cur.status, by, `nota: ${clean}`);
      return { item: api.get(cur.id) };
    },

    /** Next items to work on: pending / in progress, every dependency done (or not applicable), in template order. Computed in code. */
    proposeNext({ product, country, limit = 5 } = {}) {
      const tpl = templatesById();
      const all = api.items({ product });
      const doneOf = (it, templateId) => {
        const dep = tpl.get(templateId);
        const match = all.find((x) => x.productId === it.productId && x.templateId === templateId && (dep?.scope === 'product' ? !x.country : x.country === it.country));
        return !match || match.status === 'hecho' || match.status === 'no_aplica';
      };
      return all
        .filter((it) => (it.status === 'pendiente' || it.status === 'en_progreso') && (!country || it.country === String(country).toLowerCase()))
        .map((it) => ({ it, blockedBy: (tpl.get(it.templateId)?.depends ?? []).filter((d) => !doneOf(it, d)) }))
        .filter((x) => !x.blockedBy.length)
        .sort((a, b) => (tpl.get(a.it.templateId)?.sort ?? 0) - (tpl.get(b.it.templateId)?.sort ?? 0) || (a.it.status === 'en_progreso' ? -1 : 1))
        .slice(0, limit)
        .map(({ it }) => ({ ...it, skill: tpl.get(it.templateId)?.skill ?? null, manual: tpl.get(it.templateId)?.manual === 1 }));
    },
    log: (itemId) => q('SELECT ts, old, new, by, note FROM checklist_log WHERE item_id = ? ORDER BY id DESC LIMIT 30').all(Number(itemId)),
  };
  return api;
}
