// Pure view logic of the Anuncios section (no React, no Tauri), so it can be tested with `node --test`.
import type { TrackingItem } from "./adsApi";

const dmyText = (iso: string) => iso.split("-").reverse().join("/");

/** Why a date range cannot be applied, or null when it is fine. Dates are AAAA-MM-DD, so string order is date order. */
export function rangeProblem(from: string, to: string, min: string | null, max: string): string | null {
  if (!from || !to) return "Elige las dos fechas: desde y hasta.";
  if (from > to) return "«Desde» no puede ser posterior a «Hasta».";
  if (to > max) return "No hay datos de fechas futuras: «Hasta» como máximo es hoy.";
  if (min && from < min) return `El historial empieza el ${dmyText(min)}: «Desde» no puede ser anterior.`;
  return null;
}

export interface CtGroup {
  ct: string;
  summary: TrackingItem | null;
  ads: TrackingItem[];
  /** Raises that no listed ad of this CT carries (so they are not shown twice). */
  orphanBudgets: TrackingItem[];
  latestRaise: { dayN: number; date: string; pct: number } | null;
  inTest: number;
}

const ctNumber = (label: string) => Number(/\d+/.exec(label)?.[0] ?? 9999);

/** One group per CT (sorted by number): its summary, its ads and the raises that no listed ad carries. */
export function groupTracking(items: TrackingItem[]): CtGroup[] {
  const groups = new Map<string, CtGroup>();
  const group = (ct: string) => {
    if (!groups.has(ct)) groups.set(ct, { ct, summary: null, ads: [], orphanBudgets: [], latestRaise: null, inTest: 0 });
    return groups.get(ct)!;
  };
  for (const i of items) {
    const g = group(i.ct ?? "Sin CT");
    if (i.kind === "ct") g.summary = i;
    else if (i.kind === "ad") {
      g.ads.push(i);
      if (i.inTest) g.inTest += 1;
    }
  }
  for (const g of groups.values()) {
    const carried = new Set(g.ads.filter((a) => a.raise).map((a) => `${a.raise!.entityType}:${a.raise!.entityId}:${a.raise!.date}`));
    for (const i of items.filter((x) => x.kind === "budget" && (x.ct ?? "Sin CT") === g.ct)) {
      if (!carried.has(`${i.entityType}:${i.entityId}:${i.date}`)) g.orphanBudgets.push(i);
      const r = { dayN: i.dayN, date: i.date ?? "", pct: i.pct ?? 0 };
      if (!g.latestRaise || r.date > g.latestRaise.date) g.latestRaise = r;
    }
    for (const a of g.ads) if (a.raise && (!g.latestRaise || a.raise.date > g.latestRaise.date)) g.latestRaise = a.raise;
    g.ads.sort((x, y) => y.dayN - x.dayN || x.label.localeCompare(y.label));
  }
  return [...groups.values()].sort((x, y) => ctNumber(x.ct) - ctNumber(y.ct) || x.ct.localeCompare(y.ct));
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
