// Figure grounding (adapted from Leasify's chat-verificacion): every number in the final answer must appear in the
// turn's tool results or in the user's own message. Pure code, no model: unverified figures are MARKED, never deleted.
//
// Formats understood: 1.234.567 · 1,234,567 · 2,62 · 2.62 · $15.000 · 35 % · 15 mil · 1,5 M. Dates, times, years,
// CT codes and list numbering are not figures. A figure matches a source value when it is equal, equal after
// rounding to the decimals written, or (for percentages) equal to the ratio times 100.

const NBSP = '  ';
const EPS = 1e-9;

// Characters replaced by spaces so that dates, times, codes and list markers are never read as figures.
function maskNonFigures(text) {
  return String(text ?? '')
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/g, (m) => ' '.repeat(m.length))
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, (m) => ' '.repeat(m.length))
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, (m) => ' '.repeat(m.length))
    .replace(/\b(?:19|20)\d{2}\b(?![.,]\d)/g, (m) => ' '.repeat(m.length))
    .replace(/\bCT\s*-?\s*\d{1,3}\b/gi, (m) => ' '.repeat(m.length))
    .replace(/\bact_\d+\b/gi, (m) => ' '.repeat(m.length))
    .replace(/^(\s*)\d{1,2}[.)](?=\s)/gm, (m, lead) => `${lead}${' '.repeat(m.length - lead.length)}`);
}

const NUMBER = new RegExp(
  `(?<![\\w.,])(?:US\\$|\\$)?\\s?(\\d{1,3}(?:[.,${NBSP}]\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?)(?!\\d)(?:\\s?(%|mil\\b|k\\b|M\\b|millones?\\b))?`,
  'g',
);

// All plausible numeric readings of "1.234", "1,234", "2,62", "1.234.567,5"...
function readings(token) {
  const text = token.replace(new RegExp(`[${NBSP}]`, 'g'), '.');
  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  const out = new Map(); // value -> decimals
  const add = (value, decimals) => {
    if (Number.isFinite(value)) out.set(value, decimals);
  };
  if (dots && commas) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const at = text.lastIndexOf(decimal);
    add(Number(`${text.slice(0, at).replace(/[.,]/g, '')}.${text.slice(at + 1)}`), text.length - at - 1);
  } else if (dots + commas > 1) {
    add(Number(text.replace(/[.,]/g, '')), 0); // 1.234.567
  } else if (dots + commas === 1) {
    const sep = dots ? '.' : ',';
    const at = text.indexOf(sep);
    const tail = text.length - at - 1;
    add(Number(`${text.slice(0, at)}.${text.slice(at + 1)}`), tail); // decimal reading: 2,62 / 1.5 / 1.500
    if (tail === 3) add(Number(text.replace(sep, '')), 0); // thousands reading: 15.000 / 1,234
  } else add(Number(text), 0);
  return [...out.entries()].map(([value, decimals]) => ({ value, decimals }));
}

/** @returns {{ raw: string, start: number, end: number, readings: {value:number, decimals:number}[], percent: boolean, scale: number }[]} */
export function extractFigures(text) {
  const source = String(text ?? '');
  const masked = maskNonFigures(source);
  const out = [];
  for (const m of masked.matchAll(NUMBER)) {
    const unit = m[2] ?? '';
    const percent = unit === '%';
    const scale = /^(mil|k)$/i.test(unit) ? 1e3 : /^(M|millones?)$/i.test(unit) ? 1e6 : 1;
    const start = m.index + m[0].indexOf(m[1]);
    const rawEnd = m.index + m[0].length;
    out.push({ raw: source.slice(start, rawEnd).trim(), start, end: rawEnd, readings: readings(m[1]), percent, scale });
  }
  return out;
}

// Numbers present in a source: JSON-style numbers plus localized figures inside text (reasons, labels).
export function sourceValues(texts) {
  const values = new Set();
  const addValue = (v) => {
    if (Number.isFinite(v)) values.add(Math.abs(v));
  };
  for (const text of texts) {
    const raw = String(text ?? '');
    for (const m of raw.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) addValue(Number(m[0]));
    for (const f of extractFigures(raw)) for (const r of f.readings) addValue(r.value * f.scale);
  }
  return [...values];
}

const roundTo = (v, d) => Number(v.toFixed(Math.min(Math.max(d, 0), 20)));
const close = (a, b) => Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));

function matches(figure, values) {
  for (const { value, decimals } of figure.readings) {
    const v = Math.abs(value);
    for (const s of values) {
      const bases = figure.percent ? [s, s * 100] : [s];
      for (const base of bases) {
        const scaled = figure.scale === 1 ? base : base / figure.scale;
        if (close(v, scaled) || close(v, roundTo(scaled, decimals))) return true;
        // Abbreviations ("15 mil") round to what is written; allow half a unit of the last written place.
        if (figure.scale > 1 && Math.abs(v - scaled) <= 0.5 * 10 ** -decimals + EPS) return true;
      }
    }
  }
  return false;
}

/**
 * Figures of `answer` that appear in none of the sources.
 * @param {string} answer
 * @param {(string | null | undefined)[]} sources tool results, the user's message, earlier tool results of the session
 * @returns {{ raw: string, start: number, end: number }[]}
 */
export function ungroundedFigures(answer, sources) {
  const values = sourceValues(sources);
  return extractFigures(answer)
    .filter((f) => !matches(f, values))
    .map(({ raw, start, end }) => ({ raw, start, end }));
}

export const uniqueRaw = (figures) => [...new Set(figures.map((f) => f.raw))];
