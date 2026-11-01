import { Check, Pencil, RefreshCw, RotateCcw, Save, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { type AgentApi, type AgentInfo, type LearningSummary, type Lesson, type LessonStatus } from "../../lib/agentApi";
import { Card, Notice, Pill, Skeleton } from "../ui";

// What each agent learns from (shown under the title so it is clear where the candidates come from).
const SOURCES: Record<string, string> = {
  analista: "Aparecen cuando una recomendación se mide con datos reales.",
  creativo: "Aparecen cuando aprobaste o rechazaste generaciones, usaste o descartaste archivos, o lo corregiste; y cuando le dices una regla.",
  investigador: "Aparecen cuando le cuentas que un producto se lanzó y se compara lo previsto con lo real, o cuando le dices una regla.",
};

function groupsFor(name: string, agentId: string): { status: LessonStatus; title: string; empty: string }[] {
  return [
    { status: "candidate", title: "Candidatas (esperan tu decisión)", empty: `No hay lecciones nuevas. ${SOURCES[agentId] ?? SOURCES.analista}` },
    { status: "certified", title: `Certificadas (las que ${name} usa)`, empty: `Todavía no certificaste ninguna: ${name} no usa lecciones.` },
    { status: "rejected", title: "Rechazadas o revocadas", empty: "Nada por aquí." },
  ];
}

const kindLabel = (l: Lesson, name: string) => (l.source === "user" && l.kind === "rule" ? "Regla que dijiste" : l.kind === "rule" ? "Resultado real" : l.kind === "preference" ? "Tu preferencia" : `Propuesta de ${name}`);
const dmy = (ms: number) => new Date(ms).toLocaleDateString("es-CO");

export default function LessonsPanel({ api, agent, learning, refreshKey }: { api: AgentApi; agent?: AgentInfo; learning: boolean; refreshKey: number }) {
  const name = agent?.shortName ?? "Analista";
  const agentId = agent?.id ?? "analista";
  const [note, setNote] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.lessons();
      setLessons(res.lessons);
      setSummary(res.summary);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function act(l: Lesson, action: "certify" | "reject" | "revoke" | "restore") {
    setError(null);
    try {
      await api.setLesson(l.id, action);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  // "Medir ahora": the agent re-reads its own outcomes (approvals, used files, launches) and stores new candidates.
  async function measure() {
    setMeasuring(true);
    setError(null);
    setNote(null);
    try {
      const res = (await api.measureNow()) as { candidates?: number; faltan_resultados?: number };
      setNote(res.candidates ? `Salieron ${res.candidates} lecciones candidatas nuevas.` : res.faltan_resultados ? `Todavía faltan ${res.faltan_resultados} lanzamientos con resultado real para proponer algo.` : "No hay lecciones nuevas todavía: se necesitan al menos 3 casos que coincidan en un 75 % o más.");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setMeasuring(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setError(null);
    try {
      await api.editLesson(editing.id, editing.text);
      setEditing(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!lessons) return error ? <Notice>{error}</Notice> : <Skeleton height={200} />;
  const sig = summary?.signals;
  const GROUPS = groupsFor(name, agentId);

  return (
    <div className="an-lessons">
      {!learning && <Notice>El aprendizaje está desactivado: ninguna lección se usa en las respuestas (no se borró nada). Actívalo en Ajustes.</Notice>}
      {error && <Notice>{error}</Notice>}
      {note && <Notice kind="ok">{note}</Notice>}
      {summary && (
        <Card className="an-summary">
          {agent?.usesAdsData !== false && (
            <p>
              <strong>Resultados medidos:</strong> {summary.outcomes.acierto} aciertos · {summary.outcomes.fallo} fallos · {summary.outcomes.neutral} neutrales · {summary.outcomes.sin_datos} sin datos
              {summary.pending ? ` · ${summary.pending} por medir` : ""}.
            </p>
          )}
          <p className="muted">
            Señales de tus valoraciones (con vida media de 30 días): {sig && sig.count ? `${sig.total > 0 ? "+" : ""}${String(sig.total).replace(".", ",")} en ${sig.count} eventos` : "aún no hay"}.
          </p>
          <p className="muted">Solo las lecciones certificadas llegan a {name}. Las candidatas nunca cambian sus respuestas.</p>
          {!agent?.usesAdsData && (
            <button className="btn secondary sm" onClick={() => void measure()} disabled={measuring}>
              <RefreshCw size={13} aria-hidden className={measuring ? "spin" : ""} /> Revisar resultados ahora
            </button>
          )}
        </Card>
      )}

      {GROUPS.map((g) => {
        const items = lessons.filter((l) => l.status === g.status);
        return (
          <Card key={g.status} className="an-lesson-group">
            <h3>{g.title} <Pill tone={g.status === "certified" ? "green" : g.status === "candidate" ? "amber" : "gray"}>{items.length}</Pill></h3>
            {!items.length && <p className="muted">{g.empty}</p>}
            <ul>
              {items.map((l) => (
                <li key={l.id}>
                  {editing?.id === l.id ? (
                    <div className="an-edit">
                      <textarea className="input" rows={2} value={editing.text} maxLength={240} aria-label="Texto de la lección" onChange={(e) => setEditing({ id: l.id, text: e.target.value })} />
                      <button className="btn sm" onClick={() => void saveEdit()}><Save size={13} aria-hidden /> Guardar</button>
                      <button className="btn secondary sm" onClick={() => setEditing(null)}>Cancelar</button>
                    </div>
                  ) : (
                    <>
                      <div className="an-lesson-text">
                        <p>{l.text}</p>
                        <small className="muted">
                          {kindLabel(l, name)}
                          {l.evidence.support ? ` · ${l.evidence.support} casos` : ""}
                          {l.evidence.acierto !== undefined ? ` (${l.evidence.acierto} aciertos, ${l.evidence.fallo ?? 0} fallos)` : ""}
                          {l.certifiedAt ? ` · certificada el ${dmy(l.certifiedAt)}` : ` · creada el ${dmy(l.created)}`}
                        </small>
                      </div>
                      <div className="an-lesson-actions">
                        {l.status === "candidate" && (
                          <>
                            <button className="btn sm" onClick={() => void act(l, "certify")}><Check size={13} aria-hidden /> Certificar</button>
                            <button className="btn secondary sm" onClick={() => void act(l, "reject")}><X size={13} aria-hidden /> Rechazar</button>
                          </>
                        )}
                        {l.status === "certified" && <button className="btn secondary sm" onClick={() => void act(l, "revoke")}><Undo2 size={13} aria-hidden /> Revocar</button>}
                        {l.status === "rejected" && <button className="btn ghost sm" onClick={() => void act(l, "restore")}><RotateCcw size={13} aria-hidden /> Volver a candidata</button>}
                        {l.status !== "rejected" && (
                          <button className="btn ghost sm" onClick={() => setEditing({ id: l.id, text: l.text })} aria-label="Editar el texto"><Pencil size={13} aria-hidden /></button>
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
