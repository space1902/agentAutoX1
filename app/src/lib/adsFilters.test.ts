import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_VOUCHER_FILTERS,
  HOURS_NOTE,
  NO_MESSAGES,
  WHOLE_DAY,
  amountProblem,
  costPerMessage,
  filterVouchers,
  hourLabel,
  hoursArg,
  hoursProblem,
  inHoursWindow,
  parseAmount,
  readChartView,
  readHoursChoice,
  readVoucherFilters,
  stateCounts,
  voucherBanks,
  writeChartView,
  writeHoursChoice,
  writeVoucherFilters,
} from "./adsFilters.ts";

const memory = () => {
  const saved = new Map<string, string>();
  return { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
};
const denied = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

test("cost per message is the spend with IVA over the messages, and nothing without messages", () => {
  assert.equal(costPerMessage({ gasto: 139074, mensajes: 6 }), 23179);
  assert.equal(costPerMessage({ gasto: 139074, mensajes: 0 }), null);
  assert.equal(costPerMessage({ gasto: 0, mensajes: 5 }), 0);
});

test("hours window: validation, engine argument and membership (also across midnight)", () => {
  assert.equal(hoursProblem(WHOLE_DAY), null);
  assert.equal(hoursProblem({ start: 22, end: 6 }), null);
  assert.match(hoursProblem({ start: 8, end: 8 }) ?? "", /distinta/);
  assert.match(hoursProblem({ start: 24, end: 6 }) ?? "", /válid/);
  assert.match(hoursProblem({ start: 3, end: 25 }) ?? "", /válid/);
  assert.equal(hoursArg(WHOLE_DAY), null, "the whole day sends no flag");
  assert.equal(hoursArg({ start: 8, end: 14 }), "8-14");
  assert.equal(hoursArg({ start: 22, end: 6 }), "22-6");
  assert.equal(hoursArg({ start: 8, end: 8 }), null, "an invalid window is never sent");
  assert.deepEqual([7, 8, 13, 14].map((h) => inHoursWindow(h, { start: 8, end: 14 })), [false, true, true, false]);
  assert.deepEqual([21, 22, 0, 5, 6].map((h) => inHoursWindow(h, { start: 22, end: 6 })), [false, true, true, true, false]);
  assert.equal(inHoursWindow(3, WHOLE_DAY), true);
  assert.equal(hourLabel(8), "08:00");
  assert.equal(hourLabel(24), "24:00");
  assert.match(HOURS_NOTE, /el gasto es el que Meta entregó en esas horas/);
});

test("costPerMessage is N/D (null) when messages are N/D under an hour window", () => {
  assert.equal(costPerMessage({ gasto: 1000, mensajes: null }), null);
  assert.equal(costPerMessage({ gasto: 1000, mensajes: 4 }), 250);
  assert.equal(NO_MESSAGES, "N/D con horario");
});

test("the chart view (per day / per hour) is remembered per viewer and defaults to per day", () => {
  const store = memory();
  assert.equal(readChartView(store), "day");
  writeChartView("hour", store);
  assert.equal(readChartView(store), "hour");
  store.setItem("ads.chartView", "junk");
  assert.equal(readChartView(store), "day");
  assert.equal(readChartView(denied), "day");
  assert.doesNotThrow(() => writeChartView("day", denied));
});

test("the hours choice is remembered per viewer, survives junk and blocked storage", () => {
  const store = memory();
  assert.deepEqual(readHoursChoice(store), WHOLE_DAY);
  writeHoursChoice({ start: 22, end: 6 }, store);
  assert.deepEqual(readHoursChoice(store), { start: 22, end: 6 });
  store.setItem("ads.hours", "not json");
  assert.deepEqual(readHoursChoice(store), WHOLE_DAY);
  store.setItem("ads.hours", JSON.stringify({ start: 8, end: 8 }));
  assert.deepEqual(readHoursChoice(store), WHOLE_DAY, "an invalid saved window falls back to the whole day");
  assert.deepEqual(readHoursChoice(denied), WHOLE_DAY);
  assert.doesNotThrow(() => writeHoursChoice({ start: 1, end: 2 }, denied));
});

test("parseAmount accepts whole pesos with separators and refuses everything else", () => {
  assert.equal(parseAmount("45000"), 45000);
  assert.equal(parseAmount("$ 45.000"), 45000);
  assert.equal(parseAmount("1,250,000"), 1250000);
  assert.equal(parseAmount("100000000"), 100000000);
  for (const bad of ["", "0", "-5", "1.5", "45.00", "abc", "100000001", "1e5", "12 34 abc"]) assert.equal(parseAmount(bad), null, bad);
  assert.match(amountProblem("0") ?? "", /entero positivo/);
  assert.match(amountProblem("100000001") ?? "", /100\.000\.000/);
  assert.equal(amountProblem("45.000"), null);
});

// ---- voucher filters

const v = (over: Record<string, unknown>) =>
  ({
    key: "k", date: "2026-10-28", registered: "28/10/2026 10:00:00", valor: 60000, valorSheet: 60000, valueOverridden: false, bank: "Nequi", flow: "Bebidas", adId: "A", adName: "Ad A", ct: "CT 01", campaignId: "c1",
    campaign: "CT01", result: "Pago válido", status: "valid", phoneMasked: "", phone: "573001234567", clientName: "María Pérez", payerName: "", valorCop: 60000, country: "CO", countrySource: "telefono",
    gone: false, accepted: false, rejected: false, accountId: "act_11111", ...over,
  }) as never;

const list = [
  v({ key: "a", clientName: "María Pérez", bank: "Nequi" }),
  v({ key: "b", status: "review", result: "Nombre a revisar", bank: "Bancolombia", country: "MX", accountId: "act_22222", phone: "5215512345678", clientName: "José Núñez" }),
  v({ key: "c", status: "accepted", accepted: true, result: "Nombre a revisar", bank: "nequi" }),
  v({ key: "d", status: "rejected", rejected: true, bank: "Daviplata", country: "" }),
  v({ key: "e", gone: true, bank: "Nequi", accountId: "" }),
  v({ key: "f", valueOverridden: true, valor: 45000, bank: "Nequi" }),
] as never[];
const keys = (items: { key: string }[]) => items.map((i) => i.key).join("");

test("the voucher states are exclusive where they should be and monto corregido overlaps", () => {
  const f = (state: string) => keys(filterVouchers(list, { ...DEFAULT_VOUCHER_FILTERS, state: state as never }));
  assert.equal(f("all"), "abcdef");
  assert.equal(f("valid"), "af");
  assert.equal(f("review"), "b");
  assert.equal(f("accepted"), "c");
  assert.equal(f("rejected"), "d");
  assert.equal(f("gone"), "e");
  assert.equal(f("corrected"), "f");
});

test("bank, account, country and search combine, ignoring case and accents", () => {
  const f = (over: object) => keys(filterVouchers(list, { ...DEFAULT_VOUCHER_FILTERS, ...over }));
  assert.equal(f({ bank: "NEQUI" }), "acef", "banks match ignoring case");
  assert.equal(f({ account: "act_22222" }), "b");
  assert.equal(f({ account: "-" }), "e", "«-» = payments with no ad account");
  assert.equal(f({ country: "MX" }), "b");
  assert.equal(f({ country: "-" }), "d", "«-» = no country");
  assert.equal(f({ search: "jose nunez" }), "b", "name search ignores accents");
  assert.equal(f({ search: "5215512" }), "b", "phone search uses the digits");
  assert.equal(f({ search: "+52 1 55" }), "b");
  assert.equal(f({ search: "12" }), "", "short digit strings are not treated as a phone");
  assert.equal(f({ bank: "Nequi", state: "valid", account: "act_11111" }), "af", "filters combine with AND");
  assert.equal(f({ bank: "Nequi", country: "MX" }), "");
});

test("counts per state respect the other filters", () => {
  const counts = stateCounts(list, { ...DEFAULT_VOUCHER_FILTERS, bank: "Nequi" });
  assert.deepEqual(counts, { all: 4, valid: 2, review: 0, accepted: 1, rejected: 0, gone: 1, corrected: 1 });
});

test("bank options are unique ignoring case and sorted", () => {
  assert.deepEqual(voucherBanks(list), ["Bancolombia", "Daviplata", "Nequi"]);
});

test("voucher filters persist in localStorage, tolerate junk and blocked storage", () => {
  const store = memory();
  assert.deepEqual(readVoucherFilters(store), DEFAULT_VOUCHER_FILTERS);
  const filters = { state: "review" as const, bank: "Nequi", account: "act_11111", country: "MX", search: "maría" };
  writeVoucherFilters(filters, store);
  assert.deepEqual(readVoucherFilters(store), filters);
  store.setItem("ads.voucherFilters", "{bad");
  assert.deepEqual(readVoucherFilters(store), DEFAULT_VOUCHER_FILTERS);
  store.setItem("ads.voucherFilters", JSON.stringify({ state: "weird", bank: 5, account: "x".repeat(500), country: "MX", search: "a".repeat(500) }));
  const cleaned = readVoucherFilters(store);
  assert.equal(cleaned.state, "all");
  assert.equal(cleaned.bank, "");
  assert.equal(cleaned.account, "");
  assert.equal(cleaned.country, "MX");
  assert.ok(cleaned.search.length <= 80);
  assert.deepEqual(readVoucherFilters(denied), DEFAULT_VOUCHER_FILTERS);
  assert.doesNotThrow(() => writeVoucherFilters(filters, denied));
});
