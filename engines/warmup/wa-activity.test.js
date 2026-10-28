import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  activityRecord,
  appendActivity,
  parseActivity,
  readActivity,
} from './wa-activity.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-activity-'));

test('activityRecord keeps only metadata, never the message text', () => {
  const record = activityRecord({
    from: 'g@g.us',
    fromMe: true,
    body: 'secret text',
    type: 'chat',
    timestamp: 100,
  });
  assert.deepEqual(record, { t: 100, me: 1, chat: 'g@g.us', type: 'chat', len: 11 });
});

test('activityRecord skips status broadcasts and malformed messages', () => {
  assert.equal(activityRecord({ from: 'status@broadcast', timestamp: 1, type: 'chat' }), null);
  assert.equal(activityRecord(null), null);
  assert.equal(activityRecord({ from: 'g@g.us', type: 'chat' }), null);
});

test('parseActivity filters by window, tracks the earliest sent message and ignores bad lines', () => {
  const lines = [
    JSON.stringify({ t: 50, me: 1, chat: 'a', type: 'chat', len: 3 }),
    'not json',
    JSON.stringify({ t: 150, me: 0, chat: 'a', type: 'ptt', len: 0 }),
    JSON.stringify({ t: 200, me: 1, chat: 'b', type: 'chat', len: 40 }),
    '',
  ].join('\n');

  const result = parseActivity(lines, 100);
  assert.equal(result.earliestSent, 50);
  assert.equal(result.chatsSeen, 2);
  assert.deepEqual(result.messages, [
    { fromMe: false, timestamp: 150, chatId: 'a', bodyLength: 0, type: 'ptt' },
    { fromMe: true, timestamp: 200, chatId: 'b', bodyLength: 40, type: 'chat' },
  ]);
});

test('parseActivity on empty text returns an empty result', () => {
  assert.deepEqual(parseActivity('', 0), {
    messages: [],
    earliestSent: null,
    chatsSeen: 0,
    chatsSkipped: 0,
  });
});

test('appendActivity and readActivity round-trip through a per-session file', () => {
  const dir = tmpDir();
  try {
    appendActivity(dir, 'tester1', { t: 10, me: 1, chat: 'g@g.us', type: 'chat', len: 5 });
    appendActivity(dir, 'tester1', { t: 20, me: 0, chat: 'g@g.us', type: 'chat', len: 9 });
    appendActivity(dir, 'tester2', { t: 30, me: 0, chat: 'g@g.us', type: 'chat', len: 1 });

    const one = readActivity(dir, 'tester1', 0);
    assert.equal(one.messages.length, 2);
    assert.equal(one.earliestSent, 10);
    assert.equal(readActivity(dir, 'tester2', 0).messages.length, 1);
    assert.equal(readActivity(dir, 'nobody', 0).messages.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendActivity never throws, even when the folder cannot be created', () => {
  const dir = tmpDir();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  try {
    assert.doesNotThrow(() =>
      appendActivity(path.join(blocker, 'sub'), 's', { t: 1, me: 0, chat: 'c', type: 'chat', len: 0 }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
