import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accountFromRecentReport,
  aggregateByDay,
  bidirectionalRatio,
  classifyPhase,
  compareToPrevious,
  daysSince,
  earliestCsvDate,
  formatTrend,
  historyRows,
  loadHistory,
  localDateKey,
  parseCsv,
  readinessVerdict,
  richIncomingRatio,
  summarizeIncidents,
  trendForReport,
} from './health-metrics.js';

const at = (iso) => Math.floor(new Date(iso).getTime() / 1000);

test('classifyPhase maps account age to community phases', () => {
  assert.deepEqual(classifyPhase(1), { phase: 1, name: 'Fragile', min: 5, max: 10 });
  assert.equal(classifyPhase(3).phase, 1);
  assert.deepEqual(classifyPhase(4), { phase: 2, name: 'Growing', min: 15, max: 30 });
  assert.equal(classifyPhase(10).phase, 2);
  assert.equal(classifyPhase(11).phase, 3);
  assert.equal(classifyPhase(11).name, 'Stable');
  assert.equal(classifyPhase(40).max, Infinity);
  assert.equal(classifyPhase(0).phase, 1);
});

test('localDateKey formats a unix timestamp as a local YYYY-MM-DD', () => {
  const d = new Date(2026, 5, 7, 23, 30); // local time
  assert.equal(localDateKey(Math.floor(d.getTime() / 1000)), '2026-06-07');
});

test('aggregateByDay counts outgoing, incoming and distinct active chats', () => {
  const t1 = new Date(2026, 5, 7, 10).getTime() / 1000;
  const t2 = new Date(2026, 5, 7, 11).getTime() / 1000;
  const t3 = new Date(2026, 5, 8, 9).getTime() / 1000;
  const messages = [
    { fromMe: true, timestamp: t1, chatId: 'a', body: 'x', type: 'chat' },
    { fromMe: true, timestamp: t2, chatId: 'a', body: 'y', type: 'chat' },
    { fromMe: true, timestamp: t2, chatId: 'b', body: 'z', type: 'chat' },
    { fromMe: false, timestamp: t2, chatId: 'a', body: 'r', type: 'chat' },
    { fromMe: false, timestamp: t3, chatId: 'c', body: 'r', type: 'chat' },
  ];
  assert.deepEqual(aggregateByDay(messages), {
    '2026-06-07': { outgoing: 3, incoming: 1, activeChats: 2 },
    '2026-06-08': { outgoing: 0, incoming: 1, activeChats: 0 },
  });
});

test('bidirectionalRatio is the share of chats we wrote in where others also wrote', () => {
  const m = (fromMe, chatId) => ({ fromMe, chatId, timestamp: 1, body: '', type: 'chat' });
  const messages = [m(true, 'a'), m(false, 'a'), m(true, 'b'), m(true, 'c'), m(false, 'd')];
  assert.equal(bidirectionalRatio(messages), 1 / 3);
  assert.equal(bidirectionalRatio([m(false, 'x')]), null);
  assert.equal(bidirectionalRatio([]), null);
});

test('richIncomingRatio counts long bodies and voice notes among incoming messages', () => {
  const inc = (body, type = 'chat') => ({ fromMe: false, chatId: 'a', timestamp: 1, body, type });
  const messages = [
    inc('hi'),
    inc('x'.repeat(40)),
    inc('', 'ptt'),
    inc('', 'audio'),
    { fromMe: true, chatId: 'a', timestamp: 1, body: 'y'.repeat(100), type: 'chat' },
  ];
  assert.equal(richIncomingRatio(messages), 3 / 4);
  assert.equal(richIncomingRatio([]), null);
});

test('richIncomingRatio also accepts the logged body length instead of the body text', () => {
  const inc = (bodyLength, type = 'chat') => ({ fromMe: false, chatId: 'a', timestamp: 1, bodyLength, type });
  assert.equal(richIncomingRatio([inc(5), inc(40), inc(0, 'ptt'), inc(12)]), 2 / 4);
});

test('parseCsv handles quoted fields with commas, quotes and newlines', () => {
  const text = 'a,b,c\n"1","x, y","he said ""hi""\nbye"\n"2","","z"\n';
  assert.deepEqual(parseCsv(text), [
    ['a', 'b', 'c'],
    ['1', 'x, y', 'he said "hi"\nbye'],
    ['2', '', 'z'],
  ]);
});

test('earliestCsvDate returns the earliest timestamp for one tester only', () => {
  const header = 'timestamp,turn,tester,topic,sent,replied,latency_ms,reply_count,input_tokens,output_tokens,replies';
  const csvA = [
    header,
    '"2026-06-05T10:00:00.000Z","1","tester1","a, b","hi","true","10","1","","","ok, fine"',
    '"2026-06-03T10:00:00.000Z","2","tester1","t","hi","true","10","1","","","r"',
    '"2026-06-01T10:00:00.000Z","3","tester2","t","hi","true","10","1","","","r"',
  ].join('\n');
  const csvB = `${header}\n"2026-06-04T08:00:00.000Z","1","tester1","t","hi","true","1","1","","","r"\n`;
  assert.equal(earliestCsvDate([csvA, csvB], 'tester1'), '2026-06-03T10:00:00.000Z');
  assert.equal(earliestCsvDate([csvA], 'bot'), null);
  assert.equal(earliestCsvDate([], 'tester1'), null);
});

test('daysSince counts the first recorded day as day 1', () => {
  const now = new Date(2026, 5, 10, 12);
  assert.equal(daysSince(new Date(2026, 5, 10, 1).toISOString(), now), 1);
  assert.equal(daysSince(new Date(2026, 5, 1, 23).toISOString(), now), 10);
  assert.equal(daysSince(null, now), 0);
});

test('summarizeIncidents counts events inside the window per kind', () => {
  const events = [
    { at: '2026-06-09T09:00:00.000Z', session: 'bot', event: 'ready' },
    { at: '2026-06-09T10:00:00.000Z', session: 'bot', event: 'qr' },
    { at: '2026-06-09T10:00:30.000Z', session: 'bot', event: 'ready' },
    { at: '2026-06-09T11:00:00.000Z', session: 'bot', event: 'disconnected', detail: 'NAVIGATION' },
    { at: '2026-01-01T00:00:00.000Z', session: 'bot', event: 'auth_failure' },
    { at: '2026-06-09T11:00:00.000Z', session: 'tester1', event: 'qr' },
  ];
  const since = new Date('2026-05-27T00:00:00.000Z');
  assert.deepEqual(summarizeIncidents(events, 'bot', since), {
    qr: 1, disconnected: 1, auth_failure: 0, total: 2,
  });
});

const ev = (iso, session, event) => ({ at: iso, session, event });
const SINCE = new Date('2026-05-27T00:00:00.000Z');

test('summarizeIncidents: ready -> qr -> ready counts one qr', () => {
  const events = [
    ev('2026-06-09T09:00:00.000Z', 's', 'ready'),
    ev('2026-06-09T10:00:00.000Z', 's', 'qr'),
    ev('2026-06-09T10:02:00.000Z', 's', 'ready'),
  ];
  assert.equal(summarizeIncidents(events, 's', SINCE).qr, 1);
  assert.equal(summarizeIncidents(events, 's', SINCE).total, 1);
});

test('summarizeIncidents: initial linking (qr -> qr -> ready) counts zero', () => {
  const events = [
    ev('2026-06-09T09:00:00.000Z', 's', 'qr'),
    ev('2026-06-09T09:30:00.000Z', 's', 'qr'),
    ev('2026-06-09T09:32:00.000Z', 's', 'ready'),
  ];
  assert.equal(summarizeIncidents(events, 's', SINCE).total, 0);
});

test('summarizeIncidents: a lone qr counts zero', () => {
  assert.equal(summarizeIncidents([ev('2026-06-09T09:00:00.000Z', 's', 'qr')], 's', SINCE).total, 0);
});

test('summarizeIncidents: a ready before the window still makes a later qr an incident', () => {
  const events = [
    ev('2026-01-01T00:00:00.000Z', 's', 'ready'),
    ev('2026-06-09T10:00:00.000Z', 's', 'qr'),
  ];
  assert.equal(summarizeIncidents(events, 's', SINCE).qr, 1);
});

test('summarizeIncidents: a ready of another session does not count, disconnects still do', () => {
  const events = [
    ev('2026-06-01T00:00:00.000Z', 'other', 'ready'),
    ev('2026-06-09T10:00:00.000Z', 's', 'qr'),
    ev('2026-06-09T11:00:00.000Z', 's', 'disconnected'),
    ev('2026-06-09T12:00:00.000Z', 's', 'auth_failure'),
  ];
  assert.deepEqual(summarizeIncidents(events, 's', SINCE), {
    qr: 0, disconnected: 1, auth_failure: 1, total: 2,
  });
});

const HOUR = 3_600_000;
const NOW = new Date('2026-10-13T20:00:00.000Z');
const reportAt = (hoursAgo, accounts) => ({
  generatedAt: new Date(NOW.getTime() - hoursAgo * HOUR).toISOString(),
  accounts,
});
const okAccount = (session, over = {}) => ({
  session,
  days: 20,
  phase: { phase: 3, name: 'Stable' },
  bidirectional: 0.9,
  incidents: { qr: 5, disconnected: 0, auth_failure: 0, total: 5 },
  probe: 'skipped',
  pacing: { mode: 'auto' },
  ...over,
});

test('accountFromRecentReport: picks the newest report under 48h and recomputes incidents', () => {
  const reports = [
    reportAt(30, [okAccount('t1', { bidirectional: 0.1 })]),
    reportAt(5, [okAccount('t1')]),
    reportAt(1, [okAccount('t2')]),
  ];
  const events = [ev('2026-10-13T18:00:00.000Z', 't1', 'ready')];
  const found = accountFromRecentReport(reports, 't1', { events, now: NOW, windowDays: 14 });
  assert.equal(found.generatedAt, reports[1].generatedAt);
  assert.equal(found.account.bidirectional, 0.9);
  assert.equal(found.account.incidents.total, 0);
  assert.equal(found.account.pacing, undefined);
  assert.equal(found.account.verdict.verdict, 'READY');
});

test('accountFromRecentReport: ignores reports 48h old or older', () => {
  const reports = [reportAt(48, [okAccount('t1')]), reportAt(100, [okAccount('t1')])];
  assert.equal(accountFromRecentReport(reports, 't1', { events: [], now: NOW, windowDays: 14 }), null);
});

test('accountFromRecentReport: skips failed or unusable accounts of that session', () => {
  const reports = [
    reportAt(1, [{ session: 't1', error: 'Listing chats timed out' }]),
    reportAt(2, [okAccount('t1', { days: undefined })]),
    reportAt(3, [okAccount('t1')]),
  ];
  const found = accountFromRecentReport(reports, 't1', { events: [], now: NOW, windowDays: 14 });
  assert.equal(found.generatedAt, reports[2].generatedAt);
});

test('accountFromRecentReport: null with no reports, bad dates or no matching session', () => {
  const opts = { events: [], now: NOW, windowDays: 14 };
  assert.equal(accountFromRecentReport([], 't1', opts), null);
  assert.equal(accountFromRecentReport([{ generatedAt: 'nope', accounts: [okAccount('t1')] }], 't1', opts), null);
  assert.equal(accountFromRecentReport([reportAt(1, [okAccount('t2')])], 't1', opts), null);
});

test('readinessVerdict is READY only when every criterion passes', () => {
  const ok = { days: 14, incidents: 0, bidirectionalRatio: 0.5, probe: 'pass' };
  assert.deepEqual(readinessVerdict(ok), { verdict: 'READY', reasons: [], verified: true });
});

test('readinessVerdict lists every failing reason', () => {
  const v = readinessVerdict({ days: 5, incidents: 2, bidirectionalRatio: 0.2, probe: 'fail' });
  assert.equal(v.verdict, 'NOT YET');
  assert.equal(v.reasons.length, 4);
});

test('readinessVerdict marks READY as not verified when the probe was not run', () => {
  const v = readinessVerdict({ days: 20, incidents: 0, bidirectionalRatio: 0.9, probe: 'skipped' });
  assert.equal(v.verdict, 'READY');
  assert.equal(v.verified, false);
});

test('readinessVerdict fails when there is no bidirectional data', () => {
  const v = readinessVerdict({ days: 20, incidents: 0, bidirectionalRatio: null, probe: 'skipped' });
  assert.equal(v.verdict, 'NOT YET');
});

const account = (session, over = {}) => ({
  session,
  days: 20,
  todayActive: 4,
  avgActive: 8,
  bidirectional: 0.9,
  richIncoming: 0.3,
  incidents: { qr: 0, disconnected: 0, auth_failure: 0, total: 0 },
  verdict: { verdict: 'READY', reasons: [], verified: false },
  ...over,
});

test('loadHistory builds per-session series sorted by time', () => {
  const entries = [
    { generatedAt: '2026-10-02T10:00:00.000Z', accounts: [account('bot', { avgActive: 9 })] },
    { generatedAt: '2026-10-01T10:00:00.000Z', accounts: [account('bot'), account('tester1')] },
  ];
  const history = loadHistory(entries);
  assert.deepEqual(history.bot.map((p) => p.at), ['2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z']);
  assert.deepEqual(history.bot[1], {
    at: '2026-10-02T10:00:00.000Z',
    days: 20,
    avgActive: 9,
    todayActive: 4,
    bidirectional: 0.9,
    richIncoming: 0.3,
    incidents: 0,
    verdict: 'READY',
  });
  assert.equal(history.tester1.length, 1);
});

test('loadHistory skips errored sessions and malformed entries', () => {
  const entries = [
    null,
    'junk',
    { accounts: [account('bot')] }, // no timestamp
    { generatedAt: 'not-a-date', accounts: [account('bot')] },
    { generatedAt: '2026-10-01T10:00:00.000Z', accounts: 'nope' },
    {
      generatedAt: '2026-10-01T10:00:00.000Z',
      accounts: [{ session: 'bot', error: 'browser is already running' }, account('tester1'), null, { session: 'x' }],
    },
  ];
  const history = loadHistory(entries);
  assert.deepEqual(Object.keys(history), ['tester1']);
  assert.deepEqual(loadHistory(undefined), {});
});

test('compareToPrevious reports deltas with direction markers', () => {
  const prev = { at: 'a', avgActive: 8, bidirectional: 0.9, richIncoming: 0.3, incidents: 1 };
  const cur = { at: 'b', avgActive: 10, bidirectional: 0.9, richIncoming: 0.2, incidents: 0 };
  const c = compareToPrevious(cur, prev);
  assert.equal(c.previousAt, 'a');
  assert.deepEqual(c.avgActive, { previous: 8, current: 10, delta: 2, direction: 'up' });
  assert.equal(c.bidirectional.direction, 'same');
  assert.equal(c.richIncoming.direction, 'down');
  assert.equal(c.incidents.direction, 'down');
  assert.deepEqual(c.warnings, []);
});

test('compareToPrevious warns when bidirectional drops 5+ points or incidents increase', () => {
  const base = { avgActive: 8, richIncoming: 0.3, incidents: 0 };
  const drop = compareToPrevious({ ...base, bidirectional: 0.85 }, { ...base, bidirectional: 0.9 });
  assert.equal(drop.warnings.length, 1);
  assert.match(drop.warnings[0], /bidirectional/);
  assert.equal(compareToPrevious({ ...base, bidirectional: 0.86 }, { ...base, bidirectional: 0.9 }).warnings.length, 0);

  const inc = compareToPrevious({ ...base, bidirectional: 0.9, incidents: 2 }, { ...base, bidirectional: 0.9 });
  assert.equal(inc.warnings.length, 1);
  assert.match(inc.warnings[0], /incidents/);
});

test('compareToPrevious tolerates null ratios', () => {
  const c = compareToPrevious(
    { avgActive: 5, bidirectional: null, richIncoming: 0.2, incidents: 0 },
    { avgActive: 5, bidirectional: 0.9, richIncoming: null, incidents: 0 },
  );
  assert.deepEqual(c.bidirectional, { previous: 0.9, current: null, delta: null, direction: 'same' });
  assert.equal(c.richIncoming.delta, null);
  assert.deepEqual(c.warnings, []);
});

test('trendForReport compares only sessions that succeeded and have a previous run', () => {
  const history = loadHistory([
    { generatedAt: '2026-10-01T10:00:00.000Z', accounts: [account('bot'), account('tester1')] },
  ]);
  const trend = trendForReport(
    [account('bot', { avgActive: 10 }), { session: 'tester1', error: 'in use' }, account('tester2')],
    history,
  );
  assert.deepEqual(Object.keys(trend), ['bot']);
  assert.equal(trend.bot.avgActive.direction, 'up');
});

test('formatTrend renders arrows, deltas and warnings; historyRows keeps the last N', () => {
  const prev = { at: '2026-10-01T10:00:00.000Z', avgActive: 8, bidirectional: 0.9, richIncoming: 0.3, incidents: 0 };
  const cur = { at: 'x', avgActive: 6, bidirectional: 0.8, richIncoming: 0.3, incidents: 1 };
  const text = formatTrend('bot', compareToPrevious(cur, prev));
  assert.match(text, /Avg chats\/day: 8\.0 -> 6\.0 ↓ \(-2\.0\)/);
  assert.match(text, /Rich incoming: 30% -> 30% =/);
  assert.match(text, /WARNING: bidirectional/);
  assert.match(text, /WARNING: incidents/);

  const series = Array.from({ length: 12 }, (_, i) => ({
    at: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
    avgActive: i, bidirectional: 0.5, richIncoming: null, incidents: 0, verdict: 'READY',
  }));
  const rows = historyRows(series, 10);
  assert.equal(rows.length, 10);
  assert.equal(rows[0].date, '2026-10-03 10:00');
  assert.equal(rows[0]['rich %'], 'n/a');
});

test('compareToPrevious treats ratio changes under one percentage point as the same', () => {
  const base = { avgActive: 8, incidents: 0 };
  const c = compareToPrevious(
    { ...base, bidirectional: 0.9, richIncoming: 0.2666 },
    { ...base, bidirectional: 0.9, richIncoming: 0.27 },
  );
  assert.equal(c.richIncoming.direction, 'same');
  assert.equal(c.richIncoming.delta, 0);
});
