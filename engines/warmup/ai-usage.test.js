import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UsageLedger, localDateKey, summarize } from './ai-usage.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-'));
}

test('localDateKey formats the local calendar day', () => {
  assert.equal(localDateKey(new Date(2026, 9, 29, 23, 59)), '2026-10-29');
  assert.equal(localDateKey(new Date(2026, 0, 5, 0, 1)), '2026-01-05');
});

test('record accumulates per date and provider/model and persists atomically', () => {
  const dir = tempDir();
  const now = new Date(2026, 9, 29, 12, 0);
  const ledger = new UsageLedger(dir, { now: () => now });
  ledger.record({ provider: 'openai', model: 'gpt-5-nano', promptTokens: 1000, completionTokens: 50, usd: 0.00007 });
  ledger.record({ provider: 'openai', model: 'gpt-5-nano', promptTokens: 500, completionTokens: 20, usd: 0.00003 });

  const file = JSON.parse(fs.readFileSync(path.join(dir, 'ai-usage.json'), 'utf8'));
  assert.deepEqual(file['2026-10-29']['openai/gpt-5-nano'], {
    calls: 2,
    promptTokens: 1500,
    completionTokens: 70,
    usd: 0.0001,
  });
  assert.equal(ledger.todayUsd(), 0.0001);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('a new ledger reads what an earlier run saved', () => {
  const dir = tempDir();
  const now = () => new Date(2026, 9, 29, 12, 0);
  new UsageLedger(dir, { now }).record({ provider: 'p', model: 'm', promptTokens: 1, completionTokens: 1, usd: 0.5 });
  assert.equal(new UsageLedger(dir, { now }).todayUsd(), 0.5);
});

test('todayUsd ignores other days and a corrupt file starts empty', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'ai-usage.json'), '{broken');
  const yesterday = new UsageLedger(dir, { now: () => new Date(2026, 9, 28, 12) });
  assert.equal(yesterday.todayUsd(), 0);
  yesterday.record({ provider: 'p', model: 'm', promptTokens: 1, completionTokens: 1, usd: 2 });
  const today = new UsageLedger(dir, { now: () => new Date(2026, 9, 29, 12) });
  assert.equal(today.todayUsd(), 0);
});

test('summarize returns today and the last 7 days', () => {
  const dir = tempDir();
  let day = 20;
  const ledger = new UsageLedger(dir, { now: () => new Date(2026, 9, day, 12) });
  for (day = 20; day <= 29; day++) {
    ledger.record({ provider: 'p', model: 'm', promptTokens: 100, completionTokens: 10, usd: 1 });
  }
  const summary = summarize(dir, new Date(2026, 9, 29, 15));
  assert.equal(summary.todayUsd, 1);
  assert.equal(summary.days.length, 7);
  assert.equal(summary.days[0].date, '2026-10-23');
  assert.equal(summary.days[6].date, '2026-10-29');
  assert.equal(summary.last7Usd, 7);
  assert.equal(summary.todayCalls, 1);
});

test('old days are pruned after 60 days', () => {
  const dir = tempDir();
  const file = path.join(dir, 'ai-usage.json');
  fs.writeFileSync(file, JSON.stringify({ '2026-01-01': { 'p/m': { calls: 1, promptTokens: 1, completionTokens: 1, usd: 1 } } }));
  const ledger = new UsageLedger(dir, { now: () => new Date(2026, 9, 29, 12) });
  ledger.record({ provider: 'p', model: 'm', promptTokens: 1, completionTokens: 1, usd: 1 });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['2026-10-29']);
});
