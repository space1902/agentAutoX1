import { useMemo, useState } from "react";
import { formatMoney, type Voucher, type VoucherStatus } from "../../lib/adsApi";
import { Pill } from "../ui";

type Filter = "all" | "valid" | "review";

const TONE: Record<VoucherStatus, "green" | "amber" | "red"> = { valid: "green", review: "amber", invalid: "red" };

export default function VouchersPanel({ vouchers, reviewCount }: { vouchers: Voucher[]; reviewCount: number }) {
  const [filter, setFilter] = useState<Filter>("all");

  const shown = useMemo(
    () => vouchers.filter((v) => (filter === "all" ? true : filter === "valid" ? v.status === "valid" : v.status !== "valid")),
    [vouchers, filter],
  );

  const chip = (id: Filter, label: string, count: number) => (
    <button key={id} className={`chip ads-chip ${filter === id ? "on" : ""}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>
      {label} <span className="muted">{count}</span>
    </button>
  );

  return (
    <>
      <div className="chips" role="group" aria-label="Filtrar comprobantes">
        {chip("all", "Todos", vouchers.length)}
        {chip("valid", "Válidos", vouchers.length - reviewCount)}
        {chip("review", "A revisar", reviewCount)}
      </div>
      {shown.length === 0 ? (
        <p className="muted">No hay comprobantes con este filtro.</p>
      ) : (
        <div className="table-wrap ads-vouchers">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th className="num">Valor</th>
                <th>Banco</th>
                <th>Flujo</th>
                <th>Anuncio</th>
                <th>Cliente</th>
                <th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 300).map((v, i) => (
                <tr key={`${v.registered}-${i}`} className={v.status === "valid" ? "" : "ads-review"}>
                  <td>{v.date}</td>
                  <td className="num">{formatMoney(v.valor)}</td>
                  <td>{v.bank || "—"}</td>
                  <td>{v.flow || "—"}</td>
                  <td>{v.ct}{v.adName ? <span className="muted"> · {v.adName}</span> : null}</td>
                  <td className="muted">{v.phoneMasked || "—"}</td>
                  <td><Pill tone={TONE[v.status]}>{v.result || "Sin resultado"}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > 300 && <p className="muted">Se muestran los primeros 300 de {shown.length}.</p>}
        </div>
      )}
    </>
  );
}
