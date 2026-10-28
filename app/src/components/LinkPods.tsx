import { listen } from "@tauri-apps/api/event";
import { Check, Link2, Loader2, Play, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorText, type LinkProgress, type LinkResult, type LinkStage, type LinkTarget } from "../lib/api";
import { Modal, Warning } from "./Modal";
import { Notice, Pill, type PillTone } from "./ui";

const STAGE_LABEL: Record<LinkStage, string> = {
  queued: "En cola",
  "powering-on": "Encendiendo el pod",
  "waiting-android": "Esperando a Android y WhatsApp Business",
  "requesting-code": "Pidiendo el código",
  "typing-code": "Escribiendo el código en el pod",
  "waiting-link": "Esperando la confirmación",
  linked: "Vinculado",
  "powering-off": "Apagando el pod",
  manual: "Termina a mano",
  failed: "Falló",
  cancelled: "Cancelado",
  "dry-run": "Simulación",
};

const STAGE_TONE: Record<LinkStage, PillTone> = {
  queued: "gray",
  "powering-on": "amber",
  "waiting-android": "amber",
  "requesting-code": "amber",
  "typing-code": "amber",
  "waiting-link": "amber",
  linked: "green",
  "powering-off": "amber",
  manual: "red",
  failed: "red",
  cancelled: "gray",
  "dry-run": "green",
};

interface Props {
  profile: string;
  targets: LinkTarget[];
  /** Called after the user chose to start the profile (all linked, or "start anyway"). */
  onStart: () => void;
  onClose: () => void;
}

/** Links the unlinked pod numbers of a profile one at a time, then offers to start the profile. */
export default function LinkPodsModal({ profile, targets, onStart, onClose }: Props) {
  const [rows, setRows] = useState<Record<string, LinkProgress>>({});
  const [results, setResults] = useState<LinkResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [powerOff, setPowerOff] = useState(true);

  useEffect(() => {
    const un = listen<LinkProgress>("pod-link-progress", (e) => setRows((prev) => ({ ...prev, [e.payload.testerId]: e.payload })));
    return () => void un.then((fn) => fn());
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResults(null);
    setRows({});
    try {
      const out = await api.runPodLinks(profile, dryRun, powerOff);
      setResults(out);
      if (!dryRun && out.every((r) => r.ok)) onStart();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  const failed = results?.filter((r) => !r.ok && r.stage !== "dry-run") ?? [];
  const started = running || results !== null;
  // The code of the row waiting for a manual finish (or being typed) is shown big, as a fallback.
  const bigCode = Object.values(rows).find((r) => r.code && (r.stage === "manual" || r.stage === "typing-code" || r.stage === "waiting-link"));

  return (
    <Modal
      title={`Vincular pods de «${profile}»`}
      wide
      locked={running}
      onClose={onClose}
      footer={
        running ? (
          <button className="btn danger" onClick={() => void api.cancelPodLinks()}>
            <X size={15} aria-hidden /> Cancelar tras este paso
          </button>
        ) : results === null ? (
          <>
            <button className="btn ghost" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn" onClick={() => void run()}>
              <Link2 size={15} aria-hidden /> {dryRun ? "Simular" : "Vincular e iniciar"}
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose}>
              Cerrar
            </button>
            {failed.length > 0 && (
              <button className="btn secondary" onClick={() => void run()}>
                Reintentar
              </button>
            )}
            {!dryRun && failed.length > 0 && (
              <button className="btn" onClick={onStart} title="Los números sin vincular mostrarán su código en el registro del perfil">
                <Play size={14} aria-hidden /> Iniciar de todos modos
              </button>
            )}
          </>
        )
      }
    >
      {!started && (
        <>
          <p>
            Estos números están en un pod y todavía no están vinculados al calentador. Se vinculan <strong>de uno en uno</strong>: se enciende el pod (si está
            apagado), se pide un código a WhatsApp y se escribe dentro de WhatsApp Business.
          </p>
          <Warning>
            No uses ni cierres la ventana de estos pods mientras se vinculan. Los pods que ya estén vinculados no se tocan y no hace falta que estén encendidos.
          </Warning>
          <label className="check">
            <input type="checkbox" checked={powerOff} onChange={(e) => setPowerOff(e.target.checked)} /> Apagar de nuevo los pods que estaban apagados
          </label>
          <label className="check">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Solo simular (no enciende nada ni escribe en el pod)
          </label>
        </>
      )}

      <ol className="link-list" aria-label="Números a vincular">
        {targets.map((t) => {
          const row = rows[t.testerId];
          const result = results?.find((r) => r.testerId === t.testerId);
          const stage: LinkStage = result?.stage ?? row?.stage ?? "queued";
          const message = result?.message ?? row?.message ?? "";
          return (
            <li key={t.testerId} className={`link-row ${stage}`}>
              <div className="link-head">
                <span className="link-icon">
                  {stage === "linked" ? <Check size={14} aria-hidden /> : running && row && stage !== "failed" && stage !== "queued" ? <Loader2 size={14} className="spin" aria-hidden /> : <Link2 size={14} aria-hidden />}
                </span>
                <strong>{t.phone}</strong>
                <span className="muted">
                  {t.podName} · {t.testerId}
                </span>
                <Pill tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</Pill>
              </div>
              {message && stage !== "queued" && <p className="link-msg">{message}</p>}
            </li>
          );
        })}
      </ol>

      {bigCode?.code && (
        <div className="big-code" role="status" aria-live="polite">
          <span>Código para {bigCode.phone}</span>
          <strong>{bigCode.code}</strong>
          <small>
            {bigCode.stage === "manual"
              ? "Escríbelo tú en WhatsApp Business del pod: Menú ⋮ > Dispositivos vinculados > Vincular un dispositivo > Vincular con el número de teléfono."
              : "Se está escribiendo solo; este es el código por si necesitas escribirlo a mano."}
          </small>
        </div>
      )}

      {results && failed.length === 0 && !dryRun && <Notice kind="ok">Todos los números quedaron vinculados. Iniciando el perfil…</Notice>}
      {results && dryRun && <Notice kind="ok">Simulación terminada: no se encendió ni se escribió nada en ningún pod.</Notice>}
      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}
