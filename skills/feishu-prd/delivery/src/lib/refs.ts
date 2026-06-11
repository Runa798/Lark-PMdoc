// In-document cross-reference parsing and resolution.
//
// The manifest allows inline references to other sections in any text-rendered
// position. Syntax:
//
//   [[ref:anchorId|display text]]
//
// During the markdown create pass the reference is degraded to its plain
// display text (heading block_ids don't exist yet). After the doc is created
// the heading map is built and a second pass rewrites the affected blocks via
// PATCH update_text_elements so the display text becomes a clickable link to
// the target heading.
//
// For blocks the engine inserts directly (callout / grid), the link is baked
// into the text elements at insertion time — no PATCH round-trip needed.

const REF_PATTERN = /\[\[ref:([^\]|]+)\|([^\]]+)\]\]/g;

export interface RefSegment {
  readonly kind: "ref";
  readonly anchorId: string;
  readonly text: string;
}

export interface PlainSegment {
  readonly kind: "text";
  readonly text: string;
}

export type InlineSegment = RefSegment | PlainSegment;

/**
 * Split `content` into alternating plain-text and ref segments. The text of a
 * ref segment is the display text (the part after `|`) — never the syntax.
 *
 * The pattern intentionally does not allow `]` inside the anchorId or display
 * text. A reviewer who wants a literal `]` inside ref display text should use
 * a different character; this keeps the parse trivially unambiguous.
 */
export function parseInlineRefs(content: string): readonly InlineSegment[] {
  if (!content.includes("[[ref:")) {
    return content === "" ? [] : [{ kind: "text", text: content }];
  }

  const segments: InlineSegment[] = [];
  let cursor = 0;
  REF_PATTERN.lastIndex = 0;
  for (;;) {
    const match = REF_PATTERN.exec(content);
    if (match === null) break;
    const before = content.slice(cursor, match.index);
    if (before !== "") segments.push({ kind: "text", text: before });
    segments.push({
      kind: "ref",
      anchorId: match[1]!.trim(),
      text: match[2]!,
    });
    cursor = match.index + match[0].length;
  }
  const tail = content.slice(cursor);
  if (tail !== "") segments.push({ kind: "text", text: tail });
  return segments;
}

/** Render the content with refs replaced by their plain display text. */
export function stripRefs(content: string): string {
  if (!content.includes("[[ref:")) return content;
  return parseInlineRefs(content)
    .map((segment) => segment.text)
    .join("");
}

/** True iff the content contains at least one ref syntax occurrence. */
export function hasRef(content: string): boolean {
  if (!content.includes("[[ref:")) return false;
  for (const segment of parseInlineRefs(content)) {
    if (segment.kind === "ref") return true;
  }
  return false;
}

/** Collect every anchorId referenced anywhere in `content`. */
export function collectRefAnchorIds(content: string): readonly string[] {
  if (!content.includes("[[ref:")) return [];
  const ids: string[] = [];
  for (const segment of parseInlineRefs(content)) {
    if (segment.kind === "ref") ids.push(segment.anchorId);
  }
  return ids;
}
