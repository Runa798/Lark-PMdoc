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
        b.table.rows.forEach((row, ri) => {
          if (row.length !== b.table.header.length) {
            issues.push(`${blockLabel}.rows[${ri}] has ${row.length} columns but header has ${b.table.header.length}`);
          }
        });
      }
      if (b.kind === "image") {
        if (b.image.width !== undefined && b.image.width < 0) issues.push(`${blockLabel}.image.width must not be negative`);
        if (b.image.height !== undefined && b.image.height < 0) issues.push(`${blockLabel}.image.height must not be negative`);
      }
    });
  });

  if (issues.length > 0) throw new ManifestValidationError(issues);
}
