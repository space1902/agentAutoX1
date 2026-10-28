import test from 'node:test';
import assert from 'node:assert/strict';

import { installConsoleFilter, shouldSilence } from './console-filter.js';

test('shouldSilence matches libsignal session rotation dumps only', () => {
  assert.equal(shouldSilence(['Closing session:', { a: 1 }]), true);
  assert.equal(shouldSilence(['Opening session:', {}]), true);
  assert.equal(shouldSilence(['Removing old closed session:', {}]), true);
  assert.equal(shouldSilence(['Closing open session in favor of incoming prekey bundle']), true);
  assert.equal(shouldSilence(['Migrating session to:', {}]), true);
  assert.equal(shouldSilence(['[tester1] ready']), false);
  assert.equal(shouldSilence([{ msg: 'Closing session:' }]), false);
  assert.equal(shouldSilence([]), false);
});

test('installConsoleFilter drops matching log/info/warn calls and passes the rest through', () => {
  const calls = [];
  const fake = {
    log: (...args) => calls.push(['log', ...args]),
    info: (...args) => calls.push(['info', ...args]),
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args]),
  };
  installConsoleFilter(fake);
  installConsoleFilter(fake); // idempotent

  fake.log('Closing session:', { secret: 1 });
  fake.info('Opening session:', {});
  fake.warn('Removing old closed session:', {});
  fake.log('hello', 1);
  fake.warn('careful');
  fake.error('Closing session:', 'errors always pass');

  assert.deepEqual(calls, [
    ['log', 'hello', 1],
    ['warn', 'careful'],
    ['error', 'Closing session:', 'errors always pass'],
  ]);
});
