// Research store of the Investigador (tables in its agent.db) and the report writer. A report is a markdown file in the
// owner's investigaciones folder PLUS rows here: the searched terms, the counts, the verdict, the thresholds used and, later,
// what really happened when the product launched. The tables are the learning material; the file is for reading.
import fs from 'node:fs';
import path from 'node:path';

import { classify, DECISIONS, estimateProfit, DEFAULT_THRESHOLDS } from './research-thresholds.js';

export const RESEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, date TEXT NOT NULL, topic TEXT NOT NULL, idea TEXT NOT NULL DEFAULT '', path TEXT NOT NULL,
  verdict TEXT NOT NULL, model_verdict TEXT, decision TEXT NOT NULL, main_term TEXT, main_count INTEGER, countries_json TEXT NOT NULL DEFAULT '[]',
  thresholds_json TEXT NOT NULL, estimate_json TEXT, summary TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS research_measurements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER NOT NULL, term TEXT NOT NULL, country TEXT NOT NULL, count INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'nicho',
  infoproducers INTEGER, verdict TEXT NOT NULL, measured_on TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS research_measurements_term ON research_measurements (term, country, measured_on);
CREATE TABLE IF NOT EXISTS research_launches (
  report_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, launched_on TEXT NOT NULL, product TEXT NOT NULL DEFAULT '', ct_code TEXT, source TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}', label TEXT NOT NULL DEFAULT 'sin_datos', hit INTEGER, note TEXT NOT NULL DEFAULT ''
);
`;

export const REUSE_DAYS = 14;

const DAY = 86_400_000;
const TYPES = ['generico', 'nicho', 'formato', 'frase_exacta', 'idioma'];

const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const slugify = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'tema';
const fmt = (n) => Number(n).toLocaleString('es-CO');

function uniqueFile(dir, stem) {
  let file = path.join(dir, `${stem}.md`);
  for (let i = 2; fs.existsSync(file); i += 1) file = path.join(dir, `${stem}-${i}.md`);
  return file;
}

// ---------------------------------------------------------------- report markdown

export function renderReport({ date, topic, idea, countries, measurements, advertisers, estimate, thresholds, main, verdict, decision, copy, gaps, risks, nextQuestion }) {
  const L = [`# Investigación: ${topic}`, '', `- Fecha de medición: ${date}`, `- Idea evaluada: ${idea || topic}`, `- Países medidos: ${countries.join(', ') || 'todos (ALL)'}`, '- Herramienta: Biblioteca de anuncios de Meta (anuncios activos), sin sesión, solo lectura', ''];
  L.push('## Qué se buscó', '', '| # | Término | Tipo | País |', '|---|---|---|---|');
  measurements.forEach((m, i) => L.push(`| ${i + 1} | ${m.term} | ${m.kind} | ${m.country} |`));
  const cols = [...new Set(measurements.map((m) => m.country))];
  L.push('', '## Números (~ anuncios activos)', '', `| Término | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
  for (const term of [...new Set(measurements.map((m) => m.term))]) {
    L.push(`| ${term} | ${cols.map((c) => { const m = measurements.find((x) => x.term === term && x.country === c); return m ? `~${fmt(m.count)}` : '–'; }).join(' | ')} |`);
  }
  if (advertisers.length) {
    L.push('', '## Anunciantes dominantes', '', '| Página | Tipo | Anuncios | En video | Días activo | Variantes | Países | Precio | Canal |', '|---|---|---|---|---|---|---|---|---|');
    for (const a of advertisers) L.push(`| ${a.page} | ${a.type} | ${a.ads ?? '–'} | ${a.videoAds ?? '–'} | ${a.daysActive ?? '–'} | ${a.variants ?? '–'} | ${a.countries || '–'} | ${a.price || 'sin precio visible'} | ${a.channel || '–'} |`);
  }
  L.push('', '## Clasificación por ángulo', '', `Umbrales usados: saturado desde ~${thresholds.saturated} anuncios, competitivo desde ~${thresholds.competitive}.`, '', '| Término | País | Conteo | Infoproductores | Veredicto | Por qué |', '|---|---|---|---|---|---|');
  for (const m of measurements) L.push(`| ${m.term} | ${m.country} | ~${fmt(m.count)} | ${m.infoproducers ?? '–'} | ${m.verdict} | ${m.reason}${m.note ? ` ${m.note}` : ''} |`);
  L.push('', `Medición que decide: «${main.term}» (${main.country}) → **${verdict}**.`);
  if (estimate) {
    const e = estimate;
    L.push('', '## Rentabilidad (estimación)', '', `- Ticket esperado: ${fmt(e.ticket)} ${e.currency}`);
    if (e.needsCost) {
      L.push(`- CPA máximo (ROAS ${thresholds.roasGood}): ${fmt(e.cpaMax)} ${e.currency}`, `- Con conversión de ${(e.conversion * 100).toFixed(1).replace('.', ',')} %, el costo por mensaje tendría que ser de ${fmt(e.maxCostPerMessage)} ${e.currency} o menos. Los benchmarks del usuario están en ${thresholds.benchmarks.currency}: falta medir el costo por mensaje en ${e.currency}.`, '- Conclusión: sin estimar (falta el costo por mensaje de ese país)');
    } else {
      L.push(`- Costo por mensaje y conversión asumidos: ${e.fromBenchmarks ? `benchmarks del usuario (${fmt(thresholds.benchmarks.costPerMessageLow)} a ${fmt(thresholds.benchmarks.costPerMessageHigh)} ${thresholds.benchmarks.currency} por mensaje)` : 'dados por el usuario'}, conversión ${(e.conversion * 100).toFixed(1).replace('.', ',')} %`,
        `- CPA máximo (ROAS ${thresholds.roasGood}): ${fmt(e.cpaMax)} ${e.currency}`, `- Costo por venta estimado: ${fmt(e.best.costPerSale)} a ${fmt(e.worst.costPerSale)} ${e.currency} (ROAS ${String(e.worst.roas).replace('.', ',')} a ${String(e.best.roas).replace('.', ',')})`, `- Conclusión: ${e.verdict.replace('_', ' ')} (estimación, no promesa)`);
    }
    if (e.assumptions) L.push(`- Supuestos: ${e.assumptions}`);
  }
  const list = (title, items) => items.length && L.push('', `**${title}**`, ...items.map((i) => `- ${i}`));
  L.push('', '## Recomendación');
  list('Copiar con mejor ángulo', copy);
  list('Huecos', gaps);
  list('Riesgos', risks);
  L.push('', `Decisión sugerida: **${decision}**.`);
  if (nextQuestion) L.push('', `Siguiente paso: ${nextQuestion}`);
  L.push('', '## Limitaciones', '', 'La Biblioteca muestra cuántos anuncios hay y desde cuándo, no ventas ni gasto: «activo» es una señal indirecta. Todo conteo es aproximado y cambia a diario. Las cifras de rentabilidad son estimaciones con los benchmarks del usuario.', '', '## Resultado real (se completa si se lanza)', '', '- Fecha de lanzamiento:', '- Ticket real, costo por mensaje, conversión, ROAS:', '- ¿Acertó el veredicto?:', '- Ajuste propuesto a los umbrales:', '');
  return L.join('\n');
}

// ---------------------------------------------------------------- store

const reportRow = (r) => ({
  id: r.id, ts: r.ts, date: r.date, topic: r.topic, idea: r.idea, path: r.path, verdict: r.verdict, modelVerdict: r.model_verdict, decision: r.decision, mainTerm: r.main_term, mainCount: r.main_count,
  countries: JSON.parse(r.countries_json), thresholds: JSON.parse(r.thresholds_json), estimate: r.estimate_json ? JSON.parse(r.estimate_json) : null, summary: r.summary,
});
const launchRow = (r) => ({ reportId: r.report_id, ts: r.ts, launchedOn: r.launched_on, product: r.product, ctCode: r.ct_code, source: r.source, result: JSON.parse(r.result_json), label: r.label, hit: r.hit === null ? null : r.hit === 1, note: r.note });

/** `db` is a node:sqlite DatabaseSync that already ran RESEARCH_SCHEMA. */
export function createResearch(db, { researchDir, now = Date.now } = {}) {
  const q = (sql) => db.prepare(sql);
  const api = {
    /** Validates the structured input, classifies each measurement IN CODE, writes the file and the rows. */
    save(input, { thresholds = DEFAULT_THRESHOLDS } = {}) {
      const topic = str(input.topic, 80);
      if (topic.length < 3) return { error: 'Indica el tema (topic).' };
      if (!DECISIONS.includes(input.decision)) return { error: `decision debe ser ${DECISIONS.join(', ')}.` };
      const raw = Array.isArray(input.measurements) ? input.measurements : [];
      if (!raw.length || raw.length > 60) return { error: 'Pasa entre 1 y 60 mediciones en measurements.' };
      const date = localDate(now());
      const measurements = [];
      for (const [i, m] of raw.entries()) {
        const term = str(m.term, 120).replace(/[|]/g, '/');
        const country = str(m.country || 'ALL', 6).toUpperCase();
        const count = Number(m.count);
        if (!term || !Number.isFinite(count) || count < 0) return { error: `Medición ${i + 1}: falta term o count (número mayor o igual a 0).` };
        if (!/^[A-Z]{2,3}$/.test(country)) return { error: `Medición ${i + 1}: country debe ser ALL o un código como CO, MX, VE.` };
        const kind = TYPES.includes(m.type) ? m.type : 'nicho';
        const infoproducers = m.infoproducers === undefined || m.infoproducers === null ? null : Math.max(0, Math.floor(Number(m.infoproducers)));
        if (infoproducers !== null && !Number.isFinite(infoproducers)) return { error: `Medición ${i + 1}: infoproducers debe ser un número.` };
        const c = classify(Math.round(count), { infoproducers, thresholds });
        measurements.push({ term, country, count: Math.round(count), kind, infoproducers, verdict: c.verdict, reason: c.reason, note: str(m.note, 160), measuredOn: /^\d{4}-\d{2}-\d{2}$/.test(String(m.measured_on)) && m.measured_on <= date ? m.measured_on : date });
      }
      const mainTerm = str(input.main_term, 120);
      const main = measurements.find((m) => m.term === mainTerm) ?? measurements.find((m) => m.country === 'ALL') ?? measurements[0];
      const estimate = input.estimate ? estimateProfit({ ticket: input.estimate.ticket, currency: input.estimate.currency, costPerMessage: input.estimate.cost_per_message, conversion: input.estimate.conversion, thresholds }) : null;
      if (estimate?.error) return { error: `estimate: ${estimate.error}` };
      if (estimate) {
        estimate.assumptions = str(input.estimate.assumptions, 300);
      }
      const advertisers = (Array.isArray(input.advertisers) ? input.advertisers : []).slice(0, 20).map((a) => ({
        page: str(a.page, 80).replace(/[|]/g, '/'), type: a.type === 'infoproductor' ? 'infoproductor' : 'marca', ads: Number.isFinite(Number(a.ads)) ? Number(a.ads) : null, videoAds: Number.isFinite(Number(a.video_ads)) ? Number(a.video_ads) : null, daysActive: a.days_active === undefined || a.days_active === null ? null : str(a.days_active, 40).replace(/[|]/g, '/'), variants: Number.isFinite(Number(a.variants)) ? Number(a.variants) : null,
        countries: str(a.countries, 60), price: str(a.price, 60), channel: str(a.channel, 40),
      })).filter((a) => a.page);
      const list = (v) => (Array.isArray(v) ? v.map((x) => str(x, 240)).filter(Boolean).slice(0, 6) : []);
      const countries = [...new Set((Array.isArray(input.countries) ? input.countries : measurements.map((m) => m.country)).map((c) => str(c, 6).toUpperCase()).filter(Boolean))];
      const markdown = renderReport({ date, topic, idea: str(input.idea, 200), countries, measurements, advertisers, estimate, thresholds, main, verdict: main.verdict, decision: input.decision, copy: list(input.copy_with_better_angle), gaps: list(input.gaps), risks: list(input.risks), nextQuestion: str(input.next_question, 200) });

      fs.mkdirSync(researchDir, { recursive: true });
      const file = uniqueFile(researchDir, `${date}-${slugify(topic)}`);
      fs.writeFileSync(file, markdown, { encoding: 'utf8', flag: 'wx' });
      const modelVerdict = ['saturado', 'competitivo', 'hueco'].includes(input.verdict) ? input.verdict : null;
      db.exec('BEGIN');
      try {
        const id = Number(q('INSERT INTO research_reports (ts, date, topic, idea, path, verdict, model_verdict, decision, main_term, main_count, countries_json, thresholds_json, estimate_json, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(now(), date, topic, str(input.idea, 200), file, main.verdict, modelVerdict, input.decision, main.term, main.count, JSON.stringify(countries), JSON.stringify(thresholds), estimate ? JSON.stringify(estimate) : null, str(input.summary, 400)).lastInsertRowid);
        const ins = q('INSERT INTO research_measurements (report_id, term, country, count, kind, infoproducers, verdict, measured_on, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const m of measurements) ins.run(id, m.term, m.country, m.count, m.kind, m.infoproducers, m.verdict, m.measuredOn, m.note);
        db.exec('COMMIT');
        return { id, file, date, verdict: main.verdict, mainTerm: main.term, mainCount: main.count, modelVerdictDiffers: modelVerdict !== null && modelVerdict !== main.verdict, estimate, measurements: measurements.length };
      } catch (error) {
        db.exec('ROLLBACK');
        fs.rmSync(file, { force: true });
        throw error;
      }
    },

    reports: ({ topic, limit = 20 } = {}) => {
      const rows = q('SELECT * FROM research_reports ORDER BY id DESC LIMIT 500').all().map(reportRow);
      const needle = slugify(topic ?? '');
      return (topic ? rows.filter((r) => slugify(r.topic).includes(needle) || needle.includes(slugify(r.topic)) || r.path.toLowerCase().includes(needle)) : rows).slice(0, limit);
    },
    report: (id) => {
      const r = q('SELECT * FROM research_reports WHERE id = ?').get(Number(id));
      return r ? reportRow(r) : null;
    },
    measurements(reportId) {
      return q('SELECT * FROM research_measurements WHERE report_id = ? ORDER BY id').all(Number(reportId)).map((m) => ({ term: m.term, country: m.country, count: m.count, kind: m.kind, infoproducers: m.infoproducers, verdict: m.verdict, measuredOn: m.measured_on, note: m.note }));
    },
    /** Recent measurements across reports with their age, so a new run reuses numbers younger than REUSE_DAYS instead of searching again. */
    recentMeasurements({ term, days = 90 } = {}) {
      const since = localDate(now() - days * DAY);
      const rows = q('SELECT m.*, r.topic, r.id AS rid FROM research_measurements m JOIN research_reports r ON r.id = m.report_id WHERE m.measured_on >= ? ORDER BY m.measured_on DESC, m.id DESC').all(since);
      const needle = term ? slugify(term) : '';
      return rows.filter((m) => !needle || slugify(m.term).includes(needle) || needle.includes(slugify(m.term))).map((m) => {
        const age = Math.max(0, Math.round((Date.parse(`${localDate(now())}T00:00:00Z`) - Date.parse(`${m.measured_on}T00:00:00Z`)) / DAY));
        return { reportId: m.rid, topic: m.topic, term: m.term, country: m.country, count: m.count, verdict: m.verdict, measuredOn: m.measured_on, ageDays: age, reusable: age <= REUSE_DAYS };
      });
    },

    saveLaunch({ reportId, launchedOn, product, ctCode, source, result, label, hit, note }) {
      const report = api.report(reportId);
      if (!report) return { error: 'No encuentro ese informe.' };
      q(`INSERT INTO research_launches (report_id, ts, launched_on, product, ct_code, source, result_json, label, hit, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(report_id) DO UPDATE SET ts = excluded.ts, launched_on = excluded.launched_on, product = excluded.product, ct_code = excluded.ct_code, source = excluded.source, result_json = excluded.result_json, label = excluded.label, hit = excluded.hit, note = excluded.note`)
        .run(Number(reportId), now(), launchedOn || localDate(now()), str(product, 80), ctCode ?? null, source, JSON.stringify(result ?? {}), label, hit === null || hit === undefined ? null : hit ? 1 : 0, str(note, 300));
      return { launch: api.launch(reportId) };
    },
    launch: (reportId) => {
      const r = q('SELECT * FROM research_launches WHERE report_id = ?').get(Number(reportId));
      return r ? launchRow(r) : null;
    },
    launches() {
      return q('SELECT l.*, r.verdict, r.decision, r.main_count, r.topic FROM research_launches l JOIN research_reports r ON r.id = l.report_id ORDER BY l.ts DESC').all()
        .map((r) => ({ ...launchRow(r), verdict: r.verdict, decision: r.decision, mainCount: r.main_count, topic: r.topic }));
    },
  };
  return api;
}
