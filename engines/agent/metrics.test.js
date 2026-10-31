import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDataset, MetricsError, normalizeCt, runMetric, windowMetrics } from './metrics.js';
import { makeDataDir } from './seed-fixture.js';

const withData = (fn) => {
  const fx = makeDataDir();
  try {
    return fn(loadDataset(fx.dataDir, fx.now));
  } finally {
    fx.cleanup();
  }
};

test('kpis match the hand-computed totals for a CT', () => {
  withData((ds) => {
    const res = runMetric(ds, { kind: 'kpis', ct: 'CT07', from: '2026-10-01', to: '2026-10-10' });
    assert.equal(res.alcance, 'CT 07');
    assert.equal(res.totales.gasto, 100000);
    assert.equal(res.totales.ventas, 10);
    assert.equal(res.totales.ingresos, 300000);
    assert.equal(res.totales.roas, 3);
    assert.equal(res.totales.costo_por_venta, 10000);
  });
});

test('the table returns one row per CT with the suggested action', () => {
  withData((ds) => {
    const res = runMetric(ds, { kind: 'table', group: 'ct', from: '2026-10-01', to: '2026-10-10' });
    const byLabel = Object.fromEntries(res.filas.map((r) => [r.etiqueta, r]));
    assert.equal(byLabel['CT 07'].roas, 3);
    assert.equal(byLabel['CT 07'].accion_sugerida, 'Escalar y duplicar');
    assert.equal(byLabel['CT 08'].roas, 0.6);
    assert.equal(byLabel['CT 08'].accion_sugerida, 'Apagar');
    assert.equal(res.totales.gasto, 150000);
  });
});

test('daily series has one point per day', () => {
  withData((ds) => {
    const res = runMetric(ds, { kind: 'daily', ct: 'ct 08', from: '2026-10-01', to: '2026-10-04' });
    assert.deepEqual(res.dias.map((d) => d.ventas), [0, 1, 0, 1]);
  });
});

test('lifecycle counts day 1 as the first day with spend', () => {
  withData((ds) => {
    const res = runMetric(ds, { kind: 'lifecycle', ct: 'CT07' });
    assert.equal(res.anuncios[0].dia_n_hoy, 11);
    assert.equal(res.anuncios[0].primer_dia_con_gasto, '2026-10-01');
  });
});

test('budget_compare reuses the app verdict rule', () => {
  withData((ds) => {
    const res = runMetric(ds, { kind: 'budget_compare', ct: 'CT07' });
    assert.equal(res.total_cambios, 1);
    const c = res.cambios[0];
    assert.equal(c.fecha_cambio, '2026-10-06');
    assert.equal(c.subida_pct, 20);
    assert.equal(c.antes.roas, 3);
    assert.equal(c.despues.roas, 3);
    assert.match(c.veredicto_app, /Subir más/);
  });
});

test('countries table and bad inputs fail with friendly errors', () => {
  withData((ds) => {
    assert.equal(runMetric(ds, { kind: 'countries', from: '2026-10-01', to: '2026-10-10' }).paises[0].pais, 'CO');
    assert.throws(() => runMetric(ds, { kind: 'nope' }), MetricsError);
    assert.throws(() => runMetric(ds, { kind: 'kpis', ct: 'abc' }), /CT/);
    assert.throws(() => runMetric(ds, { kind: 'kpis', from: '2026-13-40', to: '2026-10-01' }), /fechas/);
    assert.throws(() => runMetric(ds, { kind: 'kpis', country: 'COLOMBIA' }), /país/);
    assert.throws(() => runMetric(ds, { kind: 'kpis', ct: 'CT 99' }), /No hay datos/);
  });
});

test('windowMetrics aggregates the ads of any entity type', () => {
  withData((ds) => {
    const byCt = windowMetrics(ds, { entityType: 'ct', entityId: 'CT 07', from: '2026-10-01', to: '2026-10-03' });
    const byAdset = windowMetrics(ds, { entityType: 'adset', entityId: 's1', from: '2026-10-01', to: '2026-10-03' });
    assert.equal(byCt.gasto, 30000);
    assert.equal(byCt.roas, 3);
    assert.equal(byAdset.ventas, 3);
    assert.equal(windowMetrics(ds, { entityType: 'ad', entityId: 'zzz', from: '2026-10-01', to: '2026-10-03' }), null);
  });
});

test('normalizeCt', () => {
  assert.equal(normalizeCt('ct7'), 'CT 07');
  assert.equal(normalizeCt(undefined), null);
});

test('the agent metrics use the spend WITH IVA (ROAS and cost per sale included)', () => {
  const fx = makeDataDir({ vatPct: 19 });
  try {
    const res = runMetric(loadDataset(fx.dataDir, fx.now), { kind: 'kpis', ct: 'CT07', from: '2026-10-01', to: '2026-10-10' });
    assert.equal(res.totales.gasto, 119000);
    assert.equal(res.totales.roas, 300000 / 119000 > 2.52 && 300000 / 119000 < 2.53 ? res.totales.roas : -1);
    assert.equal(res.totales.costo_por_venta, 11900);
  } finally {
    fx.cleanup();
  }
});
