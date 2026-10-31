import assert from "node:assert/strict";
import { test } from "node:test";

import { formatVoucherPhone, groupTracking, rangeProblem } from "./adsView.ts";

test("rangeProblem accepts a valid range and explains each invalid one", () => {
  assert.equal(rangeProblem("2026-10-21", "2026-10-29", "2026-09-23", "2026-10-29"), null);
  assert.equal(rangeProblem("2026-10-29", "2026-10-29", null, "2026-10-29"), null);
  assert.match(rangeProblem("", "2026-10-29", null, "2026-10-29") ?? "", /dos fechas/);
  assert.match(rangeProblem("2026-10-30", "2026-10-29", null, "2026-10-29") ?? "", /no puede ser posterior/);
  assert.match(rangeProblem("2026-10-01", "2026-11-02", null, "2026-10-29") ?? "", /futuras/);
  assert.match(rangeProblem("2026-09-01", "2026-10-02", "2026-09-23", "2026-10-29") ?? "", /empieza el 23\/09\/2026/);
});

const ad = (id: string, ct: string | null, dayN: number, extra: object = {}) =>
  ({ kind: "ad", id, label: `Anuncio ${id}`, ct, dayN, inTest: dayN <= 5, ...extra }) as never;

test("groupTracking makes ONE group per CT, sorted by number, so CT 06 is not listed three times", () => {
  const raise = { date: "2026-10-26", pct: 30, dayN: 4, exact: false, entityType: "campaign", entityId: "c6" };
  const items = [
    { kind: "budget", id: "campaign:c6:2026-10-26:13000", entityType: "campaign", entityId: "c6", ct: "CT 06", label: "CT 06 Col 2 - ventas", dayN: 4, date: "2026-10-26", pct: 30 },
    { kind: "ct", id: "CT 06", ct: "CT 06", label: "CT 06", dayN: 8 },
    ad("a6", "CT 06", 8, { raise }),
    ad("a10", "CT 10", 3),
    { kind: "ct", id: "CT 10", ct: "CT 10", label: "CT 10", dayN: 3 },
    ad("a1", "CT 01", 12),
    ad("x", null, 2),
  ] as never[];
  const groups = groupTracking(items);
  assert.deepEqual(groups.map((g) => g.ct), ["CT 01", "CT 06", "CT 10", "Sin CT"]);
  const ct6 = groups.find((g) => g.ct === "CT 06")!;
  assert.equal(ct6.ads.length, 1);
  assert.equal(ct6.summary?.dayN, 8);
  assert.equal(ct6.orphanBudgets.length, 0, "the raise is already shown on its ad");
  assert.deepEqual(ct6.latestRaise && [ct6.latestRaise.date, ct6.latestRaise.dayN], ["2026-10-26", 4]);
});

test("a raise no ad carries is kept as its own row, and CT 10 never absorbs CT 01's data", () => {
  const items = [
    { kind: "budget", id: "adset:s1:2026-10-27:13000", entityType: "adset", entityId: "s1", ct: "CT 01", label: "Set 1", dayN: 3, date: "2026-10-27", pct: 30 },
    ad("a1", "CT 01", 5),
    ad("a10", "CT 10", 5),
  ] as never[];
  const groups = groupTracking(items);
  assert.equal(groups.find((g) => g.ct === "CT 01")!.orphanBudgets.length, 1);
  assert.equal(groups.find((g) => g.ct === "CT 10")!.orphanBudgets.length, 0);
  assert.equal(groups.find((g) => g.ct === "CT 10")!.ads.length, 1);
});

test("ads are listed oldest first and ads in the test are counted", () => {
  const g = groupTracking([ad("b", "CT 02", 2), ad("a", "CT 02", 9), ad("c", "CT 02", 4)])[0];
  assert.deepEqual(g.ads.map((a) => a.id), ["a", "c", "b"]);
  assert.equal(g.inTest, 2);
});

test("formatVoucherPhone groups the digits and adds the country code", () => {
  assert.equal(formatVoucherPhone("573001234567"), "+57 300 123 4567");
  assert.equal(formatVoucherPhone("+57 300 123 4567"), "+57 300 123 4567");
  assert.equal(formatVoucherPhone("584141234567"), "+58 414 123 4567");
  assert.equal(formatVoucherPhone("3001234567"), "300 123 4567");
  assert.equal(formatVoucherPhone(""), "");
  assert.equal(formatVoucherPhone("sin número"), "");
});
