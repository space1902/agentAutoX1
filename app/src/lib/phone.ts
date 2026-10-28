// Phone and pod-name helpers. They mirror the rules of the engines (registry.js phoneKey, pods.ps1 Test-NombrePod)
// only to give instant feedback in forms; the engines remain the source of truth and re-validate everything.
import type { RegistryRow } from "./api";

/** 57XXXXXXXXXX and XXXXXXXXXX are the same line: compare numbers by this key. */
export function phoneKey(input: string | null | undefined): string {
  const digits = (input ?? "").replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("57") ? digits.slice(2) : digits;
}

/** Number as pods-wsp.json stores it (digits, 10 for Colombian lines) or an error in Spanish. */
export function podPhone(input: string): { value: string } | { error: string } {
  const key = phoneKey(input);
  if (key.length >= 7 && key.length <= 15) return { value: key };
  return { error: "El número debe tener entre 7 y 15 dígitos (para Colombia, 10 dígitos que empiecen por 3)." };
}

export const POD_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,23}$/;

export function podNameProblem(name: string, taken: string[]): string | null {
  if (!POD_NAME_RE.test(name)) {
    return "Usa solo letras, números, guion y guion bajo (máximo 24 caracteres, sin empezar por símbolo).";
  }
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) return `Ya existe un pod llamado «${name}».`;
  return null;
}

/** Warning text when `phone` is already used by another pod (or, without a pod, by a warm-up tester). */
export function phoneConflict(rows: RegistryRow[], phone: string, ownInstanceId: string | null): string | null {
  const key = phoneKey(phone);
  if (!key) return null;
  const row = rows.find((r) => r.key === key);
  if (!row) return null;
  if (row.pod && row.pod.instanceId !== ownInstanceId) return `Ese número ya está asignado al pod «${row.pod.name}».`;
  if (row.isBot) return "Ese es el número del bot principal.";
  if (!row.pod && row.testerId) {
    const used = row.profiles.length ? ` (perfiles: ${row.profiles.join(", ")})` : "";
    return `Ese número ya lo usa un tester del calentador: ${row.testerId}${used}.`;
  }
  return null;
}
