import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeConfig } from './config.js';
import { parseAccountsArg, targetsFor } from './portfolios.js';
import { createStore } from './store.js';
import { runAutoSync, runSync } from './sync.js';
import { runTick, tickInsights } from './tick.js';

const T1 = 'EAAB-token-principal-1234567890';
const T2 = 'EAAB-token-segundo-bm-0987654321';
const config = mergeConfig({
  portfolios: [
    { id: 'principal', name: 'Principal', accounts: [{ id: 'act_11111', name: 'Uno', currency: 'COP', timezone: 'America/Bogota' }] },
    { id: 'bm-dos', name: 'BM dos', accounts: [{ id: 'act_22222', name: 'Dos', currency: 'USD', timezone: 'America/Mexico_City' }, { id: 'act_33333', name: 'Tres' }] },
  ],
});
const tokens = { principal: T1, 'bm-dos': T2 };

const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const text = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => body });
const HEADER = '"Registrado el","Resultado","Teléfono cliente","Nombre cliente","Valor","Banco","Nombre pagador","Fecha comprobante","Flujo","ID anuncio","URL anuncio"';

// Each account has one ad named after it; `fail` makes the listed accounts answer with a Meta error.
function world({ fail = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'docs.google.com') return text(HEADER);
    const m = u.pathname.match(/\/(act_\d+)(\/[a-z]+)?$/);
    const account = m?.[1];
    calls.push({ account, path: m?.[2] ?? '', auth: init.headers?.Authorization, url: String(url) });
    if (fail[account]) return json({ error: { code: fail[account].code, message: `boom ${init.headers?.Authorization?.slice(7)}` } }, 400);
    if (m?.[2] === '/insights') {
      if (u.searchParams.get('level') === 'account') return json({ data: [{ date_start: '2026-10-20', spend: '10' }] });
      const range = JSON.parse(u.searchParams.get('time_range'));
      return json({ data: [{ date_start: range.until, ad_id: `ad-${account}`, ad_name: `Ad ${account}`, campaign_id: 'c', campaign_name: 'CT01', adset_id: 's', adset_name: 'S', country: 'CO', spend: '100', impressions: '1', clicks: '1', actions: [] }] });
    }
    if (m?.[2] === '/ads') return json({ data: [{ id: `ad-${account}`, name: `Ad ${account}`, created_time: '2026-10-25T10:00:00-0500', effective_status: 'ACTIVE', campaign_id: 'c', adset_id: 's', campaign: { name: 'CT01', id: 'c' }, adset: { name: 'S', id: 's', daily_budget: '1000' } }] });
    if (m?.[2] === '/activities') return json({ data: [] });
    return json({ name: `Cuenta ${account}`, timezone_name: account === 'act_22222' ? 'America/Mexico_City' : 'America/Bogota', currency: account === 'act_22222' ? 'USD' : 'COP', account_status: 1 });
  };
  return { fetchImpl, calls };
}
const now = () => Date.parse('2026-10-29T15:00:00Z');
const base = { config, tokens, from: '2026-10-28', to: '2026-10-29', now };

test('each account is synced with its own portfolio token and stored under its account id', async () => {
  const store = createStore();
  const w = world();
  const out = await runSync({ ...base, store, fetchImpl: w.fetchImpl, targets: targetsFor(config, parseAccountsArg('act_11111,act_22222', config)) });
  assert.equal(out.meta.ok, true);
  assert.deepEqual(out.accounts.map((a) => [a.accountId, a.ok]), [['act_11111', true], ['act_22222', true]]);
  assert.ok(w.calls.filter((c) => c.account === 'act_11111').every((c) => c.auth === `Bearer ${T1}`));
  assert.ok(w.calls.filter((c) => c.account === 'act_22222').every((c) => c.auth === `Bearer ${T2}`));
  assert.equal(w.calls.some((c) => c.account === 'act_33333'), false, 'unselected accounts are never queried');
  assert.deepEqual(store.insightsBetween('2026-10-28', '2026-10-29').map((r) => [r.adId, r.accountId]).sort(), [['ad-act_11111', 'act_11111'], ['ad-act_22222', 'act_22222']]);
  assert.equal(store.adsMap()['ad-act_22222'].accountId, 'act_22222');
  assert.equal(store.getKv('account:act_22222').currency, 'USD');
  assert.equal(store.getKv('account:act_11111').name, 'Cuenta act_11111');
  assert.ok(w.calls.filter((c) => c.path === '/ads').every((c) => !/DELETED/.test(decodeURIComponent(c.url))), 'DELETED is never requested');
});

test('one failing account does not abort the others and is reported by account without leaking tokens', async () => {
  const store = createStore();
  const w = world({ fail: { act_11111: { code: 190 } } });
  const out = await runSync({ ...base, store, fetchImpl: w.fetchImpl });
  const by = Object.fromEntries(out.accounts.map((a) => [a.accountId, a]));
  assert.equal(by.act_11111.ok, false);
  assert.equal(by.act_22222.ok, true);
  assert.equal(by.act_33333.ok, true);
  assert.equal(out.meta.ok, false);
  assert.equal(out.meta.partial, true);
  assert.equal(store.insightsBetween('2026-10-28', '2026-10-29').length, 2);
  assert.equal(JSON.stringify(out).includes(T1), false);
  assert.equal(JSON.stringify(out).includes(T2), false);
  const last = store.getKv('lastSync');
  assert.equal(last.accounts.act_11111.ok, false);
  assert.equal(last.accounts.act_22222.ok, true);
  assert.ok(last.meta, 'a partial success still counts as a refresh');
});

test('a portfolio without a token only fails its own accounts', async () => {
  const store = createStore();
  const out = await runSync({ ...base, tokens: { principal: T1 }, store, fetchImpl: world().fetchImpl });
  const by = Object.fromEntries(out.accounts.map((a) => [a.accountId, a]));
  assert.equal(by.act_11111.ok, true);
  assert.equal(by.act_22222.code, 'NO_TOKEN');
  assert.match(by.act_22222.error, /token/i);
});

test('a legacy single token still syncs the old single account', async () => {
  const store = createStore();
  const legacy = mergeConfig({});
  const out = await runSync({ config: legacy, token: T1, store, from: '2026-10-28', to: '2026-10-29', now, fetchImpl: world().fetchImpl });
  assert.equal(out.meta.ok, true);
  assert.equal(out.meta.insightRows, 1);
  assert.deepEqual(out.accounts.map((a) => a.accountId), [legacy.adAccountId]);
});

test('auto sync keeps one backfill per account: a new account backfills while the others only refresh', async () => {
  const store = createStore();
  const first = world();
  const out1 = await runAutoSync({ store, config, tokens, targets: targetsFor(config, parseAccountsArg('act_11111', config)), fetchImpl: first.fetchImpl, now });
  assert.equal(out1.backfilled, true);
  assert.ok(store.getKv('backfillDone:act_11111'));
  assert.equal(store.getKv('backfillDone:act_22222'), null);

  const second = world();
  const out2 = await runAutoSync({ store, config, tokens, targets: targetsFor(config, parseAccountsArg('act_11111,act_22222', config)), fetchImpl: second.fetchImpl, now });
  assert.equal(out2.backfilled, true, 'the new account backfills');
  assert.ok(store.getKv('backfillDone:act_22222'));
  const ranges = (account) => second.calls.filter((c) => c.account === account && c.path === '/insights' && c.url.includes('time_range')).map((c) => JSON.parse(new URL(c.url).searchParams.get('time_range')));
  assert.ok(ranges('act_11111').every((r) => r.since >= '2026-10-25'), 'the first account only refreshes its last days');
  assert.equal(ranges('act_22222')[0].since, '2026-10-20', 'the new account backfills from its first spend');
  assert.equal(second.calls.some((c) => c.account === 'act_33333'), false);
});

test('a tick snapshots every account with its own token and tolerates one failing', async () => {
  const store = createStore();
  const w = world({ fail: { act_33333: { code: 190 } } });
  const out = await runTick({ store, config, tokens, fetchImpl: w.fetchImpl, now, force: true });
  assert.equal(out.snapshot, true);
  assert.ok(out.warnings.some((x) => /Token/i.test(x)));
  assert.equal(store.adsMap()['ad-act_22222'].accountId, 'act_22222');
  assert.ok(w.calls.filter((c) => c.account === 'act_22222').every((c) => c.auth === `Bearer ${T2}`));
});

test('decisions see spend in the base currency: other-currency accounts are converted, removed ones left out, missing rates excluded with a warning', () => {
  const store = createStore();
  const row = (adId, gasto) => ({ date: '2026-10-28', adId, adName: adId, campaignId: 'c', campaignName: 'C', adsetId: 's', adsetName: 'S', gasto, impressions: 1, clicks: 1, mensajes: 1, country: 'CO' });
  store.upsertInsights([row('a', 100)], 1, 'act_11111');
  store.upsertInsights([row('b', 10)], 1, 'act_22222'); // USD
  store.upsertInsights([row('x', 999)], 1, 'act_99999'); // removed from the config
  store.upsertInsights([row('l', 5)], 1, ''); // legacy row without account
  const usd = mergeConfig({ portfolios: [{ id: 'principal', name: 'P', accounts: [{ id: 'act_11111', currency: 'COP' }, { id: 'act_22222', currency: 'USD' }] }] });
  store.saveFxRate({ currency: 'USD', date: '2026-10-01', rate: 4000, fetchedAt: 1, source: 't' });
  const ok = tickInsights(store, usd);
  assert.deepEqual(ok.rows.map((r) => [r.adId, r.gasto]).sort(), [['a', 100], ['b', 40000], ['l', 5]]);
  assert.deepEqual(ok.warnings, []);
  const none = tickInsights(createStore(), usd);
  assert.deepEqual(none.rows, []);
  const noRate = createStore();
  noRate.upsertInsights([row('b', 10)], 1, 'act_22222');
  const missing = tickInsights(noRate, usd);
  assert.deepEqual(missing.rows, []);
  assert.match(missing.warnings[0], /USD/);
});
