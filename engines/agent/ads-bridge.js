// Read-only bridge from the other agents to the Analista's data: how did an ad code (CT) really perform?
// Used by the Agente creativo (assets mapped to a CT) and by the Investigador (launched products). It only reads ads.db
// through metrics.js and applies the same ROAS rules the Analista uses (>= 2 scale, < 1 switch off, in between optimize).
import { addDays } from '../ads/time.js';
import { loadDataset, windowMetrics } from './metrics.js';

export const ROAS_GOOD = 2;
export const ROAS_BAD = 1;
const DEFAULT_WINDOW_DAYS = 30;

const canonicalCt = (value) => {
  const m = /(\d{1,3})/.exec(String(value ?? ''));
  return m ? `CT ${m[1].padStart(2, '0')}` : null;
};

/** acierto (ROAS >= 2) / fallo (< 1) / neutral / sin_datos (not enough spend to judge). */
export function labelRoas({ roas, gasto }, minSpend = 0) {
  if (!Number.isFinite(roas) || !(gasto > 0) || gasto < minSpend) return 'sin_datos';
  if (roas >= ROAS_GOOD) return 'acierto';
  if (roas < ROAS_BAD) return 'fallo';
  return 'neutral';
}

/**
 * Real results of a CT since `since` (ms or YYYY-MM-DD; default the last 30 days). Never throws: no ads database or an unknown CT
 * gives `{ available: false, reason }`.
 */
export function ctResult(dataDir, ctCode, { since, now = Date.now(), dataset } = {}) {
  const ct = canonicalCt(ctCode);
  if (!ct) return { available: false, reason: 'Código CT no válido.' };
  try {
    const ds = dataset ?? loadDataset(dataDir, now);
    const to = ds.today;
    const sinceDate = typeof since === 'string' ? since : since ? new Date(since).toISOString().slice(0, 10) : addDays(to, -(DEFAULT_WINDOW_DAYS - 1));
    const from = sinceDate > to ? to : sinceDate;
    const w = windowMetrics(ds, { entityType: 'ct', entityId: ct, from, to });
    if (!w) return { available: false, reason: `No hay datos de ${ct} en Anuncios.` };
    const minSpend = ds.config?.thresholds?.minSpend ?? 0;
    return {
      available: true, ct, from, to, days: w.days, gasto: Math.round(w.gasto), ventas: w.ventas, valor: Math.round(w.valor), roas: Math.round(w.roas * 100) / 100,
      costoVenta: w.costoVenta === null ? null : Math.round(w.costoVenta), label: labelRoas(w, minSpend),
    };
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error).slice(0, 160) };
  }
}
