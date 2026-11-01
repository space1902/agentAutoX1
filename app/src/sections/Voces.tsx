import { AnimatePresence } from "framer-motion";
import { AudioLines, KeyRound, Pause, Play, RefreshCw, Save, ShieldCheck, Trash2, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Warning } from "../components/Modal";
import { Banner, Card, Notice, Pill, Skeleton } from "../components/ui";
import { errorText } from "../lib/api";
import {
  type Estimate,
  formatNumber,
  type Subscription,
  type VoiceContext,
  type VoiceInfo,
  type VoiceKeyStatus,
  type VoicePreset,
  voicesApi,
} from "../lib/voicesApi";

const EMPTY_PRESET: Partial<VoicePreset> = { name: "", voiceId: "", modelId: "", stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, product: "", country: "", note: "" };

function Slider({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}: {value.toFixed(2).replace(".", ",")}</label>
      <input id={id} type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

/** Plays one preview at a time. */
function useSinglePlayer() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const toggle = useCallback((id: string, url: string) => {
    if (audio.current) audio.current.pause();
    if (playing === id) return setPlaying(null);
    const next = new Audio(url);
    next.onended = () => setPlaying((p) => (p === id ? null : p));
    audio.current = next;
    setPlaying(id);
    void next.play().catch(() => setPlaying(null));
  }, [playing]);
  useEffect(() => () => audio.current?.pause(), []);
  return { playing, toggle };
}

export default function Voces() {
  const [ctx, setCtx] = useState<VoiceContext | null>(null);
  const [key, setKey] = useState<VoiceKeyStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [sub, setSub] = useState<Subscription | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [presets, setPresets] = useState<VoicePreset[]>([]);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState<Partial<VoicePreset>>(EMPTY_PRESET);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const player = useSinglePlayer();

  // Manual generation
  const [text, setText] = useState("");
  const [presetId, setPresetId] = useState("");
  const [product, setProduct] = useState("");
  const [country, setCountry] = useState("");
  const [filename, setFilename] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ file: string; credits: number; dataUrl: string | null } | null>(null);

  const fail = (e: unknown) => setError(errorText(e));
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    setOk(null);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const loadAccount = useCallback(async () => {
    const [s, v] = await Promise.all([voicesApi.subscription(), voicesApi.voices()]);
    setSub(s.subscription);
    setVoices(v.voices);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [c, k, p] = await Promise.all([voicesApi.context(), voicesApi.keyStatus(), voicesApi.presets()]);
        setCtx(c);
        setKey(k);
        setPresets(p.presets);
        if (k.present) await loadAccount().catch(fail);
      } catch (e) {
        fail(e);
      }
    })();
  }, [loadAccount]);

  // Live estimate of the characters and credits of the text, using the chosen preset's model.
  useEffect(() => {
    if (!text.trim()) return setEstimate(null);
    const timer = setTimeout(() => void voicesApi.estimate(text, presetId || undefined).then(setEstimate).catch(() => setEstimate(null)), 250);
    return () => clearTimeout(timer);
  }, [text, presetId]);

  // Picking a preset fills the product and the country it was saved for.
  useEffect(() => {
    const p = presets.find((x) => x.id === presetId);
    if (p) {
      if (p.product) setProduct(p.product);
      if (p.country) setCountry(p.country);
    }
  }, [presetId, presets]);

  const countries = useMemo(() => ctx?.products.find((p) => p.name === product)?.countries ?? [], [ctx, product]);
  const shown = voices.filter((v) => `${v.name} ${v.category} ${Object.values(v.labels).join(" ")}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const voiceName = (id: string) => voices.find((v) => v.id === id)?.name;

  const saveKey = () =>
    run("key", async () => {
      const status = await voicesApi.keySet(keyInput);
      setKeyInput("");
      setKey(status);
      const test = await voicesApi.testKey();
      setOk(`Clave guardada y válida. Plan ${test.tier || "—"}: te quedan ${formatNumber(test.remaining)} caracteres.`);
      await loadAccount();
    });

  const testKey = () =>
    run("test", async () => {
      const test = await voicesApi.testKey();
      setOk(`La clave funciona. Plan ${test.tier || "—"}: ${formatNumber(test.remaining)} de ${formatNumber(test.limit)} caracteres disponibles.`);
      await loadAccount();
    });

  const clearKey = () =>
    run("clear", async () => {
      await voicesApi.keyClear();
      setKey({ present: false, masked: "" });
      setSub(null);
      setVoices([]);
      setOk("Clave eliminada del Administrador de credenciales.");
    });

  const savePreset = () =>
    run("preset", async () => {
      const list = presets.some((p) => p.id === form.id) ? presets.map((p) => (p.id === form.id ? { ...p, ...form } : p)) : [...presets, form];
      const saved = await voicesApi.savePresets(list as Array<Partial<VoicePreset>>);
      setPresets(saved.presets);
      setForm(EMPTY_PRESET);
      setOk("Preset guardado.");
    });

  const removePreset = (id: string) =>
    run("preset", async () => {
      setPresets((await voicesApi.savePresets(presets.filter((p) => p.id !== id))).presets);
      if (form.id === id) setForm(EMPTY_PRESET);
    });

  const generate = () =>
    run("generate", async () => {
      if (!estimate) return;
      const out = await voicesApi.generate({
        text, presetId: presetId || undefined, product: product || undefined, country: country || undefined, filename: filename || undefined, outputDir: outputDir.trim() || undefined,
        confirmed: true, confirmedCredits: estimate.credits,
      });
      const audio = await voicesApi.audio(out.file).catch(() => null);
      setResult({ file: out.file, credits: out.credits, dataUrl: audio?.dataUrl ?? null });
      setConfirming(false);
      await voicesApi.subscription().then((s) => setSub(s.subscription)).catch(() => undefined);
    });

  const canGenerate = !!key?.present && !!text.trim() && !!estimate && !!presetId && (outputDir.trim() !== "" || (product !== "" && country !== ""));
  const enough = !sub || !estimate || estimate.credits <= sub.remaining;

  if (!ctx && !error) return <Skeleton height={320} />;

  return (
    <div className="page voces">
      <Banner title="Voces" subtitle="Tu cuenta de ElevenLabs: voces, presets por producto y país, saldo y audios. Los créditos son de pago: siempre ves el costo antes de generar." />
      {error && <Notice>{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Card className="voz-card">
        <h2 className="card-title"><KeyRound size={16} aria-hidden /> Clave de ElevenLabs</h2>
        {key?.present ? (
          <div className="ia-inline">
            <span className="ia-key"><ShieldCheck size={14} aria-hidden /> {key.masked}</span>
            <button className="btn sm" disabled={busy !== null} onClick={() => void testKey()}>Probar</button>
            <button className="btn sm ghost" disabled={busy !== null} onClick={() => void clearKey()}><Trash2 size={14} aria-hidden /> Quitar clave</button>
          </div>
        ) : (
          <div className="ia-inline">
            <input className="input" type="password" autoComplete="off" placeholder="Pega aquí tu API key de ElevenLabs" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} aria-label="API key de ElevenLabs" />
            <button className="btn sm" disabled={!keyInput.trim() || busy !== null} onClick={() => void saveKey()}>Guardar y probar</button>
          </div>
        )}
        <small className="muted">Se guarda solo en el Administrador de credenciales de Windows. Nunca se escribe en archivos, registros ni en el chat; el Agente creativo la recibe sin verla.</small>
        <Warning>
          Si guardaste una clave de ElevenLabs en un archivo de texto dentro de tus carpetas (por ejemplo un <code>apikey…txt</code>), esa clave quedó en claro. Crea una nueva en ElevenLabs, guárdala aquí, revoca la anterior y borra el archivo.
        </Warning>
      </Card>

      {key?.present && (
        <Card className="voz-card">
          <div className="card-head">
            <h2 className="card-title">Saldo</h2>
            <button className="btn sm ghost" disabled={busy !== null} onClick={() => void run("sub", loadAccount)}><RefreshCw size={14} aria-hidden /> Actualizar</button>
          </div>
          {sub ? (
            <p>
              <strong>{formatNumber(sub.remaining)}</strong> créditos disponibles de {formatNumber(sub.limit)} <Pill tone="gray">{sub.tier || "plan"}</Pill>
              {sub.resetsAt ? <small className="muted"> · se renuevan el {new Date(sub.resetsAt * 1000).toLocaleDateString("es-CO")}</small> : null}
            </p>
          ) : (
            <Skeleton height={28} />
          )}
        </Card>
      )}

      <Card className="voz-card">
        <h2 className="card-title">Presets por producto y país</h2>
        <p className="muted">Un preset guarda la voz, el modelo y los ajustes. El Agente creativo los usa por su nombre.</p>
        <ul className="voz-list">
          {presets.map((p) => (
            <li key={p.id}>
              <span><strong>{p.name}</strong> <small className="muted">{[p.product, p.country].filter(Boolean).join(" / ") || "sin producto"} · {voiceName(p.voiceId) ?? p.voiceId} · {p.modelId}</small></span>
              <span>
                <button className="btn sm ghost" onClick={() => setForm(p)}>Editar</button>
                <button className="btn sm ghost" aria-label={`Borrar el preset ${p.name}`} disabled={busy !== null} onClick={() => void removePreset(p.id)}><Trash2 size={14} aria-hidden /></button>
              </span>
            </li>
          ))}
          {!presets.length && <li className="muted">Todavía no hay presets.</li>}
        </ul>

        <div className="voz-form">
          <div className="field"><label htmlFor="pr-name">Nombre</label><input id="pr-name" className="input" value={form.name ?? ""} placeholder="Venezuela" onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field">
            <label htmlFor="pr-voice">ID de voz</label>
            <input id="pr-voice" className="input" list="voz-ids" value={form.voiceId ?? ""} placeholder="Pega el ID o elige de tu cuenta" onChange={(e) => setForm({ ...form, voiceId: e.target.value.trim() })} />
            <datalist id="voz-ids">{voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</datalist>
          </div>
          <div className="field">
            <label htmlFor="pr-model">Modelo</label>
            <select id="pr-model" className="input" value={form.modelId || ctx?.defaultModel || ""} onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
              {(ctx?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pr-product">Producto</label>
            <select id="pr-product" className="input" value={form.product ?? ""} onChange={(e) => setForm({ ...form, product: e.target.value })}>
              <option value="">Cualquiera</option>
              {(ctx?.products ?? []).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="pr-country">País</label><input id="pr-country" className="input" value={form.country ?? ""} placeholder="venezuela" onChange={(e) => setForm({ ...form, country: e.target.value })} /></div>
          <Slider id="pr-stab" label="Estabilidad" value={form.stability ?? 0.5} onChange={(v) => setForm({ ...form, stability: v })} />
          <Slider id="pr-sim" label="Similitud" value={form.similarity ?? 0.75} onChange={(v) => setForm({ ...form, similarity: v })} />
          <Slider id="pr-style" label="Estilo" value={form.style ?? 0} onChange={(v) => setForm({ ...form, style: v })} />
          <div className="field">
            <button type="button" className="switch" role="switch" aria-checked={form.speakerBoost !== false} onClick={() => setForm({ ...form, speakerBoost: form.speakerBoost === false })}>
              <span className="knob">{form.speakerBoost !== false ? "✓" : ""}</span> Realce de locutor
            </button>
          </div>
        </div>
        <div className="ia-inline">
          <button className="btn" disabled={busy !== null || !form.name?.trim() || !form.voiceId?.trim()} onClick={() => void savePreset()}><Save size={14} aria-hidden /> {form.id ? "Guardar cambios" : "Guardar preset"}</button>
          {(form.id || form.name || form.voiceId) && <button className="btn ghost" onClick={() => setForm(EMPTY_PRESET)}>Limpiar</button>}
        </div>
      </Card>

      {key?.present && (
        <Card className="voz-card">
          <div className="card-head">
            <h2 className="card-title"><AudioLines size={16} aria-hidden /> Voces de tu cuenta ({voices.length})</h2>
            <input className="input voz-filter" placeholder="Buscar por nombre o acento" aria-label="Buscar voces" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <ul className="voz-list">
            {shown.map((v) => (
              <li key={v.id}>
                <span><strong>{v.name}</strong> <small className="muted">{[v.category, ...Object.values(v.labels)].filter(Boolean).join(" · ")}</small><br /><code>{v.id}</code></span>
                <span>
                  {v.previewUrl && (
                    <button className="btn sm ghost" aria-label={`${player.playing === v.id ? "Pausar" : "Escuchar"} ${v.name}`} onClick={() => player.toggle(v.id, v.previewUrl as string)}>
                      {player.playing === v.id ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
                    </button>
                  )}
                  <button className="btn sm ghost" onClick={() => setForm({ ...EMPTY_PRESET, name: v.name, voiceId: v.id })}>Usar en un preset</button>
                </span>
              </li>
            ))}
            {!shown.length && <li className="muted">No hay voces que coincidan.</li>}
          </ul>
        </Card>
      )}

      <Card className="voz-card">
        <h2 className="card-title"><Wand2 size={16} aria-hidden /> Generar audio</h2>
        <div className="field">
          <label htmlFor="gen-text">Texto</label>
          <textarea id="gen-text" className="input" rows={5} value={text} maxLength={ctx?.maxChars ?? 10000} placeholder="Escribe el texto con todas las tildes, ¿ y ¡." onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="voz-form">
          <div className="field">
            <label htmlFor="gen-preset">Preset</label>
            <select id="gen-preset" className="input" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">Elige un preset</option>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="gen-product">Producto</label>
            <select id="gen-product" className="input" value={product} onChange={(e) => { setProduct(e.target.value); setCountry(""); }}>
              <option value="">—</option>
              {(ctx?.products ?? []).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="gen-country">País</label>
            <input id="gen-country" className="input" list="gen-countries" value={country} placeholder="venezuela" onChange={(e) => setCountry(e.target.value)} />
            <datalist id="gen-countries">{countries.map((c) => <option key={c} value={c} />)}</datalist>
          </div>
          <div className="field"><label htmlFor="gen-file">Nombre del archivo (opcional)</label><input id="gen-file" className="input" value={filename} placeholder="guion-01" onChange={(e) => setFilename(e.target.value)} /></div>
          <div className="field voz-wide">
            <label htmlFor="gen-dir">Otra carpeta de destino (opcional)</label>
            <input id="gen-dir" className="input" value={outputDir} placeholder={product && country ? `Producto ${product}\\audios\\${country}` : "Por defecto: audios del producto y país"} onChange={(e) => setOutputDir(e.target.value)} />
            <small>Vacío = la carpeta audios del producto y país. Nunca se sobrescribe un audio: si existe, se agrega -2.</small>
          </div>
        </div>
        <p className="voz-estimate">
          {estimate ? (
            <>
              <strong>{formatNumber(estimate.chars)}</strong> caracteres → <strong>{formatNumber(estimate.credits)}</strong> créditos estimados ({estimate.modelId})
              {sub ? <> · tienes {formatNumber(sub.remaining)}</> : null}
            </>
          ) : (
            <span className="muted">Escribe un texto para ver el costo estimado.</span>
          )}
        </p>
        {!enough && <Notice>El texto necesita más créditos de los que te quedan. Acórtalo o renueva el plan.</Notice>}
        <button className="btn" disabled={!canGenerate || !enough || busy !== null} onClick={() => setConfirming(true)}>Generar audio</button>
        {!presetId && !!text.trim() && <small className="muted"> Elige un preset para poder generar.</small>}

        {result && (
          <div className="voz-result">
            <p>Listo: <code>{result.file}</code> ({formatNumber(result.credits)} créditos)</p>
            {result.dataUrl ? <audio controls src={result.dataUrl} /> : <small className="muted">No pude cargar el reproductor, pero el archivo está en esa ruta.</small>}
          </div>
        )}
      </Card>

      <AnimatePresence>
        {confirming && estimate && (
          <Modal
            title="Confirmar el gasto de créditos"
            locked={busy === "generate"}
            onClose={() => setConfirming(false)}
            footer={
              <>
                <button className="btn ghost" disabled={busy === "generate"} onClick={() => setConfirming(false)}>Cancelar</button>
                <button className="btn" disabled={busy === "generate"} onClick={() => void generate()}>{busy === "generate" ? "Generando…" : "Sí, generar"}</button>
              </>
            }
          >
            <p>Se enviarán <strong>{formatNumber(estimate.chars)}</strong> caracteres a ElevenLabs y se descontarán unos <strong>{formatNumber(estimate.credits)}</strong> créditos de tu cuenta{sub ? ` (te quedan ${formatNumber(sub.remaining)})` : ""}.</p>
            <p className="muted">Este gasto no se puede deshacer.</p>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}
