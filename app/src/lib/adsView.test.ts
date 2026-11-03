import assert from "node:assert/strict";
import { test } from "node:test";

import { countryChips, formatNative, formatVoucherPhone, fxLine, groupTracking, hiddenInactive, noDataNote, rangeProblem, readCountryChoice, readShowInactive, resolveCountryChoice, visibleRows, writeCountryChoice, writeShowInactive } from "./adsView.ts";

test("rangeProblem accepts a valid range and explains each invalid one", () => {
  assert.equal(rangeProblem("2026-10-21", "2026-10-29", "2026-09-23", "2026-10-29"), null);
  assert.equal(rangeProblem("2026-10-29", "2026-10-29", null, "2026-10-29"), null);
  assert.match(rangeProblem("", "2026-10-29", null, "2026-10-29") ?? "", /dos fechas/);
  assert.match(rangeProblem("2026-10-30", "2026-10-29", null, "2026-10-29") ?? "", /no puede ser posterior/);
  assert.match(rangeProblem("2026-10-01", "2026-11-02", null, "2026-10-29") ?? "", /futuras/);
  assert.match(rangeProblem("2026-09-01", "2026-10-02", "2026-09-23", "2026-10-29") ?? "", /empieza el 23\/09\/2026/);
});

const ad = (id: string, campaignId: string | null, dayN: number, extra: object = {}) =>
  ({ kind: "ad", id, label: `Anuncio ${id}`, campaignId, campaignName: campaignId ? `Campaña ${campaignId}` : "", dayN, inTest: dayN <= 5, ...extra }) as never;

test("groupTracking makes ONE group per real campaign, so two campaigns sharing a CT code stay apart", () => {
  const raise = { date: "2026-10-26", pct: 30, dayN: 4, exact: false, entityType: "campaign", entityId: "c6" };
  const items = [
    { kind: "budget", id: "campaign:c6:2026-10-26:13000", entityType: "campaign", entityId: "c6", campaignId: "c6", ct: "CT 06", label: "CT 06 Col 2 - ventas", dayN: 4, date: "2026-10-26", pct: 30 },
    { kind: "campaign", id: "c6", ct: "CT 06", label: "CT 06 Col 2 - ventas", dayN: 8 },
    { kind: "campaign", id: "c6b", ct: "CT 06", label: "CT 06 Col 2", dayN: 2 },
    ad("a6", "c6", 8, { raise }),
    ad("a6b", "c6b", 2),
    { kind: "campaign", id: "c10", ct: "CT 10", label: "CT 10", dayN: 3 },
    ad("a10", "c10", 3),
    ad("x", null, 2),
  ] as never[];
  const groups = groupTracking(items);
  assert.deepEqual(groups.map((g) => g.name), ["CT 06 Col 2", "CT 06 Col 2 - ventas", "CT 10", "Sin campaña"]);
  const c6 = groups.find((g) => g.key === "c6")!;
  assert.equal(c6.ads.length, 1);
  assert.equal(c6.summary?.dayN, 8);
  assert.equal(c6.orphanBudgets.length, 0, "the raise is already shown on its ad");
  assert.deepEqual(c6.latestRaise && [c6.latestRaise.date, c6.latestRaise.dayN], ["2026-10-26", 4]);
  assert.equal(groups.find((g) => g.key === "c6b")!.ads.length, 1);
});

test("a raise no ad carries is kept as its own row under its campaign", () => {
  const items = [
    { kind: "budget", id: "adset:s1:2026-10-27:13000", entityType: "adset", entityId: "s1", campaignId: "c1", label: "Set 1", dayN: 3, date: "2026-10-27", pct: 30 },
    ad("a1", "c1", 5),
    ad("a10", "c10", 5),
  ] as never[];
  const groups = groupTracking(items);
  assert.equal(groups.find((g) => g.key === "c1")!.orphanBudgets.length, 1);
  assert.equal(groups.find((g) => g.key === "c10")!.orphanBudgets.length, 0);
  assert.equal(groups.find((g) => g.key === "c10")!.ads.length, 1);
});

test("ads are listed oldest first and ads in the test are counted", () => {
  const g = groupTracking([ad("b", "c2", 2), ad("a", "c2", 9), ad("c", "c2", 4)])[0];
  assert.deepEqual(g.ads.map((a) => a.id), ["a", "c", "b"]);
  assert.equal(g.inTest, 2);
});

const row = (label: string, gasto: number, paused: boolean) => ({ label, gasto, paused });

test("visibleRows hides paused rows by default and shows them all when asked", () => {
  const rows = [row("A", 100, false), row("B", 50, true), row("C", 10, false)];
  assert.deepEqual(visibleRows(rows, false).map((r) => r.label), ["A", "C"]);
  assert.deepEqual(visibleRows(rows, true).map((r) => r.label), ["A", "B", "C"]);
});

test("hiddenInactive sums what the hidden rows spent so the totals can say they include it", () => {
  const rows = [row("A", 100, false), row("B", 50, true), row("D", 25, true)];
  assert.deepEqual(hiddenInactive(rows, false), { gasto: 75, count: 2 });
  assert.deepEqual(hiddenInactive(rows, true), { gasto: 0, count: 0 });
  assert.deepEqual(hiddenInactive([row("A", 1, false)], false), { gasto: 0, count: 0 });
});

test("showInactive is read and saved safely even when storage is missing or broken", () => {
  const saved = new Map<string, string>();
  const good = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  assert.equal(readShowInactive(good), false);
  writeShowInactive(true, good);
  assert.equal(readShowInactive(good), true);
  writeShowInactive(false, good);
  assert.equal(readShowInactive(good), false);
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(readShowInactive(broken), false);
  assert.doesNotThrow(() => writeShowInactive(true, broken));
  assert.equal(readShowInactive(null), false);
});

test("formatVoucherPhone groups the digits and adds the country code", () => {
  assert.equal(formatVoucherPhone("573001234567"), "+57 300 123 4567");
  assert.equal(formatVoucherPhone("+57 300 123 4567"), "+57 300 123 4567");
  assert.equal(formatVoucherPhone("584141234567"), "+58 414 123 4567");
  assert.equal(formatVoucherPhone("3001234567"), "300 123 4567");
  assert.equal(formatVoucherPhone(""), "");
  assert.equal(formatVoucherPhone("sin número"), "");
});

const enabled = [
  { country: "CO", name: "Colombia", currency: "COP", hasData: true },
  { country: "MX", name: "México", currency: "MXN", hasData: false },
];

test("countryChips lists every enabled country (with or without data) and then Combinado", () => {
  assert.deepEqual(countryChips(enabled), [
    { id: "CO", label: "Colombia" },
    { id: "MX", label: "México" },
    { id: "", label: "Combinado" },
  ]);
  assert.deepEqual(countryChips([]), [{ id: "", label: "Combinado" }]);
});

test("resolveCountryChoice keeps an enabled country, the data without country, or falls back to Combinado", () => {
  assert.equal(resolveCountryChoice("MX", enabled), "MX");
  assert.equal(resolveCountryChoice("-", enabled), "-");
  assert.equal(resolveCountryChoice("", enabled), "");
  assert.equal(resolveCountryChoice("VE", enabled), "");
  assert.equal(resolveCountryChoice("MX", []), "MX", "nothing is known yet: do not drop the saved choice");
});

test("the country choice is remembered on this device and survives broken storage", () => {
  const saved = new Map<string, string>();
  const good = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  assert.equal(readCountryChoice(good), "");
  writeCountryChoice("MX", good);
  assert.equal(readCountryChoice(good), "MX");
  writeCountryChoice("", good);
  assert.equal(readCountryChoice(good), "");
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(readCountryChoice(broken), "");
  assert.doesNotThrow(() => writeCountryChoice("MX", broken));
  assert.equal(readCountryChoice(null), "");
});

test("noDataNote only speaks for a single country without data in the range", () => {
  assert.equal(noDataNote("MX", enabled), "Sin datos de México en este rango");
  assert.equal(noDataNote("CO", enabled), null);
  assert.equal(noDataNote("", enabled), null);
  assert.equal(noDataNote("-", enabled), null);
});

test("formatNative shows the native currency of a non-COP country", () => {
  assert.equal(formatNative("MXN", 1234.5), "MXN $ 1.235");
  assert.equal(formatNative("COP", 1000), null);
});

test("fxLine describes the live rate with its time and source, or says it is manual", () => {
  const at = new Date(2026, 10, 3, 14, 5).getTime();
  const now = new Date(2026, 10, 3, 18, 0).getTime();
  const live = { country: "MX", currency: "MXN", mode: "auto" as const, rate: 170.66, date: "2026-11-03", fetchedAt: at, source: "open.er-api.com" };
  assert.equal(fxLine(live, now), "1 MXN = $ 170,66 COP · actualizada 14:05 (open.er-api.com)");
  const old = { ...live, fetchedAt: new Date(2026, 10, 1, 9, 30).getTime() };
  assert.equal(fxLine(old, now), "1 MXN = $ 170,66 COP · actualizada 01/11 09:30 (open.er-api.com)");
  assert.equal(fxLine({ ...live, mode: "manual" as const, fetchedAt: null, source: null, rate: 50 }, now), "1 MXN = $ 50 COP · tasa manual");
  assert.equal(fxLine({ ...live, mode: "none" as const, fetchedAt: null, source: null, rate: 1 }, now), "1 MXN = sin tasa (defínela en Configuración)");
});
