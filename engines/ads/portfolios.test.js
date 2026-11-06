import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeConfig } from './config.js';
import {
  PRINCIPAL_ID, SelectionError, accountsOf, allTokens, parseAccountsArg, redactAll, slugify, targetsFor, tokenEnvName, tokenFor,
} from './portfolios.js';

const cfg = () => mergeConfig({
  portfolios: [
    { id: 'principal', name: 'Principal', accounts: [{ id: 'act_11111', name: 'Uno', currency: 'COP', timezone: 'America/Bogota' }] },
    { id: 'otro-bm', name: 'Otro', accounts: [{ id: 'act_22222', name: 'Dos', currency: 'USD' }, { id: 'act_33333', name: 'Tres' }] },
  ],
});

test('token env names derive from the slug and never collide', () => {
  assert.equal(tokenEnvName('principal'), 'AGENTAUTO_META_TOKEN__PRINCIPAL');
  assert.equal(tokenEnvName('otro-bm'), 'AGENTAUTO_META_TOKEN__OTRO_BM');
});

test('tokenFor reads the per-portfolio variable; only principal falls back to the legacy one', () => {
  const env = { AGENTAUTO_META_TOKEN: 'legacy-token-value-123456', AGENTAUTO_META_TOKEN__OTRO_BM: ' bm-token-value-1234567 ' };
  assert.equal(tokenFor(env, 'principal'), 'legacy-token-value-123456');
  assert.equal(tokenFor(env, 'otro-bm'), 'bm-token-value-1234567');
  assert.equal(tokenFor(env, 'tercero'), '');
  assert.deepEqual(allTokens(env, cfg()), { principal: 'legacy-token-value-123456', 'otro-bm': 'bm-token-value-1234567' });
});

test('redactAll scrubs every token from a message', () => {
  assert.equal(redactAll('fail abc-token-1 and def-token-2', ['abc-token-1', 'def-token-2', '']), 'fail *** and ***');
});

test('slugify makes a valid slug from a name', () => {
  assert.equal(slugify('Leasefy S.A.S — BM #2'), 'leasefy-s-a-s-bm-2');
  assert.equal(slugify('   '), 'portafolio');
  assert.ok(slugify('x'.repeat(100)).length <= 40);
});

test('accountsOf flattens the portfolios with their owner', () => {
  const list = accountsOf(cfg());
  assert.deepEqual(list.map((a) => [a.accountId, a.portfolioId, a.currency]), [['act_11111', 'principal', 'COP'], ['act_22222', 'otro-bm', 'USD'], ['act_33333', 'otro-bm', '']]);
});

test('parseAccountsArg: all by default, strict list otherwise', () => {
  const c = cfg();
  assert.equal(parseAccountsArg(undefined, c).all, true);
  assert.equal(parseAccountsArg('all', c).all, true);
  assert.equal(parseAccountsArg('act_11111,act_22222,act_33333', c).all, true, 'every account selected = all');
  const some = parseAccountsArg('act_22222, act_11111', c);
  assert.equal(some.all, false);
  assert.deepEqual(some.ids, ['act_22222', 'act_11111']);
  assert.throws(() => parseAccountsArg('act_99999', c), SelectionError);
  assert.throws(() => parseAccountsArg('act_11111;calc', c), SelectionError);
  assert.throws(() => parseAccountsArg('11111', c), SelectionError);
  assert.equal(parseAccountsArg('', c).all, true, 'an empty value is all, never an empty list');
});

test('targetsFor resolves selected accounts with their portfolio; legacy configs still sync the old account', () => {
  const c = cfg();
  assert.deepEqual(targetsFor(c, parseAccountsArg('act_33333', c)).map((t) => [t.accountId, t.portfolioId]), [['act_33333', 'otro-bm']]);
  assert.equal(targetsFor(c, parseAccountsArg('all', c)).length, 3);
  const legacy = mergeConfig({});
  const t = targetsFor(legacy, parseAccountsArg('all', legacy));
  assert.deepEqual(t.map((x) => [x.accountId, x.portfolioId]), [[legacy.adAccountId, PRINCIPAL_ID]]);
});
