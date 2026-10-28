import { Cable, MonitorSmartphone, Phone, Power, PowerOff, RefreshCw, Eye, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Banner, Card, Notice, Pill, SkeletonGrid, StatCard } from "../components/ui";
import { api, errorText, type Pod } from "../lib/api";

type Action = "prender" | "apagar" | "ver";

export default function MultiWhatsApp() {
  const [pods, setPods] = useState<Pod[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "<pod>:<action>"

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPods(await api.listPods());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: Action, name: string) => {
    setBusy(`${name}:${action}`);
    setError(null);
    setInfo(null);
    try {
      setInfo((await api.podAction(action, name)) || `Listo: ${action} ${name}.`);
      setPods(await api.listPods());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const running = pods?.filter((p) => p.state === "running").length ?? 0;
  const withPhone = pods?.filter((p) => p.phone).length ?? 0;

  return (
    <div className="page">
      <Banner
        title="MultiWhatsApp"
        subtitle="Tus pods de WhatsApp Business sobre BlueStacks: enciende, apaga o trae al frente cada uno."
      >
        <button className="btn secondary" onClick={() => void load()} disabled={loading || busy !== null}>
          <RefreshCw size={15} aria-hidden /> Actualizar lista
        </button>
      </Banner>

      <section className="stats" aria-label="Resumen">
        <StatCard icon={Power} label="Pods activos" value={pods ? running : "–"} caption="encendidos ahora" />
        <StatCard icon={Smartphone} label="Pods totales" value={pods ? pods.length : "–"} caption="instancias wa-*" />
        <StatCard icon={Phone} label="Números asignados" value={pods ? withPhone : "–"} caption="con #wsp en pods-wsp.json" />
      </section>

      {error && <Notice>{error}</Notice>}
      {info && <Notice kind="ok">{info}</Notice>}
      {busy && <Notice kind="ok">Ejecutando «{busy.replace(":", " ")}». Prender puede tardar hasta unos 4 minutos mientras arranca Android.</Notice>}

      {loading && !pods ? (
        <SkeletonGrid />
      ) : (
        <div className="grid">
          {(pods ?? []).map((pod) => {
            const isOn = pod.state === "running";
            const disabled = busy !== null;
            return (
              <Card key={pod.instanceId}>
                <div className="card-head">
                  <h2 className="card-title">{pod.name}</h2>
                  <Pill tone={isOn ? "green" : "gray"}>{isOn ? "Activo" : "Apagado"}</Pill>
                </div>
                <dl className="meta">
                  <dt>Teléfono</dt>
                  <dd>{pod.phone ?? "Sin asignar"}</dd>
                  <dt>Puerto adb</dt>
                  <dd>{pod.adbPort}</dd>
                  <dt>Serial</dt>
                  <dd>{pod.serial ?? "–"}</dd>
                  <dt>Instancia</dt>
                  <dd>{pod.instanceId}</dd>
                </dl>
                <div className="row-actions">
                  <button className="btn sm" disabled={disabled || isOn} onClick={() => void run("prender", pod.name)}>
                    <Power size={14} aria-hidden /> Prender
                  </button>
                  <button className="btn sm ghost" disabled={disabled || !isOn} onClick={() => void run("apagar", pod.name)}>
                    <PowerOff size={14} aria-hidden /> Apagar
                  </button>
                  <button className="btn sm ghost" disabled={disabled} onClick={() => void run("ver", pod.name)}>
                    <Eye size={14} aria-hidden /> Ver
                  </button>
                </div>
              </Card>
            );
          })}
          {pods && pods.length === 0 && !error && <Card>No hay pods todavía. Créalos con pods.ps1 nuevo &lt;nombre&gt;.</Card>}
        </div>
      )}

      {/* PHASE 2 PLACEHOLDER: the BlueStacks window will be embedded here. */}
      <Card>
        <div className="card-head">
          <h2 className="card-title">Vista embebida</h2>
          <Pill tone="amber">Próximamente</Pill>
        </div>
        <div className="placeholder" data-phase="2">
          <MonitorSmartphone size={30} aria-hidden />
          <strong>Vista embebida (próximamente)</strong>
          <span>Aquí verás la ventana de BlueStacks de cada pod dentro de la app.</span>
          <Cable size={16} aria-hidden />
        </div>
      </Card>
    </div>
  );
}
