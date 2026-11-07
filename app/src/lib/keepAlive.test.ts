import assert from "node:assert/strict";
import { test } from "node:test";

import { KEEP_ALIVE_HOURS, intervalLabel, keepAliveHelp } from "./keepAlive.ts";

test("the selectable intervals are 4, 6, 8, 12 and 24 hours", () => {
  assert.deepEqual([...KEEP_ALIVE_HOURS], [4, 6, 8, 12, 24]);
  assert.equal(intervalLabel(6), "6 h");
});

test("the help text mentions the chosen interval", () => {
  assert.match(keepAliveHelp(8), /más de 8 horas/);
  assert.doesNotMatch(keepAliveHelp(8), /24 horas/);
});
