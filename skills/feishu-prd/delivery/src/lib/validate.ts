import type { BlockSpec, PrdManifest, TableSpec } from "./manifest.ts";
import { collectRefAnchorIds, hasRef } from "./refs.ts";

const PREAMBLE_ALLOWED_KINDS: ReadonlySet<BlockSpec["kind"]> = new Set(["paragraph", "list", "table"]);

const GRID_STATIC_DESCENDANT_COUNT = 4;
const GRID_DESCENDANT_LIMIT = 1000;

export class ManifestValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid PRD manifest:\n- ${issues.join("\n- ")}`);
    this.name = "ManifestValidationError";
    this.issues = issues;
  }
}

function containsLineBreak(text: string): boolean {
  return /\r|\n/.test(text);
}

function validateTableBlock(blockLabel: string, table: TableSpec, issues: string[]): void {
  if (table.columnWidths !== undefined) {
    if (table.columnWidths.length !== table.header.length) {
      issues.push(`${blockLabel}.table.columnWidths has ${table.columnWidths.length} columns but header has ${table.header.length}`);
    }
    table.columnWidths.forEach((width, wi) => {
      if (!Number.isFinite(width) || width <= 0) issues.push(`${blockLabel}.table.columnWidths[${wi}] must be a positive number`);
    });
  }
  table.rows.forEach((row, ri) => {
    if (row.length !== table.header.length) {
      issues.push(`${blockLabel}.rows[${ri}] has ${row.length} columns but header has ${table.header.length}`);
    }
  });
}

export function validateManifest(m: PrdManifest): void {
  const issues: string[] = [];
  if (m.title.trim() === "") issues.push("document title must not be empty");

  if (m.preamble !== undefined) {
    m.preamble.forEach((b, bi) => {
      const blockLabel = `preamble.blocks[${bi}]`;
      const kind: unknown = (b as { kind?: unknown }).kind;
      if (typeof kind !== "string" || !PREAMBLE_ALLOWED_KINDS.has(kind as BlockSpec["kind"])) {
        issues.push(
          `${blockLabel} kind "${String(kind)}" is not allowed in preamble — only paragraph / list / table are renderable before the first heading (preamble has no heading anchor for post-create insertion)`,
        );
        return;
      }
      if (b.kind === "table") {
        validateTableBlock(blockLabel, b.table, issues);
      }
    });
  }

  // Heading hierarchy: no section may jump more than 1 level deeper than the previous section
  // (e.g. H4 must not appear before H3 — engine hard constraint "H4 出现前必须先有 H3" FATAL)
  let prevLevel = 0;
  m.sections.forEach((s, si) => {
    if (Number.isInteger(s.level) && s.level >= 1 && s.level <= 5) {
      if (s.level > prevLevel + 1) {
        issues.push(
          `section[${si}] heading level jump: L${prevLevel} -> L${s.level} "${s.title}" (H${s.level} must not appear before H${s.level - 1})`,
        );
      }
      prevLevel = s.level;
    }
  });

  m.sections.forEach((s, si) => {
    const sectionLabel = `section[${si}]`;
    if (s.title.trim() === "") issues.push(`${sectionLabel} title must not be empty`);
    if (!Number.isInteger(s.level) || s.level < 1 || s.level > 5) {
      issues.push(`${sectionLabel} level must be an integer from 1 to 5`);
    }
    if (s.blocks.length === 0) issues.push(`${sectionLabel} must contain at least one block`);

    s.blocks.forEach((b, bi) => {
      const blockLabel = `${sectionLabel}.blocks[${bi}]`;
      if (b.kind === "table") {
        if (b.table.columnWidths !== undefined) {
          if (b.table.columnWidths.length !== b.table.header.length) {
            issues.push(`${blockLabel}.table.columnWidths has ${b.table.columnWidths.length} columns but header has ${b.table.header.length}`);
          }
          b.table.columnWidths.forEach((width, wi) => {
            if (!Number.isFinite(width) || width <= 0) issues.push(`${blockLabel}.table.columnWidths[${wi}] must be a positive number`);
          });
        }
        b.table.rows.forEach((row, ri) => {
          if (row.length !== b.table.header.length) {
            issues.push(`${blockLabel}.rows[${ri}] has ${row.length} columns but header has ${b.table.header.length}`);
          }
        });
      }
      if (b.kind === "callout") {
        const lines = b.callout.lines ?? (b.callout.text !== undefined ? b.callout.text.split(/\r?\n/) : []);
        if (lines.every((line) => line.trim() === "")) issues.push(`${blockLabel}.callout must contain at least one text line`);
        if (b.callout.backgroundColor !== undefined) {
          if (!Number.isInteger(b.callout.backgroundColor) || b.callout.backgroundColor < 1 || b.callout.backgroundColor > 14) {
            issues.push(`${blockLabel}.callout.backgroundColor must be an integer from 1 to 14`);
          }
        }
        if (b.callout.borderColor !== undefined) {
          if (!Number.isInteger(b.callout.borderColor) || b.callout.borderColor < 1 || b.callout.borderColor > 7) {
            issues.push(`${blockLabel}.callout.borderColor must be an integer from 1 to 7`);
          }
        }
      }
      if (b.kind === "image") {
        if (b.image.width !== undefined && (!Number.isInteger(b.image.width) || b.image.width <= 0)) {
          issues.push(`${blockLabel}.image.width must be a positive integer`);
        }
        if (b.image.height !== undefined && (!Number.isInteger(b.image.height) || b.image.height <= 0)) {
          issues.push(`${blockLabel}.image.height must be a positive integer`);
        }
      }
      if (b.kind === "grid") {
        const rightBlocks = b.grid.blocks;
        const usesText = b.grid.text !== undefined;
        const usesParagraphs = b.grid.paragraphs !== undefined;
        if (usesText && usesParagraphs) {
          issues.push(`${blockLabel}.grid must use either text or paragraphs, not both`);
        }
        if (rightBlocks !== undefined && (usesText || usesParagraphs)) {
          issues.push(`${blockLabel}.grid must use only one of text, paragraphs, or blocks`);
        }

        let rightBlockCount = 0;
        if (rightBlocks !== undefined) {
          if (rightBlocks.length === 0) issues.push(`${blockLabel}.grid.blocks must not be empty`);
          rightBlocks.forEach((rightBlock, ri) => {
            const rightBlockLabel = `${blockLabel}.grid.blocks[${ri}]`;
            if (rightBlock.kind === "paragraph") {
              rightBlockCount += 1;
              if (rightBlock.text.trim() === "") issues.push(`${rightBlockLabel}.text must not be empty`);
              if (containsLineBreak(rightBlock.text)) issues.push(`${rightBlockLabel}.text must not contain line breaks`);
            }
            if (rightBlock.kind === "list") {
              const style: unknown = rightBlock.style;
              if (style !== "ordered" && style !== "unordered") {
                issues.push(`${rightBlockLabel}.style must be ordered or unordered`);
              }
              if (rightBlock.items.length === 0) issues.push(`${rightBlockLabel}.items must not be empty`);
              rightBlockCount += rightBlock.items.length;
              rightBlock.items.forEach((item, ii) => {
                if (item.trim() === "") issues.push(`${rightBlockLabel}.items[${ii}] must not be empty`);
                if (containsLineBreak(item)) issues.push(`${rightBlockLabel}.items[${ii}] must not contain line breaks`);
              });
            }
          });
        } else {
          const paragraphs = b.grid.paragraphs ?? (b.grid.text !== undefined ? b.grid.text.split(/\r?\n/) : []);
          rightBlockCount = paragraphs.length;
          if (paragraphs.every((paragraph) => paragraph.trim() === "")) issues.push(`${blockLabel}.grid must contain right-column text`);
        }
        if (rightBlockCount + GRID_STATIC_DESCENDANT_COUNT > GRID_DESCENDANT_LIMIT) {
          issues.push(`${blockLabel}.grid descendants must not exceed ${GRID_DESCENDANT_LIMIT}`);
        }
        if (b.grid.image.width !== undefined && (!Number.isInteger(b.grid.image.width) || b.grid.image.width <= 0)) {
          issues.push(`${blockLabel}.grid.image.width must be a positive integer`);
        }
        if (b.grid.image.height !== undefined && (!Number.isInteger(b.grid.image.height) || b.grid.image.height <= 0)) {
          issues.push(`${blockLabel}.grid.image.height must be a positive integer`);
        }
        if (b.grid.widthRatios !== undefined) {
          const [left, right] = b.grid.widthRatios;
          if (!Number.isInteger(left) || left < 1 || left > 99) issues.push(`${blockLabel}.grid.widthRatios[0] must be an integer from 1 to 99`);
          if (!Number.isInteger(right) || right < 1 || right > 99) issues.push(`${blockLabel}.grid.widthRatios[1] must be an integer from 1 to 99`);
          if (left + right !== 100) issues.push(`${blockLabel}.grid.widthRatios must sum to 100`);
        }
      }
    });
  });

  validateAnchorsAndRefs(m, issues);

  if (issues.length > 0) throw new ManifestValidationError(issues);
}

const REF_FORBIDDEN_KINDS: ReadonlySet<BlockSpec["kind"]> = new Set(["image", "mermaid"]);

function reportRefsIn(text: string, label: string, issues: string[]): void {
  if (!hasRef(text)) return;
  issues.push(`${label} contains [[ref:...]] in an unsupported position (image / mermaid caption do not support inline links)`);
}

function collectKnownAnchorIds(m: PrdManifest, issues: string[]): Set<string> {
  const known = new Set<string>();
  m.sections.forEach((s, si) => {
    if (s.anchorId === undefined) return;
    const id = s.anchorId.trim();
    if (id === "") {
      issues.push(`section[${si}] anchorId must not be empty when present`);
      return;
    }
    if (known.has(id)) {
      issues.push(`section[${si}] anchorId "${id}" is duplicated; anchorIds must be unique`);
      return;
    }
    known.add(id);
  });
  return known;
}

function checkBlockRefs(
  label: string,
  block: BlockSpec,
  known: ReadonlySet<string>,
  issues: string[],
): void {
  if (block.kind === "image") {
    if (block.image.caption !== undefined) reportRefsIn(block.image.caption, `${label}.image.caption`, issues);
    return;
  }
  if (block.kind === "mermaid") {
    if (block.caption !== undefined) reportRefsIn(block.caption, `${label}.mermaid.caption`, issues);
    return;
  }

  const refs: { readonly path: string; readonly text: string }[] = [];
  switch (block.kind) {
    case "paragraph":
      refs.push({ path: `${label}.text`, text: block.text });
      break;
    case "list":
      block.list.items.forEach((item, i) => refs.push({ path: `${label}.list.items[${i}]`, text: item }));
      break;
    case "table":
      block.table.header.forEach((cell, i) => refs.push({ path: `${label}.table.header[${i}]`, text: cell }));
      block.table.rows.forEach((row, ri) =>
        row.forEach((cell, ci) => refs.push({ path: `${label}.table.rows[${ri}][${ci}]`, text: cell })),
      );
      break;
    case "callout": {
      const lines =
        block.callout.lines ??
        (block.callout.text !== undefined ? block.callout.text.split(/\r?\n/) : []);
      lines.forEach((line, i) => refs.push({ path: `${label}.callout.lines[${i}]`, text: line }));
      break;
    }
    case "grid": {
      if (block.grid.image.caption !== undefined) {
        reportRefsIn(block.grid.image.caption, `${label}.grid.image.caption`, issues);
      }
      if (block.grid.blocks !== undefined) {
        block.grid.blocks.forEach((rb, ri) => {
          if (rb.kind === "paragraph") {
            refs.push({ path: `${label}.grid.blocks[${ri}].text`, text: rb.text });
          } else {
            rb.items.forEach((item, ii) =>
              refs.push({ path: `${label}.grid.blocks[${ri}].items[${ii}]`, text: item }),
            );
          }
        });
      } else {
        const paragraphs =
          block.grid.paragraphs ??
          (block.grid.text !== undefined ? block.grid.text.split(/\r?\n/) : []);
        paragraphs.forEach((p, i) => refs.push({ path: `${label}.grid.paragraphs[${i}]`, text: p }));
      }
      break;
    }
  }

  for (const { path, text } of refs) {
    for (const anchorId of collectRefAnchorIds(text)) {
      if (!known.has(anchorId)) {
        issues.push(`${path} references unknown anchorId "${anchorId}"`);
      }
    }
  }
}

function validateAnchorsAndRefs(m: PrdManifest, issues: string[]): void {
  const known = collectKnownAnchorIds(m, issues);
  if (m.preamble !== undefined) {
    m.preamble.forEach((b, bi) => {
      if (REF_FORBIDDEN_KINDS.has(b.kind)) return;
      checkBlockRefs(`preamble.blocks[${bi}]`, b, known, issues);
    });
  }
  m.sections.forEach((s, si) => {
    s.blocks.forEach((b, bi) => {
      checkBlockRefs(`section[${si}].blocks[${bi}]`, b, known, issues);
    });
  });
}
