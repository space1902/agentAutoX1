import { Flame, Link2, MessagesSquare, Play, RefreshCw, Square, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Banner, Card, Notice, Pill, SkeletonGrid, StatCard } from "../components/ui";
import { api, errorText, type LogLine, type WarmupData } from "../lib/api";

interface Props {
  running: boolean;
  profile: string | null;
  logs: LogLine[];
  onClearLogs: () => void;
}

export default function CalentadorBots({ running, profile, logs, onClearLogs }: Props) {
  const [data, setData] = useState<WarmupData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.readWarmupData());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow the log unless the user scrolled up.
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const start = async (name: string) => {
    setPending("start");
    setError(null);
    try {
      await api.startProfile(name);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(null);
    }
  };

  const stop = async () => {
    setPending("stop");
    setError(null);
    try {
      await api.stopProfile();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(null);
    }
  };

  const testers = data?.testers ?? [];
  const byId = new Map(testers.map((t) => [t.id, t]));
  const linked = testers.filter((t) => t.hasSession).length;

  return (
    <div className="page">
      <Banner
        title="Calentador Bots"
        subtitle="Inicia un perfil de calentamiento: sus números conversan entre sí en el grupo. Solo uno a la vez."
      >
        {running ? (
          <button className="btn danger" onClick={() => void stop()} disabled={pending === "stop"}>
            <Square size={15} aria-hidden /> {pending === "stop" ? "Deteniendo…" : "Detener perfil"}
          </button>
        ) : (
          <button className="btn secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} aria-hidden /> Actualizar
          </button>
        )}
      </Banner>

      <section className="stats" aria-label="Resumen">
        <StatCard icon={Flame} label="Perfiles" value={data ? data.profiles.length : "–"} caption="en profiles.json" />
        <StatCard icon={Link2} label="Números vinculados" value={data ? `${linked}/${testers.length}` : "–"} caption="con sesión guardada" />
        <StatCard icon={Users} label="Perfil en curso" value={running ? profile : "Ninguno"} caption={running ? "calentando ahora" : "listo para iniciar"} />
        <StatCard icon={MessagesSquare} label="Grupo por defecto" value={data?.defaultGroup ?? "–"} caption="si el perfil no define uno" />
      </section>

      {error && <Notice>{error}</Notice>}

      {loading && !data ? (
        <SkeletonGrid />
      ) : (
        <div className="grid">
          {(data?.profiles ?? []).map((p) => {
            const isThis = running && profile === p.name;
            return (
              <Card key={p.name}>
                <div className="card-head">
                  <h2 className="card-title">{p.name}</h2>
                  {isThis ? <Pill tone="green">Activo</Pill> : <Pill tone="gray">Detenido</Pill>}
                </div>
                <dl className="meta">
                  <dt>Grupo</dt>
                  <dd>{p.groupName ?? data?.defaultGroup ?? "–"}</dd>
                  <dt>Números</dt>
                  <dd>{p.testers.length}</dd>
                </dl>
                <div className="chips">
                  {p.testers.map((id) => {
                    const t = byId.get(id);
                    return (
                      <span key={id} className={`chip ${t?.hasSession ? "" : "unlinked"}`} title={t?.hasSession ? "Sesión vinculada" : "Sin vincular: pedirá QR al iniciar"}>
                        <i aria-hidden /> {id}
                        {t?.phone ? ` · ${t.phone}` : ""}
                      </span>
                    );
                  })}
                </div>
                {isThis ? (
                  <button className="btn sm danger" onClick={() => void stop()} disabled={pending === "stop"}>
                    <Square size={14} aria-hidden /> Detener
                  </button>
                ) : (
                  <button className="btn sm" onClick={() => void start(p.name)} disabled={running || pending !== null}>
                    <Play size={14} aria-hidden /> Iniciar
                  </button>
                )}
              </Card>
            );
          })}
          {data && data.profiles.length === 0 && !error && <Card>No hay perfiles. Créalos con «npm run perfil -- crear».</Card>}
        </div>
      )}

      <Card>
        <div className="card-head">
          <h2 className="card-title">Registro en vivo</h2>
          <button className="btn sm ghost" onClick={onClearLogs}>
            <Trash2 size={14} aria-hidden /> Limpiar
          </button>
        </div>
        <div className="log" ref={logRef} role="log" aria-live="off" tabIndex={0}>
          {logs.length === 0 ? (
            <span className="log-empty">Aquí aparecerá la salida del perfil cuando lo inicies.</span>
          ) : (
            logs.map((l, i) => (
              <div key={i} className={l.stream}>
                {l.line || " "}
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
