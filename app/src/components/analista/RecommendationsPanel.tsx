import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { analista, type RecMetrics, type Recommendation } from "../../lib/analistaApi";
import { Card, Notice, Pill, Skeleton, type PillTone } from "../ui";

const ACTION: Record<string, string> = { escalar: "Escalar", subir_presupuesto: "Subir presupuesto", duplicar: "Duplicar", mantener: "Mantener", bajar: "Bajar", apagar: "Apagar" };
const LABEL: Record<string, { text: string; tone: PillTone }> = {
  acierto: { text: "Acierto", tone: "green" },
  fallo: { text: "Fallo", tone: "red" },
  neutral: { text: "Neutral", tone: "gray" },
  sin_datos: { text: "Sin datos", tone: "amber" },
};
const FOLLOWED: Record<string, string> = { yes: "Sí", no: "No", unknown: "—" };
const money = (n?: number | null) => (n === undefined || n === null ? "—" : `$${Math.round(n).toLocaleString("es-CO")}`);
const roas = (n?: number) => (n === undefined ? "—" : n.toFixed(2).replace(".", ","));

function Metrics({ m }: { m?: RecMetrics }) {
  if (!m || m.gasto === undefined) return <span className="muted">—</span>;
  return (
    <span>
      ROAS <strong>{roas(m.roas)}</strong> · {money(m.gastoDia)}/día · {(m.ventasDia ?? 0).toFixed(1).replace(".", ",")} ventas/día
    </span>
  );
}

export default function RecommendationsPanel({ refreshKey }: { refreshKey: number }) {
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRecs((await analista.recommendations()).recommendations);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function measure() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await analista.measureNow();
      setNote(res.evaluated ? `Se midieron ${res.evaluated} recomendaciones.` : "No había recomendaciones listas para medir (se miden cuando pasan los días indicados).");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!recs) return error ? <Notice>{error}</Notice> : <Skeleton height={200} />;

  return (
    <Card className="an-recs">
      <div className="an-recs-head">
        <div>
          <h2>Recomendaciones</h2>
          <p className="muted">Cada recomendación concreta del Analista se guarda con su línea base y se mide con datos reales unos días después. Si la seguiste o no se detecta por los cambios de presupuesto y estado.</p>
        </div>
        <button className="btn secondary" onClick={() => void measure()} disabled={busy}>
          <RefreshCw size={14} aria-hidden /> Medir ahora
        </button>
      </div>
      {error && <Notice>{error}</Notice>}
      {note && <Notice kind="ok">{note}</Notice>}
      {!recs.length ? (
        <p className="muted">Aún no hay recomendaciones. Pídele al Analista que te diga qué escalar o apagar.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th><th>Qué</th><th>Estado</th><th>Línea base</th><th>Después</th><th>¿La seguiste?</th><th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {recs.map((r) => (
                <tr key={r.id}>
                  <td>{r.recDate}</td>
                  <td>
                    <strong>{ACTION[r.action] ?? r.action}{r.params.pct ? ` ${r.params.pct} %` : ""}</strong>
                    <br />
                    <span className="muted">{r.entityLabel || r.entityId}</span>
                  </td>
                  <td><Pill tone={r.status === "pending" ? "amber" : "gray"}>{r.status === "pending" ? `Se mide a los ${r.evalAfterDays} días` : "Medida"}</Pill></td>
                  <td><Metrics m={r.baseline} /></td>
                  <td>{r.outcome ? <Metrics m={r.outcome.after} /> : <span className="muted">—</span>}</td>
                  <td>{FOLLOWED[r.followed]}</td>
                  <td>
                    {r.outcome ? (
                      <>
                        <Pill tone={LABEL[r.outcome.label].tone}>{LABEL[r.outcome.label].text}</Pill>
                        <br />
                        <small className="muted">{r.outcome.explanation}</small>
                      </>
                    ) : (
                      <span className="muted">Pendiente</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
