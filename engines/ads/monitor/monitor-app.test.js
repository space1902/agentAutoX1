import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { ACTION_CONVERSATION, ACTION_PURCHASE } from './insights.js';
import { Monitor } from './monitor.js';
import { UNATTRIBUTED } from './sheet-sales.js';
import { createStore } from './store.js';

const ACC = 'act_1';
const T = Date.parse('2026-10-25T20:00:00Z'); // 15:00 in Bogota
const insight = (over = {}) => ({
  campaign_name: 'CT01 Bebidas', campaign_id: 'c1', adset_id: 's1', ad_id: 'a1', ad_name: 'Video 1', spend: '6000', impressions: '2000', clicks: '40', frequency: '1.2',
  actions: [{ action_type: ACTION_PURCHASE, value: '0' }, { action_type: ACTION_CONVERSATION, value: '10' }], ...over,
});
const pay = (registered, adId, extra = {}) => ({ registered, date: registered.slice(0, 10), result: 'Pago válido', flow: 'Bebidas - aporte', adId, valor: 15000, ...extra });

function setup({ sheetRows, allowActions = false, config = {}, now = T } = {}) {
  const clock = { t: now };
  const posts = [];
  const api = {
    usagePct: 12, accessTier: 'standard_access',
    shouldSkipPoll: () => ({ skip: false }),
    async get() { return { timezone_name: 'America/Bogota', account_status: 1, disable_reason: 0, spend_cap: '0', amount_spent: '0' }; },
    async getAll(path, params) {
      if (path.endsWith('/insights')) return params.breakdowns ? [] : [insight()];
      return [{ id: 'a1', name: 'Video 1', effective_status: 'ACTIVE', campaign_id: 'c1', adset_id: 's1', campaign: { name: 'CT01 Bebidas' } }];
    },
    async post(path, body) { posts.push({ path, body }); return {}; },
  };
  const sent = [];
  const store = createStore(':memory:');
  const monitor = new Monitor({
    api, store, accountId: ACC, config: mergeConfig({ salesSource: 'sheet', flowPrefix: 'Bebidas', validResult: 'Pago válido', ...config }),
    send: async (t) => { sent.push(t); }, now: () => clock.t, log: () => {}, sheetRows, allowActions,
  });
  return { monitor, sent, store, posts, clock };
}

test('the payments sheet is the sales signal: ads and unattributed payments are counted today', async () => {
  const rows = [pay('25/10/2026 14:10:00', 'a1'), pay('25/10/2026 14:40:00', 'a1'), pay('25/10/2026 14:50:00', ''), pay('24/10/2026 14:50:00', 'a1')];
  const { monitor, store } = setup({ sheetRows: async () => rows });
  await monitor.init();
  const snap = await monitor.buildSnapshot();
  assert.equal(snap.ads.find((a) => a.id === 'a1').purchases, 2, 'Meta said 0 purchases; the sheet says 2');
  assert.equal(snap.ads.some((a) => a.id === UNATTRIBUTED), false, 'the pseudo ad never reaches the rules');
  assert.equal(store.latestSamples()[UNATTRIBUTED].purchases, 1);
});

test('a new payment between polls becomes a sale event that resets the no-sale clock', async () => {
  let rows = [pay('25/10/2026 12:00:00', 'a1')];
  const { monitor, store, clock } = setup({ sheetRows: async () => rows });
  await monitor.init();
  await monitor.buildSnapshot();
  clock.t += 15 * 60_000;
  rows = [...rows, pay('25/10/2026 15:10:00', 'a1')];
  await monitor.buildSnapshot();
  const sales = store.lastSales(T - 24 * 3_600_000);
  assert.equal(sales.ads.a1.ts, clock.t);
});

test('when the sheet fails the last copy is used, then Meta purchases', async () => {
  let fail = false;
  const rows = [pay('25/10/2026 14:10:00', 'a1')];
  const { monitor } = setup({ sheetRows: async () => { if (fail) throw new Error('offline'); return rows; } });
  await monitor.init();
  await monitor.buildSnapshot();
  fail = true;
  const snap = await monitor.buildSnapshot();
  assert.equal(snap.ads[0].purchases, 1);
  const noSheet = setup({ sheetRows: async () => { throw new Error('offline'); } });
  await noSheet.monitor.init();
  assert.equal((await noSheet.monitor.buildSnapshot()).ads[0].purchases, 0);
});

test('without a sheet the monitor falls back to Meta purchases', async () => {
  const { monitor } = setup({});
  assert.equal(monitor.salesSource, 'meta');
});

test('alert-only mode never offers a pause and refuses SI', async () => {
  const { monitor, sent, posts, store, clock } = setup({ sheetRows: async () => [], config: { thresholds: { targetCpa: 2500, reviewCpa: 5000 } } });
  await monitor.init();
  await monitor.poll();
  const alert = sent.find((t) => /gastó/.test(t));
  assert.ok(alert, 'the no-sale alert is still sent');
  assert.doesNotMatch(alert, /Responde SI/);
  assert.equal(store.pendingRequests(clock.t).length, 0);
  await monitor.handleMessage('SI 1');
  assert.match(sent.at(-1), /desactivadas/);
  assert.equal(posts.length, 0);
});

test('with actions enabled the same alert asks for approval', async () => {
  const { monitor, sent } = setup({ sheetRows: async () => [], allowActions: true });
  await monitor.init();
  await monitor.poll();
  assert.match(sent.find((t) => /gastó/.test(t)), /Responde SI/);
});

test('summaryEnabled=false silences the hourly summary', async () => {
  const { monitor, sent } = setup({ sheetRows: async () => [], config: { summaryEnabled: false } });
  await monitor.init();
  await monitor.poll();
  assert.equal(sent.some((t) => /Resumen/.test(t)), false);
});

test('status reports the poll clock, API usage and mode for the UI', async () => {
  const { monitor } = setup({ sheetRows: async () => [] });
  await monitor.init();
  const stop = monitor.run();
  await new Promise((r) => setTimeout(r, 30));
  stop();
  const s = monitor.status();
  assert.equal(s.tz, 'America/Bogota');
  assert.equal(s.usagePct, 12);
  assert.equal(s.mode, 'alert_only');
  assert.equal(s.nextPollTs - s.lastPollTs, DEFAULT_CONFIG.pollMinutes * 60_000);
  assert.equal(s.lastError, null);
});
