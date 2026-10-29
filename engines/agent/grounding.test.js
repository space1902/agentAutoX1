import assert from 'node:assert/strict';
import test from 'node:test';

import { extractFigures, ungroundedFigures, uniqueRaw } from './grounding.js';

const tool = JSON.stringify({ kpis: { gasto: 1234567, valor: 3234000, roas: 2.6197, ventas: 12, costoVenta: 102880.58, margenPct: 0.3519 }, label: 'CT 07' });
const bad = (answer, sources = [tool]) => uniqueRaw(ungroundedFigures(answer, sources));

test('extracts figures in Latin and English formats', () => {
  const raws = extractFigures('Gastaste $1.234.567 y 1,234,567 más; ROAS 2,62 y 2.62; 35 % y 15 mil y 1,5 M').map((f) => f.raw);
  assert.deepEqual(raws, ['1.234.567', '1,234,567', '2,62', '2.62', '35 %', '15 mil', '1,5 M']);
});

test('dates, times, years, CT codes and list numbers are not figures', () => {
  assert.deepEqual(extractFigures('El 2026-10-05 a las 20:00, en 2026 el CT 07 y CT07 (ver 12/10).'), []);
  assert.deepEqual(extractFigures('1. Primero\n2) Segundo'), []);
});

test('a figure that is in the tool result is grounded, whatever the format', () => {
  assert.deepEqual(bad('Gasto $1.234.567, ingresos 3.234.000, ROAS 2,62, 12 ventas.'), []);
  assert.deepEqual(bad('El gasto fue 1,234,567 y el ROAS 2.62.'), []);
  assert.deepEqual(bad('Costo por venta de $102.881 (102.880,58 exacto).'), []);
});

test('percentages match a ratio or a plain value', () => {
  assert.deepEqual(bad('Margen de 35,2 %.'), []);
  assert.deepEqual(bad('Margen de 35 %.'), []);
  assert.deepEqual(bad('Margen de 52 %.'), ['52 %']);
});

test('rounding to the written decimals is accepted, invented values are not', () => {
  assert.deepEqual(bad('ROAS 2,6'), []);
  assert.deepEqual(bad('ROAS 2,7'), ['2,7']);
  assert.deepEqual(bad('Vendiste 13 veces'), ['13']);
});

test('abbreviations "mil" and "M" compare against the real value', () => {
  assert.deepEqual(bad('Gastaste 1,2 M y ganaste 3,2 M.'), []);
  assert.deepEqual(bad('Cada venta costó 103 mil.'), []);
  assert.deepEqual(bad('Cada venta costó 200 mil.'), ['200 mil']);
});

test('the user message and earlier tool results count as sources', () => {
  assert.deepEqual(bad('Con tu umbral de 90 días, 12 ventas.', [tool, 'Dime los de más de 90 días']), []);
  assert.deepEqual(bad('En total 777 ventas.', [tool, JSON.stringify({ ventas: 777 })]), []);
});

test('numbers inside text reasons of the tools are sources too', () => {
  const reason = JSON.stringify({ reason: 'Tras subir 20 %: ROAS 2,6 (antes 3,1) con 4 ventas, +31 % en costo por venta.' });
  assert.deepEqual(bad('Tras la subida el ROAS fue 2,6 contra 3,1 y el costo subió 31 %.', [reason]), []);
});

test('negative values match their magnitude', () => {
  assert.deepEqual(bad('Bajó 20 % el ROAS.', [JSON.stringify({ pct: -20 })]), []);
});

test('reports the position so the UI can mark it', () => {
  const answer = 'Vendiste 99 pedidos.';
  const [f] = ungroundedFigures(answer, [tool]);
  assert.equal(answer.slice(f.start, f.end), '99');
});
