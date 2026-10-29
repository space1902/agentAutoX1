import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaApi, MetaApiError, parseUsage, parseAccessTier, BACKOFF_CODES } from './meta-api.js';

const TOKEN = 'SECRET_TOKEN_123';

function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body ?? {},
    };
  };
  fn.calls = calls;
  return fn;
}

const make = (responses, extra = {}) => {
  let t = 1_000_000;
  const fetchImpl = fakeFetch(responses);
  const times = [];
  const timedFetch = async (url, opts) => {
    times.push(t);
    return fetchImpl(url, opts);
  };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); t += ms; };
  const api = new MetaApi({ token: TOKEN, fetchImpl: timedFetch, now: () => t, sleep, ...extra });
  return { api, fetchImpl, times, sleeps, advance: (ms) => { t += ms; } };
};

test('GET uses the versioned Graph URL, sends the token in a header and never in the URL', async () => {
  const { api, fetchImpl } = make([{ body: { data: [1] } }]);
  const out = await api.get('/act_1/insights', { fields: 'a,b', time_range: { since: '2026-10-20', until: '2026-10-24' } });
  assert.deepEqual(out, { data: [1] });
  const { url, opts } = fetchImpl.calls[0];
  assert.ok(url.startsWith('https://graph.facebook.com/v26.0/act_1/insights?'));
  assert.ok(url.includes('fields=a%2Cb'));
  assert.ok(url.includes(encodeURIComponent('{"since":"2026-10-20","until":"2026-10-24"}')));
  assert.ok(!url.includes(TOKEN));
  assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`);
});

test('graph version is configurable', async () => {
  const { api, fetchImpl } = make([{ body: {} }], { version: 'v99.0' });
  await api.get('/me');
  assert.ok(fetchImpl.calls[0].url.includes('/v99.0/me'));
});

test('getAll follows pagination', async () => {
  const { api, fetchImpl } = make([
    { body: { data: [1, 2], paging: { next: 'https://graph.facebook.com/v26.0/act_1/insights?after=X' } } },
    { body: { data: [3] } },
  ]);
  assert.deepEqual(await api.getAll('/act_1/insights', {}), [1, 2, 3]);
  assert.equal(fetchImpl.calls.length, 2);
});

test('getAll refuses to follow a next link to another host', async () => {
  const { api } = make([{ body: { data: [1], paging: { next: 'https://evil.example/steal' } } }]);
  await assert.rejects(() => api.getAll('/x', {}), /host/i);
});

test('parseUsage reads ad account, business use case and app headers', () => {
  assert.equal(parseUsage(new Headers({ 'x-ad-account-usage': '{"acc_id_util_pct":42}' })).pct, 42);
  const buc = JSON.stringify({ '123': [{ type: 'ads_insights', call_count: 80, total_cputime: 10, total_time: 20, estimated_time_to_regain_access: 0 }] });
  assert.equal(parseUsage(new Headers({ 'x-business-use-case-usage': buc })).pct, 80);
  assert.equal(parseUsage(new Headers({ 'x-app-usage': '{"call_count":12,"total_time":30}' })).pct, 30);
  assert.equal(parseUsage(new Headers({})).pct, 0);
  assert.equal(parseUsage(new Headers({ 'x-ad-account-usage': 'not json' })).pct, 0);
});

test('usage above 75% makes the next poll skip, once', async () => {
  const { api } = make([{ body: {}, headers: { 'x-ad-account-usage': '{"acc_id_util_pct":80}' } }]);
  await api.get('/x');
  assert.equal(api.usagePct, 80);
  assert.equal(api.shouldSkipPoll().skip, true);
  assert.equal(api.shouldSkipPoll().skip, false, 'only one poll is skipped');
});

test('usage below the limit does not skip', async () => {
  const { api } = make([{ body: {}, headers: { 'x-ad-account-usage': '{"acc_id_util_pct":60}' } }]);
  await api.get('/x');
  assert.equal(api.shouldSkipPoll().skip, false);
});

test('rate limit error codes trigger exponential backoff and reset on success', async () => {
  for (const code of [17, 80004, 613]) assert.ok(BACKOFF_CODES.has(code));
  const { api, advance } = make(
    [
      { status: 400, body: { error: { code: 17, message: 'User request limit reached' } } },
      { status: 400, body: { error: { code: 17, message: 'again' } } },
      { body: { ok: 1 } },
    ],
    { baseBackoffMs: 60_000, maxBackoffMs: 600_000 },
  );
  await assert.rejects(() => api.get('/x'), (e) => e instanceof MetaApiError && e.code === 17);
  assert.equal(api.shouldSkipPoll().skip, true);
  assert.equal(api.backoffMs, 60_000);
  advance(61_000);
  assert.equal(api.shouldSkipPoll().skip, false);
  await assert.rejects(() => api.get('/x'));
  assert.equal(api.backoffMs, 120_000);
  advance(121_000);
  await api.get('/x');
  assert.equal(api.backoffMs, 0);
  assert.equal(api.shouldSkipPoll().skip, false);
});

test('backoff is capped', async () => {
  const { api, advance } = make([{ status: 400, body: { error: { code: 613, message: 'x' } } }], { baseBackoffMs: 100_000, maxBackoffMs: 250_000 });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(() => api.get('/x'));
    advance(1_000_000);
  }
  assert.equal(api.backoffMs, 250_000);
});

test('other errors are thrown with code and a sanitized message', async () => {
  const { api } = make([{ status: 400, body: { error: { code: 2635, message: `bad token ${TOKEN}` } } }]);
  await assert.rejects(
    () => api.get('/x'),
    (e) => e.code === 2635 && !e.message.includes(TOKEN) && api.backoffMs === 0,
  );
});

test('readOnly mode refuses POST without touching the network', async () => {
  const { api, fetchImpl } = make([{ body: {} }], { readOnly: true });
  await assert.rejects(() => api.post('/a1', { status: 'PAUSED' }), /read-only/i);
  assert.equal(fetchImpl.calls.length, 0);
});

test('POST sends form-encoded body with the token in a header', async () => {
  const { api, fetchImpl } = make([{ body: { success: true } }]);
  await api.post('/a1', { status: 'PAUSED' });
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(opts.method, 'POST');
  assert.ok(!url.includes(TOKEN));
  assert.equal(opts.body, 'status=PAUSED');
  assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`);
});

test('MetaApiError keeps subcode, user title/message and is_transient, sanitized', async () => {
  const { api } = make([{
    status: 400,
    body: { error: {
      code: 100, error_subcode: 2446880, message: 'Invalid parameter', error_user_title: 'Se requiere un número de WhatsApp',
      error_user_msg: `Agrega un número ${TOKEN}`, is_transient: false,
    } },
  }]);
  await assert.rejects(
    () => api.post('/a1', { status: 'PAUSED' }),
    (e) => e instanceof MetaApiError && e.code === 100 && e.subcode === 2446880
      && e.userTitle === 'Se requiere un número de WhatsApp' && e.userMessage === 'Agrega un número ***'
      && e.isTransient === false && e.message === 'Invalid parameter',
  );
});

test('parseAccessTier reads ads_api_access_tier from the business use case header', () => {
  const buc = JSON.stringify({ '123': [{ type: 'ads_management', call_count: 1, ads_api_access_tier: 'development_access' }] });
  assert.equal(parseAccessTier(new Headers({ 'x-business-use-case-usage': buc })), 'development_access');
  assert.equal(parseAccessTier(new Headers({})), null);
});

test('the access tier is stored from responses and kept when a later response lacks it', async () => {
  const buc = JSON.stringify({ '123': [{ type: 'ads_management', call_count: 1, ads_api_access_tier: 'development_access' }] });
  const { api } = make([{ body: {}, headers: { 'x-business-use-case-usage': buc } }, { body: {} }]);
  assert.equal(api.accessTier, null);
  await api.get('/x');
  assert.equal(api.accessTier, 'development_access');
  await api.get('/y');
  assert.equal(api.accessTier, 'development_access');
});

test('writes are spaced at least 35 s apart and run sequentially', async () => {
  const { api, times, sleeps } = make([{ body: { success: true } }]);
  await Promise.all([api.post('/a', { status: 'PAUSED' }), api.post('/b', { status: 'PAUSED' }), api.post('/c', { status: 'PAUSED' })]);
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 35_000);
  assert.ok(times[2] - times[1] >= 35_000);
  assert.equal(sleeps.length, 2, 'the first write does not wait');
});

test('a failed write still counts for spacing and does not break the queue', async () => {
  const { api, times } = make([
    { status: 400, body: { error: { code: 100, message: 'bad' } } },
    { body: { success: true } },
  ]);
  const first = api.post('/a', {});
  const second = api.post('/b', {});
  await assert.rejects(() => first);
  await second;
  assert.ok(times[1] - times[0] >= 35_000);
});

test('reads are not delayed by the write queue', async () => {
  const { api, sleeps } = make([{ body: {} }]);
  await api.post('/a', {});
  await api.get('/x');
  assert.equal(sleeps.length, 0);
});
