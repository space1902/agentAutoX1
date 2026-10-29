import { useCallback, useEffect, useState } from "react";
import AnalistaSettingsPanel from "../components/analista/AnalistaSettings";
import ChatPanel from "../components/analista/ChatPanel";
import { Banner } from "../components/ui";
import { analista } from "../lib/analistaApi";

type Tab = "chat" | "ajustes";

export default function Analista() {
  const [tab, setTab] = useState<Tab>("chat");
  const [learning, setLearning] = useState(true);
  const [, setLearningTick] = useState(0);

  useEffect(() => {
    void analista.settings().then((r) => setLearning(r.settings.learning)).catch(() => undefined);
  }, []);

  const bumpLearning = useCallback(() => setLearningTick((n) => n + 1), []);

  return (
    <div className="page analista">
      <Banner title="Analista" subtitle="Un asistente que consulta tus datos reales de anuncios y ventas, hace las cuentas con código y te dice qué escalar, mantener o apagar." />

      <div className="ia-tabs" role="tablist" aria-label="Secciones del Analista">
        {([["chat", "Chat"], ["ajustes", "Ajustes"]] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`ia-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "chat" && <ChatPanel learning={learning} onGoSettings={() => setTab("ajustes")} onLearningChange={bumpLearning} />}
      {tab === "ajustes" && <AnalistaSettingsPanel onSaved={(s) => setLearning(s.learning)} />}
    </div>
  );
}
