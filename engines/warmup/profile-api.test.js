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
    botNumber: '573000000002',
    testers: ['tester1', { id: 'tester2', phone: '573000000001' }, { id: 'tester3', phone: '573001112233' }],
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
  { name: 'pod1', instanceId: 'Rvc64_1', state: 'running', phone: '3000000001' },
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
  assert.deepEqual(uno.testers, [
    {
      id: 'tester2',
      phone: '573000000001',
      phoneSource: 'config',
      sessionPhone: null,
      mismatch: false,
      duplicateOf: [],
      linked: true,
      podName: 'pod1',
    },
  ]);
  assert.equal(out.registry.rows.length, 3);
  assert.equal(out.botNumber, '573000000002');
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
  const out = runCommand('create', { name: 'dos', selections: [{ phone: '3000000001' }] }, t.ctx);
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
  assert.throws(attempt({ selections: [{ phone: '3000000002' }] }), /bot/i);
  assert.throws(attempt({ selections: [{ phone: '573000000002' }] }), /bot/i);
  assert.throws(attempt({ selections: [{ testerId: 'tester2' }, { phone: '3000000001' }] }), /repetid/i);
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

test('line-health scores every tester from the data dir (events, activity, csv) and marks unlinked ones', () => {
  const t = setup();
  const results = path.join(t.dir, 'results');
  fs.mkdirSync(results, { recursive: true });
  fs.writeFileSync(
    path.join(results, 'events.jsonl'),
    `${JSON.stringify({ at: '2026-10-20T10:00:00.000Z', session: 'tester2', event: 'ready' })}
`,
  );
  const sec = (iso) => new Date(iso).getTime() / 1000;
  fs.writeFileSync(
    path.join(results, 'activity-tester2.jsonl'),
    [
      { t: sec('2026-10-28T10:00:00.000Z'), me: 1, chat: 'g', type: 'chat', len: 5 },
      { t: sec('2026-10-28T10:05:00.000Z'), me: 0, chat: 'g', type: 'chat', len: 5 },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );
  const out = runCommand('line-health', {}, t.ctx);
  assert.deepEqual(Object.keys(out.lines).sort(), ['tester1', 'tester2', 'tester3']);
  assert.equal(out.lines.tester2.linked, true);
  assert.equal(out.lines.tester2.stats.sent, 1);
  assert.equal(out.lines.tester2.stats.received, 1);
  assert.equal(out.lines.tester2.stats.days, 9);
  assert.equal(out.lines.tester1.light, 'rojo');
  assert.equal(out.lines.tester1.linked, false);
  assert.equal(out.generatedAt, NOW.toISOString());
  t.cleanup();
});

test('line-health works with no results folder at all', () => {
  const t = setup();
  const out = runCommand('line-health', {}, t.ctx);
  assert.equal(out.lines.tester2.stats.sent, 0);
  assert.equal(out.lines.tester2.stats.days, 0);
  t.cleanup();
});

test('list shows the session phone, flags duplicates and mismatches, and never writes config.json', () => {
  const t = setup({
    config: {
      groupName: 'G',
      botNumber: '573000000002',
      testers: ['tester1', 'tester2', { id: 'tester3', phone: '573001112233' }],
    },
    profiles: { uno: { testers: ['tester1', 'tester2', 'tester3'] } },
  });
  const linkAs = (id, meId) => {
    fs.mkdirSync(path.join(t.dir, '.baileys_auth', id), { recursive: true });
    fs.writeFileSync(path.join(t.dir, '.baileys_auth', id, 'creds.json'), JSON.stringify({ me: { id: meId }, noiseKey: 'secret' }));
  };
  linkAs('tester1', '573162135114:12@s.whatsapp.net');
  linkAs('tester2', '573162135114:7@s.whatsapp.net');
  linkAs('tester3', '573009998877:3@s.whatsapp.net');
  const before = fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8');

  const out = runCommand('list', { pods }, t.ctx);
  const [a, b, c] = out.profiles[0].testers;
  assert.equal(a.phone, '573162135114');
  assert.equal(a.phoneSource, 'session');
  assert.deepEqual(a.duplicateOf, ['tester2']);
  assert.deepEqual(b.duplicateOf, ['tester1']);
  assert.equal(c.phone, '573001112233');
  assert.equal(c.mismatch, true);
  assert.equal(c.sessionPhone, '573009998877');
  assert.equal(out.registry.duplicates.length, 1);
  assert.equal(JSON.stringify(out).includes('secret'), false);
  assert.equal(fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8'), before);
  t.cleanup();
});

// ---- pause / resume / schedule status ----

const pauseFile = (t) => path.join(t.dir, 'warmup-pauses.json');
const eventsOf = (t) => {
  try {
    return fs
      .readFileSync(path.join(t.dir, 'results', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

test('pause-tester pauses one number from the app: persisted, logged, config untouched', () => {
  const t = setup();
  const before = fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8');

  const out = runCommand('pause-tester', { id: 'tester2' }, t.ctx);
  assert.equal(out.paused, true);

  const saved = JSON.parse(fs.readFileSync(pauseFile(t), 'utf8'));
  assert.equal(saved.paused.tester2.reason, 'manual');
  assert.equal(saved.paused.tester2.source, 'user');
  assert.equal(saved.paused.tester2.until, null);
  assert.equal(saved.paused.tester2.number, '573000000001');
  assert.equal(saved.paused.tester1, undefined, 'only the chosen number');

  const events = eventsOf(t);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'paused');
  assert.equal(events[0].session, 'tester2');
  assert.equal(fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8'), before);
  t.cleanup();
});

test('pause-tester accepts a duration in hours and rejects unknown numbers', () => {
  const t = setup();
  runCommand('pause-tester', { id: 'tester1', hours: 6 }, t.ctx);
  const entry = JSON.parse(fs.readFileSync(pauseFile(t), 'utf8')).paused.tester1;
  assert.equal(new Date(entry.until).getTime() - new Date(entry.since).getTime(), 6 * 3_600_000);

  assert.throws(() => runCommand('pause-tester', { id: 'nope' }, t.ctx), SelectionError);
  assert.throws(() => runCommand('pause-tester', {}, t.ctx), SelectionError);
  t.cleanup();
});

test('pause-tester clamps hours to 1..720 and ignores non-finite values', () => {
  const t = setup();
  const span = (id) => {
    const e = JSON.parse(fs.readFileSync(pauseFile(t), 'utf8')).paused[id];
    return e.until ? new Date(e.until).getTime() - new Date(e.since).getTime() : null;
  };
  runCommand('pause-tester', { id: 'tester1', hours: 1e12 }, t.ctx);
  assert.equal(span('tester1'), 720 * 3_600_000);
  runCommand('pause-tester', { id: 'tester2', hours: 0.01 }, t.ctx);
  assert.equal(span('tester2'), 3_600_000);
  runCommand('pause-tester', { id: 'tester3', hours: Infinity }, t.ctx);
  assert.equal(span('tester3'), null);
  t.cleanup();
});

test('pause-tester works for the bot session too', () => {
  const t = setup();
  runCommand('pause-tester', { id: 'bot' }, t.ctx);
  assert.ok(JSON.parse(fs.readFileSync(pauseFile(t), 'utf8')).paused.bot);
  t.cleanup();
});

test('resume-tester clears the pause, logs it and is harmless when nothing was paused', () => {
  const t = setup();
  runCommand('pause-tester', { id: 'tester2' }, t.ctx);
  const out = runCommand('resume-tester', { id: 'tester2' }, t.ctx);
  assert.equal(out.resumed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(pauseFile(t), 'utf8')).paused, {});
  assert.deepEqual(eventsOf(t).map((e) => e.event), ['paused', 'resumed']);

  assert.equal(runCommand('resume-tester', { id: 'tester2' }, t.ctx).resumed, false);
  assert.equal(eventsOf(t).length, 2);
  t.cleanup();
});

test('schedule-status: state, messages today and cap per number, plus the bot', () => {
  const t = setup();
  const results = path.join(t.dir, 'results');
  fs.mkdirSync(results, { recursive: true });
  const sec = (iso) => new Date(iso).getTime() / 1000;
  fs.writeFileSync(
    path.join(results, 'activity-tester2.jsonl'),
    [
      { t: sec('2026-10-28T04:00:00.000Z'), me: 1, chat: 'g', type: 'chat', len: 5 }, // 23:00 on the 27th in Bogota
      { t: sec('2026-10-28T13:00:00.000Z'), me: 1, chat: 'g', type: 'chat', len: 5 },
      { t: sec('2026-10-28T14:00:00.000Z'), me: 1, chat: 'g', type: 'chat', len: 5 },
      { t: sec('2026-10-28T14:30:00.000Z'), me: 0, chat: 'g', type: 'chat', len: 5 },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );

  const out = runCommand('schedule-status', {}, t.ctx);
  assert.deepEqual(Object.keys(out.sessions).sort(), ['bot', 'tester1', 'tester2', 'tester3']);
  assert.equal(out.sessions.tester2.count, 2, 'only today (local day), only what it sent');
  assert.equal(out.sessions.tester2.state, 'active');
  assert.ok(out.sessions.tester2.cap > 0);
  assert.equal(out.sessions.tester2.timezone, 'America/Bogota');
  assert.ok(out.sessions.tester2.window.endAt > out.sessions.tester2.window.startAt);
  assert.equal(out.sessions.tester2.pause, null);
  assert.equal(out.sessions.bot.cap === 150 || out.sessions.bot.cap === 45, true);
  assert.equal(out.enabled, true);
  t.cleanup();
});

test('schedule-status: outside the window and paused states', () => {
  const t = setup();
  const night = { ...t.ctx, now: new Date('2026-10-28T08:00:00.000Z') }; // 03:00 in Bogota
  assert.equal(runCommand('schedule-status', {}, night).sessions.tester1.state, 'outside_window');

  runCommand('pause-tester', { id: 'tester1' }, t.ctx);
  const status = runCommand('schedule-status', {}, t.ctx).sessions.tester1;
  assert.equal(status.state, 'paused');
  assert.equal(status.pause.reason, 'manual');
  assert.equal(status.pause.source, 'user');
  t.cleanup();
});

test('schedule-status: a per-entry timezone (Mexico) and a disabled schedule are honored', () => {
  const t = setup({
    config: {
      groupName: 'G',
      botNumber: '573000000002',
      schedule: { enabled: false },
      testers: ['tester1', { id: 'tester2', phone: '5215512345678', timezone: 'America/Mexico_City' }],
    },
    profiles: { uno: { testers: ['tester1'] } },
  });
  const out = runCommand('schedule-status', {}, { ...t.ctx, now: new Date('2026-10-28T08:00:00.000Z') });
  assert.equal(out.enabled, false);
  assert.equal(out.sessions.tester1.state, 'active', 'schedule off: never blocked');
  assert.equal(out.sessions.tester2.timezone, 'America/Mexico_City');
  t.cleanup();
});

test('schedule-status survives a corrupt pause file and reports a warning', () => {
  const t = setup();
  fs.writeFileSync(pauseFile(t), '{garbage');
  const out = runCommand('schedule-status', {}, t.ctx);
  assert.equal(out.sessions.tester1.pause, null);
  assert.ok(out.warnings.length >= 1);
  t.cleanup();
});

test('pause-tester and resume-tester fail loudly when the pause file cannot be saved', () => {
  const t = setup();
  fs.mkdirSync(pauseFile(t)); // a folder where the file should be: nothing can be saved
  assert.throws(() => runCommand('pause-tester', { id: 'tester1' }, t.ctx), (e) => e instanceof SelectionError && /No se pudo guardar/.test(e.message));
  assert.deepEqual(eventsOf(t), [], 'no paused event for a pause that did not happen');
  t.cleanup();
});

test('schedule-status: a fleet freeze (raw disconnects) does not lower the cap; a logout does', () => {
  const t = setup();
  const results = path.join(t.dir, 'results');
  fs.mkdirSync(results, { recursive: true });
  const old = '2026-10-01T10:00:00.000Z';
  const lines = [{ at: old, session: 'tester1', event: 'ready' }];
  for (let i = 0; i < 10; i++) lines.push({ at: '2026-10-27T10:00:00.000Z', session: 'tester1', event: 'disconnected', detail: '408' });
  lines.push({ at: old, session: 'tester2', event: 'ready' });
  lines.push({ at: '2026-10-27T10:00:00.000Z', session: 'tester2', event: 'disconnected', detail: 'LOGOUT' });
  fs.writeFileSync(path.join(results, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join(String.fromCharCode(10)) + String.fromCharCode(10));
  const out = runCommand('schedule-status', {}, t.ctx).sessions;
  assert.equal(out.tester1.cap === 150 || out.tester1.cap === 45, true, 'old number, no real incident: 150 (45 on a low day)');
  assert.equal(out.tester2.cap === 80 || out.tester2.cap === 24, true, 'one real incident: one level down');
  t.cleanup();
});
