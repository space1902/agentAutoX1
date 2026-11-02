// Deterministic metrics for the Analista. All arithmetic lives here (reusing the ads report code); the model only
// explains the numbers it gets back. Every function takes a plain dataset so it is testable without a database.
import { loadConfig } from '../ads/config.js';
import { computeChanges } from '../ads/budget.js';
import { postBudgetVerdict } from '../ads/decisions.js';
import { extractCt } from '../ads/parse.js';
import { buildReport, isMonitored } from '../ads/report.js';
import { openStoreReadOnly } from '../ads/store.js';
import { DEFAULT_TIMEZONE } from '../ads/sync.js';
import { addDays, daysBetween, isIsoDate, localParts } from '../ads/time.js';
import { raisesByAd } from '../ads/tracking.js';

export const MAX_RANGE_DAYS = 370;
const MAX_ROWS = 60;

export class MetricsError extends Error {}

// Today's date in the ad account's timezone (cheap: reads one key of ads.db).
export function accountToday(dataDir, now = Date.now()) {
  try {
    const store = openStoreReadOnly(dataDir);
    try {
      return localParts(now, store.getKv('account')?.timezone || DEFAULT_TIMEZONE).date;
    } finally {
      store.close();
    }
  } catch {
    return localParts(now, DEFAULT_TIMEZONE).date;
  }
}

export function loadDataset(dataDir, now = Date.now()) {
  const store = openStoreReadOnly(dataDir);
  try {
    const timezone = store.getKv('account')?.timezone || DEFAULT_TIMEZONE;
    const histories = store.budgetHistories();
    const events = store.budgetEvents();
    return {
      histories,
      events,
      insights: store.insightsBetween('2000-01-01', '2999-12-31'),
      comprobantes: store.comprobantesBetween('2000-01-01', '2999-12-31'),
      identities: store.identities(),
      ads: store.adsWithFirstSpend(),
      changes: computeChanges({ histories, events }),
      config: loadConfig(dataDir),
      timezone,
      today: localParts(now, timezone).date,
      lastSync: store.getKv('lastSync'),
    };
  } finally {
    store.close();
  }
}

const r2 = (n) => Math.round(n * 100) / 100;
const r0 = (n) => Math.round(n);

// Compact, rounded view of a KPI object (the numbers the model is allowed to quote).
export function brief(k) {
  return {
    gasto: r0(k.gasto), mensajes: r0(k.mensajes), ventas: k.ventas, ingresos: r0(k.valor), roas: r2(k.roas),
    costo_por_venta: k.ventas > 0 ? r0(k.costoVenta) : null, costo_por_mensaje: k.mensajes > 0 ? r0(k.costoMensaje) : null,
    conversion_pct: r2(k.conversion * 100), ticket: k.ventas > 0 ? r0(k.ticket) : null,
    margen: r0(k.margen), margen_pct: r2(k.margenPct * 100),
  };
}

export function normalizeCt(value) {
  if (value === undefined || value === null || value === '') return null;
  const ct = extractCt(String(value));
  if (!ct) throw new MetricsError(`«${value}» no parece un código CT (ejemplo: CT 07).`);
  return ct;
}

function range(ds, p) {
  const to = p.to ?? ds.today;
  const from = p.from ?? addDays(to, -6);
  if (!isIsoDate(from) || !isIsoDate(to)) throw new MetricsError('Las fechas deben tener el formato AAAA-MM-DD.');
  if (from > to || daysBetween(from, to) > MAX_RANGE_DAYS) throw new MetricsError(`El rango no es válido (máximo ${MAX_RANGE_DAYS} días).`);
  return { from, to };
}

function country(p) {
  if (p.country === undefined || p.country === null || p.country === '' || p.country === 'all') return '';
  if (!/^[A-Za-z]{2}$/.test(String(p.country))) throw new MetricsError('El país debe ser un código de 2 letras (CO, MX, VE) o «all».');
  return String(p.country).toUpperCase();
}

const ctOfAd = (ds, adId) => {
  const id = ds.identities[adId];
  return extractCt(id?.campaignName, id?.adName);
};

export function adIdsOfCampaign(ds, campaignId) {
  const out = new Set();
  for (const adId of new Set(ds.insights.map((r) => r.adId))) if (ds.identities[adId]?.campaignId === campaignId) out.add(adId);
  return out;
}

export function adIdsOfCt(ds, ct) {
  const out = new Set();
  for (const adId of new Set(ds.insights.map((r) => r.adId))) if (ctOfAd(ds, adId) === ct) out.add(adId);
  return out;
}

// Report restricted to some ads (all ads when `adIds` is null). Campaign prefix is lifted, as in decisions.js.
export function report(ds, { from, to, group = 'campaign', country: cty = '', adIds = null, split = false }) {
  const keep = (r) => (adIds ? adIds.has(r.adId) : true);
  return buildReport({
    insights: ds.insights.filter(keep),
    comprobantes: ds.comprobantes.filter(keep),
    identities: ds.identities,
    ads: ds.ads,
    config: ds.config,
    from,
    to,
    group,
    today: ds.today,
    country: cty,
    splitCountry: split,
    raises: raisesByAd({ insights: ds.insights.filter((r) => r.date >= addDays(ds.today, -60)), changes: ds.changes, today: ds.today }),
  });
}

export const kpis = (ds, args) => report(ds, { ...args, group: 'ad' }).kpis;

const rowOut = (row) => ({
  etiqueta: row.label, campaign_id: row.campaignId || undefined, ct: row.ct, pais: row.country || undefined, gasto: r0(row.gasto), ventas: row.ventas, ingresos: r0(row.valor), roas: r2(row.roas),
  costo_por_venta: row.ventas > 0 ? r0(row.costoVenta) : null, margen: r0(row.margen), margen_pct: r2(row.margenPct * 100),
  dia_n: row.ageDays, estado: row.effectiveStatus ?? undefined, accion_sugerida: row.action?.label ?? null,
  subida_reciente: row.raise ? { fecha: row.raise.date, pct: r2(row.raise.pct), dia_n: row.raise.dayN } : null,
});

function entityAds(ds, p) {
  if (p.campaign_id) {
    const id = String(p.campaign_id);
    const ids = adIdsOfCampaign(ds, id);
    if (!ids.size) throw new MetricsError(`No hay datos de la campaña ${id}.`);
    const name = ds.identities[[...ids][0]]?.campaignName || id;
    return { ct: name, adIds: ids };
  }
  const ct = normalizeCt(p.ct);
  if (ct) {
    const ids = adIdsOfCt(ds, ct);
    if (!ids.size) throw new MetricsError(`No hay datos del ${ct}.`);
    return { ct, adIds: ids };
  }
  if (p.ad_id) {
    const id = String(p.ad_id).replace(/\D/g, '');
    if (!id || !ds.insights.some((r) => r.adId === id)) throw new MetricsError(`No encuentro el anuncio ${p.ad_id}.`);
    return { ct: null, adIds: new Set([id]) };
  }
  return { ct: null, adIds: null };
}

const KINDS = {
  // Totals for a period, optionally for one campaign / CT tag / ad and country.
  kpis(ds, p) {
    const { from, to } = range(ds, p);
    const { ct, adIds } = entityAds(ds, p);
    const rep = report(ds, { from, to, group: 'campaign', country: country(p), adIds });
    return {
      periodo: { desde: from, hasta: to }, alcance: ct ?? (adIds ? `anuncio ${[...adIds][0]}` : 'todos los anuncios monitoreados'), pais: country(p) || 'todos',
      totales: brief(rep.kpis),
    };
  },
  // One row per campaign / ad, with the suggested action (same thresholds as the Anuncios screen).
  table(ds, p) {
    const { from, to } = range(ds, p);
    const group = p.group === 'ad' ? 'ad' : 'campaign';
    const { adIds } = entityAds(ds, p);
    const rep = report(ds, { from, to, group, country: country(p), adIds, split: p.split === true });
    const rows = rep.rows.filter((r) => r.gasto > 0 || r.ventas > 0);
    return {
      periodo: { desde: from, hasta: to }, agrupacion: group, pais: country(p) || 'todos', filas: rows.slice(0, MAX_ROWS).map(rowOut), total_filas: rows.length,
      totales: brief(rep.kpis),
      umbrales: ds.config.thresholds,
    };
  },
  // Day-by-day series.
  daily(ds, p) {
    const { from, to } = range(ds, p);
    const { ct, adIds } = entityAds(ds, p);
    const rep = report(ds, { from, to, group: 'ad', country: country(p), adIds });
    return {
      periodo: { desde: from, hasta: to }, alcance: ct ?? 'todos', pais: country(p) || 'todos',
      dias: rep.daily.map((d) => ({ fecha: d.date, gasto: r0(d.gasto), ventas: d.ventas, ingresos: r0(d.valor), roas: r2(d.roas), mensajes: d.mensajes })),
    };
  },
  // Country table (spend, sales, ROAS, margin per country).
  countries(ds, p) {
    const { from, to } = range(ds, p);
    const rep = report(ds, { from, to, group: 'campaign' });
    return {
      periodo: { desde: from, hasta: to },
      paises: rep.countries.map((c) => ({
        pais: c.country || 'Sin país', nombre: c.name, moneda: c.currency, tasa_a_cop: c.rateToCop, tasa_sin_configurar: c.rateMissing, ...brief(c),
      })),
    };
  },
  // Age counters of the ads (day 1 = first day with spend) and each day's cumulative result.
  lifecycle(ds, p) {
    const { ct, adIds } = entityAds(ds, p);
    const ids = adIds ?? new Set(Object.keys(ds.ads).filter((id) => ds.ads[id]?.firstSpendDate && isMonitored(ds.identities[id]?.campaignName ?? '', ds.config.campaignPrefix)));
    const out = [];
    for (const adId of ids) {
      const first = ds.ads[adId]?.firstSpendDate;
      if (!first) continue;
      const days = daysBetween(first, ds.today) + 1;
      const lastSpend = ds.insights.filter((r) => r.adId === adId && r.gasto > 0).map((r) => r.date).sort().at(-1);
      const cumulative = kpis(ds, { from: first, to: ds.today, adIds: new Set([adId]) });
      out.push({
        ad_id: adId, anuncio: ds.identities[adId]?.adName ?? adId, ct: ctOfAd(ds, adId), estado: ds.ads[adId]?.effectiveStatus ?? null,
        primer_dia_con_gasto: first, dia_n_hoy: days, ultimo_dia_con_gasto: lastSpend ?? null, acumulado: brief(cumulative),
        en_prueba: days <= ds.config.lifecycle.testDays, dia_del_veredicto: ds.config.lifecycle.testNotifyDay,
      });
    }
    out.sort((a, b) => a.dia_n_hoy - b.dia_n_hoy);
    return { hoy: ds.today, alcance: ct ?? 'anuncios monitoreados', anuncios: out.slice(0, MAX_ROWS), total_anuncios: out.length };
  },
  // For each budget raise: the days before vs the days since, with the app's own verdict rule.
  budget_compare(ds, p) {
    const life = ds.config.lifecycle;
    const { ct, adIds } = entityAds(ds, p);
    const since = p.since && isIsoDate(p.since) ? p.since : addDays(ds.today, -60);
    const out = [];
    for (const change of ds.changes) {
      if (change.date < since || change.date > ds.today) continue;
      const field = change.entityType === 'campaign' ? 'campaignId' : 'adsetId';
      const rows = ds.insights.filter((r) => r[field] === change.entityId);
      const ids = new Set(rows.map((r) => r.adId));
      if (!ids.size) continue;
      if (adIds && ![...ids].some((id) => adIds.has(id))) continue;
      const latest = rows.at(-1);
      const afterDays = Math.min(p.after_days > 0 ? Math.floor(p.after_days) : life.postBudgetNotifyDay, daysBetween(change.date, ds.today) + 1);
      const window = life.windowDays;
      const after = kpis(ds, { from: change.date, to: addDays(change.date, afterDays - 1), adIds: ids });
      const before = kpis(ds, { from: addDays(change.date, -window), to: addDays(change.date, -1), adIds: ids });
      const verdict = postBudgetVerdict(after, before, life, ds.config.thresholds, change);
      out.push({
        entidad: change.entityType === 'campaign' ? latest.campaignName : latest.adsetName, tipo: change.entityType, entity_id: change.entityId,
        fecha_cambio: change.date, presupuesto_anterior: r0(change.oldBudget), presupuesto_nuevo: r0(change.newBudget), subida_pct: r2(change.pct),
        fecha_exacta: change.exact, dias_despues_evaluados: afterDays, dias_antes_comparados: window,
        antes: brief(before), despues: brief(after), veredicto_app: verdict.verdict.label, motivo: verdict.reason,
      });
    }
    out.sort((a, b) => (a.fecha_cambio < b.fecha_cambio ? 1 : -1));
    return { alcance: ct ?? 'todos', desde: since, cambios: out.slice(0, 30), total_cambios: out.length };
  },
};

export const METRIC_KINDS = Object.freeze(Object.keys(KINDS));

export function runMetric(ds, params = {}) {
  const fn = KINDS[params.kind];
  if (!fn) throw new MetricsError(`Tipo de métrica desconocido: «${params.kind}». Usa uno de: ${METRIC_KINDS.join(', ')}.`);
  return { hoy: ds.today, ...fn(ds, params) };
}

// Baseline/after window metrics for the learning loop (also pure): totals of an entity over [from, to].
export function windowMetrics(ds, { entityType, entityId, from, to }) {
  const adIds = entityAdIds(ds, entityType, entityId);
  if (!adIds || !adIds.size) return null;
  const days = daysBetween(from, to) + 1;
  const k = kpis(ds, { from, to, adIds });
  return { adIds: [...adIds], days, gasto: k.gasto, ventas: k.ventas, valor: k.valor, roas: k.roas, costoVenta: k.ventas > 0 ? k.costoVenta : null, mensajes: k.mensajes, margen: k.margen };
}

// Ads that belong to a recommendation target: a CT code, an ad id, an ad set or a campaign.
export function entityAdIds(ds, entityType, entityId) {
  if (entityType === 'ct') {
    const ct = extractCt(entityId);
    return ct ? adIdsOfCt(ds, ct) : null;
  }
  // Entities recommended before campaigns replaced CT codes keep their CT type; a campaign id also resolves here.
  if (entityType === 'ad') return ds.insights.some((r) => r.adId === String(entityId)) ? new Set([String(entityId)]) : null;
  if (entityType === 'adset' || entityType === 'campaign') {
    const field = entityType === 'campaign' ? 'campaignId' : 'adsetId';
    return new Set(ds.insights.filter((r) => r[field] === String(entityId)).map((r) => r.adId));
  }
  return null;
}
