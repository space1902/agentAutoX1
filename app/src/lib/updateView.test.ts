import assert from "node:assert/strict";
import { test } from "node:test";

import { applyOutcome, checkSummary } from "./updateView.ts";

test("dependencies win over a Rust change", () => {
  const o = applyOutcome({ depsChanged: true, rustChanged: true });
  assert.equal(o.kind, "warn");
  assert.match(o.text, /actualizar\.ps1/);
});

test("a Rust change announces the automatic rebuild", () => {
  const o = applyOutcome({ depsChanged: false, rustChanged: true });
  assert.match(o.text, /1-2 minutos/);
});

test("a frontend-only update just reloads", () => {
  const o = applyOutcome({ depsChanged: false, rustChanged: false });
  assert.equal(o.kind, "ok");
  assert.match(o.text, /se recarga sola/);
});

test("check summary handles up to date, one and many changes", () => {
  assert.equal(checkSummary(0), "Estás al día");
  assert.equal(checkSummary(1), "Hay 1 cambio nuevo");
  assert.equal(checkSummary(5), "Hay 5 cambios nuevos");
});
