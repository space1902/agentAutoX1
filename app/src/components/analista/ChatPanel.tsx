import { AlertTriangle, Check, Loader2, MessageSquarePlus, Send, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../../lib/api";
import {
  type AgentApi,
  type AgentInfo,
  formatDuration,
  formatTokens,
  STARTERS,
  type AgentMessage,
  type AgentSession,
  type AnalistaStatus,
  type PlanInfo,
  type StepInfo,
  type TurnEvent,
} from "../../lib/agentApi";
import { Notice } from "../ui";
import Markdown from "./Markdown";
import MessageActions from "./MessageActions";

// While a turn runs only the steps are shown; the commentary and the answer appear once, when the turn is done.
interface Live {
  steps: StepInfo[];
}

function Steps({ steps, live }: { steps: StepInfo[]; live: boolean }) {
  if (!steps.length) return null;
  return (
    <ul className="an-steps" aria-label="Pasos del análisis" aria-live={live ? "polite" : undefined}>
      {steps.map((s) => (
        <li key={s.id} className={s.ok === null ? "run" : s.ok ? "ok" : "bad"}>
          {s.ok === null ? <Loader2 size={13} className="spin" aria-hidden /> : s.ok ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />}
          <span>{s.label}</span>
          {s.summary && <small>{s.summary}</small>}
        </li>
      ))}
    </ul>
  );
}

function UsageFooter({ meta }: { meta: AgentMessage["meta"] }) {
  if (!meta.usage && !meta.durationMs) return null;
  const parts: string[] = [];
  if (meta.durationMs) parts.push(formatDuration(meta.durationMs));
  if (meta.turns) parts.push(`${meta.turns} ${meta.turns === 1 ? "turno" : "turnos"}`);
  if (meta.usage) parts.push(`${formatTokens(meta.usage.total)} tokens (${formatTokens(meta.usage.output)} de respuesta)`);
  const plan: PlanInfo | null | undefined = meta.plan;
  if (plan && plan.fiveHour !== null) parts.push(`plan: ${Math.round(plan.fiveHour * 100)} % de la ventana de 5 h`);
  return <p className="an-usage">{parts.join(" · ")}</p>;
}

export default function ChatPanel({ api, agent, learning, onGoSettings, onLearningChange }: { api: AgentApi; agent?: AgentInfo; learning: boolean; onGoSettings: () => void; onLearningChange: () => void }) {
  const label = agent?.shortName ?? "Analista";
  const starters = agent?.starters?.length ? agent.starters : STARTERS;
  const welcome = agent?.welcome ?? { title: "Pregúntame por tus anuncios y ventas", text: "Consulto tus datos reales de solo lectura, hago las cuentas con código y te explico. No cambio nada en Meta." };
  const usesAdsData = agent?.usesAdsData ?? true;
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AnalistaStatus | null>(null);
  const [candidateIds, setCandidateIds] = useState<number[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const loadSessions = useCallback(async () => {
    try {
      setSessions((await api.sessions()).sessions);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const openSession = useCallback(async (id: string | null) => {
    setActiveId(id);
    setCandidateIds([]);
    if (!id) return setMessages([]);
    try {
      setMessages((await api.messages(id)).messages);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    void api.status().then(setStatus).catch((e) => setError(errorText(e)));
    void api.running().then((s) => setRunning(s.chat.running)).catch(() => undefined);
  }, [loadSessions]);

  useEffect(() => {
    const unlisten = [
      api.onTurn((ev: TurnEvent) => {
        switch (ev.type) {
          case "turn_start":
            setActiveId(ev.sessionId);
            setRunning(true);
            setLive({ steps: [] });
            void loadSessions();
            break;
          case "step":
            setLive((l) => (l ? { ...l, steps: [...l.steps, { id: ev.id, tool: ev.tool, label: ev.label, ok: null, summary: "" }] } : l));
            break;
          case "step_done":
            setLive((l) => (l ? { ...l, steps: l.steps.map((s) => (s.id === ev.id ? { ...s, ok: ev.ok, summary: ev.summary } : s)) } : l));
            break;
          case "done":
            setCandidateIds(ev.candidateIds ?? []);
            setLive(null);
            setRunning(false);
            void openSession(ev.sessionId).then(() => void loadSessions());
            if ((ev.newCandidates ?? 0) > 0) onLearningChange();
            break;
          case "cancelled":
            setLive(null);
            setRunning(false);
            void openSession(ev.sessionId);
            break;
          case "error":
            setError(ev.error);
            setLive(null);
            setRunning(false);
            if (ev.sessionId) void openSession(ev.sessionId);
            break;
          default:
            break;
        }
      }),
      api.onExit(() => {
        setRunning(false);
        void loadSessions();
      }),
    ];
    return () => unlisten.forEach((p) => void p.then((fn) => fn()));
  }, [loadSessions, openSession, onLearningChange]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, live]);

  async function send(text: string) {
    const body = text.trim();
    if (!body || running) return;
    setError(null);
    setInput("");
    setCandidateIds([]);
    setMessages((m) => [...m, { id: -Date.now(), sessionId: activeRef.current ?? "", role: "user", text: body, ts: Date.now(), meta: {} }]);
    setRunning(true);
    setLive({ steps: [] });
    try {
      await api.start("turn", { sessionId: activeRef.current ?? "", text: body });
    } catch (e) {
      setError(errorText(e));
      setRunning(false);
      setLive(null);
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteSession(id);
      if (activeId === id) await openSession(null);
      await loadSessions();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="an-chat">
      <aside className="an-side card" aria-label="Conversaciones">
        <button className="btn secondary sm" onClick={() => void openSession(null)} disabled={running}>
          <MessageSquarePlus size={14} aria-hidden /> Nuevo chat
        </button>
        <ul>
          {sessions.map((s) => (
            <li key={s.id} className={s.id === activeId ? "active" : ""}>
              <button className="an-session" onClick={() => void openSession(s.id)} disabled={running} title={s.title}>
                {s.title}
              </button>
              <button className="an-del" aria-label={`Borrar el chat ${s.title}`} onClick={() => void remove(s.id)} disabled={running}>
                <Trash2 size={13} aria-hidden />
              </button>
            </li>
          ))}
          {!sessions.length && <li className="an-empty muted">Aún no hay conversaciones.</li>}
        </ul>
      </aside>

      <section className="an-main card" aria-label="Conversación">
        {status && !status.claude.found && (
          <Notice>
            No encuentro Claude Code en este equipo. Instálalo e inicia sesión, o indica la ruta de <code>claude.exe</code> en{" "}
            <button className="btn ghost sm" onClick={onGoSettings}>Ajustes del {label}</button>.
          </Notice>
        )}
        {usesAdsData && status && !status.adsDb && <Notice>Todavía no hay datos de Anuncios: abre la sección Anuncios y actualiza para que el Analista tenga qué consultar.</Notice>}
        {error && <Notice>{error}</Notice>}

        <div className="an-scroll" role="log" aria-live="polite">
          {!messages.length && !live && (
            <div className="an-welcome">
              <h2>{welcome.title}</h2>
              <p className="muted">{welcome.text}</p>
              <div className="an-starters">
                {starters.map((q) => (
                  <button key={q} className="chip" onClick={() => void send(q)} disabled={running}>{q}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <article key={m.id} className={`an-msg ${m.role}`}>
              {m.role === "user" ? (
                <p>{m.text}</p>
              ) : (
                <>
                  {!!m.meta.steps?.length && (
                    <details className="an-steps-box">
                      <summary>{m.meta.steps.length} {m.meta.steps.length === 1 ? "paso" : "pasos"}</summary>
                      <Steps steps={m.meta.steps} live={false} />
                    </details>
                  )}
                  <Markdown text={m.text} marks={m.meta.ungrounded ?? []} />
                  {!!m.meta.ungrounded?.length && (
                    <p className="an-warn">
                      <AlertTriangle size={13} aria-hidden /> {m.meta.ungrounded.length === 1 ? "1 cifra no verificada" : `${m.meta.ungrounded.length} cifras no verificadas`}: no las encontré en los datos de esta consulta. Tómalas con cuidado.
                    </p>
                  )}
                  {m.meta.cancelled && <p className="an-warn">Respuesta cancelada.</p>}
                  <UsageFooter meta={m.meta} />
                  {learning && !m.meta.cancelled && (
                    <MessageActions api={api} message={m} candidateIds={m.id === lastAssistant?.id ? candidateIds : []} onChanged={onLearningChange} onRated={(rating) => setMessages((all) => all.map((x) => (x.id === m.id ? { ...x, meta: { ...x.meta, rating } } : x)))} />
                  )}
                </>
              )}
            </article>
          ))}

          {live && (
            <article className="an-msg assistant live">
              <Steps steps={live.steps} live />
              {live.steps.every((s) => s.ok !== null) && (
                <p className="muted"><Loader2 size={13} className="spin" aria-hidden /> {live.steps.length ? "Preparando la respuesta…" : "Pensando…"}</p>
              )}
            </article>
          )}
          <div ref={bottom} />
        </div>

        <form
          className="an-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            className="input"
            rows={2}
            value={input}
            placeholder="Escribe tu pregunta… (Enter envía, Shift+Enter hace un salto de línea)"
            aria-label={`Pregunta para el ${label}`}
            maxLength={8000}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            disabled={running}
          />
          {running ? (
            <button type="button" className="btn danger" onClick={() => void api.cancel().catch((e) => setError(errorText(e)))}>
              <Square size={14} aria-hidden /> Cancelar
            </button>
          ) : (
            <button type="submit" className="btn" disabled={!input.trim()}>
              <Send size={14} aria-hidden /> Enviar
            </button>
          )}
        </form>
        <p className="an-plan-note">Usa los límites de tu plan de Claude (tu sesión de Claude Code), no la API: no se cobra por token.</p>
      </section>
    </div>
  );
}
