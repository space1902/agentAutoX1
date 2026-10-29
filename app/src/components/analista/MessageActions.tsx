import type { AgentMessage } from "../../lib/analistaApi";

/** Feedback and "¿Aprendo esto?" controls under an answer (filled in by the learning phase). */
export default function MessageActions(_props: {
  message: AgentMessage;
  showCandidates: number;
  onChanged: () => void;
  onRated: (rating: 1 | -1) => void;
}) {
  return null;
}
