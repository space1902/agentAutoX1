// Payments sheet ("Comprobantes"): download as CSV through the public gviz export and normalize the rows.
import { cleanAdId, normalizeText, parseCsv, parseDateToIso, parseMoney } from './parse.js';

export class SheetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SheetError';
    this.code = 'SHEET';
  }
}

const COLUMNS = {
  registered: ['registrado el'],
  result: ['resultado'],
  phone: ['telefono cliente'],
  clientName: ['nombre cliente'],
  valor: ['valor'],
  bank: ['banco'],
  payerName: ['nombre pagador'],
  voucherDate: ['fecha comprobante'],
  flow: ['flujo'],
  adId: ['id anuncio'],
  adUrl: ['url anuncio'],
};
const REQUIRED = { result: 'Resultado', valor: 'Valor', flow: 'Flujo' };

export function sheetCsvUrl(sheetId, tab) {
  const query = `tqx=${encodeURIComponent('out:csv')}&sheet=${encodeURIComponent(tab)}`;
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?${query}`;
}

const unreadable = (detail) =>
  new SheetError(`No se pudo leer la hoja de pagos${detail ? ` (${detail})` : ''}. Revisa que esté compartida con «cualquier persona con el enlace» y que el ID y la pestaña sean correctos.`);

export async function fetchSheetCsv({ sheetId, tab, fetchImpl = globalThis.fetch }) {
  let response;
  try {
    response = await fetchImpl(sheetCsvUrl(sheetId, tab), { headers: { Accept: 'text/csv' }, redirect: 'follow' });
  } catch {
    throw unreadable('sin conexión');
  }
  if (!response.ok) throw unreadable(`HTTP ${response.status}`);
  return response.text();
}

// Rows of the sheet as plain objects. PRUEBA (test) rows are dropped; rows without any date are dropped.
export function parseComprobantes(csvText) {
  const head = String(csvText ?? '').trimStart().slice(0, 200).toLowerCase();
  if (!head) throw unreadable('la hoja llegó vacía');
  if (head.startsWith('<') || head.includes('<html')) throw unreadable('Google pidió iniciar sesión');

  const table = parseCsv(csvText);
  if (!table.length) throw unreadable('la hoja llegó vacía');
  const headers = table[0].map((h) => normalizeText(h));
  const index = {};
  for (const [field, names] of Object.entries(COLUMNS)) index[field] = headers.findIndex((h) => h && names.includes(h));
  for (const [field, label] of Object.entries(REQUIRED)) {
    if (index[field] === -1) throw new SheetError(`La hoja no tiene la columna «${label}». Revisa la pestaña configurada.`);
  }
  const cell = (r, field) => (index[field] >= 0 ? String(r[index[field]] ?? '').trim() : '');

  const rows = [];
  let skippedTests = 0;
  let skippedNoDate = 0;
  for (const r of table.slice(1)) {
    const result = cell(r, 'result');
    const flow = cell(r, 'flow');
    if ([result, flow, cell(r, 'clientName'), cell(r, 'payerName')].some((v) => normalizeText(v).includes('prueba'))) {
      skippedTests++;
      continue;
    }
    const date = parseDateToIso(cell(r, 'voucherDate')) ?? parseDateToIso(cell(r, 'registered'));
    if (!date) {
      skippedNoDate++;
      continue;
    }
    const rawAd = cell(r, 'adId');
    const adId = cleanAdId(rawAd);
    rows.push({
      registered: cell(r, 'registered'),
      date,
      result,
      phone: cell(r, 'phone'),
      clientName: cell(r, 'clientName'),
      payerName: cell(r, 'payerName'),
      valor: parseMoney(cell(r, 'valor')),
      bank: cell(r, 'bank'),
      flow,
      adId,
      adLossy: Boolean(rawAd) && !adId,
      adUrl: cell(r, 'adUrl'),
    });
  }
  return { rows, skippedTests, skippedNoDate };
}

export const isValidResult = (result, validResult) => {
  const a = normalizeText(result);
  return a !== '' && a === normalizeText(validResult);
};

export const matchesFlow = (flow, prefix) => {
  const p = normalizeText(prefix);
  if (!p) return true;
  return normalizeText(flow).startsWith(p);
};
