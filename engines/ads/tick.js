// Scheduler tick (phase B), one-shot: the desktop app calls it every few minutes. It
//  1. takes a budget snapshot (and reads the account activity log) at most every `snapshotMinutes`,
//  2. checks which decisions are due (day-4 test verdicts, day-2 post-budget checks, plus catch-up for the ones
//     missed while the app was closed) and, only if something is due, refreshes the data with a sync,
//  3. stores each decision once (unique key) and queues the WhatsApp text when that channel is enabled.
import { computeChanges } from './budget.js';
import { decisionMessage, dueBudgetChanges, evaluateDue } from './decisions.js';
import { MetaApi, friendlyMetaError } from './meta-api.js';
import { redact } from './redact.js';
import { syncActivities } from './activities.js';
import { fetchAccount, fetchAds } from './meta-data.js';
import { targetsFor } from './portfolios.js';
import { DEFAULT_TIMEZONE, runSync, timezoneFor, tokenOfTarget } from './sync.js';
import { configuredAccountIds } from './portfolios.js';
import { accountMetaOf, scopeInsights } from './scope.js';
import { addDays, localParts } from './time.js';

const SYNC_DAYS = 10;
const ACTIVITY_DAYS = 14;

// Budget snapshot of one account (its own token). Returns true when it worked; a failure becomes a warning.
async function snapshotAccount({ store, config, target, token, fetchImpl, now, warnings, label }) {
  const api = new MetaApi({ token, version: config.graphVersion, fetchImpl, now });
  const id = target.accountId;
  try {
    const account = await fetchAccount(api, id);
    const timezone = account.timezone || timezoneFor(store, target);
    store.setAccountInfo(id, { name: account.name, timezone, currency: account.currency || target.currency || config.currency }, { primary: id === config.adAccountId });
    const today = localParts(now(), timezone).date;

    const ads = await fetchAds(api, id);
    store.upsertAds(ads, now(), id);
    store.recordBudgets(ads, today, now(), id);
    store.refreshFirstSpend();

    const synced = await syncActivities({ api, store, config, since: addDays(today, -ACTIVITY_DAYS), timezone, token, accountId: id });
    if (!synced.ok) {
      warnings.push(`${label}No se pudo leer el registro de actividad de Meta (${synced.error}). Los cambios de presupuesto se detectan por comparación y se fechan en la siguiente lectura.`);
    }
    return true;
  } catch (error) {
    warnings.push(`${label}${redact(friendlyMetaError(error), token)}`);
    return false;
  }
}

// Every account with a token gets a snapshot; the others are skipped quietly (the sync reports missing tokens).
async function snapshotBudgets({ store, config, targets, tokens, token, fetchImpl, now, warnings }) {
  let any = false;
  for (const target of targets) {
    const t = tokenOfTarget({ tokens, token }, target);
    if (!t) continue;
    const label = targets.length > 1 ? `${target.name || target.accountId}: ` : '';
    if (await snapshotAccount({ store, config, target, token: t, fetchImpl, now, warnings, label })) any = true;
  }
  if (any) store.setKv('lastSnapshot', now());
  return any;
}

const SYNC_GAP_MS = 10 * 60_000;

// Every stored day in the base currency, for the accounts that are configured now (plus rows with no account). An account whose
// currency has no known rate is left out of the decisions and reported in `warnings`.
export function tickInsights(store, config) {
  const allowed = new Set(['', ...configuredAccountIds(config)]);
  const scoped = scopeInsights({ rows: store.insightsBetween('2000-01-01', '2999-12-31'), accounts: allowed, accountMeta: accountMetaOf(config, store), config, fxRates: store.fxRates() });
  return { rows: scoped.rows, warnings: scoped.warnings.map((w) => w.message) };
}

function dataFor(store, config, clock) {
  return {
    insights: tickInsights(store, config).rows,
    comprobantes: store.comprobantesBetween('2000-01-01', '2999-12-31'),
    identities: store.identities(),
    ads: store.adsWithFirstSpend(),
    changes: computeChanges({ histories: store.budgetHistories(), events: store.budgetEvents() }),
    config,
    now: clock,
    existing: store.decisionKeys(),
  };
}

export async function runTick({ store, config, token, tokens, targets, fetchImpl = globalThis.fetch, now = Date.now, force = false }) {
  const life = config.lifecycle;
  const list = targets ?? targetsFor(config, null);
  const anyToken = list.some((t) => tokenOfTarget({ tokens, token }, t));
  const timezone = (list[0] ? timezoneFor(store, list[0]) : null) || store.getKv('account')?.timezone || DEFAULT_TIMEZONE;
  const parts = localParts(now(), timezone);
  const clock = { date: parts.date, minutes: parts.hour * 60 + parts.minute };
  const result = { snapshot: false, synced: false, created: [], clock, warnings: [], notifyDesktop: life.notifyDesktop };

  const last = store.getKv('lastSnapshot');
  if (anyToken && (force || !last || now() - last >= life.snapshotMinutes * 60_000)) {
    result.snapshot = await snapshotBudgets({ store, config, targets: list, tokens, token, fetchImpl, now, warnings: result.warnings });
  }

  for (const w of tickInsights(store, config).warnings) result.warnings.push(`Decisiones: ${w}`);
  let due = evaluateDue(dataFor(store, config, clock));
  const wantsData = due.length > 0 || dueBudgetChanges(dataFor(store, config, clock)).length > 0;
  const lastSync = store.getKv('lastSync')?.meta ?? 0;
  if (wantsData && anyToken && (force || now() - lastSync >= SYNC_GAP_MS)) {
    const sync = await runSync({ store, config, token, tokens, targets: list, from: addDays(clock.date, -SYNC_DAYS), to: clock.date, fetchImpl, now });
    result.synced = sync.meta.ok;
    for (const part of [sync.meta, sync.sheet]) if (!part.ok && part.error) result.warnings.push(part.error);
    due = evaluateDue(dataFor(store, config, clock));
  }

  for (const decision of due) {
    const id = store.insertDecision(decision, now());
    if (id === null) continue;
    const stored = { ...decision, id, status: 'pending', createdAt: now(), message: decisionMessage(decision) };
    result.created.push(stored);
    if (life.notifyWhatsapp) store.enqueueWhatsapp(decisionMessage(decision).text, 'decision', now());
  }
  if (result.created.length) store.markNotified(result.created.map((d) => d.id), now());
  return result;
}
