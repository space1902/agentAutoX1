// Pure comparator of an answer against numbers computed from the real data at run time (never stored answers).
// Tolerances per kind: money 1 % (or $1), ratio 0,015 absolute (answers show 2 decimals), pct 0,6 points, count exact.
import { extractFigures } from '../grounding.js';

export const TOLERANCE = Object.freeze({
  money: (v) => Math.max(1, Math.abs(v) * 0.01),
  ratio: () => 0.015,
  pct: () => 0.6,
  count: () => 0,
});

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');

function figureMatches(figure, expected) {
  const tol = (TOLERANCE[expected.kind] ?? TOLERANCE.money)(expected.value);
  for (const r of figure.readings) {
    let v = Math.abs(r.value) * figure.scale;
    // "35 %" for a pct, or "0,35" never passes as a pct: percentages must be written as such.
    if (expected.kind === 'pct' && !figure.percent && v <= 1.5 && Math.abs(expected.value) > 1.5) v *= 100;
    if (Math.abs(v - Math.abs(expected.value)) <= tol + 1e-9) return true;
    if (expected.kind === 'count' && figure.scale === 1 && v === Math.abs(expected.value)) return true;
  }
  return false;
}

/**
 * @param {string} answer
 * @param {{ label: string, value: number, kind: 'money'|'ratio'|'pct'|'count' }[]} numbers every one must appear
 * @param {string[]} mention names that must be written (accent/case-insensitive)
 */
export function compareAnswer(answer, numbers = [], mention = []) {
  const figures = extractFigures(answer);
  const matched = [];
  const missing = [];
  for (const n of numbers) (figures.some((f) => figureMatches(f, n)) ? matched : missing).push(n);
  const text = norm(answer).replace(/ct\s*-?\s*0*(\d+)/g, (_m, d) => `ct ${d.padStart(2, '0')}`);
  const missingNames = mention.filter((m) => !text.includes(norm(m).replace(/ct\s*-?\s*0*(\d+)/g, (_x, d) => `ct ${d.padStart(2, '0')}`)));
  return { pass: missing.length === 0 && missingNames.length === 0 && (numbers.length > 0 || mention.length > 0), matched, missing, missingNames };
}

export function describeExpected(numbers = [], mention = []) {
  return [...numbers.map((n) => `${n.label}: ${n.value}`), ...mention.map((m) => `debe mencionar «${m}»`)].join(' · ');
}
