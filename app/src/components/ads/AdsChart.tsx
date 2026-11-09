import { useState } from "react";
import { formatMoney, formatRoas, vatOf, type DayPoint } from "../../lib/adsApi";

const W = 860;
const H = 260;
const PAD = { top: 22, right: 48, bottom: 30, left: 60 };
const TICKS = 4;

const comma = (n: number, digits = 1) => n.toFixed(digits).replace(".", ",");
const shortMoney = (v: number) => (v >= 1_000_000 ? `${comma(v / 1_000_000)} M` : v >= 1000 ? `${Math.round(v / 1000)} k` : String(Math.round(v)));

/** Rounds a maximum up to 1, 2, 2.5, 5 or 10 times a power of ten, so the axis ends on a round number. */
export function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Hand-rolled SVG: grouped bars (Gasto vs Valor per day) and the ROAS line on the right axis, with a hover tooltip. */
export default function AdsChart({ data }: { data: DayPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return null;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const clean = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  // Both axes end on a round number above the data, so bars and ROAS points always sit inside the plot.
  const maxMoney = niceMax(Math.max(...data.map((d) => Math.max(clean(d.gasto), clean(d.valor)))) * 1.05);
  const maxRoas = niceMax(Math.max(...data.map((d) => clean(d.roas))) * 1.15);
  const slot = innerW / data.length;
  const barW = Math.max(2, Math.min(26, slot * 0.36));
  const y = (v: number) => PAD.top + innerH - (Math.min(clean(v), maxMoney) / maxMoney) * innerH;
  const yr = (v: number) => PAD.top + innerH - (Math.min(clean(v), maxRoas) / maxRoas) * innerH;
  const cx = (i: number) => PAD.left + slot * i + slot / 2;
  const base = PAD.top + innerH;
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${cx(i).toFixed(1)},${yr(d.roas).toFixed(1)}`).join(" ");
  const step = Math.max(1, Math.ceil(data.length / 10));
  const showLabels = data.length <= 14;
  const active = hover !== null ? data[hover] : null;
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => i / TICKS);
  // Tooltip stays inside the chart: it opens to the right of the day, or to the left in the right half.
  const leftPct = hover !== null ? (cx(hover) / W) * 100 : 0;
  const flip = hover !== null && hover >= data.length / 2;

  return (
    <div className="ads-chart">
      <div className="ads-legend" aria-hidden>
        <span><i className="sw gasto" /> Gasto (con IVA)</span>
        <span><i className="sw valor" /> Valor (pagos)</span>
        <span><i className="sw roas" /> ROAS (valor / gasto sin IVA)</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gasto contra valor por día, con línea de ROAS" preserveAspectRatio="xMidYMid meet" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(maxMoney * t)} y2={y(maxMoney * t)} className="grid" />
            <text x={PAD.left - 8} y={y(maxMoney * t) + 4} textAnchor="end" className="axis">{shortMoney(maxMoney * t)}</text>
            <text x={W - PAD.right + 8} y={yr(maxRoas * t) + 4} className="axis roas-axis">{comma(maxRoas * t, maxRoas < 5 ? 2 : 1)}</text>
          </g>
        ))}
        {hover !== null && <rect x={PAD.left + slot * hover} y={PAD.top} width={slot} height={innerH} className="hover-band" />}
        {data.map((d, i) => (
          <g key={d.date}>
            <rect x={cx(i) - barW - 1} y={y(d.gasto)} width={barW} height={Math.max(0, base - y(d.gasto))} rx={2} className="bar gasto" />
            <rect x={cx(i) + 1} y={y(d.valor)} width={barW} height={Math.max(0, base - y(d.valor))} rx={2} className="bar valor" />
            {i % step === 0 && <text x={cx(i)} y={H - 10} textAnchor="middle" className="axis">{d.date.slice(5).replace("-", "/")}</text>}
          </g>
        ))}
        <path d={line} className="roas-line" fill="none" />
        {data.map((d, i) => <circle key={d.date} cx={cx(i)} cy={yr(d.roas)} r={hover === i ? 4.5 : 3} className="roas-dot" />)}
        {showLabels && data.map((d, i) => (d.roas > 0 ? <text key={d.date} x={cx(i)} y={Math.max(PAD.top - 4, yr(d.roas) - 7)} textAnchor="middle" className="roas-label">{comma(d.roas, 2)}</text> : null))}
        {data.map((d, i) => (
          <rect key={d.date} x={PAD.left + slot * i} y={PAD.top} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} onMouseMove={() => setHover(i)} />
        ))}
      </svg>
      {active && (
        <div className="ads-tooltip" role="status" style={{ left: `${leftPct}%`, transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}>
          <strong>{active.date.split("-").reverse().join("/")}</strong>
          <span>Gasto (con IVA): {formatMoney(active.gasto)}</span>
          <span className="muted">IVA: {formatMoney(vatOf(active))}</span>
          <span>Valor (pagos): {formatMoney(active.valor)}</span>
          <span>ROAS (sin IVA): {active.gasto > 0 ? formatRoas(active.roas) : "—"}</span>
        </div>
      )}
    </div>
  );
}
