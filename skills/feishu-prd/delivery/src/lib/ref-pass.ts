// Cross-reference rewrite pass (pass-2).
//
// The markdown create pass renders refs as plain display text. After the doc
// is created, this pass:
//   1. builds anchorId -> headingBlockId map (one GET per anchored section);
//   2. for each manifest block that contains refs, locates the corresponding
//      doc block (paragraph / list / table cell) by stripped-text matching
//      within the section's heading window, with order-based disambiguation;
//   3. rebuilds the block's text elements (preserving bold styling) with
//      link runs and writes it back via PATCH update_text_elements.
//
// Path-B blocks (callout / grid) are inserted directly with refs already
// baked in — they do NOT pass through this rewriter.

import { LarkError, larkApi } from "./lark.ts";
import { parseInlineRich, patchBlockTextElements, type RefResolver, type TextRunElement } from "./blocks.ts";
import { hasRef, stripRefs } from "./refs.ts";
import type { BlockSpec, PrdManifest, PrdSection, TableSpec, ListSpec } from "./manifest.ts";

export interface RefStats {
  /** total `[[ref:...]]` occurrences across the manifest (path-A + path-B). */
  readonly totalRefs: number;
  /** refs whose anchorId resolved to a heading URL. */
  readonly resolvedRefs: number;
  /** path-A blocks rewritten via PATCH update_text_elements. */
  readonly patchedBlocks: number;
}

interface AnchoredSection {
  readonly index: number;
  readonly section: PrdSection;
  readonly numberedTitle: string;
}

interface DocBlock {
  readonly block_id: string;
  readonly block_type: number;
  readonly parent_id: string;
  readonly children?: readonly string[];
  readonly raw: Record<string, unknown>;
}

interface BuildResultLike {
  readonly doc_id: string;
  readonly doc_url: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function nextPageToken(data: Record<string, unknown>): string | undefined {
  const token = data.page_token ?? data.next_page_token;
  return typeof token === "string" && token.trim() !== "" ? token : undefined;
}

async function fetchAllBlocks(docId: string): Promise<readonly DocBlock[]> {
  const blocks: DocBlock[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, unknown> = { page_size: 500 };
    if (pageToken !== undefined) params.page_token = pageToken;
    const data = await larkApi({
      method: "GET",
      path: `/open-apis/docx/v1/documents/${docId}/blocks`,
      params,
    });
    if (!isRecord(data) || !Array.isArray(data.items)) {
      throw new LarkError("GET blocks did not return items", data);
    }
    for (const item of data.items) {
      if (!isRecord(item)) continue;
      const blockId = item.block_id;
      const blockType = item.block_type;
      const parentId = item.parent_id;
      if (typeof blockId !== "string" || typeof blockType !== "number" || typeof parentId !== "string") continue;
      const children = Array.isArray(item.children)
        ? item.children.filter((c): c is string => typeof c === "string")
        : undefined;
      blocks.push({ block_id: blockId, block_type: blockType, parent_id: parentId, children, raw: item });
    }
    pageToken = data.has_more === true ? nextPageToken(data) : undefined;
  } while (pageToken !== undefined);
  return blocks;
}

function textRunContents(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(textRunContents);
  if (!isRecord(v)) return [];
  const current = isRecord(v.text_run) && typeof v.text_run.content === "string" ? [v.text_run.content] : [];
  return [...current, ...Object.values(v).flatMap(textRunContents)];
}

function blockText(block: DocBlock): string {
  return textRunContents(block.raw).join("");
}

function isHeadingBlockType(blockType: number): boolean {
  return blockType >= 3 && blockType <= 9;
}

/**
 * Build the anchorId -> doc URL map by matching each anchored section's
 * numbered heading text to a heading block_id in the freshly created doc.
 * The doc URL is derived from `doc_url` with a `#blockId` fragment, which
 * Feishu's docx frontend interprets as a scroll-to-block instruction.
 */
function buildAnchorUrlMap(
  anchored: readonly AnchoredSection[],
  topLevel: readonly DocBlock[],
  docUrl: string,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const a of anchored) {
    const id = a.section.anchorId;
    if (id === undefined) continue;
    const headingBlock = topLevel.find(
      (b) => isHeadingBlockType(b.block_type) && blockText(b) === a.numberedTitle,
    );
    if (headingBlock === undefined) {
      throw new LarkError(
        `cannot locate heading block for anchorId "${id}" (numbered title "${a.numberedTitle}") in created doc`,
      );
    }
    map.set(id, `${docUrl}#${headingBlock.block_id}`);
  }
  return map;
}

/** Iterate all manifest text positions that may contain refs, return their plain (stripped) forms. */
interface ManifestText {
  readonly blockIndex: number;
  /**
   * The plain text after stripping refs — this is what was rendered into the
   * doc and what we will match against doc-block contents.
   */
  readonly stripped: string;
  /** Original text WITH refs — feeds the elements rebuilder. */
  readonly source: string;
}

function manifestParagraphTexts(block: BlockSpec, blockIndex: number): readonly ManifestText[] {
  if (block.kind === "paragraph") {
    return [{ blockIndex, stripped: stripRefs(block.text), source: block.text }];
  }
  return [];
}

function manifestListItems(list: ListSpec, blockIndex: number): readonly ManifestText[] {
  return list.items.map((it) => ({ blockIndex, stripped: stripRefs(it), source: it }));
}

function manifestTableCells(table: TableSpec, blockIndex: number): readonly ManifestText[] {
  const cells: ManifestText[] = [];
  for (const cell of table.header) cells.push({ blockIndex, stripped: stripRefs(cell), source: cell });
  for (const row of table.rows) for (const cell of row) cells.push({ blockIndex, stripped: stripRefs(cell), source: cell });
  return cells;
}

/** Doc blocks that fall under one section heading (between this heading and the next heading at the same or shallower level). */
function sectionWindow(
  topLevel: readonly DocBlock[],
  headingId: string,
): readonly DocBlock[] {
  const start = topLevel.findIndex((b) => b.block_id === headingId);
  if (start < 0) return [];
  const startLevel = topLevel[start]!.block_type;
  const window: DocBlock[] = [];
  for (let i = start + 1; i < topLevel.length; i++) {
    const b = topLevel[i]!;
    // Stop at next heading of equal or shallower level (smaller block_type
    // number = shallower in docx where heading1=3 < heading2=4 < ...).
    if (isHeadingBlockType(b.block_type) && b.block_type <= startLevel) break;
    window.push(b);
  }
  return window;
}

/**
 * Find the i-th doc block under `window` whose stripped plain text matches
 * `target` and which is one of the paragraph-like text-bearing block types
 * (block_type 2 = text, 12 = bullet, 13 = ordered). Used to locate
 * paragraph / list items.
 *
 * `occurrenceIndex` is 0-based: if the same plain text appears multiple times
 * in the section, occurrenceIndex=0 picks the first, =1 the second, etc.
 */
function findTextBlockInSection(
  window: readonly DocBlock[],
  target: string,
  occurrenceIndex: number,
): DocBlock | undefined {
  let seen = 0;
  for (const b of window) {
    if (b.block_type !== 2 && b.block_type !== 12 && b.block_type !== 13) continue;
    if (blockText(b) !== target) continue;
    if (seen === occurrenceIndex) return b;
    seen += 1;
  }
  return undefined;
}

/**
 * Find the first table in the section, then locate cell text blocks by
 * traversing children. Tables (block_type 31) own row blocks (32) which own
 * cell blocks (33) which own text blocks (2). Cell text blocks are the only
 * place inline links can attach inside a table.
 */
function findTableTextBlocks(
  window: readonly DocBlock[],
  allBlocks: ReadonlyMap<string, DocBlock>,
  occurrenceIndex: number,
): readonly DocBlock[] {
  let seen = 0;
  for (const b of window) {
    if (b.block_type !== 31) continue;
    if (seen === occurrenceIndex) return collectTableCellTextBlocks(b, allBlocks);
    seen += 1;
  }
  return [];
}

function collectTableCellTextBlocks(
  table: DocBlock,
  allBlocks: ReadonlyMap<string, DocBlock>,
): readonly DocBlock[] {
  const out: DocBlock[] = [];
  const walk = (id: string): void => {
    const b = allBlocks.get(id);
    if (b === undefined) return;
    if (b.block_type === 2) {
      out.push(b);
      return;
    }
    for (const c of b.children ?? []) walk(c);
  };
  for (const c of table.children ?? []) walk(c);
  return out;
}

export interface PatchTarget {
  readonly blockId: string;
  readonly elements: readonly TextRunElement[];
}

/**
 * For one section, plan PATCH targets for every path-A block that contains
 * refs. Same-stripped-text occurrences in the same section are disambiguated
 * by manifest order (1st occurrence in manifest -> 1st occurrence in doc).
 */
function planSectionPatches(
  section: PrdSection,
  window: readonly DocBlock[],
  allBlocks: ReadonlyMap<string, DocBlock>,
  resolveRef: RefResolver,
): readonly PatchTarget[] {
  const targets: PatchTarget[] = [];
  const paragraphCounters = new Map<string, number>();
  const tableCounter = { n: 0 };

  section.blocks.forEach((b, blockIndex) => {
    if (b.kind === "paragraph") {
      if (!hasRef(b.text)) return;
      const stripped = stripRefs(b.text);
      const occ = paragraphCounters.get(stripped) ?? 0;
      paragraphCounters.set(stripped, occ + 1);
      const target = findTextBlockInSection(window, stripped, occ);
      if (target === undefined) {
        throw new LarkError(
          `cannot locate paragraph block for section "${section.title}" content "${stripped.slice(0, 60)}..."`,
        );
      }
      targets.push({ blockId: target.block_id, elements: parseInlineRich(b.text, resolveRef) });
      return;
    }

    if (b.kind === "list") {
      for (const item of manifestListItems(b.list, blockIndex)) {
        if (!hasRef(item.source)) continue;
        const occ = paragraphCounters.get(item.stripped) ?? 0;
        paragraphCounters.set(item.stripped, occ + 1);
        const target = findTextBlockInSection(window, item.stripped, occ);
        if (target === undefined) {
          throw new LarkError(
            `cannot locate list item block for section "${section.title}" content "${item.stripped.slice(0, 60)}..."`,
          );
        }
        targets.push({ blockId: target.block_id, elements: parseInlineRich(item.source, resolveRef) });
      }
      return;
    }

    if (b.kind === "table") {
      const cells = manifestTableCells(b.table, blockIndex);
      const hasAnyRef = cells.some((c) => hasRef(c.source));
      if (!hasAnyRef) {
        tableCounter.n += 1;
        return;
      }
      const cellTextBlocks = findTableTextBlocks(window, allBlocks, tableCounter.n);
      tableCounter.n += 1;
      if (cellTextBlocks.length !== cells.length) {
        throw new LarkError(
          `table cell count mismatch in section "${section.title}": manifest=${cells.length} doc=${cellTextBlocks.length}`,
        );
      }
      cells.forEach((cell, i) => {
        if (!hasRef(cell.source)) return;
        const docCell = cellTextBlocks[i]!;
        if (blockText(docCell) !== cell.stripped) {
          throw new LarkError(
            `table cell text mismatch in section "${section.title}" index ${i}: manifest="${cell.stripped.slice(0, 40)}" doc="${blockText(docCell).slice(0, 40)}"`,
          );
        }
        targets.push({ blockId: docCell.block_id, elements: parseInlineRich(cell.source, resolveRef) });
      });
    }
  });

  return targets;
}

function countManifestRefs(m: PrdManifest): number {
  let n = 0;
  const inc = (s: string): void => {
    if (!hasRef(s)) return;
    // Count refs cheaply: parseInlineRefs already filters; reuse a fast regex.
    const matches = s.match(/\[\[ref:[^\]|]+\|[^\]]+\]\]/g);
    if (matches !== null) n += matches.length;
  };
  const walkBlock = (b: BlockSpec): void => {
    if (b.kind === "paragraph") inc(b.text);
    else if (b.kind === "list") for (const it of b.list.items) inc(it);
    else if (b.kind === "table") {
      for (const c of b.table.header) inc(c);
      for (const r of b.table.rows) for (const c of r) inc(c);
    } else if (b.kind === "callout") {
      const lines = b.callout.lines ?? (b.callout.text !== undefined ? b.callout.text.split(/\r?\n/) : []);
      for (const l of lines) inc(l);
    } else if (b.kind === "grid") {
      if (b.grid.blocks !== undefined) {
        for (const rb of b.grid.blocks) {
          if (rb.kind === "paragraph") inc(rb.text);
          else for (const it of rb.items) inc(it);
        }
      } else {
        const ps = b.grid.paragraphs ?? (b.grid.text !== undefined ? b.grid.text.split(/\r?\n/) : []);
        for (const p of ps) inc(p);
      }
    }
  };
  if (m.preamble !== undefined) for (const b of m.preamble) walkBlock(b);
  for (const s of m.sections) for (const b of s.blocks) walkBlock(b);
  return n;
}

export interface BuildRefResolverResult {
  /** Resolver that resolves anchorIds to docx URLs; tracks resolution count. */
  readonly resolver: RefResolver;
  /** Number of successful resolution calls; reset by creating a new resolver. */
  getResolvedCount(): number;
}

/**
 * Build a stateful resolver that counts how many times it returned a URL.
 * Path-B insertions and path-A PATCH builds both use this so we can compute
 * the resolution coverage without re-walking the manifest.
 */
export function buildRefResolver(anchorUrlMap: ReadonlyMap<string, string>): BuildRefResolverResult {
  let resolved = 0;
  return {
    resolver: (anchorId) => {
      const url = anchorUrlMap.get(anchorId);
      if (url !== undefined) resolved += 1;
      return url;
    },
    getResolvedCount: () => resolved,
  };
}

export interface ApplyRefsOptions {
  readonly manifest: PrdManifest;
  readonly built: BuildResultLike;
  readonly numberedTitles: readonly string[];
  /** Pre-built anchorId -> URL map (must include every anchored section). */
  readonly anchorUrlMap: ReadonlyMap<string, string>;
  /** Refs already resolved by path-B insertion (callout / grid). */
  readonly pathBResolvedCount: number;
}

/**
 * Resolve every anchored section's heading block_id (via doc-blocks GET) and
 * return the anchorId -> URL map. The map is built once per build and shared
 * by path-B insertion and path-A PATCH planning.
 */
export async function buildAnchorUrlMapForDoc(
  manifest: PrdManifest,
  built: BuildResultLike,
  numberedTitles: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const anchored = manifest.sections
    .map((section, index) => ({ index, section, numberedTitle: numberedTitles[index]! }))
    .filter((a): a is AnchoredSection => a.section.anchorId !== undefined);
  if (anchored.length === 0) return new Map();
  const all = await fetchAllBlocks(built.doc_id);
  const docId = built.doc_id;
  const topLevel = all.filter((b) => b.parent_id === docId);
  return buildAnchorUrlMap(anchored, topLevel, built.doc_url);
}

/**
 * Resolve cross-references and PATCH every path-A block that contains them.
 *
 * Throws (with stats attached) if any ref could not be resolved or any block
 * could not be located; the build then surfaces this as a hard FAIL — refs
 * are content-significant and silent degradation to plain text would mislead
 * downstream reviewers.
 */
export async function applyManifestRefs(opts: ApplyRefsOptions): Promise<RefStats> {
  const totalRefs = countManifestRefs(opts.manifest);
  if (totalRefs === 0) {
    return { totalRefs: 0, resolvedRefs: opts.pathBResolvedCount, patchedBlocks: 0 };
  }

  const all = await fetchAllBlocks(opts.built.doc_id);
  const docId = opts.built.doc_id;
  const topLevel = all.filter((b) => b.parent_id === docId);
  const blockMap = new Map<string, DocBlock>(all.map((b) => [b.block_id, b]));

  const { resolver, getResolvedCount } = buildRefResolver(opts.anchorUrlMap);

  const allTargets: PatchTarget[] = [];

  // Preamble: blocks that live before the first heading. Build a synthetic
  // section so we can reuse planSectionPatches.
  if (opts.manifest.preamble !== undefined) {
    const preambleWindow: DocBlock[] = [];
    for (const b of topLevel) {
      if (isHeadingBlockType(b.block_type)) break;
      preambleWindow.push(b);
    }
    const preambleSection: PrdSection = {
      level: 1,
      title: "__preamble__",
      anchorKey: "__preamble__",
      blocks: opts.manifest.preamble,
    };
    allTargets.push(...planSectionPatches(preambleSection, preambleWindow, blockMap, resolver));
  }

  for (let si = 0; si < opts.manifest.sections.length; si++) {
    const section = opts.manifest.sections[si]!;
    const sectionHasRefs = section.blocks.some(
      (b) =>
        (b.kind === "paragraph" && hasRef(b.text)) ||
        (b.kind === "list" && b.list.items.some((it) => hasRef(it))) ||
        (b.kind === "table" &&
          (b.table.header.some((c) => hasRef(c)) || b.table.rows.some((r) => r.some((c) => hasRef(c))))),
    );
    if (!sectionHasRefs) continue;
    const headingBlock = topLevel.find(
      (b) => isHeadingBlockType(b.block_type) && blockText(b) === opts.numberedTitles[si],
    );
    if (headingBlock === undefined) {
      throw new LarkError(
        `cannot locate section heading "${opts.numberedTitles[si]}" in created doc when planning ref patches`,
      );
    }
    const window = sectionWindow(topLevel, headingBlock.block_id);
    const targets = planSectionPatches(section, window, blockMap, resolver);
    allTargets.push(...targets);
  }

  for (const target of allTargets) {
    await patchBlockTextElements(docId, target.blockId, target.elements);
  }

  const resolvedRefs = opts.pathBResolvedCount + getResolvedCount();
  if (resolvedRefs !== totalRefs) {
    throw new LarkError(
      `cross-reference rewrite incomplete: resolved ${resolvedRefs} of ${totalRefs} refs (${totalRefs - resolvedRefs} unresolved)`,
    );
  }

  return { totalRefs, resolvedRefs, patchedBlocks: allTargets.length };
}

// ---------------------------------------------------------------------------
// Test helpers (exported only so unit tests can exercise the same-text
// disambiguation path without spinning up the Feishu API).

export interface TestDocBlockInput {
  readonly block_id: string;
  readonly block_type: number;
  readonly parent_id: string;
  readonly children?: readonly string[];
  /** Plain text content this block should report when matched. */
  readonly text?: string;
}

function toDocBlock(input: TestDocBlockInput): DocBlock {
  const raw: Record<string, unknown> = {
    block_id: input.block_id,
    block_type: input.block_type,
    parent_id: input.parent_id,
  };
  if (input.children !== undefined) raw.children = [...input.children];
  if (input.text !== undefined) {
    raw.text = { elements: [{ text_run: { content: input.text, text_element_style: {} } }] };
  }
  return { block_id: input.block_id, block_type: input.block_type, parent_id: input.parent_id, children: input.children, raw };
}

/** @internal test-only: plan PATCH targets for one section against fabricated doc blocks. */
export function planSectionPatchesForTest(
  section: PrdSection,
  headingId: string,
  topLevelBlocks: readonly TestDocBlockInput[],
  resolveRef: RefResolver,
  extraBlocks: readonly TestDocBlockInput[] = [],
): readonly PatchTarget[] {
  const topLevel = topLevelBlocks.map(toDocBlock);
  const extras = extraBlocks.map(toDocBlock);
  const all = [...topLevel, ...extras];
  const map = new Map<string, DocBlock>(all.map((b) => [b.block_id, b]));
  const window = sectionWindow(topLevel, headingId);
  return planSectionPatches(section, window, map, resolveRef);
}
