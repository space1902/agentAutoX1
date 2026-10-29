import { Check, EyeOff, RefreshCw, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { dmy, formatInt, formatMoney, formatPct, formatRoas, toIso, type Decision, type DecisionKind, type DecisionStatus, type Lifecycle, type Totals, type TrackingItem } from "../../lib/adsApi";
import { Card, Pill } from "../ui";

type KindFilter = "all" | DecisionKind;

const KIND_LABEL: Record<DecisionKind, string> = { test: "Prueba de anuncio", ct_test: "Prueba de CT", budget: "Presupuesto" };
const FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "test", label: "Anuncios" },
  { id: "ct_test", label: "CT" },
  { id: "budget", label: "Presupuesto" },
];

function Metrics({ m }: { m: Totals }) {
  return (
    <dl className="dec-metrics">
      <div><dt>Gasto</dt><dd>{formatMoney(m.gasto)}</dd></div>
      <div><dt>Mensajes</dt><dd>{formatInt(m.mensajes)}</dd></div>
      <div><dt>Ventas</dt><dd>{formatInt(m.ventas)}</dd></div>
      <div><dt>Valor</dt><dd>{formatMoney(m.valor)}</dd></div>
      <div><dt>ROAS</dt><dd>{m.gasto > 0 ? formatRoas(m.roas) : "—"}</dd></div>
      <div><dt>Costo por venta</dt><dd>{m.ventas > 0 && m.gasto > 0 ? formatMoney(m.costoVenta) : "—"}</dd></div>
      <div><dt>% conversión</dt><dd>{m.mensajes > 0 ? formatPct(m.conversion) : "—"}</dd></div>
    </dl>
  );
}

function DecisionCard({ d, onStatus }: { d: Decision; onStatus: (id: number, status: DecisionStatus) => void }) {
  const isBudget = d.kind === "budget";
  return (
    <article className={`dec-card ${d.status !== "pending" ? "closed" : ""}`}>
      <header className="dec-head">
        <div>
          <span className="muted dec-kind">{KIND_LABEL[d.kind]}</span>
          <h3>{d.label}</h3>
          <span className="muted">
            Día {d.dayN} · {d.range.from === d.range.to ? d.range.from : `${d.range.from} → ${d.range.to}`}
            {d.late ? " · atrasada (la app estaba cerrada)" : ""}
          </span>
        </div>
        <div className="dec-verdict">
          <Pill tone={d.verdict.tone}>{d.verdict.label}</Pill>
          {isBudget && d.extra.suggestedPct ? <span className="muted">Próxima subida sugerida: {d.extra.suggestedPct} %</span> : null}
          {d.status !== "pending" && <span className="muted">{d.status === "done" ? "Hecha" : "Ignorada"}</span>}
        </div>
      </header>
      <p className="dec-reason">{d.reason}</p>
      <Metrics m={d.metrics} />
      {isBudget && d.extra.before && (
        <p className="muted dec-note">
          Antes del cambio ({d.extra.beforeRange?.from} → {d.extra.beforeRange?.to}): ROAS {d.extra.before.gasto > 0 ? formatRoas(d.extra.before.roas) : "—"}, costo por venta{" "}
          {d.extra.before.ventas > 0 ? formatMoney(d.extra.before.costoVenta) : "—"}. Subida de {Math.round(d.extra.changePct ?? 0)} % el {d.extra.changeDate}
          {d.extra.exact ? "" : " (fecha aproximada: se detectó al leer el presupuesto)"}.
        </p>
      )}
      <footer className="dec-actions">
        {d.status === "pending" ? (
          <>
            <button className="btn sm" onClick={() => onStatus(d.id, "done")}><Check size={14} aria-hidden /> Hecho</button>
            <button className="btn secondary sm" onClick={() => onStatus(d.id, "ignored")}><EyeOff size={14} aria-hidden /> Ignorar</button>
          </>
        ) : (
          <button className="btn ghost sm" onClick={() => onStatus(d.id, "pending")}><Undo2 size={14} aria-hidden /> Volver a pendiente</button>
        )}
      </footer>
    </article>
  );
}

const short = (iso?: string) => dmy(iso).slice(0, 5);

/** Informational day counters. Verdicts only come automatically (see the cards below). */
function Following({ items }: { items: TrackingItem[] }) {
  if (items.length === 0) return null;
  return (
    <Card>
      <div className="card-head">
        <h2 className="card-title">Seguimiento</h2>
        <span className="muted">Solo informativo: los veredictos llegan solos</span>
      </div>
      <div className="ads-follow">
        {items.map((i) => {
          const lines: string[] = [];
          if (i.kind === "budget") {
            lines.push(`Día ${i.dayN} desde la subida (${short(i.date)}, +${Math.round(i.pct ?? 0)} %)${i.exact ? "" : " · fecha aproximada"}`);
            if (i.checkDay && i.dayN < i.checkDay) lines.push(`Revisión automática el día ${i.checkDay} (${short(i.checkDate)}) a las ${i.checkAt}`);
            else if (i.checkDay && i.dayN === i.checkDay) lines.push(`Revisión automática hoy a las ${i.checkAt}`);
          } else {
            lines.push(`Día ${i.dayN} desde que empezó a gastar`);
            if (i.verdictDay && i.dayN < i.verdictDay) lines.push(`Prueba: día ${i.dayN} de ${i.testDays} · veredicto el día ${i.verdictDay} (${short(i.verdictDate)}) a las ${i.verdictAt}`);
            else if (i.verdictDay && i.dayN === i.verdictDay) lines.push(`Prueba: veredicto hoy a las ${i.verdictAt}`);
            else if (i.inTest) lines.push(`Prueba: día ${i.dayN} de ${i.testDays}`);
            if (i.raise) lines.push(`Día ${i.raise.dayN} desde la subida (${short(i.raise.date)}, +${Math.round(i.raise.pct)} %)`);
          }
          return (
            <div key={`${i.kind}-${i.id}`} className={`ads-follow-item ${i.kind}`}>
              <strong>{i.kind === "ct" ? i.label : i.kind === "budget" ? `Presupuesto · ${i.label}` : i.label}</strong>
              {lines.map((l) => <span key={l}>{l}</span>)}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

interface Props {
  tracking: TrackingItem[];
  decisions: Decision[];
  activitiesOk: boolean | null;
  lifecycle: Lifecycle | null;
  busy: boolean;
  onStatus: (id: number, status: DecisionStatus) => void;
  onEvaluate: () => void;
}

export default function DecisionsPanel({ tracking, decisions, activitiesOk, lifecycle, busy, onStatus, onEvaluate }: Props) {
  const [kind, setKind] = useState<KindFilter>("all");
  const today = toIso(new Date());

  const { current, history } = useMemo(() => {
    const filtered = decisions.filter((d) => kind === "all" || d.kind === kind);
    const isToday = (d: Decision) => toIso(new Date(d.createdAt)) === today;
    return { current: filtered.filter((d) => d.status === "pending" || isToday(d)), history: filtered.filter((d) => !(d.status === "pending" || isToday(d))) };
  }, [decisions, kind, today]);

  return (
    <div className="dec-panel">
      <Following items={tracking} />
      <Card>
        <div className="card-head">
          <h2 className="card-title">Decisiones del día</h2>
          <button className="btn secondary sm" disabled={busy} onClick={onEvaluate}>
            <RefreshCw size={14} aria-hidden className={busy ? "spin" : ""} /> Evaluar ahora
          </button>
        </div>
        <p className="muted ads-note">
          La app solo te recomienda: nunca cambia presupuestos ni pausa anuncios. Las pruebas se evalúan el día {lifecycle?.testNotifyDay ?? 4} a las {lifecycle?.testNotifyAt ?? "20:00"} y los cambios de presupuesto el día {lifecycle?.postBudgetNotifyDay ?? 2} a las {lifecycle?.postBudgetNotifyAt ?? "20:00"} (hora de la cuenta). El día 1 es el primer día con gasto.
          {activitiesOk === false
            ? " Meta no dejó leer el registro de actividad: los cambios de presupuesto hechos con la app cerrada se detectan en la siguiente lectura y se fechan ese día (aproximado)."
            : " Si cambias un presupuesto con la app cerrada, se detecta en la siguiente lectura; con el registro de actividad de Meta la fecha es exacta."}
        </p>
        <div className="chips" role="group" aria-label="Tipo de decisión">
          {FILTERS.map((f) => (
            <button key={f.id} className={`chip ads-chip ${kind === f.id ? "on" : ""}`} aria-pressed={kind === f.id} onClick={() => setKind(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </Card>

      {current.length === 0 && history.length === 0 && (
        <Card>
          <p className="muted">Todavía no hay decisiones. Aparecerán cuando un anuncio llegue al día 4 o cuando detectemos una subida de presupuesto.</p>
        </Card>
      )}
      {current.length > 0 && (
        <section aria-label="Pendientes y de hoy">
          <h3 className="ia-sub">Pendientes y de hoy</h3>
          <div className="dec-list">{current.map((d) => <DecisionCard key={d.id} d={d} onStatus={onStatus} />)}</div>
        </section>
      )}
      {history.length > 0 && (
        <section aria-label="Historial">
          <h3 className="ia-sub">Historial</h3>
          <div className="dec-list">{history.map((d) => <DecisionCard key={d.id} d={d} onStatus={onStatus} />)}</div>
        </section>
      )}
    </div>
  );
}
