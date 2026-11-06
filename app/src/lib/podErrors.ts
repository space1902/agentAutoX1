/** Stable marker `pods.ps1` puts in the error when WhatsApp Business is not installed in a pod (never match prose). */
export const WA_MISSING_MARKER = "[WA_FALTA]";

export interface PodError {
  /** Message to show: one clear line, without PowerShell position/stack noise. */
  message: string;
  /** WhatsApp Business is missing from the pod: offer "Reparar WhatsApp". */
  waMissing: boolean;
}

const NOISE = /^(at\s+\S.*:\d+\s+char:\d+|\+\s|\s*\+\s*(categoryinfo|fullyqualifiederrorid)\b|categoryinfo\b|fullyqualifiederrorid\b)/i;

/** Cleans an error coming from a pod action and detects the WhatsApp-missing case by marker. */
export function parsePodError(raw: string): PodError {
  const text = raw.trim();
  const at = text.indexOf(WA_MISSING_MARKER);
  if (at >= 0) {
    return { message: text.slice(at + WA_MISSING_MARKER.length).trim(), waMissing: true };
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l))
    .map((l) => l.replace(/^[A-Za-z]:\\[^:]*\.ps1\s*:\s*/, ""));
  return { message: lines.join(" ").trim() || text, waMissing: false };
}
