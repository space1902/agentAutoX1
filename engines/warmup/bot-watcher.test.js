import test from 'node:test';
import assert from 'node:assert/strict';

import { createBotWatcher } from './bot-watcher.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

function setup(overrides = {}) {
  const state = { client: null, paused: false, now: 1_000_000, connects: 0, stops: 0, warnings: [] };
  const watcher = createBotWatcher({
    isPaused: () => state.paused,
    isShuttingDown: () => false,
    getClient: () => state.client,
    stopClient: async () => {
      state.stops++;
    },
    connect: overrides.connect ?? (async () => {
      state.connects++;
      state.client = { stopped: false };
    }),
    now: () => state.now,
    warn: (m) => state.warnings.push(m),
    retryMs: 5 * 60_000,
  });
  return { state, watcher };
}

test('a slow connect is not started twice by the next tick', async () => {
  const gate = deferred();
  let connects = 0;
  const { state, watcher } = setup({
    connect: async () => {
      connects++;
      await gate.promise;
      state.client = { stopped: false };
    },
  });

  const first = watcher.tick();
  await watcher.tick();
  await watcher.tick();
  assert.equal(connects, 1, 'only one socket is opened while the first connect is pending');

  gate.resolve();
  await first;
  await watcher.tick();
  assert.equal(connects, 1, 'a live client needs no new connect');
});

test('the guard is released when a connect fails, and a retry waits for the backoff', async () => {
  let connects = 0;
  const { state, watcher } = setup({
    connect: async () => {
      connects++;
      throw new Error('boom');
    },
  });

  await watcher.tick();
  assert.equal(connects, 1);
  assert.equal(state.warnings.length, 1);

  await watcher.tick();
  assert.equal(connects, 1, 'inside the backoff');

  state.now += 5 * 60_000 + 1;
  await watcher.tick();
  assert.equal(connects, 2);
});

test('while paused it closes the socket and never connects', async () => {
  const { state, watcher } = setup();
  state.paused = true;
  state.client = { stopped: false };
  await watcher.tick();
  assert.equal(state.stops, 1);
  assert.equal(state.connects, 0);

  state.client = { stopped: true };
  await watcher.tick();
  assert.equal(state.connects, 0);
});

test('it reconnects after a pause ends and does nothing during shutdown', async () => {
  const { state, watcher } = setup();
  state.client = { stopped: true };
  await watcher.tick();
  assert.equal(state.connects, 1);

  const down = createBotWatcher({
    isPaused: () => false,
    isShuttingDown: () => true,
    getClient: () => null,
    stopClient: async () => {},
    connect: async () => {
      throw new Error('must not connect');
    },
  });
  await down.tick();
});
