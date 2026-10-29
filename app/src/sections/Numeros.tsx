import { Hash, Layers, Link2, RefreshCw, Smartphone, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DuplicateBanner } from "../components/DuplicateBanner";
import { Tooltip } from "../components/Tooltip";
import { HealthBadge, useLineHealth } from "../components/Health";
import { Banner, Card, Notice, Pill, Skeleton, StatCard, type PillTone } from "../components/ui";
import { duplicateText, formatPhone, mismatchText } from "../lib/phone";
import { api, errorText, type NumberSource, type Registry, type RegistryRow } from "../lib/api";

type SourceFilter = "todos" | NumberSource;
type LinkedFilter = "todos" | "vinculados" | "sin-vincular";

const SOURCES: { id: SourceFilter; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "pod", label: "Pod" },
  { id: "pod sin calentar", label: "Pod sin calentar" },
  { id: "externo", label: "Externo" },
];

const LINKED: { id: LinkedFilter; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "vinculados", label: "Vinculados" },
  { id: "sin-vincular", label: "Sin vincular" },
];

const SOURCE_TONE: Record<NumberSource, PillTone> = { pod: "green", "pod sin calentar": "amber", externo: "gray" };

export default function Numeros() {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [podsError, setPodsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<SourceFilter>("todos");
  const [linked, setLinked] = useState<LinkedFilter>("todos");
  const [group, setGroup] = useState("");
  const health = useLineHealth();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    void health.reload();
    try {
      const overview = await api.registryOverview();
      setRegistry(overview.data);
      setPodsError(overview.podsError);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = registry?.rows ?? [];
  const warningOf = (r: RegistryRow): string | null => {
    if (r.duplicateOf.length > 0) return duplicateText(r.duplicateOf);
    const info = r.testerId ? registry?.testers[r.testerId] : undefined;
    return info?.mismatch ? mismatchText(info.configPhone, info.sessionPhone) : null;
  };
  const groups = useMemo(() => [...new Set(rows.flatMap((r) => r.groups))].sort(), [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r: RegistryRow) => {
      if (source !== "todos" && r.source !== source) return false;
      if (linked === "vinculados" && !r.linked) return false;
      if (linked === "sin-vincular" && r.linked) return false;
      if (group && !r.groups.includes(group)) return false;
      if (!q) return true;
      return [r.phone, r.key, r.pod?.name, r.testerId, ...r.profiles, ...r.groups].some((v) => v?.toLowerCase().includes(q));
    });
  }, [rows, search, source, linked, group]);

  const inPods = rows.filter((r) => r.pod).length;
  const inBots = rows.filter((r) => r.testerId).length;
  const linkedCount = rows.filter((r) => r.linked).length;

  return (
    <div className="page">
      <Banner title="Números" subtitle="Cada número una sola vez: su pod, su tester, si está vinculado, en qué perfiles se usa y en qué grupo.">
        <button className="btn secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} aria-hidden /> Actualizar
        </button>
      </Banner>

      <section className="stats" aria-label="Resumen">
        <StatCard icon={Hash} label="Números" value={registry ? rows.length : "–"} caption="únicos entre pods y bots" />
        <StatCard icon={Smartphone} label="En un pod" value={registry ? inPods : "–"} caption="asignados en pods-wsp.json" />
        <StatCard icon={Layers} label="En el calentador" value={registry ? inBots : "–"} caption="testers con teléfono" />
        <StatCard icon={Link2} label="Vinculados" value={registry ? linkedCount : "–"} caption="con sesión de WhatsApp guardada" />
      </section>

      <DuplicateBanner groups={registry?.duplicates} />
      {error && <Notice>{error}</Notice>}
      {podsError && <Notice>No se pudo leer la lista de pods (solo se muestran los testers): {podsError}</Notice>}

      <Card>
        <div className="filters">
          <input className="input" type="search" placeholder="Buscar número, pod, tester, perfil…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar" />
          <div className="seg" role="group" aria-label="Origen">
            {SOURCES.map((s) => (
              <button key={s.id} className={source === s.id ? "on" : ""} onClick={() => setSource(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Vinculación">
            {LINKED.map((s) => (
              <button key={s.id} className={linked === s.id ? "on" : ""} onClick={() => setLinked(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <select className="input" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Grupo">
            <option value="">Todos los grupos</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>

        {loading && !registry ? (
          <Skeleton height={220} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Teléfono</th>
                  <th>Origen</th>
                  <th>Pod</th>
                  <th>Tester</th>
                  <th>Vinculado</th>
                  <th>Salud</th>
                  <th>Perfiles</th>
                  <th>Grupos</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.key}>
                    <td className="num">
                      {formatPhone(r.phone)} {r.isBot && <Pill tone="amber">Bot</Pill>}
                      {r.phoneSource === "session" && <span className="muted"> · de la sesión</span>}
                      {warningOf(r) && (
                        <>
                          {" "}
                          <Tooltip className="phone-warn" content={warningOf(r)!} label={warningOf(r)!} width={260}>
                            <TriangleAlert size={14} aria-hidden />
                          </Tooltip>
                        </>
                      )}
                    </td>
                    <td>
                      <Pill tone={SOURCE_TONE[r.source]}>{r.source}</Pill>
                    </td>
                    <td>
                      {r.pod ? (
                        <>
                          {r.pod.name} <span className="muted">· {r.pod.state === "running" ? "activo" : "apagado"}</span>
                        </>
                      ) : (
                        <span className="muted">–</span>
                      )}
                    </td>
                    <td>{r.testerId ?? <span className="muted">–</span>}</td>
                    <td>{r.testerId ? <Pill tone={r.linked ? "green" : "amber"}>{r.linked ? "Sí" : "No"}</Pill> : <span className="muted">–</span>}</td>
                    <td>{r.testerId ? <HealthBadge health={health.lines[r.testerId]} /> : <span className="muted">Sin calentar</span>}</td>
                    <td>{r.profiles.length ? r.profiles.join(", ") : <span className="muted">–</span>}</td>
                    <td>{r.groups.length ? r.groups.join(", ") : <span className="muted">–</span>}</td>
                  </tr>
                ))}
                {registry && visible.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted">
                      {rows.length === 0 ? "Todavía no hay números registrados." : "Ningún número coincide con los filtros."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {registry && (registry.podsWithoutPhone.length > 0 || registry.testersWithoutPhone.length > 0) && (
        <Card>
          <h2 className="card-title">Sin número asignado</h2>
          {registry.podsWithoutPhone.length > 0 && (
            <p>
              <strong>Pods:</strong> {registry.podsWithoutPhone.map((p) => p.name).join(", ")}. Asígnales el número desde MultiWhatsApp → Editar.
            </p>
          )}
          {registry.testersWithoutPhone.length > 0 && (
            <p>
              <strong>Testers:</strong>{" "}
              {registry.testersWithoutPhone.map((t) => `${t.id}${t.linked ? " (vinculado)" : ""}${t.profiles.length ? ` → ${t.profiles.join(", ")}` : ""}`).join("; ")}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
