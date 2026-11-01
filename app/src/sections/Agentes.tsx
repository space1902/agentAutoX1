import { BarChart3, Bot, Clapperboard, Loader2, Search, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import AnalistaSettingsPanel from "../components/analista/AnalistaSettings";
import ChatPanel from "../components/analista/ChatPanel";
import QualityPanel from "../components/analista/QualityPanel";
import ResearchPanel from "../components/analista/ResearchPanel";
import RoadmapBoard from "../components/analista/RoadmapBoard";
import LessonsPanel from "../components/analista/LessonsPanel";
import RecommendationsPanel from "../components/analista/RecommendationsPanel";
import { Banner, Notice } from "../components/ui";
import { errorText } from "../lib/api";
import { listAgents, makeAgentApi, onAnyAgentActivity, type AgentInfo, type AgentTab } from "../lib/agentApi";

type Tab = AgentTab;

// Used until the engine answers (and if it never does), so the section is never empty.
const FALLBACK_AGENTS: AgentInfo[] = [
  { id: "analista", name: "Analista de publicidad", shortName: "Analista", description: "Analiza tus anuncios de Meta, explica qué pasa y aprende de los resultados.", icon: "BarChart3", tabs: ["chat", "lecciones", "recomendaciones", "calidad", "ajustes"], usesAdsData: true },
];

// Registry icon keys -> lucide icons.
const ICONS: Record<string, LucideIcon> = { BarChart3, Clapperboard, Search };

const TABS: ReadonlyArray<readonly [Tab, string]> = [["chat", "Chat"], ["lecciones", "Lecciones"], ["recomendaciones", "Recomendaciones"], ["calidad", "Calidad"], ["hoja", "Hoja de ruta"], ["informes", "Informes"], ["ajustes", "Ajustes"]];
const ALL_TABS: Tab[] = TABS.map(([id]) => id);

export default function Agentes() {
  const [agents, setAgents] = useState<AgentInfo[]>(FALLBACK_AGENTS);
  const [selected, setSelected] = useState<string>(FALLBACK_AGENTS[0].id);
  // Which agents are working right now. Kept here (not in the chat) so the badge survives switching agents.
  const [working, setWorking] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<Tab>("chat");
  const [learning, setLearning] = useState(true);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const agent = agents.find((a) => a.id === selected) ?? agents[0];
  const api = useMemo(() => makeAgentApi(agent.id), [agent.id]);
  // Only the tabs that apply to the agent (each one learns; only the Analista has the ads-metrics tabs).
  const agentTabs = agent.tabs ?? ALL_TABS;
  const hasLessons = agentTabs.includes("lecciones");

  useEffect(() => {
    void listAgents().then((r) => r.agents.length && setAgents(r.agents)).catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    let alive = true;
    // The section can be opened while an agent is already running (the process lives in the backend).
    for (const a of agents) {
      void makeAgentApi(a.id)
        .running()
        .then((s) => alive && setWorking((w) => ({ ...w, [a.id]: s.chat.running || s.eval.running })))
        .catch(() => undefined);
    }
    const off = onAnyAgentActivity((id, isWorking) => alive && setWorking((w) => ({ ...w, [id]: isWorking })));
    return () => {
      alive = false;
      void off.then((fn) => fn());
    };
  }, [agents]);

  useEffect(() => {
    void api.settings().then((r) => setLearning(r.settings.learning)).catch(() => undefined);
  }, [api]);

  const bumpLearning = useCallback(() => setTick((n) => n + 1), []);
  const select = (id: string) => {
    if (id === selected) return;
    setSelected(id);
    setTab("chat");
  };

  const busyOther = agents.find((a) => a.id !== agent.id && working[a.id]);

  return (
    <div className="page analista agentes">
      <Banner title="Agentes" subtitle="Asistentes que trabajan con Claude Code en tu equipo, con las herramientas y datos de cada uno. Solo uno puede estar trabajando a la vez." />

      <div className="agent-cards" role="tablist" aria-label="Agentes">
        {agents.map((a) => {
          const Icon = ICONS[a.icon] ?? Bot;
          const busy = working[a.id] === true;
          return (
            <button key={a.id} role="tab" aria-selected={a.id === agent.id} className={`card agent-card ${a.id === agent.id ? "active" : ""}`} onClick={() => select(a.id)}>
              <span className="agent-card-icon" aria-hidden>
                <Icon size={20} />
              </span>
              <span className="agent-card-body">
                <strong>{a.name}</strong>
                <span className="muted">{a.description}</span>
              </span>
              <span className={`agent-badge ${busy ? "busy" : ""}`}>
                {busy ? <Loader2 size={12} className="spin" aria-hidden /> : null}
                {busy ? "Trabajando" : "Libre"}
              </span>
            </button>
          );
        })}
      </div>

      {error && <Notice>{error}</Notice>}
      {busyOther && <Notice kind="ok">{`${busyOther.name} está trabajando. Hasta que termine no podrás lanzar otra consulta con ${agent.name}.`}</Notice>}

      <div className="ia-tabs" role="tablist" aria-label={`Secciones de ${agent.name}`}>
        {TABS.filter(([id]) => agentTabs.includes(id)).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`ia-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {/* Keyed by agent so a chat, its listeners and its drafts never leak into another agent. */}
      <div key={agent.id}>
        {tab === "chat" && <ChatPanel api={api} agent={agent} learning={learning && hasLessons} onGoSettings={() => setTab("ajustes")} onLearningChange={bumpLearning} />}
        {tab === "lecciones" && <LessonsPanel api={api} agent={agent} learning={learning} refreshKey={tick} />}
        {tab === "hoja" && <RoadmapBoard api={api} refreshKey={tick} />}
        {tab === "informes" && <ResearchPanel api={api} refreshKey={tick} />}
        {tab === "recomendaciones" && <RecommendationsPanel api={api} refreshKey={tick} />}
        {tab === "calidad" && <QualityPanel api={api} />}
        {tab === "ajustes" && <AnalistaSettingsPanel api={api} agent={agent} showLearning={hasLessons} onSaved={(s) => setLearning(s.learning)} />}
      </div>
    </div>
  );
}
