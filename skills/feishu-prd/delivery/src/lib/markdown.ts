// Render a PRD manifest into Lark-flavored Markdown for `docs +create`.
//
// Only text-renderable blocks (paragraph / list / table) are emitted here, with
// headings numbered per D14. Media (image/mermaid) and callouts are NOT
// expressible in the create-markdown (images need upload; markdown `>` yields a
// quote, not a callout) — the orchestrator inserts those after creation,
// anchored by the numbered title returned alongside the markdown.

import { numberHeadings, type Heading, type NumberedHeading } from "./numbering.ts";
import type { PrdManifest, BlockSpec, TableSpec, ListSpec } from "./manifest.ts";

function escapeCell(c: string): string {
  return c.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderTable(t: TableSpec): string {
  const head = `| ${t.header.map(escapeCell).join(" | ")} |`;
  const sep = `| ${t.header.map(() => "---").join(" | ")} |`;
  const rows = t.rows.map((r) => `| ${r.map(escapeCell).join(" | ")} |`);
  return [head, sep, ...rows].join("\n");
}

function renderList(l: ListSpec): string {
  return l.items.map((it, i) => (l.style === "ordered" ? `${i + 1}. ${it}` : `- ${it}`)).join("\n");
}

/** Returns the markdown for a block, or null if it must be inserted post-create. */
function renderBlock(b: BlockSpec): string | null {
  switch (b.kind) {
    case "paragraph":
      return b.text;
    case "list":
      return renderList(b.list);
    case "table":
      return renderTable(b.table);
    case "callout":
    case "image":
    case "mermaid":
      return null;
  }
}

export interface RenderedManifest {
  readonly markdown: string;
  /** numbered heading per section, in document order (parallel to manifest.sections). */
  readonly numbered: readonly NumberedHeading[];
}

export function renderManifestMarkdown(m: PrdManifest): RenderedManifest {
  const headings: Heading[] = m.sections.map((s) => ({ level: s.level, title: s.title }));
  const numbered = numberHeadings(headings);
  const parts: string[] = [];
  m.sections.forEach((s, i) => {
    const n = numbered[i]!;
    parts.push(`${"#".repeat(s.level)} ${n.numbered}`);
    for (const b of s.blocks) {
      const r = renderBlock(b);
      if (r !== null && r.trim() !== "") parts.push(r);
    }
  });
  return { markdown: `${parts.join("\n\n")}\n`, numbered };
}
