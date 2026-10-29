import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG } from './config.js';
import { ACTIONS, computeMetrics, suggestAction } from './metrics.js';

const T = DEFAULT_CONFIG.thresholds;

test('computeMetrics follows the Apps Script formulas', () => {
  const m = computeMetrics({ gasto: 20000, valor: 60000, ventas: 4, mensajes: 40 });
  assert.equal(m.resultado, 40000);
  assert.equal(m.roas, 3);
  assert.equal(m.costoMensaje, 500);
  assert.equal(m.ticket, 15000);
  assert.equal(m.conversion, 0.1);
  assert.equal(m.costoVenta, 5000);
});

test('computeMetrics returns 0 whenever the divisor is 0', () => {
  const m = computeMetrics({ gasto: 0, valor: 15000, ventas: 0, mensajes: 0 });
  assert.equal(m.roas, 0);
  assert.equal(m.costoMensaje, 0);
  assert.equal(m.ticket, 0);
  assert.equal(m.conversion, 0);
  assert.equal(m.costoVenta, 0);
  assert.equal(m.resultado, 15000);
});

test('suggestAction waits while spend is below the minimum', () => {
  assert.equal(suggestAction({ gasto: 14999, roas: 5, ventas: 9 }, T).key, 'wait');
  assert.equal(suggestAction({ gasto: 0, roas: 0, ventas: 0 }, T).label, 'Esperar');
});

test('suggestAction ladder', () => {
  const a = (roas, ventas = 0, gasto = 15000) => suggestAction({ gasto, roas, ventas }, T);
  assert.equal(a(3, 3).label, 'Escalar y duplicar');
  assert.equal(a(3, 2).label, 'Escalar');
  assert.equal(a(2.5, 1).label, 'Escalar');
  assert.equal(a(2).label, 'Escalar');
  assert.equal(a(1.99).label, 'Mantener');
  assert.equal(a(1.3).label, 'Mantener');
  assert.equal(a(1.29).label, 'Vigilar');
  assert.equal(a(1).label, 'Vigilar');
  assert.equal(a(0.99).label, 'Apagar');
  assert.equal(a(0).label, 'Apagar');
});

test('suggestAction honours custom thresholds', () => {
  const custom = { ...T, minSpend: 1000, scaleRoas: 4 };
  assert.equal(suggestAction({ gasto: 1000, roas: 3.5, ventas: 1 }, custom).label, 'Mantener');
  assert.equal(suggestAction({ gasto: 999, roas: 9, ventas: 9 }, custom).label, 'Esperar');
});

test('actions expose a tone for the UI', () => {
  assert.equal(ACTIONS.off.tone, 'red');
  assert.equal(ACTIONS.duplicate.tone, 'green');
  assert.equal(ACTIONS.watch.tone, 'amber');
});
