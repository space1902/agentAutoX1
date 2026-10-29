import { useCallback, useEffect, useState } from "react";
import { api, type Light, type LineHealth } from "../lib/api";
import { Tooltip } from "./Tooltip";

const LIGHT_LABEL: Record<Light, string> = { verde: "Línea sana", amarillo: "Atención", rojo: "En riesgo" };

/** Loads the traffic light and strength of every tester once; `reload` refreshes it. */
export function useLineHealth() {
  const [lines, setLines] = useState<Record<string, LineHealth>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLines((await api.lineHealth()).lines);
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : "No se pudo calcular la salud de las líneas.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { lines, error, reload };
}

/** Dot + score with a hover/focus tooltip that shows how the score is made up. */
export function HealthBadge({ health, compact = false }: { health: LineHealth | undefined; compact?: boolean }) {
  if (!health) return <span className="muted">–</span>;
  const label = LIGHT_LABEL[health.light];
  const body = (
    <div className="health-tip">
      <strong>
        {label} · fuerza {health.score}/100
      </strong>
      <small>
        Fase: {health.phase.name}
        {health.linked ? "" : " · sin vincular"}
      </small>
      <ul>
        {health.components.map((c) => (
          <li key={c.key}>
            <span>
              {c.label} <em>{c.points}/{c.max}</em>
            </span>
            <small>{c.detail}</small>
          </li>
        ))}
      </ul>
      {health.reasons.length > 0 && (
        <ul className="health-reasons">
          {health.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <Tooltip className={`health ${health.light}`} content={body} label={`${label}, fuerza ${health.score} de 100`}>
      <i className="health-dot" aria-hidden />
      <b>{health.score}</b>
      {!compact && <span className="health-label">{label}</span>}
    </Tooltip>
  );
}
