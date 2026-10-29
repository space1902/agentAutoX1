// Scheduler tick (phase B), one-shot: the desktop app calls it every few minutes. It
//  1. takes a budget snapshot (and reads the account activity log) at most every `snapshotMinutes`,
//  2. checks which decisions are due (day-4 test verdicts, day-2 post-budget checks, plus catch-up for the ones
//     missed while the app was closed) and, only if something is due, refreshes the data with a sync,
//  3. stores each decision once (unique key) and queues the WhatsApp text when that channel is enabled.
import { computeChanges, parseActivity } from './budget.js';
import { decisionMessage, dueBudgetChanges, evaluateDue } from './decisions.js';
import { MetaApi, friendlyMetaError } from './meta-api.js';
import { fetchActivities, fetchAccount, fetchAds } from './meta-data.js';
import { DEFAULT_TIMEZONE, redact, runSync } from './sync.js';
import { addDays, localParts } from './time.js';

const SYNC_DAYS = 10;
const ACTIVITY_DAYS = 14;

async function snapshotBudgets({ store, config, token, fetchImpl, now, warnings }) {
  const api = new MetaApi({ token, version: config.graphVersion, fetchImpl, now });
  try {
    const account = await fetchAccount(api, config.adAccountId);
    const timezone = account.timezone || store.getKv('account')?.timezone || DEFAULT_TIMEZONE;
    store.setKv('account', { name: account.name, timezone, currency: account.currency || config.currency });
    const today = localParts(now(), timezone).date;

    const ads = await fetchAds(api, config.adAccountId);
    store.upsertAds(ads, now());
    store.recordBudgets(ads, today, now());
    store.refreshFirstSpend();
    store.setKv('lastSnapshot', now());

    try {
      const activities = await fetchActivities(api, config.adAccountId, addDays(today, -ACTIVITY_DAYS));
      store.upsertBudgetEvents(activities.map((a) => parseActivity(a, timezone)).filter(Boolean));
      store.setKv('activitiesOk', true);
    } catch (error) {
      store.setKv('activitiesOk', false);
      warnings.push(`No se pudo leer el registro de actividad de Meta (${redact(friendlyMetaError(error), token)}). Los cambios de presupuesto se detectan por comparación y se fechan en la siguiente lectura.`);
    }
    return true;
  } catch (error) {
    warnings.push(redact(friendlyMetaError(error), token));
    return false;
  }
}

const SYNC_GAP_MS = 10 * 60_000;

function dataFor(store, config, clock) {
  return {
    insights: store.insightsBetween('2000-01-01', '2999-12-31'),
    comprobantes: store.comprobantesBetween('2000-01-01', '2999-12-31'),
    identities: store.identities(),
    ads: store.adsWithFirstSpend(),
    changes: computeChanges({ histories: store.budgetHistories(), events: store.budgetEvents() }),
    config,
    now: clock,
    existing: store.decisionKeys(),
  };
}

export async function runTick({ store, config, token, fetchImpl = globalThis.fetch, now = Date.now, force = false }) {
  const life = config.lifecycle;
  const timezone = store.getKv('account')?.timezone || DEFAULT_TIMEZONE;
  const parts = localParts(now(), timezone);
  const clock = { date: parts.date, minutes: parts.hour * 60 + parts.minute };
  const result = { snapshot: false, synced: false, created: [], clock, warnings: [], notifyDesktop: life.notifyDesktop };

  const last = store.getKv('lastSnapshot');
  if (token && (force || !last || now() - last >= life.snapshotMinutes * 60_000)) {
    result.snapshot = await snapshotBudgets({ store, config, token, fetchImpl, now, warnings: result.warnings });
  }

  let due = evaluateDue(dataFor(store, config, clock));
  const wantsData = due.length > 0 || dueBudgetChanges(dataFor(store, config, clock)).length > 0;
  const lastSync = store.getKv('lastSync')?.meta ?? 0;
  if (wantsData && token && (force || now() - lastSync >= SYNC_GAP_MS)) {
    const sync = await runSync({ store, config, token, from: addDays(clock.date, -SYNC_DAYS), to: clock.date, fetchImpl, now });
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
