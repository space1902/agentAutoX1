import { Check, Pencil, RotateCcw, Save, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { analista, type LearningSummary, type Lesson, type LessonStatus } from "../../lib/analistaApi";
import { Card, Notice, Pill, Skeleton } from "../ui";

const GROUPS: { status: LessonStatus; title: string; empty: string }[] = [
  { status: "candidate", title: "Candidatas (esperan tu decisión)", empty: "No hay lecciones nuevas. Aparecen cuando una recomendación se mide con datos reales." },
  { status: "certified", title: "Certificadas (las que el Analista usa)", empty: "Todavía no certificaste ninguna: el Analista no usa lecciones." },
  { status: "rejected", title: "Rechazadas o revocadas", empty: "Nada por aquí." },
];

const KIND = { rule: "Resultado real", preference: "Tu preferencia", agent: "Propuesta del Analista" } as const;
const dmy = (ms: number) => new Date(ms).toLocaleDateString("es-CO");

export default function LessonsPanel({ learning, refreshKey }: { learning: boolean; refreshKey: number }) {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await analista.lessons();
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
      await analista.setLesson(l.id, action);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setError(null);
    try {
      await analista.editLesson(editing.id, editing.text);
      setEditing(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!lessons) return error ? <Notice>{error}</Notice> : <Skeleton height={200} />;
  const sig = summary?.signals;

  return (
    <div className="an-lessons">
      {!learning && <Notice>El aprendizaje está desactivado: ninguna lección se usa en las respuestas (no se borró nada). Actívalo en Ajustes.</Notice>}
      {error && <Notice>{error}</Notice>}
      {summary && (
        <Card className="an-summary">
          <p>
            <strong>Resultados medidos:</strong> {summary.outcomes.acierto} aciertos · {summary.outcomes.fallo} fallos · {summary.outcomes.neutral} neutrales · {summary.outcomes.sin_datos} sin datos
            {summary.pending ? ` · ${summary.pending} por medir` : ""}.
          </p>
          <p className="muted">
            Señales de tus valoraciones (con vida media de 30 días): {sig && sig.count ? `${sig.total > 0 ? "+" : ""}${String(sig.total).replace(".", ",")} en ${sig.count} eventos` : "aún no hay"}.
          </p>
          <p className="muted">Solo las lecciones certificadas llegan al Analista. Las candidatas nunca cambian sus respuestas.</p>
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
                          {KIND[l.kind]}
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
