import test from 'node:test';
import assert from 'node:assert/strict';

import { cachedGroupId, findGroup, resolveGroupId, withGroupId } from './lib.js';

const fakeClient = (groups) => ({ listGroups: async () => groups });

test('cachedGroupId reads groupIds by lowercased name and falls back to groupId for the default group', () => {
  const config = { groupName: 'Calentamiento', groupId: 'default@g.us', groupIds: { 'cal mex4': 'mex4@g.us' } };
  assert.equal(cachedGroupId(config, ' Cal MEX4 '), 'mex4@g.us');
  assert.equal(cachedGroupId(config, 'calentamiento'), 'default@g.us');
  assert.equal(cachedGroupId(config, 'Otro'), null);
  assert.equal(cachedGroupId({ groupName: 'X' }, 'X'), null);
});

test('withGroupId stores the id per group name and keeps groupId in sync for the default group', () => {
  const base = { groupName: 'Calentamiento', groupId: 'old@g.us', other: 1 };
  const custom = withGroupId(base, ' Cal Mex4 ', 'mex4@g.us');
  assert.deepEqual(custom, { ...base, groupIds: { 'cal mex4': 'mex4@g.us' } });
  assert.equal(base.groupIds, undefined, 'input is not mutated');

  const sameAsDefault = withGroupId(base, 'calentamiento', 'new@g.us');
  assert.equal(sameAsDefault.groupId, 'new@g.us');
  assert.equal(sameAsDefault.groupIds.calentamiento, 'new@g.us');
});

test('resolveGroupId returns the cached id of the requested group without listing chats', async () => {
  const client = { listGroups: async () => assert.fail('must not list chats') };
  const config = { groupName: 'Calentamiento', groupId: 'default@g.us', groupIds: { 'cal mex4': 'mex4@g.us' } };
  assert.equal(await resolveGroupId(client, config, { groupName: 'Cal mex4' }), 'mex4@g.us');
  assert.equal(await resolveGroupId(client, config), 'default@g.us');
});

test('resolveGroupId finds an uncached profile group by name and saves it per group name', async () => {
  const saved = [];
  const client = fakeClient([
    { id: 'default@g.us', name: 'Calentamiento' },
    { id: 'mex4@g.us', name: 'Cal Mex4' },
  ]);
  const id = await resolveGroupId(client, { groupName: 'Calentamiento', groupId: 'default@g.us' }, {
    groupName: 'cal mex4',
    save: (name, groupId) => saved.push([name, groupId]),
  });
  assert.equal(id, 'mex4@g.us');
  assert.deepEqual(saved, [['cal mex4', 'mex4@g.us']]);
});

test('findGroup error names the wanted group and lists the visible ones', async () => {
  await assert.rejects(
    findGroup(fakeClient([{ id: 'a@g.us', name: 'Otro' }]), 'Cal Mex4'),
    (error) => /Group "Cal Mex4" not found/.test(error.message) && /- Otro/.test(error.message),
  );
});

test('resolveGroupId rethrows the not-found error naming the profile group', async () => {
  await assert.rejects(
    resolveGroupId(fakeClient([]), { groupName: 'Calentamiento' }, { groupName: 'Cal Mex4', save: () => {} }),
    /Group "Cal Mex4" not found/,
  );
});
