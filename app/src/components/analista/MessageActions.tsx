import { Check, MessageSquareWarning, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { type AgentApi, type AgentMessage, type Lesson } from "../../lib/agentApi";

/** Feedback under an answer (👍 / 👎 / "Esto está mal") and the "¿Aprendo esto?" fence for new lesson candidates. */
export default function MessageActions({
  api,
  message,
  candidateIds,
  onChanged,
  onRated,
}: {
  api: AgentApi;
  message: AgentMessage;
  candidateIds: number[];
  onChanged: () => void;
  onRated: (rating: 1 | -1) => void;
}) {
  const [wrong, setWrong] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Lesson[]>([]);
  const rating = message.meta.rating;

  useEffect(() => {
    if (!candidateIds.length) return setPending([]);
    void api
      .lessons(candidateIds)
      .then((r) => setPending(r.lessons.filter((l) => l.status === "candidate")))
      .catch(() => setPending([]));
  }, [candidateIds]);

  async function rate(kind: "up" | "down" | "wrong", text?: string) {
    setError(null);
    try {
      const res = await api.feedback(message.id, kind, text);
      onRated(res.rating === 1 ? 1 : -1);
      setWrong(false);
      setComment("");
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function decide(lesson: Lesson, action: "certify" | "reject") {
    setError(null);
    try {
      await api.setLesson(lesson.id, action);
      setPending((all) => all.filter((l) => l.id !== lesson.id));
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="an-actions">
      <div className="an-rate" role="group" aria-label="¿Te sirvió esta respuesta?">
        <button className={`btn ghost sm ${rating === 1 ? "on" : ""}`} aria-pressed={rating === 1} onClick={() => void rate("up")} title="Me sirvió">
          <ThumbsUp size={14} aria-hidden /> <span className="sr-only">Me sirvió</span>
        </button>
        <button className={`btn ghost sm ${rating === -1 && !message.meta.comment ? "on" : ""}`} aria-pressed={rating === -1} onClick={() => void rate("down")} title="No me sirvió">
          <ThumbsDown size={14} aria-hidden /> <span className="sr-only">No me sirvió</span>
        </button>
        <button className="btn ghost sm" onClick={() => setWrong((v) => !v)} aria-expanded={wrong}>
          <MessageSquareWarning size={14} aria-hidden /> Esto está mal
        </button>
      </div>

      {wrong && (
        <form
          className="an-wrong"
          onSubmit={(e) => {
            e.preventDefault();
            void rate("wrong", comment.trim());
          }}
        >
          <input className="input" value={comment} maxLength={300} placeholder="¿Qué estaba mal o cómo lo prefieres? (opcional)" aria-label="Qué estaba mal" onChange={(e) => setComment(e.target.value)} />
          <button className="btn sm" type="submit">Enviar</button>
        </form>
      )}

      {pending.length > 0 && (
        <div className="an-learn" role="region" aria-label="Lecciones nuevas">
          {pending.map((l) => (
            <div key={l.id} className="an-learn-item">
              <p>
                <strong>¿Aprendo esto?</strong> {l.text}
                {l.evidence.support ? <small> · {l.evidence.support} casos</small> : null}
              </p>
              <div>
                <button className="btn sm" onClick={() => void decide(l, "certify")}><Check size={13} aria-hidden /> Sí</button>
                <button className="btn secondary sm" onClick={() => void decide(l, "reject")}><X size={13} aria-hidden /> No</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <p className="an-warn">{error}</p>}
    </div>
  );
}
