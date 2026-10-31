// Main loop: poll Meta, detect sales, evaluate rules, send WhatsApp messages, and handle replies.
// Dependencies are injected (api, store, send, clock) so the whole flow is testable without network.
import { applyThreshold, applyThresholds } from './config.js';
import { canExecute, executeAction } from './actions.js';
import { computeBaseline, recommendThresholds } from './baseline.js';
import { parseCommand } from './commands.js';
import { isMonitored, parseHourlyRow, parseInsightRow } from './insights.js';
import { fetchAccount, fetchAds, fetchHourly, fetchTodayInsights } from './meta-data.js';
import {
  errorText, formatAlert, formatHelp, formatRecommendation, formatStatus, formatSummary, replies,
} from './messages.js';
import { buildSummary, evaluate, filterAlerts, shouldSendSummary } from './rules.js';
import { detectSales, seedSalesFromHourly } from './sales.js';
import { hourlySales, mergeHourlyPurchases, todaySales, UNATTRIBUTED } from './sheet-sales.js';
import { addDays, localParts, minutes, startOfLocalDay } from './time.js';

const DAY_MS = 86_400_000;
const QUEUED_REQUEST_TTL_MIN = 12 * 60;
const TOKEN_ALERT_EVERY_MS = 6 * 3_600_000;

export class Monitor {
  // sheetRows: async () => parsed Comprobantes rows (the payments sheet), or null when not configured.
  // allowActions: false = alerts only; pause/budget requests are never offered nor executed.
  constructor({ api, store, accountId, config, send, saveConfig = () => {}, now = Date.now, log = console.log, sheetRows = null, allowActions = false }) {
    this.api = api;
    this.store = store;
    this.accountId = accountId;
    this.config = config;
    this.sendText = send;
    this.persistConfig = saveConfig;
    this.now = now;
    this.log = log;
    this.tz = null;
    this.baseline = null;
    this.baselineDate = null;
    this.lastSnapshot = null;
    this.sheetRows = sheetRows;
    this.sheetCache = null;
    this.allowActions = allowActions;
    this.lastPollTs = null;
    this.nextPollTs = null;
    this.lastError = null;
  }

  get salesSource() {
    return this.sheetRows ? (this.config.salesSource ?? 'sheet') : 'meta';
  }

  get flowRules() {
    return { flowPrefix: this.config.flowPrefix ?? '', validResult: this.config.validResult ?? 'Pago válido' };
  }

  // Payments sheet rows; on failure the last good copy is used so a flaky download never looks like lost sales.
  async #sheet() {
    if (this.salesSource === 'meta') return null;
    try {
      const rows = await this.sheetRows();
      if (rows) this.sheetCache = rows;
    } catch (error) {
      this.log(`payments sheet unavailable, using ${this.sheetCache ? 'the last copy' : 'Meta purchases'}: ${error.message}`);
    }
    return this.sheetCache;
  }

  status() {
    return {
      tz: this.tz,
      lastPollTs: this.lastPollTs,
      nextPollTs: this.nextPollTs,
      lastError: this.lastError,
      usagePct: this.api.usagePct ?? 0,
      accessTier: this.api.accessTier ?? null,
      pausedUntil: this.store.getKv('pausedUntil') ?? null,
      baselineDays: this.baseline?.days ?? 0,
      salesSource: this.salesSource,
      mode: this.allowActions ? 'actions_with_approval' : 'alert_only',
    };
  }

  // ---- startup -----------------------------------------------------------------------------

  async init() {
    const account = await fetchAccount(this.api, this.accountId);
    this.tz = account.timezone_name;
    if (!this.tz) throw new Error('The ad account did not report timezone_name');
    if (this.store.getKv('firstRunTs') == null) this.store.setKv('firstRunTs', this.now());
    await this.refreshBaseline();
  }

  // Last N full days of hourly data -> baseline; today's hourly rows seed "last sale" after a restart.
  async refreshBaseline() {
    const now = this.now();
    const today = localParts(now, this.tz).date;
    let rows = [];
    try {
      const raw = await fetchHourly(this.api, this.accountId, addDays(today, -this.config.baselineDays), today);
      const parsed = raw.map((r) => parseHourlyRow(r, this.config.spendVatPct)).filter((r) => r.hour !== null);
      const others = new Set(parsed.filter((r) => !isMonitored(r.campaignName, this.config.campaignPrefix)).map((r) => r.adId));
      rows = parsed.filter((r) => isMonitored(r.campaignName, this.config.campaignPrefix));
      const sheet = await this.#sheet();
      if (sheet) {
        const counts = hourlySales(sheet, { from: addDays(today, -this.config.baselineDays), to: today, ...this.flowRules });
        for (const key of [...counts.keys()]) if (others.has(key.split('|')[2])) counts.delete(key);
        rows = mergeHourlyPurchases(rows, counts, this.salesSource);
      }
    } catch (error) {
      this.log(`baseline unavailable, using fixed thresholds: ${error.message}`);
    }
    this.baseline = computeBaseline(rows.filter((r) => r.date < today));
    this.baselineDate = today;

    const dayStart = startOfLocalDay(now, this.tz);
    if (this.store.lastSales(dayStart).accountLastTs === null) {
      for (const event of seedSalesFromHourly(rows, { nowMs: now, tz: this.tz })) this.store.addSale(event);
    }
  }

  // ---- polling -----------------------------------------------------------------------------

  async buildSnapshot() {
    const now = this.now();
    const dayStart = startOfLocalDay(now, this.tz);
    const [account, insightRows, adsList] = await Promise.all([
      fetchAccount(this.api, this.accountId),
      fetchTodayInsights(this.api, this.accountId),
      fetchAds(this.api, this.accountId),
    ]);

    const prefix = this.config.campaignPrefix;
    const byId = new Map();
    for (const ad of adsList) {
      const campaignName = ad.campaign?.name ?? '';
      if (!isMonitored(campaignName, prefix)) continue;
      byId.set(ad.id, {
        id: ad.id, name: ad.name, campaignId: ad.campaign_id, campaignName, adsetId: ad.adset_id,
        status: ad.effective_status, spend: 0, impressions: 0, clicks: 0, frequency: 0, purchases: 0, conversations: 0,
      });
    }
    for (const raw of insightRows) {
      const row = parseInsightRow(raw, this.config.spendVatPct);
      if (!isMonitored(row.campaignName, prefix)) continue;
      const ad = byId.get(row.adId) ?? {
        id: row.adId, name: row.adName, campaignId: row.campaignId, campaignName: row.campaignName,
        adsetId: row.adsetId, status: 'UNKNOWN',
      };
      byId.set(row.adId, {
        ...ad, spend: row.spend, impressions: row.impressions, clicks: row.clicks, frequency: row.frequency,
        purchases: row.purchases, conversations: row.conversations,
      });
    }
    let ads = [...byId.values()];
    // Real sales come from the payments sheet; unattributed payments still count for the account-wide gap.
    let salesAds = ads;
    const sheet = await this.#sheet();
    if (sheet) {
      const today = localParts(now, this.tz).date;
      const sold = todaySales(sheet, { today, ...this.flowRules });
      const merge = (meta, fromSheet) => (this.salesSource === 'both' ? Math.max(meta, fromSheet) : fromSheet);
      ads = ads.map((a) => ({ ...a, purchases: merge(a.purchases, sold.byAd[a.id] ?? 0) }));
      salesAds = [...ads, { id: UNATTRIBUTED, name: 'Sin anuncio', status: 'N/A', spend: 0, impressions: 0, clicks: 0, frequency: 0, purchases: sold.unattributed, conversations: 0 }];
    }

    // Sales = difference of cumulative purchases between polls of the same local day.
    const previous = Object.entries(this.store.latestSamples()).filter(([, s]) => s.ts >= dayStart);
    const prev = previous.length > 0 ? Object.fromEntries(previous.map(([id, s]) => [id, s.purchases])) : null;
    for (const event of detectSales(prev, salesAds, now)) this.store.addSale(event);

    const t = this.config.thresholds;
    const windows = this.#windows(salesAds, now, dayStart, t);
    this.store.addSamples(now, salesAds);

    return {
      account: {
        status: Number(account.account_status),
        disableReason: Number(account.disable_reason ?? 0),
        spendCap: Number(account.spend_cap ?? 0),
        amountSpent: Number(account.amount_spent ?? 0),
      },
      ads,
      sales: this.store.lastSales(dayStart),
      windows,
    };
  }

  // Deltas over the last N hours from our own samples; null when we do not have data that old today.
  #windows(ads, now, dayStart, t) {
    const sampleAt = (hours) => {
      const samples = this.store.samplesAtOrBefore(now - minutes(hours * 60));
      if (!samples) return null;
      return Object.values(samples).every((s) => s.ts >= dayStart) ? samples : null;
    };
    const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);

    let spend2h = null;
    const past2 = sampleAt(t.noSpendHours);
    if (past2) {
      const entries = ads.filter((a) => a.status === 'ACTIVE').map((a) => [a.id, a.spend - (past2[a.id]?.spend ?? 0)]);
      spend2h = entries.some(([, delta]) => delta < 0) ? null : Object.fromEntries(entries);
    }

    let conversations3h = null;
    let purchases3h = null;
    const past3 = sampleAt(t.noPurchaseHours);
    if (past3) {
      const before = Object.values(past3);
      const dConv = sum(ads, (a) => a.conversations) - sum(before, (s) => s.conversations);
      const dPurch = sum(ads, (a) => a.purchases) - sum(before, (s) => s.purchases);
      if (dConv >= 0 && dPurch >= 0) {
        conversations3h = dConv;
        purchases3h = dPurch;
      }
    }
    return { spend2h, conversations3h, purchases3h };
  }

  async poll() {
    const now = this.now();
    this.store.expireRequests(now);

    const skip = this.api.shouldSkipPoll();
    if (skip.skip) {
      this.log(`poll skipped: ${skip.reason}`);
      return { skipped: true, reason: skip.reason };
    }

    try {
      await this.#processQueue();
      if (localParts(now, this.tz).date !== this.baselineDate) await this.refreshBaseline();

      const snapshot = await this.buildSnapshot();
      this.lastSnapshot = snapshot;
      this.store.pruneSamples(now - 3 * DAY_MS);

      const alerts = evaluate({ now, tz: this.tz, config: this.config, baseline: this.baseline, snapshot });
      const sentAlerts = await this.#dispatchAlerts(alerts, now);
      await this.#maybeSendSummary(snapshot, now);
      await this.#maybeRecommend(now);
      this.lastError = null;
      return { skipped: false, alerts: sentAlerts };
    } catch (error) {
      this.lastError = error.message;
      this.log(`poll failed: ${error.message}`);
      if (error.code === 190) await this.#tokenProblem(now);
      return { skipped: false, error: error.message };
    }
  }

  async #tokenProblem(now) {
    const last = this.store.getKv('tokenAlertTs');
    if (last != null && now - last < TOKEN_ALERT_EVERY_MS) return;
    this.store.setKv('tokenAlertTs', now);
    await this.#safeSend(replies.tokenProblem());
  }

  // ---- alerts ------------------------------------------------------------------------------

  #alertsPaused(now) {
    return (this.store.getKv('pausedUntil') ?? 0) > now;
  }

  async #safeSend(text) {
    try {
      await this.sendText(text);
      return true;
    } catch (error) {
      this.log(`could not send WhatsApp message: ${error.message}`);
      return false;
    }
  }

  // Reuses an identical pending request instead of asking twice for the same thing.
  #requestFor(actions, now) {
    const key = JSON.stringify(actions);
    const existing = this.store.pendingRequests(now).find((r) => r.kind === 'action' && JSON.stringify(r.payload.actions) === key);
    if (existing) return existing.id;
    return this.store.createRequest({ kind: 'action', payload: { actions }, now, ttlMin: this.config.requestTtlMin });
  }

  async #dispatchAlerts(alerts, now) {
    const last = this.store.lastSentByFamily(now - DAY_MS);
    const fresh = filterAlerts(alerts, last, now, this.config.cooldownMin);
    const paused = this.#alertsPaused(now);
    const delivered = [];

    for (const alert of fresh) {
      if (paused) {
        this.store.logAlert({ ts: now, family: alert.family, severity: alert.severity, type: alert.type, text: formatAlert(alert), sent: false });
        continue;
      }
      const offered = this.allowActions ? alert.actions : undefined;
      const requestId = offered?.length ? this.#requestFor(offered, now) : null;
      const text = formatAlert({ ...alert, actions: offered }, { requestId, ttlMin: this.config.requestTtlMin });
      const sent = await this.#safeSend(text);
      this.store.logAlert({ ts: now, family: alert.family, severity: alert.severity, type: alert.type, text, sent });
      if (sent) delivered.push(alert);
    }
    return delivered;
  }

  async #maybeSendSummary(snapshot, now) {
    if (this.#alertsPaused(now) || this.config.summaryEnabled === false) return;
    const { send, key } = shouldSendSummary({ now, tz: this.tz, config: this.config, lastKey: this.store.getKv('lastSummaryKey') });
    if (!send) return;
    const hour = key.slice(-2);
    const text = formatSummary(buildSummary({ config: this.config, ads: snapshot.ads }), { hourLabel: `${hour}:00` });
    if (await this.#safeSend(text)) {
      this.store.setKv('lastSummaryKey', key);
      this.store.logAlert({ ts: now, family: `summary:${key}`, severity: 1, type: 'hourly_summary', text, sent: true });
    }
  }

  async #maybeRecommend(now) {
    if (this.#alertsPaused(now) || !this.baseline || this.baseline.days < 3) return;
    const since = this.store.getKv('lastRecommendationTs') ?? this.store.getKv('firstRunTs') ?? now;
    if (now - since < this.config.recommendEveryDays * DAY_MS) return;

    const recs = recommendThresholds(this.baseline, this.config);
    this.store.setKv('lastRecommendationTs', now);
    if (recs.length === 0) return;
    const id = this.store.createRequest({
      kind: 'recommendation', payload: { recs }, now, ttlMin: this.config.recommendEveryDays * 24 * 60,
    });
    const text = formatRecommendation(recs, { id, days: this.baseline.days });
    const sent = await this.#safeSend(text);
    this.store.logAlert({ ts: now, family: `recommendation:${id}`, severity: 1, type: 'recommendation', text, sent });
  }

  // ---- actions -----------------------------------------------------------------------------

  async #executeRequest(request) {
    const now = this.now();
    const results = [];
    for (const action of request.payload.actions) {
      try {
        const result = await executeAction(this.api, action, this.config);
        this.store.logAction({ ts: now, kind: action.kind, targetId: action.targetId, requestId: request.id, ok: true, result });
        results.push({ action, ok: true });
      } catch (error) {
        this.store.logAction({ ts: now, kind: action.kind, targetId: action.targetId, requestId: request.id, ok: false, result: errorText(error) });
        results.push({ action, ok: false, error: errorText(error) });
      }
    }
    const failed = results.filter((r) => !r.ok);
    this.store.setRequestStatus(request.id, failed.length > 0 ? 'failed' : 'executed');
    if (failed.length > 0) {
      return replies.failed({ id: request.id, error: failed.map((f) => `${f.action.label ?? f.action.targetId}: ${f.error}`).join('; ') });
    }
    return replies.executed({ id: request.id, labels: results.map((r) => r.action.label ?? r.action.targetId) });
  }

  async #processQueue() {
    if (!this.allowActions) return;
    const queued = this.store.queuedRequests();
    for (const request of queued) {
      if (!canExecute({ config: this.config, now: this.now(), tz: this.tz }).ok) return;
      await this.#safeSend(await this.#executeRequest(request));
    }
  }

  // ---- incoming WhatsApp messages (already filtered to the allowed number) -------------------

  async handleMessage(text) {
    const reply = await this.#respond(parseCommand(text));
    if (reply) await this.#safeSend(reply);
  }

  #pendingOfKind(kind) {
    return this.store.pendingRequests(this.now()).filter((r) => r.kind === kind);
  }

  // Finds the request an approval refers to; returns { request } or { reply }.
  #resolveRequest(id, kind, word) {
    let target = id;
    if (target === null) {
      const pending = this.#pendingOfKind(kind);
      if (pending.length !== 1) return { reply: replies.needId(word) };
      target = pending[0].id;
    }
    this.store.expireRequests(this.now());
    const request = this.store.getRequest(target);
    if (!request || request.kind !== kind) return { reply: replies.notFound(target) };
    if (request.status === 'expired') return { reply: replies.expired(target) };
    if (request.status !== 'pending') return { reply: replies.alreadyHandled(target, request.status) };
    return { request };
  }

  async #respond(cmd) {
    const now = this.now();
    switch (cmd.type) {
      case 'approve': {
        if (!this.allowActions) return replies.actionsDisabled();
        const found = this.#resolveRequest(cmd.id, 'action', 'SI');
        if (found.reply) return found.reply;
        const guard = canExecute({ config: this.config, now, tz: this.tz });
        if (!guard.ok && guard.reason === 'kill_switch') return replies.killSwitch();
        if (!guard.ok) {
          this.store.setRequestStatus(found.request.id, 'queued', { expiresTs: now + minutes(QUEUED_REQUEST_TTL_MIN) });
          return replies.queued({ id: found.request.id, untilHour: guard.untilHour });
        }
        return this.#executeRequest(found.request);
      }
      case 'reject': {
        const found = this.#resolveRequest(cmd.id, 'action', 'NO');
        if (found.reply) return found.reply;
        this.store.setRequestStatus(found.request.id, 'rejected');
        return replies.rejected(found.request.id);
      }
      case 'accept': {
        const found = this.#resolveRequest(cmd.id, 'recommendation', 'ACEPTAR');
        if (found.reply) return found.reply;
        const { recs } = found.request.payload;
        const result = applyThresholds(this.config, Object.fromEntries(recs.map((r) => [r.name, r.recommended])));
        if (result.error) return replies.thresholdError(result.code);
        this.config = result.config;
        this.persistConfig(this.config);
        this.store.setRequestStatus(found.request.id, 'executed');
        return replies.recommendationApplied(recs);
      }
      case 'set': {
        const result = applyThreshold(this.config, cmd.name, cmd.value);
        if (result.error) return replies.thresholdError(result.code);
        this.config = result.config;
        this.persistConfig(this.config);
        return replies.thresholdSet({ name: result.key, value: cmd.value });
      }
      case 'status':
        return this.#statusText(now);
      case 'pause_alerts':
        this.store.setKv('pausedUntil', cmd.minutes > 0 ? now + minutes(cmd.minutes) : null);
        return replies.alertsPaused(cmd.minutes);
      case 'stop':
        this.config = { ...this.config, killSwitch: true };
        this.persistConfig(this.config);
        return replies.stopped();
      case 'resume':
        this.config = { ...this.config, killSwitch: false };
        this.persistConfig(this.config);
        return replies.resumed();
      case 'help':
        return formatHelp();
      case 'invalid':
        return replies.invalid(cmd.command);
      default:
        return replies.unknown();
    }
  }

  #statusText(now) {
    const dayStart = startOfLocalDay(now, this.tz);
    const { accountLastTs } = this.store.lastSales(dayStart);
    const pausedUntil = this.store.getKv('pausedUntil') ?? 0;
    const pending = this.store.pendingRequests(now).map((r) => ({
      id: r.id,
      label: r.kind === 'action' ? `Pausar ${r.payload.actions.map((a) => (a.kind === 'pause_adset' ? `el conjunto del anuncio «${a.label ?? a.adId}»` : a.label ?? a.targetId)).join(' y ')}` : 'Recomendación de umbrales',
    }));
    return formatStatus({
      config: this.config,
      summary: buildSummary({ config: this.config, ads: this.lastSnapshot?.ads ?? [] }),
      minutesSinceSale: accountLastTs == null ? null : Math.round((now - accountLastTs) / 60_000),
      pending,
      alertsPausedMin: Math.max(0, Math.ceil((pausedUntil - now) / 60_000)),
      accessTier: this.api.accessTier ?? null,
    });
  }

  // ---- scheduling --------------------------------------------------------------------------

  // Polls forever; returns a function that stops the loop.
  run() {
    let stopped = false;
    let timer = null;
    const tick = async () => {
      if (stopped) return;
      await this.poll();
      this.lastPollTs = this.now();
      this.nextPollTs = this.lastPollTs + this.config.pollMinutes * 60_000;
      if (!stopped) timer = setTimeout(tick, this.config.pollMinutes * 60_000);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }
}
