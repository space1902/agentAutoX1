import { listen } from "@tauri-apps/api/event";
import { Clock, Info, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorText, type KeepAliveStatus } from "../lib/api";
import { Tooltip } from "./Tooltip";
import { Card, Pill, type PillTone } from "./ui";

export const KEEP_ALIVE_HELP =
  "Evita que WhatsApp desvincule los dispositivos de los pods apagados: enciende, uno por uno, cada pod que lleve más de 24 horas apagado durante 15 minutos y luego lo apaga.";

/** Live status of the keep-alive scheduler (event stream + initial fetch). */
export function useKeepAlive() {
  const [status, setStatus] = useState<KeepAliveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.keepAliveStatus().then(setStatus).catch((e) => setError(errorText(e)));
    const un = listen<KeepAliveStatus>("keepalive-status", (e) => setStatus(e.payload));
    return () => void un.then((fn) => fn());
  }, []);

  const toggle = async (enabled: boolean) => {
    setError(null);
    try {
      setStatus(await api.setKeepAlive(enabled));
    } catch (e) {
      setError(errorText(e));
    }
  };

  return { status, error, toggle };
}

/** Sí/No switch with an info icon; the explanation shows on hover or keyboard focus. */
export function KeepAliveSwitch({ enabled, onChange }: { enabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="keepalive-switch">
      <span id="keepalive-label">Auto revisión de números en los pods</span>
      <Tooltip className="info" content={<p className="info-text">{KEEP_ALIVE_HELP}</p>} label="Qué hace la auto revisión" placement="bottom-end" width={280}>
        <Info size={15} aria-hidden />
      </Tooltip>
      <div className="seg yesno" role="switch" aria-checked={enabled} aria-labelledby="keepalive-label">
        <button className={enabled ? "on" : ""} onClick={() => onChange(true)}>
          Sí
        </button>
        <button className={!enabled ? "on" : ""} onClick={() => onChange(false)}>
          No
        </button>
      </div>
    </div>
  );
}

const PHASE_TONE: Record<KeepAliveStatus["phase"], PillTone> = {
  idle: "gray",
  scanning: "amber",
  "powering-on": "amber",
  holding: "green",
  "powering-off": "amber",
  "waiting-exit": "amber",
};

const OUTCOME: Record<NonNullable<KeepAliveStatus["lastRun"]>["outcome"], { label: string; tone: PillTone }> = {
  ok: { label: "Revisado", tone: "green" },
  skipped: { label: "Omitido", tone: "gray" },
  failed: { label: "Falló", tone: "red" },
  interrupted: { label: "Interrumpido", tone: "amber" },
};

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

const minutes = (secs: number) => {
  const m = Math.floor(Math.max(0, secs) / 60);
  const s = Math.max(0, secs) % 60;
  return m > 0 ? `${m} min ${String(s).padStart(2, "0")} s` : `${s} s`;
};

const when = (unix: number) => new Date(unix * 1000).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });

/** "Revisando wa-pod2: 7 min restantes", the queue and the last run. */
export function KeepAliveCard({ status }: { status: KeepAliveStatus }) {
  const now = useNow(status.holdUntil !== null);
  const remaining = status.holdUntil !== null ? status.holdUntil - now : null;
  if (!status.enabled && !status.lastRun) return null;

  return (
    <Card>
      <div className="card-head">
        <h2 className="card-title">Auto revisión de pods</h2>
        <Pill tone={status.enabled ? PHASE_TONE[status.phase] : "gray"}>{status.enabled ? (status.phase === "idle" ? "Activa" : "En curso") : "Desactivada"}</Pill>
      </div>
      <p className="keepalive-line">
        {status.current && status.phase !== "idle" ? (
          <>
            <RefreshCw size={14} className="spin" aria-hidden /> Revisando <strong>{status.current}</strong>
            {remaining !== null ? `: ${minutes(remaining)} restantes` : "…"}
          </>
        ) : (
          <>
            <Clock size={14} aria-hidden /> {status.message || "Sin revisiones pendientes."}
          </>
        )}
      </p>
      {status.queue.length > 0 && (
        <p className="muted">
          En cola ({status.queue.length}): {status.queue.join(", ")}
        </p>
      )}
      <dl className="meta">
        <dt>Última revisión</dt>
        <dd>
          {status.lastRun ? (
            <>
              {status.lastRun.pod} · {when(status.lastRun.at)} <Pill tone={OUTCOME[status.lastRun.outcome].tone}>{OUTCOME[status.lastRun.outcome].label}</Pill>
              <br />
              <span className="muted">{status.lastRun.note}</span>
            </>
          ) : (
            "–"
          )}
        </dd>
        <dt>Último escaneo</dt>
        <dd>{status.lastScanAt ? when(status.lastScanAt) : "–"}</dd>
      </dl>
    </Card>
  );
}
