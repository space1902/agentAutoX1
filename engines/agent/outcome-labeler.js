// Deterministic outcome labeler (adapted from Leasify's outcome-labeler): compares what happened AFTER a
// recommendation with the BASELINE the code stored when it was made. The model never grades itself.
//
// Metrics objects: { days, gasto, ventas, valor, roas }. Rules (ROAS_FLOOR = 1,5; KEEP = 80 % of baseline):
//   escalar / subir_presupuesto / duplicar   (needs spend after >= minSpend, else sin_datos)
//       acierto  ROAS after >= max(1,5, 80 % of baseline) AND sales/day >= 90 % of baseline
//       fallo    ROAS after below that bar
//       neutral  ROAS held but sales/day dropped more than 10 %
//   bajar     net result per day (value - spend) improved (acierto) / worsened (fallo) by more than max($1.000, 5 %)
//   apagar    only measurable when it was NOT followed (kept running): ROAS < 1 = acierto (kept losing),
//             ROAS >= bar = fallo (it recovered). If it was followed there is no counterfactual: neutral.
//   mantener  acierto ROAS >= max(1,3, 80 % of baseline); fallo ROAS < 1; else neutral
// A recommendation the user did not follow is `neutral` (nothing to learn about the action), except `apagar`.
export const ROAS_FLOOR = 1.5;
export const KEEP_RATIO = 0.8;
export const SALES_TOLERANCE = 0.9;
export const KEEP_ROAS = 1.3;
export const ACTIONS = Object.freeze(['escalar', 'subir_presupuesto', 'duplicar', 'mantener', 'bajar', 'apagar']);
const SCALE = new Set(['escalar', 'subir_presupuesto', 'duplicar']);

const perDay = (m, field) => (m?.days > 0 ? m[field] / m.days : 0);
const money = (n) => `$${Math.round(n).toLocaleString('es-CO')}`;
const num = (n) => (Math.round(n * 100) / 100).toString().replace('.', ',');
const out = (label, explanation) => ({ label, explanation });

export function labelOutcome({ action, baseline, after, followed = 'unknown', minSpend = 15000 }) {
  if (!ACTIONS.includes(action)) return out('sin_datos', `Acción desconocida: ${action}.`);
  if (!baseline || !after) return out('sin_datos', 'No hay datos suficientes de la entidad para medir el resultado.');

  const bar = Math.max(ROAS_FLOOR, KEEP_RATIO * baseline.roas);
  const notFollowed = followed === 'no';

  if (SCALE.has(action)) {
    if (notFollowed) return out('neutral', 'No se siguió la recomendación (no hubo subida de presupuesto), así que no sirve para evaluarla.');
    if (after.gasto < minSpend) return out('sin_datos', `Gasto posterior ${money(after.gasto)}, por debajo del mínimo de ${money(minSpend)} para decidir.`);
    const salesOk = perDay(after, 'ventas') >= SALES_TOLERANCE * perDay(baseline, 'ventas');
    const detail = `ROAS ${num(after.roas)} (antes ${num(baseline.roas)}, mínimo ${num(bar)}), ${num(perDay(after, 'ventas'))} ventas/día (antes ${num(perDay(baseline, 'ventas'))}).`;
    if (after.roas >= bar && salesOk) return out('acierto', `Se sostuvo. ${detail}`);
    if (after.roas < bar) return out('fallo', `El ROAS cayó bajo el mínimo. ${detail}`);
    return out('neutral', `El ROAS aguantó pero las ventas por día bajaron. ${detail}`);
  }

  if (action === 'bajar') {
    if (notFollowed) return out('neutral', 'No se siguió la recomendación (no se bajó el presupuesto).');
    if (!(baseline.gasto > 0)) return out('sin_datos', 'No había gasto previo con qué comparar.');
    const before = (baseline.valor - baseline.gasto) / baseline.days;
    const now = (after.valor - after.gasto) / after.days;
    const tolerance = Math.max(1000, 0.05 * Math.abs(before));
    const detail = `Resultado diario ${money(now)} (antes ${money(before)}).`;
    if (now - before > tolerance) return out('acierto', `El resultado diario mejoró. ${detail}`);
    if (before - now > tolerance) return out('fallo', `El resultado diario empeoró. ${detail}`);
    return out('neutral', `Sin cambio relevante. ${detail}`);
  }

  if (action === 'apagar') {
    if (followed === 'yes') return out('neutral', 'Se apagó: no hay forma de saber qué habría pasado si seguía encendido.');
    if (after.gasto < minSpend) return out('sin_datos', `Gasto posterior ${money(after.gasto)}, por debajo del mínimo de ${money(minSpend)}.`);
    if (after.roas < 1) return out('acierto', `Siguió encendido y siguió perdiendo: ROAS ${num(after.roas)}.`);
    if (after.roas >= bar) return out('fallo', `Siguió encendido y se recuperó: ROAS ${num(after.roas)} (mínimo ${num(bar)}).`);
    return out('neutral', `Siguió encendido con ROAS ${num(after.roas)}: ni claramente malo ni recuperado.`);
  }

  // mantener
  if (notFollowed) return out('neutral', 'No se siguió la recomendación (el presupuesto cambió).');
  if (after.gasto < minSpend) return out('sin_datos', `Gasto posterior ${money(after.gasto)}, por debajo del mínimo de ${money(minSpend)}.`);
  const keepBar = Math.max(KEEP_ROAS, KEEP_RATIO * baseline.roas);
  if (after.roas >= keepBar) return out('acierto', `Se mantuvo estable: ROAS ${num(after.roas)} (mínimo ${num(keepBar)}).`);
  if (after.roas < 1) return out('fallo', `Cayó por debajo de 1: ROAS ${num(after.roas)}.`);
  return out('neutral', `ROAS ${num(after.roas)}: por debajo de lo esperado pero sin perder dinero.`);
}

// ---- did the user follow it? From data only (budget events / history, ad status, spend), never from the model.

/** Budget changes in [from, to] for the given ad sets / campaigns, from the activity log and the snapshots. */
export function budgetChangesIn({ events = [], histories = {}, entities, from, to }) {
  let up = 0;
  let down = 0;
  const keys = new Set(entities.map((e) => `${e.type}|${e.id}`));
  const loggedKeys = new Set();
  for (const e of events) {
    if (!keys.has(`${e.entityType}|${e.entityId}`) || e.date < from || e.date > to) continue;
    loggedKeys.add(`${e.entityType}|${e.entityId}|${e.newBudget}`);
    if (e.newBudget > e.oldBudget) up++;
    else if (e.newBudget < e.oldBudget) down++;
  }
  for (const [key, rows] of Object.entries(histories)) {
    if (!keys.has(key)) continue;
    let last = null;
    for (const row of rows) {
      if (row.dailyBudget == null) continue;
      if (last != null && row.dailyBudget !== last && row.date >= from && row.date <= to && !loggedKeys.has(`${key}|${row.dailyBudget}`)) {
        if (row.dailyBudget > last) up++;
        else down++;
      }
      last = row.dailyBudget;
    }
  }
  return { up, down };
}

/**
 * @returns {'yes' | 'no' | 'unknown'}
 * ctx: { action, baseline, after, changes: {up, down}, newAds: number, statuses: string[] }
 */
export function detectFollowed({ action, baseline, after, changes, newAds = 0, statuses = [] }) {
  if (action === 'duplicar') return newAds > 0 ? 'yes' : changes.up > 0 ? 'yes' : 'no';
  if (action === 'escalar' || action === 'subir_presupuesto') return changes.up > 0 ? 'yes' : 'no';
  if (action === 'bajar') {
    if (changes.down > 0) return 'yes';
    const before = perDay(baseline, 'gasto');
    return before > 0 && perDay(after, 'gasto') <= 0.7 * before ? 'yes' : 'no';
  }
  if (action === 'apagar') {
    const before = perDay(baseline, 'gasto');
    const stopped = before > 0 && perDay(after, 'gasto') < 0.2 * before;
    const paused = statuses.length > 0 && statuses.every((s) => s && s !== 'ACTIVE');
    return stopped || paused ? 'yes' : 'no';
  }
  if (action === 'mantener') return changes.up + changes.down > 0 ? 'no' : 'yes';
  return 'unknown';
}
