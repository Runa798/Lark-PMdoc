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

test("validateManifest rejects negative image dimensions", () => {
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
    /image\.width must not be negative/,
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
