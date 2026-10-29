import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from './monitor.js';
import { createStore } from './store.js';
import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { ACTION_PURCHASE, ACTION_CONVERSATION } from './insights.js';

const ACC = 'act_1';
const T = Date.parse('2026-10-25T20:00:00Z'); // 15:00 Bogota
const min = (n) => n * 60_000;

const insightRow = (over = {}) => ({
  campaign_name: 'CT01 Bebidas', campaign_id: 'c1', adset_id: 's1', ad_id: 'a1', ad_name: 'Video 1',
  spend: '0', impressions: '2000', clicks: '40', frequency: '1.2',
  actions: [{ action_type: ACTION_PURCHASE, value: '0' }, { action_type: ACTION_CONVERSATION, value: '0' }],
  ...over,
});
const withActions = (row, purchases, conversations) => ({
  ...row,
  actions: [{ action_type: ACTION_PURCHASE, value: String(purchases) }, { action_type: ACTION_CONVERSATION, value: String(conversations) }],
});
const hourlyRow = (over = {}) => ({
  ...insightRow(), date_start: '2026-10-25', hourly_stats_aggregated_by_advertiser_time_zone: '14:00:00 - 14:59:59', ...over,
});

function setup({ config = DEFAULT_CONFIG, now = T } = {}) {
  const clock = { t: now };
  const state = {
    account: { timezone_name: 'America/Bogota', account_status: 1, disable_reason: 0, spend_cap: '0', amount_spent: '0', currency: 'COP' },
    today: [withActions(insightRow({ spend: '1000' }), 1, 2)],
    hourly: [],
    ads: [
      { id: 'a1', name: 'Video 1', effective_status: 'ACTIVE', campaign_id: 'c1', adset_id: 's1', campaign: { name: 'CT01 Bebidas' } },
      { id: 'b1', name: 'BF ad', effective_status: 'ACTIVE', campaign_id: 'c9', adset_id: 's9', campaign: { name: 'BF Black Friday' } },
    ],
    posts: [],
  };
  const api = {
    shouldSkipPoll: () => ({ skip: false }),
    async get(path) { assert.equal(path, `/${ACC}`); return state.account; },
    async getAll(path, params) {
      if (path === `/${ACC}/insights`) return params.breakdowns ? state.hourly : state.today;
      if (path === `/${ACC}/ads`) return state.ads;
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) { state.posts.push({ path, body }); return { success: true }; },
  };
  const sent = [];
  const saved = [];
  const store = createStore(':memory:');
  const monitor = new Monitor({
    api, store, accountId: ACC, config: mergeConfig(config), allowActions: true,
    send: async (text) => { sent.push(text); },
    saveConfig: (cfg) => saved.push(cfg),
    now: () => clock.t,
    log: () => {},
  });
  return { monitor, api, state, sent, saved, store, clock };
}

test('init reads the account timezone and polls only CT campaigns', async () => {
  const { monitor, state } = setup();
  state.today.push(withActions(insightRow({ ad_id: 'b1', ad_name: 'BF ad', campaign_name: 'BF Black Friday', spend: '99999' }), 0, 0));
  await monitor.init();
  assert.equal(monitor.tz, 'America/Bogota');
  const snap = await monitor.buildSnapshot();
  assert.deepEqual(snap.ads.map((a) => a.id), ['a1']);
});

test('first poll in active hours sends the hourly summary, then not again the same hour', async () => {
  const { monitor, sent, clock } = setup();
  await monitor.init();
  await monitor.poll();
  assert.equal(sent.filter((t) => /Resumen/.test(t)).length, 1);
  clock.t += min(15);
  await monitor.poll();
  assert.equal(sent.filter((t) => /Resumen/.test(t)).length, 1);
});

test('a sale between polls is stored with its timestamp', async () => {
  const { monitor, state, store, clock } = setup();
  await monitor.init();
  state.today = [withActions(insightRow({ spend: '1000' }), 0, 2)];
  await monitor.poll();
  clock.t += min(15);
  state.today = [withActions(insightRow({ spend: '1500' }), 1, 3)];
  await monitor.poll();
  const last = store.lastSales(clock.t - min(600));
  assert.equal(last.accountLastTs, clock.t);
  assert.equal(last.ads.a1.spendAt, 1500);
});

test('startup seeds the last sale from hourly history, so a restart raises no false gap', async () => {
  const { monitor, state, sent } = setup();
  state.hourly = [hourlyRow({ actions: [{ action_type: ACTION_PURCHASE, value: '1' }] , spend: '800' })];
  state.today = [withActions(insightRow({ spend: '800' }), 1, 2)];
  await monitor.init();
  await monitor.poll();
  assert.ok(!sent.some((t) => /sin ventas/i.test(t) && /minutos/.test(t)), sent.join('\n---\n'));
});

test('no sale all day and 5200 spent: one pause request, and duplicates reuse it', async () => {
  const { monitor, state, sent, store } = setup();
  state.today = [withActions(insightRow({ spend: '5200' }), 0, 8)];
  await monitor.init();
  await monitor.poll();
  const requests = store.pendingRequests(T);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].payload.actions, [{ kind: 'pause_adset', targetId: 's1', adId: 'a1', label: 'Video 1' }]);
  assert.ok(sent.some((t) => /SI 1\b/.test(t)));
  assert.equal(state.posts.length, 0, 'nothing is executed without approval');
});

test('a failed duplicate shows the Meta user-facing title and message', async () => {
  const { monitor, api, sent, store, clock } = setup();
  await monitor.init();
  api.post = async () => {
    throw Object.assign(new Error('Unsupported'), { userTitle: 'Sin acceso a Instagram', userMessage: 'Conecta la cuenta en Business Manager' });
  };
  const id = store.createRequest({ kind: 'action', payload: { actions: [{ kind: 'duplicate', targetId: 'a1', label: 'Video 1' }] }, now: clock.t, ttlMin: 120 });
  await monitor.handleMessage(`SI ${id}`);
  assert.match(sent.at(-1), /Sin acceso a Instagram: Conecta la cuenta en Business Manager/);
  assert.equal(store.getRequest(id).status, 'failed');
});

test('estado includes the API access tier when the client knows it', async () => {
  const { monitor, api, sent } = setup();
  api.accessTier = 'development_access';
  await monitor.init();
  await monitor.poll();
  await monitor.handleMessage('estado');
  assert.match(sent.at(-1), /development_access/);
});

test('the same alert is not resent inside the cooldown', async () => {
  const { monitor, state, sent, clock } = setup();
  state.today = [withActions(insightRow({ spend: '5200' }), 0, 8)];
  await monitor.init();
  await monitor.poll();
  const before = sent.length;
  clock.t += min(15);
  await monitor.poll();
  assert.equal(sent.length, before);
});

test('SI <id> executes the pause through the API and logs the action', async () => {
  const { monitor, state, sent, store } = setup();
  state.today = [withActions(insightRow({ spend: '5200' }), 0, 8)];
  await monitor.init();
  await monitor.poll();
  await monitor.handleMessage('SI 1');
  assert.deepEqual(state.posts, [{ path: '/s1', body: { status: 'PAUSED' } }]);
  assert.equal(store.getRequest(1).status, 'executed');
  assert.equal(store.recentActions(5)[0].ok, true);
  assert.match(sent.at(-1), /Video 1/);
});

test('NO <id> rejects without calling the API', async () => {
  const { monitor, state, store } = setup();
  state.today = [withActions(insightRow({ spend: '5200' }), 0, 8)];
  await monitor.init();
  await monitor.poll();
  await monitor.handleMessage('NO 1');
  assert.equal(state.posts.length, 0);
  assert.equal(store.getRequest(1).status, 'rejected');
});

test('requests expire after 2 hours', async () => {
  const { monitor, state, sent, clock, store } = setup();
  state.today = [withActions(insightRow({ spend: '5200' }), 0, 8)];
  await monitor.init();
  await monitor.poll();
  clock.t += min(121);
  await monitor.handleMessage('SI 1');
  assert.equal(state.posts.length, 0);
  assert.match(sent.at(-1), /expir/i);
  assert.equal(store.getRequest(1).status, 'expired');
});

test('unknown request id gets a clear answer', async () => {
  const { monitor, sent } = setup();
  await monitor.init();
  await monitor.handleMessage('SI 77');
  assert.match(sent.at(-1), /77/);
});

test('restricted hours queue the approved action and run it when the window opens', async () => {
  const night = Date.parse('2026-10-25T08:00:00Z'); // 03:00 Bogota, inside restricted hours
  const { monitor, state, sent, clock, store } = setup({ now: night });
  await monitor.init();
  const id = store.createRequest({ kind: 'action', payload: { actions: [{ kind: 'pause_adset', targetId: 's1', adId: 'a1', label: 'Video 1' }] }, now: night, ttlMin: 120 });
  await monitor.handleMessage(`SI ${id}`);
  assert.equal(state.posts.length, 0);
  assert.equal(store.getRequest(id).status, 'queued');
  assert.match(sent.at(-1), /07:00/);
  clock.t = Date.parse('2026-10-25T12:30:00Z'); // 07:30 Bogota
  await monitor.poll();
  assert.deepEqual(state.posts, [{ path: '/s1', body: { status: 'PAUSED' } }]);
  assert.equal(store.getRequest(id).status, 'executed');
});

test('DETENER blocks actions until REANUDAR', async () => {
  const { monitor, state, sent, saved, store } = setup();
  state.today = [withActions(insightRow({ spend: '5200' }), 0, 8)];
  await monitor.init();
  await monitor.poll();
  await monitor.handleMessage('DETENER');
  assert.equal(saved.at(-1).killSwitch, true);
  await monitor.handleMessage('SI 1');
  assert.equal(state.posts.length, 0);
  assert.match(sent.at(-1), /DETENER|detenid/i);
  assert.notEqual(store.getRequest(1).status, 'executed');
  await monitor.handleMessage('REANUDAR');
  assert.equal(saved.at(-1).killSwitch, false);
});

test('valor <name> <number> updates and persists the threshold', async () => {
  const { monitor, saved, sent } = setup();
  await monitor.init();
  await monitor.handleMessage('valor revisar 6000');
  assert.equal(saved.at(-1).thresholds.reviewCpa, 6000);
  assert.match(sent.at(-1), /\$6\.000/);
  await monitor.handleMessage('valor revisar 1000');
  assert.match(sent.at(-1), /objetivo|target|menor/i);
  assert.equal(saved.at(-1).thresholds.reviewCpa, 6000);
});

test('pausa alertas silences sending but still logs', async () => {
  const { monitor, state, sent, store, clock } = setup();
  state.today = [withActions(insightRow({ spend: '5200' }), 0, 8)];
  await monitor.init();
  await monitor.handleMessage('pausa alertas 30');
  const before = sent.length;
  await monitor.poll();
  assert.equal(sent.length, before);
  assert.ok(store.countAlerts() > 0);
  clock.t += min(31);
  await monitor.poll();
  assert.ok(sent.length > before);
});

test('estado answers with a summary', async () => {
  const { monitor, sent } = setup();
  await monitor.init();
  await monitor.poll();
  await monitor.handleMessage('estado');
  assert.match(sent.at(-1), /Estado/);
});

test('ACEPTAR applies a pending threshold recommendation', async () => {
  const { monitor, store, saved, sent, clock } = setup();
  await monitor.init();
  const id = store.createRequest({
    kind: 'recommendation',
    payload: { recs: [{ name: 'targetCpa', current: 2500, recommended: 3000 }, { name: 'reviewCpa', current: 5000, recommended: 6000 }] },
    now: clock.t, ttlMin: 60 * 24 * 3,
  });
  await monitor.handleMessage(`ACEPTAR ${id}`);
  assert.equal(saved.at(-1).thresholds.targetCpa, 3000);
  assert.equal(saved.at(-1).thresholds.reviewCpa, 6000);
  assert.equal(store.getRequest(id).status, 'executed');
  assert.ok(sent.length > 0);
});

test('a recommendation is sent every 3 days from the baseline and never auto-applied', async () => {
  const { monitor, state, sent, store, clock, saved } = setup();
  // 5 previous days with CPA 3000 (spend 9000 / 3 sales per day)
  for (let d = 20; d <= 24; d++) {
    state.hourly.push(
      hourlyRow({ date_start: `2026-10-${d}`, spend: '9000', actions: [{ action_type: ACTION_PURCHASE, value: '3' }, { action_type: ACTION_CONVERSATION, value: '6' }] }),
    );
  }
  await monitor.init();
  await monitor.poll();
  const first = sent.filter((t) => /ACEPTAR/.test(t)).length;
  assert.equal(first, 0, 'not on the very first day');
  store.setKv('firstRunTs', clock.t - min(60 * 24 * 3 + 5));
  clock.t += min(15);
  await monitor.poll();
  assert.equal(sent.filter((t) => /ACEPTAR/.test(t)).length, 1);
  assert.equal(saved.length, 0, 'config untouched');
  clock.t += min(15);
  await monitor.poll();
  assert.equal(sent.filter((t) => /ACEPTAR/.test(t)).length, 1, 'only once per 3 days');
});

test('a poll skipped by the rate limiter does not call the API', async () => {
  const { monitor, api } = setup();
  await monitor.init();
  api.shouldSkipPoll = () => ({ skip: true, reason: 'usage' });
  let called = false;
  api.getAll = async () => { called = true; return []; };
  const r = await monitor.poll();
  assert.equal(r.skipped, true);
  assert.equal(called, false);
});
