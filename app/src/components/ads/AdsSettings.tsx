import { KeyRound, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { COUNTRY_NAMES, adsApi, countryName, type AdsConfig, type CountrySettings, type Lifecycle, type Thresholds } from "../../lib/adsApi";
import { Notice, Pill } from "../ui";

interface Props {
  /** Countries that have data (before the enabled-countries scope). */
  detected: { country: string; gasto: number; ventas: number }[];
  tokenPresent: boolean;
  config: AdsConfig;
  onTokenChange: () => void;
  onConfigSaved: (config: AdsConfig) => void;
}

const THRESHOLD_LABELS: { key: keyof Thresholds; label: string; hint: string }[] = [
  { key: "minSpend", label: "Gasto mínimo para decidir", hint: "Por debajo de esto la acción es «Esperar»." },
  { key: "duplicateRoas", label: "ROAS para escalar y duplicar", hint: "Junto con las ventas mínimas." },
  { key: "duplicateSales", label: "Ventas mínimas para duplicar", hint: "Pagos válidos en el rango." },
  { key: "scaleRoas", label: "ROAS para escalar", hint: "" },
  { key: "keepRoas", label: "ROAS para mantener", hint: "" },
  { key: "watchRoas", label: "ROAS para vigilar", hint: "Por debajo de esto: «Apagar»." },
];

type NumKey = Exclude<keyof Lifecycle, "testEnabled" | "budgetEnabled" | "notifyDesktop" | "notifyWhatsapp" | "testNotifyAt" | "postBudgetNotifyAt">;

const LIFE_NUMBERS: { key: NumKey; label: string; hint: string }[] = [
  { key: "testNotifyDay", label: "Día del veredicto de prueba", hint: "El día 1 es el primer día con gasto. El veredicto llega solo ese día, a la hora de abajo." },
  { key: "testDays", label: "Duración de la prueba (días)", hint: "Solo informativa: cuántos días dura la prueba de un anuncio." },
  { key: "postBudgetNotifyDay", label: "Día de revisión tras subir presupuesto", hint: "El día de la subida cuenta como día 1. La revisión llega sola ese día, a la hora de abajo." },
  { key: "windowDays", label: "Días de comparación antes de la subida", hint: "Con cuántos días anteriores a la subida se compara el resultado." },
  { key: "minRoasToScale", label: "ROAS mínimo para «Subir más»", hint: "" },
  { key: "minSales", label: "Ventas mínimas para decidir", hint: "Con menos ventas que esto no se baja ni se sube por costo por venta." },
  { key: "maxCpaWorsenPct", label: "Costo por venta: máximo que puede empeorar (%)", hint: "Para «Subir más»." },
  { key: "lowerCpaWorsenPct", label: "Costo por venta: empeora más de (%) = «Bajar»", hint: "" },
  { key: "raisePct", label: "Próxima subida sugerida (%)", hint: "" },
  { key: "maxRaisePct", label: "Tope de subida (%)", hint: "Por defecto igual al del monitor (20 %)." },
  { key: "lateDays", label: "Días de gracia si la app estaba cerrada", hint: "Pasado ese plazo la decisión ya no se emite." },
];

export default function AdsSettings({ detected, tokenPresent, config, onTokenChange, onConfigSaved }: Props) {
  const [draft, setDraft] = useState<AdsConfig>(config);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setDraft(config), [config]);

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      if (message) setNotice(message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const info = await adsApi.tokenTest();
    return `Conectado a «${info.accountName}» (${info.currency}, ${info.timezone}).`;
  };

  const importToken = () =>
    run(async () => {
      await adsApi.tokenImport();
      onTokenChange();
      return `Token importado. ${await test()}`;
    });

  const saveToken = () =>
    run(async () => {
      await adsApi.tokenSet(token);
      setToken("");
      onTokenChange();
      return `Token guardado. ${await test()}`;
    });

  const clearToken = () =>
    run(async () => {
      await adsApi.tokenClear();
      onTokenChange();
      return "Token eliminado.";
    });

  const saveConfig = () =>
    run(async () => {
      const { config: saved } = await adsApi.configSet(draft);
      onConfigSaved(saved);
      return "Configuración guardada.";
    });

  const set = <K extends keyof AdsConfig>(key: K, value: AdsConfig[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setLife = <K extends keyof Lifecycle>(key: K, value: Lifecycle[K]) => setDraft((d) => ({ ...d, lifecycle: { ...d.lifecycle, [key]: value } }));
  const setCountry = (code: string, patch: Partial<CountrySettings>) =>
    setDraft((d) => ({
      ...d,
      countries: { ...d.countries, [code]: { ...({ currency: "COP", rateToCop: 0, feePct: 0, costPerSale: 0, taxPct: 0 } as CountrySettings), ...d.countries[code], ...patch } },
    }));
  const toggleCountry = (code: string, on: boolean) =>
    setDraft((d) => {
      const next = on ? [...new Set([...d.enabledCountries, code])] : d.enabledCountries.filter((c) => c !== code);
      return next.length === 0 ? d : { ...d, enabledCountries: next };
    });
  const offered = [...new Set([...Object.keys(COUNTRY_NAMES).filter((c) => c !== "XX"), ...draft.enabledCountries, ...detected.map((d) => d.country)])].sort((a, b) => {
    const rank = (c: string) => (draft.enabledCountries.includes(c) ? 0 : detected.some((d) => d.country === c) ? 1 : 2);
    return rank(a) - rank(b) || countryName(a).localeCompare(countryName(b), "es");
  });
  const addableCountries = Object.keys(COUNTRY_NAMES).filter((c) => !draft.countries[c]);
  const setThreshold = (key: keyof Thresholds, value: string) =>
    setDraft((d) => ({ ...d, thresholds: { ...d.thresholds, [key]: value === "" ? 0 : Number(value) } }));

  return (
    <div className="ads-settings">
      {error && <Notice>{error}</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}

      <h3 className="ia-sub"><KeyRound size={14} aria-hidden /> Token de Meta</h3>
      <div className="ads-token">
        <Pill tone={tokenPresent ? "green" : "red"}>{tokenPresent ? "Conectado" : "Falta"}</Pill>
        <button className="btn secondary sm" disabled={busy} onClick={() => void importToken()}>Importar desde meta-ads-monitor</button>
        {tokenPresent && (
          <>
            <button className="btn secondary sm" disabled={busy} onClick={() => void run(test)}>Probar conexión</button>
            <button className="btn ghost sm" disabled={busy} onClick={() => void clearToken()}>Quitar token</button>
          </>
        )}
      </div>
      <div className="ia-inline" style={{ marginTop: 10 }}>
        <input
          className="input"
          type="password"
          autoComplete="off"
          placeholder="O pega aquí un token nuevo"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="Token de Meta"
        />
        <button className="btn sm" disabled={busy || token.trim().length === 0} onClick={() => void saveToken()}>Guardar y probar</button>
      </div>
      <small className="muted">El token se guarda en el Administrador de credenciales de Windows. Nunca se muestra ni se escribe en archivos.</small>

      <h3 className="ia-sub" style={{ marginTop: 22 }}>Fuentes de datos</h3>
      <div className="ia-grid">
        <div className="field">
          <label htmlFor="ads-account">Cuenta publicitaria</label>
          <input id="ads-account" className="input" value={draft.adAccountId} onChange={(e) => set("adAccountId", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ads-prefix">Prefijo de campañas</label>
          <input id="ads-prefix" className="input" value={draft.campaignPrefix} onChange={(e) => set("campaignPrefix", e.target.value)} />
          <small>«all» por defecto: se ven todas las campañas. Si escribes un texto, solo cuentan las campañas cuyo nombre empieza así.</small>
        </div>
        <div className="field">
          <label htmlFor="ads-sheet">ID de la hoja de pagos</label>
          <input id="ads-sheet" className="input" value={draft.sheetId} onChange={(e) => set("sheetId", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ads-tab">Pestaña</label>
          <input id="ads-tab" className="input" value={draft.sheetTab} onChange={(e) => set("sheetTab", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ads-flow">Prefijo de flujo</label>
          <input id="ads-flow" className="input" value={draft.flowPrefix} onChange={(e) => set("flowPrefix", e.target.value)} />
          <small>Solo cuentan los pagos cuyo flujo empieza así.</small>
        </div>
        <div className="field">
          <label htmlFor="ads-valid">Resultado que cuenta como venta</label>
          <input id="ads-valid" className="input" value={draft.validResult} onChange={(e) => set("validResult", e.target.value)} />
        </div>
      </div>

      <h3 className="ia-sub" style={{ marginTop: 10 }}>Historial</h3>
      <div className="ia-grid">
        <div className="field">
          <label htmlFor="ads-history">Historial desde</label>
          <input id="ads-history" className="input" type="date" value={draft.historyFrom} onChange={(e) => set("historyFrom", e.target.value)} />
          <small>Vacío = se detecta solo el día más antiguo que haya en la hoja o en Meta. Si eliges una fecha anterior a la actual, se vuelve a cargar el historial desde ahí. Nada se borra nunca.</small>
        </div>
      </div>

      <h3 className="ia-sub" style={{ marginTop: 10 }}>Países habilitados</h3>
      <p className="muted ads-note">
        Solo los países habilitados aparecen en los filtros, las tablas y los totales. Los datos de los demás se dejan fuera (se conservan en el historial). Por defecto solo Colombia.
      </p>
      <div className="ads-countries-enabled" role="group" aria-label="Países habilitados">
        {offered.map((code) => {
          const seen = detected.find((d) => d.country === code);
          const on = draft.enabledCountries.includes(code);
          return (
            <label key={code} className="ads-check">
              <input type="checkbox" checked={on} disabled={on && draft.enabledCountries.length === 1} onChange={(e) => toggleCountry(code, e.target.checked)} />
              {code} · {countryName(code)}
              {seen ? <span className="muted"> · con datos ({seen.ventas} ventas)</span> : null}
            </label>
          );
        })}
      </div>
      <label className="ads-check" style={{ marginBottom: 14 }}>
        <input type="checkbox" checked={draft.includeOtherCountries} onChange={(e) => set("includeOtherCountries", e.target.checked)} /> Incluir los demás países agrupados como «Otros países»
      </label>

      <h3 className="ia-sub" style={{ marginTop: 10 }}>Países: moneda, comisión y costos</h3>
      <p className="muted ads-note">
        El gasto de Meta ya viene en COP (sin IVA; el IVA se configura abajo). El valor de cada pago se convierte a COP con la tasa; la comisión y el impuesto son un % del valor ya convertido y el costo es por venta (en COP). Margen bruto = valor − gasto (con IVA) − comisiones − costos − impuestos.
      </p>
      {Object.keys(draft.countries).sort().map((code) => {
        const c = draft.countries[code];
        return (
          <div key={code} className="ads-countries-grid">
            <div className="field">
              <label htmlFor={`cc-cur-${code}`}>{code} · {countryName(code)}: moneda del valor</label>
              <input id={`cc-cur-${code}`} className="input" maxLength={3} value={c.currency} onChange={(e) => setCountry(code, { currency: e.target.value.toUpperCase() })} />
            </div>
            <div className="field">
              <label htmlFor={`cc-rate-${code}`}>Tasa: 1 {c.currency} = ? COP</label>
              <input id={`cc-rate-${code}`} className="input" type="number" min={0} step="any" value={c.rateToCop} onChange={(e) => setCountry(code, { rateToCop: Number(e.target.value) })} />
              {c.currency !== "COP" && !(c.rateToCop > 0) && <small className="ads-warn">Sin tasa: se muestra sin convertir.</small>}
            </div>
            <div className="field">
              <label htmlFor={`cc-fee-${code}`}>Comisión de pago (%)</label>
              <input id={`cc-fee-${code}`} className="input" type="number" min={0} max={100} step="any" value={c.feePct} onChange={(e) => setCountry(code, { feePct: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor={`cc-cost-${code}`}>Costo por venta (COP)</label>
              <input id={`cc-cost-${code}`} className="input" type="number" min={0} step="any" value={c.costPerSale} onChange={(e) => setCountry(code, { costPerSale: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor={`cc-tax-${code}`}>Impuesto (%)</label>
              <input id={`cc-tax-${code}`} className="input" type="number" min={0} max={100} step="any" value={c.taxPct} onChange={(e) => setCountry(code, { taxPct: Number(e.target.value) })} />
            </div>
          </div>
        );
      })}
      {addableCountries.length > 0 && (
        <div className="ia-inline" style={{ marginBottom: 14 }}>
          <select className="input" aria-label="Añadir país" value="" onChange={(e) => e.target.value && setCountry(e.target.value, {})}>
            <option value="">Añadir un país…</option>
            {addableCountries.map((c) => <option key={c} value={c}>{c} · {countryName(c)}</option>)}
          </select>
        </div>
      )}

      <h3 className="ia-sub" style={{ marginTop: 10 }}>IVA del gasto en Meta</h3>
      <div className="ia-grid">
        <div className="field">
          <label htmlFor="spend-vat">IVA sobre el gasto en Meta (%)</label>
          <input id="spend-vat" className="input" type="number" min={0} max={100} step="any" value={draft.spendVatPct} onChange={(e) => set("spendVatPct", e.target.value === "" ? 0 : Number(e.target.value))} />
          <small>Meta cobra este IVA además de lo que reporta su API. Se suma al gasto en toda la app y el ROAS, el costo por venta y las decisiones lo usan. Es distinto del impuesto por país de arriba, que va sobre el valor de las ventas.</small>
        </div>
      </div>

      <h3 className="ia-sub" style={{ marginTop: 10 }}>Reglas de la acción sugerida</h3>
      <div className="ia-grid">
        {THRESHOLD_LABELS.map(({ key, label, hint }) => (
          <div className="field" key={key}>
            <label htmlFor={`th-${key}`}>{label}</label>
            <input id={`th-${key}`} className="input" type="number" min={0} step="any" value={draft.thresholds[key]} onChange={(e) => setThreshold(key, e.target.value)} />
            {hint && <small>{hint}</small>}
          </div>
        ))}
      </div>

      <h3 className="ia-sub" style={{ marginTop: 10 }}>Decisiones diarias</h3>
      <div className="ads-switches">
        {([
          ["testEnabled", "Veredicto de prueba por anuncio y campaña"],
          ["budgetEnabled", "Revisión tras subir presupuesto"],
          ["notifyDesktop", "Avisarme con una notificación de Windows"],
          ["notifyWhatsapp", "Enviarme también el aviso por WhatsApp (si el canal está conectado)"],
        ] as const).map(([key, label]) => (
          <label key={key} className="ads-check">
            <input type="checkbox" checked={draft.lifecycle[key]} onChange={(e) => setLife(key, e.target.checked)} /> {label}
          </label>
        ))}
      </div>
      <div className="ia-grid">
        <div className="field">
          <label htmlFor="life-test-at">Hora del veredicto de prueba</label>
          <input id="life-test-at" className="input" type="time" value={draft.lifecycle.testNotifyAt} onChange={(e) => setLife("testNotifyAt", e.target.value)} />
          <small>Hora de la cuenta publicitaria.</small>
        </div>
        <div className="field">
          <label htmlFor="life-budget-at">Hora de la revisión de presupuesto</label>
          <input id="life-budget-at" className="input" type="time" value={draft.lifecycle.postBudgetNotifyAt} onChange={(e) => setLife("postBudgetNotifyAt", e.target.value)} />
        </div>
        {LIFE_NUMBERS.map(({ key, label, hint }) => (
          <div className="field" key={key}>
            <label htmlFor={`life-${key}`}>{label}</label>
            <input id={`life-${key}`} className="input" type="number" min={0} step="any" value={draft.lifecycle[key]} onChange={(e) => setLife(key, e.target.value === "" ? 0 : Number(e.target.value))} />
            {hint && <small>{hint}</small>}
          </div>
        ))}
      </div>

      <button className="btn" disabled={busy} onClick={() => void saveConfig()}>
        <Save size={15} aria-hidden /> Guardar configuración
      </button>
    </div>
  );
}
