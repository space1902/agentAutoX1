import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLineHealth, scoreLine } from './line-health.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const healthy = {
  linked: true,
  days: 14,
  sent: 40,
  received: 40,
  lastActivityAt: hoursAgo(2),
  disconnected: 0,
  relinks: 0,
  authFailures: 0,
  severeRecent: false,
};

const part = (result, key) => result.components.find((c) => c.key === key);

test('a mature, active, stable line scores 100 and is green', () => {
  const r = scoreLine(healthy, NOW);
  assert.equal(r.score, 100);
  assert.equal(r.light, 'verde');
  assert.equal(r.components.reduce((sum, c) => sum + c.max, 0), 100);
  assert.equal(r.phase.phase, 3);
});

test('an unlinked line is always 0 and red, whatever its history', () => {
  const r = scoreLine({ ...healthy, linked: false }, NOW);
  assert.equal(r.score, 0);
  assert.equal(r.light, 'rojo');
  assert.match(r.reasons.join(' '), /vincul/i);
});

test('age grows linearly up to 14 days (35 points)', () => {
  assert.equal(part(scoreLine({ ...healthy, days: 0 }, NOW), 'age').points, 0);
  assert.equal(part(scoreLine({ ...healthy, days: 7 }, NOW), 'age').points, 18);
  assert.equal(part(scoreLine({ ...healthy, days: 30 }, NOW), 'age').points, 35);
});

test('volume saturates at 60 messages in the window (20 points)', () => {
  assert.equal(part(scoreLine({ ...healthy, sent: 15, received: 15 }, NOW), 'volume').points, 10);
  assert.equal(part(scoreLine({ ...healthy, sent: 500, received: 500 }, NOW), 'volume').points, 20);
  assert.equal(part(scoreLine({ ...healthy, sent: 0, received: 0 }, NOW), 'volume').points, 0);
});

test('reciprocity rewards answered conversations and is 0 when nothing was sent', () => {
  assert.equal(part(scoreLine({ ...healthy, sent: 20, received: 10 }, NOW), 'reciprocity').points, 8);
  assert.equal(part(scoreLine({ ...healthy, sent: 20, received: 90 }, NOW), 'reciprocity').points, 15);
  assert.equal(part(scoreLine({ ...healthy, sent: 0, received: 12 }, NOW), 'reciprocity').points, 0);
});

test('stability loses 4 per disconnect (max 12), 10 per relink and 10 per auth failure', () => {
  const stability = (patch) => part(scoreLine({ ...healthy, ...patch }, NOW), 'stability').points;
  assert.equal(stability({ disconnected: 1 }), 16);
  assert.equal(stability({ disconnected: 9 }), 8);
  assert.equal(stability({ relinks: 1 }), 10);
  assert.equal(stability({ relinks: 1, authFailures: 1, disconnected: 5 }), 0);
});

test('recency: 24 h = 10, 72 h = 6, 7 days = 3, older or never = 0', () => {
  const recency = (lastActivityAt) => part(scoreLine({ ...healthy, lastActivityAt }, NOW), 'recency').points;
  assert.equal(recency(hoursAgo(23)), 10);
  assert.equal(recency(hoursAgo(48)), 6);
  assert.equal(recency(hoursAgo(100)), 3);
  assert.equal(recency(hoursAgo(300)), 0);
  assert.equal(recency(null), 0);
});

test('light thresholds: 70 green, 40 yellow, below red', () => {
  assert.equal(scoreLine({ ...healthy, days: 12, sent: 36, received: 36 }, NOW).light, 'verde');
  const mid = scoreLine({ ...healthy, days: 7, sent: 10, received: 10, lastActivityAt: hoursAgo(100) }, NOW);
  assert.ok(mid.score >= 40 && mid.score < 70, `score was ${mid.score}`);
  assert.equal(mid.light, 'amarillo');
  const fresh = scoreLine({ ...healthy, days: 1, sent: 2, received: 0, lastActivityAt: hoursAgo(100) }, NOW);
  assert.equal(fresh.light, 'rojo');
});

test('a recent logout or auth failure forces red even with a high score', () => {
  const r = scoreLine({ ...healthy, severeRecent: true }, NOW);
  assert.equal(r.light, 'rojo');
  assert.ok(r.score >= 70);
  assert.match(r.reasons.join(' '), /sesión|cierre|autenticación/i);
});

test('score is clamped to 0..100 and tolerates missing numbers', () => {
  const r = scoreLine({ linked: true }, NOW);
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(r.light, 'rojo');
});

// ---- buildLineHealth: wires raw data (events, activity, csv) into scoring -------------------------

const sec = (iso) => new Date(iso).getTime() / 1000;

test('buildLineHealth derives age, volume, incidents and last activity from raw data', () => {
  const events = [
    { at: '2026-10-10T10:00:00.000Z', session: 'tester1', event: 'ready' },
    { at: '2026-10-27T10:00:00.000Z', session: 'tester1', event: 'disconnected', detail: '408' },
    { at: '2026-10-20T10:00:00.000Z', session: 'tester1', event: 'disconnected', detail: '408' },
    { at: '2026-10-27T11:00:00.000Z', session: 'tester2', event: 'logged_out_relink' },
  ];
  const activity = {
    tester1: {
      messages: [
        { fromMe: true, timestamp: sec('2026-10-28T10:00:00.000Z'), chatId: 'g' },
        { fromMe: false, timestamp: sec('2026-10-28T09:00:00.000Z'), chatId: 'g' },
        { fromMe: true, timestamp: sec('2026-10-27T09:00:00.000Z'), chatId: 'g' },
      ],
      earliestSent: sec('2026-10-11T09:00:00.000Z'),
    },
  };
  const out = buildLineHealth({
    testerIds: ['tester1', 'tester2', 'tester3'],
    linkedOf: (id) => id !== 'tester3',
    events,
    activityOf: (id) => activity[id] ?? { messages: [], earliestSent: null },
    csvTexts: [],
    now: NOW,
  });

  const t1 = out.tester1;
  assert.equal(t1.linked, true);
  assert.equal(t1.stats.sent, 2);
  assert.equal(t1.stats.received, 1);
  assert.equal(t1.stats.disconnected, 2);
  assert.equal(t1.stats.days, 19); // first ready on 2026-10-10, day 1 = that day
  assert.equal(t1.stats.lastActivityAt, '2026-10-28T10:00:00.000Z');
  assert.equal(part(t1, 'recency').points, 10);

  // tester2 was logged out yesterday and has no activity: red with a severe reason.
  assert.equal(out.tester2.light, 'rojo');
  assert.equal(out.tester2.stats.relinks, 1);
  assert.equal(out.tester2.severeRecent, true);

  // tester3 is not linked.
  assert.equal(out.tester3.score, 0);
  assert.equal(out.tester3.linked, false);
});

test('buildLineHealth takes the earliest of ready event, csv row and sent message as day 1', () => {
  const header = '"timestamp","run","tester","target","text","ok"';
  const csv = `${header}\n"2026-10-01T08:00:00.000Z","1","tester1","t","hi","true"\n`;
  const out = buildLineHealth({
    testerIds: ['tester1'],
    linkedOf: () => true,
    events: [{ at: '2026-10-20T10:00:00.000Z', session: 'tester1', event: 'ready' }],
    activityOf: () => ({ messages: [], earliestSent: sec('2026-10-15T10:00:00.000Z') }),
    csvTexts: [csv],
    now: NOW,
  });
  assert.equal(out.tester1.stats.firstActivityAt, '2026-10-01T08:00:00.000Z');
  assert.equal(out.tester1.stats.days, 28);
});
