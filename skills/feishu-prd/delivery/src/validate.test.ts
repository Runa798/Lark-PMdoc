import test from "node:test";
import assert from "node:assert/strict";
import type { PrdManifest } from "./lib/manifest.ts";
import { ManifestValidationError, validateManifest } from "./lib/validate.ts";

const validManifest: PrdManifest = {
  title: "PRD",
  sections: [
    {
      level: 1,
      title: "Overview",
      anchorKey: "overview",
      blocks: [{ kind: "paragraph", text: "body" }],
    },
  ],
};

function expectInvalid(m: PrdManifest, pattern: RegExp): void {
  assert.throws(() => validateManifest(m), (e: unknown) => {
    assert.ok(e instanceof ManifestValidationError);
    assert.match(e.message, pattern);
    return true;
  });
}

test("validateManifest accepts a valid manifest", () => {
  assert.doesNotThrow(() => validateManifest(validManifest));
});

test("validateManifest rejects an empty document title", () => {
  expectInvalid({ ...validManifest, title: " " }, /document title must not be empty/);
});

test("validateManifest rejects an empty section title", () => {
  expectInvalid(
    {
      ...validManifest,
      sections: [{ ...validManifest.sections[0]!, title: "" }],
    },
    /section\[0\] title must not be empty/,
  );
});

test("validateManifest rejects levels outside 1..5", () => {
  const manifest = {
    ...validManifest,
    sections: [{ ...validManifest.sections[0]!, level: 6 }],
  } as unknown as PrdManifest;
  expectInvalid(manifest, /level must be an integer from 1 to 5/);
});

test("validateManifest rejects table rows with the wrong column count", () => {
  expectInvalid(
    {
      ...validManifest,
      sections: [
        {
          ...validManifest.sections[0]!,
          blocks: [{ kind: "table", table: { header: ["A", "B"], rows: [["1"]] } }],
        },
      ],
    },
    /has 1 columns but header has 2/,
  );
});

test("validateManifest rejects non-positive-integer image dimensions", () => {
  expectInvalid(
    {
      ...validManifest,
      sections: [
        {
          ...validManifest.sections[0]!,
          blocks: [{ kind: "image", image: { path: "a.png", width: -1, height: -2 } }],
        },
      ],
    },
    /image\.width must be a positive integer/,
  );
});

test("validateManifest rejects sections without blocks", () => {
  expectInvalid(
    {
      ...validManifest,
      sections: [{ ...validManifest.sections[0]!, blocks: [] }],
    },
    /must contain at least one block/,
  );
});

test("validateManifest rejects grid blocks with legacy text", () => {
  expectInvalid(
    {
      ...validManifest,
      sections: [
        {
          ...validManifest.sections[0]!,
          blocks: [
            {
              kind: "grid",
              grid: {
                image: { path: "a.png" },
                text: "legacy",
                blocks: [{ kind: "paragraph", text: "rich" }],
              },
            },
          ],
        },
      ],
    },
    /grid must use only one of text, paragraphs, or blocks/,
  );
});

test("validateManifest rejects empty grid blocks", () => {
  expectInvalid(
    {
      ...validManifest,
      sections: [
        {
          ...validManifest.sections[0]!,
          blocks: [{ kind: "grid", grid: { image: { path: "a.png" }, blocks: [] } }],
        },
      ],
    },
    /grid\.blocks must not be empty/,
  );
});

test("validateManifest accepts consecutive level increases of 1", () => {
  // L1 -> L2 -> L3 is a valid progressive hierarchy
  const manifest: PrdManifest = {
    title: "PRD",
    sections: [
      { level: 1, title: "Chapter", anchorKey: "ch", blocks: [{ kind: "paragraph", text: "x" }] },
      { level: 2, title: "Section", anchorKey: "sec", blocks: [{ kind: "paragraph", text: "x" }] },
      { level: 3, title: "Subsection", anchorKey: "sub", blocks: [{ kind: "paragraph", text: "x" }] },
    ],
  };
  assert.doesNotThrow(() => validateManifest(manifest));
});

test("validateManifest rejects heading level jump (L1 -> L3 skipping L2)", () => {
  const manifest: PrdManifest = {
    title: "PRD",
    sections: [
      { level: 1, title: "Chapter", anchorKey: "ch", blocks: [{ kind: "paragraph", text: "x" }] },
      { level: 3, title: "Subsection", anchorKey: "sub", blocks: [{ kind: "paragraph", text: "x" }] },
    ],
  };
  expectInvalid(manifest, /heading level jump.*L1 -> L3/);
});

test("validateManifest rejects grid blocks in preamble", () => {
  expectInvalid(
    {
      ...validManifest,
      preamble: [
        {
          kind: "grid",
          grid: {
            image: { path: "a.png" },
            blocks: [{ kind: "paragraph", text: "right" }],
          },
        },
      ],
    },
    /preamble\.blocks\[0\] kind "grid" is not allowed in preamble/,
  );
});

test("validateManifest rejects grid list items with line breaks", () => {
  expectInvalid(
    {
      ...validManifest,
      sections: [
        {
          ...validManifest.sections[0]!,
          blocks: [
            {
              kind: "grid",
              grid: {
                image: { path: "a.png" },
                blocks: [{ kind: "list", style: "unordered", items: ["one\ntwo"] }],
              },
            },
          ],
        },
      ],
    },
    /items\[0\] must not contain line breaks/,
  );
});
