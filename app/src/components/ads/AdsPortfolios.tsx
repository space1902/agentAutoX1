import { Building2, KeyRound, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../lib/api";
import { adsApi, type AdsConfig, type Portfolio, type TokenTestResult } from "../../lib/adsApi";
import { Notice, Pill } from "../ui";

interface Props {
  config: AdsConfig;
  /** The configuration changed (portfolio or account added, renamed or removed). */
  onChanged: (config: AdsConfig) => void;
  /** A token was saved or removed. */
  onTokenChange: () => void;
}

/** Shown when the principal portfolio is about to lose its token or disappear. */
const PRINCIPAL_NOTE = " Atención: es el portafolio principal; lo usan el monitor de alertas y la cuenta principal, y dejarán de funcionar.";

type Pending = { kind: "portfolio" | "account" | "token"; portfolio: string; account?: string } | null;

const same = (a: Pending, kind: NonNullable<Pending>["kind"], portfolio: string, account?: string) =>
  a?.kind === kind && a.portfolio === portfolio && a.account === account;

/** "Portafolios y cuentas publicitarias": Business Managers with their token, and the ad accounts under each. */
export default function AdsPortfolios({ config, onChanged, onTokenChange }: Props) {
  const [tokens, setTokens] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  // Accounts a successful token test could see, per portfolio, to offer as quick picks.
  const [picks, setPicks] = useState<Record<string, TokenTestResult["accounts"]>>({});
  const [newName, setNewName] = useState("");
  const [newToken, setNewToken] = useState("");
  const [tokenFor, setTokenFor] = useState<{ portfolio: string; value: string } | null>(null);
  const [renaming, setRenaming] = useState<{ portfolio: string; account?: string; value: string } | null>(null);
  const [adding, setAdding] = useState<Record<string, { id: string; name: string }>>({});

  const ids = config.portfolios.map((p) => p.id).join(",");
  const refreshTokens = useCallback(async () => {
    try {
      setTokens(await adsApi.portfolioTokenStatus(ids ? ids.split(",") : []));
    } catch (e) {
      setError(errorText(e));
    }
  }, [ids]);
  useEffect(() => {
    void refreshTokens();
  }, [refreshTokens]);

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

  const testToken = async (portfolio: string): Promise<string> => {
    const info = await adsApi.portfolioTokenTest(portfolio);
    const known = new Set(config.portfolios.flatMap((p) => p.accounts.map((a) => a.id)));
    setPicks((p) => ({ ...p, [portfolio]: info.accounts.filter((a) => !known.has(a.id)) }));
    const count = info.accounts.length;
    return `Token válido${info.name ? ` («${info.name}»)` : ""}. ${count > 0 ? `Ve ${count} ${count === 1 ? "cuenta publicitaria" : "cuentas publicitarias"}.` : "No pude listar cuentas: agrégalas escribiendo su número."}`;
  };

  const saveList = async (portfolios: Portfolio[]) => {
    const { config: saved } = await adsApi.configSet({ portfolios });
    onChanged(saved);
  };

  const createPortfolio = () =>
    run(async () => {
      const created = await adsApi.portfolioAdd(newName, newToken);
      setNewName("");
      setNewToken("");
      onChanged(created.config);
      await refreshTokens();
      onTokenChange();
      return `Portafolio «${created.portfolio.name}» creado. ${await testToken(created.portfolio.id)}`;
    });

  const saveToken = (portfolio: string, value: string) =>
    run(async () => {
      await adsApi.portfolioTokenSet(portfolio, value);
      setTokenFor(null);
      await refreshTokens();
      onTokenChange();
      return `Token guardado. ${await testToken(portfolio)}`;
    });

  const clearToken = (portfolio: string) =>
    run(async () => {
      await adsApi.portfolioTokenClear(portfolio, portfolio === "principal");
      setPending(null);
      await refreshTokens();
      onTokenChange();
      return "Token eliminado. Las cuentas de este portafolio no se actualizarán hasta que pegues uno nuevo.";
    });

  const importToken = () =>
    run(async () => {
      await adsApi.tokenImport();
      await refreshTokens();
      onTokenChange();
      const principal = config.portfolios.find((p) => p.id === "principal");
      return principal ? `Token importado. ${await testToken(principal.id)}` : "Token importado.";
    });

  const removePortfolio = (portfolio: string) =>
    run(async () => {
      const { config: saved } = await adsApi.portfolioRemove(portfolio, portfolio === "principal");
      setPending(null);
      onChanged(saved);
      onTokenChange();
      return "Portafolio eliminado. Su historial sigue guardado; solo dejó de actualizarse.";
    });

  const addAccount = (portfolio: string, id: string, name: string) =>
    run(async () => {
      const added = await adsApi.accountAdd(portfolio, id, name);
      setAdding((a) => ({ ...a, [portfolio]: { id: "", name: "" } }));
      setPicks((p) => ({ ...p, [portfolio]: (p[portfolio] ?? []).filter((x) => x.id !== added.account.id) }));
      onChanged(added.config);
      return `Cuenta «${added.account.name}» agregada (${added.account.currency || "moneda sin definir"}).`;
    });

  const removeAccount = (portfolio: string, account: string) =>
    run(async () => {
      await saveList(config.portfolios.map((p) => (p.id === portfolio ? { ...p, accounts: p.accounts.filter((a) => a.id !== account) } : p)));
      setPending(null);
      return "Cuenta quitada. Su historial sigue guardado; solo dejó de actualizarse.";
    });

  const rename = () =>
    run(async () => {
      if (!renaming) return;
      const value = renaming.value.trim();
      await saveList(
        config.portfolios.map((p) => {
          if (p.id !== renaming.portfolio) return p;
          return renaming.account
            ? { ...p, accounts: p.accounts.map((a) => (a.id === renaming.account ? { ...a, name: value } : a)) }
            : { ...p, name: value };
        }),
      );
      setRenaming(null);
      return "Nombre actualizado.";
    });

  const confirmRow = (text: string, onYes: () => void) => (
    <span className="ads-confirm" role="alertdialog" aria-label="Confirmar">
      <span className="ads-warn" style={{ margin: 0 }}>{text}</span>
      <button className="btn sm" disabled={busy} onClick={onYes}>Sí, continuar</button>
      <button className="btn ghost sm" disabled={busy} onClick={() => setPending(null)}>Cancelar</button>
    </span>
  );

  return (
    <div className="ads-portfolios">
      <h3 className="ia-sub"><Building2 size={14} aria-hidden /> Portafolios y cuentas publicitarias</h3>
      <p className="muted ads-note" style={{ marginTop: 0 }}>
        Un portafolio es un Business Manager de Meta con su propio token. Bajo cada uno van sus cuentas publicitarias. El token se guarda en el Administrador de credenciales de Windows; nunca se muestra ni se escribe en archivos.
      </p>
      {error && <Notice>{error}</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}

      {config.portfolios.length === 0 && <p className="muted">Todavía no tienes portafolios. Crea el primero abajo.</p>}

      {config.portfolios.map((p) => {
        const hasToken = tokens[p.id] === true;
        const draft = adding[p.id] ?? { id: "", name: "" };
        const available = picks[p.id] ?? [];
        return (
          <section key={p.id} className="ads-portfolio" aria-label={`Portafolio ${p.name}`}>
            <div className="ads-token">
              <strong>{p.name}</strong>
              <Pill tone={hasToken ? "green" : "red"}>{hasToken ? "Token ✓" : "Token ✗"}</Pill>
              {hasToken && <button className="btn secondary sm" disabled={busy} onClick={() => void run(() => testToken(p.id))}>Probar</button>}
              <button className="btn secondary sm" disabled={busy} onClick={() => setTokenFor({ portfolio: p.id, value: "" })}>{hasToken ? "Cambiar token" : "Pegar token"}</button>
              {hasToken && <button className="btn ghost sm" disabled={busy} onClick={() => setPending({ kind: "token", portfolio: p.id })}>Quitar token</button>}
              <button className="btn ghost sm" disabled={busy} onClick={() => setRenaming({ portfolio: p.id, value: p.name })}>Renombrar</button>
              <button className="btn ghost sm" disabled={busy} onClick={() => setPending({ kind: "portfolio", portfolio: p.id })}>Eliminar portafolio</button>
              {p.id === "principal" && (
                <button className="btn secondary sm" disabled={busy} onClick={() => void importToken()}>Importar desde meta-ads-monitor</button>
              )}
            </div>
            {same(pending, "token", p.id) && confirmRow(`Se borrará el token de este portafolio.${p.id === "principal" ? PRINCIPAL_NOTE : ""} ¿Seguro?`, () => void clearToken(p.id))}
            {same(pending, "portfolio", p.id) &&
              confirmRow(`Se quitará «${p.name}», sus cuentas y su token. El historial guardado no se borra.${p.id === "principal" ? PRINCIPAL_NOTE : ""} ¿Seguro?`, () => void removePortfolio(p.id))}
            {tokenFor?.portfolio === p.id && (
              <div className="ia-inline" style={{ marginTop: 8 }}>
                <input className="input" type="password" autoComplete="off" placeholder="Pega aquí el token" aria-label={`Token de ${p.name}`} value={tokenFor.value} onChange={(e) => setTokenFor({ portfolio: p.id, value: e.target.value })} />
                <button className="btn sm" disabled={busy || tokenFor.value.trim().length === 0} onClick={() => void saveToken(p.id, tokenFor.value)}>Guardar y probar</button>
                <button className="btn ghost sm" disabled={busy} onClick={() => setTokenFor(null)}>Cancelar</button>
              </div>
            )}
            {renaming?.portfolio === p.id && !renaming.account && (
              <div className="ia-inline" style={{ marginTop: 8 }}>
                <input className="input" aria-label="Nombre del portafolio" value={renaming.value} onChange={(e) => setRenaming({ ...renaming, value: e.target.value })} />
                <button className="btn sm" disabled={busy || renaming.value.trim() === ""} onClick={() => void rename()}>Guardar nombre</button>
                <button className="btn ghost sm" disabled={busy} onClick={() => setRenaming(null)}>Cancelar</button>
              </div>
            )}

            <ul className="ads-accounts-list">
              {p.accounts.length === 0 && <li className="muted">Sin cuentas todavía.</li>}
              {p.accounts.map((a) => (
                <li key={a.id}>
                  <span><strong>{a.name}</strong> <span className="muted">· {a.id} · {a.currency || "moneda sin definir"}</span></span>
                  <span className="ads-account-actions">
                    <button className="btn ghost sm" disabled={busy} onClick={() => setRenaming({ portfolio: p.id, account: a.id, value: a.name })}>Renombrar</button>
                    <button className="btn ghost sm" disabled={busy} onClick={() => setPending({ kind: "account", portfolio: p.id, account: a.id })}>Quitar</button>
                  </span>
                  {same(pending, "account", p.id, a.id) &&
                    confirmRow(`Se dejará de actualizar «${a.name}». Su historial guardado no se borra. ¿Seguro?`, () => void removeAccount(p.id, a.id))}
                  {renaming?.portfolio === p.id && renaming.account === a.id && (
                    <div className="ia-inline" style={{ marginTop: 6 }}>
                      <input className="input" aria-label="Nombre de la cuenta" value={renaming.value} onChange={(e) => setRenaming({ ...renaming, value: e.target.value })} />
                      <button className="btn sm" disabled={busy || renaming.value.trim() === ""} onClick={() => void rename()}>Guardar nombre</button>
                      <button className="btn ghost sm" disabled={busy} onClick={() => setRenaming(null)}>Cancelar</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {hasToken ? (
              <div className="ads-add-account">
                <div className="ia-inline">
                  <input className="input" placeholder="act_1234567890" aria-label={`Cuenta publicitaria para ${p.name}`} value={draft.id} onChange={(e) => setAdding((a) => ({ ...a, [p.id]: { ...draft, id: e.target.value } }))} />
                  <input className="input" placeholder="Nombre (opcional)" aria-label="Nombre de la cuenta (opcional)" value={draft.name} onChange={(e) => setAdding((a) => ({ ...a, [p.id]: { ...draft, name: e.target.value } }))} />
                  <button className="btn sm" disabled={busy || draft.id.trim() === ""} onClick={() => void addAccount(p.id, draft.id, draft.name)}>
                    <Plus size={14} aria-hidden /> Agregar cuenta
                  </button>
                </div>
                <small className="muted">La cuenta ya debe existir en Meta y estar asignada al usuario del sistema de este portafolio. Primero la verifico con Meta; si no la encuentro, no se guarda.</small>
                {available.length > 0 && (
                  <div className="chips" role="group" aria-label="Cuentas que ve este token" style={{ marginTop: 6 }}>
                    {available.map((a) => (
                      <button key={a.id} className="chip" disabled={busy} onClick={() => setAdding((m) => ({ ...m, [p.id]: { id: a.id, name: a.name } }))} title={`${a.id} · ${a.currency}`}>
                        {a.name || a.id}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <small className="muted">Pega el token de este portafolio para poder agregar cuentas.</small>
            )}
          </section>
        );
      })}

      <section className="ads-portfolio" aria-label="Nuevo portafolio">
        <strong><KeyRound size={14} aria-hidden /> Nuevo portafolio</strong>
        <div className="ia-inline" style={{ marginTop: 8 }}>
          <input className="input" placeholder="Nombre (ej.: Mi Business Manager)" aria-label="Nombre del portafolio nuevo" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input className="input" type="password" autoComplete="off" placeholder="Token de Meta" aria-label="Token del portafolio nuevo" value={newToken} onChange={(e) => setNewToken(e.target.value)} />
          <button className="btn sm" disabled={busy || newName.trim() === "" || newToken.trim() === ""} onClick={() => void createPortfolio()}>Crear y probar</button>
        </div>
        <small className="muted">El token es obligatorio: se guarda primero y luego se prueba con Meta.</small>
      </section>
    </div>
  );
}
