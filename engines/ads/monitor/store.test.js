import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.js';

const T0 = Date.parse('2026-10-25T20:00:00Z');
const min = (n) => n * 60_000;

test('kv stores and reads JSON values', () => {
  const s = createStore(':memory:');
  assert.equal(s.getKv('x'), null);
  s.setKv('x', { a: 1 });
  assert.deepEqual(s.getKv('x'), { a: 1 });
  s.setKv('x', 5);
  assert.equal(s.getKv('x'), 5);
});

test('samples: latest sample per ad and the sample closest before a time', () => {
  const s = createStore(':memory:');
  s.addSamples(T0 - min(60), [{ id: 'a1', spend: 100, purchases: 0, conversations: 1 }]);
  s.addSamples(T0 - min(30), [{ id: 'a1', spend: 200, purchases: 1, conversations: 2 }]);
  s.addSamples(T0, [{ id: 'a1', spend: 300, purchases: 1, conversations: 4 }]);
  const latest = s.latestSamples();
  assert.equal(latest.a1.spend, 300);
  const before = s.samplesAtOrBefore(T0 - min(45));
  assert.equal(before.a1.spend, 100);
  assert.equal(s.samplesAtOrBefore(T0 - min(90)), null);
  assert.equal(s.oldestSampleTs(), T0 - min(60));
});

test('sales: last sale per ad and for the account, restricted to a day window', () => {
  const s = createStore(':memory:');
  s.addSale({ adId: 'a1', count: 1, spendAt: 500, ts: T0 - min(120) });
  s.addSale({ adId: 'a2', count: 2, spendAt: 900, ts: T0 - min(30) });
  s.addSale({ adId: 'a1', count: 1, spendAt: 1500, ts: T0 - min(10) });
  s.addSale({ adId: 'a1', count: 1, spendAt: 99, ts: T0 - min(60 * 30) }); // yesterday
  const sinceDay = T0 - min(60 * 8);
  const last = s.lastSales(sinceDay);
  assert.equal(last.accountLastTs, T0 - min(10));
  assert.deepEqual(last.ads.a1, { ts: T0 - min(10), spendAt: 1500 });
  assert.deepEqual(last.ads.a2, { ts: T0 - min(30), spendAt: 900 });
  assert.equal(s.salesBetween(T0 - min(60), T0).length, 2);
  assert.equal(s.lastSales(T0 + 1).accountLastTs, null);
});

test('requests: ids are short sequential numbers; expire after ttl', () => {
  const s = createStore(':memory:');
  const a = s.createRequest({ kind: 'action', payload: { actions: [1] }, now: T0, ttlMin: 120 });
  const b = s.createRequest({ kind: 'recommendation', payload: { recs: [] }, now: T0, ttlMin: 120 });
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.equal(s.getRequest(a).status, 'pending');
  assert.deepEqual(s.getRequest(a).payload, { actions: [1] });
  assert.equal(s.pendingRequests(T0 + min(119)).length, 2);
  assert.equal(s.pendingRequests(T0 + min(121)).length, 0);
  assert.equal(s.expireRequests(T0 + min(121)), 2);
  assert.equal(s.getRequest(a).status, 'expired');
});

test('requests: status transitions and queued retrieval', () => {
  const s = createStore(':memory:');
  const id = s.createRequest({ kind: 'action', payload: {}, now: T0, ttlMin: 120 });
  s.setRequestStatus(id, 'queued', { expiresTs: T0 + min(720) });
  assert.equal(s.queuedRequests().length, 1);
  s.setRequestStatus(id, 'executed');
  assert.equal(s.queuedRequests().length, 0);
  assert.equal(s.getRequest(id).status, 'executed');
  assert.equal(s.getRequest(999), null);
});

test('alert log and last-sent tracking per family', () => {
  const s = createStore(':memory:');
  s.logAlert({ ts: T0 - min(30), family: 'f1', severity: 1, type: 't', text: 'hi', sent: true });
  s.logAlert({ ts: T0 - min(10), family: 'f1', severity: 2, type: 't', text: 'hi2', sent: true });
  s.logAlert({ ts: T0 - min(5), family: 'f2', severity: 1, type: 't', text: 'suppressed', sent: false });
  const last = s.lastSentByFamily(T0 - min(120));
  assert.deepEqual(last.f1, { ts: T0 - min(10), severity: 2 });
  assert.equal(last.f2, undefined, 'unsent alerts do not start a cooldown');
  assert.equal(s.countAlerts(), 3);
});

test('action log records every action with outcome', () => {
  const s = createStore(':memory:');
  s.logAction({ ts: T0, kind: 'pause_ad', targetId: 'a1', requestId: 1, ok: true, result: { success: true } });
  s.logAction({ ts: T0, kind: 'pause_ad', targetId: 'a2', requestId: 1, ok: false, result: 'boom' });
  const rows = s.recentActions(10);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.targetId === 'a2').ok, false);
  assert.deepEqual(rows.find((r) => r.targetId === 'a1').result, { success: true });
});

test('pruneSamples removes old rows', () => {
  const s = createStore(':memory:');
  s.addSamples(T0 - min(60 * 100), [{ id: 'a1', spend: 1, purchases: 0, conversations: 0 }]);
  s.addSamples(T0, [{ id: 'a1', spend: 2, purchases: 0, conversations: 0 }]);
  s.pruneSamples(T0 - min(60 * 48));
  assert.equal(s.oldestSampleTs(), T0);
});
