import type { PrdManifest } from "./manifest.ts";

export class ManifestValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid PRD manifest:\n- ${issues.join("\n- ")}`);
    this.name = "ManifestValidationError";
    this.issues = issues;
  }
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
        if (b.image.width !== undefined && b.image.width < 0) issues.push(`${blockLabel}.image.width must not be negative`);
        if (b.image.height !== undefined && b.image.height < 0) issues.push(`${blockLabel}.image.height must not be negative`);
      }
      if (b.kind === "grid") {
        const paragraphs = b.grid.paragraphs ?? (b.grid.text !== undefined ? b.grid.text.split(/\r?\n/) : []);
        if (b.grid.text !== undefined && b.grid.paragraphs !== undefined) {
          issues.push(`${blockLabel}.grid must use either text or paragraphs, not both`);
        }
        if (paragraphs.every((paragraph) => paragraph.trim() === "")) issues.push(`${blockLabel}.grid must contain right-column text`);
        if (b.grid.image.width !== undefined && b.grid.image.width < 0) issues.push(`${blockLabel}.grid.image.width must not be negative`);
        if (b.grid.image.height !== undefined && b.grid.image.height < 0) issues.push(`${blockLabel}.grid.image.height must not be negative`);
        if (b.grid.widthRatios !== undefined) {
          const [left, right] = b.grid.widthRatios;
          if (!Number.isFinite(left) || left <= 0) issues.push(`${blockLabel}.grid.widthRatios[0] must be a positive number`);
          if (!Number.isFinite(right) || right <= 0) issues.push(`${blockLabel}.grid.widthRatios[1] must be a positive number`);
          if (left + right !== 100) issues.push(`${blockLabel}.grid.widthRatios must sum to 100`);
        }
      }
    });
  });

  if (issues.length > 0) throw new ManifestValidationError(issues);
}
