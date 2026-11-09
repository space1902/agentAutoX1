import { AlertTriangle } from "lucide-react";
import { formatInt, formatMoney, formatPct, formatRoas, vatOf, type CountryRow } from "../../lib/adsApi";

/** Per-country economics: spend (by delivery country), sales (by customer country), value in COP and margin. */
export default function CountriesPanel({ countries, selected, onSelect }: { countries: CountryRow[]; selected: string; onSelect: (code: string) => void }) {
  if (countries.length === 0) return <p className="muted">Todavía no hay datos por país en este rango.</p>;
  const missing = countries.filter((c) => c.rateMissing);
  return (
    <>
      {missing.length > 0 && (
        <p className="ads-warn">
          <AlertTriangle size={14} aria-hidden /> Falta la tasa de cambio a COP de {missing.map((c) => c.name).join(", ")}: mientras tanto sus valores se muestran sin convertir. Defínela en Configuración.
        </p>
      )}
      <div className="table-wrap">
        <table className="ads-table">
          <thead>
            <tr>
              <th>País</th>
              <th className="num">Gasto</th>
              <th className="num">Ventas</th>
              <th className="num">Valor (COP)</th>
              <th className="num">Comisiones</th>
              <th className="num">Costos e impuestos</th>
              <th className="num">Margen bruto</th>
              <th className="num">Margen %</th>
              <th className="num" title="Valor / gasto sin IVA">ROAS</th>
            </tr>
          </thead>
          <tbody>
            {countries.map((c) => (
              <tr key={c.country || "none"} className={selected === c.country && c.country ? "ads-selected" : ""}>
                <td>
                  <button className="ads-sort" onClick={() => onSelect(c.country)} disabled={!c.country} title={c.country ? "Filtrar por este país" : undefined}>
                    <strong>{c.name}</strong>
                  </button>
                  <div className="muted ads-sub">{c.currency}{c.currency !== "COP" ? ` · 1 = ${formatMoney(c.rateToCop)}` : ""}</div>
                </td>
                <td className="num">
                  {formatMoney(c.gasto)}
                  {vatOf(c) > 0 && <div className="muted ads-vat">IVA {formatMoney(vatOf(c))}</div>}
                </td>
                <td className="num">{formatInt(c.ventas)}</td>
                <td className="num">{formatMoney(c.valor)}</td>
                <td className="num">{formatMoney(c.comisiones)}</td>
                <td className="num">{formatMoney(c.costos + c.impuestos)}</td>
                <td className={`num ${c.margen < 0 ? "ads-neg" : ""}`}>{formatMoney(c.margen)}</td>
                <td className="num">{c.valor > 0 ? formatPct(c.margenPct) : "—"}</td>
                <td className="num">{c.gasto > 0 ? formatRoas(c.roas) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
