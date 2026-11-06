import test from 'node:test';
import assert from 'node:assert/strict';

import { capIncidents, sessionAge } from './session-age.js';

const NOW = new Date('2026-11-03T15:00:00.000Z');
const SINCE = NOW.getTime() - 14 * 86_400_000;
const at = (daysAgo) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

test('capIncidents: a fleet-wide freeze (many raw disconnects and QR events) is not an incident', () => {
  const events = [];
  for (let i = 0; i < 12; i++) events.push({ at: at(1), session: 'tester1', event: 'disconnected', detail: '408' });
  events.push({ at: at(2), session: 'tester1', event: 'qr' });
  events.push({ at: at(2), session: 'tester1', event: 'auth_failure' });
  assert.equal(capIncidents(events, 'tester1', SINCE), 0);
});

test('capIncidents: counts LOGOUT events and pauses from the disconnect brake', () => {
  const events = [
    { at: at(3), session: 'tester1', event: 'disconnected', detail: 'LOGOUT' },
    { at: at(2), session: 'tester1', event: 'paused', detail: 'repeated_disconnects; 5 disconnects in 60 min; source=engine' },
    { at: at(1), session: 'tester1', event: 'paused', detail: 'manual; source=user' },
    { at: at(1), session: 'tester1', event: 'resumed', detail: 'source=user' },
    { at: at(1), session: 'tester2', event: 'disconnected', detail: 'LOGOUT' },
  ];
  assert.equal(capIncidents(events, 'tester1', SINCE), 2);
});

test('capIncidents: a logout is one incident even though it also writes a logged_out pause, and old relink events', () => {
  const events = [
    { at: at(3), session: 'tester1', event: 'disconnected', detail: 'LOGOUT' },
    { at: at(3), session: 'tester1', event: 'paused', detail: 'logged_out; WhatsApp logged the session out (401); source=engine' },
    { at: at(3), session: 'tester1', event: 'logged_out_relink' },
  ];
  assert.equal(capIncidents(events, 'tester1', SINCE), 1);
});

test('capIncidents: events outside the window are ignored', () => {
  const events = [{ at: at(30), session: 'tester1', event: 'disconnected', detail: 'LOGOUT' }];
  assert.equal(capIncidents(events, 'tester1', SINCE), 0);
});

test('sessionAge: day 1 is the first ready event or first sent message, whichever is earlier', () => {
  const events = [{ at: at(9), session: 'tester1', event: 'ready' }];
  const earliestSent = new Date(at(12)).getTime() / 1000;
  assert.equal(sessionAge({ session: 'tester1', events, earliestSentSeconds: earliestSent, now: NOW }).days, 13);
  assert.equal(sessionAge({ session: 'tester1', events, earliestSentSeconds: null, now: NOW }).days, 10);
});

test('sessionAge: a number with no history is day 1, and incidents come from capIncidents', () => {
  const age = sessionAge({
    session: 'tester1',
    events: [{ at: at(1), session: 'tester1', event: 'disconnected', detail: 'LOGOUT' }],
    earliestSentSeconds: null,
    now: NOW,
  });
  assert.equal(age.days, 1);
  assert.equal(age.incidents, 1);
});
