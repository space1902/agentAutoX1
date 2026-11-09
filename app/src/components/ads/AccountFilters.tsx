import { accountChipGroups, nameFilterProblem, selectOnlyAccount, toggleAccount, type AccountOption } from "../../lib/adsView";

interface Props {
  accounts: AccountOption[];
  /** Selected account ids; [] = all. */
  choice: string[];
  onChoice: (ids: string[]) => void;
  nameInput: string;
  onNameInput: (value: string) => void;
}

/** Account chips ("Todas" + one per account, tick boxes for several) and the ad-name filter. */
export default function AccountFilters({ accounts, choice, onChoice, nameInput, onNameInput }: Props) {
  const groups = accountChipGroups(accounts);
  const problem = nameFilterProblem(nameInput);
  const selected = (id: string) => choice.length === 0 || choice.includes(id);
  return (
    <div className="ads-account-filters">
      {accounts.length > 0 && (
        <div role="group" aria-label="Cuenta publicitaria">
          <div className="chips ads-account-chips">
            <button className={`chip ads-chip ${choice.length === 0 ? "on" : ""}`} aria-pressed={choice.length === 0} onClick={() => onChoice([])}>
              Todas
            </button>
            {groups.map((g) => (
              <span key={g.portfolioId} className="ads-account-group">
                {g.label && <span className="muted ads-account-group-label">{g.label}</span>}
                {g.accounts.map((a) => {
                  const only = choice.length === 1 && choice[0] === a.id;
                  return (
                    <span key={a.id} className={`chip ads-chip ads-account-chip ${choice.length > 0 && selected(a.id) ? "on" : ""}`}>
                      {accounts.length > 1 && (
                        <input
                          type="checkbox"
                          checked={selected(a.id)}
                          onChange={() => onChoice(toggleAccount(choice, a.id, accounts))}
                          aria-label={`Incluir ${a.name}`}
                          title="Marca varias cuentas para verlas juntas"
                        />
                      )}
                      <button className="ads-account-name" aria-pressed={only} onClick={() => onChoice(selectOnlyAccount(a.id, accounts))} title="Ver solo esta cuenta">
                        {a.name}
                      </button>
                    </span>
                  );
                })}
              </span>
            ))}
          </div>
        </div>
      )}
      <label className="ads-name-filter">
        <span className="muted">Buscar</span>
        <input
          className="input"
          value={nameInput}
          placeholder="Buscar anuncio, conjunto o campaña (ej.: pcol, ct 07)"
          aria-label="Buscar anuncio, conjunto o campaña"
          aria-invalid={problem !== null}
          onChange={(e) => onNameInput(e.target.value)}
        />
        {problem ? <small className="ads-warn" style={{ margin: 0 }}>{problem}</small> : <small className="muted">Anuncios cuyo nombre, conjunto o campaña contiene alguno de estos textos (sin importar mayúsculas ni tildes), separados por coma.</small>}
      </label>
    </div>
  );
}
