// Typed wrappers for the "Agentes" section. Agents run on the locally installed Claude Code (the user's plan);
// nothing here ever sees an API key. One-shot commands go through `agent_call`, streaming ones through `agent_start`
// and arrive as `agent-status` (chat) / `agent-eval-status` (quality evaluation) events carrying the `agentId`.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AgentSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StepInfo {
  id: string;
  tool: string;
  label: string;
  ok: boolean | null;
  summary: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  total: number;
}

export interface PlanInfo {
  fiveHour: number | null;
  resetsAt: number | null;
  status: string | null;
}

export interface MessageMeta {
  usage?: Usage;
  /** Tokens of the first model call of the turn (system prompt, tool schemas, skills): what every inner turn re-reads. */
  baseContext?: number;
  durationMs?: number;
  turns?: number;
  steps?: StepInfo[];
  /** Figures of the answer that were not found in the turn's data. */
  ungrounded?: string[];
  plan?: PlanInfo | null;
  model?: string;
  cancelled?: boolean;
  /** Learning: 1 = thumbs up, -1 = thumbs down / marked wrong. */
  rating?: 1 | -1;
  /** Comment typed with "Esto está mal". */
  comment?: string;
}

export interface AgentMessage {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  meta: MessageMeta;
}

export interface AnalistaSettings {
  claudePath: string;
  model: string;
  web: boolean;
  learning: boolean;
  /** Agente creativo only: Codex (image generation with the ChatGPT plan). */
  codexModel?: string;
  codexEffort?: string;
  codexHome?: string;
  codexPath?: string;
}

/** What the creativo asks the user to approve before generating anything. */
export interface ProposalItem {
  id: number;
  tool: "generate_image" | "design_pdf_asset" | "generate_voice";
  label: string;
  units: { images?: number; chars?: number; credits?: number };
  status: string;
}

export interface Proposal {
  id: number;
  ts: number;
  summary: string;
  status: "pending" | "approved" | "rejected";
  items: ProposalItem[];
}

export interface CodexStatus {
  found: boolean;
  loggedIn: boolean;
  codexHome: string;
  message: string;
}

export type RoadmapStatus = "pendiente" | "en_progreso" | "hecho" | "no_aplica";

export interface RoadmapItem {
  id: number;
  productId: string;
  /** null = an item of the whole product. */
  country: string | null;
  templateId: string;
  phase: string | null;
  title: string;
  status: RoadmapStatus;
  evidencePath: string | null;
  notes: string;
  /** What the disk said when it was last checked ("12 de 16 archivos"). */
  detail: string;
  markedBy: "usuario" | "agente" | "sistema";
  updated: number;
  evidenceBroken: boolean;
  skill?: string | null;
  manual?: boolean;
}

export interface RoadmapProduct {
  id: string;
  name: string;
  folder: string;
  countries: string[];
  progress: Record<string, { total: number; done: number; pct: number }>;
  rows: { templateId: string; title: string; scope: "product" | "country"; sort: number; skill: string | null; manual: boolean }[];
  items: RoadmapItem[];
  next: RoadmapItem[];
}

/** A file the creativo generated and what the user did with it (what the creativo learns from). */
export interface CreativeAsset {
  id: number;
  ts: number;
  product: string;
  country: string;
  kind: string;
  path: string;
  status: "generated" | "used" | "discarded";
  ctCode: string | null;
}

export interface ResearchMeasurement {
  term: string;
  country: string;
  count: number;
  verdict: "saturado" | "competitivo" | "hueco";
  measuredOn: string;
  infoproducers: number | null;
}

export interface ResearchLaunch {
  reportId: number;
  launchedOn: string;
  product: string;
  ctCode: string | null;
  source: "analista" | "usuario";
  label: "acierto" | "fallo" | "neutral" | "sin_datos";
  hit: boolean | null;
  result: { roas?: number | null };
}

export interface ResearchReport {
  id: number;
  date: string;
  topic: string;
  path: string;
  verdict: "saturado" | "competitivo" | "hueco";
  decision: "entrar" | "validar" | "descartar";
  mainTerm: string | null;
  mainCount: number | null;
  measurements: ResearchMeasurement[];
  launch: ResearchLaunch | null;
}

export interface ResearchThresholds {
  saturated: number;
  competitive: number;
  roasGood: number;
  roasBad: number;
}

export interface LaunchInput {
  reportId: number;
  ctCode?: string;
  product?: string;
  launchedOn?: string;
  roas?: number;
  ticket?: number;
  costPerMessage?: number;
  conversion?: number;
}

export interface LaunchComparison {
  informe: { id: number; tema: string; veredicto: string; decision: string };
  real: { fuente: string; etiqueta: string; roas: number | null };
  acerto_la_decision: boolean | null;
  aviso?: string;
  lanzamientos_medidos: number;
  siguiente: string;
}

export interface AnalistaStatus {
  claude: { found: boolean; path: string | null };
  adsDb: boolean;
  agentDb: boolean;
  workspace: string;
  settings: AnalistaSettings;
}

/** Events of a chat turn (normalized by the engine from Claude Code's stream-json). */
export type TurnEvent =
  | { type: "turn_start"; sessionId: string; userMessageId: number }
  | { type: "init"; claudeSessionId: string | null; mcp: { name: string; status: string }[]; tools: string[] }
  | { type: "message_start" }
  | { type: "text"; delta: string }
  | { type: "step"; id: string; tool: string; label: string }
  | { type: "step_done"; id: string; tool: string; ok: boolean; summary: string }
  | { type: "proposal"; id: number }
  | { type: "plan"; status: string | null; fiveHour: number | null; resetsAt: number | null }
  | { type: "result"; ok: boolean; text: string; durationMs: number; turns: number; usage: Usage }
  | { type: "done"; sessionId: string; messageId: number; text: string; meta: MessageMeta; newCandidates?: number; candidateIds?: number[] }
  | { type: "cancelled"; sessionId: string; messageId: number }
  | { type: "error"; sessionId: string | null; error: string };

export type LessonStatus = "candidate" | "certified" | "rejected";

export interface Lesson {
  id: number;
  key: string;
  text: string;
  scope: string;
  kind: "rule" | "preference" | "agent";
  source: "distiller" | "agent" | "user";
  evidence: { support?: number; acierto?: number; fallo?: number; nota?: string };
  status: LessonStatus;
  weight: number;
  created: number;
  certifiedAt: number | null;
}

export interface LearningSummary {
  lessons: Record<LessonStatus, number>;
  outcomes: Record<"acierto" | "fallo" | "neutral" | "sin_datos", number>;
  pending: number;
  signals: { total: number; count: number; byKind: Record<string, { count: number; sum: number }> };
}

export interface RecMetrics {
  from?: string;
  to?: string;
  days?: number;
  gasto?: number;
  ventas?: number;
  valor?: number;
  roas?: number;
  costoVenta?: number | null;
  gastoDia?: number;
  ventasDia?: number;
}

export interface Recommendation {
  id: number;
  recDate: string;
  sessionId: string | null;
  entityType: "ct" | "ad" | "adset" | "campaign";
  entityId: string;
  entityLabel: string;
  action: string;
  params: { pct?: number };
  rationale: string;
  baseline: RecMetrics;
  evalAfterDays: number;
  status: "pending" | "evaluated" | "expired";
  followed: "unknown" | "yes" | "no";
  outcome: { evaluatedAt: number; after: RecMetrics; label: "acierto" | "fallo" | "neutral" | "sin_datos"; explanation: string } | null;
}

export interface EvalQuestion {
  id: string;
  category: "numeric" | "judged" | "scope" | "refuse";
  question: string;
  skip: string | null;
  judged: boolean;
}

export interface EvalEstimate {
  questions: number;
  claudeRuns: number;
  judgeRuns: number;
  skipped: number;
}

export interface EvalRun {
  id: number;
  ts: number;
  finishedAt: number | null;
  status: "running" | "done" | "cancelled";
  total: number;
  passed: number;
  failed: number;
  excluded: number;
  model: string;
  passRate: number | null;
}

export interface EvalResult {
  id: number;
  questionId: string;
  category: string;
  question: string;
  status: "pass" | "fail" | "excluded";
  expected: string;
  answer: string;
  detail: string;
  ms: number;
  ungrounded: number;
}

export type EvalEvent =
  | { type: "eval_start"; runId: number; total: number; estimate: EvalEstimate }
  | { type: "eval_progress"; runId: number; index: number; total: number; id: string; question: string; phase: string }
  | { type: "eval_result"; runId: number; index: number; id: string; status: "pass" | "fail" | "excluded"; detail: string }
  | { type: "eval_done"; runId: number; status: string; passed: number; failed: number; excluded: number; passRate: number | null }
  | { type: "error"; error: string };

export interface ProcStatus {
  running: boolean;
  pid: number | null;
  logs: string[];
}

export type AgentTab = "chat" | "lecciones" | "recomendaciones" | "calidad" | "hoja" | "informes" | "ajustes";

export interface AgentInfo {
  id: string;
  name: string;
  shortName?: string;
  description: string;
  icon: string;
  /** Tabs that apply to this agent (the creativo has no ads-metrics tabs). */
  tabs?: AgentTab[];
  starters?: string[];
  welcome?: { title: string; text: string };
  /** True when the agent reads the ads database (adds the "no ads data yet" notice). */
  usesAdsData?: boolean;
}

/** What `agent_status` reports: this agent's two process slots and which agent (if any) holds the single Claude slot. */
export interface AgentRunStatus {
  agentId: string;
  chat: ProcStatus;
  eval: ProcStatus;
  busyAgent: string | null;
}

/** Event payloads from the Rust side always carry the `agentId` that produced them. */
type Tagged<T> = T & { agentId?: string };

/**
 * Typed API of ONE agent. Every command goes through `agent_call` / `agent_start` with this agentId, and the event
 * listeners only deliver the events of this agent (so two agents can never mix their chats).
 */
export function makeAgentApi(agentId: string) {
  const call = <T,>(command: string, payload: Record<string, unknown> = {}) => invoke<T>("agent_call", { agentId, command, payload });
  const mine = <T,>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> =>
    listen<Tagged<T>>(event, (e) => {
      if (e.payload?.agentId === agentId) cb(e.payload);
    });
  return {
    agentId,
    call,
    status: () => call<AnalistaStatus>("status"),
    sessions: () => call<{ sessions: AgentSession[] }>("sessions"),
    newSession: () => call<{ sessionId: string }>("session-new"),
    renameSession: (sessionId: string, title: string) => call("session-rename", { sessionId, title }),
    deleteSession: (sessionId: string) => call("session-delete", { sessionId }),
    messages: (sessionId: string) => call<{ messages: AgentMessage[] }>("messages", { sessionId }),
    lessons: (ids?: number[]) => call<{ summary: LearningSummary; lessons: Lesson[] }>("learning-get", ids ? { ids } : {}),
    setLesson: (id: number, action: "certify" | "reject" | "revoke" | "restore") => call<{ lesson: Lesson }>("lesson-set", { id, action }),
    editLesson: (id: number, text: string) => call<{ lesson: Lesson }>("lesson-edit", { id, text }),
    feedback: (messageId: number, kind: "up" | "down" | "wrong", comment?: string) => call<{ rating: number }>("feedback", { messageId, kind, comment }),
    recommendations: () => call<{ recommendations: Recommendation[] }>("recommendations"),
    measureNow: () => call<{ evaluated: number; candidates: number }>("learning-run"),
    evalBank: () => call<{ questions: EvalQuestion[]; estimate: EvalEstimate; today: string }>("eval-bank"),
    evalRuns: () => call<{ runs: EvalRun[] }>("eval-runs"),
    evalDetail: (runId: number) => call<{ run: EvalRun | null; results: EvalResult[] }>("eval-run-detail", { runId }),
    onEval: (cb: (event: EvalEvent) => void): Promise<UnlistenFn> => mine<EvalEvent>("agent-eval-status", cb),
    onEvalExit: (cb: () => void): Promise<UnlistenFn> => mine<object>("agent-eval-exit", () => cb()),
    proposals: (status?: string) => call<{ proposals: Proposal[] }>("proposals", status ? { status } : {}),
    decideProposal: (id: number, approve: boolean) => call<{ id: number; status: string }>("proposal-decide", { id, approve }),
    roadmap: (product?: string) => call<{ board: RoadmapProduct[]; seeded: { created: number; refreshed: number } }>("roadmap-get", product ? { product } : {}),
    setItem: (id: number, status: RoadmapStatus, note?: string) => call<{ item: RoadmapItem }>("item-set", { id, status, note }),
    assets: (status?: string) => call<{ assets: CreativeAsset[] }>("assets", status ? { status } : {}),
    setAsset: (id: number, status: CreativeAsset["status"], ctCode?: string) => call<{ output: CreativeAsset }>("asset-set", { id, status, ...(ctCode !== undefined ? { ctCode } : {}) }),
    researchList: () => call<{ reports: ResearchReport[]; thresholds: ResearchThresholds }>("research-list"),
    markLaunched: (input: LaunchInput) => call<LaunchComparison>("research-launch", input as unknown as Record<string, unknown>),
    codexStatus: () => call<CodexStatus>("codex-status"),
    settings: () => call<{ settings: AnalistaSettings }>("settings-get"),
    saveSettings: (partial: Partial<AnalistaSettings>) => call<{ settings: AnalistaSettings }>("settings-set", partial),
    start: (command: "turn" | "eval-run", payload: Record<string, unknown>) => invoke<number>("agent_start", { agentId, command, payload }),
    cancel: () => invoke<void>("agent_cancel", { agentId }),
    running: () => invoke<AgentRunStatus>("agent_status", { agentId }),
    onTurn: (cb: (event: TurnEvent) => void): Promise<UnlistenFn> => mine<TurnEvent>("agent-status", cb),
    onExit: (cb: () => void): Promise<UnlistenFn> => mine<object>("agent-exit", () => cb()),
  };
}

export type AgentApi = ReturnType<typeof makeAgentApi>;

/** Kept so existing imports keep working. */
export const analista = makeAgentApi("analista");

/** Public registry of the engine (id, name, description, icon). */
export const listAgents = () => analista.call<{ agents: AgentInfo[] }>("agents-list");

/** Fires when ANY agent starts or stops working (the "trabajando" badge lives above the chats, not inside them). */
export const onAnyAgentActivity = async (cb: (agentId: string, working: boolean) => void): Promise<UnlistenFn> => {
  const offs = await Promise.all([
    listen<Tagged<object>>("agent-status", (e) => {
      if (e.payload?.agentId) cb(e.payload.agentId, true);
    }),
    listen<Tagged<object>>("agent-exit", (e) => {
      if (e.payload?.agentId) cb(e.payload.agentId, false);
    }),
  ]);
  return () => offs.forEach((off) => off());
};

export const STARTERS = [
  "¿Qué CT debería escalar esta semana?",
  "¿Cómo le fue a CT 07 desde la subida de presupuesto?",
  "Compara Colombia vs Venezuela este mes",
  "¿Qué anuncios debería apagar hoy?",
];

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

export const formatTokens = (n: number) => n.toLocaleString("es-CO");
