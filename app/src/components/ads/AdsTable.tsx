import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";
import { dayLabel, dmy, formatInt, formatMoney, formatPct, formatRoas, vatOf, type AdRow, type Group } from "../../lib/adsApi";
import { NO_MESSAGES, costPerMessage } from "../../lib/adsFilters";
import { Pill } from "../ui";

type SortKey = "label" | "gasto" | "mensajes" | "costoMensaje" | "ventas" | "valor" | "roas" | "costoVenta" | "conversion" | "margen";

const COLUMNS: { key: SortKey; label: string; numeric: boolean; title?: string }[] = [
  { key: "gasto", label: "Gasto", numeric: true },
  { key: "mensajes", label: "Mensajes", numeric: true },
  { key: "costoMensaje", label: "Costo/mensaje", numeric: true, title: "Gasto con IVA / mensajes" },
  { key: "ventas", label: "Ventas", numeric: true },
  { key: "valor", label: "Valor", numeric: true },
  { key: "roas", label: "ROAS", numeric: true, title: "Valor / gasto sin IVA" },
  { key: "costoVenta", label: "Costo por venta", numeric: true },
  { key: "conversion", label: "% conversión", numeric: true },
  { key: "margen", label: "Margen", numeric: true },
];

const FIRST_COLUMN: Record<Group, string> = { campaign: "Campaña", ad: "Anuncio" };

const NO_DATA = "No hay datos en este rango. Pulsa «Actualizar» para traerlos de Meta y de la hoja de pagos.";

/** `restricted`: an hour window is active, so ROAS-based actions would be misleading and are not shown. */
export default function AdsTable({ rows, group, emptyText = NO_DATA, restricted = false }: { rows: AdRow[]; group: Group; emptyText?: string; restricted?: boolean }) {
  const [sortKey, setSortKey] = useState<SortKey>("roas");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    const factor = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === "label") return a.label.localeCompare(b.label, "es") * factor;
      return ((a[sortKey] ?? -1) - (b[sortKey] ?? -1)) * factor;
    });
  }, [rows, sortKey, dir]);

  const toggle = (key: SortKey) => {
    if (key === sortKey) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setDir("desc");
    }
  };

  const head = (key: SortKey, label: string, numeric: boolean, title?: string) => (
    <th key={key} className={numeric ? "num" : ""} title={title} aria-sort={sortKey === key ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button className="ads-sort" onClick={() => toggle(key)}>
        {label}
        {sortKey === key && (dir === "asc" ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
      </button>
    </th>
  );

  if (rows.length === 0) return <p className="muted">{emptyText}</p>;

  return (
    <div className="table-wrap">
      <table className="ads-table">
        <thead>
          <tr>
            {head("label", FIRST_COLUMN[group], false)}
            {COLUMNS.map((c) => head(c.key, c.label, c.numeric, c.title))}
            <th>Acción</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.key}>
              <td>
                <strong>{r.label}</strong>
                <div className="muted ads-sub">
                  {group === "ad" && <>{r.campaignName || "—"} · </>}
                  {r.ageDays !== null || r.action ? dayLabel(r) : "sin gasto de Meta"}
                  {r.paused ? " · apagada" : ""}
                  {r.raise ? ` · día ${r.raise.dayN} desde la subida (${dmy(r.raise.date).slice(0, 5)}, +${Math.round(r.raise.pct)} %)` : ""}
                  {!r.paused && r.effectiveStatus && r.effectiveStatus !== "ACTIVE" ? ` · ${r.effectiveStatus.toLowerCase()}` : ""}
                </div>
              </td>
              <td className="num">
                {formatMoney(r.gasto)}
                {vatOf(r) > 0 && <div className="muted ads-vat">IVA {formatMoney(vatOf(r))}</div>}
              </td>
              <td className="num">{r.mensajes === null ? <span className="muted">{NO_MESSAGES}</span> : formatInt(r.mensajes)}</td>
              <td className="num">{r.mensajes === null ? <span className="muted">{NO_MESSAGES}</span> : costPerMessage(r) !== null ? formatMoney(costPerMessage(r) as number) : "—"}</td>
              <td className="num">{formatInt(r.ventas)}</td>
              <td className="num">{formatMoney(r.valor)}</td>
              <td className="num" title="Valor / gasto sin IVA">{r.gasto > 0 ? formatRoas(r.roas) : "—"}</td>
              <td className="num">{r.ventas > 0 && r.gasto > 0 ? formatMoney(r.costoVenta) : "—"}</td>
              <td className="num">{r.mensajes === null ? <span className="muted">{NO_MESSAGES}</span> : r.mensajes > 0 && r.conversion !== null ? formatPct(r.conversion) : "—"}</td>
              <td className={`num ${r.margen < 0 ? "ads-neg" : ""}`} title={`Margen ${formatPct(r.margenPct)} del valor`}>{formatMoney(r.margen)}</td>
              <td>{r.action ? <Pill tone={r.action.tone}>{r.action.label}</Pill> : <span className="muted" title={restricted ? "Con horario, el gasto es de todo el día y las ventas solo del horario: la acción no se puede calcular." : undefined}>{restricted ? "N/D con horario" : "—"}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
