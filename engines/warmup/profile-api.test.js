import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backupFile, runCommand } from './profile-api.js';
import { SelectionError } from './session-selection.js';

const NOW = new Date('2026-10-28T15:04:05.123Z');

function setup({ config, profiles } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentautox1-api-'));
  const base = config ?? {
    groupName: 'Calentamiento',
    botNumber: '573167585233',
    testers: ['tester1', { id: 'tester2', phone: '573042370764' }, { id: 'tester3', phone: '573001112233' }],
    testerPersonas: { tester1: 'Eres A.' },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(base));
  fs.writeFileSync(
    path.join(dir, 'profiles.json'),
    JSON.stringify(profiles ?? { uno: { testers: ['tester2'], createdAt: '2026-01-01T00:00:00.000Z', groupName: 'Grupo A' } }),
  );
  fs.mkdirSync(path.join(dir, '.baileys_auth', 'tester2'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.baileys_auth', 'tester2', 'creds.json'), JSON.stringify({ me: { id: '1:2@s.whatsapp.net' } }));
  const ctx = { dataDir: dir, now: NOW };
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  return { dir, ctx, read, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const pods = [
  { name: 'pod1', instanceId: 'Rvc64_1', state: 'running', phone: '3042370764' },
  { name: 'pod2', instanceId: 'Rvc64_2', state: 'stopped', phone: '3109998877' },
];

test('backupFile copies the file into backups/ with a timestamp and skips missing files', () => {
  const t = setup();
  const saved = backupFile(path.join(t.dir, 'config.json'), NOW);
  assert.ok(saved.includes(path.join(t.dir, 'backups')));
  assert.match(path.basename(saved), /^config\.20261028-150405-123\.json$/);
  assert.equal(fs.readFileSync(saved, 'utf8'), fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8'));
  assert.equal(backupFile(path.join(t.dir, 'nope.json'), NOW), null);
  t.cleanup();
});

test('list returns profiles with decorated testers and the registry', () => {
  const t = setup();
  const out = runCommand('list', { pods }, t.ctx);
  assert.equal(out.defaultGroup, 'Calentamiento');
  const uno = out.profiles.find((p) => p.name === 'uno');
  assert.equal(uno.groupName, 'Grupo A');
  assert.deepEqual(uno.testers, [{ id: 'tester2', phone: '573042370764', linked: true, podName: 'pod1' }]);
  assert.equal(out.registry.rows.length, 3);
  assert.equal(out.botNumber, '573167585233');
  t.cleanup();
});

test('create resolves tester ids, pod numbers and external numbers, with backups', () => {
  const t = setup();
  const out = runCommand(
    'create',
    {
      name: 'dos',
      group: 'Mi grupo',
      pods,
      selections: [{ testerId: 'tester3' }, { phone: '3109998877' }, { phone: '+57 320 111 2233' }],
    },
    t.ctx,
  );
  assert.deepEqual(out.profile.testers, ['tester3', 'tester4', 'tester5']);
  assert.deepEqual(out.createdTesters, ['tester4', 'tester5']);
  const config = t.read('config.json');
  assert.deepEqual(config.testers.slice(-2), [
    { id: 'tester4', phone: '573109998877' },
    { id: 'tester5', phone: '573201112233' },
  ]);
  assert.equal(typeof config.testerPersonas.tester4, 'string');
  const profiles = t.read('profiles.json');
  assert.equal(profiles.dos.groupName, 'Mi grupo');
  assert.ok(profiles.uno, 'other profiles are kept');
  assert.equal(fs.readdirSync(path.join(t.dir, 'backups')).length, 2);
  assert.deepEqual(fs.readdirSync(t.dir).filter((f) => f.endsWith('.tmp')), []);
  t.cleanup();
});

test('create reuses an existing tester when the phone is already registered', () => {
  const t = setup();
  const out = runCommand('create', { name: 'dos', selections: [{ phone: '3042370764' }] }, t.ctx);
  assert.deepEqual(out.profile.testers, ['tester2']);
  assert.deepEqual(out.createdTesters, []);
  assert.equal(t.read('config.json').testers.length, 3);
  t.cleanup();
});

test('create defaults the group to config.groupName and allows numbers used by other profiles', () => {
  const t = setup();
  const out = runCommand('create', { name: 'dos', selections: [{ testerId: 'tester2' }] }, t.ctx);
  assert.equal(out.profile.groupName, 'Calentamiento');
  t.cleanup();
});

test('create rejects the bot number, duplicates, bad names and empty selections', () => {
  const t = setup();
  const attempt = (payload) => () => runCommand('create', { name: 'x', ...payload }, t.ctx);
  assert.throws(attempt({ selections: [{ phone: '3167585233' }] }), /bot/i);
  assert.throws(attempt({ selections: [{ phone: '573167585233' }] }), /bot/i);
  assert.throws(attempt({ selections: [{ testerId: 'tester2' }, { phone: '3042370764' }] }), /repetid/i);
  assert.throws(attempt({ selections: [] }), /al menos/i);
  assert.throws(attempt({ selections: [{ phone: '12' }] }), /válido/i);
  assert.throws(attempt({ selections: [{ testerId: 'nope' }] }), /no existe/i);
  assert.throws(attempt({ name: 'crear', selections: [{ testerId: 'tester2' }] }), /reservado/i);
  assert.throws(attempt({ name: 'uno', selections: [{ testerId: 'tester2' }] }), /ya existe/i);
  assert.throws(attempt({ name: '  ', selections: [{ testerId: 'tester2' }] }), SelectionError);
  // Nothing was written by the failed attempts.
  assert.equal(fs.existsSync(path.join(t.dir, 'backups')), false);
  assert.equal(t.read('config.json').testers.length, 3);
  t.cleanup();
});

test('create refuses a bot phone stored as config.bot.phone', () => {
  const t = setup({ config: { groupName: 'G', bot: { phone: '573000000001' }, testers: ['tester1'] } });
  assert.throws(() => runCommand('create', { name: 'x', selections: [{ phone: '3000000001' }] }, t.ctx), /bot/i);
  t.cleanup();
});

test('update renames, changes the group and replaces the numbers keeping createdAt', () => {
  const t = setup();
  const out = runCommand(
    'update',
    { name: 'uno', newName: 'uno-b', group: 'Otro', selections: [{ testerId: 'tester2' }, { testerId: 'tester3' }] },
    t.ctx,
  );
  assert.equal(out.profile.name, 'uno-b');
  const profiles = t.read('profiles.json');
  assert.equal(profiles.uno, undefined);
  assert.deepEqual(profiles['uno-b'].testers, ['tester2', 'tester3']);
  assert.equal(profiles['uno-b'].groupName, 'Otro');
  assert.equal(profiles['uno-b'].createdAt, '2026-01-01T00:00:00.000Z');
  t.cleanup();
});

test('update never removes testers or sessions when numbers are dropped', () => {
  const t = setup({ profiles: { uno: { testers: ['tester2', 'tester3'] } } });
  runCommand('update', { name: 'uno', selections: [{ testerId: 'tester2' }] }, t.ctx);
  assert.equal(t.read('config.json').testers.length, 3);
  assert.ok(fs.existsSync(path.join(t.dir, '.baileys_auth', 'tester2', 'creds.json')));
  t.cleanup();
});

test('update is blocked for the profile that is running', () => {
  const t = setup();
  assert.throws(() => runCommand('update', { name: 'uno', group: 'X', running: 'uno' }, t.ctx), /en curso/i);
  assert.throws(() => runCommand('delete', { name: 'uno', running: 'uno' }, t.ctx), /en curso/i);
  assert.throws(() => runCommand('set-group', { name: 'uno', group: 'X', running: 'uno' }, t.ctx), /en curso/i);
  assert.equal(t.read('profiles.json').uno.groupName, 'Grupo A');
  // Another profile running does not block this one.
  runCommand('set-group', { name: 'uno', group: 'X', running: 'otro' }, t.ctx);
  assert.equal(t.read('profiles.json').uno.groupName, 'X');
  t.cleanup();
});

test('update rejects renaming onto an existing profile and unknown profiles', () => {
  const t = setup({ profiles: { uno: { testers: ['tester2'] }, dos: { testers: ['tester3'] } } });
  assert.throws(() => runCommand('update', { name: 'uno', newName: 'dos' }, t.ctx), /ya existe/i);
  assert.throws(() => runCommand('update', { name: 'zzz', group: 'x' }, t.ctx), /No existe/);
  t.cleanup();
});

test('delete removes only the profile entry', () => {
  const t = setup();
  const before = fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8');
  runCommand('delete', { name: 'uno' }, t.ctx);
  assert.deepEqual(t.read('profiles.json'), {});
  assert.equal(fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(t.dir, '.baileys_auth', 'tester2', 'creds.json')));
  assert.equal(fs.readdirSync(path.join(t.dir, 'backups')).length, 1);
  t.cleanup();
});

test('registry command and unknown commands', () => {
  const t = setup();
  assert.equal(runCommand('registry', { pods }, t.ctx).rows.length, 3);
  assert.throws(() => runCommand('explode', {}, t.ctx), /Comando desconocido/);
  t.cleanup();
});
