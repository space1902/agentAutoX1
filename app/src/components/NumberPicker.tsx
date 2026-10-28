import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { ProfileView, Registry, Selection } from "../lib/api";
import { phoneKey, podPhone } from "../lib/phone";

export interface PickItem {
  key: string;
  /** Phone to show, or null for testers that have no number yet. */
  phone: string | null;
  /** Existing tester id (null for a pod number or external number that has no tester yet). */
  testerId: string | null;
  podName: string | null;
  linked: boolean;
  /** Other profiles that already use this number (allowed, but flagged: profiles run one at a time). */
  usedBy: string[];
  isBot: boolean;
  isNewExternal: boolean;
}

const testerKey = (id: string) => `tester:${id}`;

/** Key of a profile tester inside the picker. */
export function keyOfTester(t: { id: string; phone: string | null }): string {
  return t.phone && phoneKey(t.phone) ? phoneKey(t.phone) : testerKey(t.id);
}

export function initialSelection(profile: ProfileView): string[] {
  return profile.testers.map(keyOfTester);
}

/** Every number that can be picked, from the unified registry plus the externals typed in this session. */
export function buildItems(registry: Registry, externals: Record<string, string>, currentProfile: string | null): PickItem[] {
  const others = (profiles: string[]) => profiles.filter((p) => p !== currentProfile);
  const items: PickItem[] = registry.rows.map((r) => ({
    key: r.key,
    phone: r.phone,
    testerId: r.testerId,
    podName: r.pod?.name ?? null,
    linked: r.linked,
    usedBy: others(r.profiles),
    isBot: r.isBot,
    isNewExternal: false,
  }));
  for (const t of registry.testersWithoutPhone) {
    items.push({
      key: testerKey(t.id),
      phone: null,
      testerId: t.id,
      podName: null,
      linked: t.linked,
      usedBy: others(t.profiles),
      isBot: false,
      isNewExternal: false,
    });
  }
  const known = new Set(items.map((i) => i.key));
  for (const [key, phone] of Object.entries(externals)) {
    if (known.has(key)) continue;
    items.push({ key, phone, testerId: null, podName: null, linked: false, usedBy: [], isBot: false, isNewExternal: true });
  }
  return items;
}

/** What the engine receives, in the order the user picked them. */
export function toSelections(items: PickItem[], selected: string[]): Selection[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const out: Selection[] = [];
  for (const key of selected) {
    const item = byKey.get(key);
    if (!item) continue;
    out.push(item.testerId ? { testerId: item.testerId } : { phone: item.phone ?? "" });
  }
  return out;
}

interface Props {
  registry: Registry;
  botNumber: string | null;
  currentProfile: string | null;
  selected: string[];
  externals: Record<string, string>;
  onChange: (selected: string[], externals: Record<string, string>) => void;
}

export default function NumberPicker({ registry, botNumber, currentProfile, selected, externals, onChange }: Props) {
  const [extra, setExtra] = useState("");
  const [extraError, setExtraError] = useState<string | null>(null);
  const items = useMemo(() => buildItems(registry, externals, currentProfile), [registry, externals, currentProfile]);
  const chosen = new Set(selected);
  // Bot rows are never offered; one that is already selected stays visible so the user can remove it.
  const visible = items.filter((i) => !i.isBot || chosen.has(i.key));

  const toggle = (key: string) =>
    onChange(chosen.has(key) ? selected.filter((k) => k !== key) : [...selected, key], externals);

  const addExternal = () => {
    setExtraError(null);
    const parsed = podPhone(extra);
    if ("error" in parsed) return setExtraError(parsed.error);
    const key = phoneKey(parsed.value);
    if (botNumber && phoneKey(botNumber) === key) return setExtraError("Ese es el número del bot: siempre se incluye como bot.");
    const existing = items.find((i) => i.key === key);
    if (existing) {
      if (!chosen.has(key)) onChange([...selected, key], externals);
      setExtra("");
      return setExtraError("Ese número ya estaba en la lista: lo marcamos por ti.");
    }
    onChange([...selected, key], { ...externals, [key]: parsed.value });
    setExtra("");
  };

  return (
    <div className="field">
      <small>
        El número principal ({botNumber ?? "bot"}) siempre participa como bot, por eso no aparece en la lista. Un mismo número puede estar en varios
        perfiles, pero los perfiles se ejecutan de uno en uno.
      </small>
      <div className="picker" role="group" aria-label="Números disponibles">
        {visible.map((item) => (
          <label key={item.key} className={`pick-row ${chosen.has(item.key) ? "on" : ""}`}>
            <input type="checkbox" checked={chosen.has(item.key)} onChange={() => toggle(item.key)} />
            <span className="pick-main">
              <strong>{item.phone ?? item.testerId}</strong>
              <span className="pick-sub">
                {item.isBot
                  ? "Es el número del bot: quítalo de la selección"
                  : item.isNewExternal
                    ? "Externo nuevo (se crea un tester al guardar)"
                    : [item.podName ? `Pod ${item.podName}` : "Externo", item.phone ? item.testerId : "sin número registrado"].filter(Boolean).join(" · ")}
              </span>
              {item.usedBy.length > 0 && <span className="pick-used">También en: {item.usedBy.join(", ")}</span>}
            </span>
            <span className="pick-sub">
              <i className={`dot ${item.linked ? "" : "off"}`} aria-hidden /> {item.linked ? "Vinculado" : "Sin vincular"}
            </span>
          </label>
        ))}
        {visible.length === 0 && <span className="pick-sub">Todavía no hay números. Añade uno externo o crea un pod con número.</span>}
      </div>
      <div className="inline-add">
        <input
          className="input"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addExternal();
            }
          }}
          placeholder="300 123 4567"
          inputMode="tel"
          aria-label="Número externo"
        />
        <button type="button" className="btn ghost" onClick={addExternal} disabled={!extra.trim()}>
          <Plus size={15} aria-hidden /> Añadir número externo
        </button>
      </div>
      {extraError && <span className="field-error">{extraError}</span>}
    </div>
  );
}
