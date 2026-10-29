import { useState } from "react";
import { formatMoney, formatRoas, type DayPoint } from "../../lib/adsApi";

const W = 860;
const H = 260;
const PAD = { top: 16, right: 44, bottom: 30, left: 56 };

const shortMoney = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)} M` : v >= 1000 ? `${Math.round(v / 1000)} k` : String(Math.round(v)));

/** Hand-rolled SVG: grouped bars (Gasto vs Valor per day) and the ROAS line on the right axis. */
export default function AdsChart({ data }: { data: DayPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return null;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const maxMoney = Math.max(1, ...data.map((d) => Math.max(d.gasto, d.valor)));
  const maxRoas = Math.max(1, ...data.map((d) => d.roas));
  const slot = innerW / data.length;
  const barW = Math.min(26, slot * 0.34);
  const y = (v: number) => PAD.top + innerH - (v / maxMoney) * innerH;
  const yr = (v: number) => PAD.top + innerH - (v / maxRoas) * innerH;
  const cx = (i: number) => PAD.left + slot * i + slot / 2;
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${cx(i).toFixed(1)},${yr(d.roas).toFixed(1)}`).join(" ");
  const step = Math.max(1, Math.ceil(data.length / 10));
  const active = hover !== null ? data[hover] : null;

  return (
    <div className="ads-chart">
      <div className="ads-legend" aria-hidden>
        <span><i className="sw gasto" /> Gasto</span>
        <span><i className="sw valor" /> Valor (pagos)</span>
        <span><i className="sw roas" /> ROAS</span>
        {active && (
          <strong className="ads-hover">
            {active.date}: gasto {formatMoney(active.gasto)} · valor {formatMoney(active.valor)} · {active.ventas} ventas · ROAS {formatRoas(active.roas)}
          </strong>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gasto contra valor por día, con línea de ROAS" preserveAspectRatio="xMidYMid meet">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(maxMoney * t)} y2={y(maxMoney * t)} className="grid" />
            <text x={PAD.left - 8} y={y(maxMoney * t) + 4} textAnchor="end" className="axis">{shortMoney(maxMoney * t)}</text>
            <text x={W - PAD.right + 8} y={yr(maxRoas * t) + 4} className="axis roas-axis">{(maxRoas * t).toFixed(1)}</text>
          </g>
        ))}
        {data.map((d, i) => (
          <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={innerH} fill="transparent" />
            <rect x={cx(i) - barW - 1} y={y(d.gasto)} width={barW} height={PAD.top + innerH - y(d.gasto)} rx={3} className="bar gasto" />
            <rect x={cx(i) + 1} y={y(d.valor)} width={barW} height={PAD.top + innerH - y(d.valor)} rx={3} className="bar valor" />
            {i % step === 0 && <text x={cx(i)} y={H - 10} textAnchor="middle" className="axis">{d.date.slice(5).replace("-", "/")}</text>}
          </g>
        ))}
        <path d={line} className="roas-line" fill="none" />
        {data.map((d, i) => <circle key={d.date} cx={cx(i)} cy={yr(d.roas)} r={hover === i ? 4.5 : 3} className="roas-dot" />)}
      </svg>
    </div>
  );
}
