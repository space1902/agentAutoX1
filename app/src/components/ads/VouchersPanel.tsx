import { useMemo, useState } from "react";
import { COUNTRY_NAMES, SOURCE_LABEL, countryName, formatMoney, type Voucher, type VoucherStatus } from "../../lib/adsApi";
import { Pill } from "../ui";

type Filter = "all" | "valid" | "review";

const TONE: Record<VoucherStatus, "green" | "amber" | "red"> = { valid: "green", review: "amber", invalid: "red" };

interface Props {
  vouchers: Voucher[];
  reviewCount: number;
  onCountry: (key: string, code: string) => void;
}

export default function VouchersPanel({ vouchers, reviewCount, onCountry }: Props) {
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
                <th>País</th>
                <th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 300).map((v, i) => (
                <tr key={`${v.registered}-${i}`} className={v.status === "valid" ? "" : "ads-review"}>
                  <td>{v.date}{v.gone ? <span className="muted ads-sub" title="Ya no está en la hoja; se conserva en el historial">fuera de la hoja</span> : null}</td>
                  <td className="num">{formatMoney(v.valor)}</td>
                  <td>{v.bank || "—"}</td>
                  <td>{v.flow || "—"}</td>
                  <td>{v.ct}{v.adName ? <span className="muted"> · {v.adName}</span> : null}</td>
                  <td className="muted">{v.phoneMasked || "—"}</td>
                  <td>
                    <select
                      className="input ads-country-select"
                      aria-label="País del comprobante"
                      value={v.country}
                      title={v.country ? `${countryName(v.country)} (${SOURCE_LABEL[v.countrySource] ?? "sin datos"})` : "Sin país"}
                      onChange={(e) => onCountry(v.key, e.target.value)}
                    >
                      <option value="">{v.countrySource === "manual" ? "Quitar manual" : "Sin país"}</option>
                      {[...new Set([...Object.keys(COUNTRY_NAMES), v.country].filter(Boolean))].map((code) => (
                        <option key={code} value={code}>{code} · {countryName(code)}</option>
                      ))}
                    </select>
                    <span className="muted ads-sub">{v.country ? SOURCE_LABEL[v.countrySource] ?? "" : ""}</span>
                  </td>
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
