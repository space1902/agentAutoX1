import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canExecute, pauseAdset, setStatus, setAdsetDailyBudget, duplicate, executeAction, clampBudget,
} from './actions.js';
import { DEFAULT_CONFIG } from './config.js';

const TZ = 'America/Bogota';
const NOON = Date.parse('2026-10-25T17:00:00Z'); // 12:00 Bogota
const NIGHT = Date.parse('2026-10-25T08:00:00Z'); // 03:00 Bogota

const fakeApi = (getResponses = {}) => {
  const calls = [];
  return {
    calls,
    async post(path, body) { calls.push({ method: 'POST', path, body }); return { success: true, copied_ad_id: 'new1' }; },
    async get(path, params) { calls.push({ method: 'GET', path, params }); return getResponses[path] ?? {}; },
  };
};

test('canExecute allows normal hours', () => {
  assert.deepEqual(canExecute({ config: DEFAULT_CONFIG, now: NOON, tz: TZ }), { ok: true });
});

test('canExecute blocks on kill switch', () => {
  const r = canExecute({ config: { ...DEFAULT_CONFIG, killSwitch: true }, now: NOON, tz: TZ });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'kill_switch');
});

test('canExecute queues during restricted hours and says when they end', () => {
  const r = canExecute({ config: DEFAULT_CONFIG, now: NIGHT, tz: TZ });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'restricted_hours');
  assert.equal(r.untilHour, DEFAULT_CONFIG.restrictedHours.end);
});

test('pauseAdset POSTs status=PAUSED to the ad set (ad-level writes fail on click-to-WhatsApp ads)', async () => {
  const api = fakeApi();
  await pauseAdset(api, 's1');
  assert.deepEqual(api.calls, [{ method: 'POST', path: '/s1', body: { status: 'PAUSED' } }]);
});

test('pauseAdset refuses a missing ad set id and does not POST', async () => {
  const api = fakeApi();
  await assert.rejects(() => pauseAdset(api, ''), /ad set/i);
  assert.equal(api.calls.length, 0);
});

test('setStatus validates the status value', async () => {
  const api = fakeApi();
  await setStatus(api, 'c1', 'ACTIVE');
  assert.equal(api.calls[0].body.status, 'ACTIVE');
  await assert.rejects(() => setStatus(api, 'c1', 'DELETED'), /status/i);
});

test('clampBudget enforces the +-20% cap with integer COP', () => {
  assert.equal(clampBudget(100000, 120000, 20).ok, true);
  assert.equal(clampBudget(100000, 121000, 20).ok, false);
  assert.equal(clampBudget(100000, 80000, 20).ok, true);
  assert.equal(clampBudget(100000, 79000, 20).ok, false);
  assert.equal(clampBudget(100000, 100000.5, 20).ok, false, 'must be an integer');
  assert.equal(clampBudget(100000, 0, 20).ok, false);
});

test('setAdsetDailyBudget reads the current budget, validates and writes', async () => {
  const api = fakeApi({ '/s1': { daily_budget: '100000' } });
  await setAdsetDailyBudget(api, 's1', 115000, 20);
  assert.deepEqual(api.calls[1], { method: 'POST', path: '/s1', body: { daily_budget: 115000 } });
});

test('setAdsetDailyBudget falls back to the campaign budget (CBO) when the ad set has none', async () => {
  const api = fakeApi({ '/s1': { campaign_id: 'c1' }, '/c1': { daily_budget: '100000' } });
  await setAdsetDailyBudget(api, 's1', 110000, 20);
  assert.deepEqual(api.calls.at(-1), { method: 'POST', path: '/c1', body: { daily_budget: 110000 } });
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 1);
});

test('setAdsetDailyBudget applies the cap to the campaign budget too', async () => {
  const api = fakeApi({ '/s1': { campaign_id: 'c1' }, '/c1': { daily_budget: '100000' } });
  await assert.rejects(() => setAdsetDailyBudget(api, 's1', 150000, 20), /20%/);
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0);
});

test('setAdsetDailyBudget throws when neither ad set nor campaign has a budget', async () => {
  const api = fakeApi({ '/s1': { campaign_id: 'c1' }, '/c1': {} });
  await assert.rejects(() => setAdsetDailyBudget(api, 's1', 1000, 20), /no daily budget/i);
});

test('setAdsetDailyBudget refuses a change above the cap and does not POST', async () => {
  const api = fakeApi({ '/s1': { daily_budget: '100000' } });
  await assert.rejects(() => setAdsetDailyBudget(api, 's1', 150000, 20), /20%/);
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0);
});

test('duplicate uses /copies and creates the copy paused', async () => {
  const api = fakeApi();
  const r = await duplicate(api, 'a1');
  assert.equal(api.calls[0].path, '/a1/copies');
  assert.equal(api.calls[0].body.status_option, 'PAUSED');
  assert.equal(r.copied_ad_id, 'new1');
});

test('executeAction dispatches by kind', async () => {
  const api = fakeApi({ '/s1': { daily_budget: '1000' } });
  await executeAction(api, { kind: 'pause_adset', targetId: 's2', adId: 'a1' }, DEFAULT_CONFIG);
  await executeAction(api, { kind: 'set_status', targetId: 'c1', status: 'PAUSED' }, DEFAULT_CONFIG);
  await executeAction(api, { kind: 'set_budget', targetId: 's1', value: 1100 }, DEFAULT_CONFIG);
  await executeAction(api, { kind: 'duplicate', targetId: 'a1' }, DEFAULT_CONFIG);
  const posts = api.calls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.deepEqual(posts, ['/s2', '/c1', '/s1', '/a1/copies']);
  await assert.rejects(() => executeAction(api, { kind: 'explode', targetId: 'x' }, DEFAULT_CONFIG), /unknown action/i);
});
