import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { BarChart3, Cpu, Flame, Hash, LogOut, MessageCircleMore, Settings as SettingsIcon, Smartphone, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type LogLine, type PairingCard } from "./lib/api";
import { usePodCreation } from "./lib/podCreation";
import { applyTheme, loadTheme, type Theme } from "./lib/theme";
import Ajustes from "./sections/Ajustes";
import Anuncios from "./sections/Anuncios";
import IA from "./sections/IA";
import CalentadorBots from "./sections/CalentadorBots";
import MultiWhatsApp from "./sections/MultiWhatsApp";
import Numeros from "./sections/Numeros";

type SectionId = "pods" | "bots" | "numeros" | "anuncios" | "ia" | "ajustes";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "pods", label: "MultiWhatsApp", icon: Smartphone },
  { id: "bots", label: "Calentador Bots", icon: Flame },
  { id: "numeros", label: "Números", icon: Hash },
  { id: "anuncios", label: "Anuncios", icon: BarChart3 },
  { id: "ia", label: "IA", icon: Cpu },
  { id: "ajustes", label: "Ajustes", icon: SettingsIcon },
];

const MAX_LOG_LINES = 2000;

/** Warm-up run state lives here so logs keep flowing while another section is open. */
function useWarmupRun() {
  const [running, setRunning] = useState(false);
  const [profile, setProfile] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [pairing, setPairing] = useState<PairingCard[]>([]);

  const sync = useCallback(async () => {
    try {
      const s = await api.warmupStatus();
      setRunning(s.running);
      setProfile(s.profile);
      setLogs(s.logs);
      setPairing(s.pairing ?? []);
    } catch {
      /* backend not ready yet */
    }
  }, []);

  useEffect(() => {
    void sync();
    const unlisten = [
      listen<LogLine>("warmup-log", (e) => {
        setRunning(true);
        setLogs((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), e.payload]);
        // The profile name arrives with the first status sync after a start.
        void api.warmupStatus().then((s) => setProfile(s.profile)).catch(() => undefined);
      }),
      listen<PairingCard[]>("warmup-pairing", (e) => setPairing(e.payload)),
      listen("warmup-exit", () => {
        setRunning(false);
        setProfile(null);
        setPairing([]);
      }),
    ];
    return () => {
      unlisten.forEach((p) => void p.then((fn) => fn()));
    };
  }, [sync]);

  return { running, profile, logs, pairing, clearLogs: () => setLogs([]) };
}

export default function App() {
  const [section, setSection] = useState<SectionId>("pods");
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const warmup = useWarmupRun();
  const podCreation = usePodCreation(() => undefined);

  useEffect(() => applyTheme(theme), [theme]);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Secciones">
        <div className="logo" aria-hidden>
          <MessageCircleMore size={20} />
        </div>
        <div className="nav">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${section === id ? "active" : ""}`}
              onClick={() => setSection(id)}
              aria-label={label}
              aria-current={section === id ? "page" : undefined}
            >
              <Icon size={19} aria-hidden />
              <span className="tip" role="tooltip">
                {label}
              </span>
            </button>
          ))}
        </div>
        <button className="nav-item" aria-label="Salir" onClick={() => void getCurrentWindow().close()}>
          <LogOut size={19} aria-hidden />
          <span className="tip" role="tooltip">
            Salir
          </span>
        </button>
      </nav>

      <main className="main">
        <AnimatePresence mode="wait">
          <motion.div
            key={section}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {section === "pods" && <MultiWhatsApp creation={podCreation} />}
            {section === "bots" && (
              <CalentadorBots running={warmup.running} profile={warmup.profile} logs={warmup.logs} pairing={warmup.pairing} onClearLogs={warmup.clearLogs} />
            )}
            {section === "numeros" && <Numeros />}
            {section === "anuncios" && <Anuncios />}
            {section === "ia" && <IA warmupRunning={warmup.running} />}
            {section === "ajustes" && <Ajustes theme={theme} onTheme={setTheme} />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
