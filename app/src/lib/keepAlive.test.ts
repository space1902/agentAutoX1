import assert from "node:assert/strict";
import { test } from "node:test";

import { KEEP_ALIVE_HOURS, intervalLabel, keepAliveHelp } from "./keepAlive.ts";

test("the selectable intervals are 4, 6, 8, 12, 24, 36, 48 and 72 hours", () => {
  assert.deepEqual([...KEEP_ALIVE_HOURS], [4, 6, 8, 12, 24, 36, 48, 72]);
  assert.equal(intervalLabel(72), "72 h");
  assert.equal(intervalLabel(6), "6 h");
});

test("the help text mentions the chosen interval", () => {
  assert.match(keepAliveHelp(8), /más de 8 horas/);
  assert.doesNotMatch(keepAliveHelp(8), /24 horas/);
});

test("the help recommends 24 h or less and warns that longer intervals pile up messages", () => {
  assert.match(keepAliveHelp(6), /24 h o menos/);
  assert.match(keepAliveHelp(6), /se acumulan más mensajes/);
});
