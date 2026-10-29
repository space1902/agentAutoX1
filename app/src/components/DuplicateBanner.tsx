import { TriangleAlert } from "lucide-react";
import type { DuplicateGroup } from "../lib/api";
import { formatPhone } from "../lib/phone";

const memberName = (id: string) => (id === "bot" ? "el bot principal" : id);

/** Amber banner listing every number used by more than one tester (or by a tester and the bot). */
export function DuplicateBanner({ groups }: { groups: DuplicateGroup[] | undefined }) {
  if (!groups || groups.length === 0) return null;
  return (
    <div className="notice warn" role="status">
      <strong className="warn-title">
        <TriangleAlert size={15} aria-hidden /> {groups.length === 1 ? "Hay un número repetido" : `Hay ${groups.length} números repetidos`}
      </strong>
      <ul>
        {groups.map((g) => (
          <li key={g.key}>
            <strong>{formatPhone(g.phone)}</strong>: {g.members.map(memberName).join(", ")}
          </li>
        ))}
      </ul>
      <span className="muted">Un mismo WhatsApp vinculado dos veces puede cerrar la sesión de ambos. Desvincula el repetido desde el teléfono (Dispositivos vinculados).</span>
    </div>
  );
}
