// Typed wrappers for the "Anuncios" section. The Meta token lives in the Windows Credential Manager:
// the UI can only learn whether it exists, never read it.
import { invoke } from "@tauri-apps/api/core";

/** Rows are real Meta campaigns (keyed by campaign id) or single ads; the CT code of a name never merges anything. */
export type Group = "campaign" | "ad";
export type ActionTone = "green" | "gray" | "amber" | "red";

export interface AdAction {
  key: string;
  label: string;
  tone: ActionTone;
}

export interface Totals {
  /** Ad spend WITH Meta's IVA (what Meta really charges). Every derived metric uses it. */
  gasto: number;
  /** Raw spend as the Meta API reports it (without IVA) and the IVA amount (gasto = spendNet + vat). Absent in decisions stored before the IVA setting. */
  spendNet?: number;
  vat?: number;
  /** null = N/D: with an hour window messages are not split by hour. */
  mensajes: number | null;
  valor: number;
  /** Value in the countries' own currency (meaningful when a single country is shown). Absent in older payloads. */
  valorNative?: number;
  ventas: number;
  resultado: number;
  /** Value / spend WITHOUT IVA (spendNet). Cost per sale, margin and result use the spend with IVA. */
  roas: number;
  costoMensaje: number | null;
  ticket: number;
  conversion: number | null;
  costoVenta: number;
  /** Fees, per-sale costs and taxes in COP, and the gross margin: value - spend - fees - costs - taxes. */
  comisiones: number;
  costos: number;
  impuestos: number;
  margen: number;
  margenPct: number;
}

/** Informational "day N since the last budget raise" (never a verdict). */
export interface Raise {
  date: string;
  pct: number;
  dayN: number;
  exact: boolean;
  entityType: string;
  entityId: string;
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
  /** "Apagada" when every campaign / ad of the row is already off in Meta; otherwise the computed recommendation. */
  action: AdAction | null;
  /** The recommendation that was replaced by "Apagada" (informational). */
  suggestedAction?: AdAction | null;
  /** Every known ad of the row is off in Meta (paused, archived, deleted...). */
  paused?: boolean;
  raise: Raise | null;
  country: string;
}

export interface DayPoint {
  date: string;
  gasto: number;
  spendNet?: number;
  vat?: number;
  valor: number;
  ventas: number;
  mensajes: number | null;
  roas: number;
}

/** valid = valid in the sheet; accepted = accepted by hand in the app; review / invalid = pending. */
export type VoucherStatus = "valid" | "accepted" | "invalid" | "review" | "rejected";

export interface Voucher {
  date: string;
  registered: string;
  /** Amount that counts: the corrected one when the user edited it, else the sheet value. */
  valor: number;
  /** Amount written in the sheet. */
  valorSheet: number;
  /** The amount was corrected by hand in the app (the sheet is never changed). */
  valueOverridden: boolean;
  bank: string;
  flow: string;
  adId: string;
  adName: string;
  /** Tag read from the campaign name (informational). */
  ct: string;
  /** Campaign that owns the payment's ad ("" when the ad is unknown). */
  campaignId: string;
  /** Full campaign name, "Sin anuncio" or "Anuncio desconocido". */
  campaign: string;
  result: string;
  status: VoucherStatus;
  phoneMasked: string;
  /** Ad account (act_...) that owns the payment's ad; "" when it cannot be tied to one. */
  accountId: string;
  /** Raw phone from the sheet; shown only in the Comprobantes card. */
  phone: string;
  /** Contact name in the WhatsApp/Leona chat. */
  clientName: string;
  /** Account holder printed on the bank voucher. */
  payerName: string;
  key: string;
  valorCop: number;
  /** ISO country code; empty when it could not be derived. */
  country: string;
  /** How it was derived: telefono | campana | flujo | manual. */
  countrySource: string;
  /** The row is no longer in the sheet (kept in the history). */
  gone: boolean;
  /** Accepted by hand in the app (the sheet is never changed). */
  accepted: boolean;
  /** Discarded by hand in the app: never counted, wins over `accepted` (the sheet is never changed). */
  rejected: boolean;
}

/** Result of `ads_vouchers`: the payments of one range (the Comprobantes card has its own dates). */
export interface VouchersData {
  range: { from: string; to: string };
  comprobantes: Voucher[];
  reviewCount: number;
}

/** One hour of the day (0-23, Bogota time): sales and value by payment registration, spend by delivery hour (all in COP). */
export interface HourPoint {
  hour: number;
  ventas: number;
  valor: number;
  /** Spend WITH IVA. */
  gasto: number;
  /** Spend WITHOUT IVA (the ROAS divisor). */
  spendNet: number;
  vat: number;
  /** valor / spendNet; 0 without spend. */
  roas: number;
}

export interface CountryRow extends Totals {
  country: string;
  name: string;
  currency: string;
  rateToCop: number;
  rateMissing: boolean;
}

/** An enabled country, shown in the selector even when it has no data in the range. */
export interface EnabledCountry {
  country: string;
  name: string;
  currency: string;
  hasData: boolean;
}

/** Rate behind an enabled non-COP country: auto = live rate saved by day, manual = the configured one, none = unknown. */
export interface FxInfo {
  country: string;
  currency: string;
  mode: "auto" | "manual" | "none";
  /** COP per 1 unit of the currency. */
  rate: number;
  date?: string | null;
  fetchedAt: number | null;
  source: string | null;
}

export interface FxRefreshResult {
  today: string;
  rates: { currency: string; date: string; rate: number; fetchedAt: number; source: string }[];
  errors: { currency: string; message: string }[];
  fx: FxInfo[];
}

export interface HistoryInfo {
  from: string | null;
  source: string | null;
  firstData: string | null;
  lastData: string | null;
  days: number;
  vouchers: number;
  backfill: { from: string; at: number } | null;
}

export interface LastSync {
  meta: number | null;
  sheet: number | null;
  metaError: string | null;
  sheetError: string | null;
  /** Per ad account: did its last refresh work, when, and what went wrong. */
  accounts?: Record<string, { ok: boolean; at: number | null; error: string | null }>;
}

export interface ReportAccount {
  accountId: string;
  /** "Sin cuenta" for what cannot be tied to an ad account. */
  name: string;
  portfolioName: string;
  currency: string;
  gasto: number;
  ventas: number;
  valor: number;
  roas: number;
}

export interface ReportNote {
  code: string;
  message: string;
  count?: number;
}

export interface Report {
  range: { from: string; to: string };
  group: Group;
  country: string;
  splitCountry: boolean;
  enabledCountries?: EnabledCountry[];
  fx?: FxInfo[];
  countries: CountryRow[];
  /** Countries that have data at all (even if not enabled), for the settings. */
  detected: { country: string; gasto: number; ventas: number }[];
  history: HistoryInfo;
  currency: string;
  /** IVA (%) added to Meta's spend. */
  spendVatPct?: number;
  kpis: Totals;
  /** Hour window applied to sales and spend (restricted = false: whole day). Messages are not split by hour. */
  hours?: { start: number; end: number; restricted: boolean };
  /** Sales per hour of registration for the same scope, whatever the window (24 entries). */
  hourly?: HourPoint[];
  /** The same 24 hours per real campaign (same keys as campaignDaily), for the chart selector. */
  campaignHourly?: { key: string; hourly: HourPoint[] }[];
  /** Hourly spend comes from Meta at ad level; daysMissing = days with daily spend but no hourly spend saved yet. */
  hourlySpend?: { level: string; available: boolean; daysMissing: number };
  rows: AdRow[];
  daily: DayPoint[];
  /** Daily series per real campaign (whatever the table grouping), for the chart selector. */
  campaignDaily: { campaignId: string; campaign: string; key: string; paused: boolean; daily: DayPoint[] }[];
  /** What the off (paused) rows spent in the range. The KPIs already include it. */
  inactive: { gasto: number; count: number };
  comprobantes: Voucher[];
  reviewCount: number;
  /** Spend and sales per ad account (including "Sin cuenta"). */
  accounts?: ReportAccount[];
  /** Spend left out because no exchange rate was known, etc. */
  warnings?: { code: string; message: string }[];
  /** E.g. payments that cannot be tied to an ad and are not counted under a filter. */
  notes?: ReportNote[];
  nameFilter?: string[];
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

export interface SyncAccountResult {
  accountId: string;
  portfolioId: string;
  ok: boolean;
  code?: string;
  error?: string;
}

export interface SyncResult {
  today: string;
  syncedAt: number;
  meta: SyncPart & { insightRows?: number; ads?: number; partial?: boolean; accounts?: SyncAccountResult[] };
  /** Portfolios whose token could not be read from the Credential Manager (their accounts were skipped). */
  portfolioWarnings?: string[];
  /** Per-account outcome: one failing account never hides the others. */
  accounts?: SyncAccountResult[];
  sheet: SyncPart & { rows?: number; warning?: string };
  backfilled?: boolean;
  history?: HistoryInfo;
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

/** ct_test: decisions issued before campaigns replaced CT codes (history only). */
export type DecisionKind = "test" | "campaign_test" | "ct_test" | "budget";
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

export interface CountrySettings {
  currency: string;
  rateToCop: number;
  /** Follow the live rate (default on); the manual rate is then only the fallback. */
  autoRate?: boolean;
  feePct: number;
  costPerSale: number;
  taxPct: number;
}

export interface AdAccount {
  /** act_1234567890 */
  id: string;
  name: string;
  currency: string;
  timezone: string;
}

/** A Meta Business Manager. Its token lives in the Credential Manager, keyed by `id`; it is never in the config. */
export interface Portfolio {
  id: string;
  name: string;
  accounts: AdAccount[];
}

export interface TokenTestResult {
  portfolio: string;
  name: string;
  id: string;
  /** Ad accounts the token can see, to offer them as quick picks. */
  accounts: { id: string; name: string; currency: string; timezone: string; status: number | null }[];
}

export interface AdsConfig {
  portfolios: Portfolio[];
  /** Countries shown in the views (default only CO). */
  enabledCountries: string[];
  /** Group the other countries as "Otros países" instead of leaving them out. */
  includeOtherCountries: boolean;
  historyFrom: string;
  countries: Record<string, CountrySettings>;
  countryWords: Record<string, string[]>;
  adAccountId: string;
  graphVersion: string;
  campaignPrefix: string;
  sheetId: string;
  sheetTab: string;
  validResult: string;
  flowPrefix: string;
  currency: string;
  /** IVA (%) Meta charges on top of the ad spend; the API reports spend without it. Not the per-country taxPct. */
  spendVatPct: number;
  autoRefreshMinutes: number;
  thresholds: Thresholds;
  lifecycle: Lifecycle;
}

export interface AdsStatus {
  tokenPresent: boolean;
  portfolios?: { id: string; tokenPresent: boolean }[];
  lastSync: LastSync;
  counts: { insights: number; ads: number; comprobantes: number; budgets: number };
  account: { name: string; timezone: string; currency: string } | null;
  history: HistoryInfo;
  today: string;
}

export interface TrackingItem {
  kind: "ad" | "campaign" | "budget";
  id: string;
  label: string;
  ct?: string | null;
  campaignId?: string;
  campaignName?: string;
  dayN: number;
  firstSpendDate?: string;
  inTest?: boolean;
  testDays?: number;
  verdictDay?: number;
  verdictAt?: string;
  verdictDate?: string;
  raise?: Raise | null;
  entityType?: string;
  entityId?: string;
  date?: string;
  pct?: number;
  exact?: boolean;
  checkDay?: number;
  checkAt?: string;
  checkDate?: string;
}

// ---------------------------------------------------------------- Presupuestos (budget timeline + suggestion)

/** Metrics of a window of days (spend WITH IVA; ROAS is value / spend without IVA). */
export interface BudgetWindow {
  from: string;
  to: string;
  /** Days of the window with spend. */
  days: number;
  gasto: number;
  spendNet: number;
  valor: number;
  ventas: number;
  mensajes: number;
  roas: number;
  costoVenta: number;
  conversion: number;
  costoMensaje: number;
}

export interface BudgetStatus {
  key: "evaluating" | "worked" | "worsened" | "stable" | "overlap" | "nodata" | "cut";
  label: string;
  tone: ActionTone;
}

export interface BudgetChange {
  id: string;
  date: string;
  exact: boolean;
  kind: "raise" | "cut";
  oldBudget: number;
  newBudget: number;
  /** Signed: negative for a cut. */
  pct: number;
  daysSince: number;
  /** The after window is over. */
  complete: boolean;
  before: BudgetWindow;
  after: BudgetWindow;
  /** Cost per sale after vs before, in %; null without sales on one side. */
  worsenPct: number | null;
  /** Another budget change fell inside the after window. */
  overlap: boolean;
  /** Counts for learning: a complete raise with spend and no other change in its window. */
  measured: boolean;
  success: boolean;
  status: BudgetStatus;
}

export interface BudgetSuggestion {
  mode: "learning" | "learned";
  action: { key: "raise" | "hold" | "lower" | "wait"; label: string; tone: ActionTone };
  suggestedBudget: number | null;
  suggestedPct: number | null;
  currentBudget: number | null;
  currency: string;
  reason: string;
  detail: string | null;
  /** Measured raises the suggestion is based on (account-wide). */
  evidence: number;
}

export interface BudgetCampaign {
  campaignId: string;
  name: string;
  accountId: string;
  accountName: string;
  /** Currency of the budget amounts (the ad account's); metrics are in the base currency. */
  budgetCurrency: string;
  active: boolean;
  paused: boolean;
  currentBudget: number | null;
  lastChangeDate: string | null;
  daysSinceLastChange: number | null;
  changeCount: number;
  /** Newest first, only the ones inside the chosen range. */
  changes: BudgetChange[];
  suggestion: BudgetSuggestion | null;
}

export interface BudgetLearning {
  mode: "learning" | "learned";
  measured: number;
  needed: number;
  text: string;
  sentence: string | null;
  buckets: { key: string; label: string; n: number; successes: number; medianCpaChangePct: number | null }[];
}

export interface BudgetPlan {
  range: { from: string; to: string };
  today: string;
  currency: string;
  learning: BudgetLearning;
  campaigns: BudgetCampaign[];
  warnings: { code: string; message: string }[];
  notes: { code: string; message: string }[];
  settings: { windowDays: number; postBudgetDays: number; raisePct: number; minMeasured: number; minRoasToScale: number };
}

export const adsApi = {
  /** `accounts` = comma list of act ids; null/omitted = every account. Only those accounts are queried in Meta. */
  sync: (from: string, to: string, accounts: string | null = null) => invoke<SyncResult>("ads_sync", { from, to, accounts }),
  syncAuto: (accounts: string | null = null) => invoke<SyncResult>("ads_sync_auto", { accounts }),
  report: (from: string, to: string, group: Group, country = "", split = false, accounts: string | null = null, name = "", hours: string | null = null) =>
    invoke<Report>("ads_report", { from, to, group, country: country || null, split, accounts, name: name.trim() || null, hours }),
  vouchers: (from: string, to: string, country = "", accounts: string | null = null, name = "") =>
    invoke<VouchersData>("ads_vouchers", { from, to, country: country || null, accounts, name: name.trim() || null }),
  /** Fetches the live exchange rates (free sources, no key); a failure keeps the last saved rate. */
  fxRefresh: () => invoke<FxRefreshResult>("ads_fx_refresh"),
  tracking: () => invoke<{ today: string; items: TrackingItem[] }>("ads_tracking"),
  comprobanteCountry: (key: string, code: string) => invoke<{ key: string; country: string }>("ads_comprobante_country", { key, code }),
  /** Accepts a payment by hand (or takes it back with `undo`); only the local database changes. */
  comprobanteAccept: (key: string, undo = false) => invoke<{ key: string; accepted: boolean }>("ads_comprobante_accept", { key, undo }),
  comprobanteReject: (key: string, undo = false) => invoke<{ key: string; rejected: boolean }>("ads_comprobante_reject", { key, undo }),
  /** Corrects the amount of a payment (null restores the sheet value); only the local database changes. */
  comprobanteValue: (key: string, valor: number | null) => invoke<{ key: string; valor: number | null }>("ads_comprobante_value", { key, valor }),
  /** Assigns an ad to a payment by hand (null removes it); only the local database changes. */
  comprobanteAd: (key: string, ad: string | null) => invoke<{ key: string; adId: string }>("ads_comprobante_ad", { key, ad }),
  /** Budget changes per campaign with the 3 days before/after and the suggested next budget. Reads stored data; never changes Meta. */
  budgetPlan: (from: string, to: string, country = "", accounts: string | null = null, name = "") =>
    invoke<BudgetPlan>("ads_budget_plan", { from, to, country: country || null, accounts, name: name.trim() || null }),
  status: () => invoke<AdsStatus>("ads_status"),
  configGet: () => invoke<{ config: AdsConfig; defaults: AdsConfig }>("ads_config_get"),
  configSet: (config: Partial<AdsConfig>) => invoke<{ config: AdsConfig }>("ads_config_set", { config }),
  decisions: () => invoke<DecisionsData>("ads_decisions"),
  decisionStatus: (id: number, status: DecisionStatus) => invoke<{ id: number; status: DecisionStatus }>("ads_decision_status", { id, status }),
  tickNow: () => invoke<{ created: Decision[]; warnings: string[]; snapshot: boolean; synced: boolean }>("ads_tick_now"),
  /** Legacy single-token commands: they act on the principal portfolio. */
  tokenStatus: () => invoke<boolean>("ads_token_status"),
  tokenImport: () => invoke<void>("ads_token_import_from_monitor"),
  /** Token presence by portfolio id (never the values). */
  portfolioTokenStatus: (portfolios: string[]) => invoke<Record<string, boolean>>("ads_portfolio_token_status", { portfolios }),
  portfolioTokenSet: (portfolio: string, token: string) => invoke<void>("ads_portfolio_token_set", { portfolio, token }),
  /** The principal portfolio (alerts monitor and main account) only accepts this with `confirmPrincipal` after the user confirmed. */
  portfolioTokenClear: (portfolio: string, confirmPrincipal = false) => invoke<void>("ads_portfolio_token_clear", { portfolio, confirmPrincipal }),
  portfolioTokenTest: (portfolio: string) => invoke<TokenTestResult>("ads_portfolio_token_test", { portfolio }),
  /** Creates the portfolio and stores its token. */
  portfolioAdd: (name: string, token: string) => invoke<{ portfolio: { id: string; name: string }; config: AdsConfig }>("ads_portfolio_add", { name, token }),
  /** Removes the portfolio and its token; the stored history stays in the database. */
  portfolioRemove: (portfolio: string, confirmPrincipal = false) => invoke<{ config: AdsConfig }>("ads_portfolio_remove", { portfolio, confirmPrincipal }),
  /** Meta is asked first; the account is saved only if the portfolio's token can read it. */
  accountAdd: (portfolio: string, account: string, name = "") => invoke<{ account: AdAccount; config: AdsConfig }>("ads_account_add", { portfolio, account, name }),
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
/** IVA amount of a spend figure (0 when the payload does not carry it). */
export const vatOf = (x: { vat?: number }) => (Number.isFinite(x.vat) ? (x.vat as number) : 0);
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

export const COUNTRY_NAMES: Record<string, string> = {
  CO: "Colombia", MX: "México", VE: "Venezuela", PE: "Perú", EC: "Ecuador", US: "Estados Unidos", CL: "Chile", AR: "Argentina",
  BR: "Brasil", BO: "Bolivia", PY: "Paraguay", UY: "Uruguay", PA: "Panamá", CR: "Costa Rica", GT: "Guatemala", SV: "El Salvador",
  HN: "Honduras", NI: "Nicaragua", CU: "Cuba", DO: "República Dominicana", ES: "España", XX: "Otros países",
};

export const countryName = (code: string) => (code ? (COUNTRY_NAMES[code] ?? code) : "Sin país");

/** Local calendar day of a timestamp (ms). */
export const dayOfTs = (ts: number) => toIso(new Date(ts));

export const SOURCE_LABEL: Record<string, string> = { telefono: "por teléfono", campana: "por campaña", flujo: "por flujo", manual: "manual" };

/** AAAA-MM-DD -> DD/MM/AAAA */
export const dmy = (iso: string | null | undefined) => (iso ? iso.split("-").reverse().join("/") : "—");
