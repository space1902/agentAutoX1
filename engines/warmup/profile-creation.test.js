import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_NUMBERS,
  PERSONA_POOL,
  buildUpdatedConfig,
  chooseIds,
  collectProfile,
  normalizePhone,
  phoneProblem,
  writeJsonAtomic,
} from './profile-creation.js';

const config = (extra = {}) => ({
  botNumber: '573167585233',
  testers: ['tester1', 'tester2', { id: 'tester3', proxy: 'http://p:1' }, 'tester4'],
  testerPersonas: { tester1: 'Eres una persona A.', tester2: 'Eres una persona B.' },
  rounds: 3,
  ...extra,
});

test('normalizePhone strips symbols and adds 57 to local mobile numbers', () => {
  assert.equal(normalizePhone('300 123 4567'), '573001234567');
  assert.equal(normalizePhone('+57 (300) 123-4567'), '573001234567');
  assert.equal(normalizePhone('573001234567'), '573001234567');
  assert.equal(normalizePhone('14155550123'), '14155550123');
});

test('normalizePhone rejects numbers outside 11-15 digits', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('2001234567'), null); // 10 digits not starting with 3
  assert.equal(normalizePhone('1234567890123456'), null);
});

test('phoneProblem flags numbers used by another tester or by the bot', () => {
  const ctx = { taken: new Set(['573001234567']), botNumbers: ['573167585233'] };
  assert.match(phoneProblem('573001234567', ctx), /otro/);
  assert.match(phoneProblem('573167585233', ctx), /bot/);
  assert.equal(phoneProblem('573009998888', ctx), null);
});

test('chooseIds takes free ids in config order and skips ids of other profiles', () => {
  const profiles = { a: { testers: ['tester1', 'tester3'] } };
  assert.deepEqual(chooseIds(config().testers, profiles, 2), { ids: ['tester2', 'tester4'], created: [] });
});

test('chooseIds ignores the profile being replaced', () => {
  const profiles = { a: { testers: ['tester1', 'tester2'] } };
  assert.deepEqual(chooseIds(config().testers, profiles, 2, { replacing: 'a' }).ids, ['tester1', 'tester2']);
});

test('chooseIds creates new ids continuing the numbering when there are not enough free ones', () => {
  const profiles = { a: { testers: ['tester1', 'tester2', 'tester3'] }, b: { testers: ['tester20'] } };
  const result = chooseIds(config().testers, profiles, 3);
  assert.deepEqual(result, { ids: ['tester4', 'tester21', 'tester22'], created: ['tester21', 'tester22'] });
});

test('buildUpdatedConfig writes phones as objects, keeps proxy and other keys, adds new testers and personas', () => {
  const original = config();
  const snapshot = structuredClone(original);
  const updated = buildUpdatedConfig(original, {
    ids: ['tester3', 'tester5'],
    created: ['tester5'],
    phones: { tester3: '573001234567', tester5: '573009998888' },
  });

  assert.deepEqual(original, snapshot, 'input is not mutated');
  assert.deepEqual(updated.testers[2], { id: 'tester3', proxy: 'http://p:1', phone: '573001234567' });
  assert.deepEqual(updated.testers[4], { id: 'tester5', phone: '573009998888' });
  assert.equal(updated.testers[0], 'tester1');
  assert.equal(updated.rounds, 3);
  assert.equal(typeof updated.testerPersonas.tester5, 'string');
  assert.equal(typeof updated.testerPersonas.tester3, 'string');
  assert.equal(updated.testerPersonas.tester1, 'Eres una persona A.');
});

test('buildUpdatedConfig gives different personas to different new testers', () => {
  const updated = buildUpdatedConfig(
    { testers: [], testerPersonas: {} },
    { ids: ['tester15', 'tester16', 'tester17'], created: ['tester15', 'tester16', 'tester17'], phones: {} },
  );
  const texts = Object.values(updated.testerPersonas);
  assert.equal(new Set(texts).size, 3);
  assert.ok(PERSONA_POOL.length >= 10);
  for (const text of PERSONA_POOL) assert.doesNotMatch(text, /\bvos\b|tenés|querés/);
});

function scripted(answers) {
  const queue = [...answers];
  const asked = [];
  const printed = [];
  return {
    asked,
    printed,
    ask: async (question) => {
      asked.push(question);
      assert.ok(queue.length, `unexpected question: ${question}`);
      return queue.shift();
    },
    print: (line) => printed.push(line),
  };
}

test('collectProfile asks only for unlinked numbers and re-asks on invalid or duplicated input', async () => {
  const io = scripted(['2', 'hola', '573167585233', '3001234567', 'G']);
  const result = await collectProfile({
    ...io,
    config: config(),
    profiles: { otro: { testers: ['tester1'] } },
    name: 'nuevo',
    hasSession: (id) => id === 'tester2',
  });

  assert.deepEqual(result.ids, ['tester2', 'tester3']);
  assert.deepEqual(result.phones, { tester3: '573001234567' });
  assert.deepEqual(result.unlinked, ['tester3']);
  assert.ok(io.printed.some((line) => /tester2 ya está vinculado/.test(line)));
  assert.ok(io.asked.some((q) => q.includes('Número de WhatsApp para tester3 (ej. 3001234567)')));
  assert.equal(io.asked.filter((q) => q.includes('tester3')).length, 3);
  assert.deepEqual(result.profiles.nuevo.testers, ['tester2', 'tester3']);
  assert.deepEqual(result.config.testers[2], { id: 'tester3', proxy: 'http://p:1', phone: '573001234567' });
});

test('collectProfile rejects a phone already used by another tester', async () => {
  const cfg = config({ testers: ['tester1', { id: 'tester2', phone: '573001112222' }, 'tester3'] });
  const io = scripted(['1', '3001112222', '3005556666', 'G']);
  const result = await collectProfile({ ...io, config: cfg, profiles: {}, name: 'x', hasSession: () => false });
  assert.deepEqual(result.ids, ['tester1']);
  assert.equal(result.phones.tester1, '573005556666');
  assert.ok(io.printed.length >= 1);
});

test('collectProfile asks before replacing an existing profile and cancels on no', async () => {
  const io = scripted(['n']);
  const result = await collectProfile({
    ...io,
    config: config(),
    profiles: { x: { testers: ['tester1'] } },
    name: 'x',
    hasSession: () => true,
  });
  assert.equal(result, null);
  assert.match(io.asked[0], /El perfil "x" ya existe, ¿reemplazarlo\? \(s\/n\)/);
});

test('collectProfile with a preset count, force and all sessions linked asks nothing', async () => {
  const io = scripted([]);
  const result = await collectProfile({
    ...io,
    config: config(),
    profiles: { x: { testers: ['tester1'] } },
    name: 'x',
    count: '2',
    force: true,
    group: 'Grupo fijo',
    hasSession: () => true,
  });
  assert.deepEqual(result.ids, ['tester1', 'tester2']);
  assert.deepEqual(result.unlinked, []);
});

test('collectProfile caps the count at MAX_NUMBERS', async () => {
  const io = scripted(['999', '1', 'G']);
  const result = await collectProfile({ ...io, config: config(), profiles: {}, name: 'x', hasSession: () => true });
  assert.equal(result.ids.length, 1);
  assert.ok(io.printed.some((line) => line.includes(String(MAX_NUMBERS))));
});

test('writeJsonAtomic writes 2-space JSON and leaves no temp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  try {
    const file = path.join(dir, 'config.json');
    writeJsonAtomic(file, { a: 1 });
    assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 1\n}\n');
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectProfile asks for the group name and Enter keeps config.groupName', async () => {
  const io = scripted(['1', '']);
  const result = await collectProfile({
    ...io,
    config: config({ groupName: 'Calentamiento' }),
    profiles: {},
    name: 'nuevo',
    hasSession: () => true,
  });
  assert.ok(io.asked.at(-1).includes('Nombre del grupo de WhatsApp para este perfil (Enter = "Calentamiento")'));
  assert.equal(result.profiles.nuevo.groupName, 'Calentamiento');
});

test('collectProfile stores the typed group name, trimmed', async () => {
  const io = scripted(['1', '  Mi grupo mex4 ']);
  const result = await collectProfile({
    ...io,
    config: config({ groupName: 'Calentamiento' }),
    profiles: {},
    name: 'nuevo',
    hasSession: () => true,
  });
  assert.equal(result.profiles.nuevo.groupName, 'Mi grupo mex4');
});

test('collectProfile asks the group after the phone numbers', async () => {
  const io = scripted(['1', '3001234567', 'G']);
  await collectProfile({ ...io, config: config(), profiles: {}, name: 'x', hasSession: () => false });
  const phoneAt = io.asked.findIndex((q) => q.includes('Número de WhatsApp para'));
  const groupAt = io.asked.findIndex((q) => q.includes('Nombre del grupo'));
  assert.ok(phoneAt >= 0 && groupAt > phoneAt);
});

test('collectProfile re-asks when there is no default group and the answer is empty', async () => {
  const io = scripted(['1', '', 'Grupo X']);
  const result = await collectProfile({ ...io, config: config(), profiles: {}, name: 'x', hasSession: () => true });
  assert.equal(result.profiles.x.groupName, 'Grupo X');
  assert.ok(io.asked.at(-2).includes('Nombre del grupo de WhatsApp para este perfil:'));
});

test('collectProfile with a preset group (--group) does not ask for it', async () => {
  const io = scripted(['1']);
  const result = await collectProfile({
    ...io, config: config(), profiles: {}, name: 'x', group: 'Preset', hasSession: () => true,
  });
  assert.equal(result.profiles.x.groupName, 'Preset');
  assert.ok(io.asked.every((q) => !q.includes('Nombre del grupo')));
});
