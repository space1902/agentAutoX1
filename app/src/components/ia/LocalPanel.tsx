import { AnimatePresence } from "framer-motion";
import { Check, Download, Play, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { formatBytes, isValidModelTag, type AiConfig, type InstallEvent, type InstalledModel, type LocalDetect, type PullEvent } from "../../lib/aiApi";
import { Modal, ProgressBar, Warning } from "../Modal";
import { Pill } from "../ui";

interface Props {
  detect: LocalDetect | null;
  config: AiConfig | null;
  ollamaInstalled: boolean;
  warmupRunning: boolean;
  pull: PullEvent | null;
  install: InstallEvent | null;
  busy: boolean;
  onUse: (config: AiConfig) => void;
  onTest: (config: AiConfig) => void;
  onDelete: (model: string) => Promise<void>;
  onPull: (tag: string) => void;
  onCancelPull: () => void;
  onInstall: () => void;
  onLaunch: () => void;
  onRescan: (extraUrl: string) => void;
}

function whenText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" });
}

export default function LocalPanel(p: Props) {
  const [tag, setTag] = useState("");
  const [extraUrl, setExtraUrl] = useState("");
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [toDelete, setToDelete] = useState<InstalledModel | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const ollama = p.detect?.ollama ?? null;
  const baseUrl = ollama?.baseUrl;
  const others = (p.detect?.servers ?? []).filter((s) => s.id !== "ollama");
  const pulling = p.pull?.type === "progress";
  const tagOk = isValidModelTag(tag);
  const gpuMode: "auto" | "cpu" = p.detect?.gpu.hasDedicated === false ? "cpu" : "auto";
  const selected = p.config?.provider === "ollama" ? p.config.model : undefined;
  const installing = p.install !== null && !p.install.done;

  const ollamaConfig = (model: string): AiConfig => ({
    ...(p.config ?? {}),
    provider: "ollama",
    preset: undefined,
    model,
    baseUrl,
    localGpu: gpuMode,
    prices: undefined,
    extraBody: undefined,
  });

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleteError(null);
    try {
      await p.onDelete(toDelete.name);
      setToDelete(null);
    } catch (e) {
      setDeleteError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="ia-stack">
      {!ollama && (
        <div className="ia-empty">
          <strong>No encuentro Ollama en este equipo.</strong>
          <span className="muted">
            {p.ollamaInstalled
              ? "Está instalado pero no está abierto. Ábrelo para ver tus modelos."
              : "Ollama corre los modelos en tu propio computador, sin costo por mensaje."}
          </span>
          <div className="row-actions">
            {p.ollamaInstalled ? (
              <button className="btn sm" onClick={p.onLaunch}>
                <Play size={14} aria-hidden /> Abrir Ollama
              </button>
            ) : (
              <button className="btn sm" disabled={installing} onClick={() => setConfirmInstall(true)}>
                <Download size={14} aria-hidden /> Instalar Ollama
              </button>
            )}
            <button className="btn sm ghost" onClick={() => p.onRescan(extraUrl)}>
              <RefreshCw size={14} aria-hidden /> Buscar de nuevo
            </button>
          </div>
          {p.install && (
            <div className={`ia-install ${p.install.done && !p.install.ok ? "bad" : ""}`} role="status">
              {p.install.message}
            </div>
          )}
        </div>
      )}

      {ollama && (
        <section>
          <h3 className="ia-sub">Modelos instalados en Ollama {ollama.version && <span className="muted">v{ollama.version}</span>}</h3>
          {ollama.installedModels.length === 0 && <span className="muted">Aún no tienes modelos. Descarga uno de los recomendados.</span>}
          <ul className="ia-list">
            {ollama.installedModels.map((m) => {
              const chosen = selected === m.name;
              const blocked = m.inUse && p.warmupRunning;
              return (
                <li key={m.name} className={`ia-row ${chosen ? "chosen" : ""}`}>
                  <div className="ia-row-main">
                    <strong>{m.name}</strong>
                    <span className="muted">
                      {formatBytes(m.sizeBytes)}
                      {m.parameterSize && ` · ${m.parameterSize}`}
                      {m.quantization && ` · ${m.quantization}`}
                      {m.modified && ` · ${whenText(m.modified)}`}
                    </span>
                  </div>
                  <div className="ia-row-tags">
                    {chosen ? <Pill tone="green">En uso</Pill> : m.inUse ? <Pill tone="amber">Reserva</Pill> : null}
                    <Pill tone={m.fit.fits ? "green" : "amber"}>{m.fit.text}</Pill>
                  </div>
                  <div className="row-actions">
                    <button className="btn sm" disabled={chosen || p.busy} onClick={() => p.onUse(ollamaConfig(m.name))}>
                      <Check size={14} aria-hidden /> Usar
                    </button>
                    <button className="btn sm secondary" disabled={p.busy} onClick={() => p.onTest(ollamaConfig(m.name))}>
                      Probar velocidad
                    </button>
                    <button
                      className="btn sm danger"
                      disabled={blocked}
                      title={blocked ? "Lo usa el perfil en curso: deténlo para eliminarlo." : undefined}
                      onClick={() => {
                        setDeleteError(null);
                        setToDelete(m);
                      }}
                    >
                      <Trash2 size={14} aria-hidden /> Eliminar
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {ollama && (
        <section>
          <h3 className="ia-sub">Descargar un modelo</h3>
          {p.detect && !p.detect.gpu.hasDedicated && (
            <span className="muted">Sin tarjeta de video te conviene {p.detect.suggestedForCpu.join(" o ")}.</span>
          )}
          <ul className="ia-list">
            {(p.detect?.recommended ?? []).map((m) => (
              <li key={m.id} className="ia-row">
                <div className="ia-row-main">
                  <strong>{m.label}</strong> <span className="muted">({m.id})</span>
                  <span className="muted">
                    {m.sizeGb} GB · {m.note} · necesita {m.memoryNeed}
                  </span>
                </div>
                <div className="ia-row-tags">
                  <Pill tone={m.fit.fits ? "green" : "amber"}>{m.fit.text}</Pill>
                  {m.installed && <Pill tone="gray">Instalado</Pill>}
                </div>
                <div className="row-actions">
                  <button className="btn sm" disabled={m.installed || pulling} onClick={() => p.onPull(m.id)}>
                    <Download size={14} aria-hidden /> Descargar
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="ia-inline">
            <input
              className="input"
              placeholder="Otra etiqueta, por ejemplo llama3.1:8b"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              aria-label="Etiqueta del modelo a descargar"
            />
            <button className="btn sm" disabled={!tagOk || pulling} onClick={() => p.onPull(tag.trim())}>
              <Download size={14} aria-hidden /> Descargar
            </button>
          </div>
          {tag.trim() !== "" && !tagOk && <span className="field-error">Etiqueta no válida. Usa el formato nombre:tamaño, por ejemplo gemma3:4b.</span>}
          {p.pull && (
            <div className="ia-pull" role="status">
              <div className="ia-pull-head">
                <span>
                  {p.pull.type === "progress" && `Descargando ${p.pull.model}… ${p.pull.percent ?? 0}% ${p.pull.status ? `(${p.pull.status})` : ""}`}
                  {p.pull.type === "done" && `${p.pull.model} descargado.`}
                  {p.pull.type === "cancelled" && `Descarga de ${p.pull.model} cancelada.`}
                  {p.pull.type === "error" && `No se pudo descargar ${p.pull.model}: ${p.pull.error ?? "error"}`}
                </span>
                {pulling && (
                  <button className="btn sm ghost" onClick={p.onCancelPull}>
                    <X size={14} aria-hidden /> Cancelar
                  </button>
                )}
              </div>
              {pulling && <ProgressBar value={(p.pull.percent ?? 0) / 100} />}
            </div>
          )}
        </section>
      )}

      <section>
        <h3 className="ia-sub">Otros servidores locales</h3>
        {others.length === 0 && <span className="muted">No detecté LM Studio, llama.cpp, Jan, LocalAI ni vLLM. Puedes indicar una URL.</span>}
        <ul className="ia-list">
          {others.map((s) => (
            <li key={s.id} className="ia-row">
              <div className="ia-row-main">
                <strong>{s.name}</strong> <span className="muted">{s.baseUrl}</span>
                <span className="muted">{s.models.length === 0 ? "Sin modelos cargados" : s.models.join(", ")}</span>
              </div>
              <div className="row-actions">
                {s.models.map((model) => {
                  const chosen = p.config?.preset === "local-openai" && p.config.model === model && p.config.baseUrl === s.baseUrl;
                  return (
                    <button
                      key={model}
                      className="btn sm"
                      disabled={chosen || p.busy}
                      onClick={() => p.onUse({ ...(p.config ?? {}), provider: "openai-compatible", preset: "local-openai", baseUrl: s.baseUrl, model, prices: { inUsd: 0, outUsd: 0 } })}
                    >
                      {chosen ? <Check size={14} aria-hidden /> : null} Usar {model}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
        <div className="ia-inline">
          <input className="input" placeholder="URL de otro servidor (http://…)" value={extraUrl} onChange={(e) => setExtraUrl(e.target.value)} aria-label="URL de otro servidor local" />
          <button className="btn sm secondary" onClick={() => p.onRescan(extraUrl)}>
            <RefreshCw size={14} aria-hidden /> Buscar
          </button>
        </div>
      </section>

      <AnimatePresence>
        {confirmInstall && (
          <Modal
            title="Instalar Ollama"
            onClose={() => setConfirmInstall(false)}
            footer={
              <>
                <button className="btn ghost" onClick={() => setConfirmInstall(false)}>
                  Cancelar
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setConfirmInstall(false);
                    p.onInstall();
                  }}
                >
                  Instalar
                </button>
              </>
            }
          >
            <p>
              Voy a instalar Ollama con winget (si no está disponible, descargo el instalador oficial de ollama.com). Ocupa unos 2 GB y no borra nada de lo que ya tienes.
            </p>
          </Modal>
        )}
        {toDelete && (
          <Modal
            title={`Eliminar ${toDelete.name}`}
            onClose={() => setToDelete(null)}
            footer={
              <>
                <button className="btn ghost" onClick={() => setToDelete(null)}>
                  Cancelar
                </button>
                <button className="btn danger" onClick={() => void confirmDelete()}>
                  <Trash2 size={14} aria-hidden /> Eliminar
                </button>
              </>
            }
          >
            <p>
              Se borra el modelo del disco ({formatBytes(toDelete.sizeBytes)}). Para volver a usarlo tendrás que descargarlo otra vez.
            </p>
            {toDelete.inUse && <Warning>Es el modelo configurado actualmente. Elige otro en «Usar» después de eliminarlo.</Warning>}
            {deleteError && <span className="field-error">{deleteError}</span>}
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}
