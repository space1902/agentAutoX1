// Report builder: joins daily Meta spend with valid payments (key = date|adId, as the Apps Script
// trkJoin did), derives metrics and suggested actions, and groups by CT / campaign / ad. Pure.
import { ACTIONS, computeMetrics, suggestAction } from './metrics.js';
import { extractCt, maskPhone, normalizeText } from './parse.js';
import { isValidResult, matchesFlow } from './sheet.js';
import { daysBetween, eachDate } from './time.js';

export const NO_AD = 'Sin anuncio';
const NO_CT = 'Sin CT';

export function isMonitored(campaignName, prefix) {
  const p = String(prefix ?? '').trim().toLowerCase();
  if (!p || p === 'all') return true;
  return String(campaignName ?? '').toLowerCase().startsWith(p);
}

const blank = (date, adId) => ({ date, adId, gasto: 0, mensajes: 0, valor: 0, ventas: 0 });

// Map "date|adId" -> { date, adId, gasto, mensajes, valor, ventas }. `sales` must already be valid payments.
export function joinByDateAndAd({ insights, sales }) {
  const map = new Map();
  const entry = (date, adId) => {
    const key = `${date}|${adId}`;
    if (!map.has(key)) map.set(key, blank(date, adId));
    return map.get(key);
  };
  for (const r of insights) {
    const e = entry(r.date, r.adId);
    e.gasto += r.gasto;
    e.mensajes += r.mensajes;
  }
  for (const s of sales) {
    const e = entry(s.date, s.adId || '');
    e.valor += s.valor;
    e.ventas += 1;
  }
  return map;
}

function resultStatus(result, validResult) {
  if (isValidResult(result, validResult)) return 'valid';
  return normalizeText(result).includes('invalido') ? 'invalid' : 'review';
}

// "Day N": the first day with spend is day 1. null when the ad has not spent yet.
const dayOf = (ad, today) => {
  const first = String(ad?.firstSpendDate ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(first) && first <= today ? daysBetween(first, today) + 1 : null;
};

const addTotals = (to, from) => {
  to.gasto += from.gasto;
  to.mensajes += from.mensajes;
  to.valor += from.valor;
  to.ventas += from.ventas;
  return to;
};
const withMetrics = (t) => ({ ...t, ...computeMetrics(t) });

export function buildReport({ insights, comprobantes, identities = {}, ads = {}, config, from, to, group = 'ct', today }) {
  const prefix = config.campaignPrefix;
  const inRange = (d) => d >= from && d <= to;

  const monitoredInsights = insights.filter((r) => inRange(r.date) && isMonitored(r.campaignName, prefix));
  const seen = {};
  for (const r of insights) seen[r.adId] = { adName: r.adName, campaignId: r.campaignId, campaignName: r.campaignName };
  const identityOf = (adId) => (adId ? (identities[adId] ?? seen[adId] ?? null) : null);

  // Payments of the flow that belong to a monitored ad, to an unknown ad, or to no ad at all.
  const flowRows = comprobantes.filter((c) => inRange(c.date) && matchesFlow(c.flow, config.flowPrefix));
  const attributable = flowRows.filter((c) => {
    const id = identityOf(c.adId);
    return !id || isMonitored(id.campaignName, prefix);
  });
  const sales = attributable.filter((c) => isValidResult(c.result, config.validResult));
  const joined = joinByDateAndAd({ insights: monitoredInsights, sales });

  const describe = (adId) => {
    const id = identityOf(adId);
    const campaignName = id?.campaignName ?? '';
    const adName = id?.adName ?? '';
    return {
      adId,
      adName,
      campaignId: id?.campaignId ?? '',
      campaignName,
      known: Boolean(id),
      ct: !adId ? NO_AD : (extractCt(campaignName, adName) ?? NO_CT),
    };
  };

  const groupOf = (info) => {
    if (group === 'campaign') {
      if (!info.adId) return { key: NO_AD, label: NO_AD };
      return info.known ? { key: info.campaignId || info.campaignName, label: info.campaignName || '(campaña sin nombre)' } : { key: 'unknown', label: 'Anuncio desconocido' };
    }
    if (group === 'ad') {
      if (!info.adId) return { key: NO_AD, label: NO_AD };
      return { key: info.adId, label: info.adName || `Anuncio ${info.adId}` };
    }
    return { key: info.ct, label: info.ct };
  };

  const groups = new Map();
  const daily = new Map(eachDate(from, to).map((d) => [d, blank(d, '')]));
  const total = { gasto: 0, mensajes: 0, valor: 0, ventas: 0 };
  for (const e of joined.values()) {
    const info = describe(e.adId);
    const g = groupOf(info);
    if (!groups.has(g.key)) {
      groups.set(g.key, {
        gasto: 0, mensajes: 0, valor: 0, ventas: 0,
        key: g.key, label: g.label, ct: group === 'ct' ? g.label : info.ct, adId: group === 'ad' ? info.adId : '',
        adName: group === 'ad' ? info.adName : '', campaignId: group === 'ad' || group === 'campaign' ? info.campaignId : '',
        campaignName: group === 'ct' ? '' : info.campaignName, hasAction: false, adIds: new Set(),
      });
    }
    const row = groups.get(g.key);
    addTotals(row, e);
    if (e.adId) row.adIds.add(e.adId);
    if (info.known) row.hasAction = true;
    const day = daily.get(e.date);
    if (day) addTotals(day, e);
    addTotals(total, e);
  }

  const rows = [...groups.values()]
    .map(({ adIds, hasAction, ...row }) => {
      const metrics = withMetrics(row);
      const ages = [...adIds].map((id) => dayOf(ads[id], today)).filter((n) => n !== null);
      const single = group === 'ad' ? ads[row.adId] : null;
      return {
        ...metrics,
        ageDays: ages.length ? Math.max(...ages) : null,
        firstSpendDate: [...adIds].map((id) => ads[id]?.firstSpendDate).filter(Boolean).sort()[0] ?? null,
        effectiveStatus: single?.effectiveStatus ?? null,
        action: hasAction ? suggestAction(metrics, config.thresholds) : null,
      };
    })
    .sort((a, b) => b.gasto - a.gasto || b.valor - a.valor);

  const list = flowRows
    .filter((c) => attributable.includes(c))
    .map((c) => {
      const info = describe(c.adId);
      return {
        date: c.date,
        registered: c.registered,
        valor: c.valor,
        bank: c.bank,
        flow: c.flow,
        adId: c.adId,
        adName: info.adName,
        ct: info.ct,
        result: c.result,
        status: resultStatus(c.result, config.validResult),
        phoneMasked: maskPhone(c.phone),
      };
    })
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));

  return {
    range: { from, to },
    group,
    currency: config.currency,
    kpis: withMetrics(total),
    rows,
    daily: [...daily.values()].map(({ date, gasto, valor, ventas, mensajes }) => ({ date, gasto, valor, ventas, mensajes, roas: gasto ? valor / gasto : 0 })),
    comprobantes: list,
    reviewCount: list.filter((c) => c.status !== 'valid').length,
  };
}

export { ACTIONS };
