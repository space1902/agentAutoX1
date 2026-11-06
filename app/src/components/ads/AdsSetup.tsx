import { useState } from "react";
import { errorText } from "../../lib/api";
import { adsApi, type AdsConfig, type TokenTestResult } from "../../lib/adsApi";
import { Notice } from "../ui";

interface Props {
  /** Portfolios that exist but have no account yet (step 2 resumes there). */
  config: AdsConfig;
  onDone: (config: AdsConfig) => void;
}

/** First run: no portfolio with an ad account yet. Step 1 = portfolio + token, step 2 = its first account. */
export default function AdsSetup({ config, onDone }: Props) {
  const existing = config.portfolios.find((p) => p.accounts.length === 0) ?? null;
  const [portfolio, setPortfolio] = useState<{ id: string; name: string } | null>(existing ? { id: existing.id, name: existing.name } : null);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [account, setAccount] = useState("");
  const [accountName, setAccountName] = useState("");
  const [picks, setPicks] = useState<TokenTestResult["accounts"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const loadPicks = async (id: string) => {
    const info = await adsApi.portfolioTokenTest(id);
    setPicks(info.accounts);
    setNotice(`Token válido${info.name ? ` («${info.name}»)` : ""}. ${info.accounts.length > 0 ? "Elige una de tus cuentas o escribe su número." : "Escribe el número de tu cuenta publicitaria."}`);
  };

  const createPortfolio = () =>
    run(async () => {
      const created = await adsApi.portfolioAdd(name, token);
      setPortfolio(created.portfolio);
      setToken("");
      await loadPicks(created.portfolio.id);
    });

  const addAccount = () =>
    run(async () => {
      if (!portfolio) return;
      const added = await adsApi.accountAdd(portfolio.id, account, accountName);
      onDone(added.config);
    });

  return (
    <div className="ads-setup">
      <h2 className="card-title">Conecta tu primera cuenta publicitaria</h2>
      <p className="muted">Anuncios necesita un portafolio de Meta (tu Business Manager) con su token, y al menos una cuenta publicitaria. Son dos pasos.</p>
      {error && <Notice>{error}</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}

      <section className="ads-portfolio" aria-label="Paso 1">
        <strong>Paso 1 · Portafolio y token {portfolio ? "✓" : ""}</strong>
        {portfolio ? (
          <p className="muted" style={{ margin: "6px 0 0" }}>Portafolio «{portfolio.name}» con su token guardado.</p>
        ) : (
          <>
            <div className="ia-inline" style={{ marginTop: 8 }}>
              <input className="input" placeholder="Nombre del portafolio" aria-label="Nombre del portafolio" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="input" type="password" autoComplete="off" placeholder="Token de Meta" aria-label="Token de Meta" value={token} onChange={(e) => setToken(e.target.value)} />
              <button className="btn sm" disabled={busy || name.trim() === "" || token.trim() === ""} onClick={() => void createPortfolio()}>Guardar y probar</button>
            </div>
            <small className="muted">El token se guarda en el Administrador de credenciales de Windows; nunca se muestra ni se escribe en archivos.</small>
          </>
        )}
      </section>

      <section className="ads-portfolio" aria-label="Paso 2" style={{ opacity: portfolio ? 1 : 0.5 }}>
        <strong>Paso 2 · Primera cuenta publicitaria</strong>
        <div className="ia-inline" style={{ marginTop: 8 }}>
          <input className="input" placeholder="act_1234567890" aria-label="Cuenta publicitaria" disabled={!portfolio} value={account} onChange={(e) => setAccount(e.target.value)} />
          <input className="input" placeholder="Nombre (opcional)" aria-label="Nombre de la cuenta (opcional)" disabled={!portfolio} value={accountName} onChange={(e) => setAccountName(e.target.value)} />
          <button className="btn sm" disabled={busy || !portfolio || account.trim() === ""} onClick={() => void addAccount()}>Verificar y agregar</button>
        </div>
        <small className="muted">La cuenta ya debe existir en Meta y estar asignada al usuario del sistema de este portafolio. Si no la encuentro, no se guarda.</small>
        {picks.length > 0 && (
          <div className="chips" role="group" aria-label="Cuentas que ve este token" style={{ marginTop: 6 }}>
            {picks.map((a) => (
              <button key={a.id} className="chip" disabled={busy} onClick={() => { setAccount(a.id); setAccountName(a.name); }} title={`${a.id} · ${a.currency}`}>
                {a.name || a.id}
              </button>
            ))}
          </div>
        )}
        {portfolio && picks.length === 0 && existing && (
          <button className="btn secondary sm" style={{ marginTop: 8 }} disabled={busy} onClick={() => void run(() => loadPicks(portfolio.id))}>Ver las cuentas que ve mi token</button>
        )}
      </section>
    </div>
  );
}
