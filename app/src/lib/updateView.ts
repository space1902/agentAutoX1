export interface ApplyFlags {
  depsChanged: boolean;
  rustChanged: boolean;
}

/** Message shown after a successful update, depending on what the new commits touched. */
export function applyOutcome({ depsChanged, rustChanged }: ApplyFlags): { kind: "ok" | "warn"; text: string } {
  if (depsChanged) {
    return { kind: "warn", text: "Esta actualización trae dependencias nuevas: cierra la app y ejecuta actualizar.ps1" };
  }
  if (rustChanged) {
    return { kind: "ok", text: "La app se recompila y se vuelve a abrir sola en 1-2 minutos" };
  }
  return { kind: "ok", text: "Listo: la pantalla se recarga sola" };
}

export function checkSummary(behind: number): string {
  if (behind === 0) return "Estás al día";
  return behind === 1 ? "Hay 1 cambio nuevo" : `Hay ${behind} cambios nuevos`;
}
