// Report builder: joins daily Meta spend with valid payments (key = date|adId, as the Apps Script
// trkJoin did; with a country, date|adId|country), derives metrics, per-country economics and suggested actions,
// and groups by CT / campaign / ad. Pure.
import { COUNTRY_NAMES, DEFAULT_COUNTRY_TOKENS, deriveCountry } from './country.js';
import { ACTIONS, computeMetrics, suggestAction } from './metrics.js';
import { extractCt, maskPhone, normalizeText } from './parse.js';
import { isValidResult, matchesFlow } from './sheet.js';
import { daysBetween, eachDate } from './time.js';

export const NO_AD = 'Sin anuncio';
const NO_CT = 'Sin CT';
export const NO_COUNTRY = 'Sin país';

export function isMonitored(campaignName, prefix) {
  const p = String(prefix ?? '').trim().toLowerCase();
  if (!p || p === 'all') return true;
  return String(campaignName ?? '').toLowerCase().startsWith(p);
}

const blank = (date, adId, country = '') => ({ date, adId, country, gasto: 0, mensajes: 0, valor: 0, ventas: 0, comisiones: 0, costos: 0, impuestos: 0 });

// Settings of a country; the rate defaults to 1 while it is not set (flagged by the country table).
export function countrySettings(config, country) {
  const c = config.countries?.[country];
  return { currency: c?.currency ?? 'COP', rate: c?.rateToCop > 0 ? c.rateToCop : 1, rateSet: !c || c.currency === 'COP' || c.rateToCop > 0, feePct: c?.feePct ?? 0, costPerSale: c?.costPerSale ?? 0, taxPct: c?.taxPct ?? 0 };
}

// Value of a payment in COP plus what it costs (fee and tax are % of that value; the cost is per sale).
export function economics(sale, config, country) {
  const s = countrySettings(config, country);
  const valor = sale.valor * s.rate;
  return { valor, comisiones: (valor * s.feePct) / 100, costos: s.costPerSale, impuestos: (valor * s.taxPct) / 100 };
}

// Map "date|adId[|country]" -> entry. `sales` must already be valid payments; `convert(sale)` may turn them into COP
// and add costs (the default keeps the raw sheet value).
export function joinByDateAndAd({ insights, sales, convert = (s) => ({ valor: s.valor, comisiones: 0, costos: 0, impuestos: 0 }) }) {
  const map = new Map();
  const entry = (date, adId, country) => {
    const key = country ? `${date}|${adId}|${country}` : `${date}|${adId}`;
    if (!map.has(key)) map.set(key, blank(date, adId, country));
    return map.get(key);
  };
  for (const r of insights) {
    const e = entry(r.date, r.adId, r.country ?? '');
    e.gasto += r.gasto;
    e.mensajes += r.mensajes;
  }
  for (const s of sales) {
    const e = entry(s.date, s.adId || '', s.country ?? '');
    const c = convert(s);
    e.valor += c.valor;
    e.comisiones += c.comisiones;
    e.costos += c.costos;
    e.impuestos += c.impuestos;
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
  for (const k of ['gasto', 'mensajes', 'valor', 'ventas', 'comisiones', 'costos', 'impuestos']) to[k] += from[k];
  return to;
};

// Metrics plus the gross margin: value - spend - fees - per-sale costs - taxes.
const withMetrics = (t) => {
  const margen = t.valor - t.gasto - t.comisiones - t.costos - t.impuestos;
  return { ...t, ...computeMetrics(t), margen, margenPct: t.valor ? margen / t.valor : 0 };
};
const zero = () => ({ gasto: 0, mensajes: 0, valor: 0, ventas: 0, comisiones: 0, costos: 0, impuestos: 0 });

export function buildReport({
  insights, comprobantes, identities = {}, ads = {}, config, from, to, group = 'ct', today, country = '', splitCountry = false, raises = {},
}) {
  const prefix = config.campaignPrefix;
  const words = config.countryWords ?? DEFAULT_COUNTRY_TOKENS;
  const wanted = country && country !== 'all' ? country : '';
  const inRange = (d) => d >= from && d <= to;

  const monitoredInsights = insights.filter((r) => inRange(r.date) && isMonitored(r.campaignName, prefix));
  const seen = {};
  for (const r of insights) seen[r.adId] = { adName: r.adName, campaignId: r.campaignId, campaignName: r.campaignName };
  const identityOf = (adId) => (adId ? (identities[adId] ?? seen[adId] ?? null) : null);

  // Country of a payment: manual/stored value, else derived (phone, then the ad's campaign, then the flow).
  const saleCountry = (c) => c.country || deriveCountry({ phone: c.phone, campaignName: identityOf(c.adId)?.campaignName, flow: c.flow }, words).country;

  // Payments of the flow that belong to a monitored ad, to an unknown ad, or to no ad at all.
  const flowRows = comprobantes.filter((c) => inRange(c.date) && matchesFlow(c.flow, config.flowPrefix));
  const attributable = flowRows.filter((c) => {
    const id = identityOf(c.adId);
    return !id || isMonitored(id.campaignName, prefix);
  });
  const withCountry = new Map(attributable.map((c) => [c, saleCountry(c)]));
  const sales = attributable.filter((c) => isValidResult(c.result, config.validResult)).map((c) => ({ ...c, country: withCountry.get(c) }));
  const joined = joinByDateAndAd({ insights: monitoredInsights, sales, convert: (s) => economics(s, config, s.country) });

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

  const groupOf = (info, entryCountry) => {
    let g;
    if (group === 'campaign') {
      if (!info.adId) g = { key: NO_AD, label: NO_AD };
      else g = info.known ? { key: info.campaignId || info.campaignName, label: info.campaignName || '(campaña sin nombre)' } : { key: 'unknown', label: 'Anuncio desconocido' };
    } else if (group === 'ad') {
      g = !info.adId ? { key: NO_AD, label: NO_AD } : { key: info.adId, label: info.adName || `Anuncio ${info.adId}` };
    } else g = { key: info.ct, label: info.ct };
    if (splitCountry) return { key: `${g.key}|${entryCountry}`, label: `${g.label} · ${entryCountry || NO_COUNTRY}` };
    return g;
  };

  // Per-country table (always over every country, whatever the filter).
  const byCountry = new Map();
  for (const e of joined.values()) {
    if (!byCountry.has(e.country)) byCountry.set(e.country, zero());
    addTotals(byCountry.get(e.country), e);
  }
  const countries = [...byCountry.entries()]
    .map(([code, totals]) => {
      const s = countrySettings(config, code);
      return {
        country: code, name: code ? (COUNTRY_NAMES[code] ?? code) : NO_COUNTRY, currency: s.currency, rateToCop: s.rate, rateMissing: totals.valor > 0 && !s.rateSet,
        ...withMetrics(totals),
      };
    })
    .sort((a, b) => b.gasto - a.gasto || b.valor - a.valor);

  const groups = new Map();
  const daily = new Map(eachDate(from, to).map((d) => [d, blank(d, '')]));
  const total = zero();
  for (const e of joined.values()) {
    if (wanted && e.country !== wanted) continue;
    const info = describe(e.adId);
    const g = groupOf(info, e.country);
    if (!groups.has(g.key)) {
      groups.set(g.key, {
        ...zero(),
        key: g.key, label: g.label, ct: group === 'ct' ? g.label : info.ct, adId: group === 'ad' ? info.adId : '',
        adName: group === 'ad' ? info.adName : '', campaignId: group === 'ad' || group === 'campaign' ? info.campaignId : '',
        campaignName: group === 'ct' ? '' : info.campaignName, country: splitCountry ? e.country : '', hasAction: false, adIds: new Set(),
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
        // Latest recent budget raise among its ads (informational: day N since the raise).
        raise: [...adIds].map((id) => raises[id]).filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null,
        action: hasAction ? suggestAction(metrics, config.thresholds) : null,
      };
    })
    .sort((a, b) => b.gasto - a.gasto || b.valor - a.valor);

  const list = flowRows
    .filter((c) => attributable.includes(c))
    .filter((c) => !wanted || withCountry.get(c) === wanted)
    .map((c) => {
      const info = describe(c.adId);
      const code = withCountry.get(c);
      return {
        key: c.key ?? '',
        date: c.date,
        registered: c.registered,
        valor: c.valor,
        valorCop: c.valor * countrySettings(config, code).rate,
        bank: c.bank,
        flow: c.flow,
        adId: c.adId,
        adName: info.adName,
        ct: info.ct,
        result: c.result,
        status: resultStatus(c.result, config.validResult),
        phoneMasked: maskPhone(c.phone),
        country: code,
        countrySource: c.country ? (c.countrySource || 'telefono') : deriveCountry({ phone: c.phone, campaignName: identityOf(c.adId)?.campaignName, flow: c.flow }, words).source,
        gone: Boolean(c.gone),
      };
    })
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));

  return {
    range: { from, to },
    group,
    country: wanted,
    splitCountry,
    currency: config.currency,
    kpis: withMetrics(total),
    rows,
    countries,
    daily: [...daily.values()].map(({ date, gasto, valor, ventas, mensajes }) => ({ date, gasto, valor, ventas, mensajes, roas: gasto ? valor / gasto : 0 })),
    comprobantes: list,
    reviewCount: list.filter((c) => c.status !== 'valid').length,
  };
}

export { ACTIONS };
