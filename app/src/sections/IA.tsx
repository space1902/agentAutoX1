import { listen } from "@tauri-apps/api/event";
import { Cpu, Gauge, MonitorCog, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import ApiPanel from "../components/ia/ApiPanel";
import LocalPanel from "../components/ia/LocalPanel";
import { Banner, Card, Notice, Pill, Skeleton } from "../components/ui";
import { errorText } from "../lib/api";
import {
  aiApi,
  formatBytes,
  formatUsd,
  type AiConfig,
  type InstallEvent,
  type KeyStatus,
  type LocalDetect,
  type PresetsData,
  type PullEvent,
  type Resources,
  type TestResult,
  type Usage,
} from "../lib/aiApi";

type Mode = "local" | "api";

const RESOURCE_MS = 4000;
const USAGE_MS = 15000;

interface Props {
  warmupRunning: boolean;
}

function Meter({ label, used, total, unit }: { label: string; used: number; total: number; unit: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div className="ia-meter">
      <div className="ia-meter-head">
        <span>{label}</span>
        <span className="muted">
          {(used / 1024).toFixed(1)} / {(total / 1024).toFixed(1)} {unit} ({pct}%)
        </span>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ResourcesCard({ data }: { data: Resources | null }) {
  return (
    <Card>
      <div className="card-head">
        <h2 className="card-title">
          <Gauge size={16} aria-hidden /> Uso de recursos en vivo
        </h2>
        <span className="muted">Se actualiza cada pocos segundos</span>
      </div>
      {!data ? (
        <Skeleton height={80} />
      ) : (
        <div className="ia-stack">
          {data.loaded.length === 0 ? (
            <span className="muted">No hay ningún modelo cargado en memoria ahora mismo. Se carga al primer mensaje o al «Probar velocidad».</span>
          ) : (
            data.loaded.map((m) => (
              <div key={m.name} className="ia-loaded">
                <strong>{m.name}</strong>
                <span className="muted">{formatBytes(m.sizeBytes)} en memoria</span>
                <Pill tone={m.percentGpu >= 100 ? "green" : m.percentGpu > 0 ? "amber" : "red"}>
                  {m.percentGpu}% en la tarjeta de video · {m.percentCpu}% en procesador y RAM
                </Pill>
              </div>
            ))
          )}
          {data.resources.gpus.map((g) => (
            <Meter key={g.name} label={`Memoria de video — ${g.name}`} used={g.usedMb} total={g.totalMb} unit="GB" />
          ))}
          <Meter label="Memoria RAM del sistema" used={data.resources.ram.usedMb} total={data.resources.ram.totalMb} unit="GB" />
        </div>
      )}
    </Card>
  );
}

function UsageCard({ usage }: { usage: Usage | null }) {
  return (
    <Card>
      <div className="card-head">
        <h2 className="card-title">
          <Wallet size={16} aria-hidden /> Gasto de hoy
        </h2>
      </div>
      {!usage ? (
        <Skeleton height={60} />
      ) : (
        <div className="ia-usage">
          <span className="ia-usage-value">{formatUsd(usage.todayUsd)}</span>
          <span className="muted">
            {usage.todayCalls.toLocaleString("es-CO")} mensajes con API externa · últimos 7 días {formatUsd(usage.last7Usd)}
          </span>
          <div className="ia-bars" aria-hidden>
            {usage.days.map((d) => {
              const max = Math.max(...usage.days.map((x) => x.usd), 0.0001);
              return <span key={d.date} title={`${d.date}: ${formatUsd(d.usd)}`} style={{ height: `${Math.max(6, (d.usd / max) * 100)}%` }} />;
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

function TestCard({ result, running }: { result: TestResult | null; running: boolean }) {
  if (!result && !running) return null;
  return (
    <Card>
      <div className="card-head">
        <h2 className="card-title">Resultado de la prueba</h2>
        {result && <span className="muted">{result.label}</span>}
      </div>
      {running && !result && <Skeleton height={100} />}
      {result && (
        <div className="ia-stack">
          <div className="ia-test-stats">
            <Pill tone={result.okCount === result.samples.length ? "green" : "amber"}>
              {result.okCount} de {result.samples.length} mensajes utilizables
            </Pill>
            <Pill tone="gray">Latencia promedio {(result.avgLatencyMs / 1000).toFixed(1)} s por mensaje</Pill>
            {result.estimate.usdDay > 0 ? (
              <Pill tone="gray">
                ≈ {formatUsd(result.estimate.usdDay)}/día · {formatUsd(result.estimate.usdMonth)}/mes con {result.estimate.messages.toLocaleString("es-CO")} mensajes/día
              </Pill>
            ) : (
              <Pill tone="green">Sin costo por mensaje</Pill>
            )}
          </div>
          <ol className="ia-samples">
            {result.samples.map((s, i) => (
              <li key={i} className={s.ok ? "" : "bad"}>
                <span>{s.ok ? s.text : (s.error ?? "Mensaje no utilizable")}</span>
                <span className="muted">
                  {(s.latencyMs / 1000).toFixed(1)} s
                  {s.promptTokens !== null && ` · ${s.promptTokens}/${s.completionTokens} tokens`}
                  {s.usd > 0 && ` · ${formatUsd(s.usd)}`}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

export default function IA({ warmupRunning }: Props) {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>("local");
  const [presets, setPresets] = useState<PresetsData | null>(null);
  const [detect, setDetect] = useState<LocalDetect | null>(null);
  const [keys, setKeys] = useState<Record<string, KeyStatus>>({});
  const [usage, setUsage] = useState<Usage | null>(null);
  const [resources, setResources] = useState<Resources | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pull, setPull] = useState<PullEvent | null>(null);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [ollamaInstalled, setOllamaInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fail = (e: unknown) => setError(errorText(e));

  const rescan = useCallback(async (extraUrl = "") => {
    try {
      setDetect(await aiApi.detect(extraUrl));
      setOllamaInstalled(await aiApi.ollamaInstalled());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [cfg, pr] = await Promise.all([aiApi.getConfig(), aiApi.presets()]);
        setConfig(cfg.ai);
        setMode(cfg.ai?.provider === "openai-compatible" && cfg.ai.preset !== "local-openai" ? "api" : "local");
        setPresets(pr);
        setKeys(await aiApi.keyStatus(pr.presets.map((p) => p.id)));
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoaded(true);
      }
    })();
    void rescan();
  }, [rescan]);

  // Live readings while the section is open.
  useEffect(() => {
    let alive = true;
    const readUsage = () => void aiApi.usage().then((u) => alive && setUsage(u)).catch(() => undefined);
    const readResources = () => void aiApi.resources().then((r) => alive && setResources(r)).catch(() => undefined);
    readUsage();
    readResources();
    const a = window.setInterval(readUsage, USAGE_MS);
    const b = window.setInterval(readResources, RESOURCE_MS);
    return () => {
      alive = false;
      window.clearInterval(a);
      window.clearInterval(b);
    };
  }, []);

  useEffect(() => {
    const unlisten = [
      listen<PullEvent>("ai-pull", (e) => {
        setPull(e.payload);
        if (e.payload.type === "done") void rescan();
      }),
      listen<InstallEvent>("ai-install", (e) => {
        setInstall(e.payload);
        if (e.payload.done) {
          void rescan();
          // The service takes a few seconds to answer after the installer ends.
          window.setTimeout(() => void rescan(), 6000);
        }
      }),
    ];
    return () => unlisten.forEach((p) => void p.then((fn) => fn()));
  }, [rescan]);

  const save = async (next: AiConfig) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await aiApi.saveConfig(next);
      setConfig(saved.ai);
      setNotice(
        warmupRunning
          ? "Guardado. El perfil que está corriendo sigue con la configuración anterior; se aplicará al iniciar el próximo."
          : "Guardado. Se usará al iniciar el próximo perfil.",
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (next: AiConfig) => {
    setTesting(true);
    setResult(null);
    setError(null);
    try {
      setResult(await aiApi.test(next));
      void aiApi.resources().then(setResources).catch(() => undefined);
    } catch (e) {
      fail(e);
    } finally {
      setTesting(false);
    }
  };

  const saveKey = async (preset: string, key: string) => {
    const status = await aiApi.keySet(preset, key);
    setKeys((prev) => ({ ...prev, [preset]: status }));
  };

  const clearKey = async (preset: string) => {
    try {
      await aiApi.keyClear(preset);
      setKeys((prev) => ({ ...prev, [preset]: { present: false, masked: "" } }));
    } catch (e) {
      fail(e);
    }
  };

  const deleteModel = async (model: string) => {
    await aiApi.deleteModel(model);
    await rescan();
  };

  const startPull = (tag: string) => {
    setPull({ type: "progress", model: tag, percent: 0 });
    aiApi.pullStart(tag).catch((e) => setPull({ type: "error", model: tag, error: errorText(e) }));
  };

  const localModels = detect?.ollama?.installedModels.map((m) => m.name) ?? [];
  const activeLabel =
    config?.provider === "openai-compatible" ? `${config.model} (${config.preset})` : config?.model ? `${config.model} (local)` : "el modelo local por defecto (qwen2.5:7b)";

  return (
    <div className="page">
      <Banner title="IA" subtitle="Elige qué inteligencia escribe los mensajes del calentador: un modelo en tu computador o una API externa con límite de gasto." />

      {error && <Notice>{error}</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}

      {detect && (
        <div className={`notice ia-gpu ${detect.gpu.hasDedicated ? "ok" : "warn"}`} role="status">
          <MonitorCog size={16} aria-hidden /> {detect.gpu.text}
        </div>
      )}

      <Card>
        <div className="card-head">
          <h2 className="card-title">
            <Cpu size={16} aria-hidden /> Qué IA usar
          </h2>
          <span className="muted">Ahora: {activeLabel}</span>
        </div>
        <div className="ia-tabs" role="tablist" aria-label="Tipo de IA">
          <button role="tab" aria-selected={mode === "local"} className={`ia-tab ${mode === "local" ? "active" : ""}`} onClick={() => setMode("local")}>
            Modelo local
          </button>
          <button role="tab" aria-selected={mode === "api"} className={`ia-tab ${mode === "api" ? "active" : ""}`} onClick={() => setMode("api")}>
            API externa
          </button>
        </div>
        {!loaded || !presets ? (
          <Skeleton height={160} />
        ) : mode === "local" ? (
          <LocalPanel
            detect={detect}
            config={config}
            ollamaInstalled={ollamaInstalled}
            warmupRunning={warmupRunning}
            pull={pull}
            install={install}
            busy={busy || testing}
            onUse={(c) => void save(c)}
            onTest={(c) => void runTest(c)}
            onDelete={deleteModel}
            onPull={startPull}
            onCancelPull={() => void aiApi.pullCancel()}
            onInstall={() => {
              setInstall({ stage: "start", message: "Preparando la instalación…", done: false, ok: false });
              aiApi.ollamaInstall().catch(fail);
            }}
            onLaunch={() => {
              aiApi.ollamaLaunch().catch(fail);
              window.setTimeout(() => void rescan(), 4000);
            }}
            onRescan={(url) => void rescan(url)}
          />
        ) : (
          <ApiPanel
            presets={presets}
            config={config}
            keys={keys}
            localModels={localModels}
            busy={busy || testing}
            onSaveKey={saveKey}
            onClearKey={clearKey}
            onSave={(c) => void save(c)}
            onTest={(c) => void runTest(c)}
          />
        )}
      </Card>

      <TestCard result={result} running={testing} />

      <div className="ia-two">
        <UsageCard usage={usage} />
        <ResourcesCard data={resources} />
      </div>
    </div>
  );
}
