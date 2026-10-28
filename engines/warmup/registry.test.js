import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRegistry, phoneKey } from './registry.js';

const config = {
  groupName: 'Calentamiento',
  botNumber: '573167585233',
  testers: ['tester1', { id: 'tester2', phone: '573042370764' }, { id: 'tester3', phone: '573001112233' }],
};
const profiles = {
  uno: { testers: ['tester2'], groupName: 'Grupo A' },
  dos: { testers: ['tester2', 'tester3'] },
};
const pods = [
  { name: 'pod1', instanceId: 'Rvc64_1', state: 'running', phone: '3042370764' },
  { name: 'pod2', instanceId: 'Rvc64_2', state: 'stopped', phone: '3109998877' },
  { name: 'pod3', instanceId: 'Rvc64_3', state: 'stopped', phone: null },
];
const hasSession = (id) => id === 'tester2';

test('phoneKey treats 57XXXXXXXXXX and XXXXXXXXXX as the same line', () => {
  assert.equal(phoneKey('573042370764'), '3042370764');
  assert.equal(phoneKey('304 237 0764'), '3042370764');
  assert.equal(phoneKey('+57 304 237 0764'), '3042370764');
  assert.equal(phoneKey('14155550123'), '14155550123');
  assert.equal(phoneKey('abc'), '');
  assert.equal(phoneKey(null), '');
});

test('merges pod, tester, session, profiles and groups into one row per phone', () => {
  const { rows } = buildRegistry({ config, profiles, pods, hasSession });
  const row = rows.find((r) => r.key === '3042370764');
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
    pods: [...pods, { name: 'bot', instanceId: 'Rvc64_9', state: 'stopped', phone: '3167585233' }],
    hasSession,
  });
  const bot = out.rows.find((r) => r.key === '3167585233');
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
