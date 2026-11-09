// Pure view logic added to the Anuncios section: cost per message, the hour-of-day window, the corrected payment amount
// and the vouchers list filters. No React, no Tauri, so it can be tested with `node --test`.
import type { Voucher } from "./adsApi";

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- cost per message

/** Spend (with IVA) over messages: null when there are no messages (the table shows a dash) or they are N/D (hour window). */
export const NO_MESSAGES = "N/D con horario";
export function costPerMessage(row: { gasto: number; mensajes: number | null }): number | null {
  return row.mensajes !== null && row.mensajes > 0 ? row.gasto / row.mensajes : null;
}

// ---------------------------------------------------------------- hour-of-day window

/** Hours of the day in which a payment was registered (start inclusive, end exclusive; start > end wraps past midnight). */
export interface HoursWindow {
  start: number;
  end: number;
}

export const WHOLE_DAY: HoursWindow = { start: 0, end: 24 };
const HOURS_KEY = "ads.hours";

export const HOURS_NOTE = "Con horario, el gasto es el que Meta entregó en esas horas (hora de Bogotá). Los mensajes no se separan por hora y no se muestran.";

// ---------------------------------------------------------------- chart view (per day / per hour)

export type ChartView = "day" | "hour";
const CHART_VIEW_KEY = "ads.chartView";

/** The chart this viewer last picked; "day" when nothing valid was saved or storage is blocked. */
export function readChartView(store: KeyValueStore | null = defaultStore()): ChartView {
  try {
    return store?.getItem(CHART_VIEW_KEY) === "hour" ? "hour" : "day";
  } catch {
    return "day";
  }
}

export function writeChartView(view: ChartView, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(CHART_VIEW_KEY, view);
  } catch {
    // The choice just will not persist.
  }
}

export const isWholeDay = (w: HoursWindow) => w.start === 0 && w.end === 24;

/** Why a window cannot be applied, or null when it is fine. */
export function hoursProblem(w: HoursWindow): string | null {
  if (!Number.isInteger(w.start) || !Number.isInteger(w.end) || w.start < 0 || w.start > 23 || w.end < 0 || w.end > 24) return "El horario no es válido: usa horas de 0 a 24.";
  if (w.start === w.end) return "La hora de inicio debe ser distinta de la de fin.";
  return null;
}

/** `--hours` value for the engine: null = whole day (flag omitted) or an invalid window. */
export function hoursArg(w: HoursWindow): string | null {
  return hoursProblem(w) !== null || isWholeDay(w) ? null : `${w.start}-${w.end}`;
}

export function inHoursWindow(hour: number, w: HoursWindow): boolean {
  if (isWholeDay(w)) return true;
  return w.start < w.end ? hour >= w.start && hour < w.end : hour >= w.start || hour < w.end;
}

export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** The window of this viewer; the whole day when nothing valid was saved. */
export function readHoursChoice(store: KeyValueStore | null = defaultStore()): HoursWindow {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(HOURS_KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      const { start, end } = parsed as Record<string, unknown>;
      if (typeof start === "number" && typeof end === "number" && hoursProblem({ start, end }) === null) return { start, end };
    }
  } catch {
    // Unreadable or blocked: use the whole day.
  }
  return { ...WHOLE_DAY };
}

export function writeHoursChoice(w: HoursWindow, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(HOURS_KEY, JSON.stringify({ start: w.start, end: w.end }));
  } catch {
    // The choice just will not persist.
  }
}

// ---------------------------------------------------------------- corrected payment amount

const MAX_AMOUNT = 100_000_000;

/** "45.000", "$ 45,000" or "45000" -> 45000. Whole pesos from 1 to 100,000,000; anything else (decimals, letters) -> null. */
export function parseAmount(text: string): number | null {
  const t = String(text ?? "").trim().replace(/^\$\s*/, "");
  if (!/^\d{1,3}([.,]\d{3})+$|^\d+$/.test(t)) return null;
  const n = Number(t.replace(/[.,]/g, ""));
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_AMOUNT ? n : null;
}

export function amountProblem(text: string): string | null {
  return parseAmount(text) === null ? "El monto debe ser un número entero positivo de hasta 100.000.000." : null;
}

// ---------------------------------------------------------------- voucher filters

/** Lowercase without accents, for searches. */
export const foldText = (value: string | null | undefined) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

export type VoucherState = "all" | "valid" | "review" | "accepted" | "rejected" | "gone" | "corrected";
export const VOUCHER_STATES: VoucherState[] = ["all", "valid", "review", "accepted", "rejected", "gone", "corrected"];

export interface VoucherFilters {
  state: VoucherState;
  /** "" = every bank. */
  bank: string;
  /** Ad account id, "-" = payments with no ad account, "" = every account. */
  account: string;
  /** Country code, "-" = no country, "" = every country. */
  country: string;
  /** Name or phone. */
  search: string;
}

export const DEFAULT_VOUCHER_FILTERS: VoucherFilters = { state: "all", bank: "", account: "", country: "", search: "" };

type VoucherLike = Pick<Voucher, "status" | "gone" | "rejected" | "valueOverridden" | "bank" | "accountId" | "country" | "clientName" | "payerName" | "phone">;

export function voucherInState(v: VoucherLike, state: VoucherState): boolean {
  const live = !v.gone && !v.rejected;
  switch (state) {
    case "valid":
      return live && v.status === "valid";
    case "review":
      return !v.gone && (v.status === "review" || v.status === "invalid");
    case "accepted":
      return live && v.status === "accepted";
    case "rejected":
      return v.rejected;
    case "gone":
      return v.gone;
    case "corrected":
      return Boolean(v.valueOverridden);
    default:
      return true;
  }
}

const digitsOf = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");

function matchesSearch(v: VoucherLike, search: string): boolean {
  const q = foldText(search);
  if (!q) return true;
  if (foldText(v.clientName).includes(q) || foldText(v.payerName).includes(q)) return true;
  const d = digitsOf(search);
  return d.length >= 3 && digitsOf(v.phone).includes(d);
}

/** Every filter except the state (used for the per-state counts). */
function matchesOthers(v: VoucherLike, f: VoucherFilters): boolean {
  if (f.bank && foldText(v.bank) !== foldText(f.bank)) return false;
  if (f.account && (f.account === "-" ? v.accountId !== "" : v.accountId !== f.account)) return false;
  if (f.country && (f.country === "-" ? v.country !== "" : v.country !== f.country)) return false;
  return matchesSearch(v, f.search);
}

/** Filters combine with AND. */
export function filterVouchers<T extends VoucherLike>(vouchers: T[], f: VoucherFilters): T[] {
  return vouchers.filter((v) => voucherInState(v, f.state) && matchesOthers(v, f));
}

/** How many payments each state has once the other filters are applied. */
export function stateCounts(vouchers: VoucherLike[], f: VoucherFilters): Record<VoucherState, number> {
  const base = vouchers.filter((v) => matchesOthers(v, f));
  return Object.fromEntries(VOUCHER_STATES.map((s) => [s, base.filter((v) => voucherInState(v, s)).length])) as Record<VoucherState, number>;
}

/** Banks present in the list, one per case-insensitive name, sorted. */
export function voucherBanks(vouchers: { bank: string }[]): string[] {
  const seen = new Map<string, string>();
  for (const v of vouchers) {
    const name = v.bank.trim();
    if (name && !seen.has(foldText(name))) seen.set(foldText(name), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "es"));
}

const VOUCHER_FILTERS_KEY = "ads.voucherFilters";

export function readVoucherFilters(store: KeyValueStore | null = defaultStore()): VoucherFilters {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(VOUCHER_FILTERS_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_VOUCHER_FILTERS };
    const p = parsed as Record<string, unknown>;
    const text = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
    const state = VOUCHER_STATES.includes(p.state as VoucherState) ? (p.state as VoucherState) : "all";
    const account = text(p.account, 40);
    const country = text(p.country, 2);
    return {
      state,
      bank: text(p.bank, 60),
      account: /^(act_\d{5,25}|-)?$/.test(account) ? account : "",
      country: /^([A-Z]{2}|-)?$/.test(country) ? country : "",
      search: text(p.search, 80),
    };
  } catch {
    return { ...DEFAULT_VOUCHER_FILTERS };
  }
}

export function writeVoucherFilters(f: VoucherFilters, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(VOUCHER_FILTERS_KEY, JSON.stringify(f));
  } catch {
    // The filters just will not persist.
  }
}

export const hasVoucherFilters = (f: VoucherFilters) => JSON.stringify(f) !== JSON.stringify(DEFAULT_VOUCHER_FILTERS);
