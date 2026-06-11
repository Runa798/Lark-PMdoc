import test from "node:test";
import assert from "node:assert/strict";
import { planSectionPatchesForTest } from "./ref-pass.ts";
import type { PrdSection } from "./manifest.ts";

const url = encodeURIComponent("https://example.test/docx/D#H100");
const resolver = (id: string): string | undefined =>
  id === "target" ? "https://example.test/docx/D#H100" : undefined;

test("planSectionPatches disambiguates same-text paragraphs by manifest order", () => {
  // Two paragraphs share the same stripped text "note" but only the second
  // one carries a ref; the planner must locate the second matching doc block.
  const section: PrdSection = {
    level: 1,
    title: "Notes",
    anchorKey: "notes",
    blocks: [
      { kind: "paragraph", text: "note" },
      { kind: "paragraph", text: "note" },
      { kind: "paragraph", text: "note [[ref:target|jump]]" },
    ],
  };
  const targets = planSectionPatchesForTest(
    section,
    "h1",
    [
      { block_id: "h1", block_type: 3, parent_id: "doc" },
      { block_id: "p1", block_type: 2, parent_id: "doc", text: "note" },
      { block_id: "p2", block_type: 2, parent_id: "doc", text: "note" },
      { block_id: "p3", block_type: 2, parent_id: "doc", text: "note jump" },
    ],
    resolver,
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.blockId, "p3");
  assert.deepEqual(targets[0]!.elements, [
    { text_run: { content: "note ", text_element_style: {} } },
    { text_run: { content: "jump", text_element_style: { link: { url } } } },
  ]);
});

test("planSectionPatches stops the section window at the next equal-level heading", () => {
  // A "note" in the NEXT section must not be picked up as a candidate.
  const section: PrdSection = {
    level: 1,
    title: "First",
    anchorKey: "first",
    blocks: [{ kind: "paragraph", text: "note [[ref:target|jump]]" }],
  };
  const targets = planSectionPatchesForTest(
    section,
    "h1",
    [
      { block_id: "h1", block_type: 3, parent_id: "doc" },
      { block_id: "p1", block_type: 2, parent_id: "doc", text: "note jump" },
      { block_id: "h2", block_type: 3, parent_id: "doc" },
      { block_id: "p2", block_type: 2, parent_id: "doc", text: "note jump" },
    ],
    resolver,
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.blockId, "p1");
});

test("planSectionPatches locates table cell text blocks via the table descendant chain", () => {
  const section: PrdSection = {
    level: 1,
    title: "T",
    anchorKey: "t",
    blocks: [
      {
        kind: "table",
        table: {
          header: ["A", "B"],
          rows: [["see [[ref:target|here]]", "right"]],
        },
      },
    ],
  };
  const targets = planSectionPatchesForTest(
    section,
    "h1",
    [
      { block_id: "h1", block_type: 3, parent_id: "doc" },
      { block_id: "tbl", block_type: 31, parent_id: "doc", children: ["row1"] },
    ],
    resolver,
    [
      { block_id: "row1", block_type: 32, parent_id: "tbl", children: ["c1", "c2", "c3", "c4"] },
      { block_id: "c1", block_type: 33, parent_id: "row1", children: ["c1t"] },
      { block_id: "c1t", block_type: 2, parent_id: "c1", text: "A" },
      { block_id: "c2", block_type: 33, parent_id: "row1", children: ["c2t"] },
      { block_id: "c2t", block_type: 2, parent_id: "c2", text: "B" },
      { block_id: "c3", block_type: 33, parent_id: "row1", children: ["c3t"] },
      { block_id: "c3t", block_type: 2, parent_id: "c3", text: "see here" },
      { block_id: "c4", block_type: 33, parent_id: "row1", children: ["c4t"] },
      { block_id: "c4t", block_type: 2, parent_id: "c4", text: "right" },
    ],
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.blockId, "c3t");
});

test("planSectionPatches raises when no doc block matches a referenced paragraph", () => {
  const section: PrdSection = {
    level: 1,
    title: "S",
    anchorKey: "s",
    blocks: [{ kind: "paragraph", text: "absent [[ref:target|x]]" }],
  };
  assert.throws(() =>
    planSectionPatchesForTest(
      section,
      "h1",
      [
        { block_id: "h1", block_type: 3, parent_id: "doc" },
        { block_id: "p1", block_type: 2, parent_id: "doc", text: "different content" },
      ],
      resolver,
    ),
  );
});
