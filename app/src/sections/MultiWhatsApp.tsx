import { listen } from "@tauri-apps/api/event";
import { AnimatePresence } from "framer-motion";
import { Check, Eye, Loader2, Pencil, Phone, Plus, Power, PowerOff, RefreshCw, RotateCcw, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import EmbeddedView from "../components/EmbeddedView";
import { KeepAliveCard, KeepAliveSwitch, useKeepAlive } from "../components/KeepAlive";
import { Modal, ProgressBar, Warning } from "../components/Modal";
import { Banner, Card, Notice, Pill, SkeletonGrid, StatCard } from "../components/ui";
import { api, errorText, type Pod, type RegistryRow } from "../lib/api";
import { POD_STEP_LABELS, type PodCreationState } from "../lib/podCreation";
import { phoneConflict, podNameProblem, podPhone } from "../lib/phone";

type Action = "prender" | "apagar" | "ver";

/** The base BlueStacks instance hosts the Root.vhd shared by every pod: it can never be deleted. */
const BASE_INSTANCE = "Rvc64";

interface Props {
  creation: {
    state: PodCreationState;
    start: (name: string, phone: string) => Promise<void>;
    reset: () => void;
  };
}

type Dialog = { kind: "create" } | { kind: "reset" } | { kind: "edit"; pod: Pod } | { kind: "delete"; pod: Pod } | null;

export default function MultiWhatsApp({ creation }: Props) {
  const [pods, setPods] = useState<Pod[] | null>(null);
  const [registry, setRegistry] = useState<RegistryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "<pod>:<action>"
  const [dialog, setDialog] = useState<Dialog>(creation.state.running || creation.state.result ? { kind: "create" } : null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPods(await api.listPods());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
    // Used only for "this number is already used" warnings; the page works without it.
    api.registryOverview().then((o) => setRegistry(o.data.rows)).catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const keepAlive = useKeepAlive();
  const creating = creation.state.running;
  const [resetting, setResetting] = useState<string | null>(null); // current step of "Reiniciar pods"
  const [embedKey, setEmbedKey] = useState(0); // bumped to rebuild the embedded view from scratch
  const locked = busy !== null || creating || resetting !== null;

  /**
   * "Reiniciar pods": cancels what the app started for pods, frees the lock, stops the auto-review run, releases the
   * embedded windows and restarts the pods that were on. Then ONLY this section is read again (no app reload).
   */
  const resetPods = async () => {
    setDialog(null);
    setResetting("Reiniciando pods…");
    setError(null);
    setInfo(null);
    const unlisten = listen<string>("pods-reset-progress", (e) => setResetting(e.payload));
    try {
      const report = await api.resetPods();
      if (report.failed.length > 0) setError(report.message);
      else setInfo(report.message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      void unlisten.then((fn) => fn());
      setResetting("Recargando la sección…");
      setEmbedKey((n) => n + 1);
      await Promise.all([load(), keepAlive.refresh()]);
      setResetting(null);
    }
  };

  const run = async (action: Action, name: string) => {
    setBusy(`${name}:${action}`);
    setError(null);
    setInfo(null);
    try {
      setInfo((await api.podAction(action, name)) || `Listo: ${action} ${name}.`);
      setPods(await api.listPods());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const running = pods?.filter((p) => p.state === "running").length ?? 0;
  const withPhone = pods?.filter((p) => p.phone).length ?? 0;

  return (
    <div className="page">
      <Banner
        title="MultiWhatsApp"
        subtitle="Tus pods de WhatsApp Business sobre BlueStacks: crea, edita, enciende, apaga o trae al frente cada uno."
      >
        <KeepAliveSwitch enabled={keepAlive.status?.enabled ?? false} onChange={(v) => void keepAlive.toggle(v)} />
        <button className="btn secondary" onClick={() => void load()} disabled={loading || locked}>
          <RefreshCw size={15} aria-hidden /> Actualizar lista
        </button>
        <button
          className="btn secondary"
          onClick={() => setDialog({ kind: "reset" })}
          disabled={resetting !== null}
          title="Úsalo si la sección se quedó trabada: cancela lo que esté en curso y reinicia los pods encendidos"
        >
          {resetting !== null ? <Loader2 size={15} className="spin" aria-hidden /> : <RotateCcw size={15} aria-hidden />}
          {resetting !== null ? "Reiniciando…" : "Reiniciar pods"}
        </button>
        <button className="btn" onClick={() => setDialog({ kind: "create" })} disabled={busy !== null}>
          {creating ? <Loader2 size={15} className="spin" aria-hidden /> : <Plus size={15} aria-hidden />}
          {creating ? "Creando pod…" : "Nuevo pod"}
        </button>
      </Banner>

      <section className="stats" aria-label="Resumen">
        <StatCard icon={Power} label="Pods activos" value={pods ? running : "–"} caption="encendidos ahora" />
        <StatCard icon={Smartphone} label="Pods totales" value={pods ? pods.length : "–"} caption="instancias wa-*" />
        <StatCard icon={Phone} label="Números asignados" value={pods ? withPhone : "–"} caption="con #wsp en pods-wsp.json" />
      </section>

      {resetting !== null && <Notice kind="ok">{resetting}</Notice>}
      {error && <Notice>{error}</Notice>}
      {info && <Notice kind="ok">{info}</Notice>}
      {busy && <Notice kind="ok">Ejecutando «{busy.replace(":", " ")}». Prender puede tardar hasta unos 4 minutos mientras arranca Android.</Notice>}
      {creating && <Notice kind="ok">Creando el pod «{creation.state.name}»: paso {creation.state.step} de {creation.state.total}. No cierres la app.</Notice>}

      {keepAlive.error && <Notice>{keepAlive.error}</Notice>}
      {keepAlive.status && <KeepAliveCard status={keepAlive.status} />}

      {loading && !pods ? (
        <SkeletonGrid />
      ) : (
        <div className="grid">
          {(pods ?? []).map((pod) => {
            const isOn = pod.state === "running";
            return (
              <Card key={pod.instanceId}>
                <div className="card-head">
                  <h2 className="card-title">{pod.name}</h2>
                  <Pill tone={isOn ? "green" : "gray"}>{isOn ? "Activo" : "Apagado"}</Pill>
                </div>
                <dl className="meta">
                  <dt>Teléfono</dt>
                  <dd>{pod.phone ?? "Sin asignar"}</dd>
                  <dt>Puerto adb</dt>
                  <dd>{pod.adbPort}</dd>
                  <dt>Serial</dt>
                  <dd>{pod.serial ?? "–"}</dd>
                  <dt>Instancia</dt>
                  <dd>{pod.instanceId}</dd>
                </dl>
                <div className="row-actions">
                  <button className="btn sm" disabled={locked || isOn} onClick={() => void run("prender", pod.name)}>
                    <Power size={14} aria-hidden /> Prender
                  </button>
                  <button className="btn sm ghost" disabled={locked || !isOn} onClick={() => void run("apagar", pod.name)}>
                    <PowerOff size={14} aria-hidden /> Apagar
                  </button>
                  <button className="btn sm ghost" disabled={locked} onClick={() => void run("ver", pod.name)}>
                    <Eye size={14} aria-hidden /> Ver
                  </button>
                  <button className="btn sm ghost" disabled={locked} onClick={() => setDialog({ kind: "edit", pod })}>
                    <Pencil size={14} aria-hidden /> Editar
                  </button>
                  <button
                    className="btn sm ghost"
                    disabled={locked || pod.instanceId === BASE_INSTANCE}
                    title={pod.instanceId === BASE_INSTANCE ? "Instancia base: aloja el disco compartido de todos los pods" : "Borrar el pod"}
                    onClick={() => setDialog({ kind: "delete", pod })}
                  >
                    <Trash2 size={14} aria-hidden /> Borrar
                  </button>
                </div>
              </Card>
            );
          })}
          {pods && pods.length === 0 && !error && <Card>No hay pods todavía. Crea el primero con «Nuevo pod».</Card>}
        </div>
      )}

      <EmbeddedView key={embedKey} pods={pods ?? []} suspended={dialog !== null} />

      <AnimatePresence>
        {dialog?.kind === "create" && (
          <CreatePodModal
            key="create"
            pods={pods ?? []}
            registry={registry}
            creation={creation}
            onClose={() => {
              creation.reset();
              setDialog(null);
            }}
            onDone={() => void load()}
          />
        )}
        {dialog?.kind === "reset" && <ResetPodsModal key="reset" running={pods?.filter((p) => p.state === "running").map((p) => p.name) ?? []} onClose={() => setDialog(null)} onConfirm={() => void resetPods()} />}
        {dialog?.kind === "edit" && (
          <EditPodModal
            key="edit"
            pod={dialog.pod}
            pods={pods ?? []}
            registry={registry}
            onClose={() => setDialog(null)}
            onSaved={(message) => {
              setDialog(null);
              setInfo(message);
              void load();
            }}
          />
        )}
        {dialog?.kind === "delete" && (
          <DeletePodModal
            key="delete"
            pod={dialog.pod}
            onClose={() => setDialog(null)}
            onDeleted={(message) => {
              setDialog(null);
              setInfo(message);
              void load();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ResetPodsModal({ running, onClose, onConfirm }: { running: string[]; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title="Reiniciar pods"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn danger" onClick={onConfirm}>
            <RotateCcw size={15} aria-hidden /> Reiniciar pods
          </button>
        </>
      }
    >
      <p>Esto cancela cualquier operación de pods que esté en curso (incluida la revisión automática), suelta las ventanas de los pods y vuelve a cargar solo esta sección.</p>
      {running.length > 0 ? (
        <Warning>
          Los pods encendidos ({running.join(", ")}) se apagarán y se volverán a encender uno por uno; puede tardar varios minutos. Los pods apagados se quedan apagados.
        </Warning>
      ) : (
        <p>Ahora no hay pods encendidos, así que no se encenderá ninguno.</p>
      )}
    </Modal>
  );
}

function CreatePodModal({
  pods,
  registry,
  creation,
  onClose,
  onDone,
}: {
  pods: Pod[];
  registry: RegistryRow[];
  creation: Props["creation"];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const state = creation.state;
  const started = state.running || state.result !== null;

  const nameError = name ? podNameProblem(name, pods.map((p) => p.name)) : null;
  const phoneResult = phone ? podPhone(phone) : null;
  const phoneError = phoneResult && "error" in phoneResult ? phoneResult.error : null;
  const conflict = phoneResult && "value" in phoneResult ? phoneConflict(registry, phone, null) : null;
  const valid = name !== "" && !nameError && phoneResult !== null && !phoneError;

  const submit = () => {
    if (!valid || !phoneResult || !("value" in phoneResult)) return;
    void creation.start(name, phoneResult.value).then(onDone);
  };

  return (
    <Modal
      title="Nuevo pod"
      wide
      locked={state.running}
      onClose={onClose}
      footer={
        started ? (
          <button className="btn" onClick={onClose} disabled={state.running}>
            {state.running ? "Creando…" : "Cerrar"}
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn" onClick={submit} disabled={!valid}>
              <Plus size={15} aria-hidden /> Crear pod
            </button>
          </>
        )
      }
    >
      {!started ? (
        <>
          <div className="field">
            <label htmlFor="pod-name">Nombre del pod</label>
            <input id="pod-name" className="input" value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="bebidas1" maxLength={24} autoFocus />
            <small>Letras, números, guion y guion bajo (máximo 24). Aparecerá en BlueStacks como «wa-{name || "nombre"}».</small>
            {nameError && <span className="field-error">{nameError}</span>}
          </div>
          <div className="field">
            <label htmlFor="pod-phone">Número de WhatsApp</label>
            <input id="pod-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="304 237 4349" inputMode="tel" />
            <small>Se guarda solo como etiqueta del pod (10 dígitos, sin el 57). El registro en WhatsApp lo haces tú en la ventana del pod.</small>
            {phoneError && <span className="field-error">{phoneError}</span>}
          </div>
          {conflict && <Warning>{conflict} Puedes continuar, pero dos pods o testers con el mismo número se estorban.</Warning>}
          <Warning>
            Crear un pod tarda unos 12 a 15 minutos y tiene 9 pasos. BlueStacks puede cerrarse y volver a abrirse durante el proceso (los pods
            encendidos se reabren solos). No apagues el equipo ni cierres la app mientras tanto.
          </Warning>
        </>
      ) : (
        <CreationProgress state={state} />
      )}
    </Modal>
  );
}

function CreationProgress({ state }: { state: PodCreationState }) {
  const done = state.result?.ok ? state.total : Math.max(0, state.step - 1);
  return (
    <>
      <div className="card-head">
        <strong>«{state.name}»</strong>
        {state.running ? <Pill tone="amber">En curso</Pill> : state.result?.ok ? <Pill tone="green">Listo</Pill> : <Pill tone="red">Falló</Pill>}
      </div>
      <ProgressBar value={done / state.total} />
      <ol className="step-list" aria-label="Pasos de la creación">
        {Array.from({ length: state.total }, (_, i) => i + 1).map((n) => {
          const status = n <= done ? "done" : n === state.step && state.running ? "current" : "pending";
          return (
            <li key={n} className={status}>
              <span className="step-dot">{status === "done" ? <Check size={12} aria-hidden /> : status === "current" ? <Loader2 size={12} className="spin" aria-hidden /> : n}</span>
              {state.labels[n] || POD_STEP_LABELS[n - 1] || `Paso ${n}`}
            </li>
          );
        })}
      </ol>
      {state.result && <Notice kind={state.result.ok ? "ok" : "error"}>{state.result.message}</Notice>}
      {state.lines.length > 0 && (
        <div className="log-small" aria-label="Salida del script">
          {state.lines.slice(-6).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </>
  );
}

function EditPodModal({
  pod,
  pods,
  registry,
  onClose,
  onSaved,
}: {
  pod: Pod;
  pods: Pod[];
  registry: RegistryRow[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(pod.name);
  const [phone, setPhone] = useState(pod.phone ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const renamed = name !== pod.name;
  const nameError = renamed ? podNameProblem(name, pods.filter((p) => p.instanceId !== pod.instanceId).map((p) => p.name)) : null;
  const phoneResult = phone.trim() ? podPhone(phone) : null; // blank removes the number
  const phoneError = phoneResult && "error" in phoneResult ? phoneResult.error : null;
  const newPhone = phoneResult && "value" in phoneResult ? phoneResult.value : "";
  const phoneChanged = newPhone !== (pod.phone ?? "");
  const conflict = newPhone ? phoneConflict(registry, newPhone, pod.instanceId) : null;
  const changed = renamed || phoneChanged;

  const save = async () => {
    setSaving(true);
    setError(null);
    const messages: string[] = [];
    try {
      if (renamed) messages.push((await api.renamePod(pod.name, name)) || `Pod renombrado a «${name}».`);
      if (phoneChanged) messages.push((await api.setPodPhone(renamed ? name : pod.name, newPhone)) || "Número guardado.");
      onSaved(messages.join(" "));
    } catch (e) {
      const partial = messages.length ? `Se guardó una parte (${messages.join(" ")}). ` : "";
      setError(`${partial}${errorText(e)}`);
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Editar «${pod.name}»`}
      locked={saving}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button className="btn" onClick={() => void save()} disabled={saving || !changed || !!nameError || !!phoneError || name === ""}>
            {saving ? <Loader2 size={15} className="spin" aria-hidden /> : <Check size={15} aria-hidden />} {saving ? "Guardando…" : "Guardar cambios"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="edit-name">Nombre del pod</label>
        <input id="edit-name" className="input" value={name} onChange={(e) => setName(e.target.value.trim())} maxLength={24} />
        {nameError && <span className="field-error">{nameError}</span>}
      </div>
      <div className="field">
        <label htmlFor="edit-phone">Número de WhatsApp</label>
        <input id="edit-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Vacío para quitar el número" inputMode="tel" />
        <small>Solo cambia la etiqueta del pod; la cuenta de WhatsApp dentro del pod no se toca.</small>
        {phoneError && <span className="field-error">{phoneError}</span>}
      </div>
      {conflict && <Warning>{conflict} Puedes guardarlo, pero conviene que cada número tenga un solo dueño.</Warning>}
      {renamed && (
        <Warning>
          Renombrar cierra BlueStacks un momento y vuelve a abrir los pods que estaban encendidos. La cuenta de WhatsApp no se toca.
        </Warning>
      )}
      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}

function DeletePodModal({ pod, onClose, onDeleted }: { pod: Pod; onClose: () => void; onDeleted: (message: string) => void }) {
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      onDeleted((await api.deletePod(pod.name, typed)) || `Pod «${pod.name}» borrado.`);
    } catch (e) {
      setError(errorText(e));
      setDeleting(false);
    }
  };

  return (
    <Modal
      title={`Borrar «${pod.name}»`}
      locked={deleting}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={deleting}>
            Cancelar
          </button>
          <button className="btn danger" onClick={() => void remove()} disabled={deleting || typed !== pod.name}>
            {deleting ? <Loader2 size={15} className="spin" aria-hidden /> : <Trash2 size={15} aria-hidden />} {deleting ? "Borrando…" : "Borrar pod"}
          </button>
        </>
      }
    >
      <Warning>
        Esto borra el pod y la cuenta de WhatsApp que tenga dentro. No se puede deshacer. BlueStacks se cierra un momento y los demás pods
        encendidos se reabren.
      </Warning>
      <div className="field">
        <label htmlFor="del-name">Escribe «{pod.name}» para confirmar</label>
        <input id="del-name" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
      </div>
      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}
