import { useMemo, useState } from "react";
import { COUNTRY_NAMES, SOURCE_LABEL, countryName, formatMoney, type Voucher, type VoucherStatus } from "../../lib/adsApi";
import {
  amountProblem,
  filterVouchers,
  hasVoucherFilters,
  parseAmount,
  stateCounts,
  voucherBanks,
  DEFAULT_VOUCHER_FILTERS,
  type VoucherFilters,
  type VoucherState,
} from "../../lib/adsFilters";
import { formatVoucherPhone, phoneDigits, voucherNote } from "../../lib/adsView";
import { Pill } from "../ui";

const STATE_LABELS: [VoucherState, string][] = [
  ["all", "Todos"],
  ["valid", "Válidos"],
  ["review", "Por revisar"],
  ["accepted", "Aceptados a mano"],
  ["rejected", "Descartados"],
  ["gone", "Eliminados de la hoja"],
  ["corrected", "Monto corregido"],
];

const TONE: Record<VoucherStatus, "green" | "amber" | "red"> = { valid: "green", accepted: "green", review: "amber", invalid: "red", rejected: "red" };

/** Not valid in the sheet and not accepted by hand yet (a payment that no longer counts is never pending). */
const isPending = (v: Voucher) => !v.gone && (v.status === "review" || v.status === "invalid");

interface Props {
  vouchers: Voucher[];
  filters: VoucherFilters;
  onFilters: (filters: VoucherFilters) => void;
  /** Ad accounts to offer in the account filter. */
  accounts: { id: string; name: string }[];
  /** Corrects the amount of a payment (null restores the sheet value). Only the app changes, never the sheet. */
  onValue: (key: string, valor: number | null) => Promise<void>;
  onCountry: (key: string, code: string) => void;
  /** Accepts a payment by hand (or undoes it). Only the app changes, never the sheet. */
  onAccept: (key: string, undo: boolean) => Promise<void>;
  /** Discards a payment by hand (or restores it). Only the app changes, never the sheet. */
  onReject: (key: string, undo: boolean) => Promise<void>;
}

type Pending = { key: string; kind: "accept" | "reject" };
/** Amount being edited: first the input, then the confirmation. */
type Editing = { key: string; text: string; step: "input" | "confirm" };

function ClientCell({ v }: { v: Voucher }) {
  const [copied, setCopied] = useState(false);
  const phone = formatVoucherPhone(v.phone);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`+${phoneDigits(v.phone)}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the number stays selectable */
    }
  };
  const payer = v.payerName && v.payerName !== v.clientName ? v.payerName : "";
  return (
    <div className="ads-client">
      <strong>{v.clientName || "Sin nombre"}</strong>
      <span className="ads-client-phone">
        <span>{phone || "Sin teléfono"}</span>
        {phone && (
          <button className="btn ghost sm" onClick={() => void copy()} aria-label="Copiar teléfono" title="Copiar teléfono">
            {copied ? "Copiado" : "Copiar"}
          </button>
        )}
      </span>
      {payer && <span className="muted ads-sub" title="Titular de la cuenta que aparece en el comprobante">Pagó: {payer}</span>}
    </div>
  );
}

export default function VouchersPanel({ vouchers, filters, onFilters, accounts, onValue, onCountry, onAccept, onReject }: Props) {
  // Payment waiting for the inline confirmation (accept or discard), and the key of the one being saved.
  const [confirming, setConfirming] = useState<Pending | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const counts = useMemo(() => stateCounts(vouchers, filters), [vouchers, filters]);
  const shown = useMemo(() => filterVouchers(vouchers, filters), [vouchers, filters]);
  const banks = useMemo(() => voucherBanks(vouchers), [vouchers]);
  const countries = useMemo(() => [...new Set(vouchers.map((v) => v.country).filter(Boolean))].sort(), [vouchers]);
  const hasNoAccount = vouchers.some((v) => v.accountId === "");
  const hasNoCountry = vouchers.some((v) => v.country === "");
  const set = (patch: Partial<VoucherFilters>) => onFilters({ ...filters, ...patch });
  // A saved choice that is not in the list any more is still offered, so the select never lies about what is applied.
  const withCurrent = (options: string[], current: string) => (current && current !== "-" && !options.includes(current) ? [...options, current] : options);

  const saveValue = async (key: string, valor: number | null) => {
    setSaving(key);
    try {
      await onValue(key, valor);
    } finally {
      setSaving(null);
      setEditing(null);
    }
  };

  const act = async (kind: "accept" | "reject", key: string, undo: boolean) => {
    setSaving(key);
    try {
      await (kind === "accept" ? onAccept : onReject)(key, undo);
    } finally {
      setSaving(null);
      setConfirming(null);
    }
  };

  const chip = (id: VoucherState, label: string) => (
    <button key={id} className={`chip ads-chip ${filters.state === id ? "on" : ""}`} aria-pressed={filters.state === id} onClick={() => set({ state: id })}>
      {label} <span className="muted">{id === "review" ? `(${counts[id]})` : counts[id]}</span>
    </button>
  );

  return (
    <>
      <div className="chips" role="group" aria-label="Estado del comprobante">
        {STATE_LABELS.map(([id, label]) => chip(id, label))}
      </div>
      <div className="ads-voucher-filters" role="group" aria-label="Filtrar comprobantes">
        <label>
          <span className="muted">Banco</span>
          <select className="input" value={filters.bank} onChange={(e) => set({ bank: e.target.value })}>
            <option value="">Todos</option>
            {withCurrent(banks, filters.bank).map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        {accounts.length > 0 && (
          <label>
            <span className="muted">Cuenta publicitaria</span>
            <select className="input" value={filters.account} onChange={(e) => set({ account: e.target.value })}>
              <option value="">Todas</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              {(hasNoAccount || filters.account === "-") && <option value="-">Sin cuenta</option>}
            </select>
          </label>
        )}
        <label>
          <span className="muted">País</span>
          <select className="input" value={filters.country} onChange={(e) => set({ country: e.target.value })}>
            <option value="">Todos</option>
            {withCurrent(countries, filters.country).map((c) => <option key={c} value={c}>{c} · {countryName(c)}</option>)}
            {(hasNoCountry || filters.country === "-") && <option value="-">Sin país</option>}
          </select>
        </label>
        <label className="ads-voucher-search">
          <span className="muted">Buscar</span>
          <input className="input" value={filters.search} maxLength={80} placeholder="Nombre o teléfono" aria-label="Buscar comprobante por nombre o teléfono" onChange={(e) => set({ search: e.target.value })} />
        </label>
        {hasVoucherFilters(filters) && (
          <button className="btn ghost sm" onClick={() => onFilters({ ...DEFAULT_VOUCHER_FILTERS })}>Limpiar filtros</button>
        )}
      </div>
      {hasVoucherFilters(filters) && <p className="muted ads-note" role="status">Mostrando {shown.length} de {vouchers.length} comprobantes.</p>}
      {shown.length === 0 ? (
        <p className="muted">No hay comprobantes con estos filtros.</p>
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
                  <td>{v.date}{voucherNote(v) ? <span className="muted ads-sub" title="Se conserva en el historial, pero no suma en ningún total">{voucherNote(v)}</span> : null}</td>
                  <td className="num">
                    {editing?.key === v.key ? (
                      editing.step === "input" ? (
                        <span className="ads-amount-edit">
                          <input
                            className="input"
                            inputMode="numeric"
                            autoFocus
                            value={editing.text}
                            aria-label="Nuevo monto del pago"
                            aria-invalid={amountProblem(editing.text) !== null}
                            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") setEditing(null);
                              if (e.key === "Enter" && parseAmount(editing.text) !== null) setEditing({ ...editing, step: "confirm" });
                            }}
                          />
                          {editing.text.trim() !== "" && amountProblem(editing.text) !== null && <span className="ads-warn ads-sub">{amountProblem(editing.text)}</span>}
                          <span>
                            <button className="btn sm" disabled={parseAmount(editing.text) === null || parseAmount(editing.text) === v.valor} onClick={() => setEditing({ ...editing, step: "confirm" })}>Guardar</button>
                            <button className="btn ghost sm" onClick={() => setEditing(null)}>Cancelar</button>
                          </span>
                        </span>
                      ) : (
                        <span className="ads-confirm" role="group" aria-label="Confirmar monto">
                          <span className="muted ads-sub">¿Cambiar el monto de {formatMoney(v.valor)} a {formatMoney(parseAmount(editing.text) ?? 0)}? Solo cambia en la app, no en la hoja, y puedes restaurar el original.</span>
                          <button className="btn sm" disabled={saving === v.key} onClick={() => { const n = parseAmount(editing.text); if (n !== null) void saveValue(v.key, n === v.valorSheet ? null : n); }}>Sí, cambiar</button>
                          <button className="btn ghost sm" disabled={saving === v.key} onClick={() => setEditing({ ...editing, step: "input" })}>Volver</button>
                        </span>
                      )
                    ) : (
                      <>
                        {formatMoney(v.valor)}
                        {v.valueOverridden && <span className="muted ads-sub" title="El monto fue corregido a mano en la app; la hoja no cambia">Monto corregido (hoja: {formatMoney(v.valorSheet)})</span>}
                        <button className="btn ghost sm" disabled={saving === v.key} onClick={() => setEditing({ key: v.key, text: String(Math.round(v.valor)), step: "input" })}>Editar monto</button>
                        {v.valueOverridden && <button className="btn ghost sm" disabled={saving === v.key} onClick={() => void saveValue(v.key, null)}>Restaurar monto</button>}
                      </>
                    )}
                  </td>
                  <td>{v.bank || "—"}</td>
                  <td>{v.flow || "—"}</td>
                  <td>{v.campaign}{v.adName ? <span className="muted"> · {v.adName}</span> : null}</td>
                  <td><ClientCell v={v} /></td>
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
                    {v.rejected ? (
                      <>
                        <Pill tone="red">Descartado</Pill>
                        <span className="muted ads-sub">En la hoja: {v.result || "Sin resultado"}</span>
                        <button className="btn ghost sm" disabled={saving === v.key} onClick={() => void act("reject", v.key, true)}>Restaurar</button>
                      </>
                    ) : (
                      <>
                        {v.status === "accepted" ? (
                          <>
                            <Pill tone="green">Validado a mano</Pill>
                            <span className="muted ads-sub">En la hoja: {v.result || "Sin resultado"}</span>
                            <button className="btn ghost sm" disabled={saving === v.key} onClick={() => void act("accept", v.key, true)}>Deshacer</button>
                          </>
                        ) : (
                          <>
                            <Pill tone={TONE[v.status]}>{v.result || "Sin resultado"}</Pill>
                            {isPending(v) && confirming?.key !== v.key && (
                              <button className="btn ghost sm" onClick={() => setConfirming({ key: v.key, kind: "accept" })}>Aceptar</button>
                            )}
                          </>
                        )}
                        {confirming?.key !== v.key && (
                          <button className="btn ghost sm" onClick={() => setConfirming({ key: v.key, kind: "reject" })}>Descartar</button>
                        )}
                        {confirming?.key === v.key && confirming.kind === "accept" && (
                          <span className="ads-confirm" role="group" aria-label="Confirmar aceptación">
                            <span className="muted ads-sub">¿Aceptar este pago como válido? Solo cambia en la app, no en la hoja.</span>
                            <button className="btn sm" disabled={saving === v.key} onClick={() => void act("accept", v.key, false)}>Sí, aceptar</button>
                            <button className="btn ghost sm" disabled={saving === v.key} onClick={() => setConfirming(null)}>Cancelar</button>
                          </span>
                        )}
                        {confirming?.key === v.key && confirming.kind === "reject" && (
                          <span className="ads-confirm" role="group" aria-label="Confirmar descarte">
                            <span className="muted ads-sub">¿Descartar este pago? Dejará de contarse en todos los totales. Solo cambia en la app, no en la hoja, y puedes restaurarlo.</span>
                            <button className="btn sm" disabled={saving === v.key} onClick={() => void act("reject", v.key, false)}>Sí, descartar</button>
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
