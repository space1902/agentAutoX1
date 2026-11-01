import { Check, CircleDashed, Clock, FileSearch, Minus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText } from "../../lib/api";
import { type AgentApi, type CreativeAsset, type RoadmapItem, type RoadmapProduct, type RoadmapStatus } from "../../lib/agentApi";
import { Card, Notice, Pill, Skeleton, type PillTone } from "../ui";

const STATUS: Record<RoadmapStatus, { label: string; tone: PillTone; Icon: typeof Check }> = {
  hecho: { label: "Hecho", tone: "green", Icon: Check },
  en_progreso: { label: "En progreso", tone: "amber", Icon: Clock },
  pendiente: { label: "Pendiente", tone: "gray", Icon: CircleDashed },
  no_aplica: { label: "No aplica", tone: "gray", Icon: Minus },
};
const MARKER = { usuario: "tú", agente: "el agente", sistema: "los archivos" } as const;
const ASSET_STATUS = { generated: "Sin decidir", used: "Usado", discarded: "Descartado" } as const;
const titleCase = (s: string) => s.replace(/(^|\s)(\p{L})/gu, (_, a, b) => `${a}${b.toUpperCase()}`);
const dmy = (ms: number) => new Date(ms).toLocaleDateString("es-CO");
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function Cell({ item, selected, onSelect }: { item?: RoadmapItem; selected: boolean; onSelect: () => void }) {
  if (!item) return <td />;
  const s = STATUS[item.status];
  return (
    <td>
      <button className={`rm-cell ${item.status} ${selected ? "selected" : ""}`} onClick={onSelect} aria-label={`${item.title}: ${s.label}`} title={item.detail || s.label}>
        <s.Icon size={14} aria-hidden />
        <span>{s.label}</span>
        {item.evidenceBroken && <span className="rm-warn" title="La evidencia ya no existe en disco">!</span>}
      </button>
    </td>
  );
}

function Detail({ item, api, onChanged }: { item: RoadmapItem; api: AgentApi; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function set(status: RoadmapStatus) {
    setError(null);
    try {
      await api.setItem(item.id, status, note.trim() || undefined);
      setNote("");
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Card className="rm-detail">
      <h3>
        {item.title}
        {item.country ? <small className="muted"> · {titleCase(item.country)}</small> : null}
      </h3>
      <p className="muted">
        {item.detail || "Sin comprobación automática."} Marcado por {MARKER[item.markedBy]} el {dmy(item.updated)}.
      </p>
      {item.evidencePath && (
        <p>
          <FileSearch size={13} aria-hidden /> Evidencia: <code>{item.evidencePath}</code>
          {item.evidenceBroken && <strong className="rm-broken"> (ya no existe en disco)</strong>}
        </p>
      )}
      {item.notes && <pre className="rm-notes">{item.notes}</pre>}
      <div className="rm-actions">
        {(Object.keys(STATUS) as RoadmapStatus[]).map((st) => (
          <button key={st} className={`btn sm ${st === item.status ? "" : "secondary"}`} disabled={st === item.status} onClick={() => void set(st)}>
            {STATUS[st].label}
          </button>
        ))}
      </div>
      <input className="input" value={note} maxLength={400} placeholder="Nota opcional (se guarda con el cambio)" aria-label="Nota" onChange={(e) => setNote(e.target.value)} />
      {error && <Notice>{error}</Notice>}
    </Card>
  );
}

function Assets({ api, refreshKey }: { api: AgentApi; refreshKey: number }) {
  const [assets, setAssets] = useState<CreativeAsset[] | null>(null);
  const [ct, setCt] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAssets((await api.assets()).assets);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function set(a: CreativeAsset, status: CreativeAsset["status"]) {
    setError(null);
    try {
      const code = (ct[a.id] ?? a.ctCode ?? "").trim();
      await api.setAsset(a.id, status, code || (a.ctCode ? "" : undefined));
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!assets) return error ? <Notice>{error}</Notice> : <Skeleton height={80} />;
  return (
    <Card className="rm-assets">
      <h3>Archivos que generó el agente</h3>
      <p className="muted">Dile si te sirvieron: el agente aprende de lo que usas y de lo que descartas. Si lo usaste en un anuncio, escribe su CT y usará el resultado real del Analista (solo lectura).</p>
      {error && <Notice>{error}</Notice>}
      {!assets.length && <p className="muted">Todavía no hay archivos generados.</p>}
      <ul>
        {assets.map((a) => (
          <li key={a.id}>
            <div className="rm-asset-text">
              <strong title={a.path}>{fileName(a.path)}</strong>
              <small className="muted">
                {a.kind}
                {a.product ? ` · ${a.product}` : ""}
                {a.country ? ` · ${titleCase(a.country)}` : ""} · {dmy(a.ts)}
              </small>
            </div>
            <Pill tone={a.status === "used" ? "green" : a.status === "discarded" ? "red" : "gray"}>{ASSET_STATUS[a.status]}</Pill>
            <input className="input rm-ct" placeholder="CT (opcional)" aria-label="Código CT" value={ct[a.id] ?? a.ctCode ?? ""} maxLength={8} onChange={(e) => setCt((m) => ({ ...m, [a.id]: e.target.value }))} />
            <button className="btn secondary sm" disabled={a.status === "used"} onClick={() => void set(a, "used")}>Lo usé</button>
            <button className="btn ghost sm" disabled={a.status === "discarded"} onClick={() => void set(a, "discarded")}>Descartar</button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function RoadmapBoard({ api, refreshKey = 0 }: { api: AgentApi; refreshKey?: number }) {
  const [products, setProducts] = useState<RoadmapProduct[] | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await api.roadmap();
      setProducts(res.board);
      setProductId((cur) => cur ?? res.board[0]?.id ?? null);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const product = useMemo(() => products?.find((p) => p.id === productId) ?? products?.[0] ?? null, [products, productId]);
  const byKey = useMemo(() => new Map((product?.items ?? []).map((i) => [`${i.country ?? ""}|${i.templateId}`, i])), [product]);
  const item = product?.items.find((i) => i.id === selected) ?? null;

  if (!products) return error ? <Notice>{error}</Notice> : <Skeleton height={240} />;
  if (!product) return <Notice kind="ok">No encontré productos en la carpeta de trabajo (carpetas «Producto …»).</Notice>;

  const rows = product.rows;
  return (
    <div className="rm">
      {error && <Notice>{error}</Notice>}
      <Card>
        <div className="rm-head">
          <div className="rm-products" role="tablist" aria-label="Productos">
            {products.map((p) => (
              <button key={p.id} role="tab" aria-selected={p.id === product.id} className={`ia-tab ${p.id === product.id ? "active" : ""}`} onClick={() => { setProductId(p.id); setSelected(null); }}>
                {p.name}
              </button>
            ))}
          </div>
          <button className="btn secondary sm" onClick={() => void load()} disabled={busy}>
            <RefreshCw size={13} aria-hidden className={busy ? "spin" : ""} /> Revisar los archivos
          </button>
        </div>
        <p className="muted">Cada casilla se comprueba contra los archivos reales. Si tú marcas algo, nadie lo cambia sin ti. Haz clic en una casilla para ver el detalle o cambiarla.</p>
        <div className="rm-scroll">
          <table className="rm-table">
            <thead>
              <tr>
                <th>Ítem</th>
                <th>Producto</th>
                {product.countries.map((c) => (
                  <th key={c}>
                    {titleCase(c)}
                    <div className="rm-bar" title={`${product.progress[c]?.done ?? 0} de ${product.progress[c]?.total ?? 0}`}>
                      <span style={{ width: `${product.progress[c]?.pct ?? 0}%` }} />
                    </div>
                    <small className="muted">{product.progress[c]?.pct ?? 0} %</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.templateId}>
                  <th scope="row">
                    {r.title}
                    {r.manual && <small className="muted"> · se marca a mano</small>}
                  </th>
                  {r.scope === "product" ? <Cell item={byKey.get(`|${r.templateId}`)} selected={byKey.get(`|${r.templateId}`)?.id === selected} onSelect={() => setSelected(byKey.get(`|${r.templateId}`)?.id ?? null)} /> : <td />}
                  {product.countries.map((c) => {
                    const it = byKey.get(`${c}|${r.templateId}`);
                    return r.scope === "country" ? <Cell key={c} item={it} selected={it?.id === selected} onSelect={() => setSelected(it?.id ?? null)} /> : <td key={c} />;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {item && <Detail key={item.id} item={item} api={api} onChanged={() => { setTick((n) => n + 1); void load(); }} />}

      <Card className="rm-next">
        <h3>Qué sigue</h3>
        {!product.next.length && <p className="muted">No hay nada pendiente con sus dependencias listas.</p>}
        <ol>
          {product.next.map((n) => (
            <li key={n.id}>
              <strong>{n.title}</strong> <span className="muted">· {n.country ? titleCase(n.country) : "Producto"}{n.skill ? ` · skill ${n.skill}` : ""}{n.manual ? " · se marca a mano" : ""}</span>
              <small className="muted"> {n.detail}</small>
            </li>
          ))}
        </ol>
      </Card>

      <Assets api={api} refreshKey={refreshKey + tick} />
    </div>
  );
}
