import { KeyRound, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { adsApi, type AdsConfig, type Thresholds } from "../../lib/adsApi";
import { Notice, Pill } from "../ui";

interface Props {
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

export default function AdsSettings({ tokenPresent, config, onTokenChange, onConfigSaved }: Props) {
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
          <small>«CT» por defecto. Escribe «all» para ver todas.</small>
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
        <div className="field">
          <label htmlFor="ads-auto">Actualizar hoy cada (minutos)</label>
          <input id="ads-auto" className="input" type="number" min={0} value={draft.autoRefreshMinutes} onChange={(e) => set("autoRefreshMinutes", Number(e.target.value))} />
          <small>0 desactiva la actualización automática.</small>
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

      <button className="btn" disabled={busy} onClick={() => void saveConfig()}>
        <Save size={15} aria-hidden /> Guardar configuración
      </button>
    </div>
  );
}
