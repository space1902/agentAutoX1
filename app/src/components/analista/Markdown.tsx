import { Fragment, type ReactNode } from "react";

/**
 * Small, safe Markdown renderer for the Analista's answers: headings, paragraphs, lists, tables, quotes, code,
 * bold/italic/inline code. Links are shown as text (the agent's output is never a navigation target).
 * `marks` are figures the engine could not find in the turn's data: they are highlighted, never removed.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function markFigures(text: string, marks: string[], key: string): ReactNode {
  if (!marks.length) return text;
  const re = new RegExp(`(${[...marks].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})`, "g");
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    marks.includes(part) ? (
      <mark key={`${key}-${i}`} className="an-unverified" title="Cifra no verificada: no la encontré en los datos que consulté en este turno.">
        {part}
        <sup aria-label="cifra no verificada">?</sup>
      </mark>
    ) : (
      <Fragment key={`${key}-${i}`}>{part}</Fragment>
    ),
  );
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;

export function renderInline(text: string, marks: string[], keyBase = "i"): ReactNode[] {
  return text.split(INLINE).filter((p) => p !== "").map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={key}>{renderInline(part.slice(2, -2), marks, key)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={key}>{renderInline(part.slice(1, -1), marks, key)}</em>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      return (
        <span key={key} className="an-link" title={link[2]}>
          {link[1]} <small>({link[2]})</small>
        </span>
      );
    }
    return <Fragment key={key}>{markFigures(part, marks, key)}</Fragment>;
  });
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "hr" }
  | { kind: "table"; head: string[]; rows: string[][] };

const splitRow = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || ordered.test(line)) {
      const kind = bullet.test(line) ? "ul" : "ol";
      const re = kind === "ul" ? bullet : ordered;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ""));
      blocks.push({ kind, items });
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1]))) para.push(lines[i++]);
    blocks.push({ kind: "p", text: para.join(" ") });
  }
  return blocks;
}

const numericCell = (s: string) => /^[-+$\s]*[\d.,]+\s*(%|x|mil|M)?$/.test(s);

export default function Markdown({ text, marks = [] }: { text: string; marks?: string[] }) {
  return (
    <div className="an-md">
      {parseBlocks(text).map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case "h": {
            const Tag = (`h${Math.min(b.level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
            return <Tag key={key}>{renderInline(b.text, marks, key)}</Tag>;
          }
          case "ul":
            return <ul key={key}>{b.items.map((it, j) => <li key={j}>{renderInline(it, marks, `${key}-${j}`)}</li>)}</ul>;
          case "ol":
            return <ol key={key}>{b.items.map((it, j) => <li key={j}>{renderInline(it, marks, `${key}-${j}`)}</li>)}</ol>;
          case "quote":
            return <blockquote key={key}>{renderInline(b.text, marks, key)}</blockquote>;
          case "code":
            return <pre key={key}><code>{b.text}</code></pre>;
          case "hr":
            return <hr key={key} />;
          case "table":
            return (
              <div className="table-wrap an-table" key={key}>
                <table>
                  <thead>
                    <tr>{b.head.map((h, j) => <th key={j}>{renderInline(h, marks, `${key}-h${j}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => <td key={k} className={numericCell(c) ? "num" : undefined}>{renderInline(c, marks, `${key}-${j}-${k}`)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <p key={key}>{renderInline(b.text, marks, key)}</p>;
        }
      })}
    </div>
  );
}
