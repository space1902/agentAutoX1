import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { type AgentApi, type AgentInfo, type AnalistaSettings, type AnalistaStatus, type CodexStatus } from "../../lib/agentApi";
import { Card, Notice, Pill, Skeleton } from "../ui";

const MODELS = [
  { id: "", label: "El predeterminado de Claude Code" },
  { id: "sonnet", label: "Sonnet (equilibrado)" },
  { id: "opus", label: "Opus (el más capaz, gasta más plan)" },
  { id: "haiku", label: "Haiku (rápido y liviano)" },
];

const EFFORTS = [
  { id: "minimal", label: "Mínimo" },
  { id: "low", label: "Bajo (recomendado)" },
  { id: "medium", label: "Medio" },
  { id: "high", label: "Alto" },
];

export default function AnalistaSettingsPanel({ api, agent, showLearning = true, onSaved }: { api: AgentApi; agent?: AgentInfo; showLearning?: boolean; onSaved: (s: AnalistaSettings) => void }) {
  const label = agent?.shortName ?? "Analista";
  const [status, setStatus] = useState<AnalistaStatus | null>(null);
  const [form, setForm] = useState<AnalistaSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const creativo = api.agentId === "creativo";
  // The creativo and the investigador default to Sonnet (the CLI default model reads a much larger context).
  const sonnetDefault = creativo || api.agentId === "investigador";
  const models = sonnetDefault ? MODELS.filter((m) => m.id !== "") : MODELS;

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

  async function checkCodex() {
    setBusy(true);
    setError(null);
    try {
      // Save first so the check uses the folder and path just typed.
      if (form) await api.saveSettings(form);
      setCodex(await api.codexStatus());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

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
        <select id="an-model" className="input" value={models.some((m) => m.id === form.model) ? form.model : sonnetDefault ? "sonnet" : ""} onChange={(e) => setForm({ ...form, model: e.target.value })}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <small>Cada pregunta gasta del límite de tu plan; un modelo más pequeño rinde más preguntas.{sonnetDefault ? " Sonnet es el recomendado para este agente." : ""}</small>
      </div>

      {creativo && (
        <>
          <h3>Imágenes con GPT (Codex)</h3>
          <p className="muted">Las imágenes y el arte de los PDF se generan con Codex usando tu plan de ChatGPT, no una clave de API. Si no has entrado, abre una terminal y ejecuta <code>codex login</code>.</p>
          <div className="field">
            <label htmlFor="cx-model">Modelo de Codex</label>
            <input id="cx-model" className="input" value={form.codexModel ?? ""} onChange={(e) => setForm({ ...form, codexModel: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="cx-effort">Esfuerzo de razonamiento</label>
            <select id="cx-effort" className="input" value={form.codexEffort ?? "low"} onChange={(e) => setForm({ ...form, codexEffort: e.target.value })}>
              {EFFORTS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <small>Se envía siempre de forma explícita para no heredar el ajuste de tu configuración de Codex.</small>
          </div>
          <div className="field">
            <label htmlFor="cx-home">Carpeta de Codex (CODEX_HOME, opcional)</label>
            <input id="cx-home" className="input" value={form.codexHome ?? ""} placeholder="Vacío = la variable CODEX_HOME de tu sistema o ~/.codex" onChange={(e) => setForm({ ...form, codexHome: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="cx-path">Ruta de Codex (opcional)</label>
            <input id="cx-path" className="input" value={form.codexPath ?? ""} placeholder="Vacío = buscarlo solo (PATH, npm)" onChange={(e) => setForm({ ...form, codexPath: e.target.value })} />
          </div>
          <div className="field">
            <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void checkCodex()}>Comprobar Codex</button>
            {codex && (
              <small>
                {codex.loggedIn ? <Pill tone="green">Listo</Pill> : <Pill tone="red">Falta</Pill>} {codex.message} <code>{codex.codexHome}</code>
              </small>
            )}
          </div>
        </>
      )}

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
