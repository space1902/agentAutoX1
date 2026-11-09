// "Presupuestos": per-campaign timeline of daily-budget changes with the metrics of the days before and after each
// change, plus a suggested next budget. Pure: it only reads stored data (no Meta requests) and never changes a budget.
//
// Windows (same convention as decisions.js, reusing config.lifecycle):
//  - after  = `postBudgetDays` days starting ON the day of the change (the day of the change is day 1),
//  - before = the `windowDays` days right before the change.
//  A change is "complete" once the last day of its after window is over (day 4 when postBudgetDays = 3).
// A raise is MEASURED when it is complete, has spend after it and no other budget change (of the campaign or of one of
// its ad sets) falls inside its after window. Earlier changes do not matter: raising every 3 days is the normal ladder.
import { buildReport } from './report.js';
import { computeMetrics } from './metrics.js';
import { addDays, daysBetween, eachDate } from './time.js';

export const MIN_MEASURED_RAISES = 8;
// A raise-size bucket needs at least this many measured raises before it can be recommended (1 of 1 is not evidence).
export const MIN_BUCKET_SAMPLE = 3;
const ACTIVE_WITHIN_DAYS = 2;
const MAX_LOOKBACK_DAYS = 600;

export const BUCKETS = Object.freeze([
  Object.freeze({ key: 'le15', label: '≤15 %', max: 15 }),
  Object.freeze({ key: 'mid', label: '16–25 %', max: 25 }),
  Object.freeze({ key: 'gt25', label: '>25 %', max: Infinity }),
]);
const bucketOf = (pct) => BUCKETS.find((b) => Math.round(pct) <= b.max);

const STATUS = Object.freeze({
  cut: { key: 'cut', label: 'BAJÓ', tone: 'amber' },
  worked: { key: 'worked', label: 'funcionó', tone: 'green' },
  worsened: { key: 'worsened', label: 'empeoró', tone: 'red' },
  stable: { key: 'stable', label: 'sin cambio claro', tone: 'gray' },
  overlap: { key: 'overlap', label: 'mezclado con otro cambio', tone: 'gray' },
  nodata: { key: 'nodata', label: 'sin datos', tone: 'gray' },
});

// ---------- formatting / rounding ----------

const WHOLE_UNITS = Object.freeze({ COP: 1000, CLP: 1000, PYG: 1000, MXN: 10 });
const ZERO_DECIMAL = new Set(['COP', 'CLP', 'PYG', 'JPY', 'KRW', 'VND', 'ISK', 'UGX', 'XAF', 'XOF']);

// Smallest step budgets are rounded to: 1.000 for COP-like currencies, finer when the budget is so small that the step
// would be a big jump (less than 5 steps in the budget).
export function budgetUnit(amount, currency) {
  let unit = WHOLE_UNITS[String(currency ?? '').toUpperCase()] ?? 1;
  while (unit > 1 && Math.abs(amount) / unit < 5) unit /= 10;
  return unit;
}

export function roundBudget(amount, currency) {
  const unit = budgetUnit(amount, currency);
  return Math.round(amount / unit) * unit;
}

const group = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
export function money(amount, currency = 'COP') {
  const whole = Number.isInteger(amount) ? group(amount) : `${group(Math.trunc(amount))},${String(Math.round((Math.abs(amount) % 1) * 100)).padStart(2, '0').replace(/0$/, '')}`;
  return !currency || currency === 'COP' ? `$${whole}` : `${currency} ${whole}`;
}
const num1 = (n) => n.toFixed(1).replace('.', ',');
const sales = (n) => `${n} ${n === 1 ? 'venta' : 'ventas'}`;
const pctText = (n) => `${Math.round(n)} %`;

// ---------- changes ----------

const pctChange = (from, to) => (from > 0 ? ((to - from) / from) * 100 : 0);
const endOfDay = (date) => Date.parse(`${date}T23:59:59Z`);

// Every budget change (raises AND cuts) of campaigns and ad sets: the activity log first (exact time), then the
// snapshot differences the log does not know. Several changes of the same entity on the same day collapse into the net
// one (dropped when it nets to zero). `divisorOf(type, id)` turns snapshot amounts (minor units) into whole units.
export function collectChanges({ events = [], histories = {}, divisorOf = () => 1 }) {
  const raw = events.map((e) => ({ entityType: e.entityType, entityId: String(e.entityId), date: e.date, time: e.time ?? null, oldBudget: e.oldBudget, newBudget: e.newBudget, exact: true }));
  for (const [key, rows] of Object.entries(histories)) {
    const [entityType, entityId] = key.split('|');
    const divisor = divisorOf(entityType, entityId) || 1;
    let last = null;
    for (const row of rows) {
      if (row.dailyBudget == null) continue;
      const value = row.dailyBudget / divisor;
      if (last !== null && value !== last) {
        const covered = events.some((e) => e.entityType === entityType && String(e.entityId) === entityId && e.newBudget === value && daysBetween(e.date, row.date) >= 0 && daysBetween(e.date, row.date) <= 2);
        if (!covered) raw.push({ entityType, entityId, date: row.date, time: row.firstSeen ?? null, oldBudget: last, newBudget: value, exact: false });
      }
      last = value;
    }
  }
  raw.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time ?? 0) - (b.time ?? 0)));
  const merged = new Map();
  for (const c of raw) {
    const key = `${c.entityType}|${c.entityId}|${c.date}`;
    const prev = merged.get(key);
    if (!prev) merged.set(key, { ...c });
    else {
      prev.newBudget = c.newBudget;
      prev.time = c.time ?? prev.time;
      prev.exact = prev.exact && c.exact;
    }
  }
  return [...merged.values()].filter((c) => Number.isFinite(c.oldBudget) && Number.isFinite(c.newBudget) && c.oldBudget !== c.newBudget);
}

// First day the loaded data must cover: the baseline of the oldest change, the requested range and the windows the
// suggestion needs, never further back than MAX_LOOKBACK_DAYS.
export function planDataStart({ changes, from, today, life }) {
  const dates = [from, ...changes.map((c) => c.date)].filter(Boolean).sort();
  const start = addDays(dates[0], -life.windowDays);
  const needed = addDays(today, -(life.postBudgetDays + life.windowDays));
  const earliest = start < needed ? start : needed;
  const floor = addDays(today, -MAX_LOOKBACK_DAYS);
  return earliest < floor ? floor : earliest;
}

// ---------- metrics of a window ----------

// `daily` = Map date -> { gasto, spendNet, valor, ventas, mensajes }. Missing days count as zero (and as "no data").
export function windowMetrics(daily, from, to) {
  const t = { gasto: 0, spendNet: 0, valor: 0, ventas: 0, mensajes: 0 };
  let days = 0;
  for (const date of eachDate(from, to)) {
    const p = daily.get(date);
    if (!p) continue;
    t.gasto += p.gasto;
    t.spendNet += p.spendNet ?? p.gasto;
    t.valor += p.valor;
    t.ventas += p.ventas;
    t.mensajes += p.mensajes;
    if (p.gasto > 0) days += 1;
  }
  return { from, to, days, ...t, ...computeMetrics(t) };
}

// How much worse (in %) the cost per sale is; null when either side has no sales to compare.
const cpaWorsenPct = (after, before) => (after.ventas > 0 && before.ventas > 0 && before.costoVenta > 0 ? (after.costoVenta / before.costoVenta - 1) * 100 : null);

// ---------- one change ----------

// `otherDates`: dates of the OTHER budget changes of the campaign and of its ad sets.
export function evaluateChange(change, { daily, today, life, thresholds, otherDates = [] }) {
  const n = life.postBudgetDays;
  const kind = change.newBudget > change.oldBudget ? 'raise' : 'cut';
  const pct = pctChange(change.oldBudget, change.newBudget);
  const before = windowMetrics(daily, addDays(change.date, -life.windowDays), addDays(change.date, -1));
  const after = windowMetrics(daily, change.date, addDays(change.date, n - 1));
  const daysSince = daysBetween(change.date, today);
  const complete = after.to < today;
  const overlap = otherDates.some((d) => d >= change.date && d <= after.to);
  const worsenPct = cpaWorsenPct(after, before);

  let status;
  let evalDay = null;
  let success = false;
  if (kind === 'cut') status = STATUS.cut;
  else if (!complete) {
    evalDay = Math.min(n, Math.max(1, daysSince + 1));
    status = { key: 'evaluating', label: `en evaluación (día ${evalDay} de ${n})`, tone: 'amber' };
  } else if (after.gasto === 0) status = STATUS.nodata;
  else if (overlap) status = STATUS.overlap;
  else {
    success = after.roas >= life.minRoasToScale;
    const worsened = (after.gasto >= thresholds.minSpend && after.roas < thresholds.keepRoas) || (after.ventas >= life.minSales && worsenPct !== null && worsenPct > life.lowerCpaWorsenPct);
    if (worsened) status = STATUS.worsened;
    else if (success && after.ventas >= life.minSales && (worsenPct === null || worsenPct <= life.maxCpaWorsenPct)) status = STATUS.worked;
    else status = STATUS.stable;
  }
  const measured = kind === 'raise' && complete && !overlap && after.gasto > 0;
  return {
    id: `campaign:${change.entityId}:${change.date}:${change.newBudget}`,
    date: change.date, time: change.time ?? null, exact: Boolean(change.exact), kind, oldBudget: change.oldBudget, newBudget: change.newBudget, pct,
    daysSince, complete, evalDay, before, after, worsenPct, overlap, measured, success: measured && success, status,
    bucket: kind === 'raise' ? bucketOf(pct).key : null,
  };
}

// ---------- learning ----------

const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
// Lower bound of the Wilson interval of a success rate (95 %): small perfect samples do not beat big good ones.
const wilsonLower = (successes, n, z = 1.96) => {
  if (n === 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
};
const standardPct =(life) => Math.min(life.raisePct, life.maxRaisePct);

// Success of a measured raise = ROAS after it stayed >= minRoasToScale. Learned mode needs MIN_MEASURED_RAISES of them.
export function summarizeLearning(records, { life }) {
  const measured = records.filter((r) => r.kind === 'raise' && r.measured);
  const buckets = BUCKETS.map((b) => {
    const rows = measured.filter((r) => bucketOf(r.pct).key === b.key);
    const successes = rows.filter((r) => r.success).length;
    return {
      key: b.key, label: b.label, n: rows.length, successes, rate: rows.length ? successes / rows.length : 0, score: wilsonLower(successes, rows.length),
      medianCpaChangePct: median(rows.map((r) => r.worsenPct).filter((v) => v !== null && v !== undefined)),
      pct: rows.length ? Math.round(median(rows.map((r) => r.pct))) : null,
    };
  }).filter((b) => b.n > 0);
  const learned = measured.length >= MIN_MEASURED_RAISES;
  let best = null;
  if (learned) {
    // Conservative ranking: Wilson lower bound of the success rate; ties go to the larger sample, then the smaller raise.
    for (const b of buckets) {
      if (b.n < MIN_BUCKET_SAMPLE) continue;
      if (best === null || b.score > best.score || (b.score === best.score && (b.n > best.n || (b.n === best.n && b.pct < best.pct)))) best = b;
    }
  }
  const parts = buckets.map((b, i) => (i === 0 ? `${b.label} mantuvo el ROAS en ${b.successes} de ${b.n}` : `${b.label} en ${b.successes} de ${b.n}`));
  const sentence = learned ? `Según lo aprendido: de ${measured.length} subidas, ${parts.join('; ')}.` : null;
  return {
    mode: learned ? 'learned' : 'learning', measured: measured.length, needed: MIN_MEASURED_RAISES, buckets, best, sentence,
    text: learned ? sentence : `Aprendiendo (${measured.length} de ${MIN_MEASURED_RAISES} subidas medidas): sugerencia estándar +${standardPct(life)} % cada ${life.postBudgetDays} días`,
  };
}

// ---------- suggestion ----------

// campaign = { active, currentBudget, currency, changes (chronological evaluated records of the campaign),
//              lastAnyChangeDate (campaign or ad set), daily (Map) }. Null when the campaign is not active.
export function suggestNext({ campaign, today, life, thresholds, learning }) {
  if (!campaign.active) return null;
  const { currentBudget, currency, changes, daily } = campaign;
  const n = life.postBudgetDays;
  const base = { mode: learning.mode, currentBudget, currency, evidence: learning.measured, learningText: learning.mode === 'learning' ? learning.text : learning.sentence, suggestedBudget: null, suggestedPct: null };

  if (campaign.lastAnyChangeDate) {
    const since = daysBetween(campaign.lastAnyChangeDate, today);
    if (since < n) {
      const day = Math.max(1, since + 1);
      return {
        ...base, action: { key: 'wait', label: `Esperar (día ${day} de ${n})`, tone: 'gray' },
        reason: `El presupuesto cambió ${since === 0 ? 'hoy' : `hace ${since} ${since === 1 ? 'día' : 'días'}`}: espera a completar ${n} días para medir el resultado.`, detail: null,
      };
    }
  }
  const last = changes.at(-1) ?? null;
  const cur = windowMetrics(daily, addDays(today, -n), addDays(today, -1));
  const baseline = last ? last.before : windowMetrics(daily, addDays(today, -n - life.windowDays), addDays(today, -n - 1));
  // After a cut the cost per sale is not compared: spending less is the point of a cut.
  const worsen = last?.kind === 'cut' ? null : cpaWorsenPct(cur, baseline);
  if (cur.gasto === 0) {
    return { ...base, action: { key: 'hold', label: 'Mantener', tone: 'gray' }, reason: `Sin gasto en los últimos ${n} días: no hay datos para decidir.`, detail: null };
  }
  const cpaText = worsen === null ? 'sin ventas previas para comparar' : `${worsen >= 0 ? '+' : ''}${Math.round(worsen)} % en costo por venta`;
  const detail = `Últimos ${n} días: ROAS ${num1(cur.roas)} con ${sales(cur.ventas)}, ${cpaText}.`;

  const worsened = (cur.gasto >= thresholds.minSpend && cur.roas < thresholds.keepRoas) || (cur.ventas >= life.minSales && worsen !== null && worsen > life.lowerCpaWorsenPct);
  if (worsened) {
    const reference = currentBudget ?? last?.newBudget ?? null;
    if (last?.kind === 'raise' && (reference === null || last.oldBudget < reference)) {
      return {
        ...base, action: { key: 'lower', label: `Bajar a ${money(last.oldBudget, currency)}`, tone: 'red' }, suggestedBudget: last.oldBudget,
        reason: `${learning.text.replace(/[.]$/, '')}. El resultado empeoró tras la última subida: vuelve al presupuesto anterior.`, detail,
      };
    }
    return {
      ...base, action: { key: 'hold', label: 'Mantener', tone: 'gray' },
      reason: `${learning.text.replace(/[.]$/, '')}. El rendimiento es bajo, pero ${last ? 'el último cambio fue una bajada' : 'no hay una subida previa a la que volver'}: revisa los anuncios antes de tocar el presupuesto.`, detail,
    };
  }
  if (cur.roas >= life.minRoasToScale && cur.ventas >= life.minSales && (worsen === null || worsen <= life.maxCpaWorsenPct)) {
    const learnedPct = learning.mode === 'learned' && learning.best ? learning.best.pct : null;
    const pct = Math.min(learnedPct ?? life.raisePct, life.maxRaisePct);
    let amount = null;
    if (currentBudget != null) {
      amount = roundBudget(currentBudget * (1 + pct / 100), currency);
      if (amount <= currentBudget) amount = currentBudget + budgetUnit(currentBudget, currency);
    }
    // Show the REAL change after rounding (15.000 -> 17.000 is +13 %), not the nominal one.
    const shownPct = amount !== null ? Math.round((amount / currentBudget - 1) * 100) : pct;
    const label = `Subir ${shownPct} %${amount !== null ? ` → ${money(amount, currency)}` : ''}`;
    const capped = learnedPct !== null && learnedPct > life.maxRaisePct ? ` (tope ${life.maxRaisePct} %)` : '';
    const reason = learnedPct !== null
      ? `${learning.sentence} Sugerido: +${shownPct} %${amount !== null ? ` → ${money(amount, currency)}` : ''}${capped}`
      : `${learning.text.replace(/[.]$/, '')}. El ROAS se mantiene y el costo por venta no empeoró: puedes subir ${shownPct} %.`;
    return { ...base, action: { key: 'raise', label, tone: 'green' }, suggestedPct: shownPct, nominalPct: pct, suggestedBudget: amount, reason, detail };
  }
  return { ...base, action: { key: 'hold', label: 'Mantener', tone: 'gray' }, reason: `${learning.text.replace(/[.]$/, '')}. Aún no hay señal clara para subir ni para bajar.`, detail };
}

// ---------- the whole plan ----------

export function buildBudgetPlan({
  insights, comprobantes, identities = {}, ads = {}, config, fxRates = {}, accountMeta = {}, accounts = null, names = [], country = '',
  events = [], histories = {}, today, from, to,
}) {
  const life = config.lifecycle;
  const thresholds = config.thresholds;

  const accountOfCampaign = new Map();
  const campaignOfAdset = new Map();
  for (const r of insights) {
    if (r.campaignId) {
      accountOfCampaign.set(r.campaignId, r.accountId ?? '');
      if (r.adsetId) campaignOfAdset.set(r.adsetId, r.campaignId);
    }
  }
  const currencyOf = (campaignId) => accountMeta[accountOfCampaign.get(campaignId)]?.currency || config.currency;
  const divisorOf = (type, id) => {
    const campaignId = type === 'campaign' ? id : campaignOfAdset.get(id);
    return campaignId && ZERO_DECIMAL.has(String(currencyOf(campaignId)).toUpperCase()) ? 1 : campaignId ? 100 : 1;
  };
  const all = collectChanges({ events, histories, divisorOf });
  const start = planDataStart({ changes: all, from, today, life });

  const reportOf = (scopeNames) => buildReport({
    insights, comprobantes, identities, ads, config, fxRates, from: start, to: today, group: 'campaign', today, country, accounts, names: scopeNames, accountMeta,
  });
  const scope = reportOf([]);
  const visible = names.length ? new Set(reportOf(names).campaignDaily.map((c) => c.campaignId).filter(Boolean)) : null;

  const records = [];
  const prepared = [];
  for (const c of scope.campaignDaily) {
    if (!c.campaignId) continue;
    const dailyMap = new Map(c.daily.map((p) => [p.date, p]));
    const own = all.filter((x) => x.entityType === 'campaign' && x.entityId === c.campaignId);
    const adsetDates = all.filter((x) => x.entityType === 'adset' && campaignOfAdset.get(x.entityId) === c.campaignId).map((x) => x.date);
    const evaluated = own.map((ch) => evaluateChange(ch, {
      daily: dailyMap, today, life, thresholds, otherDates: [...own.filter((o) => o !== ch).map((o) => o.date), ...adsetDates],
    }));
    records.push(...evaluated);
    prepared.push({ c, dailyMap, own, evaluated, adsetDates });
  }
  const learning = summarizeLearning(records, { life });

  const campaigns = [];
  for (const { c, dailyMap, own, evaluated, adsetDates } of prepared) {
    if (visible && !visible.has(c.campaignId)) continue;
    const lastSpend = [...dailyMap.values()].filter((p) => p.gasto > 0).map((p) => p.date).sort().at(-1) ?? null;
    const active = !c.paused && lastSpend !== null && daysBetween(lastSpend, today) <= ACTIVE_WITHIN_DAYS;
    const shown = evaluated.filter((e) => e.date >= from && e.date <= to);
    if (!active && !shown.length) continue;

    const accountId = accountOfCampaign.get(c.campaignId) ?? '';
    const currency = currencyOf(c.campaignId);
    // Current budget = the most recent of the last snapshot and the last logged/derived change.
    const snaps = (histories[`campaign|${c.campaignId}`] ?? []).filter((r) => r.dailyBudget != null);
    const snap = snaps.at(-1);
    const lastOwn = own.at(-1);
    const candidates = [];
    if (snap) candidates.push({ time: snap.firstSeen ?? 0, value: snap.dailyBudget / divisorOf('campaign', c.campaignId) });
    if (lastOwn) candidates.push({ time: lastOwn.time ?? endOfDay(lastOwn.date), value: lastOwn.newBudget });
    const currentBudget = candidates.sort((a, b) => b.time - a.time)[0]?.value ?? null;

    const lastAny = [lastOwn?.date, ...adsetDates].filter(Boolean).sort().at(-1) ?? null;
    const suggestion = suggestNext({
      campaign: { active, currentBudget, currency, changes: evaluated, lastAnyChangeDate: lastAny, daily: dailyMap }, today, life, thresholds, learning,
    });
    campaigns.push({
      campaignId: c.campaignId, name: c.campaign, accountId, accountName: accountId ? (accountMeta[accountId]?.name || accountId) : '', budgetCurrency: currency,
      active, paused: Boolean(c.paused), currentBudget, lastChangeDate: lastAny, daysSinceLastChange: lastAny ? daysBetween(lastAny, today) : null,
      changeCount: evaluated.length, now: windowMetrics(dailyMap, addDays(today, -life.postBudgetDays), addDays(today, -1)),
      changes: [...shown].reverse(), suggestion,
    });
  }
  campaigns.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'es', { numeric: true }));

  return {
    range: { from, to }, today, currency: config.currency, learning, campaigns, warnings: scope.warnings, notes: scope.notes,
    settings: { windowDays: life.windowDays, postBudgetDays: life.postBudgetDays, raisePct: standardPct(life), minMeasured: MIN_MEASURED_RAISES, minRoasToScale: life.minRoasToScale },
  };
}
