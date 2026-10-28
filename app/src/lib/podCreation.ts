import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, type PodProgress } from "./api";

/** The nine steps `pods.ps1 nuevo` prints; used until the real text of each step arrives. */
export const POD_STEP_LABELS = [
  "Comprobando requisitos",
  "Creando la instancia de BlueStacks",
  "Primer arranque",
  "Instalando WhatsApp Business",
  "Compilando WhatsApp",
  "Deshabilitando apps innecesarias",
  "Bajando a los recursos finales",
  "Reiniciando el pod",
  "Abriendo WhatsApp Business",
];

export interface PodCreationState {
  running: boolean;
  name: string | null;
  /** Last step announced by the script (1-based), 0 before the first one. */
  step: number;
  total: number;
  labels: Record<number, string>;
  lines: string[];
  result: { ok: boolean; message: string } | null;
}

const IDLE: PodCreationState = { running: false, name: null, step: 0, total: 9, labels: {}, lines: [], result: null };
const MAX_LINES = 200;

/** Creation state lives at the app root so progress survives switching sections. */
export function usePodCreation(onFinished: () => void) {
  const [state, setState] = useState<PodCreationState>(IDLE);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    const un = listen<PodProgress>("pod-create-progress", (e) => {
      const p = e.payload;
      setState((prev) => ({
        ...prev,
        step: p.step ?? prev.step,
        total: p.total ?? prev.total,
        labels: p.step ? { ...prev.labels, [p.step]: p.text } : prev.labels,
        lines: p.line.trim() ? [...prev.lines.slice(-(MAX_LINES - 1)), p.line] : prev.lines,
      }));
    });
    return () => void un.then((fn) => fn());
  }, []);

  const start = useCallback(async (name: string, phone: string) => {
    setState({ ...IDLE, running: true, name });
    try {
      const message = await api.createPod(name, phone);
      setState((prev) => ({ ...prev, running: false, step: prev.total, result: { ok: true, message } }));
    } catch (e) {
      setState((prev) => ({ ...prev, running: false, result: { ok: false, message: errorText(e) } }));
    } finally {
      finished.current();
    }
  }, []);

  const reset = useCallback(() => setState(IDLE), []);
  return { state, start, reset };
}
