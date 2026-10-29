import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ALERTS_DEFAULTS, AlertsConfigError, loadAlertsConfig, mergeAlertsConfig, saveAlertsConfig } from './alerts-config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-config-'));

test('defaults: alert-only, sheet as sales source, nothing linked, monitor thresholds', () => {
  assert.equal(ALERTS_DEFAULTS.salesSource, 'sheet');
  assert.equal(ALERTS_DEFAULTS.allowActions, false);
  assert.equal(ALERTS_DEFAULTS.mode, 'alert_only');
  assert.equal(ALERTS_DEFAULTS.whatsapp.senderPhone, '');
  assert.equal(ALERTS_DEFAULTS.thresholds.targetCpa, 2500);
  assert.equal(ALERTS_DEFAULTS.pollMinutes, 15);
  assert.equal(ALERTS_DEFAULTS.budgetChangeMaxPct, 20);
});

test('mergeAlertsConfig overlays valid values, including nested thresholds', () => {
  const c = mergeAlertsConfig({ pollMinutes: 10, thresholds: { targetCpa: 3000, reviewCpa: 6000 }, activeHours: { start: 8, end: 22 }, campaignPrefix: 'CT', salesSource: 'both' });
  assert.equal(c.pollMinutes, 10);
  assert.equal(c.thresholds.targetCpa, 3000);
  assert.equal(c.thresholds.frequencyMax, 2.5);
  assert.deepEqual(c.activeHours, { start: 8, end: 22 });
  assert.equal(c.salesSource, 'both');
});

test('thresholds are validated together (target below review, worry below action)', () => {
  assert.throws(() => mergeAlertsConfig({ thresholds: { targetCpa: 9000 } }), AlertsConfigError);
  assert.throws(() => mergeAlertsConfig({ thresholds: { gapWorryMin: 90 } }), /minutos/i);
  assert.throws(() => mergeAlertsConfig({ thresholds: { frequencyMax: 0 } }), /mayor que cero/i);
  assert.throws(() => mergeAlertsConfig({ thresholds: { frequencyMax: 'x' } }), AlertsConfigError);
  assert.equal(mergeAlertsConfig({ thresholds: { targetCpa: 3000, reviewCpa: 6000 } }).thresholds.reviewCpa, 6000);
});

test('rejects out-of-range schedules, odd sources and secrets', () => {
  assert.throws(() => mergeAlertsConfig({ pollMinutes: 0 }), /sondeo/i);
  assert.throws(() => mergeAlertsConfig({ activeHours: { start: 25, end: 3 } }), /horas/i);
  assert.throws(() => mergeAlertsConfig({ salesSource: 'telepatia' }), /fuente/i);
  assert.throws(() => mergeAlertsConfig({ whatsapp: { alertTo: '123' } }), /número/i);
  assert.throws(() => mergeAlertsConfig({ metaToken: 'abc' }), /token/i);
  assert.throws(() => mergeAlertsConfig({ whatsapp: { password: 'x' } }), /token|secreto/i);
});

test('phones are normalized to digits (Colombian mobiles get 57)', () => {
  const c = mergeAlertsConfig({ whatsapp: { senderPhone: '300 123 4567', alertTo: '+57 316 758 5233' } });
  assert.equal(c.whatsapp.senderPhone, '573001234567');
  assert.equal(c.whatsapp.alertTo, '573167585233');
  assert.equal(mergeAlertsConfig({ whatsapp: { alertTo: '' } }).whatsapp.alertTo, '');
});

test('the mode cannot be forced from the outside', () => {
  assert.equal(mergeAlertsConfig({ mode: 'autonomous' }).mode, 'alert_only');
  assert.equal(mergeAlertsConfig({ allowActions: true }).allowActions, true);
});

test('save/load round trip with atomic write and a backup', () => {
  const dir = tmp();
  assert.deepEqual(loadAlertsConfig(dir), ALERTS_DEFAULTS);
  saveAlertsConfig(dir, { pollMinutes: 20 });
  saveAlertsConfig(dir, { pollMinutes: 30, whatsapp: { alertTo: '573167585233' } }, { now: () => new Date('2026-10-29T12:00:00Z') });
  const loaded = loadAlertsConfig(dir);
  assert.equal(loaded.pollMinutes, 30);
  assert.equal(loaded.whatsapp.alertTo, '573167585233');
  assert.equal(fs.readdirSync(path.join(dir, 'ads', 'backups')).filter((f) => f.startsWith('alerts-config-')).length, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'ads')).some((f) => f.endsWith('.tmp')), false);
});

test('a broken file falls back to the defaults', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'ads'));
  fs.writeFileSync(path.join(dir, 'ads', 'alerts-config.json'), '{oops');
  assert.deepEqual(loadAlertsConfig(dir), ALERTS_DEFAULTS);
});
