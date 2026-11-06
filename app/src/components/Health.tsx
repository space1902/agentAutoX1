import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorText, type Light, type LineHealth, type PauseInfo, type ScheduleState, type ScheduleStatus, type SessionSchedule } from "../lib/api";
import { Pill, type PillTone } from "./ui";
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

// ---- schedule: state, messages today / cap, Pausar and Reanudar ----

const STATE_LABEL: Record<ScheduleState, string> = {
  active: "Activa",
  outside_window: "Fuera de horario",
  capped: "Límite del día",
  paused: "Pausada",
};

const STATE_TONE: Record<ScheduleState, PillTone> = {
  active: "green",
  outside_window: "gray",
  capped: "amber",
  paused: "red",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const clockIn = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone });

/** Why a number is paused and until when, in plain Spanish. */
export function pauseText(pause: PauseInfo): string {
  const why =
    pause.reason === "logged_out"
      ? "WhatsApp cerró la sesión de este número y no se vincula solo. Para usarlo otra vez: mueve su carpeta de sesión (en .baileys_auth), vincúlalo de nuevo con un código y pulsa Reanudar."
      : pause.reason === "repeated_disconnects"
        ? "Se desconectó demasiadas veces seguidas."
        : "Pausa manual.";
  // A logout stays paused until the user acts; the other reasons say until when.
  if (pause.reason === "logged_out") return why;
  return `${why} ${pause.until ? `Hasta ${when(pause.until)}.` : "Hasta que la reanudes."}`;
}

/** One-line detail under the state: window, next opening or the pause reason. */
function stateDetail(s: SessionSchedule, live: boolean): string {
  if (s.state === "paused" && s.pause) return pauseText(s.pause);
  if (!live) return "No hay una ejecución en curso: esto es lo que haría ahora.";
  if (s.state === "outside_window" && s.nextOpenAt) return `Abre a las ${clockIn(s.nextOpenAt, s.timezone)}.`;
  if (s.state === "capped" && s.nextOpenAt) return `Vuelve mañana a las ${clockIn(s.nextOpenAt, s.timezone)}.`;
  if (s.window) return `Hoy hasta las ${clockIn(s.window.endAt, s.timezone)}${s.low ? " (día de poca actividad)" : ""}.`;
  return "";
}

/** Loads the schedule state of every number (state, messages today, cap, pause) and refreshes it every 30 s. */
export function useScheduleStatus() {
  const [status, setStatus] = useState<ScheduleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setStatus(await api.scheduleStatus());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 30_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  return { status, error, reload };
}

/** State, messages today / cap and Pausar / Reanudar for each number. */
export function ScheduleList({ ids, schedule, live }: { ids: string[]; schedule: ReturnType<typeof useScheduleStatus>; live: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const toggle = async (id: string, paused: boolean) => {
    setBusy(id);
    setProblem(null);
    try {
      if (paused) await api.testerResume(id);
      else await api.testerPause(id);
      await schedule.reload();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (!schedule.status) {
    return schedule.error ? <p className="muted sched-note">No se pudo leer el horario de los números: {schedule.error}</p> : null;
  }
  const rows = ids.flatMap((id) => {
    const s = schedule.status?.sessions[id];
    return s ? [{ id, s }] : [];
  });
  if (rows.length === 0) return null;

  return (
    <div className="sched">
      {problem && <p className="sched-note error">{problem}</p>}
      <ul className="sched-list" aria-label="Estado de cada número">
        {rows.map(({ id, s }) => {
          const paused = s.state === "paused";
          // Without a live run nobody is sending, so "Activa" would be a lie: show it as not running.
          const idle = !live && !paused;
          return (
            <li key={id} className="sched-row">
              <span className="sched-id">{id}</span>
              <Pill tone={idle ? "gray" : STATE_TONE[s.state]}>{idle ? "Sin ejecución" : STATE_LABEL[s.state]}</Pill>
              <span className="sched-count" title="Mensajes enviados hoy / tope del día">
                {s.count}/{s.cap ?? "–"} hoy
              </span>
              <span className="sched-detail muted">{stateDetail(s, live)}</span>
              <button
                className="btn sm ghost sched-btn"
                onClick={() => void toggle(id, paused)}
                disabled={busy === id}
                title={paused ? "Volver a meter este número en el ciclo" : "Sacar este número del ciclo hasta que lo reanudes"}
              >
                {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />} {paused ? "Reanudar" : "Pausar"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
