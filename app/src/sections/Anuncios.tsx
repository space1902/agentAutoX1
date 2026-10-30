import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Banknote, Bell, Coins, MessageCircle, Percent, RefreshCw, Target, TrendingUp, Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import AdsChart from "../components/ads/AdsChart";
import AdsSettings from "../components/ads/AdsSettings";
import AdsTable from "../components/ads/AdsTable";
import AlertsPanel from "../components/ads/AlertsPanel";
import DecisionsPanel from "../components/ads/DecisionsPanel";
import CountriesPanel from "../components/ads/CountriesPanel";
import DateRangeBar from "../components/ads/DateRangeBar";
import VouchersPanel from "../components/ads/VouchersPanel";
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
  type Decision,
  type DecisionsData,
  type DecisionStatus,
  type Group,
  type Preset,
  type Report,
  type SyncResult,
  type TrackingItem,
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

  const range = preset === "custom" ? custom : presetRange(preset, today);
  const decRange = decPreset === "custom" ? decCustom : presetRange(decPreset, today);
  const rangeValid = range.from !== "" && range.to !== "" && range.from <= range.to;
  const includesToday = range.to >= today && range.from <= today;

  const latest = useRef({ range, group, rangeValid, includesToday, tokenPresent, config, country, split });
  latest.current = { range, group, rangeValid, includesToday, tokenPresent, config, country, split };
  const seq = useRef(0);

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
        await Promise.all([loadReport(), loadStatus()]);
        setSyncing(false);
      }
    },
    [loadReport, loadStatus],
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

  // The scheduler (inside the app) announces new decisions while any section is open.
  useEffect(() => {
    const un = listen<{ created: Decision[] }>("ads-decisions", (e) => {
      void loadDecisions();
      const n = e.payload.created.length;
      setBanner(n === 1 ? `Nueva decisión: ${e.payload.created[0].label} → ${e.payload.created[0].verdict.label}` : `${n} decisiones nuevas por revisar.`);
    });
    return () => void un.then((fn) => fn());
  }, [loadDecisions]);

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
      await loadReport();
    } catch (e) {
      setProblems([errorText(e)]);
    }
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

  // "Actualizado hace X min" ticks while the section is open.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Today refreshes by itself (live spend) while the section is open.
  const minutes = config?.autoRefreshMinutes ?? 15;
  useEffect(() => {
    if (!loaded || minutes <= 0) return;
    const id = window.setInterval(() => {
      const cur = latest.current;
      if (cur.tokenPresent && cur.includesToday) void doSync();
    }, minutes * 60_000);
    return () => window.clearInterval(id);
  }, [loaded, minutes, today, doSync]);

  const pendingCount = decisionData?.decisions.filter((d) => d.status === "pending").length ?? 0;
  const k = report?.kpis;
  // A filter on a country that is no longer enabled would show nothing: go back to "Todos".
  useEffect(() => {
    if (report && country && country !== "-" && !report.countries.some((c) => c.country === country)) setCountry("");
  }, [report, country]);
  const updated = report?.lastSync.meta ?? status?.lastSync.meta ?? null;
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
        {preset === "today" && <p className="muted ads-note">El gasto de hoy es en vivo: se trae directo de Meta cada vez que actualizas.</p>}
      </Card>

      {!loaded || !k ? (
        <Skeleton height={110} />
      ) : (
        <div className="stats">
          <StatCard icon={Wallet} label="Gasto" value={formatMoney(k.gasto)} caption={rangeLabel} />
          <StatCard icon={Target} label="Ventas (pagos)" value={formatInt(k.ventas)} caption={`${report?.reviewCount ?? 0} por revisar`} />
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
          <h2 className="card-title">Gasto contra valor por día</h2>
        </div>
        {report ? <AdsChart data={report.daily} /> : <Skeleton height={200} />}
      </Card>

      <Card>
        <div className="card-head">
          <h2 className="card-title">Comprobantes</h2>
          <span className="muted">{report ? `${report.comprobantes.length} en el rango` : ""}</span>
        </div>
        {report ? <VouchersPanel vouchers={report.comprobantes} reviewCount={report.reviewCount} onCountry={(key, code) => void setVoucherCountry(key, code)} /> : <Skeleton height={120} />}
      </Card>
      </>
      )}
    </div>
  );
}
