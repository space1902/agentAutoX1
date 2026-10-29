// Write operations against Meta, behind guards. `api` is anything with get(path, params) and
// post(path, body) (see meta-api.js). Nothing here runs unless a human approved a request.
import { inHourRange, localParts } from './time.js';

const ALLOWED_STATUSES = new Set(['ACTIVE', 'PAUSED']);

// Global guards: kill switch (config flag or DETENER) and restricted hours (the action is queued).
export function canExecute({ config, now, tz }) {
  if (config.killSwitch) return { ok: false, reason: 'kill_switch' };
  const { hour } = localParts(now, tz);
  if (inHourRange(hour, config.restrictedHours)) {
    return { ok: false, reason: 'restricted_hours', untilHour: config.restrictedHours.end };
  }
  return { ok: true };
}

// Pausing happens at the ad set: ad-level writes fail on click-to-WhatsApp ads.
export async function pauseAdset(api, adsetId) {
  if (!adsetId) throw new Error('Cannot pause: the ad set of this ad is unknown');
  return api.post(`/${adsetId}`, { status: 'PAUSED' });
}

// Campaign or ad set (ads are not writable on click-to-WhatsApp ads).
export async function setStatus(api, id, status) {
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`Invalid status "${status}" (use ACTIVE or PAUSED)`);
  return api.post(`/${id}`, { status });
}

// COP budgets are whole numbers; a single change may move the budget at most maxPct percent.
export function clampBudget(current, next, maxPct) {
  if (!Number.isInteger(next) || next <= 0) return { ok: false, reason: 'budget must be a positive integer (COP)' };
  const change = (Math.abs(next - current) / current) * 100;
  if (change > maxPct) return { ok: false, reason: `change of ${change.toFixed(1)}% exceeds the ${maxPct}% cap` };
  return { ok: true };
}

// Budgets usually live on the campaign (CBO): when the ad set has no daily budget, the change is
// applied to its campaign instead. The cap applies to whichever budget is changed.
export async function setAdsetDailyBudget(api, adsetId, newBudget, maxPct) {
  const adset = await api.get(`/${adsetId}`, { fields: 'daily_budget,campaign_id' });
  let ownerId = adsetId;
  let current = Number(adset?.daily_budget);
  if (!Number.isFinite(current) || current <= 0) {
    if (!adset?.campaign_id) throw new Error(`Ad set ${adsetId} has no daily budget to change`);
    const campaign = await api.get(`/${adset.campaign_id}`, { fields: 'daily_budget' });
    ownerId = adset.campaign_id;
    current = Number(campaign?.daily_budget);
    if (!Number.isFinite(current) || current <= 0) throw new Error(`Ad set ${adsetId} and its campaign ${ownerId} have no daily budget to change`);
  }
  const check = clampBudget(current, newBudget, maxPct);
  if (!check.ok) throw new Error(`Budget change refused: ${check.reason}`);
  return api.post(`/${ownerId}`, { daily_budget: newBudget });
}

// Copies are always created paused so nothing starts spending by surprise.
export const duplicate = (api, id) => api.post(`/${id}/copies`, { status_option: 'PAUSED' });

export async function executeAction(api, action, config) {
  switch (action.kind) {
    case 'pause_adset':
      return pauseAdset(api, action.targetId);
    case 'set_status':
      return setStatus(api, action.targetId, action.status);
    case 'set_budget':
      return setAdsetDailyBudget(api, action.targetId, action.value, config.budgetChangeMaxPct);
    case 'duplicate':
      return duplicate(api, action.targetId);
    default:
      throw new Error(`Unknown action kind "${action.kind}"`);
  }
}
