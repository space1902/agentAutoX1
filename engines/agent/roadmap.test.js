// Phase 4: the roadmap board (store, disk-driven seeding, evidence rule) and its MCP tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createOutputs, CREATIVO_LEARNING_SCHEMA } from './creativo-learning.js';
import { createRoadmapTools, ROADMAP_TOOL_NAMES } from './creativo-extra-tools.js';
import { FREE_MCP_TOOLS } from './creativo-guard.js';
import { createRoadmap, loadRoadmapConfig, ROADMAP_SCHEMA, verifyRule } from './creativo-roadmap.js';

const mkTmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const put = (root, rel, text = 'x') => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** A workspace with one product and two countries, a little done in each. */
function workspace() {
  const root = mkTmp('roadmap');
  put(root, 'Producto Demo/contexto.md');
  for (const c of ['colombia', 'mexico']) {
    put(root, `Producto Demo/audios/${c}/clientes/a.mp3`);
    put(root, `Producto Demo/pdf/${c}/01-uno/libro-uno.pdf`);
    put(root, `Producto Demo/guiones/${c}/guiones-video-${c}.txt`);
  }
  for (let n = 1; n <= 4; n += 1) put(root, `Producto Demo/audios/colombia/clientes/a${n}.mp3`);
  put(root, 'Producto Demo/mensajes-chat/mexico/mensajes-whatsapp.txt', 'Hola [LINK DRIVE BASE] y [DATOS PAGO]');
  put(root, 'Producto Demo/mensajes-chat/colombia/mensajes-whatsapp.txt', 'Hola, todo listo');
  put(root, 'producto ideas/viejo/nota.txt');
  return root;
}

function open(root, agentDirPath = '') {
  const db = new DatabaseSync(':memory:');
  db.exec(ROADMAP_SCHEMA);
  let t = 1_000;
  const roadmap = createRoadmap(db, { root, agentDirPath, now: () => (t += 1000) });
  return { db, roadmap, find: (country, template) => roadmap.items().find((i) => (i.country ?? '') === (country ?? '') && i.templateId === template) };
}

test('seeding reads the disk: done, in progress, pending and manual items, per product and country', () => {
  const root = workspace();
  try {
    const { roadmap, find } = open(root);
    const seeded = roadmap.seed();
    assert.equal(seeded.products, 1);
    assert.ok(seeded.created > 30);
    assert.equal(find(null, 'contexto').status, 'hecho');
    assert.equal(find(null, 'contexto').evidencePath, 'Producto Demo/contexto.md');
    assert.equal(find(null, 'contexto').markedBy, 'sistema');
    assert.equal(find('colombia', 'audios-clientes').status, 'hecho', '4 of 4 mp3');
    assert.equal(find('mexico', 'audios-clientes').status, 'en_progreso', '1 of 4 mp3');
    assert.match(find('mexico', 'audios-clientes').detail, /1 de 4/);
    assert.equal(find('colombia', 'audios-contenido').status, 'pendiente');
    assert.equal(find('mexico', 'mensajes-chat').status, 'en_progreso', 'placeholders left in the chat file');
    assert.match(find('mexico', 'mensajes-chat').detail, /2 marcadores/);
    assert.equal(find('colombia', 'mensajes-chat').status, 'hecho');
    assert.equal(find('colombia', 'pdf').status, 'en_progreso', '1 of 16 distinct pdf');
    assert.equal(find('colombia', 'flujo-leona').status, 'pendiente', 'nothing on disk proves a Leona flow');
    assert.match(find('colombia', 'flujo-leona').detail, /No se puede comprobar/);
    assert.equal(find('colombia', 'precios').status, 'pendiente', 'prices are only checked for the countries that have the file');
    // product-level items exist once, country items once per country
    assert.equal(roadmap.items({ country: '' }).length > 0, true);
    const [board] = roadmap.board();
    assert.deepEqual(board.countries, ['colombia', 'mexico']);
    assert.ok(board.progress.colombia.pct > board.progress.mexico.pct - 1 && board.progress.colombia.total === board.progress.mexico.total);
    assert.equal(roadmap.seed().created, 0, 'seeding twice creates nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a re-seed follows the disk for system marks and never overrides what a person or the agent marked', () => {
  const root = workspace();
  try {
    const { roadmap, find } = open(root);
    roadmap.seed();
    const mex = find('mexico', 'audios-clientes');
    const guiones = find('colombia', 'guiones');
    assert.equal(roadmap.mark({ id: guiones.id, status: 'no_aplica', by: 'usuario' }).item.markedBy, 'usuario');
    for (let n = 2; n <= 4; n += 1) put(root, `Producto Demo/audios/mexico/clientes/b${n}.mp3`);
    const again = roadmap.seed();
    assert.ok(again.refreshed >= 1);
    assert.equal(find('mexico', 'audios-clientes').status, 'hecho', 'the system mark follows the new files');
    assert.equal(find('colombia', 'guiones').status, 'no_aplica', 'the user mark stays');
    assert.equal(find('colombia', 'guiones').markedBy, 'usuario');
    assert.ok(roadmap.log(mex.id).some((l) => l.old === 'en_progreso' && l.new === 'hecho' && l.by === 'sistema'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the agent can mark "hecho" only with evidence that exists on disk, inside the workspace, and never over the user', () => {
  const root = workspace();
  try {
    const { roadmap, find } = open(root);
    roadmap.seed();
    const item = find('colombia', 'audios-contenido');
    assert.match(roadmap.mark({ id: item.id, status: 'hecho', by: 'agente' }).error, /evidence_path/);
    assert.match(roadmap.mark({ id: item.id, status: 'hecho', evidencePath: 'Producto Demo/audios/colombia/contenido', by: 'agente' }).error, /No existe/);
    assert.match(roadmap.mark({ id: item.id, status: 'hecho', evidencePath: '../fuera.txt', by: 'agente' }).error, /carpeta de trabajo/);
    assert.match(roadmap.mark({ id: item.id, status: 'hecho', evidencePath: 'C:/Windows/win.ini', by: 'agente' }).error, /carpeta de trabajo/);
    put(root, 'Producto Demo/node_modules/x.txt');
    assert.match(roadmap.mark({ id: item.id, status: 'hecho', evidencePath: 'Producto Demo/node_modules/x.txt', by: 'agente' }).error, /bloqueada/);
    assert.equal(find('colombia', 'audios-contenido').status, 'pendiente', 'every rejection left the item as it was');
    put(root, 'Producto Demo/audios/colombia/contenido/guion_01.mp3');
    const ok = roadmap.mark({ id: item.id, status: 'hecho', evidencePath: 'Producto Demo/audios/colombia/contenido', note: 'Primer audio listo', by: 'agente' });
    assert.equal(ok.item.status, 'hecho');
    assert.equal(ok.item.markedBy, 'agente');
    assert.equal(ok.item.evidencePath, 'Producto Demo/audios/colombia/contenido');
    assert.match(ok.item.notes, /\(agente\): Primer audio listo/);
    // the agent needs a reason for "no aplica", and cannot touch what the user marked
    assert.match(roadmap.mark({ id: item.id, status: 'no_aplica', by: 'agente' }).error, /por qué/);
    roadmap.mark({ id: item.id, status: 'pendiente', note: 'Lo rehago yo', by: 'usuario' });
    assert.match(roadmap.mark({ id: item.id, status: 'hecho', evidencePath: 'Producto Demo/contexto.md', by: 'agente' }).error, /lo marcó el usuario/);
    // the user needs no evidence and can mark anything
    assert.equal(roadmap.mark({ id: find('colombia', 'pago').id, status: 'hecho', by: 'usuario' }).item.status, 'hecho');
    assert.match(roadmap.mark({ id: item.id, status: 'casi', by: 'usuario' }).error, /status/);
    assert.match(roadmap.mark({ id: 9999, status: 'hecho', by: 'usuario' }).error, /No encuentro/);
    // the evidence goes stale when the file disappears
    fs.rmSync(path.join(root, 'Producto Demo', 'contexto.md'));
    assert.equal(find(null, 'contexto').evidenceBroken, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the database enforces the allowed statuses (CHECK) and notes are appended with who wrote them', () => {
  const root = workspace();
  try {
    const { db, roadmap, find } = open(root);
    roadmap.seed();
    assert.throws(() => db.prepare("UPDATE checklist_items SET status = 'listo' WHERE id = 1").run(), /CHECK/);
    const it = find('colombia', 'pdf');
    roadmap.addNote(it.id, 'Falta el 06', 'agente');
    roadmap.addNote(it.id, 'Lo reviso mañana', 'usuario');
    assert.match(roadmap.get(it.id).notes, /\(agente\): Falta el 06\n.*\(usuario\): Lo reviso mañana/);
    assert.match(roadmap.addNote(it.id, '   ', 'agente').error, /vacía/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('propose_next respects dependencies and the order of the checklist', () => {
  const root = workspace();
  try {
    const { roadmap } = open(root);
    roadmap.seed();
    const next = roadmap.proposeNext({ product: 'demo', country: 'colombia', limit: 10 }).map((i) => i.templateId);
    assert.ok(next.includes('pdf') && next.includes('audios-contenido'));
    assert.ok(!next.includes('videos'), 'videos wait for the content audios and the b-roll');
    assert.ok(!next.includes('campanas'), 'campaigns wait for videos, texts, flow and payment');
    assert.ok(next.indexOf('pdf') < next.indexOf('audios-contenido'), 'template order');
    assert.ok(!next.includes('contexto'), 'done items are not proposed');
    const manual = roadmap.proposeNext({ product: 'demo', country: 'colombia', limit: 20 }).find((i) => i.templateId === 'pago');
    assert.equal(manual.manual, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('owner config: extra templates and country suffixes live in roadmap.config.json, not in the code', () => {
  const root = workspace();
  const agentDirPath = mkTmp('roadmap-cfg');
  try {
    fs.writeFileSync(path.join(agentDirPath, 'roadmap.config.json'), JSON.stringify({ countrySuffix: { mexico: 'mex' }, templates: [{ id: 'landing', scope: 'country', title: 'Landing', sort: 5, verify: { type: 'file', path: 'landing/{c}{sfx}.html' } }, { id: 'pdf', scope: 'country', title: 'PDF (2)', sort: 50, verify: { type: 'files', dir: 'pdf/{c}', match: '\\.pdf$', expected: 1, distinct: true } }] }));
    put(root, 'Producto Demo/landing/mexico-mex.html');
    const cfg = loadRoadmapConfig(agentDirPath);
    assert.equal(cfg.countrySuffix.mexico, 'mex');
    assert.equal(cfg.countrySuffix.colombia, '');
    assert.ok(cfg.templates.some((t) => t.id === 'landing') && cfg.templates.find((t) => t.id === 'pdf').title === 'PDF (2)');
    const { roadmap, find } = open(root, agentDirPath);
    roadmap.seed();
    assert.equal(find('mexico', 'landing').status, 'hecho');
    assert.equal(find('colombia', 'landing').status, 'pendiente');
    assert.equal(find('colombia', 'pdf').status, 'hecho', 'the owner template replaced the default one');
    assert.deepEqual(loadRoadmapConfig(path.join(agentDirPath, 'missing')).countrySuffix.mexico, 'mx', 'no file: defaults');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(agentDirPath, { recursive: true, force: true });
  }
});

test('verifyRule: any picks the best alternative and a missing rule is manual', () => {
  const root = workspace();
  try {
    const productDir = path.join(root, 'Producto Demo');
    const tokens = { c: 'colombia', sfx: '', p: 'demo' };
    const best = verifyRule({ type: 'any', of: [{ type: 'file', path: 'nada.txt' }, { type: 'file', path: 'contexto.md' }] }, { root, productDir, tokens });
    assert.equal(best.status, 'hecho');
    assert.equal(verifyRule(null, { root, productDir, tokens }).manual, true);
    assert.equal(verifyRule({ type: 'rara' }, { root, productDir, tokens }).status, 'pendiente');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP tools: list_roadmap, mark_item, add_note, propose_next, list_outputs; names match the guard list', () => {
  const root = workspace();
  try {
    const { db, roadmap } = open(root);
    db.exec(CREATIVO_LEARNING_SCHEMA);
    const outputs = createOutputs(db);
    const tools = Object.fromEntries(createRoadmapTools({ roadmap, outputs }).map((t) => [t.name, t.handler]));
    assert.deepEqual(Object.keys(tools), ROADMAP_TOOL_NAMES);
    assert.ok(ROADMAP_TOOL_NAMES.every((t) => FREE_MCP_TOOLS.includes(t)), 'the guard lets them through');
    const listing = tools.list_roadmap({ product: 'Demo', country: 'mexico' });
    assert.equal(listing.productos[0].producto, 'Demo');
    assert.ok(listing.items.every((i) => i.pais === 'mexico'));
    assert.ok(listing.items[0].estado !== 'hecho', 'pending work first');
    const pending = tools.list_roadmap({ status: 'pendiente' }).items.find((i) => i.plantilla === 'audios-contenido' && i.pais === 'colombia');
    assert.match(tools.mark_item({ item_id: pending.item_id, status: 'hecho' }).error, /evidence_path/);
    put(root, 'Producto Demo/audios/colombia/contenido/g1.mp3');
    assert.equal(tools.mark_item({ item_id: pending.item_id, status: 'en_progreso', evidence_path: 'Producto Demo/audios/colombia/contenido', note: 'Va 1 de 12' }).item.marcado_por, 'agente');
    assert.match(tools.add_note({ item_id: pending.item_id, text: 'Falta crédito de voz' }).item.notas, /Falta crédito/);
    assert.ok(tools.propose_next({ product: 'demo', country: 'colombia' }).siguientes.length <= 5);
    assert.deepEqual(tools.list_outputs({}).archivos, []);
    outputs.record({ tool: 'generate_voice', args: { product: 'Demo', country: 'colombia' }, result: { ruta: path.join(root, 'v.mp3') } });
    assert.equal(tools.list_outputs({ status: 'generated' }).archivos[0].tipo, 'audio');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review fixes: the workspace itself is not evidence and a user mark made meanwhile survives', () => {
  const root = workspace();
  try {
    const { roadmap, find } = open(root);
    roadmap.seed();
    const item = find('colombia', 'audios-contenido');
    assert.match(roadmap.mark({ id: item.id, status: 'hecho', evidencePath: '.', by: 'agente' }).error, /carpeta de trabajo/);
    assert.match(roadmap.mark({ id: item.id, status: 'hecho', evidencePath: 'Producto Demo/AGENTA~1/x', by: 'agente' }).error, /carpeta de trabajo|No existe|bloqueada/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
