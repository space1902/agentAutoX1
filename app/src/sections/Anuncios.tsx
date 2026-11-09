import { Banknote, Bell, Coins, MessageCircle, Percent, RefreshCw, Target, TrendingUp, Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import AccountFilters from "../components/ads/AccountFilters";
import AdsChart from "../components/ads/AdsChart";
import AdsSetup from "../components/ads/AdsSetup";
import AdsSettings from "../components/ads/AdsSettings";
import AdsTable from "../components/ads/AdsTable";
import AlertsPanel from "../components/ads/AlertsPanel";
import BudgetsPanel from "../components/ads/BudgetsPanel";
import DecisionsPanel from "../components/ads/DecisionsPanel";
import CountriesPanel from "../components/ads/CountriesPanel";
import DateRangeBar from "../components/ads/DateRangeBar";
import HourlyChart from "../components/ads/HourlyChart";
import VouchersPanel from "../components/ads/VouchersPanel";
import { Banner, Card, Notice, Skeleton, StatCard } from "../components/ui";
import { errorText } from "../lib/api";
import {
  HOURS_NOTE,
  NO_MESSAGES,
  hourLabel,
  hoursArg,
  hoursProblem,
  isWholeDay,
  readChartView,
  readHoursChoice,
  readVoucherFilters,
  writeChartView,
  writeHoursChoice,
  writeVoucherFilters,
  type ChartView,
  type HoursWindow,
  type VoucherFilters,
} from "../lib/adsFilters";
import {
  accountsArg,
  countryChips,
  formatNative,
  fxLine,
  hiddenInactive,
  nameFilterProblem,
  noDataNote,
  readAccountsChoice,
  readCountryChoice,
  readNameFilter,
  readShowInactive,
  resolveAccountsChoice,
  resolveCountryChoice,
  visibleRows,
  writeAccountsChoice,
  writeCountryChoice,
  writeNameFilter,
  writeShowInactive,
  type AccountOption,
} from "../lib/adsView";
import {
  adsApi,
  agoText,
  countryName,
  dmy,
  formatInt,
  formatMoney,
  formatPct,
  formatRoas,
  presetRange,
  toIso,
  vatOf,
  type AdsConfig,
  type AdsStatus,
  type BudgetPlan,
  type DecisionsData,
  type DecisionStatus,
  type EnabledCountry,
  type Group,
  type Preset,
  type Report,
  type SyncResult,
  type TrackingItem,
  type VouchersData,
} from "../lib/adsApi";

const GROUPS: { id: Group; label: string }[] = [
  { id: "campaign", label: "Campaña" },
  { id: "ad", label: "Anuncio" },
];
type Tab = "resumen" | "decisiones" | "presupuestos" | "alertas" | "configuracion";

/** Opening the section only syncs when the last sync is older than this. */
const STALE_MS = 5 * 60_000;

/** Friendly text for errors that come back inside a sync result. */
function syncProblems(res: SyncResult, names: Record<string, string> = {}): string[] {
  const out: string[] = [];
  const failed = (res.accounts ?? res.meta.accounts ?? []).filter((a) => !a.ok && a.error);
  // One line per failing account (the others still refreshed); a single-account setup keeps the plain message.
  out.push(...(res.portfolioWarnings ?? []));
  if (failed.length > 0 && (res.accounts ?? res.meta.accounts ?? []).length > 1) out.push(...failed.map((a) => `${names[a.accountId] ?? a.accountId}: ${a.error}`));
  else if (!res.meta.ok && res.meta.error) out.push(res.meta.error);
  if (!res.sheet.ok && res.sheet.error) out.push(res.sheet.error);
  if (res.sheet.ok && res.sheet.warning) out.push(res.sheet.warning);
  return out;
}

export default function Anuncios() {
  const [today] = useState(() => toIso(new Date()));
  const [preset, setPreset] = useState<Preset>("today");
  const [custom, setCustom] = useState({ from: today, to: today });
  // Decisiones keeps its OWN range (default: this month); changing it does not touch the Resumen range.
  const [decPreset, setDecPreset] = useState<Preset>("month");
  const [decCustom, setDecCustom] = useState({ from: today, to: today });
  // Presupuestos keeps its OWN range too (default: this month); the filters (accounts, country, search) are shared.
  const [budPreset, setBudPreset] = useState<Preset>("month");
  const [budCustom, setBudCustom] = useState({ from: today, to: today });
  const [budgetPlan, setBudgetPlan] = useState<BudgetPlan | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [group, setGroup] = useState<Group>("campaign");
  // Campaigns that are off in Meta are hidden by default; the choice is remembered on this device.
  const [showInactive, setShowInactive] = useState(() => readShowInactive());
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState<AdsStatus | null>(null);
  const [config, setConfig] = useState<AdsConfig | null>(null);
  const [tokenPresent, setTokenPresent] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState<Tab>("resumen");
  const [decisionData, setDecisionData] = useState<DecisionsData | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  // The selected country ("" = Combinado) is remembered on this device.
  const [country, setCountry] = useState(() => readCountryChoice());
  const [fxWarning, setFxWarning] = useState<string | null>(null);
  const [split, setSplit] = useState(false);
  const [tracking, setTracking] = useState<TrackingItem[]>([]);
  const [chartKey, setChartKey] = useState("");
  // The Comprobantes card has its own dates. null = it follows the page range (and reuses the report's list).
  const [vOwn, setVOwn] = useState<{ preset: Preset; custom: { from: string; to: string } } | null>(null);
  const [vData, setVData] = useState<VouchersData | null>(null);
  // Filters of the Comprobantes list (state, bank, account, country, name/phone), remembered on this device.
  const [vFilters, setVFilters] = useState<VoucherFilters>(() => readVoucherFilters());
  // Hour-of-day window for the sales (default: the whole day), remembered on this device.
  // Which chart the shared card shows (per day / per hour), remembered on this device.
  const [chartView, setChartView] = useState<ChartView>(() => readChartView());
  const [hoursChoice, setHoursChoice] = useState<HoursWindow>(() => readHoursChoice());
  // Ad accounts in scope ([] = all) and the ad-name filter; both are remembered on this device.
  const [accountsChoice, setAccountsChoice] = useState<string[]>(() => readAccountsChoice());
  const [nameInput, setNameInput] = useState(() => readNameFilter());
  const [nameFilter, setNameFilter] = useState(() => (nameFilterProblem(readNameFilter()) ? "" : readNameFilter()));

  const range = preset === "custom" ? custom : presetRange(preset, today);
  const decRange = decPreset === "custom" ? decCustom : presetRange(decPreset, today);
  const budRange = budPreset === "custom" ? budCustom : presetRange(budPreset, today);
  const budValid = budRange.from !== "" && budRange.to !== "" && budRange.from <= budRange.to;
  const rangeValid = range.from !== "" && range.to !== "" && range.from <= range.to;
  const includesToday = range.to >= today && range.from <= today;

  const vPreset = vOwn ? vOwn.preset : preset;
  const vRange = vOwn ? (vOwn.preset === "custom" ? vOwn.custom : presetRange(vOwn.preset, today)) : range;
  const vValid = vRange.from !== "" && vRange.to !== "" && vRange.from <= vRange.to;

  const accountOptions: AccountOption[] = (Array.isArray(config?.portfolios) ? config.portfolios : []).flatMap((p) => p.accounts.map((a) => ({ id: a.id, name: a.name, portfolioId: p.id, portfolioName: p.name })));
  const accountsParam = accountsArg(accountsChoice, accountOptions);
  const accountNames = Object.fromEntries(accountOptions.map((a) => [a.id, a.name]));
  // The first-run wizard only when the configuration was read and truly has no portfolio with an account; a failed or
  // malformed read shows its error instead.
  const needsSetup = config !== null && Array.isArray(config.portfolios) && !config.portfolios.some((p) => p.accounts.length > 0);

  // The engine only gets a valid window; the whole day sends nothing.
  const hoursParam = hoursArg(hoursChoice);
  const hoursIssue = hoursProblem(hoursChoice);

  const latest = useRef({ range, group, rangeValid, includesToday, tokenPresent, config, country, split, vOwn, vRange, vValid, accountsParam, nameFilter, hoursParam });
  latest.current = { range, group, rangeValid, includesToday, tokenPresent, config, country, split, vOwn, vRange, vValid, accountsParam, nameFilter, hoursParam };
  const budSeq = useRef(0);
  const seq = useRef(0);
  const vSeq = useRef(0);

  const loadReport = useCallback(async () => {
    const { range: r, group: g, rangeValid: ok, country: c, split: sp, accountsParam: acc, nameFilter: nm, hoursParam: hp } = latest.current;
    if (!ok) return;
    const mine = ++seq.current;
    try {
      const data = await adsApi.report(r.from, r.to, g, c, sp, acc, nm, hp);
      if (mine === seq.current) setReport(data);
    } catch (e) {
      if (mine === seq.current) setProblems([errorText(e)]);
    }
  }, []);

  // Payments of the card's own range, from the local cache. Only when the card has its own dates.
  const loadVouchers = useCallback(async () => {
    const { vOwn: own, vRange: r, vValid: ok, country: c, accountsParam: acc, nameFilter: nm } = latest.current;
    if (!own || !ok) return;
    const mine = ++vSeq.current;
    try {
      const data = await adsApi.vouchers(r.from, r.to, c, acc, nm);
      if (mine === vSeq.current) setVData(data);
    } catch (e) {
      if (mine === vSeq.current) setProblems([errorText(e)]);
    }
  }, []);

  // Budget timeline and suggestions: stored data only (no Meta request). The latest filters are read from the ref.
  const loadBudgets = useCallback(async (from: string, to: string) => {
    const { country: c, accountsParam: acc, nameFilter: nm } = latest.current;
    const mine = ++budSeq.current;
    setBudgetLoading(true);
    try {
      const data = await adsApi.budgetPlan(from, to, c, acc, nm);
      if (mine === budSeq.current) setBudgetPlan(data);
    } catch (e) {
      if (mine === budSeq.current) setProblems([errorText(e)]);
    } finally {
      if (mine === budSeq.current) setBudgetLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      // tokenPresent = at least one portfolio has a token.
      const s = await adsApi.status();
      setStatus(s);
      setTokenPresent(s.tokenPresent);
      return s;
    } catch (e) {
      setProblems([errorText(e)]);
      return null;
    }
  }, []);

  const loadDecisions = useCallback(async () => {
    try {
      setDecisionData(await adsApi.decisions());
      setTracking((await adsApi.tracking()).items);
    } catch (e) {
      setProblems([errorText(e)]);
    }
  }, []);

  const changeCountry = useCallback((code: string) => {
    setCountry(code);
    writeCountryChoice(code);
  }, []);

  const changeHours = useCallback((next: HoursWindow) => {
    setHoursChoice(next);
    writeHoursChoice(next);
  }, []);

  const changeVoucherFilters = useCallback((next: VoucherFilters) => {
    setVFilters(next);
    writeVoucherFilters(next);
  }, []);

  const changeAccounts = useCallback((ids: string[]) => {
    setAccountsChoice(ids);
    writeAccountsChoice(ids);
  }, []);

  // A stored choice that points at accounts that no longer exist goes back to "Todas".
  useEffect(() => {
    if (accountOptions.length === 0) return;
    const next = resolveAccountsChoice(accountsChoice, accountOptions);
    if (next.join() !== accountsChoice.join()) changeAccounts(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, accountsChoice]);

  // The name filter is applied (and remembered) a moment after typing stops, and only when it is valid.
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (nameFilterProblem(nameInput) !== null) return;
      const clean = nameInput.trim();
      setNameFilter(clean);
      writeNameFilter(clean);
    }, 400);
    return () => window.clearTimeout(id);
  }, [nameInput]);

  // Live exchange rates (free public sources): fetched on each data refresh, never in the background. A failure keeps
  // the last saved rate and only shows a warning.
  const refreshFx = useCallback(async () => {
    try {
      const res = await adsApi.fxRefresh();
      setFxWarning(res.errors.length > 0 ? `No pude actualizar la tasa de ${res.errors.map((e) => e.currency).join(", ")}: uso la última guardada.` : null);
    } catch (e) {
      setFxWarning(`No pude actualizar la tasa de cambio: uso la última guardada. ${errorText(e)}`);
    }
  }, []);

  const doSync = useCallback(
    async () => {
      setSyncing(true);
      try {
        // Only the accounts selected on screen are queried in Meta.
        const [res] = await Promise.all([adsApi.syncAuto(latest.current.accountsParam), refreshFx()]);
        if (res.backfilled && res.history) setBanner(`Historial cargado desde ${dmy(res.history.from)} (${res.history.days} días con datos).`);
        setProblems(syncProblems(res, accountNames));
      } catch (e) {
        setProblems([errorText(e)]);
      } finally {
        await Promise.all([loadReport(), loadStatus(), loadVouchers()]);
        setSyncing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadReport, loadStatus, loadVouchers, refreshFx, accountsParam],
  );

  // First load: cached report right away, then a sync when the data is stale.
  useEffect(() => {
    (async () => {
      // Unknown until the configuration is read; if it cannot be read the dashboard loads as before and shows the error.
      let configured = true;
      try {
        const cfg = await adsApi.configGet();
        if (!Array.isArray(cfg.config?.portfolios)) throw new Error("La configuración de Anuncios no tiene el formato esperado.");
        setConfig(cfg.config);
        const options = cfg.config.portfolios.flatMap((p) => p.accounts.map((a) => ({ id: a.id, name: a.name, portfolioId: p.id, portfolioName: p.name })));
        configured = options.length > 0;
        // The first report must already use the stored account choice checked against the real accounts.
        latest.current.accountsParam = accountsArg(readAccountsChoice(), options);
      } catch (e) {
        setProblems([errorText(e)]);
      }
      const s = await loadStatus();
      if (!configured) {
        setLoaded(true);
        return;
      }
      void loadDecisions();
      await loadReport();
      setLoaded(true);
      const { rangeValid: ok } = latest.current;
      if (s?.tokenPresent && ok && (!s.history?.backfill || !s.lastSync.meta || Date.now() - s.lastSync.meta > STALE_MS)) void doSync();
      else void refreshFx().then(() => Promise.all([loadReport(), loadVouchers()]));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeStatus = async (id: number, status: DecisionStatus) => {
    try {
      await adsApi.decisionStatus(id, status);
      await loadDecisions();
    } catch (e) {
      setProblems([errorText(e)]);
    }
  };

  const setVoucherCountry = async (key: string, code: string) => {
    try {
      await adsApi.comprobanteCountry(key, code);
      await Promise.all([loadReport(), loadVouchers()]);
    } catch (e) {
      setProblems([errorText(e)]);
    }
  };

  // Accept a payment by hand (or undo it). Only the app changes; reload the cached report on this action.
  const acceptVoucher = async (key: string, undo: boolean) => {
    try {
      await adsApi.comprobanteAccept(key, undo);
      await Promise.all([loadReport(), loadVouchers()]);
    } catch (e) {
      setProblems([errorText(e)]);
    }
  };

  // Discard a payment by hand (or restore it). It stops counting everywhere; the sheet is never written.
  const rejectVoucher = async (key: string, undo: boolean) => {
    try {
      await adsApi.comprobanteReject(key, undo);
      await Promise.all([loadReport(), loadVouchers()]);
    } catch (e) {
      setProblems([errorText(e)]);
    }
  };

  // Correct the amount of a payment (null restores the sheet value). Totals follow; the sheet is never written.
  const setVoucherValue = async (key: string, valor: number | null) => {
    try {
      await adsApi.comprobanteValue(key, valor);
      await Promise.all([loadReport(), loadVouchers()]);
    } catch (e) {
      setProblems([errorText(e)]);
    }
  };

  // "N por revisar" jumps to the Comprobantes card, following the page range, filtered to the pending ones.
  const showPending = () => {
    setVOwn(null);
    changeVoucherFilters({ ...vFilters, state: "review" });
    window.setTimeout(() => document.getElementById("ads-comprobantes")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };

  const evaluateNow = async () => {
    setEvaluating(true);
    try {
      const res = await adsApi.tickNow();
      setProblems(res.warnings);
      if (res.created.length === 0) setBanner("Revisé todo: no hay decisiones nuevas por ahora.");
    } catch (e) {
      setProblems([errorText(e)]);
    } finally {
      await loadDecisions();
      setEvaluating(false);
    }
  };

  // Range or grouping changed: read the local cache (no network).
  useEffect(() => {
    if (loaded) void loadReport();
  }, [preset, custom, group, country, split, accountsParam, nameFilter, hoursParam, loaded, loadReport]);

  // The card's own range or the country filter changed: read the local cache (no network).
  useEffect(() => {
    if (loaded) void loadVouchers();
  }, [vOwn, country, accountsParam, nameFilter, loaded, loadVouchers]);

  // Presupuestos reads the local cache when its tab is open and its range, the shared filters or the last refresh change.
  const lastRefresh = report?.lastSync.meta ?? status?.lastSync.meta ?? null;
  useEffect(() => {
    if (loaded && tab === "presupuestos" && budValid) void loadBudgets(budRange.from, budRange.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, loaded, budValid, budRange.from, budRange.to, country, accountsParam, nameFilter, lastRefresh, loadBudgets]);

  // "Actualizado hace X min" re-renders its text while the section is open; it never reloads data.
  // Data refreshes only on mount, on "Actualizar" and when the range/filters change (no polling, no scheduler events).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const pendingCount = decisionData?.decisions.filter((d) => d.status === "pending").length ?? 0;
  const k = report?.kpis;
  // Countries offered by the selector: every enabled one, even without data (before the first report, from the config).
  const enabledCountries: EnabledCountry[] =
    report?.enabledCountries ??
    (config?.enabledCountries ?? []).map((code) => ({ country: code, name: countryName(code), currency: config?.countries[code]?.currency ?? "COP", hasData: true }));
  // A saved choice on a country that is no longer enabled would show nothing: go back to "Combinado".
  useEffect(() => {
    if (!report?.enabledCountries) return;
    const next = resolveCountryChoice(country, report.enabledCountries);
    if (next !== country) changeCountry(next);
  }, [report, country, changeCountry]);
  const selectedEnabled = enabledCountries.find((c) => c.country === country);
  const fxShown = (report?.fx ?? []).filter((f) => !country || country === "-" || f.country === country);
  const emptyNote = noDataNote(country, enabledCountries);
  const nativeValue = selectedEnabled && report && k?.valorNative !== undefined ? formatNative(selectedEnabled.currency, k.valorNative) : null;
  const changeShowInactive = (value: boolean) => {
    setShowInactive(value);
    writeShowInactive(value);
  };
  const allRows = report?.rows ?? [];
  const shownRows = visibleRows(allRows, showInactive);
  // The totals above always include every campaign; when the off ones are hidden, say how much of the spend they hold.
  const hidden = hiddenInactive(allRows, showInactive);
  const one = hidden.count === 1;
  const unit = group === "ad" ? (one ? "anuncio desactivado" : "anuncios desactivados") : one ? "campaña desactivada" : "campañas desactivadas";
  // The chart focuses on one campaign when it is picked; one that left the range (or got hidden) falls back to "all".
  const chartOptions = (report?.campaignDaily ?? []).filter((c) => showInactive || !c.paused || c.key === chartKey);
  const chartSeries = chartOptions.find((c) => c.key === chartKey);
  const chartTitle = `${chartView === "hour" ? "Gasto y ventas por hora" : "Gasto contra valor por día"} · ${chartSeries ? chartSeries.campaign : "Todas las campañas"}`;
  const hourlyData = chartSeries ? report?.campaignHourly?.find((c) => c.key === chartSeries.key)?.hourly : report?.hourly;
  const changeChartView = (view: ChartView) => {
    setChartView(view);
    writeChartView(view);
  };
  const updated = report?.lastSync.meta ?? status?.lastSync.meta ?? null;
  // Accounts in scope whose last refresh failed (the rest of the numbers are still shown).
  const inScope = accountsParam ? accountsParam.split(",") : accountOptions.map((a) => a.id);
  const accountIssues = inScope.flatMap((id) => {
    const last = (report?.lastSync ?? status?.lastSync)?.accounts?.[id];
    return last && !last.ok && last.error ? [`${accountNames[id] ?? id}: la última actualización falló. ${last.error}`] : [];
  });
  const reportNotes = [...(report?.warnings ?? []), ...(report?.notes ?? [])].map((n) => n.message);
  const ownReady = vOwn !== null && vData !== null && vData.range.from === vRange.from && vData.range.to === vRange.to;
  const vouchers = vOwn ? (ownReady ? vData : null) : report ? { comprobantes: report.comprobantes, reviewCount: report.reviewCount } : null;
  const rangeLabel = range.from === range.to ? range.from : `${range.from} → ${range.to}`;

  return (
    <div className="page">
      <Banner title="Anuncios" subtitle="Gasto de Meta contra pagos válidos de la hoja: ROAS, costo por venta y qué hacer con cada anuncio." />

      {banner && (
        <Notice kind="ok">
          <Bell size={14} aria-hidden /> {banner}{" "}
          <button className="btn ghost sm" onClick={() => { setBanner(null); setTab("decisiones"); }}>Ver decisiones</button>
          <button className="btn ghost sm" onClick={() => setBanner(null)}>Cerrar</button>
        </Notice>
      )}
      {problems.map((p) => (
        <Notice key={p}>{p}</Notice>
      ))}
      {!needsSetup && !tokenPresent && tab !== "configuracion" && (
        <Notice>
          Falta el token de Meta.{" "}
          <button className="btn ghost sm" onClick={() => setTab("configuracion")}>Ir a Configuración</button>
        </Notice>
      )}

      {needsSetup && config ? (
        <Card>
          <AdsSetup
            config={config}
            onDone={(c) => {
              setConfig(c);
              void loadStatus().then(() => doSync());
              void loadDecisions();
            }}
          />
        </Card>
      ) : (
      <>
      <div className="ia-tabs ads-tabs" role="tablist" aria-label="Secciones de Anuncios">
        <button role="tab" aria-selected={tab === "resumen"} className={`ia-tab ${tab === "resumen" ? "active" : ""}`} onClick={() => setTab("resumen")}>Resumen</button>
        <button role="tab" aria-selected={tab === "decisiones"} className={`ia-tab ${tab === "decisiones" ? "active" : ""}`} onClick={() => setTab("decisiones")}>
          Decisiones{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </button>
        <button role="tab" aria-selected={tab === "presupuestos"} className={`ia-tab ${tab === "presupuestos" ? "active" : ""}`} onClick={() => setTab("presupuestos")}>Presupuestos</button>
        <button role="tab" aria-selected={tab === "alertas"} className={`ia-tab ${tab === "alertas" ? "active" : ""}`} onClick={() => setTab("alertas")}>Alertas</button>
        <button role="tab" aria-selected={tab === "configuracion"} className={`ia-tab ${tab === "configuracion" ? "active" : ""}`} onClick={() => setTab("configuracion")}>Configuración</button>
      </div>

      {tab === "decisiones" && (
        <>
        <Card>
          <DateRangeBar
            preset={decPreset}
            range={decRange}
            today={today}
            minDate={report?.history.from ?? report?.history.firstData ?? null}
            onPreset={setDecPreset}
            onRange={(from, to) => {
              setDecCustom({ from, to });
              setDecPreset("custom");
            }}
          />
        </Card>
        <DecisionsPanel range={decRange} tracking={tracking} decisions={decisionData?.decisions ?? []} activitiesOk={decisionData?.activitiesOk ?? null} lifecycle={decisionData?.lifecycle ?? null} busy={evaluating} onStatus={(id, s) => void changeStatus(id, s)} onEvaluate={() => void evaluateNow()} />
        </>
      )}

      {tab === "presupuestos" && (
        <>
        <Card>
          <AccountFilters accounts={accountOptions} choice={accountsChoice} onChoice={changeAccounts} nameInput={nameInput} onNameInput={setNameInput} />
          {enabledCountries.length > 0 && (
            <div className="ads-countries-bar" style={{ marginTop: 0, marginBottom: 12 }}>
              <div className="chips" role="group" aria-label="País">
                {countryChips(enabledCountries).map((c) => (
                  <button key={c.id || "all"} className={`chip ads-chip ${country === c.id ? "on" : ""}`} aria-pressed={country === c.id} onClick={() => changeCountry(c.id)}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <DateRangeBar
            preset={budPreset}
            range={budRange}
            today={today}
            minDate={report?.history.from ?? report?.history.firstData ?? null}
            onPreset={setBudPreset}
            onRange={(from, to) => {
              setBudCustom({ from, to });
              setBudPreset("custom");
            }}
          />
        </Card>
        <BudgetsPanel plan={budgetPlan} loading={budgetLoading} />
        </>
      )}

      {tab === "alertas" && <AlertsPanel />}

      {tab === "configuracion" && config && (
        <Card>
          <div className="card-head">
            <h2 className="card-title">Configuración de Anuncios</h2>
          </div>
          <AdsSettings
            detected={report?.detected ?? []}
            config={config}
            onTokenChange={() => void loadStatus()}
            onPortfoliosChanged={(c) => {
              // Portfolios or accounts changed: the selector and the cached numbers follow (no network).
              setConfig(c);
              void loadStatus();
              void Promise.all([loadReport(), loadVouchers()]);
            }}
            onConfigSaved={(c) => {
              setConfig(c);
              // The rate mode or the enabled countries may have changed: refresh the live rates, then redraw.
              void refreshFx().then(() => Promise.all([loadReport(), loadVouchers()]));
            }}
          />
        </Card>
      )}

      {tab === "resumen" && (
      <>
      <Card>
        <AccountFilters accounts={accountOptions} choice={accountsChoice} onChoice={changeAccounts} nameInput={nameInput} onNameInput={setNameInput} />
        {accountIssues.map((m) => (
          <p key={m} className="ads-warn" role="status">{m}</p>
        ))}
        {enabledCountries.length > 0 && (
          <div className="ads-countries-bar" style={{ marginTop: 0, marginBottom: 12 }}>
            <div className="chips" role="group" aria-label="País">
              {countryChips(enabledCountries).map((c) => (
                <button key={c.id || "all"} className={`chip ads-chip ${country === c.id ? "on" : ""}`} aria-pressed={country === c.id} onClick={() => changeCountry(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
            {group === "campaign" && enabledCountries.length > 1 && (
              <label className="ads-check">
                <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} /> Separar campañas por país
              </label>
            )}
          </div>
        )}
        {fxShown.length > 0 && (
          <p className="muted ads-note" style={{ marginTop: 0, marginBottom: 10 }} role="status">
            {fxShown.map((f) => (
              <span key={f.country} style={{ marginRight: 14 }}>{fxLine(f, now)}</span>
            ))}
          </p>
        )}
        {fxWarning && <p className="ads-warn" role="status">{fxWarning}</p>}
        {emptyNote && <p className="muted ads-note" style={{ marginTop: 0, marginBottom: 10 }} role="status">{emptyNote}</p>}
        <DateRangeBar
          preset={preset}
          range={range}
          today={today}
          minDate={report?.history.from ?? report?.history.firstData ?? null}
          onPreset={setPreset}
          onRange={(from, to) => {
            setCustom({ from, to });
            setPreset("custom");
            // "Aplicar" is a data refresh too: pick up today's exchange rate, then redraw.
            void refreshFx().then(() => loadReport());
          }}
        >
          <div className="ads-refresh">
            <span className="muted" role="status">
              Actualizado {agoText(updated, now)}
            </span>
            <button className="btn" disabled={syncing || !tokenPresent} onClick={() => void doSync()}>
              <RefreshCw size={16} aria-hidden className={syncing ? "spin" : ""} /> {syncing ? "Actualizando…" : "Actualizar"}
            </button>
          </div>
        </DateRangeBar>
        <div className="ads-toggle-bar">
          <label className="ads-check">
            <input type="checkbox" checked={showInactive} onChange={(e) => changeShowInactive(e.target.checked)} /> Mostrar desactivadas
          </label>
          <span className="muted">Por defecto solo ves las campañas activas; las desactivadas siguen contando en los totales.</span>
        </div>
        <div className="ads-hours-bar" role="group" aria-label="Horario de las ventas">
          <span className="ads-hours-label">Horario:</span>
          <label>
            <span className="muted">de</span>
            <select className="input" aria-label="Hora de inicio" value={hoursChoice.start} onChange={(e) => changeHours({ ...hoursChoice, start: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </label>
          <label>
            <span className="muted">a</span>
            <select className="input" aria-label="Hora de fin" value={hoursChoice.end} onChange={(e) => changeHours({ ...hoursChoice, end: Number(e.target.value) })}>
              {Array.from({ length: 25 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </label>
          {!isWholeDay(hoursChoice) && <button className="btn ghost sm" onClick={() => changeHours({ start: 0, end: 24 })}>Todo el día</button>}
          <span className="muted">
            {hoursIssue ?? (hoursParam === null ? "Todo el día. La hora de inicio cuenta y la de fin no (de 08:00 a 12:00 son las horas 8, 9, 10 y 11). Si el fin es menor que el inicio, cruza la medianoche (ej.: 22:00 a 06:00)." : hoursChoice.start > hoursChoice.end ? "Cruza la medianoche. Cuenta los pagos y el gasto de esas horas (hora de Bogotá)." : "Cuenta los pagos y el gasto de esas horas (hora de Bogotá); la hora de fin no se incluye.")}
          </span>
        </div>
        {hoursParam !== null && <p className="ads-warn" role="status">{HOURS_NOTE}</p>}
        {report?.history && (
          <p className="muted ads-note ads-history">
            Historial: desde {dmy(report.history.from)} · {report.history.days} días guardados · {report.history.vouchers} comprobantes · última sincronización {agoText(report.lastSync.meta ?? report.lastSync.sheet, now)}
          </p>
        )}
        {!rangeValid && <p className="muted">Elige un rango válido: la fecha inicial no puede ser posterior a la final.</p>}
        {preset === "today" && <p className="muted ads-note">El gasto de hoy es en vivo: se trae directo de Meta cuando pulsas «Actualizar» o entras a la sección.</p>}
      </Card>

      {!loaded || !k ? (
        <Skeleton height={110} />
      ) : (
        <div className="stats">
          <StatCard icon={Wallet} label="Gasto" value={formatMoney(k.gasto)} caption={<>{vatOf(k) > 0 && <span className="ads-vat-line">IVA: {formatMoney(vatOf(k))}<br /></span>}{rangeLabel}</>} />
          <StatCard icon={Target} label="Ventas (pagos)" value={formatInt(k.ventas)} caption={
              (report?.reviewCount ?? 0) > 0 ? (
                <button className="ads-sort" onClick={showPending} title="Ver los comprobantes por revisar">{report?.reviewCount} por revisar</button>
              ) : (
                "0 por revisar"
              )
            }
          />
          <StatCard icon={Banknote} label="Valor" value={formatMoney(k.valor)} caption={<>{nativeValue && <span className="ads-vat-line">{nativeValue}<br /></span>}{`Resultado ${formatMoney(k.resultado)}`}</>} />
          <StatCard icon={TrendingUp} label="ROAS" value={k.gasto > 0 ? formatRoas(k.roas) : "—"} caption="Valor / gasto sin IVA" />
          <StatCard icon={Coins} label="Costo por venta" value={k.ventas > 0 && k.gasto > 0 ? formatMoney(k.costoVenta) : "—"} caption="Gasto / ventas" />
          <StatCard icon={MessageCircle} label="Mensajes" value={k.mensajes === null ? NO_MESSAGES : formatInt(k.mensajes)} caption={k.mensajes === null ? "No se separan por hora" : k.mensajes > 0 && k.costoMensaje !== null ? `${formatMoney(k.costoMensaje)} cada uno` : "Conversaciones iniciadas"} />
          <StatCard icon={Banknote} label="Margen bruto" value={formatMoney(k.margen)} caption={`${k.valor > 0 ? formatPct(k.margenPct) : "—"} del valor, tras comisiones y costos`} />
          <StatCard icon={Percent} label="% conversión" value={k.mensajes === null ? NO_MESSAGES : k.mensajes > 0 && k.conversion !== null ? formatPct(k.conversion) : "—"} caption="Ventas / mensajes" />
        </div>
      )}
      {loaded && k && hidden.count > 0 && (
        <p className="muted ads-note ads-inactive-note" role="status">
          Incluye {formatMoney(hidden.gasto)} de {hidden.count} {unit}.{" "}
          <button className="ads-sort" onClick={() => changeShowInactive(true)}>Mostrarlas</button>
        </p>
      )}

      {reportNotes.map((m) => (
        <p key={m} className="muted ads-note ads-inactive-note" role="status">{m}</p>
      ))}

      {accountOptions.length > 1 && (report?.accounts?.length ?? 0) > 0 && (
        <Card>
          <div className="card-head">
            <h2 className="card-title">Por cuenta</h2>
            <span className="muted">Gasto (con IVA) y pagos atribuidos a cada cuenta; «Sin cuenta» son pagos que no se pueden ligar a un anuncio</span>
          </div>
          <table className="ads-table">
            <thead>
              <tr><th>Cuenta</th><th>Gasto</th><th>Ventas</th><th>Valor</th><th title="Valor / gasto sin IVA">ROAS</th></tr>
            </thead>
            <tbody>
              {(report?.accounts ?? []).map((a) => (
                <tr key={a.accountId || "none"}>
                  <td>{a.name}{a.portfolioName ? <span className="muted"> · {a.portfolioName}</span> : null}</td>
                  <td>{formatMoney(a.gasto)}</td>
                  <td>{formatInt(a.ventas)}</td>
                  <td>{formatMoney(a.valor)}</td>
                  <td>{a.gasto > 0 ? formatRoas(a.roas) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card>
        <div className="card-head">
          <h2 className="card-title">Por país</h2>
          <span className="muted">Gasto por país de entrega · ventas por país del cliente</span>
        </div>
        {report ? <CountriesPanel countries={report.countries} selected={country} onSelect={changeCountry} /> : <Skeleton height={100} />}
      </Card>

      <Card>
        <div className="card-head">
          <h2 className="card-title">Rendimiento</h2>
          <div className="ia-tabs ads-group" role="tablist" aria-label="Agrupar por">
            {GROUPS.map((g) => (
              <button key={g.id} role="tab" aria-selected={group === g.id} className={`ia-tab ${group === g.id ? "active" : ""}`} onClick={() => setGroup(g.id)}>
                {g.label}
              </button>
            ))}
          </div>
        </div>
        {report ? <AdsTable rows={shownRows} group={group} restricted={report.hours?.restricted ?? false} emptyText={allRows.length > 0 ? "Todo lo que gastó en este rango está desactivado. Marca «Mostrar desactivadas» para verlo." : undefined} /> : <Skeleton height={160} />}
        {report && (
          <p className="muted ads-note">
            {report.settings.campaignPrefix && report.settings.campaignPrefix.toLowerCase() !== "all" ? `Solo campañas que empiezan por «${report.settings.campaignPrefix}»` : "Todas las campañas de la cuenta"} y pagos del flujo «{report.settings.flowPrefix || "todos"}». El «día N» cuenta desde el primer día con gasto.
          </p>
        )}
      </Card>

      <Card>
        <div className="card-head">
          <h2 className="card-title">{chartTitle}</h2>
          <div className="ads-chart-controls">
            <div className="ia-tabs ads-group" role="tablist" aria-label="Ver el gráfico por">
              {([["day", "Por día"], ["hour", "Por hora"]] as const).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={chartView === id} className={`ia-tab ${chartView === id ? "active" : ""}`} onClick={() => changeChartView(id)}>
                  {label}
                </button>
              ))}
            </div>
            <label className="ads-chart-select">
              <span className="muted">Campaña</span>
              <select className="input" value={chartSeries ? chartSeries.key : ""} onChange={(e) => setChartKey(e.target.value)} aria-label="Campaña del gráfico">
                <option value="">Todas las campañas</option>
                {chartOptions.map((c) => (
                  <option key={c.key} value={c.key}>{c.campaign}{c.paused ? " (apagada)" : ""}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {chartView === "hour" && (
          <p className="muted ads-note">
            Hora de Bogotá. Las ventas y el valor van por la hora en que se registró el pago; el gasto, por la hora en que Meta lo entregó (a nivel de anuncio){hoursParam !== null ? ` · horario ${hourLabel(hoursChoice.start)}–${hourLabel(hoursChoice.end)} resaltado` : ""}.
            {report?.hourlySpend && !report.hourlySpend.available ? " Aún no hay gasto por hora guardado: se guarda en la próxima actualización de datos." : report?.hourlySpend && report.hourlySpend.daysMissing > 0 ? ` Gasto por hora no disponible en ${report.hourlySpend.daysMissing} ${report.hourlySpend.daysMissing === 1 ? "día" : "días"} del rango (solo se guardan los últimos días).` : ""}
          </p>
        )}
        {report ? (
          chartView === "hour" ? (hourlyData ? <HourlyChart data={hourlyData} window={hoursChoice} /> : <p className="muted ads-note">Esta campaña no tiene ventas ni gasto por hora en el rango.</p>) : <AdsChart data={chartSeries ? chartSeries.daily : report.daily} />
        ) : <Skeleton height={200} />}
      </Card>

      <Card id="ads-comprobantes">
        <div className="card-head">
          <h2 className="card-title">Comprobantes</h2>
          <span className="muted">{vouchers ? `${vouchers.comprobantes.length} en el rango` : ""}</span>
        </div>
        <DateRangeBar
          preset={vPreset}
          range={vRange}
          today={today}
          minDate={report?.history.from ?? report?.history.firstData ?? null}
          onPreset={(p) => setVOwn({ preset: p, custom: vRange })}
          onRange={(from, to) => setVOwn({ preset: "custom", custom: { from, to } })}
        />
        {vouchers ? <VouchersPanel vouchers={vouchers.comprobantes} filters={vFilters} onFilters={changeVoucherFilters} accounts={accountOptions.map((a) => ({ id: a.id, name: a.name }))} onValue={setVoucherValue} onCountry={(key, code) => void setVoucherCountry(key, code)} onAccept={acceptVoucher} onReject={rejectVoucher} /> : <Skeleton height={120} />}
      </Card>
      </>
      )}
      </>
      )}
    </div>
  );
}
