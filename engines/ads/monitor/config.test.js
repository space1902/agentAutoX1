import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, saveConfig, applyThreshold, resolveThresholdName, mergeConfig } from './config.js';

test('defaults match the agreed thresholds', () => {
  const c = DEFAULT_CONFIG;
  assert.equal(c.mode, 'alert_only');
  assert.equal(c.killSwitch, false);
  assert.equal(c.campaignPrefix, 'CT');
  assert.equal(c.pollMinutes, 15);
  assert.equal(c.graphVersion, 'v26.0');
  assert.equal(c.thresholds.targetCpa, 2500);
  assert.equal(c.thresholds.reviewCpa, 5000);
  assert.equal(c.thresholds.gapWorryMin, 45);
  assert.equal(c.thresholds.gapActionMin, 60);
  assert.deepEqual(c.activeHours, { start: 7, end: 23 });
  assert.equal(c.cooldownMin, 60);
  assert.equal(c.requestTtlMin, 120);
  assert.equal(c.budgetChangeMaxPct, 20);
});

test('mergeConfig overlays partial files on the defaults without mutating them', () => {
  const merged = mergeConfig({ thresholds: { targetCpa: 3000 }, mode: 'alert_only' });
  assert.equal(merged.thresholds.targetCpa, 3000);
  assert.equal(merged.thresholds.reviewCpa, 5000);
  assert.equal(DEFAULT_CONFIG.thresholds.targetCpa, 2500);
});

test('loadConfig returns defaults when the file is missing and saveConfig round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const file = join(dir, 'config.json');
  assert.equal(loadConfig(file).thresholds.targetCpa, 2500);
  const cfg = mergeConfig({ thresholds: { targetCpa: 2800 } });
  saveConfig(file, cfg);
  assert.equal(loadConfig(file).thresholds.targetCpa, 2800);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).thresholds);
});

test('loadConfig rejects a broken file with a clear error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, '{ nope');
  assert.throws(() => loadConfig(file), /config/i);
});

test('resolveThresholdName accepts Spanish aliases, accents and canonical names', () => {
  assert.equal(resolveThresholdName('revisar'), 'reviewCpa');
  assert.equal(resolveThresholdName('Objetivo'), 'targetCpa');
  assert.equal(resolveThresholdName('preocupación'), 'gapWorryMin');
  assert.equal(resolveThresholdName('accion'), 'gapActionMin');
  assert.equal(resolveThresholdName('frecuencia'), 'frequencyMax');
  assert.equal(resolveThresholdName('targetCpa'), 'targetCpa');
  assert.equal(resolveThresholdName('nada'), null);
});

test('applyThreshold sets a value without mutating the input', () => {
  const r = applyThreshold(DEFAULT_CONFIG, 'revisar', 3000);
  assert.equal(r.error, undefined);
  assert.equal(r.key, 'reviewCpa');
  assert.equal(r.config.thresholds.reviewCpa, 3000);
  assert.equal(DEFAULT_CONFIG.thresholds.reviewCpa, 5000);
});

test('applyThreshold validates', () => {
  assert.match(applyThreshold(DEFAULT_CONFIG, 'nada', 1).error, /unknown/);
  assert.match(applyThreshold(DEFAULT_CONFIG, 'revisar', -5).error, /positive/);
  assert.match(applyThreshold(DEFAULT_CONFIG, 'revisar', Number.NaN).error, /positive/);
  assert.match(applyThreshold(DEFAULT_CONFIG, 'objetivo', 6000).error, /target.*review/i);
  assert.match(applyThreshold(DEFAULT_CONFIG, 'revisar', 2000).error, /target.*review/i);
  assert.match(applyThreshold(DEFAULT_CONFIG, 'accion', 30).error, /worry.*action/i);
});
