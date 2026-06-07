import type { PrdManifest } from "./manifest.ts";

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

export function validateManifest(m: PrdManifest): void {
  const issues: string[] = [];
  if (m.title.trim() === "") issues.push("document title must not be empty");

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

  if (issues.length > 0) throw new ManifestValidationError(issues);
}
