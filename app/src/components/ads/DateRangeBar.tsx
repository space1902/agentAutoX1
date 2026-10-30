import { Check } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Preset } from "../../lib/adsApi";
import { rangeProblem } from "../../lib/adsView";

export const PRESETS: { id: Exclude<Preset, "custom">; label: string }[] = [
  { id: "today", label: "Hoy" },
  { id: "yesterday", label: "Ayer" },
  { id: "week", label: "Últimos 7 días" },
  { id: "month", label: "Este mes" },
];

interface Props {
  preset: Preset;
  range: { from: string; to: string };
  today: string;
  /** First day of the stored history (the inputs cannot go before it). */
  minDate: string | null;
  onPreset: (preset: Exclude<Preset, "custom">) => void;
  onRange: (from: string, to: string) => void;
  /** Extra controls on the right (the update button). */
  children?: ReactNode;
}

/**
 * Presets plus two explicit date inputs that always show the active range. A preset applies when clicked; a custom
 * range is edited freely and applied with "Aplicar" (only when valid). One component, but every page keeps its own range.
 */
export default function DateRangeBar({ preset, range, today, minDate, onPreset, onRange, children }: Props) {
  const [draft, setDraft] = useState(range);
  useEffect(() => setDraft(range), [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const problem = rangeProblem(draft.from, draft.to, minDate, today);
  const changed = draft.from !== range.from || draft.to !== range.to || preset !== "custom";
  const change = (patch: Partial<typeof draft>) => setDraft({ ...draft, ...patch });
  const apply = () => {
    if (!problem) onRange(draft.from, draft.to);
  };

  return (
    <div className="ads-range">
      <div className="ads-controls">
        <div className="ia-tabs" role="tablist" aria-label="Rango de fechas">
          {PRESETS.map((p) => (
            <button key={p.id} role="tab" aria-selected={preset === p.id} className={`ia-tab ${preset === p.id ? "active" : ""}`} onClick={() => onPreset(p.id)}>
              {p.label}
            </button>
          ))}
          <button role="tab" aria-selected={preset === "custom"} className={`ia-tab ${preset === "custom" ? "active" : ""}`} onClick={apply} disabled={Boolean(problem)} title="Aplica las fechas de abajo">
            Personalizado
          </button>
        </div>
        <div className="ads-dates" role="group" aria-label="Fechas del rango">
          <label className="ads-date">
            <span>Desde</span>
            <input className="input" type="date" value={draft.from} min={minDate ?? undefined} max={draft.to || today} onChange={(e) => change({ from: e.target.value })} />
          </label>
          <span className="muted" aria-hidden>→</span>
          <label className="ads-date">
            <span>Hasta</span>
            <input className="input" type="date" value={draft.to} min={draft.from || minDate || undefined} max={today} onChange={(e) => change({ to: e.target.value })} />
          </label>
        </div>
        <button className="btn secondary sm" disabled={Boolean(problem) || !changed} onClick={apply}>
          <Check size={14} aria-hidden /> Aplicar
        </button>
        {children}
      </div>
      {problem && <p className="ads-warn" role="alert">{problem}</p>}
    </div>
  );
}
