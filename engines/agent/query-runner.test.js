import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStore } from '../ads/store.js';
import { runQuery } from './query-runner.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-'));
  const file = path.join(dir, 'ads.db');
  const store = createStore(file);
  const rows = [];
  for (let d = 1; d <= 28; d++) {
    for (let a = 0; a < 10; a++) {
      rows.push({
        date: `2026-09-${String(d).padStart(2, '0')}`, adId: `ad${a}`, adName: `Video ${a}`, campaignId: 'c', campaignName: 'CT07 Colombia', adsetId: 's', adsetName: 'S',
        gasto: 1000 + d, impressions: 10, clicks: 1, mensajes: 1, country: 'CO',
      });
    }
  }
  store.upsertInsights(rows, 1);
  store.close();
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test('runs a validated query and caps the rows', async () => {
  const { file, cleanup } = fixture();
  try {
    const ok = await runQuery(file, 'SELECT ct, SUM(spend) AS spend FROM v_ads_daily GROUP BY ct');
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.columns, ['ct', 'spend']);
    assert.equal(ok.rows[0].ct, 'CT 07');
    const capped = await runQuery(file, 'SELECT * FROM v_ads_daily', { maxRows: 50 });
    assert.equal(capped.rowCount, 50);
    assert.equal(capped.truncated, true);
  } finally {
    cleanup();
  }
});

test('refuses internal tables and never reaches the database', async () => {
  const { file, cleanup } = fixture();
  try {
    const res = await runQuery(file, 'SELECT * FROM insights');
    assert.equal(res.ok, false);
    assert.equal(res.rejected, true);
    assert.equal(res.layer, 'relaciones');
  } finally {
    cleanup();
  }
});

test('extra statements smuggled after the query never execute (read-only connection)', async () => {
  const { file, cleanup } = fixture();
  try {
    const { runWorker } = await import('./query-runner.js');
    // Bypasses the guard on purpose: the layers behind it must hold on their own.
    const res = await runWorker(file, 'SELECT 1) ; DELETE FROM insights; SELECT * FROM (SELECT 1');
    assert.equal(res.ok, true);
    const count = await runQuery(file, 'SELECT COUNT(*) AS n FROM v_ads_daily');
    assert.equal(count.rows[0].n, 280);
  } finally {
    cleanup();
  }
});

test('a runaway query is cancelled by the timeout', async () => {
  const { file, cleanup } = fixture();
  try {
    const res = await runQuery(
      file,
      'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000000) SELECT SUM(i) FROM n',
      { timeoutMs: 300 },
    );
    assert.equal(res.ok, false);
    assert.equal(res.timeout, true);
    assert.equal(res.layer, 'tiempo');
  } finally {
    cleanup();
  }
});
