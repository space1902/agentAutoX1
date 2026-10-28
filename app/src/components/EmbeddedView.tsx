import { ExternalLink, MonitorSmartphone, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, type Pod } from "../lib/api";
import { Notice, Pill } from "./ui";

interface Props {
  pods: Pod[];
  /** True while a dialog is open: the native BlueStacks window would be drawn over it, so it is hidden. */
  suspended: boolean;
}

/** CSS-pixel rectangle of the stage, which is the client area of the webview. */
function measure(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 };
}

/**
 * Experimental: one tab per running pod; the active tab shows that pod's BlueStacks window inside the app.
 * Behind the `embedView` flag. "Abrir en ventana aparte" gives the window back at any time.
 */
export default function EmbeddedView({ pods, suspended }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [released, setReleased] = useState<string[]>([]); // pods the user popped out: not re-embedded until asked
  const [error, setError] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getEmbedView().then(setEnabled).catch(() => setEnabled(false));
  }, []);

  const tabs = pods.filter((p) => p.state === "running" && !released.includes(p.name)).map((p) => p.name);
  const current = active && tabs.includes(active) ? active : (tabs[0] ?? null);
  const visible = enabled === true && !suspended && current !== null;

  const toggle = async (value: boolean) => {
    setError(null);
    try {
      await api.setEmbedView(value);
      setEnabled(value);
      if (!value) setReleased([]);
    } catch (e) {
      setError(errorText(e));
    }
  };

  // Keep the native window glued to the placeholder when the layout changes.
  const relayout = useCallback(() => {
    const el = stage.current;
    if (!el || !current) return;
    const m = measure(el);
    void api.embedResize(current, m.x, m.y, m.width, m.height, m.dpr).catch(() => undefined);
  }, [current]);

  // Attach the active pod and show it; hide everything when nothing should be visible (also on unmount).
  useEffect(() => {
    const el = stage.current;
    if (!visible || !el || !current) return;
    let cancelled = false;
    let settle = 0;
    (async () => {
      try {
        const m = measure(el);
        await api.embedAttach(current, m.x, m.y, m.width, m.height, m.dpr);
        if (!cancelled) {
          await api.embedActivate(current);
          setError(null);
          // The page slides in with a transform (no resize event): measure again once it settled.
          settle = window.setTimeout(relayout, 450);
        }
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(settle);
      void api.embedActivate(null).catch(() => undefined);
    };
  }, [visible, current, relayout]);

  useEffect(() => {
    const el = stage.current;
    if (!visible || !el) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(relayout);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [visible, relayout]);

  // Pods that stopped: forget their embedded window.
  useEffect(() => {
    if (!enabled) return;
    const stopped = pods.filter((p) => p.state !== "running").map((p) => p.name);
    stopped.forEach((name) => void api.embedDetach(name).catch(() => undefined));
    setReleased((prev) => prev.filter((n) => !stopped.includes(n)));
  }, [pods, enabled]);

  const popOut = async (name: string) => {
    setError(null);
    try {
      await api.embedDetach(name);
      setReleased((prev) => [...prev, name]);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="card embed-card">
      <div className="card-head">
        <h2 className="card-title">Vista embebida</h2>
        <div className="head-actions">
          <Pill tone="amber">Experimental</Pill>
          <div className="seg yesno" role="switch" aria-checked={enabled === true} aria-label="Vista embebida">
            <button className={enabled ? "on" : ""} onClick={() => void toggle(true)} disabled={enabled === null}>
              Sí
            </button>
            <button className={enabled === false ? "on" : ""} onClick={() => void toggle(false)} disabled={enabled === null}>
              No
            </button>
          </div>
        </div>
      </div>

      {error && <Notice>{error}</Notice>}

      {!enabled ? (
        <div className="placeholder">
          <MonitorSmartphone size={30} aria-hidden />
          <strong>Función experimental</strong>
          <span>Al activarla, cada pod encendido tendrá una pestaña y su ventana de BlueStacks se verá aquí dentro. Puedes sacarla a una ventana aparte cuando quieras.</span>
        </div>
      ) : (
        <>
          {released.length > 0 && (
            <p className="muted">
              En ventana aparte: {released.join(", ")}.{" "}
              <button className="link-btn" onClick={() => setReleased([])}>
                Volver a ponerlas en la vista
              </button>
            </p>
          )}
          {tabs.length === 0 ? (
            <div className="placeholder">
              <MonitorSmartphone size={30} aria-hidden />
              <strong>No hay pods encendidos</strong>
              <span>Enciende un pod y aparecerá aquí como una pestaña.</span>
            </div>
          ) : (
            <>
              <div className="embed-tabs" role="tablist" aria-label="Pods encendidos">
                {tabs.map((name) => (
                  <div key={name} className={`embed-tab ${name === current ? "active" : ""}`}>
                    <button role="tab" aria-selected={name === current} onClick={() => setActive(name)}>
                      {name}
                    </button>
                    <button className="embed-close" aria-label={`Sacar ${name} a una ventana aparte`} title="Sacar a una ventana aparte" onClick={() => void popOut(name)}>
                      <X size={12} aria-hidden />
                    </button>
                  </div>
                ))}
                {current && (
                  <button className="btn sm ghost embed-popout" onClick={() => void popOut(current)}>
                    <ExternalLink size={14} aria-hidden /> Abrir en ventana aparte
                  </button>
                )}
              </div>
              <div className="embed-stage" ref={stage} role="tabpanel">
                {suspended && <span className="muted">La vista se oculta mientras hay un diálogo abierto.</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
