import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SheetError, fetchSheetCsv, isValidResult, matchesFlow, parseComprobantes, sheetCsvUrl } from './sheet.js';

const HEADER =
  '"Registrado el","Resultado","Teléfono cliente","Nombre cliente","Valor","Banco","Nombre pagador","Documento pagador","Nombre destinatario","Documento destinatario","Cuenta / llave destino","Cuenta identificada","Fecha comprobante","Respuesta IA","Error IA","Flujo","ID anuncio","URL anuncio","ID clic WhatsApp","","",""';

const row = (o) => {
  const cols = {
    reg: '30/09/2026 23:38:28', res: 'Pago válido', phone: '573001234567', name: 'Ana', valor: '15.000', bank: 'Nequi', payer: 'Ana P',
    date: '30/09/2026 10:56', flow: 'Bebidas - aporte', ad: '52552450147137', url: 'https://fb.me/x', ...o,
  };
  return `"${cols.reg}","${cols.res}","${cols.phone}","${cols.name}","${cols.valor}","${cols.bank}","${cols.payer}","","","","","","${cols.date}","","","${cols.flow}","${cols.ad}","${cols.url}","click",,,`;
};

const csv = (...rows) => [HEADER, ...rows].join('\r\n');

test('parseComprobantes maps columns by header name and ignores blank trailing headers', () => {
  const { rows } = parseComprobantes(csv(row({})));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    registered: '30/09/2026 23:38:28',
    date: '2026-09-30',
    result: 'Pago válido',
    phone: '573001234567',
    clientName: 'Ana',
    payerName: 'Ana P',
    valor: 15000,
    bank: 'Nequi',
    flow: 'Bebidas - aporte',
    adId: '52552450147137',
    adLossy: false,
    adUrl: 'https://fb.me/x',
  });
});

test('date comes from Fecha comprobante and falls back to Registrado el', () => {
  const { rows } = parseComprobantes(csv(row({ date: '' , reg: '1/10/2026 0:01:13' }), row({ date: '13/09/2026 19:08' })));
  assert.equal(rows[0].date, '2026-10-01');
  assert.equal(rows[1].date, '2026-09-13');
});

test('rows with PRUEBA in result, name, payer or flow are ignored and counted', () => {
  const out = parseComprobantes(
    csv(
      row({ res: 'PRUEBA - borrar' }),
      row({ name: 'prueba maria' }),
      row({ payer: 'Cuenta Prueba' }),
      row({ flow: 'Bebidas prueba' }),
      row({}),
    ),
  );
  assert.equal(out.rows.length, 1);
  assert.equal(out.skippedTests, 4);
});

test('rows without any usable date are dropped', () => {
  const out = parseComprobantes(csv(row({ date: '', reg: '' }), row({})));
  assert.equal(out.rows.length, 1);
  assert.equal(out.skippedNoDate, 1);
});

test('payloads without value still load (they are review rows, not sales)', () => {
  const { rows } = parseComprobantes(csv(row({ res: 'payload_invalido', valor: '', ad: '', phone: '', bank: '' })));
  assert.equal(rows[0].valor, 0);
  assert.equal(rows[0].adId, '');
});

test('scientific notation ad ids are flagged as lossy and left empty', () => {
  const { rows } = parseComprobantes(csv(row({ ad: '5.2552E+13' })));
  assert.equal(rows[0].adId, '');
  assert.equal(rows[0].adLossy, true);
});

test('parseComprobantes fails with a friendly error on HTML or missing columns', () => {
  assert.throws(() => parseComprobantes('<!DOCTYPE html><html>login</html>'), SheetError);
  assert.throws(() => parseComprobantes('"a","b"\n1,2'), /columna/i);
  assert.throws(() => parseComprobantes(''), SheetError);
});

test('isValidResult compares ignoring case and accents', () => {
  assert.equal(isValidResult('Pago válido', 'Pago válido'), true);
  assert.equal(isValidResult('PAGO VALIDO', 'Pago válido'), true);
  assert.equal(isValidResult('Comprobante inválido', 'Pago válido'), false);
  assert.equal(isValidResult('', 'Pago válido'), false);
});

test('matchesFlow filters by prefix, empty prefix accepts all', () => {
  assert.equal(matchesFlow('Bebidas - aporte', 'Bebidas'), true);
  assert.equal(matchesFlow('bebidas - downsell', 'Bebidas'), true);
  assert.equal(matchesFlow('Barf Whats', 'Bebidas'), false);
  assert.equal(matchesFlow('Barf Whats', ''), true);
  assert.equal(matchesFlow('', 'Bebidas'), false);
});

test('sheetCsvUrl builds the public gviz export', () => {
  assert.equal(
    sheetCsvUrl('abc123', 'Comprobantes'),
    'https://docs.google.com/spreadsheets/d/abc123/gviz/tq?tqx=out%3Acsv&sheet=Comprobantes',
  );
  assert.match(sheetCsvUrl('abc123', 'Mi hoja'), /sheet=Mi%20hoja$/);
});

test('fetchSheetCsv returns text and maps HTTP failures to friendly errors', async () => {
  const ok = await fetchSheetCsv({ sheetId: 'abc123', tab: 'T', fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'a,b' }) });
  assert.equal(ok, 'a,b');
  await assert.rejects(
    fetchSheetCsv({ sheetId: 'abc123', tab: 'T', fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) }),
    /No se pudo leer la hoja/,
  );
  await assert.rejects(
    fetchSheetCsv({ sheetId: 'abc123', tab: 'T', fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
    /No se pudo leer la hoja/,
  );
});

test('the client (chat) name and the payer (voucher) name are read from their own columns', () => {
  const { rows } = parseComprobantes(csv(row({ name: 'Luis Chat', payer: 'Maria Titular' }), row({ reg: '01/10/2026 10:00:00', name: '', payer: '' })));
  assert.equal(rows[0].clientName, 'Luis Chat');
  assert.equal(rows[0].payerName, 'Maria Titular');
  assert.equal(rows[1].clientName, '');
  assert.equal(rows[1].payerName, '');
});
