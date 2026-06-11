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

/**
 * Strip markdown inline marks that the docx markdown importer converts into
 * styling rather than literal characters: paired `**...**` (bold) and paired
 * `` `...` `` (inline code) — only the marks are removed, the inner content is
 * preserved.
 *
 * Unpaired single `*` and unpaired single `` ` `` are kept verbatim: the
 * corpus contains literal sequences like `c-*` that must not be mangled.
 * Triple-or-more `*` runs (e.g. bold-italic `***x***`) are not in scope and
 * collapse via the same pair-matching loop as `**` — outer pair removed, inner
 * `*` preserved (which would still drift from the rendered plain text, but the
 * current corpus contains no such cases; the guard in `parseInlineRich` covers
 * the symmetric concern for the elements rebuilder).
 *
 * Used by the ref-pass to normalize manifest text down to what the docx
 * actually exposes as plain text after import (no asterisks, no backticks),
 * so block-locating equality matches succeed.
 */
export function stripInlineMarks(content: string): string {
  return stripPairedDelim(stripPairedDelim(content, "**"), "`");
}

function stripPairedDelim(content: string, delim: string): string {
  if (!content.includes(delim)) return content;
  let out = "";
  let cursor = 0;
  const delimLen = delim.length;
  while (cursor < content.length) {
    const open = content.indexOf(delim, cursor);
    if (open === -1) {
      out += content.slice(cursor);
      return out;
    }
    const close = content.indexOf(delim, open + delimLen);
    if (close === -1) {
      // unpaired opener: keep the rest verbatim, including the delim
      out += content.slice(cursor);
      return out;
    }
    if (close === open + delimLen) {
      // empty pair "****" or "``": keep both delims literally, advance past them
      out += content.slice(cursor, close + delimLen);
      cursor = close + delimLen;
      continue;
    }
    out += content.slice(cursor, open);
    out += content.slice(open + delimLen, close);
    cursor = close + delimLen;
  }
  return out;
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
