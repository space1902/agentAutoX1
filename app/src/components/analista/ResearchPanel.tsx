import { Rocket } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { type AgentApi, type LaunchComparison, type ResearchReport, type ResearchThresholds } from "../../lib/agentApi";
import { Card, Notice, Pill, Skeleton, type PillTone } from "../ui";

const VERDICT: Record<ResearchReport["verdict"], { label: string; tone: PillTone }> = {
  saturado: { label: "Saturado", tone: "red" },
  competitivo: { label: "Competitivo", tone: "amber" },
  hueco: { label: "Hueco", tone: "green" },
};
const RESULT: Record<string, { label: string; tone: PillTone }> = {
  acierto: { label: "Funcionó", tone: "green" },
  fallo: { label: "No funcionó", tone: "red" },
  neutral: { label: "Intermedio", tone: "gray" },
  sin_datos: { label: "Sin datos", tone: "amber" },
};
const num = (v: string) => {
  const n = Number(v.replace(",", "."));
  return v.trim() && Number.isFinite(n) ? n : undefined;
};

function LaunchForm({ report, api, onDone }: { report: ResearchReport; api: AgentApi; onDone: (res: LaunchComparison) => void }) {
  const [f, setF] = useState({ product: "", ct: "", roas: "", ticket: "", cpm: "", conv: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onDone(
        await api.markLaunched({
          reportId: report.id, product: f.product.trim() || undefined, ctCode: f.ct.trim() || undefined, roas: num(f.roas), ticket: num(f.ticket), costPerMessage: num(f.cpm),
          conversion: f.conv.trim() ? (num(f.conv) ?? 0) / 100 : undefined,
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rs-launch">
      <p className="muted">Escribe el CT de sus anuncios y uso el resultado real del Analista (solo lectura). Si no hay anuncios, escribe lo que sepas: ROAS, o ticket, costo por mensaje y conversión.</p>
      <div className="rs-grid">
        <input className="input" placeholder="Nombre del producto" aria-label="Producto" value={f.product} onChange={set("product")} />
        <input className="input" placeholder="CT (por ejemplo CT 14)" aria-label="Código CT" value={f.ct} onChange={set("ct")} />
        <input className="input" placeholder="ROAS real" aria-label="ROAS" inputMode="decimal" value={f.roas} onChange={set("roas")} />
        <input className="input" placeholder="Ticket" aria-label="Ticket" inputMode="decimal" value={f.ticket} onChange={set("ticket")} />
        <input className="input" placeholder="Costo por mensaje" aria-label="Costo por mensaje" inputMode="decimal" value={f.cpm} onChange={set("cpm")} />
        <input className="input" placeholder="Conversión % (mensaje a venta)" aria-label="Conversión" inputMode="decimal" value={f.conv} onChange={set("conv")} />
      </div>
      {error && <Notice>{error}</Notice>}
      <button className="btn sm" onClick={() => void save()} disabled={busy}>
        <Rocket size={13} aria-hidden /> Guardar el lanzamiento
      </button>
    </div>
  );
}

export default function ResearchPanel({ api, refreshKey }: { api: AgentApi; refreshKey: number }) {
  const [reports, setReports] = useState<ResearchReport[] | null>(null);
  const [thresholds, setThresholds] = useState<ResearchThresholds | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [answer, setAnswer] = useState<LaunchComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.researchList();
      setReports(res.reports);
      setThresholds(res.thresholds);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!reports) return error ? <Notice>{error}</Notice> : <Skeleton height={200} />;
  return (
    <div className="an-lessons">
      {error && <Notice>{error}</Notice>}
      {thresholds && (
        <Card className="an-summary">
          <p>
            <strong>Umbrales en uso:</strong> saturado desde ~{thresholds.saturated.toLocaleString("es-CO")} anuncios activos, competitivo desde ~{thresholds.competitive.toLocaleString("es-CO")}.
          </p>
          <p className="muted">Cambian solo cuando certificas una lección en la pestaña Lecciones, después de 3 o más lanzamientos medidos. El conteo de la Biblioteca es aproximado y no muestra ventas ni gasto.</p>
        </Card>
      )}
      {answer && (
        <Notice kind="ok">
          {`${answer.informe.tema}: el informe decía «${answer.informe.veredicto}» (${answer.informe.decision}) y en la realidad ${RESULT[answer.real.etiqueta]?.label.toLowerCase() ?? answer.real.etiqueta}${answer.real.roas !== null ? ` (ROAS ${String(answer.real.roas).replace(".", ",")})` : ""}. ${answer.acerto_la_decision === null ? "Todavía no se puede juzgar la decisión." : answer.acerto_la_decision ? "La decisión acertó." : "La decisión falló."} ${answer.aviso ?? ""} ${answer.siguiente}`}
        </Notice>
      )}
      {!reports.length && (
        <Card>
          <p className="muted">Todavía no hay informes. Pídele una investigación al Investigador en el chat y aparecerá aquí.</p>
        </Card>
      )}
      {reports.map((r) => (
        <Card key={r.id} className="an-lesson-group">
          <h3>
            {r.topic} <Pill tone={VERDICT[r.verdict].tone}>{VERDICT[r.verdict].label}</Pill> <Pill tone="gray">{r.decision}</Pill>
            {r.launch && <Pill tone={RESULT[r.launch.label]?.tone ?? "gray"}>{`Lanzado: ${RESULT[r.launch.label]?.label ?? r.launch.label}`}</Pill>}
          </h3>
          <p className="muted">
            {r.date}
            {r.mainTerm ? ` · «${r.mainTerm}» ~${(r.mainCount ?? 0).toLocaleString("es-CO")} anuncios` : ""} · {r.measurements.length} mediciones
          </p>
          <p className="muted"><code>{r.path}</code></p>
          {open === r.id ? (
            <>
              <ul>
                {r.measurements.map((m, i) => (
                  <li key={i}>
                    <span>«{m.term}» en {m.country}: ~{m.count.toLocaleString("es-CO")}</span>
                    <Pill tone={VERDICT[m.verdict].tone}>{VERDICT[m.verdict].label}</Pill>
                  </li>
                ))}
              </ul>
              {!r.launch && <LaunchForm report={r} api={api} onDone={(res) => { setAnswer(res); setOpen(null); void load(); }} />}
            </>
          ) : (
            !r.launch && <button className="btn secondary sm" onClick={() => setOpen(r.id)}>Lo lancé: ver mediciones y registrar el resultado</button>
          )}
        </Card>
      ))}
    </div>
  );
}
