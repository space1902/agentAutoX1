import { listen } from "@tauri-apps/api/event";
import { Info, Link2, Play, Save, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../../lib/api";
import {
  agoText,
  alertsApi,
  type AlertThresholds,
  type AlertsConfig,
  type LinkEvent,
  type MonitorStatusEvent,
  type RecentAlert,
  type WaState,
} from "../../lib/adsApi";
import { Tooltip } from "../Tooltip";
import { Card, Notice, Pill, Skeleton } from "../ui";

const WA_LABEL: Record<WaState, { text: string; tone: "green" | "gray" | "amber" | "red" }> = {
  connected: { text: "WhatsApp conectado", tone: "green" },
  connecting: { text: "WhatsApp conectando…", tone: "amber" },
  unlinked: { text: "WhatsApp sin vincular", tone: "gray" },
  conflict: { text: "Sesión de WhatsApp en conflicto", tone: "red" },
  error: { text: "WhatsApp con error", tone: "red" },
};

type NumKey = keyof AlertThresholds;

const THRESHOLDS: { key: NumKey; label: string; help: string }[] = [
  { key: "targetCpa", label: "CPA objetivo (verde)", help: "Costo por venta que consideras bueno. También es el gasto sin vender a partir del cual un anuncio genera una preocupación." },
  { key: "reviewCpa", label: "CPA de revisión (rojo)", help: "Si un anuncio gasta esto sin vender, se te sugiere pausarlo (solo si las acciones están activadas). Debe ser mayor que el objetivo." },
  { key: "gapWorryMin", label: "Minutos sin ventas: preocupación", help: "Piso de minutos sin ninguna venta en toda la cuenta para avisarte. El monitor lo amplía solo si normalmente vendes menos de una por hora." },
  { key: "gapActionMin", label: "Minutos sin ventas: acción", help: "Piso de minutos sin ventas para pedirte una acción. Debe ser mayor que el de preocupación." },
  { key: "maxGapMin", label: "Máximo de minutos sin ventas", help: "Tope hasta donde el monitor puede ampliar los umbrales de minutos sin ventas según tu ritmo habitual." },
  { key: "noSpendHours", label: "Horas sin gasto", help: "Un anuncio activo que no gasta nada durante estas horas dispara un aviso (en revisión, sin presupuesto o sin entrega)." },
  { key: "noPurchaseHours", label: "Horas sin compras (píxel)", help: "Ventana para sospechar que el seguimiento de compras dejó de funcionar: muchas conversaciones y cero compras." },
  { key: "minConversationsNoPurchase", label: "Conversaciones mínimas sin compra", help: "Cuántas conversaciones deben haberse iniciado en esa ventana, con cero compras, para avisar del píxel." },
  { key: "costPerConversationMult", label: "Costo por conversación: veces el promedio", help: "Avisa si el costo por conversación de un anuncio supera su promedio de los días de referencia por este factor (1,5 = 50 % más caro)." },
  { key: "minConversationsForCost", label: "Conversaciones mínimas para comparar costo", help: "Con menos conversaciones que esto no se compara el costo (hay muy poco dato)." },
  { key: "frequencyMax", label: "Frecuencia máxima", help: "Veces promedio que una persona vio el anuncio. Por encima de esto la audiencia se está saturando." },
  { key: "ctrMinRatio", label: "CTR mínimo (proporción del promedio)", help: "Avisa si el CTR cae por debajo de esta fracción de su promedio (0,6 = 40 % menos)." },
  { key: "cpmMaxRatio", label: "CPM máximo (proporción del promedio)", help: "Avisa si el CPM sube por encima de esta proporción de su promedio (1,4 = 40 % más caro)." },
  { key: "minImpressions", label: "Impresiones mínimas", help: "Con menos impresiones que esto no se evalúan frecuencia, CTR ni CPM." },
];

function Help({ text }: { text: string }) {
  return (
    <Tooltip className="info" content={<p className="info-text">{text}</p>} label="Qué significa" placement="bottom-end" width={280}>
      <Info size={14} aria-hidden />
    </Tooltip>
  );
}

function Field({ id, label, help, children }: { id: string; label: string; help: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} <Help text={help} />
      </label>
      {children}
    </div>
  );
}

const minutesLeft = (ts: number | null, now: number) => (ts ? Math.max(0, Math.ceil((ts - now) / 60000)) : null);

export default function AlertsPanel() {
  const [config, setConfig] = useState<AlertsConfig | null>(null);
  const [draft, setDraft] = useState<AlertsConfig | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<MonitorStatusEvent | null>(null);
  const [recent, setRecent] = useState<RecentAlert[]>([]);
  const [wa, setWa] = useState({ linked: false, phoneMasked: "" });
  const [conflict, setConflict] = useState<number | null>(null);
  const [linking, setLinking] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const logEnd = useRef<HTMLDivElement>(null);

  const fail = (e: unknown) => setError(errorText(e));

  const loadRecent = useCallback(async () => {
    try {
      setRecent((await alertsApi.recent()).alerts);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const loadWa = useCallback(async () => {
    try {
      setWa(await alertsApi.waStatus());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await alertsApi.configGet();
        setConfig(cfg.config);
        setDraft(cfg.config);
        const [m, l] = await Promise.all([alertsApi.monitorStatus(), alertsApi.linkStatus()]);
        setRunning(m.running);
        setLogs(m.logs);
        setStatus(m.status);
        setLinking(l.running);
      } catch (e) {
        setError(errorText(e));
      }
      void loadRecent();
      void loadWa();
    })();
    const unlisten = [
      listen<{ line: string }>("ads-monitor-log", (e) => setLogs((prev) => [...prev.slice(-299), e.payload.line])),
      listen<MonitorStatusEvent>("ads-monitor-status", (e) => {
        setRunning(true);
        setStatus(e.payload);
        void loadRecent();
      }),
      listen("ads-monitor-exit", () => {
        setRunning(false);
        void loadRecent();
      }),
      listen<LinkEvent>("ads-link-status", (e) => {
        if (e.payload.type === "pairing_code" && e.payload.code) setCode(e.payload.code);
        if (e.payload.type === "linked") {
          setNotice("WhatsApp quedó vinculado.");
          setCode(null);
          void loadWa();
        }
        if (e.payload.error) setError(e.payload.error);
      }),
      listen("ads-link-exit", () => {
        setLinking(false);
        setCode(null);
        void loadWa();
      }),
    ];
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => {
      unlisten.forEach((p) => void p.then((fn) => fn()));
      window.clearInterval(timer);
    };
  }, [loadRecent, loadWa]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [logs]);

  const start = async (confirmConflict: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const mins = confirmConflict ? null : await alertsApi.conflict();
      if (mins !== null) {
        setConflict(mins);
        return;
      }
      setConflict(null);
      const s = await alertsApi.monitorStart(confirmConflict);
      setRunning(s.running);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await alertsApi.monitorStop();
      setRunning(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const saved = (await alertsApi.configSet(draft)).config;
      setConfig(saved);
      setDraft(saved);
      setNotice(running ? "Guardado. Apaga y vuelve a encender el monitor para aplicar los cambios." : "Configuración guardada.");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const startLink = async () => {
    if (!draft) return;
    setError(null);
    setBusy(true);
    try {
      await alertsApi.configSet({ whatsapp: draft.whatsapp });
      await alertsApi.linkStart(draft.whatsapp.senderPhone);
      setLinking(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const importSession = async () => {
    setBusy(true);
    setError(null);
    try {
      const copied = await alertsApi.importSession(wa.linked);
      setNotice(`Sesión copiada (${copied} archivos). El monitor aparte no se tocó.`);
      setConfirmImport(false);
      await loadWa();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!draft || !config) return <Skeleton height={240} />;

  const m = status?.monitor;
  const waState: WaState = status?.wa?.state ?? (wa.linked ? "connecting" : "unlinked");
  const next = minutesLeft(m?.nextPollTs ?? null, now);
  const setNum = (key: NumKey, value: string) => setDraft({ ...draft, thresholds: { ...draft.thresholds, [key]: value === "" ? 0 : Number(value) } });

  return (
    <div className="alerts-panel">
      {error && <Notice>{error}</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}

      <Card>
        <div className="card-head">
          <h2 className="card-title">Monitor de alertas</h2>
          <Pill tone={running ? "green" : "gray"}>{running ? "Encendido" : "Apagado"}</Pill>
        </div>
        <p className="muted ads-note">
          Vigila tus campañas cada pocos minutos y te avisa por WhatsApp. Empieza apagado. {draft.allowActions ? "Las acciones sobre anuncios requieren tu aprobación por WhatsApp." : "Modo solo alertas: no cambia nada en tus anuncios."}
        </p>
        <div className="alerts-status">
          <Pill tone={WA_LABEL[waState].tone}>{WA_LABEL[waState].text}</Pill>
          {running && m && (
            <>
              <span className="muted">Último sondeo: {agoText(m.lastPollTs, now)}</span>
              <span className="muted">Próximo: {next === null ? "—" : next === 0 ? "en instantes" : `en ${next} min`}</span>
              <span className="muted">Uso de la API de Meta: {Math.round(m.usagePct)} %</span>
              <span className="muted">Ventas desde: {m.salesSource === "sheet" ? "la hoja de pagos" : m.salesSource === "both" ? "hoja y Meta" : "Meta"}</span>
            </>
          )}
        </div>
        {m?.lastError && <Notice>{m.lastError}</Notice>}
        {status?.type === "fatal" && status.error && <Notice>{status.error}</Notice>}

        {conflict !== null && (
          <div className="notice alerts-conflict" role="alertdialog" aria-label="Monitor aparte activo">
            <p>
              Parece que el monitor aparte está corriendo (escribió su registro hace {conflict} min); detenlo antes para no recibir alertas dobles. La app no lo detiene por ti.
            </p>
            <div className="ia-inline">
              <button className="btn secondary sm" onClick={() => void start(true)}>Entiendo, iniciar igual</button>
              <button className="btn ghost sm" onClick={() => setConflict(null)}>Cancelar</button>
            </div>
          </div>
        )}
        <div className="ia-inline" style={{ marginTop: 12 }}>
          {running ? (
            <button className="btn danger" disabled={busy} onClick={() => void stop()}><Square size={15} aria-hidden /> Apagar monitor</button>
          ) : (
            <button className="btn" disabled={busy || linking} onClick={() => void start(false)}><Play size={15} aria-hidden /> Encender monitor</button>
          )}
        </div>
      </Card>

      <Card>
        <div className="card-head">
          <h2 className="card-title">WhatsApp</h2>
          <Pill tone={wa.linked ? "green" : "gray"}>{wa.linked ? `Vinculado ${wa.phoneMasked}` : "Sin vincular"}</Pill>
        </div>
        <div className="ia-grid">
          <Field id="wa-sender" label="Número remitente" help="El número desde el que se envían los avisos (con código de país). Se vincula con un código de 8 caracteres, nunca con QR.">
            <input id="wa-sender" className="input" inputMode="tel" value={draft.whatsapp.senderPhone} onChange={(e) => setDraft({ ...draft, whatsapp: { ...draft.whatsapp, senderPhone: e.target.value } })} placeholder="573001234567" />
          </Field>
          <Field id="wa-to" label="Número que recibe los avisos" help="Tu número personal. Solo los mensajes de este número pueden dar órdenes al monitor (SI, NO, ESTADO...).">
            <input id="wa-to" className="input" inputMode="tel" value={draft.whatsapp.alertTo} onChange={(e) => setDraft({ ...draft, whatsapp: { ...draft.whatsapp, alertTo: e.target.value } })} placeholder="573001234567" />
          </Field>
        </div>
        <div className="ia-inline">
          <button className="btn secondary sm" disabled={busy || running || linking} onClick={() => void startLink()}>
            <Link2 size={14} aria-hidden /> Vincular con código
          </button>
          {linking && <button className="btn ghost sm" onClick={() => void alertsApi.linkCancel().catch(fail)}>Cancelar vinculación</button>}
          <button className="btn ghost sm" disabled={busy || running || linking} onClick={() => setConfirmImport(true)}>Importar sesión de meta-ads-monitor</button>
        </div>
        {linking && (
          <div className="alerts-code" role="status">
            {code ? (
              <>
                <span className="muted">En el celular del remitente: WhatsApp &gt; Dispositivos vinculados &gt; Vincular con número de teléfono, y escribe:</span>
                <strong>{code}</strong>
              </>
            ) : (
              <span className="muted">Pidiendo el código a WhatsApp…</span>
            )}
          </div>
        )}
        {confirmImport && (
          <div className="notice alerts-conflict" role="alertdialog" aria-label="Importar sesión">
            <p>
              Se copiará la sesión de WhatsApp del monitor aparte (la original no se mueve ni se borra). Una misma sesión no puede usarse en dos procesos a la vez: apaga el monitor aparte antes de encender este.
              {wa.linked ? " Ya hay una sesión en la app y será reemplazada." : ""}
            </p>
            <div className="ia-inline">
              <button className="btn secondary sm" disabled={busy} onClick={() => void importSession()}>Copiar sesión</button>
              <button className="btn ghost sm" onClick={() => setConfirmImport(false)}>Cancelar</button>
            </div>
          </div>
        )}
      </Card>

      <div className="ia-two">
        <Card>
          <div className="card-head"><h2 className="card-title">Registro en vivo</h2></div>
          <div className="alerts-log" role="log" aria-live="off">
            {logs.length === 0 ? <span className="muted">Aquí aparecerá lo que haga el monitor.</span> : logs.map((l, i) => <div key={i}>{l}</div>)}
            <div ref={logEnd} />
          </div>
        </Card>
        <Card>
          <div className="card-head"><h2 className="card-title">Alertas recientes</h2></div>
          {recent.length === 0 ? (
            <p className="muted">Todavía no hay alertas.</p>
          ) : (
            <ul className="alerts-list">
              {recent.slice(0, 30).map((a) => (
                <li key={a.id}>
                  <div className="alerts-list-head">
                    <Pill tone={a.severity >= 2 ? "red" : "amber"}>{a.type}</Pill>
                    <span className="muted">{new Date(a.ts).toLocaleString("es-CO")}</span>
                    {!a.sent && <span className="muted">· no enviada</span>}
                  </div>
                  <p>{a.text}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <div className="card-head"><h2 className="card-title">Ajustes del monitor</h2></div>
        <div className="ia-grid">
          <Field id="al-poll" label="Minutos entre sondeos" help="Cada cuántos minutos consulta a Meta. Menos minutos = avisos más rápidos pero más uso de la API.">
            <input id="al-poll" className="input" type="number" min={1} value={draft.pollMinutes} onChange={(e) => setDraft({ ...draft, pollMinutes: Number(e.target.value) })} />
          </Field>
          <Field id="al-prefix" label="Prefijo de campañas" help="Solo se vigilan las campañas cuyo nombre empieza así (por defecto CT).">
            <input id="al-prefix" className="input" value={draft.campaignPrefix} onChange={(e) => setDraft({ ...draft, campaignPrefix: e.target.value })} />
          </Field>
          <Field id="al-base" label="Días de referencia" help="Cuántos días anteriores se usan para calcular tu promedio habitual (costo por conversación, CTR, CPM y ritmo de ventas por hora).">
            <input id="al-base" className="input" type="number" min={1} value={draft.baselineDays} onChange={(e) => setDraft({ ...draft, baselineDays: Number(e.target.value) })} />
          </Field>
          <Field id="al-cool" label="Minutos de espera entre avisos iguales" help="Mientras no pase este tiempo no se repite el mismo aviso, salvo que empeore.">
            <input id="al-cool" className="input" type="number" min={1} value={draft.cooldownMin} onChange={(e) => setDraft({ ...draft, cooldownMin: Number(e.target.value) })} />
          </Field>
          <Field id="al-active-s" label="Horas activas: desde" help="Las alertas de ventas y de gasto solo se evalúan dentro de este horario (hora de la cuenta publicitaria).">
            <input id="al-active-s" className="input" type="number" min={0} max={24} value={draft.activeHours.start} onChange={(e) => setDraft({ ...draft, activeHours: { ...draft.activeHours, start: Number(e.target.value) } })} />
          </Field>
          <Field id="al-active-e" label="Horas activas: hasta" help="Hora de fin del horario activo (puede cruzar la medianoche).">
            <input id="al-active-e" className="input" type="number" min={0} max={24} value={draft.activeHours.end} onChange={(e) => setDraft({ ...draft, activeHours: { ...draft.activeHours, end: Number(e.target.value) } })} />
          </Field>
          <Field id="al-rest-s" label="Horas restringidas: desde" help="En este horario ninguna acción sobre anuncios se ejecuta; queda en cola hasta que termine.">
            <input id="al-rest-s" className="input" type="number" min={0} max={24} value={draft.restrictedHours.start} onChange={(e) => setDraft({ ...draft, restrictedHours: { ...draft.restrictedHours, start: Number(e.target.value) } })} />
          </Field>
          <Field id="al-rest-e" label="Horas restringidas: hasta" help="Hora en que termina el horario restringido.">
            <input id="al-rest-e" className="input" type="number" min={0} max={24} value={draft.restrictedHours.end} onChange={(e) => setDraft({ ...draft, restrictedHours: { ...draft.restrictedHours, end: Number(e.target.value) } })} />
          </Field>
          <Field id="al-source" label="De dónde salen las ventas" help="La hoja de pagos es la fuente real: cuenta los pagos válidos del flujo. «Meta» usa las compras que reporta el píxel. «Ambas» toma la cifra mayor.">
            <select id="al-source" className="input" value={draft.salesSource} onChange={(e) => setDraft({ ...draft, salesSource: e.target.value as AlertsConfig["salesSource"] })}>
              <option value="sheet">Hoja de pagos</option>
              <option value="meta">Meta (píxel)</option>
              <option value="both">Ambas (la mayor)</option>
            </select>
          </Field>
          {THRESHOLDS.map(({ key, label, help }) => (
            <Field key={key} id={`al-${key}`} label={label} help={help}>
              <input id={`al-${key}`} className="input" type="number" min={0} step="any" value={draft.thresholds[key]} onChange={(e) => setNum(key, e.target.value)} />
            </Field>
          ))}
        </div>
        <div className="ads-switches">
          <label className="ads-check">
            <input type="checkbox" checked={draft.summaryEnabled} onChange={(e) => setDraft({ ...draft, summaryEnabled: e.target.checked })} /> Enviar un resumen por WhatsApp cada hora activa
          </label>
          <label className="ads-check alerts-danger">
            <input type="checkbox" checked={draft.allowActions} onChange={(e) => setDraft({ ...draft, allowActions: e.target.checked })} />
            Permitir acciones sobre anuncios (pausar conjuntos, cambiar presupuesto) solo si respondo SI por WhatsApp
          </label>
          <small className="muted">Apagado (recomendado): el monitor solo envía alertas y la conexión con Meta es de solo lectura. Para aplicar los cambios apaga y vuelve a encender el monitor.</small>
        </div>
        <button className="btn" disabled={busy} onClick={() => void saveConfig()}><Save size={15} aria-hidden /> Guardar ajustes</button>
      </Card>
    </div>
  );
}
