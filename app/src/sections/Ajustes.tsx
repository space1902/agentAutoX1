import { Moon, RotateCcw, Save, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Banner, Card, Notice, Skeleton } from "../components/ui";
import { api, errorText, type Settings } from "../lib/api";
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
