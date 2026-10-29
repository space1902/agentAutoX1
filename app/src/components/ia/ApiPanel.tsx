import { Check, KeyRound, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatUsd, type AiConfig, type KeyStatus, type Preset, type PresetsData } from "../../lib/aiApi";
import { Pill } from "../ui";

interface Props {
  presets: PresetsData;
  config: AiConfig | null;
  keys: Record<string, KeyStatus>;
  localModels: string[];
  busy: boolean;
  onSaveKey: (preset: string, key: string) => Promise<void>;
  onClearKey: (preset: string) => Promise<void>;
  onSave: (config: AiConfig) => void;
  /** Receives the config and the id of the provider whose saved key the test must use. */
  onTest: (config: AiConfig) => void;
}

export default function ApiPanel({ presets, config, keys, localModels, busy, onSaveKey, onClearKey, onSave, onTest }: Props) {
  const active = config?.provider === "openai-compatible" && config.preset !== "local-openai" ? config : null;
  const [presetId, setPresetId] = useState(active?.preset ?? "openrouter");
  const preset = presets.presets.find((x) => x.id === presetId) ?? presets.presets[0];
  const [model, setModel] = useState(active?.preset === presetId ? (active.model ?? "") : "");
  const [baseUrl, setBaseUrl] = useState(active?.baseUrl ?? "");
  const [inUsd, setInUsd] = useState(String(active?.prices?.inUsd ?? ""));
  const [outUsd, setOutUsd] = useState(String(active?.prices?.outUsd ?? ""));
  const [keyInput, setKeyInput] = useState("");
  const [budget, setBudget] = useState(String(config?.dailyBudgetUsd ?? 1));
  const [onExceed, setOnExceed] = useState<"fallback-local" | "stop">(config?.onBudgetExceeded ?? "fallback-local");
  const [fallback, setFallback] = useState(config?.fallbackLocalModel ?? "");
  const [more, setMore] = useState(Boolean(active && !presets.presets.slice(0, 2).some((x) => x.id === active.preset)));
  const [keyError, setKeyError] = useState<string | null>(null);

  const free = presets.presets.filter((x) => x.recommended);
  const rest = presets.presets.filter((x) => !x.recommended && x.id !== "local-openai");
  const editable = preset.id === "custom" || preset.models.length === 0;
  const key = keys[preset.id];

  // Default model of a provider when it changes (cheapest listed first).
  useEffect(() => {
    if (active?.preset === preset.id) return;
    setModel(preset.models[0]?.id ?? "");
  }, [preset, active?.preset]);

  const picked = preset.models.find((m) => m.id === model);
  const budgetNumber = Number(budget);
  const budgetOk = Number.isFinite(budgetNumber) && budgetNumber >= 0;
  const keyReady = Boolean(key?.present) || preset.keyOptional;
  const ready = Boolean(model.trim()) && budgetOk && keyReady && (!editable || Boolean(baseUrl.trim()));

  const built = useMemo<AiConfig>(() => {
    const cfg: AiConfig = {
      provider: "openai-compatible",
      preset: preset.id,
      model: model.trim(),
      dailyBudgetUsd: budgetOk ? budgetNumber : 1,
      onBudgetExceeded: onExceed,
      fallbackLocalModel: fallback || undefined,
      localGpu: config?.localGpu,
    };
    if (editable) {
      cfg.baseUrl = baseUrl.trim();
      const i = Number(inUsd);
      const o = Number(outUsd);
      if (inUsd !== "" && outUsd !== "" && Number.isFinite(i) && Number.isFinite(o)) cfg.prices = { inUsd: i, outUsd: o };
    }
    return cfg;
  }, [preset.id, model, budgetOk, budgetNumber, onExceed, fallback, editable, baseUrl, inUsd, outUsd, config?.localGpu]);

  const saveKey = async () => {
    setKeyError(null);
    try {
      await onSaveKey(preset.id, keyInput);
      setKeyInput("");
    } catch (e) {
      setKeyError(String(e instanceof Error ? e.message : e));
    }
  };

  const providerCard = (x: Preset) => (
    <label key={x.id} className={`ia-provider ${presetId === x.id ? "chosen" : ""}`}>
      <input type="radio" name="provider" checked={presetId === x.id} onChange={() => setPresetId(x.id)} />
      <span className="ia-provider-name">
        {x.label}
        {x.recommended && <Pill tone="green">Recomendado (más barato)</Pill>}
        {active?.preset === x.id && <Pill tone="gray">En uso</Pill>}
      </span>
      <span className="muted">{x.models.length > 0 ? `desde ${formatUsd(Math.min(...x.models.map((m) => m.usdDay)))}/día` : "precios editables"}</span>
    </label>
  );

  return (
    <div className="ia-stack">
      <section>
        <h3 className="ia-sub">1. Proveedor</h3>
        <div className="ia-providers">{free.map(providerCard)}</div>
        <details open={more} onToggle={(e) => setMore((e.target as HTMLDetailsElement).open)} className="ia-more">
          <summary>Más proveedores</summary>
          <div className="ia-providers">{rest.map(providerCard)}</div>
        </details>
      </section>

      <section>
        <h3 className="ia-sub">2. Clave de {preset.label}</h3>
        {key?.present ? (
          <div className="ia-inline">
            <span className="ia-key">
              <KeyRound size={14} aria-hidden /> {key.masked}
            </span>
            <button className="btn sm ghost" disabled={busy} onClick={() => void onClearKey(preset.id)}>
              <Trash2 size={14} aria-hidden /> Quitar clave
            </button>
          </div>
        ) : (
          <div className="ia-inline">
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder={preset.keyOptional ? "Opcional en servidores locales" : `Pega aquí tu API key ${preset.keyHint}`}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              aria-label={`API key de ${preset.label}`}
            />
            <button className="btn sm" disabled={!keyInput.trim() || busy} onClick={() => void saveKey()}>
              Guardar clave
            </button>
          </div>
        )}
        <small className="muted">Se guarda cifrada en el Administrador de credenciales de Windows, una por proveedor. Nunca se escribe en archivos.</small>
        {keyError && <span className="field-error">{keyError}</span>}
      </section>

      <section>
        <h3 className="ia-sub">3. Modelo</h3>
        {editable ? (
          <div className="ia-grid">
            <div className="field">
              <label htmlFor="ia-base">URL base</label>
              <input id="ia-base" className="input" value={baseUrl} placeholder={preset.baseUrl || "https://…/v1"} onChange={(e) => setBaseUrl(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="ia-model">Modelo</label>
              <input id="ia-model" className="input" value={model} onChange={(e) => setModel(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="ia-in">USD por 1M tokens de entrada</label>
              <input id="ia-in" className="input" inputMode="decimal" value={inUsd} onChange={(e) => setInUsd(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="ia-out">USD por 1M tokens de salida</label>
              <input id="ia-out" className="input" inputMode="decimal" value={outUsd} onChange={(e) => setOutUsd(e.target.value)} />
            </div>
          </div>
        ) : (
          <>
            <ul className="ia-list">
              {preset.models.map((m) => (
                <li key={m.id}>
                  <label className={`ia-row selectable ${model === m.id ? "chosen" : ""}`}>
                    <input type="radio" name="model" checked={model === m.id} onChange={() => setModel(m.id)} />
                    <div className="ia-row-main">
                      <strong>{m.label}</strong> <span className="muted">({m.id})</span>
                      <span className="muted">
                        ${m.inUsd} entrada / ${m.outUsd} salida por 1M tokens
                        {m.offPeak && ` · fuera de hora pico $${m.offPeak.inUsd} / $${m.offPeak.outUsd}`}
                      </span>
                    </div>
                    <div className="ia-row-tags">
                      <Pill tone="gray">≈ {formatUsd(m.usdDay)}/día</Pill>
                      <Pill tone="gray">≈ {formatUsd(m.usdMonth)}/mes</Pill>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
            <small className="muted">
              Precio al 29/10/2026 · estimado para {presets.profile.messages.toLocaleString("es-CO")} mensajes por día (~{presets.profile.promptTokens} tokens de entrada y ~{presets.profile.completionTokens} de salida). Verifica en la página del proveedor.
            </small>
            {picked?.offPeak && <small className="muted">DeepSeek cobra más de lunes a viernes entre 01–04 y 06–10 UTC; el estimado mezcla ambas tarifas.</small>}
          </>
        )}
      </section>

      <section>
        <h3 className="ia-sub">4. Control de gasto</h3>
        <div className="ia-grid">
          <div className="field">
            <label htmlFor="ia-budget">Presupuesto diario (USD)</label>
            <input id="ia-budget" className="input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            {!budgetOk && <span className="field-error">Escribe un número mayor o igual a 0.</span>}
          </div>
          <div className="field">
            <label htmlFor="ia-exceed">Al llegar al límite</label>
            <select id="ia-exceed" className="input" value={onExceed} onChange={(e) => setOnExceed(e.target.value as "fallback-local" | "stop")}>
              <option value="fallback-local">Pasar al modelo local</option>
              <option value="stop">Detener el perfil</option>
            </select>
          </div>
          {onExceed === "fallback-local" && (
            <div className="field">
              <label htmlFor="ia-fallback">Modelo local de reserva</label>
              <select id="ia-fallback" className="input" value={fallback} onChange={(e) => setFallback(e.target.value)}>
                <option value="">El modelo local por defecto</option>
                {localModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </section>

      <div className="row-actions">
        <button className="btn secondary" disabled={!ready || busy} onClick={() => onTest(built)}>
          Probar
        </button>
        <button className="btn" disabled={!ready || busy} onClick={() => onSave(built)}>
          <Check size={14} aria-hidden /> Guardar y usar
        </button>
        {!keyReady && <span className="muted">Guarda primero la clave del proveedor.</span>}
      </div>
    </div>
  );
}
