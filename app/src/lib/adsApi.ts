// Typed wrappers for the "Anuncios" section. The Meta token lives in the Windows Credential Manager:
// the UI can only learn whether it exists, never read it.
import { invoke } from "@tauri-apps/api/core";

export type Group = "ct" | "campaign" | "ad";
export type ActionTone = "green" | "gray" | "amber" | "red";

export interface AdAction {
  key: string;
  label: string;
  tone: ActionTone;
}

export interface Totals {
  gasto: number;
  mensajes: number;
  valor: number;
  ventas: number;
  resultado: number;
  roas: number;
  costoMensaje: number;
  ticket: number;
  conversion: number;
  costoVenta: number;
}

export interface AdRow extends Totals {
  key: string;
  label: string;
  ct: string;
  adId: string;
  adName: string;
  campaignId: string;
  campaignName: string;
  /** "Day N": the first day with spend is day 1. null = no spend yet. */
  ageDays: number | null;
  firstSpendDate: string | null;
  effectiveStatus: string | null;
  action: AdAction | null;
}

export interface DayPoint {
  date: string;
  gasto: number;
  valor: number;
  ventas: number;
  mensajes: number;
  roas: number;
}

export type VoucherStatus = "valid" | "invalid" | "review";

export interface Voucher {
  date: string;
  registered: string;
  valor: number;
  bank: string;
  flow: string;
  adId: string;
  adName: string;
  ct: string;
  result: string;
  status: VoucherStatus;
  phoneMasked: string;
}

export interface LastSync {
  meta: number | null;
  sheet: number | null;
  metaError: string | null;
  sheetError: string | null;
}

export interface Report {
  range: { from: string; to: string };
  group: Group;
  currency: string;
  kpis: Totals;
  rows: AdRow[];
  daily: DayPoint[];
  comprobantes: Voucher[];
  reviewCount: number;
  today: string;
  timezone: string;
  lastSync: LastSync;
  settings: { campaignPrefix: string; flowPrefix: string; validResult: string; autoRefreshMinutes: number };
}

export interface SyncPart {
  ok: boolean;
  error?: string;
  code?: string;
}

export interface SyncResult {
  today: string;
  syncedAt: number;
  meta: SyncPart & { insightRows?: number; ads?: number };
  sheet: SyncPart & { rows?: number };
}

export interface Thresholds {
  minSpend: number;
  duplicateRoas: number;
  duplicateSales: number;
  scaleRoas: number;
  keepRoas: number;
  watchRoas: number;
}

export interface Lifecycle {
  testDays: number;
  testNotifyDay: number;
  testNotifyAt: string;
  postBudgetDays: number;
  postBudgetNotifyDay: number;
  postBudgetNotifyAt: string;
  testEnabled: boolean;
  budgetEnabled: boolean;
  windowDays: number;
  minRoasToScale: number;
  maxCpaWorsenPct: number;
  minSales: number;
  lowerCpaWorsenPct: number;
  raisePct: number;
  maxRaisePct: number;
  lateDays: number;
  notifyDesktop: boolean;
  notifyWhatsapp: boolean;
  snapshotMinutes: number;
}

export type DecisionKind = "test" | "ct_test" | "budget";
export type DecisionStatus = "pending" | "done" | "ignored";

export interface Decision {
  id: number;
  key: string;
  kind: DecisionKind;
  entityType: string;
  entityId: string;
  label: string;
  dayN: number;
  late: boolean;
  dueDate: string;
  range: { from: string; to: string };
  verdict: AdAction;
  reason: string;
  metrics: Totals;
  extra: {
    changePct?: number;
    changeDate?: string;
    exact?: boolean;
    suggestedPct?: number | null;
    before?: Totals;
    beforeRange?: { from: string; to: string };
    previous?: { date: string; pct: number } | null;
    daysSincePrevious?: number | null;
    firstSpendDate?: string;
    nominalTestDays?: number;
  };
  status: DecisionStatus;
  createdAt: number;
}

export interface DecisionsData {
  decisions: Decision[];
  activitiesOk: boolean | null;
  lastSnapshot: number | null;
  lifecycle: Lifecycle;
}

export interface AdsConfig {
  adAccountId: string;
  graphVersion: string;
  campaignPrefix: string;
  sheetId: string;
  sheetTab: string;
  validResult: string;
  flowPrefix: string;
  currency: string;
  autoRefreshMinutes: number;
  thresholds: Thresholds;
  lifecycle: Lifecycle;
}

export interface AdsStatus {
  tokenPresent: boolean;
  lastSync: LastSync;
  counts: { insights: number; ads: number; comprobantes: number; budgets: number };
  account: { name: string; timezone: string; currency: string } | null;
  today: string;
}

export const adsApi = {
  sync: (from: string, to: string) => invoke<SyncResult>("ads_sync", { from, to }),
  report: (from: string, to: string, group: Group) => invoke<Report>("ads_report", { from, to, group }),
  status: () => invoke<AdsStatus>("ads_status"),
  configGet: () => invoke<{ config: AdsConfig; defaults: AdsConfig }>("ads_config_get"),
  configSet: (config: Partial<AdsConfig>) => invoke<{ config: AdsConfig }>("ads_config_set", { config }),
  decisions: () => invoke<DecisionsData>("ads_decisions"),
  decisionStatus: (id: number, status: DecisionStatus) => invoke<{ id: number; status: DecisionStatus }>("ads_decision_status", { id, status }),
  tickNow: () => invoke<{ created: Decision[]; warnings: string[]; snapshot: boolean; synced: boolean }>("ads_tick_now"),
  tokenStatus: () => invoke<boolean>("ads_token_status"),
  tokenSet: (token: string) => invoke<void>("ads_token_set", { token }),
  tokenClear: () => invoke<void>("ads_token_clear"),
  tokenTest: () => invoke<{ accountName: string; currency: string; timezone: string }>("ads_token_test"),
  tokenImport: () => invoke<void>("ads_token_import_from_monitor"),
};

// ---------------------------------------------------------------- dates (local calendar days)

const pad = (n: number) => String(n).padStart(2, "0");
export const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const shiftDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return toIso(new Date(y, m - 1, d + n));
};

export type Preset = "today" | "yesterday" | "week" | "month" | "custom";

export function presetRange(preset: Exclude<Preset, "custom">, today: string): { from: string; to: string } {
  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") return { from: shiftDays(today, -1), to: shiftDays(today, -1) };
  if (preset === "week") return { from: shiftDays(today, -6), to: today };
  return { from: `${today.slice(0, 8)}01`, to: today };
}

// ---------------------------------------------------------------- formatting

export const formatMoney = (value: number) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(Math.round(value));
export const formatRoas = (value: number) => `${value.toFixed(2).replace(".", ",")}x`;
export const formatPct = (fraction: number) => `${(fraction * 100).toFixed(1).replace(".", ",")} %`;
export const formatInt = (value: number) => new Intl.NumberFormat("es-CO").format(Math.round(value));

/** "hace 3 min" for the "Actualizado" label. */
export function agoText(ts: number | null, now: number): string {
  if (!ts) return "sin actualizar";
  const min = Math.max(0, Math.floor((now - ts) / 60000));
  if (min < 1) return "hace menos de 1 min";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return `hace ${h} h`;
}

export const dayLabel = (row: Pick<AdRow, "ageDays">) => (row.ageDays === null ? "sin gasto aún" : `día ${row.ageDays}`);

// ---------------------------------------------------------------- Alertas (in-app monitor)

export interface AlertThresholds {
  targetCpa: number;
  reviewCpa: number;
  gapWorryMin: number;
  gapActionMin: number;
  maxGapMin: number;
  noSpendHours: number;
  noPurchaseHours: number;
  minConversationsNoPurchase: number;
  costPerConversationMult: number;
  minConversationsForCost: number;
  frequencyMax: number;
  ctrMinRatio: number;
  cpmMaxRatio: number;
  minImpressions: number;
}

export interface AlertsConfig {
  mode: string;
  salesSource: "sheet" | "meta" | "both";
  allowActions: boolean;
  summaryEnabled: boolean;
  campaignPrefix: string;
  pollMinutes: number;
  baselineDays: number;
  cooldownMin: number;
  budgetChangeMaxPct: number;
  activeHours: { start: number; end: number };
  restrictedHours: { start: number; end: number };
  thresholds: AlertThresholds;
  whatsapp: { senderPhone: string; alertTo: string };
}

export interface MonitorInfo {
  tz: string | null;
  lastPollTs: number | null;
  nextPollTs: number | null;
  lastError: string | null;
  usagePct: number;
  accessTier: string | null;
  pausedUntil: number | null;
  baselineDays: number;
  salesSource: string;
  mode: string;
}

export type WaState = "unlinked" | "connecting" | "connected" | "conflict" | "error";

export interface MonitorStatusEvent {
  type?: string;
  monitor?: MonitorInfo;
  wa?: { state: WaState; linked: boolean; phoneMasked: string };
  error?: string;
}

export interface ProcStatus {
  running: boolean;
  pid: number | null;
  logs: string[];
  status: MonitorStatusEvent | null;
}

export interface RecentAlert {
  id: number;
  ts: number;
  family: string;
  severity: number;
  type: string;
  text: string;
  sent: boolean;
}

export interface LinkEvent {
  type: "pairing_code" | "linked" | "error" | "fatal" | string;
  code?: string;
  error?: string;
  phoneMasked?: string;
}

export const alertsApi = {
  configGet: () => invoke<{ config: AlertsConfig; defaults: AlertsConfig }>("ads_alerts_config_get"),
  configSet: (config: Partial<AlertsConfig>) => invoke<{ config: AlertsConfig }>("ads_alerts_config_set", { config }),
  recent: () => invoke<{ alerts: RecentAlert[]; pausedUntil: number | null }>("ads_alerts_recent"),
  waStatus: () => invoke<{ linked: boolean; phoneMasked: string }>("ads_wa_status"),
  conflict: () => invoke<number | null>("ads_monitor_conflict"),
  monitorStatus: () => invoke<ProcStatus>("ads_monitor_status"),
  monitorStart: (confirmConflict: boolean) => invoke<ProcStatus>("ads_monitor_start", { confirmConflict }),
  monitorStop: () => invoke<void>("ads_monitor_stop"),
  linkStatus: () => invoke<ProcStatus>("ads_link_status"),
  linkStart: (phone: string) => invoke<void>("ads_wa_link_start", { phone }),
  linkCancel: () => invoke<void>("ads_wa_link_cancel"),
  importSession: (overwrite: boolean) => invoke<number>("ads_wa_import_session", { overwrite }),
};
