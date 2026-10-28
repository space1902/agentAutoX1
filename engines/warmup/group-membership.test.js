import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureTestersInGroup } from './group-membership.js';

const GROUP = '120363000000000000@g.us';

function fakeBot({ phones = [], lids = [], addStatus = {}, invite = 'CODE', inviteError = null, membersError = null } = {}) {
  const calls = [];
  return {
    calls,
    async groupMembers(jid) {
      calls.push(['members', jid]);
      if (membersError) throw membersError;
      return { phones, lids };
    },
    async addToGroup(jid, digits) {
      calls.push(['add', jid, digits]);
      const status = addStatus[digits[0]] ?? '200';
      if (status instanceof Error) throw status;
      return [{ jid: `${digits[0]}@s.whatsapp.net`, status }];
    },
    async inviteCode(jid) {
      calls.push(['invite', jid]);
      if (inviteError) throw inviteError;
      return invite;
    },
  };
}

function tester(id, user, { lid, joinError = null } = {}) {
  const joins = [];
  return {
    id,
    joins,
    client: {
      info: user ? { wid: { user, ...(lid ? { lid } : {}) } } : null,
      async joinByInvite(code) {
        joins.push(code);
        if (joinError) throw joinError;
        return GROUP;
      },
    },
  };
}

function run(bot, sessions) {
  const logs = [];
  const warnings = [];
  const promise = ensureTestersInGroup({
    botClient: bot,
    groupId: GROUP,
    groupName: 'Cal Mex4',
    sessions,
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
    pause: async () => {},
  });
  return promise.then((result) => ({ ...result, logs, warnings }));
}

test('testers already in the group (by phone) are left alone', async () => {
  const bot = fakeBot({ phones: ['573001110001', '573001110002'] });
  const sessions = [tester('tester15', '573001110001'), tester('tester16', '573001110002')];
  const result = await run(bot, sessions);
  assert.deepEqual(result.ready.map((s) => s.id), ['tester15', 'tester16']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(bot.calls.map((c) => c[0]), ['members']);
});

test('a tester known only by its lid counts as a member', async () => {
  const bot = fakeBot({ lids: ['998877'] });
  const result = await run(bot, [tester('tester15', '573001110001', { lid: '998877' })]);
  assert.equal(result.ready.length, 1);
  assert.equal(bot.calls.some((c) => c[0] === 'add'), false);
});

test('a missing tester is added by the bot and one line is logged', async () => {
  const bot = fakeBot({ phones: ['573001110001'] });
  const missing = tester('tester16', '573001110002');
  const result = await run(bot, [tester('tester15', '573001110001'), missing]);
  assert.deepEqual(bot.calls.filter((c) => c[0] === 'add'), [['add', GROUP, ['573001110002']]]);
  assert.deepEqual(result.ready.map((s) => s.id), ['tester15', 'tester16']);
  assert.equal(result.logs.length, 1);
  assert.match(result.logs[0], /\[tester16\] added to "Cal Mex4"/);
  assert.deepEqual(missing.joins, []);
});

test('when membership cannot be determined the tester is added; 409 (already a member) counts as success', async () => {
  const bot = fakeBot({ addStatus: { 573001110001: '409' } });
  const result = await run(bot, [tester('tester15', '573001110001')]);
  assert.equal(result.ready.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(bot.calls.some((c) => c[0] === 'invite'), false);
});

test('a refused add (403) falls back to the invite link joined by the tester', async () => {
  const bot = fakeBot({ addStatus: { 573001110001: '403' }, invite: 'ABC123' });
  const member = tester('tester15', '573001110001');
  const result = await run(bot, [member]);
  assert.deepEqual(member.joins, ['ABC123']);
  assert.deepEqual(result.ready.map((s) => s.id), ['tester15']);
  assert.match(result.logs[0], /\[tester15\] joined "Cal Mex4" with the invite link/);
  assert.equal(result.warnings.length, 0);
});

test('an add that throws also falls back to the invite link', async () => {
  const bot = fakeBot({ addStatus: { 573001110001: new Error('not-authorized') } });
  const member = tester('tester15', '573001110001');
  const result = await run(bot, [member]);
  assert.equal(member.joins.length, 1);
  assert.equal(result.ready.length, 1);
});

test('when the invite fallback fails too, the tester is skipped with a clear warning', async () => {
  const bot = fakeBot({ addStatus: { 573001110001: '408' } });
  const stuck = tester('tester15', '573001110001', { joinError: new Error('forbidden') });
  const fine = tester('tester16', '573001110002');
  const result = await run(bot, [stuck, fine]);
  assert.deepEqual(result.ready.map((s) => s.id), ['tester16']);
  assert.deepEqual(result.skipped.map((s) => s.id), ['tester15']);
  assert.equal(result.warnings.length, 1);
  assert.equal(
    result.warnings[0],
    '[tester15] is not in "Cal Mex4" and could not be added automatically. ' +
      'Add +573001110001 to the group from the admin phone.',
  );
});

test('a failing invite code request (bot is not admin) skips the tester', async () => {
  const bot = fakeBot({ addStatus: { 573001110001: '403' }, inviteError: new Error('not-authorized') });
  const result = await run(bot, [tester('tester15', '573001110001')]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.warnings[0], /Add \+573001110001/);
});

test('a session without a known number is skipped', async () => {
  const bot = fakeBot({});
  const result = await run(bot, [tester('tester15', null)]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.warnings[0], /\[tester15\].*number/);
  assert.equal(bot.calls.some((c) => c[0] === 'add'), false);
});

test('if the member list cannot be read, every tester is tried', async () => {
  const bot = fakeBot({ membersError: new Error('boom') });
  const result = await run(bot, [tester('tester15', '573001110001')]);
  assert.equal(result.ready.length, 1);
  assert.ok(bot.calls.some((c) => c[0] === 'add'));
  assert.ok(result.warnings.some((w) => /could not read the members/.test(w)));
});
