import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeConfig } from './config.js';
import { fetchRateToCop, pickRate, refreshFxRates, resolveRate } from './fx.js';
import { createStore } from './store.js';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const ER = (cop, unix = 1793664151) => json({ result: 'success', time_last_update_unix: unix, base_code: 'MXN', rates: { MXN: 1, COP: cop, USD: 0.05 } });
const FAWAZ = (cop, date = '2026-11-02') => json({ date, mxn: { cop, usd: 0.05 } });

// A fetch that answers per host and records the calls.
function router(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push(String(url));
    const u = new URL(url);
    const handler = routes[u.hostname];
    if (!handler) throw new Error(`no route for ${u.hostname}`);
    return handler(u, init);
  };
}

test('fetchRateToCop reads the primary source (COP per 1 unit of the currency)', async () => {
  const calls = [];
  const r = await fetchRateToCop('mxn', { fetchImpl: router({ 'open.er-api.com': () => ER(170.66) }, calls) });
  assert.equal(r.rate, 170.66);
  assert.equal(r.source, 'open.er-api.com');
  assert.equal(r.rateDate, '2026-11-03');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /latest\/MXN$/);
});

test('fetchRateToCop falls back to the jsdelivr copy, then to the pages.dev mirror', async () => {
  const bad = () => json({}, 500);
  const viaJsdelivr = await fetchRateToCop('MXN', { fetchImpl: router({ 'open.er-api.com': bad, 'cdn.jsdelivr.net': () => FAWAZ(169.5) }) });
  assert.deepEqual([viaJsdelivr.rate, viaJsdelivr.source, viaJsdelivr.rateDate], [169.5, 'currency-api (jsdelivr)', '2026-11-02']);
  const calls = [];
  const viaMirror = await fetchRateToCop('MXN', {
    fetchImpl: router({ 'open.er-api.com': bad, 'cdn.jsdelivr.net': bad, 'latest.currency-api.pages.dev': () => FAWAZ(171) }, calls),
  });
  assert.deepEqual([viaMirror.rate, viaMirror.source], [171, 'currency-api (pages.dev)']);
  assert.equal(calls.length, 3);
  assert.match(calls[2], /currencies\/mxn\.json$/);
});

test('fetchRateToCop ignores nonsense payloads and throws when every source fails', async () => {
  const garbage = () => json({ result: 'success', rates: { COP: 'abc' } });
  const zero = () => json({ date: '2026-11-02', mxn: { cop: 0 } });
  await assert.rejects(
    fetchRateToCop('MXN', {
      fetchImpl: router({
        'open.er-api.com': garbage,
        'cdn.jsdelivr.net': zero,
        'latest.currency-api.pages.dev': () => {
          throw new Error('offline');
        },
      }),
    }),
    /No pude obtener la tasa/,
  );
});

test('fetchRateToCop gives up on a source that never answers (short timeout, abort signal)', async () => {
  const hang = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const started = Date.now();
  const r = await fetchRateToCop('MXN', { timeoutMs: 40, fetchImpl: router({ 'open.er-api.com': hang, 'cdn.jsdelivr.net': () => FAWAZ(168) }) });
  assert.equal(r.rate, 168);
  assert.ok(Date.now() - started < 2000);
});

test('pickRate uses the latest rate on or before the day, the earliest one before any, null when empty', () => {
  const h = [{ date: '2026-10-30', rate: 100 }, { date: '2026-11-01', rate: 110 }, { date: '2026-11-03', rate: 120 }];
  assert.equal(pickRate(h, '2026-11-02').rate, 110);
  assert.equal(pickRate(h, '2026-11-03').rate, 120);
  assert.equal(pickRate(h, '2026-12-01').rate, 120);
  assert.equal(pickRate(h, '2026-10-01').rate, 100);
  assert.equal(pickRate([], '2026-10-01'), null);
  assert.equal(pickRate(undefined, '2026-10-01'), null);
});

test('resolveRate: COP is 1, auto uses the saved day rate, manual is the fallback and the override', () => {
  const cfg = mergeConfig({ countries: { MX: { rateToCop: 200 } } });
  const fx = { MXN: [{ date: '2026-11-01', rate: 170 }, { date: '2026-11-03', rate: 172 }] };
  assert.deepEqual(resolveRate(cfg, 'CO', '2026-11-02', fx), { rate: 1, set: true, mode: 'cop' });
  assert.deepEqual(resolveRate(cfg, 'MX', '2026-11-02', fx), { rate: 170, set: true, mode: 'auto', date: '2026-11-01' });
  assert.equal(resolveRate(cfg, 'MX', '2026-10-01', fx).rate, 170, 'days before any saved rate use the earliest known');
  assert.deepEqual(resolveRate(cfg, 'MX', '2026-11-02', {}), { rate: 200, set: true, mode: 'manual' });
  const off = mergeConfig({ countries: { MX: { rateToCop: 200, autoRate: false } } });
  assert.deepEqual(resolveRate(off, 'MX', '2026-11-02', fx), { rate: 200, set: true, mode: 'manual' });
  const none = mergeConfig({});
  assert.deepEqual(resolveRate(none, 'MX', '2026-11-02', {}), { rate: 1, set: false, mode: 'none' });
});

test('refreshFxRates saves one rate per day per currency with fetch time and source', async () => {
  const store = createStore();
  const cfg = mergeConfig({ enabledCountries: ['CO', 'MX', 'VE'], countries: { VE: { currency: 'USD' } } });
  const calls = [];
  const fetchImpl = router({ 'open.er-api.com': (u) => ER(u.pathname.endsWith('MXN') ? 170 : 4000) }, calls);
  const out = await refreshFxRates({ store, config: cfg, today: '2026-11-03', fetchImpl, now: () => 1000 });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.rates.map((r) => r.currency).sort(), ['MXN', 'USD']);
  assert.equal(calls.length, 2, 'COP is never fetched');
  assert.deepEqual(store.fxRates().MXN, [{ date: '2026-11-03', rate: 170, fetchedAt: 1000, source: 'open.er-api.com' }]);
  // A second refresh the same day replaces that day's rate instead of adding rows.
  await refreshFxRates({ store, config: cfg, today: '2026-11-03', fetchImpl: router({ 'open.er-api.com': () => ER(171) }), now: () => 2000 });
  assert.deepEqual(store.fxRates().MXN, [{ date: '2026-11-03', rate: 171, fetchedAt: 2000, source: 'open.er-api.com' }]);
  // A new day appends; the old day keeps its own rate.
  await refreshFxRates({ store, config: cfg, today: '2026-11-04', fetchImpl: router({ 'open.er-api.com': () => ER(173) }), now: () => 3000 });
  assert.deepEqual(store.fxRates().MXN.map((r) => [r.date, r.rate]), [['2026-11-03', 171], ['2026-11-04', 173]]);
});

test('refreshFxRates keeps the last saved rate and reports a warning when every source fails', async () => {
  const store = createStore();
  const cfg = mergeConfig({ enabledCountries: ['CO', 'MX'] });
  store.saveFxRate({ currency: 'MXN', date: '2026-11-02', rate: 169, fetchedAt: 5, source: 'open.er-api.com' });
  const down = async () => {
    throw new Error('offline');
  };
  const out = await refreshFxRates({ store, config: cfg, today: '2026-11-03', fetchImpl: down, now: () => 9 });
  assert.equal(out.rates.length, 0);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].currency, 'MXN');
  assert.equal(store.fxRates().MXN.length, 1);
});

test('refreshFxRates skips countries that are disabled or use the manual rate, and never throws', async () => {
  const store = createStore();
  const cfg = mergeConfig({ enabledCountries: ['CO', 'MX', 'VE'], countries: { MX: { autoRate: false }, VE: { currency: 'USD' } } });
  const calls = [];
  const out = await refreshFxRates({ store, config: cfg, today: '2026-11-03', fetchImpl: router({ 'open.er-api.com': () => ER(4000) }, calls), now: () => 1 });
  assert.deepEqual(out.rates.map((r) => r.currency), ['USD']);
  assert.equal(calls.length, 1);
  const onlyCo = await refreshFxRates({
    store,
    config: mergeConfig({}),
    today: '2026-11-03',
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
    now: () => 1,
  });
  assert.deepEqual(onlyCo, { rates: [], errors: [] });
});
