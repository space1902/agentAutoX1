import assert from "node:assert/strict";
import { test } from "node:test";

import { WA_MISSING_MARKER, parsePodError } from "./podErrors.ts";

test("a WhatsApp-missing error is detected by its marker and the marker is hidden", () => {
  const r = parsePodError(`${WA_MISSING_MARKER} WhatsApp se perdió en este pod. Repáralo.`);
  assert.equal(r.waMissing, true);
  assert.equal(r.message, "WhatsApp se perdió en este pod. Repáralo.");
});

test("free-form prose without the marker is never treated as WhatsApp missing", () => {
  const r = parsePodError("WhatsApp Business no está instalado en el pod 'x'.");
  assert.equal(r.waMissing, false);
});

test("PowerShell stack noise is stripped from other errors", () => {
  const raw = [
    "C:\\x\\pods.ps1 : El pod 'a' está apagado.",
    "At C:\\x\\pods.ps1:828 char:5",
    "+     throw \"x\"",
    "    + CategoryInfo          : OperationStopped: (:) [], RuntimeException",
    "    + FullyQualifiedErrorId : El pod 'a' está apagado.",
  ].join("\n");
  assert.equal(parsePodError(raw).message, "El pod 'a' está apagado.");
});

test("plain messages pass through untouched", () => {
  assert.equal(parsePodError("Hay una operación de pods en curso (crear x).").message, "Hay una operación de pods en curso (crear x).");
});
