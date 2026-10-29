// Pure parsing helpers for the payments sheet and campaign names. No I/O.

export const normalizeText = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

// RFC 4180 CSV: quoted cells, doubled quotes, newlines inside quotes, CRLF, BOM. Fully empty lines are dropped.
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((c) => c !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') endRow();
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}

// "15.000" -> 15000, "25.000,00" -> 25000, "1,234.50" -> 1234.5, "$ 14.000" -> 14000. Garbage -> 0.
export function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let s = String(value ?? '').replace(/[^\d.,-]/g, '');
  const negative = s.startsWith('-');
  s = s.replace(/-/g, '');
  if (!/\d/.test(s)) return 0;
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  let decimalSep = null;
  if (dots && commas) decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  else if (dots + commas === 1) {
    const sep = dots ? '.' : ',';
    const tail = s.length - s.indexOf(sep) - 1;
    // Exactly three digits after a lone separator is a thousands group ("15.000"); otherwise it is a decimal.
    decimalSep = tail === 3 && s.indexOf(sep) > 0 ? null : sep;
  }
  let digits = s;
  if (decimalSep) {
    const at = s.lastIndexOf(decimalSep);
    digits = `${s.slice(0, at).replace(/[.,]/g, '')}.${s.slice(at + 1).replace(/[.,]/g, '')}`;
  } else digits = s.replace(/[.,]/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

const pad = (n) => String(n).padStart(2, '0');

function validYmd(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1970 || y > 2200) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// Calendar date (YYYY-MM-DD, wall clock as written, no timezone shifting) or null.
export function parseDateToIso(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]|$)/.exec(s);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]|$)/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  return null;
}

// Ad id from the sheet: digits only. Empty means "Sin anuncio". Scientific notation ("1.2E+17")
// lost its digits when Sheets formatted the number, so it is treated as unknown.
export function cleanAdId(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(s)) return '';
  return s.replace(/\D/g, '');
}

// "CT01 - ventas" / "ct 1" / "[CT-12]" -> "CT 01" / "CT 01" / "CT 12". null when there is no code.
export function extractCt(...names) {
  for (const name of names) {
    const m = /(?:^|[^A-Za-z])CT\s*-?\s*(\d{1,3})(?!\d)/i.exec(String(name ?? ''));
    if (m) return `CT ${m[1].padStart(2, '0')}`;
  }
  return null;
}

export function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return `••${digits.length > 2 ? '••' : ''}${digits.slice(-4)}`;
}
