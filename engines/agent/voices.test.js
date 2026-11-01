import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentError, codexStatus, runCommand } from './agent-api.js';
import { createApprovals } from './creativo-approvals.js';
import { openAgentStore } from './agent-db.js';
import { AGENTS } from './registry.js';
import { COMMANDS, NEEDS_KEY, runVoicesCommand, VoicesError } from './voices-api.js';

const mkTmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

function setup() {
  const tmp = mkTmp('voices');
  const root = path.join(tmp, 'ventas');
  for (const sub of ['pdf/colombia', 'pdf/venezuela', 'audios/colombia', 'audios/venezuela']) fs.mkdirSync(path.join(root, 'Producto Bebidas', sub), { recursive: true });
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/user/subscription')) return { ok: true, status: 200, json: async () => ({ tier: 'creator', character_count: 100, character_limit: 1000 }) };
    if (url.endsWith('/v1/voices')) return { ok: true, status: 200, json: async () => ({ voices: [{ voice_id: 'O5hbneAmtjLMgfg5UFIm', name: 'Maria', preview_url: 'https://p/x.mp3' }] }) };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('AUDIO').buffer };
  };
  const env = { AGENTAUTO_ELEVEN_KEY: 'xi-secret-value' };
  const run = (command, payload = {}, extra = {}) => runVoicesCommand(command, payload, { dataDir, root, env, fetchFn, ...extra });
  return { tmp, root, dataDir, calls, run, env };
}

test('voices: the command list matches what needs the key, and unknown commands are refused', async () => {
  const s = setup();
  try {
    for (const c of NEEDS_KEY) assert.ok(COMMANDS.includes(c), c);
    await assert.rejects(s.run('rm -rf'), (e) => e instanceof VoicesError && /no permitido/.test(e.message));
    const ctx = await s.run('context');
    assert.deepEqual(ctx.products, [{ name: 'Bebidas', folder: 'Producto Bebidas', countries: ['colombia', 'venezuela'] }]);
    assert.ok(ctx.models.includes('eleven_multilingual_v2'));
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test('voices: test key, list voices and subscription use the key from the env only, and never return it', async () => {
  const s = setup();
  try {
    assert.deepEqual(await s.run('key-test'), { ok: true, tier: 'creator', remaining: 900, limit: 1000 });
    assert.equal((await s.run('voices')).voices[0].previewUrl, 'https://p/x.mp3');
    assert.equal((await s.run('subscription')).subscription.remaining, 900);
    assert.ok(s.calls.every((c) => c.init.headers['xi-api-key'] === 'xi-secret-value'));
    assert.ok(!JSON.stringify([await s.run('key-test'), await s.run('voices')]).includes('xi-secret-value'));
    await assert.rejects(s.run('key-test', {}, { env: {} }), /Falta la clave de ElevenLabs/);
    const failing = async () => ({ ok: false, status: 401, text: async () => 'nope xi-secret-value' });
    await assert.rejects(s.run('voices', {}, { fetchFn: failing }), (e) => /401/.test(e.message) && !e.message.includes('xi-secret-value'));
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test('voices: presets round-trip and the estimate follows the preset model', async () => {
  const s = setup();
  try {
    assert.deepEqual((await s.run('presets-get')).presets, []);
    const saved = await s.run('presets-set', { presets: [{ name: 'Venezuela', voiceId: 'O5hbneAmtjLMgfg5UFIm', product: 'Bebidas', country: 'venezuela', modelId: 'eleven_flash_v2_5', stability: 0.4 }] });
    assert.equal(saved.presets[0].country, 'venezuela');
    const id = (await s.run('presets-get')).presets[0].id;
    assert.deepEqual(await s.run('estimate', { text: 'a'.repeat(101), presetId: id }), { chars: 101, credits: 51, modelId: 'eleven_flash_v2_5' });
    assert.deepEqual(await s.run('estimate', { text: 'hola' }), { chars: 4, credits: 4, modelId: 'eleven_multilingual_v2' });
    await assert.rejects(s.run('presets-set', { presets: [{ name: '', voiceId: 'x' }] }), /nombre/);
    await assert.rejects(s.run('presets-set', { presets: 'no' }), /no son válidos/);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test('voices: manual generation needs the confirmed credits, writes without overwriting and plays back only mp3', async () => {
  const s = setup();
  try {
    const preset = (await s.run('presets-set', { presets: [{ name: 'Venezuela', voiceId: 'O5hbneAmtjLMgfg5UFIm', country: 'venezuela', product: 'Bebidas' }] })).presets[0];
    const base = { text: '¡Hola pana!', presetId: preset.id, product: 'Bebidas', country: 'venezuela', filename: 'prueba' };
    const synth = () => s.calls.filter((c) => c.url.includes('text-to-speech')).length;
    await assert.rejects(s.run('generate', base), /Confirma primero/);
    await assert.rejects(s.run('generate', { ...base, confirmed: true, confirmedCredits: 3 }), /Confirma primero/, 'a stale estimate is not enough');
    assert.equal(synth(), 0, 'nothing is spent without the confirmation');
    const first = await s.run('generate', { ...base, confirmed: true, confirmedCredits: 11 });
    assert.equal(first.file, path.join(s.root, 'Producto Bebidas', 'audios', 'venezuela', 'prueba.mp3'));
    assert.equal(first.credits, 11);
    const second = await s.run('generate', { ...base, confirmed: true, confirmedCredits: 11 });
    assert.equal(path.basename(second.file), 'prueba-2.mp3');
    assert.equal(fs.readFileSync(first.file, 'utf8'), 'AUDIO');
    const custom = path.join(s.tmp, 'otra carpeta');
    const chosen = await s.run('generate', { ...base, outputDir: custom, confirmed: true, confirmedCredits: 11 });
    assert.equal(path.dirname(chosen.file), custom);
    assert.ok((await s.run('audio-read', { path: first.file })).dataUrl.startsWith('data:audio/mpeg;base64,'));
    await assert.rejects(s.run('audio-read', { path: path.join(s.tmp, 'data', 'voices', 'presets.json') }), /\.mp3/);
    await assert.rejects(s.run('generate', { ...base, text: '  ', confirmed: true, confirmedCredits: 0 }), /Escribe el texto/);
    await assert.rejects(s.run('generate', { ...base, product: 'Nada', confirmed: true, confirmedCredits: 11 }), /Productos disponibles/);
    await assert.rejects(s.run('generate', { ...base, presetId: 'fantasma', confirmed: true, confirmedCredits: 11 }), /No encuentro ese preset/);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test('agent commands: approvals are listed and decided only for the creativo; Codex status tells the user what to do', async () => {
  const tmp = mkTmp('api');
  try {
    const store = openAgentStore(tmp, undefined, AGENTS.creativo);
    const proposal = createApprovals(store.db).propose({ items: [{ tool: 'generate_image', args: { prompt: 'una michelada', product: 'Bebidas', country: 'venezuela' }, label: 'Imagen', units: { images: 1 } }] });
    store.close();
    const pending = await runCommand('proposals', { status: 'pending' }, { dataDir: tmp, agentId: 'creativo' });
    assert.equal(pending.proposals.length, 1);
    assert.equal(pending.proposals[0].items[0].units.images, 1);
    assert.deepEqual(await runCommand('proposal-decide', { id: proposal.id, approve: true }, { dataDir: tmp, agentId: 'creativo' }), { id: proposal.id, status: 'approved' });
    await assert.rejects(runCommand('proposal-decide', { id: proposal.id, approve: false }, { dataDir: tmp, agentId: 'creativo' }), /ya fue resuelta/);
    await assert.rejects(runCommand('proposals', {}, { dataDir: tmp, agentId: 'analista' }), (e) => e instanceof AgentError && /Agente creativo/.test(e.message));
    assert.deepEqual((await runCommand('proposals', { status: 'pending' }, { dataDir: tmp, agentId: 'creativo' })).proposals, []);

    const ok = async () => ({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' });
    const no = async () => ({ code: 1, stdout: '', stderr: 'Not logged in' });
    const env = { PATH: '', CODEX_HOME: 'C:/orca/home' };
    const settings = { codexHome: '', codexPath: process.execPath };
    // process.execPath is an existing file, so Codex counts as found; the fake runner answers the login check.
    assert.deepEqual(await codexStatus(settings, { env, runFn: ok }), { found: true, loggedIn: true, codexHome: 'C:/orca/home', message: 'Codex está listo y usa tu plan de ChatGPT.' });
    const out = await codexStatus(settings, { env, runFn: no });
    assert.equal(out.loggedIn, false);
    assert.match(out.message, /codex login/);
    assert.equal((await codexStatus({ codexHome: 'D:/mine', codexPath: '' }, { env: { PATH: '' }, runFn: ok })).codexHome, 'D:/mine');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
