import assert from "node:assert/strict";
import { test } from "node:test";

import { campaignHeadline, formatBudget, metricPairs, shortRange, signedPct, sinceText, suggestionLine } from "./adsBudgets.ts";

test("formatBudget writes COP as $ with dots and other currencies with their code", () => {
  assert.equal(formatBudget(17000, "COP"), "$17.000");
  assert.equal(formatBudget(1000, "COP"), "$1.000", "four digits are grouped too");
  assert.equal(formatBudget(1234567, ""), "$1.234.567");
  assert.equal(formatBudget(12, "USD"), "USD 12");
  assert.equal(formatBudget(12.5, "USD"), "USD 12,5");
  assert.equal(formatBudget(null, "COP"), "—");
});

test("signedPct shows the direction with a real minus sign", () => {
  assert.equal(signedPct(20), "+20 %");
  assert.equal(signedPct(19.6), "+20 %");
  assert.equal(signedPct(-14.3), "−14 %");
  assert.equal(signedPct(0), "0 %");
});

test("sinceText speaks in days", () => {
  assert.equal(sinceText(null), "sin cambios registrados");
  assert.equal(sinceText(0), "hoy");
  assert.equal(sinceText(1), "hace 1 día");
  assert.equal(sinceText(6), "hace 6 días");
});

test("shortRange shows day/month and collapses a single day", () => {
  assert.equal(shortRange("2026-11-01", "2026-11-03"), "01/11 → 03/11");
  assert.equal(shortRange("2026-11-01", "2026-11-01"), "01/11");
});

const win = (gasto: number, ventas: number, valor: number, mensajes: number, extra = {}) => ({
  from: "2026-11-01", to: "2026-11-03", days: gasto > 0 ? 3 : 0, gasto, spendNet: gasto, valor, ventas, mensajes,
  roas: gasto ? valor / gasto : 0, costoVenta: ventas ? gasto / ventas : 0, conversion: mensajes ? ventas / mensajes : 0, costoMensaje: 0, ...extra,
});

test("metricPairs gives before -> after cells and dashes where a ratio has no base", () => {
  const p = metricPairs(win(30000, 6, 90000, 60), win(36000, 6, 108000, 60));
  assert.deepEqual(p.gasto, ["$30.000", "$36.000"]);
  assert.deepEqual(p.ventas, ["6", "6"]);
  assert.deepEqual(p.roas, ["3,00x", "3,00x"]);
  assert.deepEqual(p.costoVenta, ["$5.000", "$6.000"]);
  assert.deepEqual(p.conversion, ["10,0 %", "10,0 %"]);
  const empty = metricPairs(win(0, 0, 0, 0), win(36000, 0, 0, 0));
  assert.deepEqual(empty.roas, ["—", "0,00x"]);
  assert.deepEqual(empty.costoVenta, ["—", "—"]);
  assert.deepEqual(empty.conversion, ["—", "—"]);
});

test("campaignHeadline joins the current budget and the days since the last change", () => {
  assert.equal(
    campaignHeadline({ currentBudget: 12000, budgetCurrency: "COP", daysSinceLastChange: 6, lastChangeDate: "2026-11-04" }),
    "Presupuesto actual $12.000 · último cambio hace 6 días (04/11)",
  );
  assert.equal(
    campaignHeadline({ currentBudget: null, budgetCurrency: "COP", daysSinceLastChange: null, lastChangeDate: null }),
    "Presupuesto actual desconocido · sin cambios registrados",
  );
});

test("suggestionLine states the mode and the evidence, never 'aprendido' while learning", () => {
  const learning = suggestionLine({ mode: "learning", evidence: 3, action: { key: "raise", label: "Subir 20 % → $14.000", tone: "green" } });
  assert.equal(learning, "Subir 20 % → $14.000 · estándar (3 de 8 subidas medidas)");
  const learned = suggestionLine({ mode: "learned", evidence: 9, action: { key: "raise", label: "Subir 15 % → $17.000", tone: "green" } });
  assert.equal(learned, "Subir 15 % → $17.000 · aprendido de 9 subidas medidas");
});
