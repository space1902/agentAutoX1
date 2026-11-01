// Part B: the Investigador de productos (thresholds, research store, MCP tools, browser guard, launch args, learning from launches).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAgentStore } from './agent-db.js';
import { buildClaudeArgs } from './claude-cli.js';
import { AGENT_LEARNING_TOOL_NAMES } from './learning-tools.js';
import { certifiedLessons, setLessonStatus } from './learning.js';
import { decide, browserDecision, AD_LIBRARY } from './investigador-guard.js';
import { investigadorPrompt, investigadorStepLabel } from './investigador-prompt.js';
import { createInvestigadorTools, COUNTRIES, INVESTIGADOR_TOOL_NAMES, libraryUrl, markLaunched, proposeUpdates } from './investigador-tools.js';
import { buildGuardSettings, INVESTIGADOR_BROWSER_TOOLS, prepareInvestigadorLaunch, researchDirOf } from './investigador-workspace.js';
import { AGENTS } from './registry.js';
import { createResearch, RESEARCH_SCHEMA, renderReport, REUSE_DAYS } from './research-store.js';
import { activeThresholds, classify, DEFAULT_THRESHOLDS, estimateProfit, mergeThresholds, predictionHit, proposeThresholdUpdates, resultFromInput } from './research-thresholds.js';
import { makeDataDir } from './seed-fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mkTmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const DAY = 86_400_000;

// ---- thresholds ------------------------------------------------------------------------------------------------

test('classify follows the skill thresholds, with the infoproducer correction', () => {
  assert.equal(classify(9800).verdict, 'saturado');
  assert.equal(classify(1000).verdict, 'saturado');
  assert.equal(classify(890).verdict, 'competitivo');
  assert.equal(classify(100).verdict, 'competitivo');
  assert.equal(classify(46).verdict, 'hueco');
  assert.equal(classify(0).verdict, 'hueco');
  // pizza air fryer: ~1.100 ads, almost all appliance brands => a gap for an infoproduct
  const air = classify(1100, { infoproducers: 0 });
  assert.equal(air.verdict, 'hueco');
  assert.equal(air.byCount, 'saturado');
  assert.match(air.reason, /marcas/);
  assert.equal(classify(1100, { infoproducers: 5 }).verdict, 'saturado');
  assert.throws(() => classify(-1), /mayor o igual a 0/);
  assert.throws(() => classify('muchos'), /número/);
  const strict = mergeThresholds({ competitive: 50, saturated: 400 });
  assert.equal(classify(60, { thresholds: strict }).verdict, 'competitivo');
  assert.deepEqual(mergeThresholds({ competitive: 2000, saturated: 1000 }), DEFAULT_THRESHOLDS, 'incoherent overrides fall back to the defaults');
  assert.equal(mergeThresholds({ evil: 1, saturated: 'x' }).saturated, 1000);
});

test('estimateProfit and the real result follow the user rules (ROAS 2 scale, below 1 switch off)', () => {
  // the skill example: 400 per message at 5 % => 8.000 per sale; ticket 14.000 => ROAS 1,75 (optimize); ticket 30.000 => 3,75
  const mid = estimateProfit({ ticket: 14000, costPerMessage: 400, conversion: 0.05 });
  assert.equal(mid.best.costPerSale, 8000);
  assert.equal(mid.best.roas, 1.75);
  assert.equal(mid.verdict, 'ajustado');
  assert.equal(mid.cpaMax, 7000);
  assert.equal(estimateProfit({ ticket: 30000, costPerMessage: 400, conversion: 0.05 }).verdict, 'viable');
  const bench = estimateProfit({ ticket: 14000 });
  assert.equal(bench.fromBenchmarks, true);
  assert.equal(bench.conversion, 0.03);
  assert.ok(bench.best.roas > bench.worst.roas);
  assert.match(estimateProfit({ ticket: 0 }).error, /ticket/);
  // the benchmarks are in COP: a ticket in another currency is never divided by them
  const mxn = estimateProfit({ ticket: 45, currency: 'mxn' });
  assert.equal(mxn.needsCost, true);
  assert.equal(mxn.verdict, 'sin_estimar');
  assert.equal(mxn.cpaMax, 22.5);
  assert.equal(mxn.maxCostPerMessage, 0.68);
  assert.equal(estimateProfit({ ticket: 45, currency: 'MXN', costPerMessage: 5, conversion: 0.03 }).worst.costPerSale, 167, 'with a cost in that currency it estimates');
  assert.equal(estimateProfit({ ticket: 14000, currency: 'cop' }).fromBenchmarks, true);
  assert.deepEqual(resultFromInput({ roas: 2.4 }), { label: 'acierto', roas: 2.4 });
  assert.deepEqual(resultFromInput({ roas: 0.5 }), { label: 'fallo', roas: 0.5 });
  assert.equal(resultFromInput({ roas: 1.5 }).label, 'neutral');
  assert.equal(resultFromInput({ ticket: 14000, costPerMessage: 400, conversion: 0.05 }).roas, 1.75);
  assert.equal(resultFromInput({}).label, 'sin_datos');
  assert.equal(predictionHit({ decision: 'entrar', label: 'acierto' }), true);
  assert.equal(predictionHit({ decision: 'validar', label: 'fallo' }), false);
  assert.equal(predictionHit({ decision: 'descartar', label: 'fallo' }), true);
  assert.equal(predictionHit({ decision: 'entrar', label: 'neutral' }), null);
});

test('proposeThresholdUpdates needs 3 cases, 75 % agreement and a clean separation to move a threshold', () => {
  const L = (id, verdict, label, mainCount, decision = 'entrar') => ({ id, verdict, decision, label, mainCount });
  assert.deepEqual(proposeThresholdUpdates([L(1, 'hueco', 'acierto', 40), L(2, 'hueco', 'acierto', 50)]), { needed: 1, candidates: [] });
  assert.equal(proposeThresholdUpdates([L(1, 'hueco', 'acierto', 40), L(2, 'hueco', 'neutral', 50), L(3, 'hueco', 'sin_datos', 30)]).needed, 2, 'only labeled cases count');
  const clean = proposeThresholdUpdates([L(1, 'hueco', 'acierto', 40), L(2, 'competitivo', 'acierto', 180), L(3, 'competitivo', 'acierto', 240), L(4, 'saturado', 'fallo', 1500)]);
  const keys = clean.candidates.map((c) => c.key);
  assert.ok(keys.includes('invest:threshold:competitive:200'), keys.join());
  const t = clean.candidates.find((c) => c.scope === 'umbral');
  assert.equal(t.evidence.thresholds.competitive, 200, 'the proposal is capped at double the current threshold');
  assert.deepEqual(t.evidence.from, { competitive: 100 });
  assert.match(t.text, /hasta ~240 anuncios activos/);
  assert.equal(t.evidence.support >= 3, true);
  // overlapping successes and failures: no threshold proposal, only the verdict reliability
  const mixed = proposeThresholdUpdates([L(1, 'hueco', 'acierto', 300), L(2, 'hueco', 'fallo', 200), L(3, 'hueco', 'fallo', 40), L(4, 'hueco', 'fallo', 500)]);
  assert.ok(!mixed.candidates.some((c) => c.scope === 'umbral'));
  assert.match(mixed.candidates.find((c) => c.scope === 'veredicto:hueco').text, /«hueco» quedaron con ROAS menor a 1 en 3 de 4 veces/);
  assert.deepEqual(proposeThresholdUpdates([L(1, 'hueco', 'acierto', 40), L(2, 'hueco', 'fallo', 41), L(3, 'competitivo', 'acierto', 120)]).candidates, [], 'no group reaches 3 cases at 75 %');
  // deterministic
  assert.deepEqual(proposeThresholdUpdates([L(1, 'hueco', 'acierto', 40), L(2, 'competitivo', 'acierto', 180), L(3, 'competitivo', 'acierto', 240), L(4, 'saturado', 'fallo', 1500)]), clean);
});

// ---- research store -------------------------------------------------------------------------------------------

function openResearch(now) {
  const dir = mkTmp('research');
  const researchDir = path.join(dir, 'producto ideas', 'investigaciones');
  const store = createAgentStore(':memory:', { schemaExtra: RESEARCH_SCHEMA });
  const research = createResearch(store.db, { researchDir, now });
  return { dir, researchDir, store, research, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const T0 = Date.parse('2026-10-31T15:00:00');
const sample = (over = {}) => ({
  topic: 'Pizza en air fryer', idea: 'Recetario de pizzas para air fryer', countries: ['CO', 'MX'], decision: 'validar', verdict: 'hueco',
  measurements: [
    { term: 'pizza air fryer', country: 'ALL', count: 1100, type: 'nicho', infoproducers: 0, note: 'casi todo electrodomésticos' },
    { term: 'pizza air fryer', country: 'CO', count: 29, type: 'nicho' },
    { term: '140 recetas italianas', country: 'PE', count: 107, type: 'frase_exacta', infoproducers: 1 },
  ],
  advertisers: [{ page: 'Daniela Garcia', type: 'infoproductor', ads: 107, video_ads: 107, days_active: '5-38', countries: 'PE', channel: 'WhatsApp' }],
  estimate: { ticket: 14000, currency: 'COP', cost_per_message: 400, conversion: 0.05 },
  copy_with_better_angle: ['Daniela: mismo formato, ángulo air fryer'], gaps: ['Pizza y panzerotti en air fryer'], risks: ['Demanda sin probar'], next_question: '¿Valido con poco presupuesto?',
  ...over,
});

test('save writes the report file and the rows; the verdict is computed in code and the file is never overwritten', () => {
  const r = openResearch(() => T0);
  try {
    const saved = r.research.save(sample());
    assert.equal(saved.verdict, 'hueco');
    assert.equal(saved.mainTerm, 'pizza air fryer');
    assert.equal(saved.mainCount, 1100);
    assert.equal(saved.modelVerdictDiffers, false);
    assert.equal(path.basename(saved.file), '2026-10-31-pizza-en-air-fryer.md');
    const md = fs.readFileSync(saved.file, 'utf8');
    assert.match(md, /^# Investigación: Pizza en air fryer/);
    assert.match(md, /~1\.100/);
    assert.match(md, /Daniela Garcia \| infoproductor \| 107/);
    assert.match(md, /CPA máximo \(ROAS 2\): 7\.000/);
    assert.match(md, /Decisión sugerida: \*\*validar\*\*/);
    assert.match(md, /no ventas ni gasto/);
    assert.match(md, /## Resultado real/);
    const mx = r.research.save(sample({ topic: 'Tema en pesos', estimate: { ticket: 45, currency: 'MXN' } }));
    const mxMd = fs.readFileSync(mx.file, 'utf8');
    assert.match(mxMd, /falta medir el costo por mensaje en MXN/);
    assert.doesNotMatch(mxMd, /ROAS 0/);
    const second = r.research.save(sample({ verdict: 'saturado' }));
    assert.equal(path.basename(second.file), '2026-10-31-pizza-en-air-fryer-2.md');
    assert.equal(second.modelVerdictDiffers, true);
    assert.equal(r.research.report(second.id).modelVerdict, 'saturado');
    assert.equal(r.research.report(second.id).verdict, 'hueco', 'the code verdict is the one stored');
    const report = r.research.report(saved.id);
    assert.deepEqual(report.thresholds, DEFAULT_THRESHOLDS, 'the thresholds used travel with the report');
    assert.deepEqual(report.countries, ['CO', 'MX']);
    assert.equal(r.research.measurements(saved.id).length, 3);
    assert.equal(r.research.measurements(saved.id)[2].verdict, 'hueco', 'the skill counts 0-1 infoproducers as a gap even at 107 ads');
    assert.equal(r.research.measurements(saved.id)[1].verdict, 'hueco');
  } finally {
    r.cleanup();
  }
});

test('save rejects bad input without leaving files or rows behind', () => {
  const r = openResearch(() => T0);
  try {
    assert.match(r.research.save(sample({ topic: '' })).error, /tema/);
    assert.match(r.research.save(sample({ decision: 'quizás' })).error, /decision/);
    assert.match(r.research.save(sample({ measurements: [] })).error, /1 y 60/);
    assert.match(r.research.save(sample({ measurements: [{ term: 'x', count: 'muchos' }] })).error, /count/);
    assert.match(r.research.save(sample({ measurements: [{ term: 'x', count: 5, country: 'Colombia' }] })).error, /country/);
    assert.match(r.research.save(sample({ estimate: { ticket: -3 } })).error, /ticket/);
    assert.equal(r.research.reports().length, 0);
    assert.equal(fs.existsSync(r.researchDir), false);
  } finally {
    r.cleanup();
  }
});

test('recent measurements carry their age: numbers younger than 14 days are reusable', () => {
  let now = T0;
  const r = openResearch(() => now);
  try {
    r.research.save(sample());
    now = T0 + 10 * DAY;
    const fresh = r.research.recentMeasurements({ term: 'pizza air fryer' });
    assert.equal(fresh.length, 2);
    assert.ok(fresh.every((m) => m.ageDays === 10 && m.reusable === true));
    now = T0 + 20 * DAY;
    const old = r.research.recentMeasurements({ term: 'pizza' });
    assert.ok(old.every((m) => m.ageDays === 20 && m.reusable === false));
    assert.equal(REUSE_DAYS, 14);
    assert.equal(r.research.recentMeasurements({ term: 'calistenia' }).length, 0);
    assert.equal(r.research.reports({ topic: 'pizza' }).length, 1);
    assert.equal(r.research.reports({ topic: 'oraciones' }).length, 0);
  } finally {
    r.cleanup();
  }
});

test('renderReport follows the skill template sections', () => {
  const m = [{ term: 'x', country: 'ALL', count: 5, kind: 'nicho', infoproducers: null, verdict: 'hueco', reason: 'r', note: '' }];
  const md = renderReport({ date: '2026-10-31', topic: 'X', idea: '', countries: [], measurements: m, advertisers: [], estimate: null, thresholds: DEFAULT_THRESHOLDS, main: m[0], verdict: 'hueco', decision: 'descartar', copy: [], gaps: [], risks: [], nextQuestion: '' });
  for (const h of ['## Qué se buscó', '## Números', '## Clasificación por ángulo', '## Recomendación', '## Limitaciones', '## Resultado real']) assert.ok(md.includes(h), h);
  assert.ok(!md.includes('## Rentabilidad') && !md.includes('## Anunciantes'));
});

// ---- tools -----------------------------------------------------------------------------------------------------

function toolsFor(r, extra = {}) {
  const ctx = { research: r.research, getStore: () => r.store, dataDir: '', sessionId: null, learning: true, researchDir: r.researchDir, ...extra };
  return { ctx, tools: Object.fromEntries(createInvestigadorTools(ctx).map((t) => [t.name, t.handler])) };
}

test('library_url builds the Ad Library address and refuses anything else', () => {
  const url = libraryUrl({ term: 'recetas air fryer', country: 'co' });
  assert.ok(AD_LIBRARY.test(url));
  assert.match(url, /active_status=active&ad_type=all&country=CO&media_type=all&q=recetas%20air%20fryer&search_type=keyword_unordered$/);
  assert.match(libraryUrl({ term: '140 recetas italianas', country: 'PE', exact: true }), /q=%22140%20recetas%20italianas%22&search_type=keyword_exact_phrase/);
  assert.match(libraryUrl({ term: 'bebidas', whatsapp: true }), /q=bebidas%20%7C%20api\.whatsapp\.com/);
  assert.throws(() => libraryUrl({ term: 'x', country: 'ZZ' }), /country/);
  assert.throws(() => libraryUrl({ term: 'x' }), /term/);
  assert.ok(COUNTRIES.includes('BR') && COUNTRIES.includes('ALL'));
});

test('list_research first: thresholds in force, previous reports, reusable numbers and the report text', () => {
  const r = openResearch(() => T0);
  try {
    const { tools } = toolsFor(r);
    const empty = tools.list_research({});
    assert.deepEqual(empty.informes, []);
    assert.equal(empty.umbrales_vigentes.saturated, 1000);
    fs.mkdirSync(r.researchDir, { recursive: true });
    fs.writeFileSync(path.join(r.researchDir, '2026-10-21-gym.md'), '# gym');
    assert.deepEqual(tools.list_research({}).informes_sin_registrar.map((f) => f.archivo), ['2026-10-21-gym.md'], 'hand-written reports are visible too');
    const saved = tools.save_research(sample());
    assert.equal(saved.guardado, true);
    assert.equal(saved.veredicto_codigo, 'hueco');
    assert.equal(saved.estimacion.cpa_maximo, 7000);
    const list = tools.list_research({ topic: 'pizza' });
    assert.equal(list.informes[0].tema, 'Pizza en air fryer');
    assert.equal(list.informes[0].lanzado, false);
    assert.deepEqual(list.informes_sin_registrar.map((f) => f.archivo), ['2026-10-21-gym.md'], 'the saved report is not listed twice');
    assert.equal(list.mediciones_recientes.length, 2);
    assert.equal(list.mediciones_recientes[0].reutilizable, true);
    const one = tools.list_research({ id: saved.id });
    assert.match(one.informe.texto, /# Investigación: Pizza en air fryer/);
    assert.equal(one.informe.mediciones.length, 3);
    assert.match(tools.list_research({ id: 999 }).error, /No encuentro/);
    assert.match(tools.save_research(sample({ measurements: [] })).error, /mediciones/);
  } finally {
    r.cleanup();
  }
});

test('mark_launched compares the prediction with the Analista result (read-only) or with what the user says', () => {
  const fx = makeDataDir();
  const r = openResearch(() => Date.parse('2026-10-11T15:00:00Z'));
  try {
    const { ctx, tools } = toolsFor(r, { dataDir: fx.dataDir, now: () => fx.now });
    const a = tools.save_research(sample({ topic: 'Idea A', decision: 'entrar' })).id;
    const b = tools.save_research(sample({ topic: 'Idea B', decision: 'entrar' })).id;
    const c = tools.save_research(sample({ topic: 'Idea C', decision: 'descartar' })).id;
    const good = tools.mark_launched({ report_id: a, ct_code: 'CT 07', launched_on: '2026-10-01', product: 'Producto A' });
    assert.equal(good.real.fuente, 'analista');
    assert.equal(good.real.etiqueta, 'acierto');
    assert.equal(good.real.roas, 3);
    assert.equal(good.acerto_la_decision, true);
    assert.match(good.siguiente, /Faltan 2/);
    const bad = tools.mark_launched({ report_id: b, ct_code: 'CT08', launched_on: '2026-10-01' });
    assert.equal(bad.real.etiqueta, 'fallo');
    assert.equal(bad.acerto_la_decision, false);
    // no ads data for that CT: falls back to what the user gave; nothing is invented
    const typed = tools.mark_launched({ report_id: c, ct_code: 'CT 99', ticket: 14000, cost_per_message: 400, conversion: 0.05 });
    assert.equal(typed.real.fuente, 'usuario');
    assert.equal(typed.real.roas, 1.75);
    assert.equal(typed.real.etiqueta, 'neutral');
    assert.equal(typed.acerto_la_decision, null);
    assert.match(typed.aviso, /CT 99/);
    const empty = tools.mark_launched({ report_id: c });
    assert.equal(empty.real.etiqueta, 'sin_datos');
    assert.match(tools.mark_launched({ report_id: 404 }).error, /No encuentro/);
    assert.deepEqual(r.store.signals().map((s) => s.kind), ['lanzamiento_acertado', 'lanzamiento_fallido']);
    assert.equal(r.research.launches().length, 3);
    assert.equal(r.research.launch(a).hit, true);
    assert.match(tools.list_research({}).lanzamientos.find((l) => l.informe === a).resultado, /acierto/);
    assert.equal(markLaunched(ctx, { reportId: a, roas: 0.4 }).real.etiqueta, 'fallo', 'marking again replaces the earlier result (one launch per report)');
    assert.equal(r.research.launches().length, 3);
  } finally {
    r.cleanup();
    fx.cleanup();
  }
});

test('threshold learning end to end: 3 measured launches => candidate lessons => the user certifies => new thresholds in force', () => {
  const r = openResearch(() => T0);
  try {
    const { ctx, tools } = toolsFor(r);
    assert.equal(proposeUpdates(ctx).faltan_resultados, 3);
    const plan = [['A', 40, 'acierto'], ['B', 180, 'acierto'], ['C', 240, 'acierto'], ['D', 1500, 'fallo']];
    for (const [name, count, label] of plan) {
      const id = tools.save_research(sample({ topic: `Idea ${name}`, decision: 'entrar', measurements: [{ term: `t${name}`, country: 'ALL', count }] })).id;
      tools.mark_launched({ report_id: id, roas: label === 'acierto' ? 2.5 : 0.4 });
    }
    assert.match(tools.mark_launched({ report_id: 1, roas: 2.5 }).siguiente, /propose_threshold_update/);
    const first = tools.propose_threshold_update({});
    assert.ok(first.propuestas >= 1);
    assert.ok(first.lecciones.some((l) => /umbral de «competitivo» pasaría de ~100 a ~200/.test(l)));
    assert.equal(tools.propose_threshold_update({}).nuevas, 0, 'idempotent');
    // nothing changes until the user certifies
    assert.equal(tools.list_research({}).umbrales_vigentes.competitive, 100);
    const lesson = r.store.lessons('candidate').find((l) => l.evidence.thresholds);
    assert.deepEqual(setLessonStatus(r.store, lesson.id, 'certify').lesson.status, 'certified');
    assert.equal(tools.list_research({}).umbrales_vigentes.competitive, 200);
    assert.equal(activeThresholds(certifiedLessons(r.store)).competitive, 200);
    // the prompt carries the new numbers and the certified lessons
    const prompt = AGENTS.investigador.systemPrompt({ dataDir: '', now: T0, lessons: certifiedLessons(r.store), settings: { learning: true } });
    assert.match(prompt, /competitivo desde ~200/);
    assert.match(prompt, /LECCIONES CERTIFICADAS/);
    // revoking goes back to the defaults
    setLessonStatus(r.store, lesson.id, 'revoke');
    assert.equal(tools.list_research({}).umbrales_vigentes.competitive, 100);
    // a new report is classified with the thresholds in force
    setLessonStatus(r.store, lesson.id, 'restore');
    setLessonStatus(r.store, lesson.id, 'certify');
    const saved = tools.save_research(sample({ topic: 'Idea E', measurements: [{ term: 'e', country: 'ALL', count: 150 }] }));
    assert.equal(saved.veredicto_codigo, 'hueco', 'with competitive at ~200, 150 ads is a probable gap (it was competitive at ~100)');
    assert.equal(r.research.report(saved.id).thresholds.competitive, 200);
  } finally {
    r.cleanup();
  }
});

test('the learning tools are available (and gated by the switch) next to the research tools', () => {
  const r = openResearch(() => T0);
  try {
    assert.deepEqual(createInvestigadorTools({ research: r.research, getStore: () => r.store, learning: true, researchDir: r.researchDir }).map((t) => t.name), [...INVESTIGADOR_TOOL_NAMES, ...AGENT_LEARNING_TOOL_NAMES]);
    assert.deepEqual(createInvestigadorTools({ research: r.research, getStore: () => r.store, learning: false, researchDir: r.researchDir }).map((t) => t.name), [...INVESTIGADOR_TOOL_NAMES]);
    const store = r.store;
    const sid = store.createSession('x');
    store.addMessage({ sessionId: sid, role: 'user', text: 'No me interesan los nichos de salud ni de medicina.' });
    const { tools } = toolsFor(r, { sessionId: sid });
    assert.equal(tools.propose_rule({ text: 'No interesan los nichos de salud ni de medicina', quote: 'no me interesan los nichos de salud' }).estado, 'candidate');
  } finally {
    r.cleanup();
  }
});

// ---- browser and file guard ------------------------------------------------------------------------------------

const ROOT = 'C:\\Users\\victo\\Proyectos\\ventas automaticas\\producto ideas\\investigaciones';
const PLUGIN = 'C:\\Users\\victo\\AppData\\Roaming\\agentautox1\\agents\\investigador\\plugin';
const opts = { root: ROOT, pluginDir: PLUGIN, skillsDir: '' };
const run = (tool_name, tool_input = {}) => decide({ tool_name, tool_input }, opts).decision;
const CHROME = (t) => `mcp__claude-in-chrome__${t}`;
const LIB = 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=CO&q=recetas&search_type=keyword_unordered&media_type=all';

test('guard: the browser only reads the Ad Library; nothing else is reachable', () => {
  assert.equal(run(CHROME('navigate'), { url: LIB, tabId: 1 }), 'allow');
  for (const url of ['https://www.facebook.com/login', 'https://facebook.com/ads/manager', 'https://evil.com/?u=https://www.facebook.com/ads/library/', 'http://www.facebook.com/ads/library/', 'javascript:alert(1)', 'https://www.facebook.com.evil.com/ads/library/', '']) {
    assert.equal(run(CHROME('navigate'), { url }), 'deny', url);
  }
  for (const t of ['tabs_context_mcp', 'tabs_close_mcp', 'get_page_text']) assert.equal(run(CHROME(t), {}), 'pass', t);
  assert.equal(run(CHROME('tabs_create_mcp'), {}), 'allow');
  assert.equal(run(CHROME('tabs_create_mcp'), { url: 'https://www.facebook.com/login' }), 'deny');
  assert.equal(run(CHROME('tabs_create_mcp'), { url: LIB }), 'allow');
  for (const t of ['computer', 'form_input', 'javascript_tool', 'find', 'file_upload', 'read_page', 'upload_image', 'gif_creator', 'read_network_requests', 'shortcuts_execute', 'resize_window', 'browser_batch']) assert.equal(run(CHROME(t), {}), 'deny', t);
  assert.equal(browserDecision('computer', {}).decision, 'deny');
  assert.deepEqual([...INVESTIGADOR_BROWSER_TOOLS].sort(), ['tabs_close_mcp', 'tabs_context_mcp', 'tabs_create_mcp', 'navigate', 'get_page_text'].map(CHROME).sort());
});

test('guard: own MCP tools, the skill of the plugin, reads confined to reports and plugin, everything else denied', () => {
  for (const t of [...INVESTIGADOR_TOOL_NAMES, ...AGENT_LEARNING_TOOL_NAMES]) assert.equal(run(`mcp__investigador__${t}`, {}), 'pass', t);
  assert.equal(run('mcp__investigador__delete_everything', {}), 'deny');
  assert.equal(run('mcp__creativo__generate_image', {}), 'deny');
  assert.equal(run('mcp__plugin_adspirer__x', {}), 'deny');
  assert.equal(run('Skill', { skill: 'investigador:investigacion-mercado' }), 'pass');
  assert.equal(run('Skill', { skill: 'creativo:new-product' }), 'deny');
  assert.equal(run('Skill', { skill: 'leona-receipts' }), 'deny');
  assert.equal(run('Read', { file_path: `${ROOT}\\2026-10-21-gym.md` }), 'pass');
  assert.equal(run('Read', { file_path: `${PLUGIN}\\skills\\investigacion-mercado\\SKILL.md` }), 'pass');
  for (const p of ['C:\\Users\\victo\\Proyectos\\ventas automaticas\\agentAutoX1\\app\\src\\x.rs', 'C:\\Users\\victo\\Proyectos\\ventas automaticas\\Producto Bebidas\\contexto.md', 'C:\\Users\\victo\\.claude\\skills\\new-product\\SKILL.md', 'C:\\Users\\victo\\.ssh\\id_rsa', `${ROOT}\\..\\..\\Token Leona.txt`]) {
    assert.equal(run('Read', { file_path: p }), 'deny', p);
  }
  for (const t of ['Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task', 'Agent', 'PowerShell', 'NotebookEdit']) assert.equal(run(t, { command: 'dir', file_path: `${ROOT}\\x.md`, pattern: '*' }), 'deny', t);
  assert.equal(run('WebSearch', { query: 'x' }), 'pass');
  assert.equal(run('WebFetch', { url: 'https://example.com' }), 'deny', 'WebFetch could exfiltrate or open other Facebook pages');
});

test('the guard hook process fails closed and speaks the PreToolUse protocol', () => {
  const guard = path.join(HERE, 'investigador-guard.js');
  const call = (event, args = ['--root', ROOT, '--plugin', PLUGIN]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', guard, ...args], { input: JSON.stringify(event), encoding: 'utf8' });
  const denied = call({ tool_name: CHROME('navigate'), tool_input: { url: 'https://example.com' } });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(call({ tool_name: CHROME('navigate'), tool_input: { url: LIB } }).stdout).hookSpecificOutput.permissionDecision, 'allow', 'the Ad Library is allowed only by the hook');
  assert.equal(call({ tool_name: CHROME('get_page_text'), tool_input: {} }).stdout, '', 'a pass prints nothing');
  assert.equal(JSON.parse(call({ tool_name: 'Read', tool_input: {} }, []).stdout).hookSpecificOutput.permissionDecision, 'deny', 'missing --root: closed');
  assert.equal(JSON.parse(spawnSync(process.execPath, [guard, '--root', ROOT], { input: 'no json', encoding: 'utf8' }).stdout).hookSpecificOutput.permissionDecision, 'deny');
});

// ---- launch, args, prompt --------------------------------------------------------------------------------------

test('investigador args: its own MCP, Read + Skill + web, --chrome and only five browser tools, no Bash', () => {
  const extra = { pluginDir: 'P', settingsFile: 'S.json', allowedTools: [...INVESTIGADOR_BROWSER_TOOLS], flags: ['--chrome'], mcpServers: {} };
  const args = buildClaudeArgs({ agent: AGENTS.investigador, mcpConfigFile: 'm.json', toolNames: AGENTS.investigador.toolNames({ learning: true }), web: true, model: 'haiku', resume: null, appendSystemPrompt: 'X', extra });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes('--chrome') && args.includes('--strict-mcp-config'));
  assert.equal(at('--tools'), 'Read,Skill,WebSearch,WebFetch');
  assert.equal(at('--permission-mode'), 'dontAsk');
  assert.equal(at('--plugin-dir'), 'P');
  assert.equal(at('--model'), 'haiku');
  assert.ok(!args.includes('--disable-slash-commands'));
  const allowed = at('--allowedTools').split(',');
  for (const t of ['mcp__investigador__library_url', 'mcp__investigador__save_research', 'mcp__investigador__get_lessons', 'Read', 'Skill', 'WebSearch', 'WebFetch', ...INVESTIGADOR_BROWSER_TOOLS]) assert.ok(allowed.includes(t), t);
  assert.equal(allowed.filter((t) => t.startsWith('mcp__claude-in-chrome__')).length, 5);
  assert.ok(!allowed.some((t) => /Bash|Write|Edit|computer|javascript/.test(t)));
  const denied = at('--disallowedTools').split(',');
  for (const t of ['Bash', 'Write', 'Edit', 'Task', 'Agent', 'PowerShell']) assert.ok(denied.includes(t), t);
  assert.ok(!denied.includes('Read') && !denied.includes('Skill'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  // without the web switch the web tools go away, the rest stays
  const noWeb = buildClaudeArgs({ agent: AGENTS.investigador, mcpConfigFile: 'm.json', toolNames: [], web: false, model: '', resume: null, appendSystemPrompt: 'X', extra });
  assert.equal(noWeb[noWeb.indexOf('--tools') + 1], 'Read,Skill');
  // the Analista's args never carry extra flags
  assert.ok(!buildClaudeArgs({ mcpConfigFile: 'm.json', toolNames: ['metrics'], web: true, model: '', resume: null, appendSystemPrompt: 'P' }).includes('--chrome'));
});

test('launch builds the plugin with ONLY the research skill, the guard settings and the env of the MCP server', () => {
  const data = mkTmp('inv-data');
  const skills = mkTmp('inv-skills');
  const root = mkTmp('inv-root');
  try {
    for (const name of ['investigacion-mercado', 'new-product']) {
      fs.mkdirSync(path.join(skills, name), { recursive: true });
      fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`);
    }
    const launch = prepareInvestigadorLaunch({ dataDir: data, root, skillsSource: skills, log: () => undefined, nodePath: 'C:\\node\\node.exe' });
    assert.deepEqual(launch.plugin.included, ['investigacion-mercado']);
    assert.ok(fs.existsSync(path.join(launch.pluginDir, 'skills', 'investigacion-mercado', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(launch.pluginDir, 'skills', 'new-product')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(launch.pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'investigador');
    assert.deepEqual(launch.flags, ['--chrome']);
    assert.equal(launch.toolsEnv.AGENTAUTO_RESEARCH_DIR, path.join(root, 'producto ideas', 'investigaciones'));
    assert.ok(fs.existsSync(launch.toolsEnv.AGENTAUTO_RESEARCH_DIR));
    const settings = JSON.parse(fs.readFileSync(launch.settingsFile, 'utf8'));
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /investigador-guard\.js" --root ".*investigaciones" --plugin ".*plugin"/);
    assert.ok(settings.hooks.PreToolUse[0].matcher.includes('mcp__.*') && settings.hooks.PreToolUse[0].matcher.includes('Bash'));
    assert.ok(settings.permissions.deny.includes('Read(**/.env*)'));
    assert.equal(researchDirOf({ AGENTAUTO_RESEARCH_DIR: 'D:\\informes' }), 'D:\\informes', 'owner-specific path comes from config');
    assert.equal(buildGuardSettings({ researchDir: 'R', pluginDir: 'P', nodePath: 'n' }).hooks.PreToolUse[0].hooks[0].timeout, 15);
  } finally {
    for (const d of [data, skills, root]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('prompt and progress labels: neutral Spanish with tú, hard browsing rules, live thresholds', () => {
  const prompt = investigadorPrompt({ researchDir: ROOT, thresholds: mergeThresholds({ competitive: 150 }), lessons: [{ text: 'Los productos «hueco» llegaron a ROAS de 2 o más en 4 de 5 veces.' }], today: '2026-10-31' });
  assert.match(prompt, /competitivo desde ~150/);
  assert.match(prompt, /Solo lectura\./);
  assert.match(prompt, /No inicies sesión/);
  assert.match(prompt, /no resuelvas CAPTCHAs/);
  assert.match(prompt, /no publiques ni escribas a anunciantes/);
  assert.match(prompt, /list_research/);
  assert.match(prompt, /14 días/);
  assert.match(prompt, /LECCIONES CERTIFICADAS[\s\S]*4 de 5 veces/);
  assert.doesNotMatch(prompt, /\b(tenés|querés|podés|sabés|elegí|decime|hacé)\b/i, 'no voseo');
  assert.equal(investigadorStepLabel(CHROME('navigate'), { url: LIB }), 'Midiendo «recetas» en CO en la Biblioteca de anuncios…');
  assert.equal(investigadorStepLabel(CHROME('get_page_text')), 'Leyendo el conteo de anuncios…');
  assert.equal(investigadorStepLabel('mcp__investigador__save_research'), 'Guardando el informe…');
  assert.equal(investigadorStepLabel('Skill', {}), 'Usando la skill de investigación de mercado…');
  assert.equal(investigadorStepLabel('Whatever'), 'Trabajando en un paso…');
});

test('review fixes: null / empty numbers are not zero, bad conversion is refused, quotes stay short-proof', () => {
  assert.equal(resultFromInput({ roas: null }).label, 'sin_datos');
  assert.equal(resultFromInput({ roas: '' }).label, 'sin_datos');
  assert.match(estimateProfit({ ticket: 5000, conversion: 0 }).error, /conversion/);
  assert.match(estimateProfit({ ticket: 5000, costPerMessage: 0, conversion: 0.03 }).error, /cost_per_message/);
  assert.equal(estimateProfit({ ticket: 50000, costPerMessage: null }).fromBenchmarks, true, 'null cost falls back to the benchmarks, never to zero');
  const r = openResearch(() => T0);
  try {
    const saved = r.research.save(sample({ measurements: [{ term: 'a|b', country: 'ALL', count: 3, measured_on: '9999-12-31' }], advertisers: [{ page: 'x | y\n## inyectado', type: 'marca', days_active: 'a\n# h' }] }));
    const md = fs.readFileSync(saved.file, 'utf8');
    assert.ok(!md.includes('\n## inyectado') && !md.includes('\n# h'));
    assert.notEqual(r.research.measurements(saved.id)[0].measuredOn, '9999-12-31');
  } finally {
    r.cleanup();
  }
});
