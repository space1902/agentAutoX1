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

/** "3XX XXX XXXX" for Colombian lines (10 digits or 57 + 10); any other number is returned as typed. */
export function formatPhone(phone: string | null | undefined): string {
  const key = phoneKey(phone);
  if (key.length === 10 && key.startsWith("3")) return `${key.slice(0, 3)} ${key.slice(3, 6)} ${key.slice(6)}`;
  return phone ?? "";
}

const memberName = (id: string) => (id === "bot" ? "el bot principal" : id);

/** Tooltip for a number that other testers (or the bot) also use. */
export function duplicateText(others: string[]): string {
  return `Mismo número que ${others.map(memberName).join(", ")}`;
}

/** Tooltip for a tester whose configured phone differs from the one of its linked session. */
export function mismatchText(configPhone: string | null, sessionPhone: string | null): string {
  return `El número configurado (${formatPhone(configPhone)}) no coincide con el de la sesión vinculada (${formatPhone(sessionPhone)}).`;
}

/** Label of a tester pill: `tester16 · pod2 · 304 233 9130`; "Externo" when the number has a phone but no pod. */
export function testerPillLabel(t: { id: string; phone: string | null; podName: string | null }): string {
  const parts = [t.id];
  if (t.podName) parts.push(t.podName);
  if (t.phone) {
    parts.push(formatPhone(t.phone));
    if (!t.podName) parts.push("Externo");
  } else {
    parts.push("sin número");
  }
  return parts.join(" · ");
}
