import { useMemo, useState } from "react";
import { COUNTRY_NAMES, SOURCE_LABEL, countryName, formatMoney, type Voucher, type VoucherStatus } from "../../lib/adsApi";
import { Pill } from "../ui";

export type VoucherFilter = "all" | "valid" | "review" | "accepted";

const TONE: Record<VoucherStatus, "green" | "amber" | "red"> = { valid: "green", accepted: "green", review: "amber", invalid: "red" };

/** Not valid in the sheet and not accepted by hand yet. */
const isPending = (v: Voucher) => v.status === "review" || v.status === "invalid";

interface Props {
  vouchers: Voucher[];
  filter: VoucherFilter;
  onFilter: (filter: VoucherFilter) => void;
  onCountry: (key: string, code: string) => void;
  /** Accepts a payment by hand (or undoes it). Only the app changes, never the sheet. */
  onAccept: (key: string, undo: boolean) => Promise<void>;
}

export default function VouchersPanel({ vouchers, filter, onFilter, onCountry, onAccept }: Props) {
  // Key of the payment waiting for the inline confirmation, and of the one being saved.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const counts = useMemo(
    () => ({
      all: vouchers.length,
      valid: vouchers.filter((v) => v.status === "valid" || v.status === "accepted").length,
      review: vouchers.filter(isPending).length,
      accepted: vouchers.filter((v) => v.status === "accepted").length,
    }),
    [vouchers],
  );

  const shown = useMemo(
    () =>
      vouchers.filter((v) => {
        if (filter === "valid") return v.status === "valid" || v.status === "accepted";
        if (filter === "review") return isPending(v);
        if (filter === "accepted") return v.status === "accepted";
        return true;
      }),
    [vouchers, filter],
  );

  const act = async (key: string, undo: boolean) => {
    setSaving(key);
    try {
      await onAccept(key, undo);
    } finally {
      setSaving(null);
      setConfirming(null);
    }
  };

  const chip = (id: VoucherFilter, label: string, count: number) => (
    <button key={id} className={`chip ads-chip ${filter === id ? "on" : ""}`} aria-pressed={filter === id} onClick={() => onFilter(id)}>
      {label} <span className="muted">{id === "review" ? `(${count})` : count}</span>
    </button>
  );

  return (
    <>
      <div className="chips" role="group" aria-label="Filtrar comprobantes">
        {chip("all", "Todos", counts.all)}
        {chip("valid", "Válidos", counts.valid)}
        {chip("review", "Por revisar", counts.review)}
        {chip("accepted", "Validados a mano", counts.accepted)}
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
              {shown.slice(0, 300).map((v) => (
                <tr key={v.key} className={isPending(v) ? "ads-review" : ""}>
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
                  <td>
                    {v.status === "accepted" ? (
                      <>
                        <Pill tone="green">Validado a mano</Pill>
                        <span className="muted ads-sub">En la hoja: {v.result || "Sin resultado"}</span>
                        <button className="btn ghost sm" disabled={saving === v.key} onClick={() => void act(v.key, true)}>Deshacer</button>
                      </>
                    ) : (
                      <>
                        <Pill tone={TONE[v.status]}>{v.result || "Sin resultado"}</Pill>
                        {isPending(v) && confirming !== v.key && (
                          <button className="btn ghost sm" onClick={() => setConfirming(v.key)}>Aceptar</button>
                        )}
                        {isPending(v) && confirming === v.key && (
                          <span className="ads-confirm" role="group" aria-label="Confirmar aceptación">
                            <span className="muted ads-sub">¿Aceptar este pago como válido? Solo cambia en la app, no en la hoja.</span>
                            <button className="btn sm" disabled={saving === v.key} onClick={() => void act(v.key, false)}>Sí, aceptar</button>
                            <button className="btn ghost sm" disabled={saving === v.key} onClick={() => setConfirming(null)}>Cancelar</button>
                          </span>
                        )}
                      </>
                    )}
                  </td>
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
