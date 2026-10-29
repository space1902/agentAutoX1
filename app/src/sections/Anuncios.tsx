import { listen } from "@tauri-apps/api/event";
import { Banknote, Bell, Coins, MessageCircle, Percent, RefreshCw, Settings2, Target, TrendingUp, Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import AdsChart from "../components/ads/AdsChart";
import AdsSettings from "../components/ads/AdsSettings";
import AdsTable from "../components/ads/AdsTable";
import DecisionsPanel from "../components/ads/DecisionsPanel";
import VouchersPanel from "../components/ads/VouchersPanel";
import { Banner, Card, Notice, Skeleton, StatCard } from "../components/ui";
import { errorText } from "../lib/api";
import {
  adsApi,
  agoText,
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
} from "../lib/adsApi";

const PRESETS: { id: Exclude<Preset, "custom">; label: string }[] = [
  { id: "today", label: "Hoy" },
  { id: "yesterday", label: "Ayer" },
  { id: "week", label: "Últimos 7 días" },
  { id: "month", label: "Este mes" },
];
const GROUPS: { id: Group; label: string }[] = [
  { id: "ct", label: "CT" },
  { id: "campaign", label: "Campaña" },
  { id: "ad", label: "Anuncio" },
];
type Tab = "resumen" | "decisiones";

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
  const [group, setGroup] = useState<Group>("ct");
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState<AdsStatus | null>(null);
  const [config, setConfig] = useState<AdsConfig | null>(null);
  const [tokenPresent, setTokenPresent] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState<Tab>("resumen");
  const [decisionData, setDecisionData] = useState<DecisionsData | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const range = preset === "custom" ? custom : presetRange(preset, today);
  const rangeValid = range.from !== "" && range.to !== "" && range.from <= range.to;
  const includesToday = range.to >= today && range.from <= today;

  const latest = useRef({ range, group, rangeValid, includesToday, tokenPresent, config });
  latest.current = { range, group, rangeValid, includesToday, tokenPresent, config };
  const seq = useRef(0);

  const loadReport = useCallback(async () => {
    const { range: r, group: g, rangeValid: ok } = latest.current;
    if (!ok) return;
    const mine = ++seq.current;
    try {
      const data = await adsApi.report(r.from, r.to, g);
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
    } catch (e) {
      setProblems([errorText(e)]);
    }
  }, []);

  const doSync = useCallback(
    async (from: string, to: string) => {
      setSyncing(true);
      try {
        const res = await adsApi.sync(from, to);
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
      const { range: r, rangeValid: ok } = latest.current;
      if (s?.tokenPresent && ok && (!s.lastSync.meta || Date.now() - s.lastSync.meta > STALE_MS)) void doSync(r.from, r.to);
      else if (s && !s.tokenPresent) setShowSettings(true);
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
  }, [preset, custom, group, loaded, loadReport]);

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
      if (cur.tokenPresent && cur.includesToday) void doSync(today, today);
    }, minutes * 60_000);
    return () => window.clearInterval(id);
  }, [loaded, minutes, today, doSync]);

  const pendingCount = decisionData?.decisions.filter((d) => d.status === "pending").length ?? 0;
  const k = report?.kpis;
  const updated = report?.lastSync.meta ?? status?.lastSync.meta ?? null;
  const rangeLabel = range.from === range.to ? range.from : `${range.from} → ${range.to}`;

  return (
    <div className="page">
      <Banner title="Anuncios" subtitle="Gasto de Meta contra pagos válidos de la hoja: ROAS, costo por venta y qué hacer con cada anuncio.">
        <button className="btn secondary" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>
          <Settings2 size={16} aria-hidden /> Configuración
        </button>
      </Banner>

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
      {!tokenPresent && !showSettings && (
        <Notice>Falta el token de Meta. Abre «Configuración» para importarlo desde meta-ads-monitor o pegarlo.</Notice>
      )}

      {showSettings && config && (
        <Card>
          <div className="card-head">
            <h2 className="card-title">Configuración de Anuncios</h2>
          </div>
          <AdsSettings
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

      <div className="ia-tabs ads-tabs" role="tablist" aria-label="Secciones de Anuncios">
        <button role="tab" aria-selected={tab === "resumen"} className={`ia-tab ${tab === "resumen" ? "active" : ""}`} onClick={() => setTab("resumen")}>Resumen</button>
        <button role="tab" aria-selected={tab === "decisiones"} className={`ia-tab ${tab === "decisiones" ? "active" : ""}`} onClick={() => setTab("decisiones")}>
          Decisiones{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </button>
      </div>

      {tab === "decisiones" && (
        <DecisionsPanel decisions={decisionData?.decisions ?? []} activitiesOk={decisionData?.activitiesOk ?? null} lifecycle={decisionData?.lifecycle ?? null} busy={evaluating} onStatus={(id, s) => void changeStatus(id, s)} onEvaluate={() => void evaluateNow()} />
      )}

      {tab === "resumen" && (
      <>
      <Card>
        <div className="ads-controls">
          <div className="ia-tabs" role="tablist" aria-label="Rango de fechas">
            {PRESETS.map((p) => (
              <button key={p.id} role="tab" aria-selected={preset === p.id} className={`ia-tab ${preset === p.id ? "active" : ""}`} onClick={() => setPreset(p.id)}>
                {p.label}
              </button>
            ))}
            <button role="tab" aria-selected={preset === "custom"} className={`ia-tab ${preset === "custom" ? "active" : ""}`} onClick={() => setPreset("custom")}>
              Personalizado
            </button>
          </div>
          {preset === "custom" && (
            <div className="ads-dates">
              <input className="input" type="date" aria-label="Desde" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
              <span className="muted">a</span>
              <input className="input" type="date" aria-label="Hasta" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </div>
          )}
          <div className="ads-refresh">
            <span className="muted" role="status">
              Actualizado {agoText(updated, now)}
            </span>
            <button className="btn" disabled={syncing || !rangeValid || !tokenPresent} onClick={() => void doSync(range.from, range.to)}>
              <RefreshCw size={16} aria-hidden className={syncing ? "spin" : ""} /> {syncing ? "Actualizando…" : "Actualizar"}
            </button>
          </div>
        </div>
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
          <StatCard icon={Percent} label="% conversión" value={k.mensajes > 0 ? formatPct(k.conversion) : "—"} caption="Ventas / mensajes" />
        </div>
      )}

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
        {report ? <VouchersPanel vouchers={report.comprobantes} reviewCount={report.reviewCount} /> : <Skeleton height={120} />}
      </Card>
      </>
      )}
    </div>
  );
}
