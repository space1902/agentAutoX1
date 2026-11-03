// Pure view logic of the Anuncios section (no React, no Tauri), so it can be tested with `node --test`.
import type { EnabledCountry, FxInfo, TrackingItem } from "./adsApi";

const dmyText = (iso: string) => iso.split("-").reverse().join("/");

/** Why a date range cannot be applied, or null when it is fine. Dates are AAAA-MM-DD, so string order is date order. */
export function rangeProblem(from: string, to: string, min: string | null, max: string): string | null {
  if (!from || !to) return "Elige las dos fechas: desde y hasta.";
  if (from > to) return "«Desde» no puede ser posterior a «Hasta».";
  if (to > max) return "No hay datos de fechas futuras: «Hasta» como máximo es hoy.";
  if (min && from < min) return `El historial empieza el ${dmyText(min)}: «Desde» no puede ser anterior.`;
  return null;
}

export interface CampaignGroup {
  /** Meta campaign id (a name when Meta gave none). */
  key: string;
  name: string;
  summary: TrackingItem | null;
  ads: TrackingItem[];
  /** Raises that no listed ad of this campaign carries (so they are not shown twice). */
  orphanBudgets: TrackingItem[];
  latestRaise: { dayN: number; date: string; pct: number } | null;
  inTest: number;
}

const NO_CAMPAIGN = "Sin campaña";

/** One group per real campaign (never merged by the CT code in the name): its summary, its ads and the raises no listed ad carries. */
export function groupTracking(items: TrackingItem[]): CampaignGroup[] {
  const groups = new Map<string, CampaignGroup>();
  const group = (key: string, name: string) => {
    if (!groups.has(key)) groups.set(key, { key, name, summary: null, ads: [], orphanBudgets: [], latestRaise: null, inTest: 0 });
    return groups.get(key)!;
  };
  const keyOf = (i: TrackingItem) => (i.kind === "campaign" ? i.id : i.campaignId || i.campaignName || "");
  for (const i of items) {
    if (i.kind === "budget") continue;
    const key = keyOf(i) || NO_CAMPAIGN;
    const g = group(key, i.kind === "campaign" ? i.label : i.campaignName || (key === NO_CAMPAIGN ? NO_CAMPAIGN : key));
    if (i.kind === "campaign") {
      g.summary = i;
      g.name = i.label;
    } else if (i.kind === "ad") {
      g.ads.push(i);
      if (i.inTest) g.inTest += 1;
    }
  }
  for (const g of groups.values()) {
    const carried = new Set(g.ads.filter((a) => a.raise).map((a) => `${a.raise!.entityType}:${a.raise!.entityId}:${a.raise!.date}`));
    for (const i of items.filter((x) => x.kind === "budget" && (keyOf(x) || NO_CAMPAIGN) === g.key)) {
      if (!carried.has(`${i.entityType}:${i.entityId}:${i.date}`)) g.orphanBudgets.push(i);
      const r = { dayN: i.dayN, date: i.date ?? "", pct: i.pct ?? 0 };
      if (!g.latestRaise || r.date > g.latestRaise.date) g.latestRaise = r;
    }
    for (const a of g.ads) if (a.raise && (!g.latestRaise || a.raise.date > g.latestRaise.date)) g.latestRaise = a.raise;
    g.ads.sort((x, y) => y.dayN - x.dayN || x.label.localeCompare(y.label));
  }
  return [...groups.values()].sort((x, y) => (x.key === NO_CAMPAIGN ? 1 : y.key === NO_CAMPAIGN ? -1 : x.name.localeCompare(y.name, "es", { numeric: true })));
}

interface PausedRow {
  paused?: boolean;
  gasto: number;
}

/** The table rows to show: campaigns that are off in Meta only appear when the user asks for them. */
export function visibleRows<T extends PausedRow>(rows: T[], showInactive: boolean): T[] {
  return showInactive ? rows : rows.filter((r) => !r.paused);
}

/** What the hidden (off) rows spent: the totals above always include it, so the screen says so. */
export function hiddenInactive(rows: PausedRow[], showInactive: boolean): { gasto: number; count: number } {
  if (showInactive) return { gasto: 0, count: 0 };
  const hidden = rows.filter((r) => r.paused);
  return { gasto: hidden.reduce((n, r) => n + r.gasto, 0), count: hidden.length };
}

const SHOW_INACTIVE_KEY = "ads.showInactive";
type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The "Mostrar desactivadas" choice of this viewer (default: off). Storage can be missing or blocked, so every access is guarded. */
export function readShowInactive(store: KeyValueStore | null = defaultStore()): boolean {
  try {
    return store?.getItem(SHOW_INACTIVE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShowInactive(value: boolean, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(SHOW_INACTIVE_KEY, value ? "1" : "0");
  } catch {
    // The choice just won't persist.
  }
}

// Longest-first country calling codes the ads run in; anything else is shown as "+digits" grouped by three.
const CALLING_CODES = ["593", "591", "595", "598", "57", "52", "58", "51", "54", "56", "55", "34", "1"];

/** "+57 300 123 4567" for a raw sheet phone ("573001234567", "+57 300 123 4567"...); "" when there are no digits. */
export function formatVoucherPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  const code = digits.length > 10 ? CALLING_CODES.find((c) => digits.startsWith(c)) : undefined;
  const national = code ? digits.slice(code.length) : digits;
  const groups = national.match(/^(\d{1,3})(\d{1,3})?(\d+)?$/)?.slice(1).filter(Boolean) ?? [national];
  return `${code || digits.length > 10 ? "+" : ""}${code ? `${code} ` : ""}${groups.join(" ")}`.trim();
}

/** Digits of a phone as typed in the sheet. */
export const phoneDigits = (raw: string | null | undefined) => String(raw ?? "").replace(/\D/g, "");

// ---------------------------------------------------------------- country selector and live rate

/** One chip per enabled country (even without data) and then "Combinado" (id "" = every enabled country, in COP). */
export function countryChips(enabled: EnabledCountry[]): { id: string; label: string }[] {
  return [...enabled.map((c) => ({ id: c.country, label: c.name })), { id: "", label: "Combinado" }];
}

/** The saved choice if it still exists (an enabled country or "-" = no country); otherwise Combinado. Nothing known yet: keep it. */
export function resolveCountryChoice(choice: string, enabled: EnabledCountry[]): string {
  if (!choice || choice === "-" || enabled.length === 0) return choice;
  return enabled.some((c) => c.country === choice) ? choice : "";
}

const COUNTRY_KEY = "ads.country";

/** The selected country of this viewer ("" = Combinado). Storage can be missing or blocked, so every access is guarded. */
export function readCountryChoice(store: KeyValueStore | null = defaultStore()): string {
  try {
    const v = store?.getItem(COUNTRY_KEY) ?? "";
    return /^([A-Z]{2}|-)?$/.test(v) ? v : "";
  } catch {
    return "";
  }
}

export function writeCountryChoice(value: string, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(COUNTRY_KEY, value);
  } catch {
    // The choice just won't persist.
  }
}

/** Muted note for a selected country that has no data in the range (null when there is nothing to say). */
export function noDataNote(choice: string, enabled: EnabledCountry[]): string | null {
  const c = choice && choice !== "-" ? enabled.find((e) => e.country === choice) : undefined;
  return c && !c.hasData ? `Sin datos de ${c.name} en este rango` : null;
}

/** "MXN $ 1.235": the value in the country's own currency (null for COP, which is already what the card shows). */
export function formatNative(currency: string, value: number): string | null {
  return currency === "COP" ? null : `${currency} $ ${new Intl.NumberFormat("es-CO").format(Math.round(value))}`;
}

const two = (n: number) => String(n).padStart(2, "0");

/** "1 MXN = $ 170,66 COP · actualizada 14:05 (open.er-api.com)". The date is added when the rate was fetched on another day. */
export function fxLine(fx: FxInfo, now: number): string {
  if (fx.mode === "none") return `1 ${fx.currency} = sin tasa (defínela en Configuración)`;
  const rate = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(fx.rate);
  const head = `1 ${fx.currency} = $ ${rate} COP`;
  if (fx.mode === "manual" || fx.fetchedAt === null) return `${head} · tasa manual`;
  const at = new Date(fx.fetchedAt);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const day = sameDay ? "" : `${two(at.getDate())}/${two(at.getMonth() + 1)} `;
  return `${head} · actualizada ${day}${two(at.getHours())}:${two(at.getMinutes())}${fx.source ? ` (${fx.source})` : ""}`;
}
