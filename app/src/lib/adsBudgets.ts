// View helpers of the "Presupuestos" tab (pure, no Tauri imports so `node --test` can run them).
import type { BudgetCampaign, BudgetSuggestion, BudgetWindow } from "./adsApi";

const group = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** "$17.000" for COP (or no currency), "USD 12,5" for any other. */
export function formatBudget(amount: number | null, currency: string): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  const text = Number.isInteger(amount) ? group(amount) : `${group(Math.trunc(amount))},${String(Math.round((Math.abs(amount) % 1) * 100)).padStart(2, "0").replace(/0$/, "")}`;
  return !currency || currency === "COP" ? `$${text}` : `${currency} ${text}`;
}

/** "+20 %" / "−14 %" (a real minus sign) / "0 %". */
export function signedPct(pct: number): string {
  const n = Math.round(pct);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)} %`;
}

export function sinceText(days: number | null): string {
  if (days === null) return "sin cambios registrados";
  if (days === 0) return "hoy";
  return `hace ${days} ${days === 1 ? "día" : "días"}`;
}

const dm = (iso: string) => iso.split("-").reverse().slice(0, 2).join("/");

/** "01/11 → 03/11" (a single day is just "01/11"). */
export function shortRange(from: string, to: string): string {
  return from === to ? dm(from) : `${dm(from)} → ${dm(to)}`;
}

const money = (n: number) => `$${group(n)}`;
const roas = (n: number) => `${n.toFixed(2).replace(".", ",")}x`;
const pct1 = (fraction: number) => `${(fraction * 100).toFixed(1).replace(".", ",")} %`;

export interface MetricPairs {
  gasto: [string, string];
  ventas: [string, string];
  roas: [string, string];
  costoVenta: [string, string];
  conversion: [string, string];
}

/** Each metric as [3 days before, 3 days after]; ratios without a base show a dash. */
export function metricPairs(before: BudgetWindow, after: BudgetWindow): MetricPairs {
  const pair = (f: (w: BudgetWindow) => string): [string, string] => [f(before), f(after)];
  return {
    gasto: pair((w) => (w.days > 0 ? money(w.gasto) : "—")),
    ventas: pair((w) => (w.days > 0 || w.ventas > 0 ? String(w.ventas) : "—")),
    roas: pair((w) => (w.gasto > 0 ? roas(w.roas) : "—")),
    costoVenta: pair((w) => (w.ventas > 0 && w.gasto > 0 ? money(w.costoVenta) : "—")),
    conversion: pair((w) => (w.mensajes > 0 ? pct1(w.conversion) : "—")),
  };
}

export function campaignHeadline(c: Pick<BudgetCampaign, "currentBudget" | "budgetCurrency" | "daysSinceLastChange" | "lastChangeDate">): string {
  const budget = c.currentBudget === null ? "desconocido" : formatBudget(c.currentBudget, c.budgetCurrency);
  const last = c.daysSinceLastChange === null ? sinceText(null) : `último cambio ${sinceText(c.daysSinceLastChange)}${c.lastChangeDate ? ` (${dm(c.lastChangeDate)})` : ""}`;
  return `Presupuesto actual ${budget} · ${last}`;
}

/** The action plus where it comes from: the standard rule while learning, the learned evidence afterwards. */
export function suggestionLine(s: Pick<BudgetSuggestion, "mode" | "evidence" | "action">): string {
  const source = s.mode === "learned" ? `aprendido de ${s.evidence} subidas medidas` : `estándar (${s.evidence} de 8 subidas medidas)`;
  return `${s.action.label} · ${source}`;
}
