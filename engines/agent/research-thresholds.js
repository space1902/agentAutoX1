// Pure rules of the Investigador: classify an ad count, estimate profitability, compare a prediction with what really
// happened and propose threshold changes. The numbers come from the skill investigacion-mercado (referencia-umbrales.md);
// they are DEFAULTS: a certified lesson with `evidence.thresholds` replaces them (see activeThresholds).
import { MIN_EVIDENCE, STRONG } from './distiller.js';

export const DEFAULT_THRESHOLDS = Object.freeze({
  // Active ads of a term (all countries, loose words): >= saturated is saturated, >= competitive is competitive, below it is a probable gap.
  saturated: 1000,
  competitive: 100,
  // With this many infoproducers or fewer, a big number is brands / restaurants / appliances: still a gap (demand to validate).
  gapInfoproducers: 1,
  // ROAS needed to call a launch a success / a failure (the Analista's rules).
  roasGood: 2,
  roasBad: 1,
  // The user's benchmarks, used only to ESTIMATE (Bebidas, Oct 2026): cost per message (in the benchmark currency) and message-to-sale conversion.
  benchmarks: Object.freeze({ currency: 'COP', costPerMessageLow: 246, costPerMessageHigh: 913, conversion: 0.03 }),
});

export const VERDICTS = Object.freeze(['saturado', 'competitivo', 'hueco']);
export const DECISIONS = Object.freeze(['entrar', 'validar', 'descartar']);

const num = (v) => (v === null || v === undefined || (typeof v === 'string' && !v.trim()) || !Number.isFinite(Number(v)) ? null : Number(v));

/** Merges overrides (from certified lessons) over the defaults; only known numeric keys survive. */
export function mergeThresholds(overrides = {}) {
  const out = { ...DEFAULT_THRESHOLDS, benchmarks: { ...DEFAULT_THRESHOLDS.benchmarks } };
  for (const key of ['saturated', 'competitive', 'gapInfoproducers', 'roasGood', 'roasBad']) {
    const v = num(overrides[key]);
    if (v !== null && v >= 0) out[key] = v;
  }
  if (out.competitive >= out.saturated) return { ...DEFAULT_THRESHOLDS, benchmarks: { ...DEFAULT_THRESHOLDS.benchmarks } }; // incoherent: keep the defaults
  return out;
}

/** The thresholds in force: the newest certified lesson that carries `evidence.thresholds`, else the defaults. */
export function activeThresholds(certified = []) {
  const withT = certified.filter((l) => l.evidence?.thresholds && l.status === 'certified').sort((a, b) => (b.certifiedAt ?? 0) - (a.certifiedAt ?? 0));
  return mergeThresholds(withT[0]?.evidence.thresholds ?? {});
}

/** saturado / competitivo / hueco for one measured term. `infoproducers` (optional) is how many real infoproducers fill the number. */
export function classify(count, { infoproducers, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const n = num(count);
  if (n === null || n < 0) throw new Error('El conteo debe ser un número mayor o igual a 0.');
  const t = thresholds;
  const byCount = n >= t.saturated ? 'saturado' : n >= t.competitive ? 'competitivo' : 'hueco';
  const ip = num(infoproducers);
  if (ip !== null && ip <= t.gapInfoproducers && byCount !== 'hueco') {
    return { verdict: 'hueco', byCount, reason: `El conteo (~${n}) lo llenan marcas y negocios: ${ip} infoproductor${ip === 1 ? '' : 'es'}. Hueco de infoproducto, con demanda por validar.` };
  }
  return { verdict: byCount, byCount, reason: `~${n} anuncios activos frente a los umbrales ${t.competitive} y ${t.saturated}.` };
}

/** Profitability estimate (an estimate, never a promise): CPA max = ticket / ROAS required; cost per sale = cost per message / conversion. */
export function estimateProfit({ ticket, currency, costPerMessage, conversion, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const tk = num(ticket);
  if (tk === null || tk <= 0) return { error: 'ticket debe ser un número mayor que 0.' };
  const b = thresholds.benchmarks;
  const conv = num(conversion) ?? b.conversion;
  if (!(conv > 0 && conv <= 1)) return { error: 'conversion debe estar entre 0 y 1 (por ejemplo 0.03).' };
  if (num(costPerMessage) !== null && !(num(costPerMessage) > 0)) return { error: 'cost_per_message debe ser mayor que 0.' };
  const cur = String(currency ?? '').trim().toUpperCase();
  // The cost-per-message benchmarks are in one currency: never compare them with a ticket in another one.
  if (num(costPerMessage) === null && cur && cur !== b.currency) {
    const cpaMax = Math.round((tk / thresholds.roasGood) * 100) / 100;
    return { ticket: tk, currency: cur, cpaMax, conversion: conv, needsCost: true, maxCostPerMessage: Math.round(cpaMax * conv * 100) / 100, verdict: 'sin_estimar' };
  }
  const cases = (cpm) => {
    const perSale = cpm / conv;
    const roas = tk / perSale;
    return { costPerMessage: cpm, costPerSale: Math.round(perSale), roas: Math.round(roas * 100) / 100, verdict: roas >= thresholds.roasGood ? 'viable' : roas >= thresholds.roasBad ? 'ajustado' : 'no_viable' };
  };
  const given = num(costPerMessage);
  const best = cases(given ?? b.costPerMessageLow);
  const worst = cases(given ?? b.costPerMessageHigh);
  return {
    ticket: tk, currency: cur || b.currency, cpaMax: Math.round(tk / thresholds.roasGood), conversion: conv, fromBenchmarks: given === null, best, worst,
    verdict: worst.verdict === 'viable' ? 'viable' : best.verdict === 'no_viable' ? 'no_viable' : 'ajustado',
  };
}

/** Real result of a launch from numbers the user gave: roas directly, or ticket / cost per message / conversion. */
export function resultFromInput(input = {}, thresholds = DEFAULT_THRESHOLDS) {
  let roas = num(input.roas);
  if (roas === null && num(input.ticket) > 0 && num(input.costPerMessage) > 0 && num(input.conversion) > 0) roas = input.ticket / (input.costPerMessage / input.conversion);
  if (roas === null) return { label: 'sin_datos', roas: null };
  const r = Math.round(roas * 100) / 100;
  return { label: r >= thresholds.roasGood ? 'acierto' : r < thresholds.roasBad ? 'fallo' : 'neutral', roas: r };
}

/** Did the report's decision match what happened? entrar / validar predicted a viable product, descartar the opposite. null = cannot tell. */
export function predictionHit({ decision, label }) {
  if (label !== 'acierto' && label !== 'fallo') return null;
  if (!DECISIONS.includes(decision)) return null;
  return (decision !== 'descartar') === (label === 'acierto');
}

const times = (k, n) => `${k} de ${n} ${n === 1 ? 'vez' : 'veces'}`;
const round10 = (n) => Math.max(10, Math.round(n / 10) * 10);

/**
 * Lesson candidates from launched products. `launches`: [{ id, verdict, decision, label, mainCount }] (only acierto / fallo count).
 * Deterministic with stable keys. Needs >= 3 cases; a threshold change needs every failure to sit above every success.
 */
export function proposeThresholdUpdates(launches, thresholds = DEFAULT_THRESHOLDS, { minEvidence = MIN_EVIDENCE, strong = STRONG } = {}) {
  const cases = launches.filter((l) => l.label === 'acierto' || l.label === 'fallo');
  if (cases.length < minEvidence) return { needed: minEvidence - cases.length, candidates: [] };
  const out = [];
  // 1) How reliable was each verdict class.
  const groups = new Map();
  for (const c of cases) {
    if (!VERDICTS.includes(c.verdict)) continue;
    const g = groups.get(c.verdict) ?? { acierto: 0, fallo: 0, ids: [] };
    g[c.label] += 1;
    g.ids.push(c.id);
    groups.set(c.verdict, g);
  }
  for (const [verdict, g] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const n = g.acierto + g.fallo;
    if (n < minEvidence) continue;
    const direction = g.fallo / n >= strong ? 'neg' : g.acierto / n >= strong ? 'pos' : null;
    if (!direction) continue;
    out.push({
      key: `invest:verdict:${verdict}:${direction}`, scope: `veredicto:${verdict}`, kind: 'rule', source: 'distiller', weight: n,
      text: direction === 'pos' ? `Los productos que el informe clasificó como «${verdict}» llegaron a ROAS de 2 o más en ${times(g.acierto, n)}.` : `Los productos que el informe clasificó como «${verdict}» quedaron con ROAS menor a 1 en ${times(g.fallo, n)}.`,
      evidence: { support: n, acierto: g.acierto, fallo: g.fallo, reportIds: g.ids },
    });
  }
  // 2) A threshold moves only when the evidence separates cleanly: every success has fewer ads than every failure.
  const counted = cases.filter((c) => num(c.mainCount) !== null);
  const wins = counted.filter((c) => c.label === 'acierto').map((c) => Number(c.mainCount));
  const losses = counted.filter((c) => c.label === 'fallo').map((c) => Number(c.mainCount));
  if (counted.length >= minEvidence && wins.length && losses.length && Math.min(...losses) > Math.max(...wins)) {
    const ceiling = Math.max(...wins);
    const next = round10(Math.min(Math.max(ceiling * 1.2, thresholds.competitive * 0.5), thresholds.competitive * 2));
    if (next !== thresholds.competitive && next < thresholds.saturated) {
      out.push({
        key: `invest:threshold:competitive:${next}`, scope: 'umbral', kind: 'rule', source: 'distiller', weight: counted.length,
        text: `En ${counted.length} lanzamientos medidos, los que funcionaron tenían hasta ~${ceiling} anuncios activos y los que fallaron desde ~${Math.min(...losses)}: el umbral de «competitivo» pasaría de ~${thresholds.competitive} a ~${next}.`,
        evidence: { support: counted.length, acierto: wins.length, fallo: losses.length, thresholds: { competitive: next, saturated: thresholds.saturated }, from: { competitive: thresholds.competitive } },
      });
    }
  }
  return { needed: 0, candidates: out };
}
