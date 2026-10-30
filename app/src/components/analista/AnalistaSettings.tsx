import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { type AgentApi, type AgentInfo, type AnalistaSettings, type AnalistaStatus } from "../../lib/agentApi";
import { Card, Notice, Pill, Skeleton } from "../ui";

const MODELS = [
  { id: "", label: "El predeterminado de Claude Code" },
  { id: "sonnet", label: "Sonnet (equilibrado)" },
  { id: "opus", label: "Opus (el más capaz, gasta más plan)" },
  { id: "haiku", label: "Haiku (rápido y liviano)" },
];

export default function AnalistaSettingsPanel({ api, agent, showLearning = true, onSaved }: { api: AgentApi; agent?: AgentInfo; showLearning?: boolean; onSaved: (s: AnalistaSettings) => void }) {
  const label = agent?.shortName ?? "Analista";
  const [status, setStatus] = useState<AnalistaStatus | null>(null);
  const [form, setForm] = useState<AnalistaSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .status()
      .then((s) => {
        setStatus(s);
        setForm(s.settings);
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  if (!form) return error ? <Notice>{error}</Notice> : <Skeleton height={240} />;

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.saveSettings(form);
      setForm(res.settings);
      setStatus(await api.status());
      onSaved(res.settings);
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="an-settings">
      <h2>Ajustes del {label}</h2>
      <p className="muted">
        El {label} usa tu Claude Code instalado y la sesión que ya tienes abierta (tu plan). Nunca usa una clave de API: si el sistema tiene una, se ignora.
      </p>
      {error && <Notice>{error}</Notice>}
      {saved && <Notice kind="ok">Guardado.</Notice>}

      <div className="field">
        <label htmlFor="an-claude">Ruta de Claude Code (opcional)</label>
        <input id="an-claude" className="input" value={form.claudePath} placeholder="Vacío = buscarlo solo (PATH, .local\bin, npm)" onChange={(e) => setForm({ ...form, claudePath: e.target.value })} />
        <small>
          {status?.claude.found ? <Pill tone="green">Encontrado</Pill> : <Pill tone="red">No encontrado</Pill>}{" "}
          {status?.claude.path ?? "Instala Claude Code o escribe la ruta de claude.exe."}
        </small>
      </div>

      <div className="field">
        <label htmlFor="an-model">Modelo</label>
        <select id="an-model" className="input" value={MODELS.some((m) => m.id === form.model) ? form.model : ""} onChange={(e) => setForm({ ...form, model: e.target.value })}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <small>Cada pregunta gasta del límite de tu plan; un modelo más pequeño rinde más preguntas.</small>
      </div>

      <div className="field">
        <button type="button" className="switch" role="switch" aria-checked={form.web} onClick={() => setForm({ ...form, web: !form.web })}>
          <span className="knob">{form.web ? "✓" : ""}</span> Búsqueda web {form.web ? "activada" : "desactivada"}
        </button>
        <small>Solo para contexto externo (benchmarks, políticas). Siempre separa lo de la web de tus datos y cita la fuente.</small>
      </div>

      {showLearning && (
      <div className="field">
        <button type="button" className="switch" role="switch" aria-checked={form.learning} onClick={() => setForm({ ...form, learning: !form.learning })}>
          <span className="knob">{form.learning ? "✓" : ""}</span> Aprendizaje {form.learning ? "activado" : "desactivado"}
        </button>
        <small>
          Interruptor general. Apagado: no guarda recomendaciones ni mide resultados, y no usa ninguna lección en las respuestas (no borra nada).
        </small>
      </div>
      )}

      <button className="btn" onClick={() => void save()} disabled={busy}>
        <Save size={14} aria-hidden /> Guardar
      </button>

      <p className="muted an-paths">Espacio de trabajo: <code>{status?.workspace}</code></p>
    </Card>
  );
}
