import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanAdId, extractCt, maskPhone, parseCsv, parseDateToIso, parseMoney, normalizeText } from './parse.js';

test('parseCsv handles quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
  const text = '\uFEFFa,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n1,2,3\r\n';
  assert.deepEqual(parseCsv(text), [
    ['a', 'b', 'c'],
    ['x, y', 'he said "hi"', 'line1\nline2'],
    ['1', '2', '3'],
  ]);
});

test('parseCsv keeps empty cells and drops fully empty trailing lines', () => {
  assert.deepEqual(parseCsv('a,,c\n,,\n'), [['a', '', 'c']]);
  assert.deepEqual(parseCsv(''), []);
});

test('parseMoney understands Colombian and US formats', () => {
  assert.equal(parseMoney('15.000'), 15000);
  assert.equal(parseMoney('25.000,00'), 25000);
  assert.equal(parseMoney('1,234.50'), 1234.5);
  assert.equal(parseMoney('1.234.567'), 1234567);
  assert.equal(parseMoney('$ 14.000'), 14000);
  assert.equal(parseMoney('15,000'), 15000);
  assert.equal(parseMoney('12,5'), 12.5);
  assert.equal(parseMoney('12.50'), 12.5);
  assert.equal(parseMoney('9999'), 9999);
  assert.equal(parseMoney(15000), 15000);
});

test('parseMoney returns 0 for blanks and garbage', () => {
  for (const v of ['', '  ', null, undefined, 'abc', '-']) assert.equal(parseMoney(v), 0);
});

test('parseDateToIso reads dd/mm/yyyy with optional time, ISO and Date-like strings', () => {
  assert.equal(parseDateToIso('30/09/2026 23:38:28'), '2026-09-30');
  assert.equal(parseDateToIso('1/10/2026 0:01:13'), '2026-10-01');
  assert.equal(parseDateToIso('13/09/2026 19:08'), '2026-09-13');
  assert.equal(parseDateToIso('05/03/2026'), '2026-03-05');
  assert.equal(parseDateToIso('2026-10-28'), '2026-10-28');
  assert.equal(parseDateToIso('2026-10-28T14:00:00'), '2026-10-28');
  assert.equal(parseDateToIso('2026-10-28 14:00'), '2026-10-28');
  assert.equal(parseDateToIso(new Date(2026, 9, 28, 14, 0)), '2026-10-28');
});

test('parseDateToIso rejects impossible and empty dates', () => {
  for (const v of ['', null, undefined, 'hola', '31/02/2026', '32/01/2026', '00/10/2026']) assert.equal(parseDateToIso(v), null);
});

test('cleanAdId keeps digits, treats blanks and scientific notation as unknown', () => {
  assert.equal(cleanAdId('52552450147137'), '52552450147137');
  assert.equal(cleanAdId(' 5255 2450147137 '), '52552450147137');
  assert.equal(cleanAdId("'52552450147137"), '52552450147137');
  assert.equal(cleanAdId(''), '');
  assert.equal(cleanAdId(null), '');
  assert.equal(cleanAdId('1.20242E+17'), '');
  assert.equal(cleanAdId('5.2552E+13'), '');
});

test('extractCt normalizes CT codes', () => {
  assert.equal(extractCt('CT01 - ventas'), 'CT 01');
  assert.equal(extractCt('CT 02'), 'CT 02');
  assert.equal(extractCt('[ct3] x'), 'CT 03');
  assert.equal(extractCt('Bebidas CT-12 - ventas'), 'CT 12');
  assert.equal(extractCt('CT 105'), 'CT 105');
  assert.equal(extractCt('ACT01'), null);
  assert.equal(extractCt('Campaña sin código'), null);
  assert.equal(extractCt(''), null);
  assert.equal(extractCt(undefined), null);
});

test('maskPhone shows only the last four digits', () => {
  assert.equal(maskPhone('573001234567'), '••••4567');
  assert.equal(maskPhone('+57 300 123 4567'), '••••4567');
  assert.equal(maskPhone('12'), '••12');
  assert.equal(maskPhone(''), '');
});

test('normalizeText strips accents and case', () => {
  assert.equal(normalizeText('  Pago VÁLIDO '), 'pago valido');
});

test('extractCt matches the whole CT number and normalizes it (CT10 is never CT01)', async () => {
  const { extractCt: ct } = await import('./parse.js');
  for (const name of ['CT1', 'CT01', 'CT 01', 'CT-1', 'CT_001', 'ct 1 - ventas', 'CT 01 Col 2']) assert.equal(ct(name), 'CT 01', name);
  for (const name of ['CT10', 'CT 10', 'CT 10 col2', 'CT-10 - ventas', 'ct010']) assert.equal(ct(name), 'CT 10', name);
  assert.equal(ct('CT100'), 'CT 100');
  assert.equal(ct('CT 105 test'), 'CT 105');
  assert.equal(ct('CT 07 Col 2 - ventas'), 'CT 07');
  assert.notEqual(ct('CT10 Col 2'), ct('CT01 Col 2'));
});

test('extractCt needs a word boundary and digits: CTX, XCT01 and ACT01 are not CT codes', async () => {
  const { extractCt: ct } = await import('./parse.js');
  for (const name of ['CTX', 'XCT01', 'ACT01', 'CT', 'CT final', 'Campaña CTA 2', '']) assert.equal(ct(name), null, name);
  assert.equal(ct('[CT-12] prueba'), 'CT 12');
  assert.equal(ct('Bebidas · CT 03'), 'CT 03');
});

test('parseCt flags an ambiguous name like "CT 1 0" instead of silently trusting it', async () => {
  const { parseCt } = await import('./parse.js');
  assert.deepEqual(parseCt('CT 1 0'), { ct: 'CT 01', ambiguous: true });
  assert.deepEqual(parseCt('CT 01 2 - ventas'), { ct: 'CT 01', ambiguous: true });
  assert.deepEqual(parseCt('CT 10 Col 2'), { ct: 'CT 10', ambiguous: false });
  assert.deepEqual(parseCt('CT 01 2026'), { ct: 'CT 01', ambiguous: false }, 'a year is not a second number');
  assert.deepEqual(parseCt('Sin código'), { ct: null, ambiguous: false });
});

test('extractCt falls back to the next name when the first has no CT', async () => {
  const { extractCt: ct } = await import('./parse.js');
  assert.equal(ct('Campaña sin código', 'CT 04 col2 - ventas'), 'CT 04');
  assert.equal(ct(undefined, null, 'CT-9'), 'CT 09');
});
