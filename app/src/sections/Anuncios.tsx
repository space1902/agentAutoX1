import { AlertTriangle, Banknote, Bell, Coins, MessageCircle, Percent, RefreshCw, Target, TrendingUp, Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import AdsChart from "../components/ads/AdsChart";
import AdsSettings from "../components/ads/AdsSettings";
import AdsTable from "../components/ads/AdsTable";
import AlertsPanel from "../components/ads/AlertsPanel";
import DecisionsPanel from "../components/ads/DecisionsPanel";
import CountriesPanel from "../components/ads/CountriesPanel";
import DateRangeBar from "../components/ads/DateRangeBar";
import VouchersPanel, { type VoucherFilter } from "../components/ads/VouchersPanel";
import { Banner, Card, Notice, Skeleton, StatCard } from "../components/ui";
import { errorText } from "../lib/api";
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
  type AdsConfig,
  type AdsStatus,
  type DecisionsData,
  type DecisionStatus,
  type Group,
  type Preset,
  type Report,
  type SyncResult,
  type TrackingItem,
  type VouchersData,
} from "../lib/adsApi";

const GROUPS: { id: Group; label: string }[] = [
  { id: "ct", label: "CT" },
  { id: "campaign", label: "Campaña" },
  { id: "ad", label: "Anuncio" },
];
type Tab = "resumen" | "decisiones" | "alertas" | "configuracion";

/** Opening the section only syncs when the last sync is older than this. */
const STALE_MS = 5 * 60_000;

/** Friendly text for errors that come back inside a sync result. */
function syncProblems(res: SyncResult): string[] {
  const out: string[] = [];
  if (!res.meta.ok && res.meta.error) out.push(res.meta.error);
  if (!res.sheet.ok && res.sheet.error) out.push(res.sheet.error);
  return out;
}

export default function Anuncios() {
  const [today] = useState(() => toIso(new Date()));
  const [preset, setPreset] = useState<Preset>("today");
  const [custom, setCustom] = useState({ from: today, to: today });
  // Decisiones keeps its OWN range (default: this month); changing it does not touch the Resumen range.
  const [decPreset, setDecPreset] = useState<Preset>("month");
  const [decCustom, setDecCustom] = useState({ from: today, to: today });
  const [group, setGroup] = useState<Group>("ct");
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
  const [country, setCountry] = useState("");
  const [split, setSplit] = useState(false);
  const [tracking, setTracking] = useState<TrackingItem[]>([]);
  const [chartCt, setChartCt] = useState("");
  // The Comprobantes card has its own dates. null = it follows the page range (and reuses the report's list).
  const [vOwn, setVOwn] = useState<{ preset: Preset; custom: { from: string; to: string } } | null>(null);
  const [vData, setVData] = useState<VouchersData | null>(null);
  const [vFilter, setVFilter] = useState<VoucherFilter>("all");

  const range = preset === "custom" ? custom : presetRange(preset, today);
  const decRange = decPreset === "custom" ? decCustom : presetRange(decPreset, today);
  const rangeValid = range.from !== "" && range.to !== "" && range.from <= range.to;
  const includesToday = range.to >= today && range.from <= today;

  const vPreset = vOwn ? vOwn.preset : preset;
  const vRange = vOwn ? (vOwn.preset === "custom" ? vOwn.custom : presetRange(vOwn.preset, today)) : range;
  const vValid = vRange.from !== "" && vRange.to !== "" && vRange.from <= vRange.to;

  const latest = useRef({ range, group, rangeValid, includesToday, tokenPresent, config, country, split, vOwn, vRange, vValid });
  latest.current = { range, group, rangeValid, includesToday, tokenPresent, config, country, split, vOwn, vRange, vValid };
  const seq = useRef(0);
  const vSeq = useRef(0);

  const loadReport = useCallback(async () => {
    const { range: r, group: g, rangeValid: ok, country: c, split: sp } = latest.current;
    if (!ok) return;
    const mine = ++seq.current;
    try {
      const data = await adsApi.report(r.from, r.to, g, c, sp);
      if (mine === seq.current) setReport(data);
    } catch (e) {
      if (mine === seq.current) setProblems([errorText(e)]);
    }
  }, []);

  // Payments of the card's own range, from the local cache. Only when the card has its own dates.
  const loadVouchers = useCallback(async () => {
    const { vOwn: own, vRange: r, vValid: ok, country: c } = latest.current;
    if (!own || !ok) return;
    const mine = ++vSeq.current;
    try {
      const data = await adsApi.vouchers(r.from, r.to, c);
      if (mine === vSeq.current) setVData(data);
    } catch (e) {
      if (mine === vSeq.current) setProblems([errorText(e)]);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([adsApi.status(), adsApi.tokenStatus()]);
      setStatus(s);
      setTokenPresent(t);
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

  const doSync = useCallback(
    async () => {
      setSyncing(true);
      try {
        const res = await adsApi.syncAuto();
        if (res.backfilled && res.history) setBanner(`Historial cargado desde ${dmy(res.history.from)} (${res.history.days} días con datos).`);
        setProblems(syncProblems(res));
      } catch (e) {
        setProblems([errorText(e)]);
      } finally {
        await Promise.all([loadReport(), loadStatus(), loadVouchers()]);
        setSyncing(false);
      }
    },
    [loadReport, loadStatus, loadVouchers],
  );

  // First load: cached report right away, then a sync when the data is stale.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await adsApi.configGet();
        setConfig(cfg.config);
      } catch (e) {
        setProblems([errorText(e)]);
      }
      const s = await loadStatus();
      void loadDecisions();
      await loadReport();
      setLoaded(true);
      const { rangeValid: ok } = latest.current;
      if (s?.tokenPresent && ok && (!s.history?.backfill || !s.lastSync.meta || Date.now() - s.lastSync.meta > STALE_MS)) void doSync();
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

  // "N por revisar" jumps to the Comprobantes card, following the page range, filtered to the pending ones.
  const showPending = () => {
    setVOwn(null);
    setVFilter("review");
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
  }, [preset, custom, group, country, split, loaded, loadReport]);

  // The card's own range or the country filter changed: read the local cache (no network).
  useEffect(() => {
    if (loaded) void loadVouchers();
  }, [vOwn, country, loaded, loadVouchers]);

  // "Actualizado hace X min" re-renders its text while the section is open; it never reloads data.
  // Data refreshes only on mount, on "Actualizar" and when the range/filters change (no polling, no scheduler events).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const pendingCount = decisionData?.decisions.filter((d) => d.status === "pending").length ?? 0;
  const k = report?.kpis;
  // A filter on a country that is no longer enabled would show nothing: go back to "Todos".
  useEffect(() => {
    if (report && country && country !== "-" && !report.countries.some((c) => c.country === country)) setCountry("");
  }, [report, country]);
  // The chart focuses on one CT when it is picked; a CT that left the range falls back to "all".
  const ctOptions = report?.ctDaily ?? [];
  const chartSeries = ctOptions.find((c) => c.ct === chartCt);
  const chartTitle = chartSeries ? `Gasto contra valor por día · ${chartSeries.ct}` : "Gasto contra valor por día · Todas las campañas";
  const updated = report?.lastSync.meta ?? status?.lastSync.meta ?? null;
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
      {!tokenPresent && tab !== "configuracion" && (
        <Notice>
          Falta el token de Meta.{" "}
          <button className="btn ghost sm" onClick={() => setTab("configuracion")}>Ir a Configuración</button>
        </Notice>
      )}

      <div className="ia-tabs ads-tabs" role="tablist" aria-label="Secciones de Anuncios">
        <button role="tab" aria-selected={tab === "resumen"} className={`ia-tab ${tab === "resumen" ? "active" : ""}`} onClick={() => setTab("resumen")}>Resumen</button>
        <button role="tab" aria-selected={tab === "decisiones"} className={`ia-tab ${tab === "decisiones" ? "active" : ""}`} onClick={() => setTab("decisiones")}>
          Decisiones{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </button>
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

      {tab === "alertas" && <AlertsPanel />}

      {tab === "configuracion" && config && (
        <Card>
          <div className="card-head">
            <h2 className="card-title">Configuración de Anuncios</h2>
          </div>
          <AdsSettings
            detected={report?.detected ?? []}
            tokenPresent={tokenPresent}
            config={config}
            onTokenChange={() => void loadStatus()}
            onConfigSaved={(c) => {
              setConfig(c);
              void loadReport();
            }}
          />
        </Card>
      )}

      {tab === "resumen" && (
      <>
      <Card>
        <DateRangeBar
          preset={preset}
          range={range}
          today={today}
          minDate={report?.history.from ?? report?.history.firstData ?? null}
          onPreset={setPreset}
          onRange={(from, to) => {
            setCustom({ from, to });
            setPreset("custom");
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
        {report && report.countries.filter((c) => c.country).length > 1 && (
          <div className="ads-countries-bar">
            <div className="chips" role="group" aria-label="Filtrar por país">
              <button className={`chip ads-chip ${country === "" ? "on" : ""}`} aria-pressed={country === ""} onClick={() => setCountry("")}>Todos</button>
              {report.countries.filter((c) => c.country).map((c) => (
                <button key={c.country} className={`chip ads-chip ${country === c.country ? "on" : ""}`} aria-pressed={country === c.country} onClick={() => setCountry(c.country)}>
                  {c.country} · {countryName(c.country)}
                </button>
              ))}
            </div>
            {group === "ct" && (
              <label className="ads-check">
                <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} /> Separar CT por país
              </label>
            )}
          </div>
        )}
        {report?.history && (
          <p className="muted ads-note ads-history">
            Historial: desde {dmy(report.history.from)} · {report.history.days} días guardados · {report.history.vouchers} comprobantes · última sincronización {agoText(report.lastSync.meta ?? report.lastSync.sheet, now)}
          </p>
        )}
        {report && report.ctIssues.length > 0 && (
          <p className="ads-warn" role="status">
            <AlertTriangle size={14} aria-hidden />
            <span>
              Nombre sin CT reconocible: {report.ctIssues.slice(0, 4).map((i) => `«${i.campaignName || i.adName}»${i.reason === "ambiguo" ? " (ambiguo)" : ""}`).join(", ")}
              {report.ctIssues.length > 4 ? ` y ${report.ctIssues.length - 4} más` : ""}. Ponle un número de CT al nombre (por ejemplo «CT 07 Col 2») para que cuente en su CT.
            </span>
          </p>
        )}
        {!rangeValid && <p className="muted">Elige un rango válido: la fecha inicial no puede ser posterior a la final.</p>}
        {preset === "today" && <p className="muted ads-note">El gasto de hoy es en vivo: se trae directo de Meta cuando pulsas «Actualizar» o entras a la sección.</p>}
      </Card>

      {!loaded || !k ? (
        <Skeleton height={110} />
      ) : (
        <div className="stats">
          <StatCard icon={Wallet} label="Gasto" value={formatMoney(k.gasto)} caption={rangeLabel} />
          <StatCard icon={Target} label="Ventas (pagos)" value={formatInt(k.ventas)} caption={
              (report?.reviewCount ?? 0) > 0 ? (
                <button className="ads-sort" onClick={showPending} title="Ver los comprobantes por revisar">{report?.reviewCount} por revisar</button>
              ) : (
                "0 por revisar"
              )
            }
          />
          <StatCard icon={Banknote} label="Valor" value={formatMoney(k.valor)} caption={`Resultado ${formatMoney(k.resultado)}`} />
          <StatCard icon={TrendingUp} label="ROAS" value={k.gasto > 0 ? formatRoas(k.roas) : "—"} caption="Valor / gasto" />
          <StatCard icon={Coins} label="Costo por venta" value={k.ventas > 0 && k.gasto > 0 ? formatMoney(k.costoVenta) : "—"} caption="Gasto / ventas" />
          <StatCard icon={MessageCircle} label="Mensajes" value={formatInt(k.mensajes)} caption={k.mensajes > 0 ? `${formatMoney(k.costoMensaje)} cada uno` : "Conversaciones iniciadas"} />
          <StatCard icon={Banknote} label="Margen bruto" value={formatMoney(k.margen)} caption={`${k.valor > 0 ? formatPct(k.margenPct) : "—"} del valor, tras comisiones y costos`} />
          <StatCard icon={Percent} label="% conversión" value={k.mensajes > 0 ? formatPct(k.conversion) : "—"} caption="Ventas / mensajes" />
        </div>
      )}

      <Card>
        <div className="card-head">
          <h2 className="card-title">Por país</h2>
          <span className="muted">Gasto por país de entrega · ventas por país del cliente</span>
        </div>
        {report ? <CountriesPanel countries={report.countries} selected={country} onSelect={setCountry} /> : <Skeleton height={100} />}
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
        {report ? <AdsTable rows={report.rows} group={group} /> : <Skeleton height={160} />}
        {report && (
          <p className="muted ads-note">
            Solo campañas que empiezan por «{report.settings.campaignPrefix || "todas"}» y pagos del flujo «{report.settings.flowPrefix || "todos"}». El «día N» cuenta desde el primer día con gasto.
          </p>
        )}
      </Card>

      <Card>
        <div className="card-head">
          <h2 className="card-title">{chartTitle}</h2>
          <label className="ads-chart-select">
            <span className="muted">Campaña</span>
            <select className="input" value={chartSeries ? chartSeries.ct : ""} onChange={(e) => setChartCt(e.target.value)} aria-label="Campaña del gráfico">
              <option value="">Todas las campañas</option>
              {ctOptions.map((c) => (
                <option key={c.ct} value={c.ct}>{c.ct}</option>
              ))}
            </select>
          </label>
        </div>
        {report ? <AdsChart data={chartSeries ? chartSeries.daily : report.daily} /> : <Skeleton height={200} />}
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
        {vouchers ? <VouchersPanel vouchers={vouchers.comprobantes} filter={vFilter} onFilter={setVFilter} onCountry={(key, code) => void setVoucherCountry(key, code)} onAccept={acceptVoucher} /> : <Skeleton height={120} />}
      </Card>
      </>
      )}
    </div>
  );
}
