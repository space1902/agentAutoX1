import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addProfile,
  askForCount,
  describeProfileList,
  describeSelection,
  hasSavedSession,
  loadProfiles,
  parseCount,
  parsePerfilArgs,
  profileGroupName,
  setProfileGroup,
  parseRunArgs,
  pickFirst,
  removeProfile,
  resolveProfile,
  saveProfiles,
  selectTesters,
  splitByCreds,
  testerIds,
} from './session-selection.js';

const TESTERS = ['tester1', { id: 'tester2', audioChance: 0.5 }, 'tester3', 'tester4', 'tester5'];

test('testerIds reads ids from strings and objects and skips invalid entries', () => {
  assert.deepEqual(testerIds(TESTERS), ['tester1', 'tester2', 'tester3', 'tester4', 'tester5']);
  assert.deepEqual(testerIds(['a', null, {}, { id: 'b' }, '']), ['a', 'b']);
  assert.deepEqual(testerIds(undefined), []);
});

test('parseCount accepts integers inside 1..max and rejects everything else in Spanish', () => {
  assert.equal(parseCount('3', 5), 3);
  assert.equal(parseCount(' 5 ', 5), 5);
  assert.equal(parseCount(1, 5), 1);
  for (const bad of ['0', '6', '-1', '2.5', 'tres', '', null, undefined, 'NaN']) {
    assert.throws(() => parseCount(bad, 5), /entre 1 y 5/, `value ${bad}`);
  }
});

test('pickFirst keeps config order and returns entries as configured', () => {
  assert.deepEqual(pickFirst(TESTERS, 2), ['tester1', { id: 'tester2', audioChance: 0.5 }]);
  assert.equal(pickFirst(TESTERS, 5).length, 5);
});

test('selectTesters returns the configured entries in the requested order', () => {
  const picked = selectTesters(TESTERS, ['tester3', 'tester2']);
  assert.deepEqual(picked, ['tester3', { id: 'tester2', audioChance: 0.5 }]);
});

test('selectTesters rejects unknown, repeated and empty selections', () => {
  assert.throws(() => selectTesters(TESTERS, ['tester1', 'tester9']), /tester9/);
  assert.throws(() => selectTesters(TESTERS, ['tester1', 'tester1']), /repetidos.*tester1/);
  assert.throws(() => selectTesters(TESTERS, []), /al menos un tester/);
});

test('parseRunArgs reads --count, -n and --count=N and ignores other flags', () => {
  assert.deepEqual(parseRunArgs(['--continuous', '--count', '3']), { count: '3', group: null });
  assert.deepEqual(parseRunArgs(['-n', '7']), { count: '7', group: null });
  assert.deepEqual(parseRunArgs(['--count=4']), { count: '4', group: null });
  assert.deepEqual(parseRunArgs(['--continuous']), { count: null, group: null });
  assert.deepEqual(parseRunArgs(['--count']), { count: '', group: null });
  assert.equal(parseRunArgs(['--group', 'Mi grupo']).group, 'Mi grupo');
  assert.equal(parseRunArgs(['--group=Otro grupo', '--continuous']).group, 'Otro grupo');
});

test('parsePerfilArgs understands the subcommands and the bare profile name', () => {
  assert.deepEqual(parsePerfilArgs(['crear', 'prueba 1']), {
    command: 'crear', name: 'prueba 1', group: null, count: null, testers: null, force: false,
  });
  assert.deepEqual(parsePerfilArgs(['prueba 1']), {
    command: 'usar', name: 'prueba 1', group: null, count: null, testers: null, force: false,
  });
  assert.equal(parsePerfilArgs(['usar', 'x']).command, 'usar');
  assert.equal(parsePerfilArgs(['lista']).command, 'lista');
  assert.equal(parsePerfilArgs(['borrar', 'x']).command, 'borrar');
  assert.equal(parsePerfilArgs([]).command, 'ayuda');
});

test('parsePerfilArgs reads --count/-n, --testers and --force', () => {
  const parsed = parsePerfilArgs(['crear', 'p', '--count', '3', '--force']);
  assert.equal(parsed.count, '3');
  assert.equal(parsed.force, true);
  assert.equal(parsePerfilArgs(['crear', 'p', '-n', '2']).count, '2');
  assert.deepEqual(parsePerfilArgs(['crear', 'p', '--testers', 'tester4, tester5']).testers, ['tester4', 'tester5']);
});

test('splitByCreds separates linked sessions from the ones that still need a QR', () => {
  const linked = new Set(['tester1', 'tester3']);
  assert.deepEqual(splitByCreds(['tester1', 'tester2', 'tester3'], (id) => linked.has(id)), {
    linked: ['tester1', 'tester3'],
    pending: ['tester2'],
  });
});

test('hasSavedSession needs a creds.json with a linked account', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-auth-'));
  try {
    fs.mkdirSync(path.join(root, 'ok'));
    fs.writeFileSync(path.join(root, 'ok', 'creds.json'), JSON.stringify({ me: { id: '57300@s.whatsapp.net' } }));
    fs.mkdirSync(path.join(root, 'unlinked'));
    fs.writeFileSync(path.join(root, 'unlinked', 'creds.json'), JSON.stringify({ registered: false }));
    fs.mkdirSync(path.join(root, 'broken'));
    fs.writeFileSync(path.join(root, 'broken', 'creds.json'), '{not json');

    assert.equal(hasSavedSession(root, 'ok'), true);
    assert.equal(hasSavedSession(root, 'unlinked'), false);
    assert.equal(hasSavedSession(root, 'broken'), false);
    assert.equal(hasSavedSession(root, 'missing'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('describeSelection tells which numbers are reused and which need a QR (tuteo)', () => {
  const lines = describeSelection(['tester1', 'tester2', 'tester3'], (id) => id === 'tester1');
  const text = lines.join('\n');
  assert.match(text, /3 número/);
  assert.match(text, /ya vinculados.*tester1/i);
  assert.match(text, /escanear.*tester2, tester3/i);
  assert.doesNotMatch(text, /\b(vos|escaneá|tenés|querés)\b/i);

  const allLinked = describeSelection(['tester1'], () => true).join('\n');
  assert.match(allLinked, /no hace falta escanear/i);
});

test('addProfile stores the profile and refuses to overwrite without force', () => {
  const now = new Date('2026-10-24T10:00:00Z');
  const profiles = addProfile({}, 'prueba 1', ['tester1', 'tester2'], { now });
  assert.deepEqual(profiles, {
    'prueba 1': { testers: ['tester1', 'tester2'], createdAt: '2026-10-24T10:00:00.000Z' },
  });

  assert.throws(() => addProfile(profiles, 'prueba 1', ['tester1'], { now }), /ya existe.*--force/);
  const forced = addProfile(profiles, ' prueba 1 ', ['tester3'], { now, force: true });
  assert.deepEqual(forced['prueba 1'].testers, ['tester3']);
  assert.deepEqual(profiles['prueba 1'].testers, ['tester1', 'tester2'], 'input is not mutated');
});

test('addProfile rejects empty names and names that clash with a command', () => {
  assert.throws(() => addProfile({}, '   ', ['tester1']), /nombre del perfil/);
  assert.throws(() => addProfile({}, 'lista', ['tester1']), /reservado/);
  assert.throws(() => addProfile({}, 'crear', ['tester1']), /reservado/);
});

test('resolveProfile returns the tester entries and explains missing profiles or testers', () => {
  const profiles = { 'prueba 1': { testers: ['tester1', 'tester3'] }, viejo: { testers: ['tester99'] } };
  assert.deepEqual(resolveProfile(profiles, 'prueba 1', TESTERS), ['tester1', 'tester3']);
  assert.throws(() => resolveProfile(profiles, 'nada', TESTERS), /No existe el perfil "nada".*prueba 1, viejo/);
  assert.throws(() => resolveProfile({}, 'nada', TESTERS), /No tienes perfiles/);
  assert.throws(() => resolveProfile(profiles, 'viejo', TESTERS), /tester99/);
});

test('removeProfile deletes only the profile and fails when it does not exist', () => {
  const profiles = { a: { testers: ['tester1'] }, b: { testers: ['tester2'] } };
  assert.deepEqual(Object.keys(removeProfile(profiles, 'a')), ['b']);
  assert.deepEqual(Object.keys(profiles), ['a', 'b']);
  assert.throws(() => removeProfile(profiles, 'zzz'), /No existe el perfil "zzz"/);
});

test('describeProfileList shows each tester as linked or pending', () => {
  const profiles = { 'prueba 1': { testers: ['tester1', 'tester2'], createdAt: '2026-10-24T10:00:00.000Z' } };
  const text = describeProfileList(profiles, (id) => id === 'tester1').join('\n');
  assert.match(text, /prueba 1/);
  assert.match(text, /tester1.*vinculado/);
  assert.match(text, /tester2.*pendiente de QR/);
  assert.match(describeProfileList({}, () => false).join('\n'), /No tienes perfiles/);
});

test('loadProfiles and saveProfiles round-trip a file and tolerate a missing or corrupt one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-profiles-'));
  const file = path.join(dir, 'profiles.json');
  try {
    assert.deepEqual(loadProfiles(file), {});
    saveProfiles(file, { a: { testers: ['tester1'], createdAt: 'x' } });
    assert.deepEqual(loadProfiles(file), { a: { testers: ['tester1'], createdAt: 'x' } });
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));

    fs.writeFileSync(file, '{broken');
    assert.throws(() => loadProfiles(file), /profiles\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('askForCount keeps asking until it gets a valid number', async () => {
  const answers = ['abc', '99', '3'];
  const asked = [];
  const count = await askForCount(async (question) => {
    asked.push(question);
    return answers.shift();
  }, 5, (line) => asked.push(line));

  assert.equal(count, 3);
  assert.match(asked[0], /¿Cuántos números de WhatsApp\?.*1.*5/);
  assert.equal(asked.filter((line) => /entre 1 y 5/.test(line)).length, 2);
});

test('parsePerfilArgs reads --group for crear and the grupo subcommand takes the name as third positional', () => {
  assert.equal(parsePerfilArgs(['crear', 'p', '--group', 'Mi grupo']).group, 'Mi grupo');
  const parsed = parsePerfilArgs(['grupo', 'cal mex4', 'Calentamiento 4']);
  assert.equal(parsed.command, 'grupo');
  assert.equal(parsed.name, 'cal mex4');
  assert.equal(parsed.group, 'Calentamiento 4');
  assert.equal(parsePerfilArgs(['grupo', 'cal mex4']).group, null);
});

test('addProfile stores a trimmed groupName only when given', () => {
  const now = new Date('2026-10-24T10:00:00Z');
  assert.equal('groupName' in addProfile({}, 'a', ['tester1'], { now })['a'], false);
  assert.equal(addProfile({}, 'a', ['tester1'], { now, groupName: '  Grupo A ' })['a'].groupName, 'Grupo A');
  assert.equal('groupName' in addProfile({}, 'a', ['tester1'], { now, groupName: '   ' })['a'], false);
});

test('"grupo" is a reserved profile name', () => {
  assert.throws(() => addProfile({}, 'grupo', ['tester1']), /reservado/);
});

test('setProfileGroup updates only the group of an existing profile and validates input', () => {
  const profiles = { a: { testers: ['tester1'], createdAt: 'x' }, b: { testers: ['tester2'] } };
  const updated = setProfileGroup(profiles, ' a ', ' Nuevo grupo ');
  assert.deepEqual(updated.a, { testers: ['tester1'], createdAt: 'x', groupName: 'Nuevo grupo' });
  assert.deepEqual(updated.b, profiles.b);
  assert.equal(profiles.a.groupName, undefined, 'input is not mutated');
  assert.throws(() => setProfileGroup(profiles, 'zzz', 'G'), /No existe el perfil "zzz"/);
  assert.throws(() => setProfileGroup(profiles, 'a', '  '), /nombre del grupo/);
});

test('profileGroupName falls back to config.groupName for profiles without a group', () => {
  assert.equal(profileGroupName({ groupName: ' Propio ' }, { groupName: 'Calentamiento' }), 'Propio');
  assert.equal(profileGroupName({ testers: [] }, { groupName: 'Calentamiento' }), 'Calentamiento');
  assert.equal(profileGroupName(undefined, { groupName: 'Calentamiento' }), 'Calentamiento');
  assert.equal(profileGroupName({}, {}), '');
});

test('describeProfileList shows the group of a profile when it has one', () => {
  const profiles = { a: { testers: ['tester1'], groupName: 'Mi grupo' }, b: { testers: ['tester2'] } };
  const lines = describeProfileList(profiles, () => true);
  assert.ok(lines.some((line) => /Mi grupo/.test(line)));
  assert.equal(lines.filter((line) => /grupo/i.test(line)).length, 1);
});
