import { Download, Moon, RefreshCw, RotateCcw, Save, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Banner, Card, Notice, Skeleton } from "../components/ui";
import { api, errorText, type ApplyReport, type Settings, type UpdateStatus } from "../lib/api";
import { applyOutcome, checkSummary } from "../lib/updateView";
import type { Theme } from "../lib/theme";

const FIELDS: { key: keyof Settings; label: string; hint: string }[] = [
  { key: "dataDir", label: "Carpeta de datos del calentador", hint: "config.json, profiles.json, .baileys_auth, results y .env. Por defecto, el proyecto whatsapp-bot-tester original." },
  { key: "warmupDir", label: "Carpeta del motor del calentador", hint: "Donde está perfil.js (engines/warmup)." },
  { key: "podsDir", label: "Carpeta de pods", hint: "Donde está pods.ps1 (engines/pods)." },
  { key: "apkDir", label: "Carpeta de APK", hint: "APK de WhatsApp Business (subcarpeta business). Por defecto, la de whatsapp-pods." },
  { key: "podsWspFile", label: "Archivo pods-wsp.json", hint: "Mapa instancia → número. Por defecto, el de whatsapp-pods." },
  { key: "nodePath", label: "Ruta de Node", hint: "«node» usa el del PATH." },
];

interface Props {
  theme: Theme;
  onTheme: (theme: Theme) => void;
}

export default function Ajustes({ theme, onTheme }: Props) {
  const [form, setForm] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then(setForm).catch((e) => setError(errorText(e)));
  }, []);

  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState<"check" | "apply" | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [applied, setApplied] = useState<ApplyReport | null>(null);

  /** Fetch + status. `auto` marks the on-open check: a busy lock there is not worth an error. */
  const checkUpdates = async ({ auto = false, keepApplied = false } = {}): Promise<boolean> => {
    setUpdateBusy("check");
    if (!keepApplied) setApplied(null);
    try {
      setUpdate(await api.updateCheck());
      setUpdateError(null);
      return true;
    } catch (e) {
      const text = errorText(e);
      if (!(auto && text.includes("en curso"))) setUpdateError(text);
      return false;
    } finally {
      setUpdateBusy(null);
    }
  };

  const applyUpdate = async () => {
    setUpdateBusy("apply");
    setUpdateError(null);
    let failure: string | null = null;
    try {
      setApplied(await api.updateApply());
    } catch (e) {
      failure = errorText(e);
    }
    // Success or not, refresh what the card shows.
    await checkUpdates({ keepApplied: true });
    if (failure) setUpdateError(failure);
  };

  // Fetch only (never applies): the user decides when to update. The ref keeps StrictMode's double mount to one check.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current) return;
    autoChecked.current = true;
    void checkUpdates({ auto: true });
  }, []);

  const save = async () => {
    if (!form) return;
    setError(null);
    setSaved(false);
    try {
      setForm(await api.saveSettings(form));
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const reset = async () => {
    try {
      setForm(await api.getDefaultSettings());
      setSaved(false);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="page">
      <Banner title="Ajustes" subtitle="Rutas que usa la app y apariencia. Los cambios de rutas se aplican a las próximas acciones." />

      <Card>
        <div className="card-head">
          <h2 className="card-title">Apariencia</h2>
          <button
            className="switch"
            role="switch"
            aria-checked={theme === "light"}
            onClick={() => onTheme(theme === "dark" ? "light" : "dark")}
          >
            <span className="knob">{theme === "dark" ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />}</span>
            {theme === "dark" ? "Tema oscuro" : "Tema claro"}
          </button>
        </div>
        <span className="muted">El tema oscuro es el predeterminado. Cambia al claro cuando lo prefieras.</span>
      </Card>

      <Card>
        <div className="card-head">
          <h2 className="card-title">Actualizaciones</h2>
          <div className="row-actions">
            <button className="btn sm ghost" onClick={() => void checkUpdates()} disabled={updateBusy !== null}>
              <RefreshCw size={14} aria-hidden /> {updateBusy === "check" ? "Buscando…" : "Buscar actualizaciones"}
            </button>
            <button
              className="btn sm"
              onClick={() => void applyUpdate()}
              disabled={updateBusy !== null || !update || !update.canApply}
            >
              <Download size={14} aria-hidden /> {updateBusy === "apply" ? "Actualizando…" : "Actualizar"}
            </button>
          </div>
        </div>
        {updateError && <Notice>{updateError}</Notice>}
        {applied && (
          <div className={`notice ${applyOutcome(applied).kind}`} role="status">
            {applyOutcome(applied).text}
          </div>
        )}
        {(update || applied) && (
          <span className="muted">
            Versión actual: <code>{(applied ?? update)!.current.sha}</code> {(applied ?? update)!.current.subject}
          </span>
        )}
        {update && (
          <>
            <strong>{checkSummary(update.behind)}</strong>
            {update.commits.length > 0 && (
              <ul>
                {update.commits.map((c) => (
                  <li key={c.sha}>
                    <code>{c.sha}</code> {c.subject}
                  </li>
                ))}
              </ul>
            )}
            {update.behind > 0 && !update.canApply && update.blockedReason && <span className="muted">{update.blockedReason}</span>}
          </>
        )}
        <small className="muted">
          Antes de actualizar, detén el calentamiento y las operaciones de pods. Esto funciona cuando la app corre con <code>npm run tauri dev</code>; un .exe ya compilado hay que volver a compilarlo.
        </small>
      </Card>

      <Card>
        <div className="card-head">
          <h2 className="card-title">Rutas</h2>
          <div className="row-actions">
            <button className="btn sm ghost" onClick={() => void reset()} disabled={!form}>
              <RotateCcw size={14} aria-hidden /> Valores por defecto
            </button>
            <button className="btn sm" onClick={() => void save()} disabled={!form}>
              <Save size={14} aria-hidden /> Guardar
            </button>
          </div>
        </div>
        {error && <Notice>{error}</Notice>}
        {saved && <Notice kind="ok">Ajustes guardados.</Notice>}
        {!form ? (
          <Skeleton height={260} />
        ) : (
          FIELDS.map((f) => (
            <div className="field" key={f.key}>
              <label htmlFor={f.key}>{f.label}</label>
              <input
                id={f.key}
                className="input"
                value={form[f.key]}
                spellCheck={false}
                onChange={(e) => {
                  setSaved(false);
                  setForm({ ...form, [f.key]: e.target.value });
                }}
              />
              <small>{f.hint}</small>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
