import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRegistry, phoneKey } from './registry.js';

const config = {
  groupName: 'Calentamiento',
  botNumber: '573000000002',
  testers: ['tester1', { id: 'tester2', phone: '573000000001' }, { id: 'tester3', phone: '573001112233' }],
};
const profiles = {
  uno: { testers: ['tester2'], groupName: 'Grupo A' },
  dos: { testers: ['tester2', 'tester3'] },
};
const pods = [
  { name: 'pod1', instanceId: 'Rvc64_1', state: 'running', phone: '3000000001' },
  { name: 'pod2', instanceId: 'Rvc64_2', state: 'stopped', phone: '3109998877' },
  { name: 'pod3', instanceId: 'Rvc64_3', state: 'stopped', phone: null },
];
const hasSession = (id) => id === 'tester2';

test('phoneKey treats 57XXXXXXXXXX and XXXXXXXXXX as the same line', () => {
  assert.equal(phoneKey('573000000001'), '3000000001');
  assert.equal(phoneKey('300 000 0001'), '3000000001');
  assert.equal(phoneKey('+57 300 000 0001'), '3000000001');
  assert.equal(phoneKey('14155550123'), '14155550123');
  assert.equal(phoneKey('abc'), '');
  assert.equal(phoneKey(null), '');
});

test('merges pod, tester, session, profiles and groups into one row per phone', () => {
  const { rows } = buildRegistry({ config, profiles, pods, hasSession });
  const row = rows.find((r) => r.key === '3000000001');
  assert.equal(row.source, 'pod');
  assert.equal(row.pod.name, 'pod1');
  assert.equal(row.pod.state, 'running');
  assert.equal(row.testerId, 'tester2');
  assert.equal(row.linked, true);
  assert.deepEqual(row.profiles, ['uno', 'dos']);
  assert.deepEqual(row.groups, ['Grupo A', 'Calentamiento']);
});

test('a pod number without a tester is "pod sin calentar"; a tester without a pod is "externo"', () => {
  const { rows } = buildRegistry({ config, profiles, pods, hasSession });
  const cold = rows.find((r) => r.key === '3109998877');
  assert.equal(cold.source, 'pod sin calentar');
  assert.equal(cold.testerId, null);
  assert.equal(cold.linked, false);
  const ext = rows.find((r) => r.key === '3001112233');
  assert.equal(ext.source, 'externo');
  assert.equal(ext.pod, null);
  assert.equal(ext.testerId, 'tester3');
});

test('reports pods without phone and testers without phone separately', () => {
  const out = buildRegistry({ config, profiles, pods, hasSession });
  assert.deepEqual(out.podsWithoutPhone.map((p) => p.name), ['pod3']);
  assert.deepEqual(out.testersWithoutPhone, [
    { id: 'tester1', linked: false, profiles: [], groups: [] },
  ]);
  assert.equal(out.rows.length, 3);
});

test('flags the bot number', () => {
  const out = buildRegistry({
    config,
    profiles,
    pods: [...pods, { name: 'bot', instanceId: 'Rvc64_9', state: 'stopped', phone: '3000000002' }],
    hasSession,
  });
  const bot = out.rows.find((r) => r.key === '3000000002');
  assert.equal(bot.isBot, true);
  assert.equal(out.rows.filter((r) => r.isBot).length, 1);
});

test('marks tester as linked only with a session', () => {
  const { rows } = buildRegistry({ config, profiles, pods, hasSession: () => false });
  assert.ok(rows.every((r) => r.linked === false));
});

test('testers without a phone still report their session, profiles and groups', () => {
  const out = buildRegistry({
    config,
    profiles: { tres: { testers: ['tester1'] } },
    pods: [],
    hasSession: (id) => id === 'tester1',
  });
  assert.deepEqual(out.testersWithoutPhone[0], { id: 'tester1', linked: true, profiles: ['tres'], groups: ['Calentamiento'] });
});

test('a tester without a configured phone takes the one from its linked session', () => {
  const sessionPhones = { tester1: '573162135114' };
  const { rows, testers, testersWithoutPhone } = buildRegistry({
    config,
    profiles,
    pods,
    hasSession: () => true,
    sessionPhoneOf: (id) => sessionPhones[id] ?? null,
  });
  const row = rows.find((r) => r.key === '3162135114');
  assert.equal(row.testerId, 'tester1');
  assert.equal(row.phoneSource, 'session');
  assert.deepEqual(testers.tester1, {
    id: 'tester1',
    phone: '573162135114',
    configPhone: null,
    sessionPhone: '573162135114',
    phoneSource: 'session',
    linked: true,
    mismatch: false,
    duplicateOf: [],
  });
  assert.equal(testersWithoutPhone.some((t) => t.id === 'tester1'), false);
});

test('config phone wins over the session phone and a difference is flagged as mismatch', () => {
  const { testers } = buildRegistry({
    config,
    pods,
    sessionPhoneOf: (id) => (id === 'tester3' ? '573009998877' : id === 'tester2' ? '573000000001' : null),
  });
  assert.equal(testers.tester3.phone, '573001112233');
  assert.equal(testers.tester3.phoneSource, 'config');
  assert.equal(testers.tester3.sessionPhone, '573009998877');
  assert.equal(testers.tester3.mismatch, true);
  assert.equal(testers.tester2.mismatch, false); // 10 vs 12 digits is the same line
});

test('testers sharing a number are reported as duplicates of each other', () => {
  const sessionPhones = { tester1: '573162135114', tester2: '573162135114' };
  const dupConfig = { ...config, testers: ['tester1', 'tester2', { id: 'tester3', phone: '3162135114' }] };
  const { testers, duplicates, rows } = buildRegistry({
    config: dupConfig,
    sessionPhoneOf: (id) => sessionPhones[id] ?? null,
  });
  assert.deepEqual(testers.tester1.duplicateOf, ['tester2', 'tester3']);
  assert.deepEqual(testers.tester2.duplicateOf, ['tester1', 'tester3']);
  assert.deepEqual(duplicates, [{ key: '3162135114', phone: '573162135114', members: ['tester1', 'tester2', 'tester3'] }]);
  assert.deepEqual(rows.find((r) => r.key === '3162135114').duplicateOf, ['tester2', 'tester3']);
});

test('a tester using the bot number is a duplicate of the bot', () => {
  const botConfig = { botNumber: '573000000002', testers: [{ id: 'tester1', phone: '3000000002' }, 'tester2'] };
  const { testers, duplicates } = buildRegistry({ config: botConfig, sessionPhoneOf: () => null });
  assert.deepEqual(testers.tester1.duplicateOf, ['bot']);
  assert.deepEqual(duplicates[0].members, ['bot', 'tester1']);
  assert.deepEqual(testers.tester2.duplicateOf, []);
});

test('the bot session phone is used when the config has no bot number', () => {
  const botConfig = { testers: [{ id: 'tester1', phone: '3000000002' }] };
  const { testers } = buildRegistry({ config: botConfig, sessionPhoneOf: (id) => (id === 'bot' ? '573000000002' : null) });
  assert.deepEqual(testers.tester1.duplicateOf, ['bot']);
});

test('distinct numbers produce no duplicates', () => {
  const { duplicates } = buildRegistry({ config, pods, sessionPhoneOf: () => null });
  assert.deepEqual(duplicates, []);
});
