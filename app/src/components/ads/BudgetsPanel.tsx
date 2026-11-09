import { Info } from "lucide-react";
import { dmy, type BudgetCampaign, type BudgetChange, type BudgetPlan } from "../../lib/adsApi";
import { campaignHeadline, formatBudget, metricPairs, shortRange, signedPct, suggestionLine } from "../../lib/adsBudgets";
import { Card, Pill, Skeleton } from "../ui";

function ChangesTable({ campaign, days }: { campaign: BudgetCampaign; days: { before: number; after: number } }) {
  if (campaign.changes.length === 0) return <p className="muted ads-note">No hay cambios de presupuesto de esta campaña en el rango elegido.</p>;
  return (
    <div className="table-wrap">
      <table className="ads-table bud-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>De → A</th>
            <th className="num">Cambio</th>
            <th className="num" title="Días desde el cambio hasta hoy">Días</th>
            <th>Resultado</th>
            <th className="num" title={`Gasto con IVA: ${days.before} días antes → ${days.after} días desde el cambio`}>Gasto</th>
            <th className="num">Ventas</th>
            <th className="num" title="Valor / gasto sin IVA">ROAS</th>
            <th className="num">Costo por venta</th>
            <th className="num">% conversión</th>
          </tr>
        </thead>
        <tbody>
          {campaign.changes.map((c) => (
            <ChangeRow key={c.id} change={c} currency={campaign.budgetCurrency} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangeRow({ change: c, currency }: { change: BudgetChange; currency: string }) {
  const m = metricPairs(c.before, c.after);
  const cells = [m.gasto, m.ventas, m.roas, m.costoVenta, m.conversion];
  return (
    <tr>
      <td>
        {dmy(c.date)}
        {c.exact ? "" : <span className="muted" title="Se detectó al leer el presupuesto: la fecha es aproximada."> ~</span>}
      </td>
      <td>
        {formatBudget(c.oldBudget, currency)} → {formatBudget(c.newBudget, currency)}
      </td>
      <td className="num">{signedPct(c.pct)}</td>
      <td className="num">{c.daysSince}</td>
      <td>
        <Pill tone={c.status.tone}>{c.status.label}</Pill>
      </td>
      {cells.map((pair, i) => (
        <td key={i} className="num bud-pair" title={`Antes ${shortRange(c.before.from, c.before.to)} → después ${shortRange(c.after.from, c.after.to)}${c.complete ? "" : " (aún incompleto)"}`}>
          <span className="muted">{pair[0]}</span> → <span className={c.complete ? "" : "muted"}>{pair[1]}</span>
        </td>
      ))}
    </tr>
  );
}

function CampaignCard({ campaign, days }: { campaign: BudgetCampaign; days: { before: number; after: number } }) {
  const s = campaign.suggestion;
  return (
    <article className="bud-campaign">
      <header className="bud-head">
        <div>
          <h3>{campaign.name}</h3>
          <span className="muted">{campaign.accountName ? `${campaign.accountName} · ` : ""}{campaignHeadline(campaign)}</span>
        </div>
        {!campaign.active && <Pill tone="gray">{campaign.paused ? "Apagada" : "Sin gasto reciente"}</Pill>}
      </header>
      {s && (
        <div className={`bud-suggest ${s.action.tone}`}>
          <div className="bud-suggest-head">
            <Pill tone={s.action.tone}>{s.action.label}</Pill>
            <span className="muted">{suggestionLine(s)}</span>
          </div>
          <p className="bud-reason">{s.reason}</p>
          {s.detail && <p className="muted bud-detail">{s.detail}</p>}
        </div>
      )}
      <ChangesTable campaign={campaign} days={days} />
    </article>
  );
}

interface Props {
  plan: BudgetPlan | null;
  loading: boolean;
}

/** Budget changes per campaign (3 days before vs after) and the suggested next budget. Suggestions only: nothing is changed in Meta. */
export default function BudgetsPanel({ plan, loading }: Props) {
  if (!plan) return loading ? <Skeleton /> : <p className="muted">Aún no hay datos de presupuestos.</p>;
  const days = { before: plan.settings.windowDays, after: plan.settings.postBudgetDays };
  const learned = plan.learning.mode === "learned";
  const notes = [...plan.warnings, ...plan.notes];
  return (
    <div className="dec-panel">
      <Card>
        <div className="card-head">
          <h2 className="card-title">Presupuestos</h2>
          <Pill tone={learned ? "green" : "amber"}>{learned ? "Aprendido" : "Aprendiendo"}</Pill>
        </div>
        <p className="bud-learning">{plan.learning.text}</p>
        {learned && plan.learning.buckets.length > 0 && (
          <ul className="muted bud-buckets">
            {plan.learning.buckets.map((b) => (
              <li key={b.key}>
                Subidas de {b.label}: mantuvo el ROAS en {b.successes} de {b.n}
                {b.medianCpaChangePct === null ? "" : ` · costo por venta ${signedPct(b.medianCpaChangePct)} (mediana)`}
              </li>
            ))}
          </ul>
        )}
        <p className="muted ads-note">
          <Info size={12} aria-hidden /> Solo son sugerencias: la app nunca cambia presupuestos en Meta. «Antes» son los {days.before} días previos al cambio y «después» los {days.after} días desde el día del cambio (ese día cuenta como el día 1).
          Una subida se mide cuando esos {days.after} días terminaron y no hubo otro cambio de presupuesto dentro de ellos.
        </p>
        {notes.map((n) => (
          <p key={n.message} className="ads-warn" role="status">{n.message}</p>
        ))}
      </Card>
      {plan.campaigns.length === 0 ? (
        <Card>
          <p className="muted">No hay campañas activas ni cambios de presupuesto en este rango y con estos filtros.</p>
        </Card>
      ) : (
        plan.campaigns.map((c) => (
          <Card key={c.campaignId}>
            <CampaignCard campaign={c} days={days} />
          </Card>
        ))
      )}
    </div>
  );
}
