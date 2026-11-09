// Report builder: joins daily Meta spend with valid payments (key = date|adId, as the Apps Script
// trkJoin did; with a country, date|adId|country), derives metrics, per-country economics and suggested actions,
// and groups by campaign / ad. Pure. A campaign is a real Meta campaign (keyed by its id, labeled with its full name):
// the CT code in a name is only a tag and never merges campaigns.
import { COUNTRY_NAMES, DEFAULT_COUNTRY_TOKENS, deriveCountry, scopeCountry } from './country.js';
import { ACTIONS, computeMetrics, isInactiveStatus, suggestAction } from './metrics.js';
import { maskPhone, normalizeText, parseCt } from './parse.js';
import { fxSummary, resolveRate } from './fx.js';
import { isValidResult, matchesFlow } from './sheet.js';
import { matchesName, scopeInsights } from './scope.js';
import { hourOfRegistered, inHours } from './hours.js';
import { daysBetween, eachDate } from './time.js';

export const NO_AD = 'Sin anuncio';
const NO_CT = 'Sin CT';
const UNKNOWN_AD = 'unknown';
export const NO_COUNTRY = 'Sin país';

export function isMonitored(campaignName, prefix) {
  const p = String(prefix ?? '').trim().toLowerCase();
  if (!p || p === 'all') return true;
  return String(campaignName ?? '').toLowerCase().startsWith(p);
}

const blank = (date, adId, country = '') => ({ date, adId, country, gasto: 0, spendNet: 0, vat: 0, mensajes: 0, valor: 0, valorNative: 0, ventas: 0, comisiones: 0, costos: 0, impuestos: 0 });

// Settings of a country on a day; the rate is the live one saved for that day (see fx.js), else the manual one, else 1
// while nothing is known (flagged by the country table).
export function countrySettings(config, country, date = '9999-12-31', fxRates = {}) {
  const c = config.countries?.[country];
  const r = c ? resolveRate(config, country, date, fxRates) : { rate: 1, set: !country || country === 'CO' };
  return { currency: c?.currency ?? 'COP', rate: r.rate, rateSet: r.set, feePct: c?.feePct ?? 0, costPerSale: c?.costPerSale ?? 0, taxPct: c?.taxPct ?? 0 };
}

// Value of a payment in COP plus what it costs (fee and tax are % of that value; the cost is per sale).
export function economics(sale, config, country, fxRates = {}) {
  const s = countrySettings(config, country, sale.date, fxRates);
  const valor = sale.valor * s.rate;
  return { valor, valorNative: sale.valor, comisiones: (valor * s.feePct) / 100, costos: s.costPerSale, impuestos: (valor * s.taxPct) / 100 };
}

// Spend as shown everywhere: `gasto` includes Meta's IVA, `spendNet` is what the API returned, `vat` the difference.
// Map "date|adId[|country]" -> entry. `sales` must already be valid payments; `convert(sale)` may turn them into COP
// and add costs (the default keeps the raw sheet value).
export function joinByDateAndAd({ insights, sales, vatPct = 0, convert = (s) => ({ valor: s.valor, valorNative: s.valor, comisiones: 0, costos: 0, impuestos: 0 }) }) {
  const map = new Map();
  const entry = (date, adId, country) => {
    const key = country ? `${date}|${adId}|${country}` : `${date}|${adId}`;
    if (!map.has(key)) map.set(key, blank(date, adId, country));
    return map.get(key);
  };
  for (const r of insights) {
    const e = entry(r.date, r.adId, r.country ?? '');
    const vat = (r.gasto * vatPct) / 100;
    e.spendNet += r.gasto;
    e.vat += vat;
    e.gasto += r.gasto + vat;
    e.mensajes += r.mensajes;
  }
  for (const s of sales) {
    const e = entry(s.date, s.adId || '', s.country ?? '');
    const c = convert(s);
    e.valor += c.valor;
    e.valorNative += c.valorNative ?? 0;
    e.comisiones += c.comisiones;
    e.costos += c.costos;
    e.impuestos += c.impuestos;
    e.ventas += 1;
  }
  return map;
}

// A payment counts as a sale when the sheet says so or when the user accepted it by hand (the sheet is never changed).
// A payment that is gone from the sheet (`gone`) or was discarded by hand (`rejected`) never counts (rejection wins
// over acceptance); both stay in the vouchers list.
const isLive = (c) => !c.gone && !c.rejected;
const countsAsSale = (c, validResult) => isLive(c) && (Boolean(c.accepted) || isValidResult(c.result, validResult));

// rejected = discarded by hand; valid = sheet says valid; accepted = not valid in the sheet but accepted by hand;
// invalid / review = pending.
function resultStatus(c, validResult) {
  if (c.rejected) return 'rejected';
  if (isValidResult(c.result, validResult)) return 'valid';
  if (c.accepted) return 'accepted';
  return normalizeText(c.result).includes('invalido') ? 'invalid' : 'review';
}

// "Day N": the first day with spend is day 1. null when the ad has not spent yet.
const dayOf = (ad, today) => {
  const first = String(ad?.firstSpendDate ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(first) && first <= today ? daysBetween(first, today) + 1 : null;
};

const addTotals = (to, from) => {
  for (const k of ['gasto', 'spendNet', 'vat', 'mensajes', 'valor', 'valorNative', 'ventas', 'comisiones', 'costos', 'impuestos']) to[k] += from[k];
  return to;
};

// Metrics plus the gross margin: value - spend - fees - per-sale costs - taxes.
const withMetrics = (t) => {
  const margen = t.valor - t.gasto - t.comisiones - t.costos - t.impuestos;
  return { ...t, ...computeMetrics(t), margen, margenPct: t.valor ? margen / t.valor : 0 };
};
const zero = () => ({ gasto: 0, spendNet: 0, vat: 0, mensajes: 0, valor: 0, valorNative: 0, ventas: 0, comisiones: 0, costos: 0, impuestos: 0 });

export function buildReport({
  insights, comprobantes, identities = {}, ads = {}, config, from, to, group = 'campaign', today, country = '', splitCountry = false, raises = {}, fxRates = {},
  // Scope: `accounts` = { all, ids } (null/all = every account), `names` = lowercase ad-name prefixes, `accountMeta` = { act_id: { name, currency, portfolioName } }.
  accounts = null, names = [], accountMeta = {},
  // Hour-of-day window ({ start, end } or null = whole day): sales are filtered by the hour their payment was registered
  // and spend by the hour Meta delivered it (days without hourly spend fall back to the whole day and are noted).
  hours = null,
  // Hourly spend rows (Meta, WITHOUT IVA, hour in Bogota time): { date, hour, adId, accountId, gasto, ...names }.
  hourlyInsights = [],
}) {
  // "ct" is the legacy name of the grouping that merged campaigns by code: it is now the campaign grouping.
  if (group === 'ct') group = 'campaign';
  const prefix = config.campaignPrefix;
  const words = config.countryWords ?? DEFAULT_COUNTRY_TOKENS;
  const wanted = country && country !== 'all' ? country : '';
  // "-" selects the data without a country; any other value is a country code.
  const matches = (code) => !wanted || (wanted === '-' ? code === '' : code === wanted);
  const inRange = (d) => d >= from && d <= to;
  // Messages are not split by hour: with an hour window they (and cost per message / conversion) are null = N/D.
  const metricsOf = (t) => {
    const m = withMetrics(t);
    return hours ? { ...m, mensajes: null, costoMensaje: null, conversion: null } : m;
  };

  const accountSel = accounts && !accounts.all ? new Set(accounts.ids) : null;
  const filtering = Boolean(accountSel) || names.length > 0;
  // "Todas" means the configured accounts plus rows with no account (legacy): a removed account's history stays in the
  // database but no longer counts.
  const configured = accounts ? new Set(['', ...accounts.ids]) : null;
  const scoped = scopeInsights({
    rows: insights.filter((r) => inRange(r.date) && isMonitored(r.campaignName, prefix)),
    accounts: accountSel ?? configured, names, accountMeta, config, fxRates,
  });
  const monitoredInsights = scoped.rows;
  const seen = {};
  for (const r of insights) seen[r.adId] = { adName: r.adName, adsetName: r.adsetName ?? '', campaignId: r.campaignId, campaignName: r.campaignName, accountId: r.accountId ?? '' };
  // Ads known from Meta's ad list (even without spend in the loaded insights) still tell which campaign owns them.
  const fromAds = (adId) => {
    const ad = ads[adId];
    return ad && (ad.campaignId || ad.campaignName) ? { adName: ad.name ?? '', adsetName: ad.adsetName ?? '', campaignId: ad.campaignId ?? '', campaignName: ad.campaignName ?? '' } : null;
  };
  const identityOf = (adId) => (adId ? (identities[adId] ?? seen[adId] ?? fromAds(adId)) : null);

  // Country of a payment: manual/stored value, else derived (phone, then the ad's campaign, then the flow).
  const saleCountry = (c) => c.country || deriveCountry({ phone: c.phone, campaignName: identityOf(c.adId)?.campaignName, flow: c.flow }, words).country;

  // Payments of the flow that belong to a monitored ad, to an unknown ad, or to no ad at all.
  const flowRows = comprobantes.filter((c) => inRange(c.date) && matchesFlow(c.flow, config.flowPrefix));
  const accountOfAd = (adId) => identities[adId]?.accountId || seen[adId]?.accountId || ads[adId]?.accountId || '';
  const monitoredRows = flowRows.filter((c) => {
    const id = identityOf(c.adId);
    return !id || isMonitored(id.campaignName, prefix);
  });
  // With an account or name filter a payment counts only when it maps to an ad of that scope; the rest is reported in `notes`.
  let unattributed = 0;
  const attributable = !filtering ? monitoredRows.filter((c) => !configured || configured.has(accountOfAd(c.adId))) : monitoredRows.filter((c) => {
    const id = identityOf(c.adId);
    if (!id || (accountSel && !accountOfAd(c.adId))) {
      if (isLive(c)) unattributed += 1;
      return false;
    }
    return (!accountSel || accountSel.has(accountOfAd(c.adId))) && matchesName({ adName: id.adName, adsetName: id.adsetName ?? seen[c.adId]?.adsetName ?? ads[c.adId]?.adsetName, campaignName: id.campaignName }, names);
  });
  const notes = unattributed
    ? [{ code: 'unattributed_sales', count: unattributed, message: `${unattributed} ${unattributed === 1 ? 'pago sin anuncio identificable no se cuenta' : 'pagos sin anuncio identificable no se cuentan'} porque hay un filtro de cuenta o nombre. Quita el filtro para verlos.` }]
    : [];
  const withCountry = new Map(attributable.map((c) => [c, saleCountry(c)]));
  const allSales = attributable.filter((c) => countsAsSale(c, config.validResult)).map((c) => ({ ...c, country: withCountry.get(c), hour: hourOfRegistered(c.registered) }));
  const sales = hours ? allSales.filter((s) => inHours(s.hour, hours)) : allSales;
  if (hours) {
    const unreadable = allSales.filter((s) => s.hour === null).length;
    if (unreadable) notes.push({ code: 'hours_unreadable', count: unreadable, message: `${unreadable} ${unreadable === 1 ? 'pago no tiene hora legible y no se cuenta' : 'pagos no tienen hora legible y no se cuentan'} mientras hay un horario.` });
  }
  const vatPct = Math.max(0, Number(config.spendVatPct ?? 0));

  // ---- hourly spend (Meta hours already shifted to Bogota when stored)
  const hourlyInRange = hourlyInsights.filter((r) => inRange(r.date) && isMonitored(r.campaignName, prefix));
  const hourlyScoped = scopeInsights({ rows: hourlyInRange, accounts: accountSel ?? configured, names, accountMeta, config, fxRates }).rows;
  const dayKey = (r) => `${r.accountId ?? ''}|${r.date}`;
  const covered = new Set(hourlyInRange.map(dayKey));
  // Days with daily spend but no hourly rows for that account.
  const missingDays = new Set(monitoredInsights.filter((r) => r.gasto > 0 && !covered.has(dayKey(r))).map(dayKey));
  const adDay = (r) => `${r.date}|${r.adId}`;
  const dailyByAdDay = new Map();
  for (const r of monitoredInsights) {
    if (!dailyByAdDay.has(adDay(r))) dailyByAdDay.set(adDay(r), []);
    dailyByAdDay.get(adDay(r)).push(r);
  }
  // Country share of an ad's day (daily spend by country), used to split hourly spend, which has no country.
  const sharesOf = (r) => {
    const parts = dailyByAdDay.get(adDay(r)) ?? [{ country: '', gasto: 1 }];
    const total = parts.reduce((n, p) => n + p.gasto, 0);
    return parts.map((p) => ({ country: p.country ?? '', share: total > 0 ? p.gasto / total : 1 / parts.length }));
  };
  // With an hour window the spend is the one delivered inside it; messages are not split by hour, so they are dropped.
  let spendRows = monitoredInsights;
  if (hours) {
    const inWindow = new Map();
    for (const h of hourlyScoped) if (inHours(h.hour, hours)) inWindow.set(adDay(h), (inWindow.get(adDay(h)) ?? 0) + h.gasto);
    spendRows = monitoredInsights.map((r) => {
      if (!covered.has(dayKey(r))) return { ...r, mensajes: 0 };
      const share = sharesOf(r).find((p) => p.country === (r.country ?? ''))?.share ?? 0;
      return { ...r, gasto: (inWindow.get(adDay(r)) ?? 0) * share, mensajes: 0 };
    });
    if (missingDays.size) {
      const n = missingDays.size;
      notes.push({ code: 'hourly_spend_missing', count: n, message: `${n} ${n === 1 ? 'día no tiene' : 'días no tienen'} gasto por hora guardado: en ${n === 1 ? 'ese día' : 'esos días'} el gasto es el del día completo y el ROAS con horario es aproximado.` });
    }
  }
  const joinedAll = joinByDateAndAd({ insights: spendRows, sales, vatPct, convert: (s) => economics(s, config, s.country, fxRates) });

  // Countries that have data at all (before the enabled-countries scope), so the settings can offer them.
  const detectedMap = new Map();
  for (const e of joinedAll.values()) {
    if (!e.country) continue;
    const d = detectedMap.get(e.country) ?? { country: e.country, gasto: 0, ventas: 0 };
    d.gasto += e.gasto;
    d.ventas += e.ventas;
    detectedMap.set(e.country, d);
  }
  const detected = [...detectedMap.values()].sort((a, b) => b.gasto - a.gasto || b.ventas - a.ventas);

  // Only enabled countries are shown (others are left out, or grouped as "Otros países" when the user asks).
  const joined = new Map();
  for (const e of joinedAll.values()) {
    const code = scopeCountry(e.country, config);
    if (code === null) continue;
    const key = `${e.date}|${e.adId}|${code}`;
    if (!joined.has(key)) joined.set(key, blank(e.date, e.adId, code));
    addTotals(joined.get(key), e);
  }

  const describe = (adId, id = identityOf(adId)) => {
    const campaignName = id?.campaignName ?? '';
    const adName = id?.adName ?? '';
    const fromCampaign = parseCt(campaignName);
    const parsed = fromCampaign.ct ? fromCampaign : parseCt(adName);
    return {
      adId,
      adName,
      campaignId: id?.campaignId ?? '',
      campaignName,
      known: Boolean(id),
      // Informational tag read from the name; it never decides the group.
      ct: !adId ? NO_AD : (parsed.ct ?? NO_CT),
    };
  };

  // The real campaign of an ad (payments follow their ad id to it). No ad id: "Sin anuncio"; an ad Meta never told us about: unknown.
  const campaignGroupOf = (info) => {
    if (!info.adId) return { key: NO_AD, label: NO_AD };
    if (!info.known) return { key: UNKNOWN_AD, label: 'Anuncio desconocido' };
    return { key: info.campaignId || info.campaignName, label: info.campaignName || '(campaña sin nombre)' };
  };

  // Group of an ad before the country split.
  const baseGroupOf = (info) => {
    if (group === 'ad') return !info.adId ? { key: NO_AD, label: NO_AD } : { key: info.adId, label: info.adName || `Anuncio ${info.adId}` };
    return campaignGroupOf(info);
  };
  const groupOf = (info, entryCountry) => {
    const g = baseGroupOf(info);
    if (splitCountry) return { key: `${g.key}|${entryCountry}`, label: `${g.label} · ${entryCountry || NO_COUNTRY}` };
    return g;
  };

  // Delivery state per group, from the stored Meta status of EVERY known ad (not only the ones that spent in the range):
  // a group is "paused" only when it has known ads and none of them is delivering.
  const deliveryBy = (keyOf) => {
    const map = new Map();
    for (const [adId, ad] of Object.entries(ads)) {
      const id = identityOf(adId);
      if (!ad?.effectiveStatus || !id || !isMonitored(id.campaignName, prefix)) continue;
      const key = keyOf(describe(adId, id));
      const d = map.get(key) ?? { total: 0, active: 0 };
      d.total += 1;
      if (!isInactiveStatus(ad.effectiveStatus)) d.active += 1;
      map.set(key, d);
    }
    return map;
  };
  const delivery = deliveryBy((info) => baseGroupOf(info).key);
  const campaignDelivery = group === 'campaign' ? delivery : deliveryBy((info) => campaignGroupOf(info).key);
  const isPaused = (d, adIds, hasKnown) => Boolean(hasKnown && d && d.total > 0 && d.active === 0 && [...adIds].every((id) => isInactiveStatus(ads[id]?.effectiveStatus)));

  // Per-country table (always over every country, whatever the filter).
  const byCountry = new Map();
  for (const e of joined.values()) {
    if (!byCountry.has(e.country)) byCountry.set(e.country, zero());
    addTotals(byCountry.get(e.country), e);
  }
  const countries = [...byCountry.entries()]
    .filter(([, totals]) => totals.gasto > 0 || totals.ventas > 0 || totals.valor > 0)
    .map(([code, totals]) => {
      const s = countrySettings(config, code, to, fxRates);
      return {
        country: code, name: code ? (COUNTRY_NAMES[code] ?? code) : NO_COUNTRY, currency: s.currency, rateToCop: s.rate, rateMissing: totals.valor > 0 && !s.rateSet,
        ...metricsOf(totals),
      };
    })
    .sort((a, b) => b.gasto - a.gasto || b.valor - a.valor);

  // Per ad account (whatever the country filter): "Sin cuenta" holds what cannot be tied to an account.
  const byAccount = new Map();
  for (const e of joined.values()) {
    const id = accountOfAd(e.adId);
    if (!byAccount.has(id)) byAccount.set(id, zero());
    addTotals(byAccount.get(id), e);
  }
  const accountRows = [...byAccount.entries()]
    .filter(([, totals]) => totals.gasto > 0 || totals.ventas > 0 || totals.valor > 0)
    .map(([id, totals]) => ({
      accountId: id, name: id ? (accountMeta[id]?.name || id) : 'Sin cuenta', portfolioName: accountMeta[id]?.portfolioName ?? '',
      currency: accountMeta[id]?.currency || config.currency, ...metricsOf(totals),
    }))
    .sort((a, b) => b.gasto - a.gasto || b.valor - a.valor);

  const groups = new Map();
  const daily = new Map(eachDate(from, to).map((d) => [d, blank(d, '')]));
  const total = zero();
  // Daily series per real campaign (whatever the table grouping), so the chart can focus on one campaign.
  const campaignDays = new Map();
  for (const e of joined.values()) {
    if (!matches(e.country)) continue;
    const info = describe(e.adId);
    const g = groupOf(info, e.country);
    if (!groups.has(g.key)) {
      groups.set(g.key, {
        ...zero(),
        key: g.key, baseKey: baseGroupOf(info).key, label: g.label, ct: info.ct, adId: group === 'ad' ? info.adId : '',
        adName: group === 'ad' ? info.adName : '', campaignId: info.campaignId,
        campaignName: info.campaignName, country: splitCountry ? e.country : '', hasAction: false, adIds: new Set(),
      });
    }
    const row = groups.get(g.key);
    addTotals(row, e);
    if (e.adId) row.adIds.add(e.adId);
    if (info.known) row.hasAction = true;
    const day = daily.get(e.date);
    if (day) addTotals(day, e);
    if (inRange(e.date)) {
      const c = campaignGroupOf(info);
      if (!campaignDays.has(c.key)) campaignDays.set(c.key, { campaignId: info.known ? info.campaignId : '', campaign: c.label, key: c.key, adIds: new Set(), known: false, days: new Map(eachDate(from, to).map((d) => [d, blank(d, '')])) });
      const cd = campaignDays.get(c.key);
      addTotals(cd.days.get(e.date), e);
      if (e.adId) cd.adIds.add(e.adId);
      if (info.known) cd.known = true;
    }
    addTotals(total, e);
  }
  const dailyPoint = ({ date, gasto, spendNet, vat, valor, ventas, mensajes }) => ({ date, gasto, spendNet, vat, valor, ventas, mensajes: hours ? null : mensajes, roas: spendNet ? valor / spendNet : 0 });
  const campaignDaily = [...campaignDays.values()]
    .map((c) => ({
      campaignId: c.campaignId, campaign: c.campaign, key: c.key, paused: isPaused(campaignDelivery.get(c.key), c.adIds, c.known),
      daily: [...c.days.values()].map(dailyPoint),
    }))
    .filter((c) => c.daily.some((d) => d.gasto > 0 || d.valor > 0))
    .sort((a, b) => a.campaign.localeCompare(b.campaign, 'es', { numeric: true }));

  // Sales per hour of registration for the same scope (range, accounts, country, filters), whatever the window: the
  // chart shows the whole day and only highlights the window.
  // Spend per hour comes from Meta (IVA added here, ROAS on the net spend). The same series is kept per real campaign so
  // the chart's campaign selector can focus on one.
  const newHours = () => Array.from({ length: 24 }, (_, hour) => ({ hour, ventas: 0, valor: 0, gasto: 0, spendNet: 0, vat: 0, roas: 0 }));
  const hourly = newHours();
  const hourlyByCampaign = new Map();
  const bump = (adId, hour, field, amount) => {
    hourly[hour][field] += amount;
    const c = campaignGroupOf(describe(adId));
    if (!hourlyByCampaign.has(c.key)) hourlyByCampaign.set(c.key, newHours());
    hourlyByCampaign.get(c.key)[hour][field] += amount;
  };
  for (const h of hourlyScoped) {
    for (const p of sharesOf(h)) {
      const code = scopeCountry(p.country, config);
      if (code === null || !matches(code)) continue;
      bump(h.adId, h.hour, 'spendNet', h.gasto * p.share);
    }
  }
  for (const s of allSales) {
    const code = scopeCountry(s.country, config);
    if (code === null || !matches(code) || s.hour === null) continue;
    bump(s.adId, s.hour, 'ventas', 1);
    bump(s.adId, s.hour, 'valor', economics(s, config, s.country, fxRates).valor);
  }
  const finishHours = (hours) => {
    for (const h of hours) {
      h.vat = (h.spendNet * vatPct) / 100;
      h.gasto = h.spendNet + h.vat;
      h.roas = h.spendNet ? h.valor / h.spendNet : 0;
    }
    return hours;
  };
  finishHours(hourly);
  const campaignHourly = [...hourlyByCampaign.entries()].map(([key, hours]) => ({ key, hourly: finishHours(hours) }));

  const rows = [...groups.values()]
    .map(({ adIds, hasAction, baseKey, ...row }) => {
      const metrics = metricsOf(row);
      const d = delivery.get(baseKey);
      // Paused: every known ad of the group is off in Meta and so is each ad that spent in the range.
      const paused = isPaused(d, adIds, hasAction);
      // With an hour window only sales are filtered while spend stays whole-day, so ROAS-based actions would mislead: none.
      const suggested = hasAction && !hours ? suggestAction(metrics, config.thresholds) : null;
      const ages = [...adIds].map((id) => dayOf(ads[id], today)).filter((n) => n !== null);
      const single = group === 'ad' ? ads[row.adId] : null;
      return {
        ...metrics,
        ageDays: ages.length ? Math.max(...ages) : null,
        firstSpendDate: [...adIds].map((id) => ads[id]?.firstSpendDate).filter(Boolean).sort()[0] ?? null,
        effectiveStatus: single?.effectiveStatus ?? null,
        // Latest recent budget raise among its ads (informational: day N since the raise).
        raise: [...adIds].map((id) => raises[id]).filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null,
        // A group that is already off in Meta shows "Apagada" instead of a recommendation (metrics are kept).
        action: paused ? ACTIONS.paused : suggested,
        suggestedAction: paused ? suggested : null,
        paused,
      };
    })
    .sort((a, b) => b.gasto - a.gasto || b.valor - a.valor);

  const list = flowRows
    .filter((c) => attributable.includes(c))
    .filter((c) => scopeCountry(withCountry.get(c), config) !== null && matches(scopeCountry(withCountry.get(c), config)))
    .map((c) => {
      const info = describe(c.adId);
      const campaign = campaignGroupOf(info);
      const code = scopeCountry(withCountry.get(c), config);
      return {
        key: c.key ?? '',
        date: c.date,
        registered: c.registered,
        valor: c.valor,
        valorSheet: c.valorSheet ?? c.valor,
        valueOverridden: Boolean(c.valueOverridden),
        valorCop: c.valor * countrySettings(config, code, c.date, fxRates).rate,
        bank: c.bank,
        flow: c.flow,
        adId: c.adId,
        accountId: accountOfAd(c.adId),
        adName: info.adName,
        adSource: c.adSource ?? 'hoja',
        ct: info.ct,
        campaignId: info.known ? info.campaignId : '',
        campaign: campaign.label,
        result: c.result,
        status: resultStatus(c, config.validResult),
        accepted: Boolean(c.accepted),
        phoneMasked: maskPhone(c.phone),
        phone: c.phone ?? '',
        clientName: c.clientName ?? '',
        payerName: c.payerName ?? '',
        country: code,
        countrySource: c.country ? (c.countrySource || 'telefono') : deriveCountry({ phone: c.phone, campaignName: identityOf(c.adId)?.campaignName, flow: c.flow }, words).source,
        gone: Boolean(c.gone),
        rejected: Boolean(c.rejected),
      };
    })
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));

  // Every enabled country is offered even without data (the selector always shows it).
  const withData = new Set(countries.map((c) => c.country));
  const enabledCountries = (config.enabledCountries ?? []).map((code) => ({
    country: code, name: COUNTRY_NAMES[code] ?? code, currency: config.countries?.[code]?.currency ?? 'COP', hasData: withData.has(code),
  }));
  // Rate behind each enabled non-COP country at the end of the range (so "today" shows today's rate).
  const fx = fxSummary(config, fxRates, to);

  return {
    range: { from, to },
    group,
    enabledCountries,
    fx,
    country: wanted,
    accountFilter: accountSel ? { all: false, ids: [...accountSel] } : { all: true, ids: [] },
    nameFilter: names,
    accounts: accountRows,
    warnings: scoped.warnings,
    notes,
    splitCountry,
    currency: config.currency,
    spendVatPct: config.spendVatPct ?? 0,
    kpis: metricsOf(total),
    hours: hours ? { start: hours.start, end: hours.end, restricted: true } : { start: 0, end: 24, restricted: false },
    hourly,
    // Hourly spend comes from Meta at ad level (one row per ad and hour), so campaign and name filters apply to it.
    campaignHourly,
    hourlySpend: { level: 'ad', available: hourlyInRange.length > 0, daysMissing: missingDays.size },
    rows,
    countries,
    detected,
    daily: [...daily.values()].map(dailyPoint),
    campaignDaily,
    // What the paused/off rows spent in the range (it is part of the KPIs): lets the screen say so when it hides them.
    inactive: { gasto: rows.filter((r) => r.paused).reduce((n, r) => n + r.gasto, 0), count: rows.filter((r) => r.paused).length },
    comprobantes: list,
    // Pending: not valid in the sheet and not accepted by hand (within the range and the enabled countries).
    reviewCount: list.filter((c) => !c.gone && (c.status === 'review' || c.status === 'invalid')).length,
  };
}

export { ACTIONS };
