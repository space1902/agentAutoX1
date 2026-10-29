import { Play, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { analista, type EvalEstimate, type EvalEvent, type EvalQuestion, type EvalResult, type EvalRun } from "../../lib/analistaApi";
import { Card, Notice, Pill, Skeleton, type PillTone } from "../ui";

const CATEGORY: Record<string, string> = { numeric: "Cifra", judged: "Criterio", scope: "Fuera de alcance", refuse: "No inventar" };
const STATUS: Record<string, { text: string; tone: PillTone }> = {
  pass: { text: "Pasó", tone: "green" },
  fail: { text: "Falló", tone: "red" },
  excluded: { text: "Excluida", tone: "gray" },
};
const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)} %`);
const when = (ms: number) => new Date(ms).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });

function Trend({ runs }: { runs: EvalRun[] }) {
  const points = [...runs].filter((r) => r.passRate !== null).reverse().slice(-12);
  if (points.length < 2) return null;
  return (
    <div className="an-trend" role="img" aria-label={`Tasa de acierto de las últimas ${points.length} evaluaciones`}>
      {points.map((r) => (
        <span key={r.id} style={{ height: `${Math.max(6, (r.passRate ?? 0) * 100)}%` }} title={`${when(r.ts)}: ${pct(r.passRate)}`} />
      ))}
    </div>
  );
}

export default function QualityPanel() {
  const [bank, setBank] = useState<EvalQuestion[] | null>(null);
  const [estimate, setEstimate] = useState<EvalEstimate | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [detail, setDetail] = useState<{ run: EvalRun | null; results: EvalResult[] } | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number; question: string; phase: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      setRuns((await analista.evalRuns()).runs);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    analista
      .evalBank()
      .then((r) => {
        setBank(r.questions);
        setEstimate(r.estimate);
        setSelected(new Set(r.questions.filter((q) => !q.skip).map((q) => q.id)));
      })
      .catch((e) => setError(errorText(e)));
    void loadRuns();
    void analista.running().then((s) => setRunning(s.eval.running)).catch(() => undefined);
  }, [loadRuns]);

  useEffect(() => {
    const unlisten = [
      analista.onEval((ev: EvalEvent) => {
        if (ev.type === "eval_start") setRunning(true);
        if (ev.type === "eval_progress") setProgress({ index: ev.index, total: ev.total, question: ev.question, phase: ev.phase });
        if (ev.type === "eval_done") {
          setRunning(false);
          setProgress(null);
          void loadRuns();
          void analista.evalDetail(ev.runId).then(setDetail).catch(() => undefined);
        }
        if (ev.type === "error") {
          setError(ev.error);
          setRunning(false);
        }
      }),
      analista.onEvalExit(() => {
        setRunning(false);
        setProgress(null);
        void loadRuns();
      }),
    ];
    return () => unlisten.forEach((p) => void p.then((fn) => fn()));
  }, [loadRuns]);

  const chosen = (bank ?? []).filter((q) => selected.has(q.id) && !q.skip);
  const claudeRuns = chosen.length;
  const judgeRuns = chosen.filter((q) => q.judged).length;

  async function start() {
    if (!claudeRuns) return;
    const ok = window.confirm(
      `Esto ejecuta al Analista de verdad: ${claudeRuns} ${claudeRuns === 1 ? "consulta" : "consultas"} a Claude` +
        (judgeRuns ? ` y hasta ${judgeRuns} llamadas al juez (Haiku)` : "") +
        ".\n\nGasta del límite de tu plan de Claude y puede tardar varios minutos. ¿Continuar?",
    );
    if (!ok) return;
    setError(null);
    setDetail(null);
    setRunning(true);
    try {
      await analista.start("eval-run", { ids: chosen.map((q) => q.id) });
    } catch (e) {
      setError(errorText(e));
      setRunning(false);
    }
  }

  async function open(run: EvalRun) {
    try {
      setDetail(await analista.evalDetail(run.id));
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!bank) return error ? <Notice>{error}</Notice> : <Skeleton height={240} />;
  const last = runs.find((r) => r.passRate !== null);

  return (
    <div className="an-quality">
      {error && <Notice>{error}</Notice>}
      <Card>
        <div className="an-recs-head">
          <div>
            <h2>Calidad</h2>
            <p className="muted">
              Preguntas con respuesta conocida: las cifras se calculan con tus datos de hoy (nunca respuestas guardadas) y se comparan con lo que contesta el Analista. Las de criterio las califica un juez barato (Haiku) con una rúbrica estricta; si no puede decidir, la pregunta sale del cálculo.
            </p>
          </div>
          <div className="an-quality-score" aria-live="polite">
            <strong>{last ? pct(last.passRate) : "—"}</strong>
            <small>{last ? `última evaluación (${last.passed} de ${last.passed + last.failed})` : "sin evaluaciones"}</small>
          </div>
        </div>
        <Trend runs={runs} />
      </Card>

      <Card>
        <h3>Preguntas del banco</h3>
        <ul className="an-bank">
          {bank.map((q) => (
            <li key={q.id}>
              <label>
                <input type="checkbox" disabled={!!q.skip || running} checked={selected.has(q.id) && !q.skip} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(q.id); else n.delete(q.id); return n; })} />
                <span>{q.question}</span>
              </label>
              <Pill tone={q.skip ? "gray" : "amber"}>{q.skip ? "No aplica" : CATEGORY[q.category]}</Pill>
            </li>
          ))}
        </ul>
        <div className="an-run-bar">
          <p className="muted">
            Se harán <strong>{claudeRuns}</strong> {claudeRuns === 1 ? "consulta" : "consultas"} a Claude{judgeRuns ? ` + hasta ${judgeRuns} del juez` : ""}. {estimate && estimate.skipped ? `${estimate.skipped} no aplican con tus datos actuales.` : ""}
          </p>
          {running ? (
            <button className="btn danger" onClick={() => void analista.cancel().catch((e) => setError(errorText(e)))}>
              <Square size={14} aria-hidden /> Cancelar
            </button>
          ) : (
            <button className="btn" onClick={() => void start()} disabled={!claudeRuns}>
              <Play size={14} aria-hidden /> Ejecutar evaluación
            </button>
          )}
        </div>
        {progress && (
          <p className="an-progress" role="status">
            Pregunta {progress.index + 1} de {progress.total}: {progress.question} <span className="muted">· {progress.phase}</span>
          </p>
        )}
      </Card>

      <Card>
        <h3>Historial</h3>
        {!runs.length ? (
          <p className="muted">Todavía no has ejecutado ninguna evaluación.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Fecha</th><th>Acierto</th><th>Pasaron</th><th>Fallaron</th><th>Excluidas</th><th>Estado</th><th /></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{when(r.ts)}</td>
                    <td className="num">{pct(r.passRate)}</td>
                    <td>{r.passed}</td>
                    <td>{r.failed}</td>
                    <td>{r.excluded}</td>
                    <td><Pill tone={r.status === "done" ? "green" : r.status === "running" ? "amber" : "gray"}>{r.status === "done" ? "Completa" : r.status === "running" ? "En curso" : "Cancelada"}</Pill></td>
                    <td><button className="btn ghost sm" onClick={() => void open(r)}>Ver detalle</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {detail && (
        <Card>
          <h3>Detalle de la evaluación {detail.run ? `del ${when(detail.run.ts)}` : ""}</h3>
          <ul className="an-results">
            {[...detail.results].sort((a, b) => (a.status === "fail" ? -1 : 0) - (b.status === "fail" ? -1 : 0)).map((r) => (
              <li key={r.id} className={r.status}>
                <div>
                  <Pill tone={STATUS[r.status].tone}>{STATUS[r.status].text}</Pill> <strong>{r.question}</strong>
                </div>
                <p className="muted">{r.detail}</p>
                {r.status !== "pass" && r.expected && <p><small>Esperado: {r.expected}</small></p>}
                {r.status === "fail" && r.answer && <details><summary>Ver la respuesta</summary><pre className="an-answer">{r.answer}</pre></details>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
