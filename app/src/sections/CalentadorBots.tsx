import { AnimatePresence } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Flame, Link2, Loader2, MessagesSquare, Pencil, Play, Plus, RefreshCw, Square, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Warning } from "../components/Modal";
import NumberPicker, { buildItems, initialSelection, toSelections } from "../components/NumberPicker";
import { Banner, Card, Notice, Pill, SkeletonGrid, StatCard } from "../components/ui";
import { api, errorText, type LogLine, type ProfileView, type ProfilesData } from "../lib/api";

interface Props {
  running: boolean;
  profile: string | null;
  logs: LogLine[];
  onClearLogs: () => void;
}

type Dialog = { kind: "create" } | { kind: "edit"; profile: ProfileView } | { kind: "delete"; profile: ProfileView } | null;

export default function CalentadorBots({ running, profile, logs, onClearLogs }: Props) {
  const [data, setData] = useState<ProfilesData | null>(null);
  const [podsError, setPodsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const overview = await api.profilesOverview();
      setData(overview.data);
      setPodsError(overview.podsError);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow the log unless the user scrolled up.
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const start = async (name: string) => {
    setPending("start");
    setError(null);
    try {
      await api.startProfile(name);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(null);
    }
  };

  const stop = async () => {
    setPending("stop");
    setError(null);
    try {
      await api.stopProfile();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(null);
    }
  };

  const profiles = data?.profiles ?? [];
  const registry = data?.registry;
  const linked = registry ? registry.rows.filter((r) => r.testerId && r.linked).length + registry.testersWithoutPhone.filter((t) => t.linked).length : 0;
  const testerTotal = registry ? registry.rows.filter((r) => r.testerId).length + registry.testersWithoutPhone.length : 0;

  const saved = (message: string) => {
    setDialog(null);
    setInfo(message);
    void load();
  };

  return (
    <div className="page">
      <Banner
        title="Calentador Bots"
        subtitle="Crea y edita instancias de calentamiento: sus números conversan entre sí en el grupo. Solo una a la vez."
      >
        {running ? (
          <button className="btn danger" onClick={() => void stop()} disabled={pending === "stop"}>
            <Square size={15} aria-hidden /> {pending === "stop" ? "Deteniendo…" : "Detener perfil"}
          </button>
        ) : (
          <button className="btn secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} aria-hidden /> Actualizar
          </button>
        )}
        <button className="btn" onClick={() => setDialog({ kind: "create" })} disabled={!registry}>
          <Plus size={15} aria-hidden /> Nueva instancia
        </button>
      </Banner>

      <section className="stats" aria-label="Resumen">
        <StatCard icon={Flame} label="Instancias" value={data ? profiles.length : "–"} caption="perfiles en profiles.json" />
        <StatCard icon={Link2} label="Números vinculados" value={data ? `${linked}/${testerTotal}` : "–"} caption="testers con sesión guardada" />
        <StatCard icon={Users} label="Perfil en curso" value={running ? profile : "Ninguno"} caption={running ? "calentando ahora" : "listo para iniciar"} />
        <StatCard icon={MessagesSquare} label="Grupo por defecto" value={data?.defaultGroup ?? "–"} caption="si la instancia no define uno" />
      </section>

      {error && <Notice>{error}</Notice>}
      {info && <Notice kind="ok">{info}</Notice>}
      {podsError && <Notice>No se pudo leer la lista de pods (los números de pods pueden faltar): {podsError}</Notice>}

      {loading && !data ? (
        <SkeletonGrid />
      ) : (
        <div className="grid">
          {profiles.map((p) => {
            const isThis = running && profile === p.name;
            return (
              <Card key={p.name}>
                <div className="card-head">
                  <h2 className="card-title">{p.name}</h2>
                  {isThis ? <Pill tone="green">Activo</Pill> : <Pill tone="gray">Detenido</Pill>}
                </div>
                <dl className="meta">
                  <dt>Grupo</dt>
                  <dd>{p.effectiveGroup ?? "–"}</dd>
                  <dt>Números</dt>
                  <dd>{p.testers.length}</dd>
                </dl>
                <div className="chips">
                  {p.testers.map((t) => (
                    <span key={t.id} className={`chip ${t.linked ? "" : "unlinked"}`} title={t.linked ? "Sesión vinculada" : "Sin vincular: pedirá QR al iniciar"}>
                      <i aria-hidden /> {t.phone ?? t.id}
                      {t.podName ? ` · ${t.podName}` : " · Externo"}
                    </span>
                  ))}
                </div>
                <div className="row-actions">
                  {isThis ? (
                    <button className="btn sm danger" onClick={() => void stop()} disabled={pending === "stop"}>
                      <Square size={14} aria-hidden /> Detener
                    </button>
                  ) : (
                    <button className="btn sm" onClick={() => void start(p.name)} disabled={running || pending !== null}>
                      <Play size={14} aria-hidden /> Iniciar
                    </button>
                  )}
                  <button
                    className="btn sm ghost"
                    onClick={() => setDialog({ kind: "edit", profile: p })}
                    disabled={isThis}
                    title={isThis ? "Está en curso: detenla para editarla" : "Editar la instancia"}
                  >
                    <Pencil size={14} aria-hidden /> Editar
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => setDialog({ kind: "delete", profile: p })}
                    disabled={isThis}
                    title={isThis ? "Está en curso: detenla para eliminarla" : "Eliminar la instancia"}
                  >
                    <Trash2 size={14} aria-hidden /> Eliminar
                  </button>
                </div>
              </Card>
            );
          })}
          {data && profiles.length === 0 && !error && <Card>Todavía no hay instancias. Crea la primera con «Nueva instancia».</Card>}
        </div>
      )}

      <Card>
        <div className="card-head">
          <h2 className="card-title">Registro en vivo</h2>
          <button className="btn sm ghost" onClick={onClearLogs}>
            <Trash2 size={14} aria-hidden /> Limpiar
          </button>
        </div>
        <div className="log" ref={logRef} role="log" aria-live="off" tabIndex={0}>
          {logs.length === 0 ? (
            <span className="log-empty">Aquí aparecerá la salida del perfil cuando lo inicies.</span>
          ) : (
            logs.map((l, i) => (
              <div key={i} className={l.stream}>
                {l.line || " "}
              </div>
            ))
          )}
        </div>
      </Card>

      <AnimatePresence>
        {dialog?.kind === "create" && data && (
          <ProfileForm key="create" mode="create" data={data} onClose={() => setDialog(null)} onSaved={saved} />
        )}
        {dialog?.kind === "edit" && data && (
          <ProfileForm key="edit" mode="edit" profile={dialog.profile} data={data} onClose={() => setDialog(null)} onSaved={saved} />
        )}
        {dialog?.kind === "delete" && (
          <DeleteProfileModal key="delete" profile={dialog.profile} onClose={() => setDialog(null)} onDeleted={saved} />
        )}
      </AnimatePresence>
    </div>
  );
}

const WIZARD_STEPS = ["Nombre", "Grupo", "Números"];

/** Create = 3-step wizard (name, group, numbers). Edit = one form with the same fields and a number counter. */
function ProfileForm({
  mode,
  profile,
  data,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  profile?: ProfileView;
  data: ProfilesData;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const editing = mode === "edit" && profile;
  const [step, setStep] = useState(0);
  const [name, setName] = useState(profile?.name ?? "");
  const [group, setGroup] = useState(profile?.groupName ?? profile?.effectiveGroup ?? data.defaultGroup ?? "");
  const [selected, setSelected] = useState<string[]>(profile ? initialSelection(profile) : []);
  const [externals, setExternals] = useState<Record<string, string>>({});
  const initialCount = profile?.testers.length ?? 0;
  const [target, setTarget] = useState(initialCount);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = buildItems(data.registry, externals, profile?.name ?? null);
  const botSelected = items.some((i) => i.isBot && selected.includes(i.key));
  const taken = data.profiles.filter((p) => p.name !== profile?.name).map((p) => p.name.toLowerCase());
  const nameProblem = !name.trim() ? "Escribe un nombre." : taken.includes(name.trim().toLowerCase()) ? `Ya existe una instancia llamada «${name.trim()}».` : null;

  const countOk = !editing || selected.length === target;
  const numbersOk = selected.length > 0 && !botSelected && countOk;
  const diff = selected.length - target;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const selections = toSelections(items, selected);
      if (editing) {
        await api.profileUpdate(profile.name, name.trim() !== profile.name ? name.trim() : null, group.trim() || null, selections);
        onSaved(`Instancia «${name.trim()}» actualizada.`);
      } else {
        await api.profileCreate(name.trim(), group.trim() || null, selections);
        onSaved(`Instancia «${name.trim()}» creada.`);
      }
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  const numbersBlock = (
    <>
      {editing && (
        <div className="field">
          <label htmlFor="count">Cantidad de números</label>
          <div className="stepper">
            <button className="btn sm ghost" onClick={() => setTarget((t) => Math.max(1, t - 1))} aria-label="Menos">
              −
            </button>
            <strong aria-live="polite">{target}</strong>
            <button className="btn sm ghost" onClick={() => setTarget((t) => t + 1)} aria-label="Más">
              +
            </button>
          </div>
          {diff < 0 && <small>Elige {-diff} número(s) más en la lista.</small>}
          {diff > 0 && <small>Quita {diff} número(s) de la lista para llegar a {target}.</small>}
          {diff === 0 && <small>Marca o desmarca números en la lista; la cantidad debe coincidir.</small>}
        </div>
      )}
      <NumberPicker
        registry={data.registry}
        botNumber={data.botNumber}
        currentProfile={profile?.name ?? null}
        selected={selected}
        externals={externals}
        onChange={(s, e) => {
          setSelected(s);
          setExternals(e);
          if (!editing) setTarget(s.length);
        }}
      />
      <small>{selected.length} número(s) seleccionados.</small>
      {botSelected && <Warning>Hay seleccionado el número del bot. Quítalo: el bot siempre participa por su cuenta.</Warning>}
    </>
  );

  const nameField = (
    <div className="field">
      <label htmlFor="profile-name">Nombre de la instancia</label>
      <input id="profile-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="cal mex5" autoFocus />
      {name && nameProblem && <span className="field-error">{nameProblem}</span>}
    </div>
  );

  const groupField = (
    <div className="field">
      <label htmlFor="profile-group">Grupo de WhatsApp</label>
      <input id="profile-group" className="input" value={group} onChange={(e) => setGroup(e.target.value)} placeholder={data.defaultGroup ?? "Nombre del grupo"} />
      <small>Si lo dejas vacío se usa el grupo por defecto{data.defaultGroup ? ` («${data.defaultGroup}»)` : ""}.</small>
    </div>
  );

  const footer = editing ? (
    <>
      <button className="btn ghost" onClick={onClose} disabled={saving}>
        Cancelar
      </button>
      <button className="btn" onClick={() => void save()} disabled={saving || !!nameProblem || !numbersOk}>
        {saving ? <Loader2 size={15} className="spin" aria-hidden /> : <Check size={15} aria-hidden />} {saving ? "Guardando…" : "Guardar cambios"}
      </button>
    </>
  ) : (
    <>
      {step === 0 ? (
        <button className="btn ghost" onClick={onClose} disabled={saving}>
          Cancelar
        </button>
      ) : (
        <button className="btn ghost" onClick={() => setStep(step - 1)} disabled={saving}>
          <ArrowLeft size={15} aria-hidden /> Atrás
        </button>
      )}
      {step < 2 ? (
        <button className="btn" onClick={() => setStep(step + 1)} disabled={step === 0 && !!nameProblem}>
          Siguiente <ArrowRight size={15} aria-hidden />
        </button>
      ) : (
        <button className="btn" onClick={() => void save()} disabled={saving || !numbersOk}>
          {saving ? <Loader2 size={15} className="spin" aria-hidden /> : <Check size={15} aria-hidden />} {saving ? "Creando…" : "Crear instancia"}
        </button>
      )}
    </>
  );

  return (
    <Modal title={editing ? `Editar «${profile.name}»` : "Nueva instancia"} wide locked={saving} onClose={onClose} footer={footer}>
      {!editing && (
        <div className="wizard-steps" aria-label="Pasos">
          {WIZARD_STEPS.map((label, i) => (
            <span key={label} className={i === step ? "active" : ""}>
              {i + 1}. {label}
            </span>
          ))}
        </div>
      )}
      {editing ? (
        <>
          {nameField}
          {groupField}
          {numbersBlock}
        </>
      ) : (
        <>
          {step === 0 && nameField}
          {step === 1 && groupField}
          {step === 2 && numbersBlock}
        </>
      )}
      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}

function DeleteProfileModal({ profile, onClose, onDeleted }: { profile: ProfileView; onClose: () => void; onDeleted: (message: string) => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.profileDelete(profile.name);
      onDeleted(`Instancia «${profile.name}» eliminada. Los números y sus sesiones se conservan.`);
    } catch (e) {
      setError(errorText(e));
      setDeleting(false);
    }
  };

  return (
    <Modal
      title={`Eliminar «${profile.name}»`}
      locked={deleting}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={deleting}>
            Cancelar
          </button>
          <button className="btn danger" onClick={() => void remove()} disabled={deleting}>
            {deleting ? <Loader2 size={15} className="spin" aria-hidden /> : <Trash2 size={15} aria-hidden />} {deleting ? "Eliminando…" : "Eliminar instancia"}
          </button>
        </>
      }
    >
      <p>
        Se quita la instancia de la lista de perfiles. Los números (testers) y sus sesiones de WhatsApp <strong>no se borran</strong>: podrás usarlos en otra
        instancia. Antes de guardar se hace una copia de seguridad de profiles.json.
      </p>
      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}
