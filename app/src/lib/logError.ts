// Reports UI errors to the application log (<data dir>/logs/app.log). Never throws: logging must not cause errors.
import { invoke } from "@tauri-apps/api/core";

export function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack };
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

export function logClientError(kind: string, error: unknown, where?: string): void {
  const { message, stack } = describeError(error);
  const text = where ? `${where}: ${message}` : message;
  try {
    void invoke("log_client_error", { kind, message: text, stack: stack ?? null }).catch(() => undefined);
  } catch {
    /* not running inside Tauri (tests, plain browser) */
  }
}

/** Window-level handlers for errors no component caught. */
export function installGlobalErrorLogging(): void {
  window.addEventListener("error", (e) => logClientError("window", e.error ?? e.message, "error"));
  window.addEventListener("unhandledrejection", (e) => logClientError("promise", e.reason, "unhandledrejection"));
}
