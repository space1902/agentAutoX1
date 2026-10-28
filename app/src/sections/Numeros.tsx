import { Hash, Layers, RefreshCw, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Banner, Card, Notice, Skeleton, StatCard } from "../components/ui";
import { api, errorText, type Pod, type WarmupData } from "../lib/api";
import { buildNumberRows, type NumberRow } from "../lib/numbers";

export default function Numeros() {
  const [rows, setRows] = useState<NumberRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const problems: string[] = [];
    // Each source can fail on its own (BlueStacks missing, no data dir...): show what we do have.
    const [wsp, pods, warmup] = await Promise.all([
      api.readPodsWsp().catch((e) => (problems.push(`pods-wsp.json: ${errorText(e)}`), {} as Record<string, string>)),
      api.listPods().catch((e) => (problems.push(`Pods: ${errorText(e)}`), [] as Pod[])),
      api.readWarmupData().catch((e) => (problems.push(`Calentador: ${errorText(e)}`), null as WarmupData | null)),
    ]);
    setRows(buildNumberRows(wsp, pods, warmup));
    setErrors(problems);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const inPods = rows?.filter((r) => r.instanceId).length ?? 0;
  const inBots = rows?.filter((r) => r.testerId).length ?? 0;

  return (
    <div className="page">
      <Banner title="Números" subtitle="Vista de solo lectura que une cada número con su pod, su tester, sus perfiles y su grupo.">
        <button className="btn secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} aria-hidden /> Actualizar
        </button>
      </Banner>

      <section className="stats" aria-label="Resumen">
        <StatCard icon={Hash} label="Números" value={rows ? rows.length : "–"} caption="únicos entre pods y bots" />
        <StatCard icon={Smartphone} label="En un pod" value={rows ? inPods : "–"} caption="asignados en pods-wsp.json" />
        <StatCard icon={Layers} label="En el calentador" value={rows ? inBots : "–"} caption="testers con teléfono" />
      </section>

      {errors.map((e) => (
        <Notice key={e}>{e}</Notice>
      ))}

      <Card>
        {loading && !rows ? (
          <Skeleton height={220} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Teléfono</th>
                  <th>Pod</th>
                  <th>Tester</th>
                  <th>Perfiles</th>
                  <th>Grupo</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={r.key}>
                    <td className="num">{r.phone}</td>
                    <td>{r.pod ?? r.instanceId ?? <span className="muted">–</span>}</td>
                    <td>{r.testerId ?? <span className="muted">–</span>}</td>
                    <td>{r.profiles.length ? r.profiles.join(", ") : <span className="muted">–</span>}</td>
                    <td>{r.groups.length ? r.groups.join(", ") : <span className="muted">–</span>}</td>
                  </tr>
                ))}
                {rows && rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Todavía no hay números registrados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
