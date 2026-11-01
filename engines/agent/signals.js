// Feedback signals (adapted from Leasify's senales.ts): what the user does with an answer, as weighted events.
// Age is discounted at READ time (30-day half-life); the table keeps the raw fact.
export const SIGNAL_WEIGHTS = Object.freeze({
  pulgar_arriba: 3,
  pulgar_abajo: -3,
  correccion: -3,
  reformulacion: -2,
  recomendacion_seguida: 2,
  cifra_sin_fuente: -1,
  // Agente creativo: what the user does with what it makes.
  generacion_aprobada: 2,
  generacion_rechazada: -2,
  activo_usado: 3,
  activo_descartado: -2,
  correccion_en_chat: -1,
  // Investigador de productos: what happened after a researched product launched.
  lanzamiento_acertado: 3,
  lanzamiento_fallido: -3,
});

export const HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

export const decayed = (weight, ts, now) => weight * 0.5 ** (Math.max(0, now - ts) / DAY_MS / HALF_LIFE_DAYS);

export function aggregateSignals(signals, now) {
  const byKind = {};
  let total = 0;
  for (const s of signals) {
    const value = decayed(s.weight, s.ts, now);
    total += value;
    const k = (byKind[s.kind] ??= { count: 0, sum: 0 });
    k.count += 1;
    k.sum += value;
  }
  const round = (n) => Math.round(n * 100) / 100;
  return { total: round(total), count: signals.length, byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { count: v.count, sum: round(v.sum) }])) };
}

/** The user's chat message pushes back on the previous answer ("no, así no", "está mal", "corrige..."): a weak signal (heuristic, -1). */
const CORRECTION_START = /^\s*(no[\s,.!:]|no$|eso no|esto no|así no|asi no|est[aá] mal|mal[\s,.!:]|incorrecto|corrige|corr[ií]gelo|c[aá]mbialo|rehaz|rehazlo|vuelve a hacerlo|no era)/i;
export const isChatCorrection = (text) => CORRECTION_START.test(String(text ?? ''));

const tokens = (text) => new Set(String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((t) => t.length > 1));

/** The same question asked again right away: the previous answer probably did not help (heuristic, −2). */
export function isReformulation(previous, next, { windowMs = 10 * 60_000 } = {}) {
  if (!previous || !next || next.ts - previous.ts > windowMs || next.ts < previous.ts) return false;
  const a = tokens(previous.text);
  const b = tokens(next.text);
  if (a.size < 3 || b.size < 3) return false;
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return both / (a.size + b.size - both) >= 0.6;
}
