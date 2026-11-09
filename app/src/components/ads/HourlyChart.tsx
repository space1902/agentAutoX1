import { useState } from "react";
import { formatInt, formatMoney, formatRoas, type HourPoint } from "../../lib/adsApi";
import { hourLabel, inHoursWindow, isWholeDay, type HoursWindow } from "../../lib/adsFilters";
import { niceMax } from "./AdsChart";

const W = 860;
const H = 240;
const PAD = { top: 18, right: 52, bottom: 30, left: 44 };
const TICKS = 4;

const shortMoney = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1).replace(".", ",")} M` : v >= 1000 ? `${Math.round(v / 1000)} k` : String(Math.round(v)));

/** Hand-rolled SVG like the daily chart: 24 bars (sales per hour of registration) plus two lines on the right money axis: value (payments) and spend (with IVA, by delivery hour). The chosen window is highlighted. */
export default function HourlyChart({ data, window: win }: { data: HourPoint[]; window: HoursWindow }) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length !== 24) return null;

  const restricted = !isWholeDay(win);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const clean = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const maxCount = niceMax(Math.max(...data.map((d) => clean(d.ventas)), 1) * 1.1);
  const maxValue = niceMax(Math.max(...data.map((d) => Math.max(clean(d.valor), clean(d.gasto))), 1) * 1.1);
  const slot = innerW / 24;
  const barW = Math.max(4, Math.min(22, slot * 0.6));
  const base = PAD.top + innerH;
  const y = (v: number) => PAD.top + innerH - (Math.min(clean(v), maxCount) / maxCount) * innerH;
  const yv = (v: number) => PAD.top + innerH - (Math.min(clean(v), maxValue) / maxValue) * innerH;
  const cx = (i: number) => PAD.left + slot * i + slot / 2;
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${cx(i).toFixed(1)},${yv(d.valor).toFixed(1)}`).join(" ");
  const spendLine = data.map((d, i) => `${i === 0 ? "M" : "L"}${cx(i).toFixed(1)},${yv(d.gasto).toFixed(1)}`).join(" ");
  const hasSpend = data.some((d) => d.gasto > 0);
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => i / TICKS);
  const total = data.reduce((n, d) => n + d.ventas, 0);
  const peak = data.reduce((best, d) => (d.ventas > best.ventas ? d : best), data[0]);
  const active = hover !== null ? data[hover] : null;
  const leftPct = hover !== null ? (cx(hover) / W) * 100 : 0;
  const flip = hover !== null && hover >= 12;

  return (
    <div className="ads-chart ads-hourly">
      <div className="ads-legend" aria-hidden>
        <span><i className="sw valor" /> Ventas (cantidad)</span>
        <span><i className="sw hour-value" /> Valor (pagos)</span>
        <span><i className="sw gasto" /> Gasto (con IVA)</span>
        {restricted && <span><i className="sw window" /> Horario elegido</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Ventas por hora de registro del pago. ${total} ventas${total > 0 ? `; la hora con más ventas es ${hourLabel(peak.hour)} con ${peak.ventas}` : ""}.`} preserveAspectRatio="xMidYMid meet" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(maxCount * t)} y2={y(maxCount * t)} className="grid" />
            <text x={PAD.left - 8} y={y(maxCount * t) + 4} textAnchor="end" className="axis">{Number.isInteger(maxCount * t) ? maxCount * t : (maxCount * t).toFixed(1).replace(".", ",")}</text>
            <text x={W - PAD.right + 8} y={yv(maxValue * t) + 4} className="axis hour-axis">{shortMoney(maxValue * t)}</text>
          </g>
        ))}
        {restricted && data.map((d, i) => (inHoursWindow(d.hour, win) ? <rect key={`w${d.hour}`} x={PAD.left + slot * i} y={PAD.top} width={slot} height={innerH} className="window-band" /> : null))}
        {hover !== null && <rect x={PAD.left + slot * hover} y={PAD.top} width={slot} height={innerH} className="hover-band" />}
        {data.map((d, i) => (
          <g key={d.hour}>
            <rect x={cx(i) - barW / 2} y={y(d.ventas)} width={barW} height={Math.max(0, base - y(d.ventas))} rx={2} className={`bar valor ${restricted && !inHoursWindow(d.hour, win) ? "out" : ""}`} />
            {i % 2 === 0 && <text x={cx(i)} y={H - 10} textAnchor="middle" className="axis">{String(d.hour).padStart(2, "0")}</text>}
          </g>
        ))}
        <path d={line} className="hour-line" fill="none" />
        {hasSpend && <path d={spendLine} className="hour-spend-line" fill="none" />}
        {data.map((d, i) => <circle key={d.hour} cx={cx(i)} cy={yv(d.valor)} r={hover === i ? 4.5 : 2.5} className="hour-dot" />)}
        {hasSpend && data.map((d, i) => <circle key={`g${d.hour}`} cx={cx(i)} cy={yv(d.gasto)} r={hover === i ? 4 : 2} className="hour-spend-dot" />)}
        {data.map((d, i) => (
          <rect key={`h${d.hour}`} x={PAD.left + slot * i} y={PAD.top} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} onMouseMove={() => setHover(i)} />
        ))}
      </svg>
      {active && (
        <div className="ads-tooltip" role="status" style={{ left: `${leftPct}%`, transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}>
          <strong>{hourLabel(active.hour)} – {String(active.hour).padStart(2, "0")}:59</strong>
          <span>Gasto (con IVA): {formatMoney(active.gasto)}</span>
          <span className="muted">IVA: {formatMoney(active.vat)}</span>
          <span>Valor (pagos): {formatMoney(active.valor)}</span>
          <span>Ventas: {formatInt(active.ventas)}</span>
          <span>ROAS (sin IVA): {active.spendNet > 0 ? formatRoas(active.roas) : "—"}</span>
          {restricted && <span className="muted">{inHoursWindow(active.hour, win) ? "Dentro del horario elegido" : "Fuera del horario elegido"}</span>}
        </div>
      )}
    </div>
  );
}
