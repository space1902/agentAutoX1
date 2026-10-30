// Daily decisions (phase B). Pure: given the stored data and the account clock, returns the decisions that are due
// and have not been issued yet. The app never changes budgets or pauses ads: it only recommends.
//  - Test verdict: on day `testNotifyDay` (day 1 = first day with spend) at `testNotifyAt`, metrics of days 1..N
//    for every ad and every CT, turned into an action with the configured thresholds.
//  - Post-budget check: on day `postBudgetNotifyDay` (the day of the raise is day 1) at `postBudgetNotifyAt`,
//    compare the days since the raise with the `windowDays` before it.
import { suggestAction } from './metrics.js';
import { extractCt } from './parse.js';
import { buildReport, isMonitored } from './report.js';
import { addDays, daysBetween } from './time.js';

const VERDICTS = Object.freeze({
  raise: { key: 'raise', label: 'Subir más', tone: 'green' },
  hold: { key: 'hold', label: 'Mantener y esperar', tone: 'gray' },
  lower: { key: 'lower', label: 'Bajar presupuesto', tone: 'red' },
});

const num1 = (n) => n.toFixed(1).replace('.', ',');
const money = (n) => `$${Math.round(n).toLocaleString('es-CO')}`;
const sales = (n) => `${n} ${n === 1 ? 'venta' : 'ventas'}`;
const hm = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

// `now` = { date: 'YYYY-MM-DD', minutes } in the account timezone.
export function isDue(now, dueDate, notifyAt, lateDays) {
  if (now.date === dueDate) return now.minutes >= hm(notifyAt) ? { due: true, late: false } : { due: false, late: false };
  if (now.date > dueDate && now.date <= addDays(dueDate, lateDays)) return { due: true, late: true };
  return { due: false, late: false };
}

export function testVerdict(metrics, days, thresholds) {
  const action = suggestAction(metrics, thresholds);
  if (action.key === 'wait') {
    return { action, reason: `Gasto de ${money(metrics.gasto)} en ${days} días: todavía no llega al mínimo de ${money(thresholds.minSpend)} para decidir.` };
  }
  const cpa = metrics.ventas > 0 ? ` · costo por venta ${money(metrics.costoVenta)}` : '';
  return { action, reason: `ROAS ${num1(metrics.roas)} con ${sales(metrics.ventas)} en ${days} días${cpa}.` };
}

// How much worse (in %) the cost per sale is now; null when either side has no sales to compare.
const cpaWorsenPct = (after, before) => (after.ventas > 0 && before.ventas > 0 && before.costoVenta > 0 ? (after.costoVenta / before.costoVenta - 1) * 100 : null);

export function postBudgetVerdict(after, before, life, thresholds, change) {
  const worsen = cpaWorsenPct(after, before);
  const enoughSpend = after.gasto >= thresholds.minSpend;
  const cpaText = worsen === null ? 'sin ventas previas para comparar' : `${worsen >= 0 ? '+' : ''}${Math.round(worsen)} % en costo por venta`;
  const summary = `Tras subir ${Math.round(change.pct)} %: ROAS ${num1(after.roas)} (antes ${num1(before.roas)}) con ${sales(after.ventas)}, ${cpaText}.`;

  if (after.gasto > 0 && enoughSpend && (after.roas < thresholds.watchRoas || (after.ventas >= life.minSales && worsen !== null && worsen > life.lowerCpaWorsenPct))) {
    return { verdict: VERDICTS.lower, suggestedPct: null, worsen, reason: `${summary} El resultado empeoró: conviene bajar el presupuesto.` };
  }
  if (after.roas >= life.minRoasToScale && after.ventas >= life.minSales && (worsen === null || worsen <= life.maxCpaWorsenPct)) {
    const suggestedPct = Math.min(life.raisePct, life.maxRaisePct);
    return { verdict: VERDICTS.raise, suggestedPct, worsen, reason: `${summary} Se mantiene estable: puedes subir otro ${suggestedPct} %.` };
  }
  return { verdict: VERDICTS.hold, suggestedPct: null, worsen, reason: `${summary} Aún no hay suficiente para decidir: espera más datos.` };
}

function kpisFor({ insights, comprobantes, identities, config, adIds, from, to }) {
  return buildReport({
    insights: insights.filter((r) => adIds.has(r.adId)),
    comprobantes: comprobantes.filter((c) => adIds.has(c.adId)),
    identities,
    ads: {},
    config: { ...config, campaignPrefix: 'all', includeOtherCountries: true },
    from,
    to,
    group: 'ad',
    today: to,
  }).kpis;
}

function testDecisions({ insights, comprobantes, identities, ads, config, now, existing }) {
  const life = config.lifecycle;
  const out = [];
  const monitoredAds = Object.entries(ads)
    .filter(([adId, ad]) => ad?.firstSpendDate && isMonitored(identities[adId]?.campaignName ?? '', config.campaignPrefix))
    .map(([adId, ad]) => ({ adId, first: ad.firstSpendDate }));
  const days = life.testNotifyDay;
  const issue = (kind, entityType, entityId, label, first, adIds) => {
    const key = `${kind}:${entityId}:${first}:d${days}`;
    if (existing.has(key)) return;
    const { due, late } = isDue(now, addDays(first, days - 1), life.testNotifyAt, life.lateDays);
    if (!due) return;
    const range = { from: first, to: addDays(first, days - 1) };
    const metrics = kpisFor({ insights, comprobantes, identities, config, adIds, ...range });
    const verdict = testVerdict(metrics, days, config.thresholds);
    out.push({
      key, kind, entityType, entityId, label, dayN: days, late, dueDate: range.to, range,
      verdict: verdict.action, reason: verdict.reason, metrics, extra: { firstSpendDate: first, nominalTestDays: life.testDays },
    });
  };

  for (const { adId, first } of monitoredAds) {
    issue('test', 'ad', adId, identities[adId]?.adName || `Anuncio ${adId}`, first, new Set([adId]));
  }
  const byCt = new Map();
  for (const { adId, first } of monitoredAds) {
    const ct = extractCt(identities[adId]?.campaignName, identities[adId]?.adName);
    if (!ct) continue;
    const entry = byCt.get(ct) ?? { first, adIds: new Set() };
    entry.adIds.add(adId);
    if (first < entry.first) entry.first = first;
    byCt.set(ct, entry);
  }
  for (const [ct, { first, adIds }] of byCt) issue('ct_test', 'ct', ct, ct, first, adIds);
  return out;
}

// Raises whose check is due and not issued yet. Needs no insight data, so the scheduler can decide to sync first.
export function dueBudgetChanges({ changes, config, now, existing }) {
  const life = config.lifecycle;
  if (!life.budgetEnabled) return [];
  const days = life.postBudgetNotifyDay;
  const out = [];
  for (const change of changes) {
    const key = `budget:${change.entityType}:${change.entityId}:${change.date}:${change.newBudget}:d${days}`;
    if (existing.has(key)) continue;
    const { due, late } = isDue(now, addDays(change.date, days - 1), life.postBudgetNotifyAt, life.lateDays);
    if (due) out.push({ change, key, late });
  }
  return out;
}

function budgetDecisions({ insights, comprobantes, identities, config, changes, now, existing }) {
  const life = config.lifecycle;
  const out = [];
  const days = life.postBudgetNotifyDay;
  for (const { change, key, late } of dueBudgetChanges({ changes, config, now, existing })) {
    const field = change.entityType === 'campaign' ? 'campaignId' : 'adsetId';
    const rows = insights.filter((r) => r[field] === change.entityId);
    const adIds = new Set(rows.map((r) => r.adId));
    if (!adIds.size) continue;
    const latest = rows[rows.length - 1];
    const label = (change.entityType === 'campaign' ? latest.campaignName : latest.adsetName) || change.entityId;
    if (change.entityType === 'adset' && !isMonitored(latest.campaignName, config.campaignPrefix)) continue;

    const range = { from: change.date, to: addDays(change.date, days - 1) };
    const beforeRange = { from: addDays(change.date, -life.windowDays), to: addDays(change.date, -1) };
    const after = kpisFor({ insights, comprobantes, identities, config, adIds, ...range });
    const before = kpisFor({ insights, comprobantes, identities, config, adIds, ...beforeRange });
    const result = postBudgetVerdict(after, before, life, config.thresholds, change);
    const daysSincePrevious = change.previous ? daysBetween(change.previous.date, change.date) : null;
    const previousNote = change.previous ? ` Último cambio anterior: hace ${daysSincePrevious} días (${Math.round(change.previous.pct)} %).` : '';
    out.push({
      key, kind: 'budget', entityType: change.entityType, entityId: change.entityId, label, dayN: days, late, dueDate: range.to, range,
      verdict: result.verdict, reason: `${result.reason}${previousNote}`, metrics: after,
      extra: {
        changeId: change.id, changeDate: change.date, changePct: change.pct, oldBudget: change.oldBudget, newBudget: change.newBudget,
        exact: change.exact, before, beforeRange, suggestedPct: result.suggestedPct, cpaWorsenPct: result.worsen,
        previous: change.previous, daysSincePrevious,
      },
    });
  }
  return out;
}

// data: { insights, comprobantes, identities, ads (with firstSpendDate), changes, config, now, existing:Set<key> }
export function evaluateDue(data) {
  const life = data.config.lifecycle;
  return [...(life.testEnabled ? testDecisions(data) : []), ...(life.budgetEnabled ? budgetDecisions(data) : [])];
}

const KIND_LABEL = { test: 'Prueba de anuncio', ct_test: 'Prueba de CT', budget: 'Presupuesto' };

// Text for the desktop notification and the WhatsApp message.
export function decisionMessage(d) {
  const title = `${KIND_LABEL[d.kind] ?? 'Decisión'}: ${d.label} · día ${d.dayN}${d.late ? ' (atrasado)' : ''}`;
  const body = `${d.verdict.label}. ${d.reason}`;
  return { title, body, text: `*${title}*\n${body}` };
}
