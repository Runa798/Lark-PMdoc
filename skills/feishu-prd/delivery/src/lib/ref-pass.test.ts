import test from "node:test";
import assert from "node:assert/strict";
import { buildAnchorUrlMapForDoc, planSectionPatchesForTest } from "./ref-pass.ts";
import type { PrdManifest, PrdSection } from "./manifest.ts";

const url = "https://example.test/docx/D#H100";
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

// --- buildAnchorUrlMapForDoc materialization-wait tests ---------------------
//
// The polling loop is injected with `sleep` + `fetchBlocks` so the tests can
// drive it without real timers or HTTP. The mock fetch returns a different
// snapshot each call to simulate Feishu's async block materialization.

interface RawDocBlock {
  readonly block_id: string;
  readonly block_type: number;
  readonly parent_id: string;
  readonly children?: readonly string[];
  readonly raw: Record<string, unknown>;
}

function headingBlock(id: string, title: string, docId: string): RawDocBlock {
  return {
    block_id: id,
    block_type: 3,
    parent_id: docId,
    raw: {
      block_id: id,
      block_type: 3,
      parent_id: docId,
      heading1: {
        elements: [{ text_run: { content: title, text_element_style: {} } }],
      },
    },
  };
}

function paragraphBlock(id: string, text: string, docId: string): RawDocBlock {
  return {
    block_id: id,
    block_type: 2,
    parent_id: docId,
    raw: {
      block_id: id,
      block_type: 2,
      parent_id: docId,
      text: { elements: [{ text_run: { content: text, text_element_style: {} } }] },
    },
  };
}

function manifestWithTwoAnchoredSections(): PrdManifest {
  return {
    title: "T",
    sections: [
      { level: 1, title: "First", anchorKey: "first", anchorId: "a1", blocks: [] },
      { level: 1, title: "Second", anchorKey: "second", anchorId: "a2", blocks: [] },
    ],
  };
}

test("buildAnchorUrlMapForDoc polls until heading count covers manifest and total is stable", async () => {
  const docId = "DOC";
  const docUrl = "https://example.test/docx/DOC";
  const manifest = manifestWithTwoAnchoredSections();
  const numberedTitles = ["1 First", "2 Second"];

  // Snapshots simulate the async materialization:
  //   call 1: only 1/2 headings present  -> wait
  //   call 2: both headings present but a fresh paragraph also appeared,
  //           so the total count is still growing -> wait
  //   call 3: same total as call 2 -> ready
  const callOne: RawDocBlock[] = [headingBlock("H1", "1 First", docId)];
  const callTwo: RawDocBlock[] = [
    headingBlock("H1", "1 First", docId),
    headingBlock("H2", "2 Second", docId),
    paragraphBlock("P1", "body", docId),
  ];
  const callThree: RawDocBlock[] = [...callTwo];
  const snapshots = [callOne, callTwo, callThree];

  let fetchCalls = 0;
  const sleeps: number[] = [];

  const result = await buildAnchorUrlMapForDoc(manifest, { doc_id: docId, doc_url: docUrl }, numberedTitles, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchBlocks: async (id) => {
      assert.equal(id, docId);
      const snap = snapshots[Math.min(fetchCalls, snapshots.length - 1)]!;
      fetchCalls += 1;
      return snap;
    },
    intervalMs: 10_000,
    maxAttempts: 30,
  });

  assert.equal(fetchCalls, 3, "should poll three times until stable");
  assert.equal(sleeps.length, 2, "should sleep between polls but not after success");
  assert.deepEqual(sleeps, [10_000, 10_000]);
  assert.equal(result.size, 2);
  assert.equal(result.get("a1"), `${docUrl}#H1`);
  assert.equal(result.get("a2"), `${docUrl}#H2`);
});

test("buildAnchorUrlMapForDoc throws with diagnostic when materialization never completes", async () => {
  const docId = "DOC";
  const docUrl = "https://example.test/docx/DOC";
  const manifest = manifestWithTwoAnchoredSections();
  const numberedTitles = ["1 First", "2 Second"];

  // Always incomplete: only one heading ever materializes.
  const incomplete: RawDocBlock[] = [headingBlock("H1", "1 First", docId)];
  let fetchCalls = 0;
  let sleepCalls = 0;

  await assert.rejects(
    () =>
      buildAnchorUrlMapForDoc(manifest, { doc_id: docId, doc_url: docUrl }, numberedTitles, {
        sleep: async () => {
          sleepCalls += 1;
        },
        fetchBlocks: async () => {
          fetchCalls += 1;
          return incomplete;
        },
        intervalMs: 10_000,
        maxAttempts: 3,
      }),
    (err: Error) => {
      assert.match(err.message, /doc materialization did not stabilize/);
      assert.match(err.message, /expected 2 headings, saw 1/);
      assert.match(err.message, /after 20 s/);
      return true;
    },
  );

  assert.equal(fetchCalls, 3, "should exhaust all attempts");
  assert.equal(sleepCalls, 2, "should sleep between attempts but not after the last one");
});

test("buildAnchorUrlMapForDoc returns empty map without polling when no anchored sections", async () => {
  const manifest: PrdManifest = {
    title: "T",
    sections: [{ level: 1, title: "First", anchorKey: "first", blocks: [] }],
  };
  let fetchCalls = 0;
  const result = await buildAnchorUrlMapForDoc(
    manifest,
    { doc_id: "DOC", doc_url: "https://example.test/docx/DOC" },
    ["1 First"],
    {
      sleep: async () => {},
      fetchBlocks: async () => {
        fetchCalls += 1;
        return [];
      },
    },
  );
  assert.equal(result.size, 0);
  assert.equal(fetchCalls, 0, "should short-circuit before any fetch");
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

test("planSectionPatches matches list items with bold against doc text without asterisks", () => {
  // The markdown importer turns `**T5**` into a bold run inside the doc; the
  // doc's plain text contains no asterisks. Manifest text DOES contain `**`,
  // so the locator must normalize past it before equality matching.
  const section: PrdSection = {
    level: 1,
    title: "Items",
    anchorKey: "items",
    blocks: [
      {
        kind: "list",
        list: {
          style: "unordered",
          items: ["**T5 large screen (landscape)**: see [[ref:target|note]] for details"],
        },
      },
    ],
  };
  const targets = planSectionPatchesForTest(
    section,
    "h1",
    [
      { block_id: "h1", block_type: 3, parent_id: "doc" },
      {
        block_id: "li1",
        block_type: 12,
        parent_id: "doc",
        // doc plain text: no asterisks, ref rendered as display text "note"
        text: "T5 large screen (landscape): see note for details",
      },
    ],
    resolver,
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.blockId, "li1");
  // Bold span and link span both present in the rebuilt elements.
  const contents = targets[0]!.elements.map((e) => e.text_run.content);
  assert.deepEqual(contents, [
    "T5 large screen (landscape)",
    ": see ",
    "note",
    " for details",
  ]);
  const styles = targets[0]!.elements.map((e) => e.text_run.text_element_style);
  assert.equal(styles[0]!.bold, true);
  assert.equal(styles[2]!.link?.url, url);
});

test("planSectionPatches matches table cells with bold against doc text without asterisks", () => {
  const section: PrdSection = {
    level: 1,
    title: "T",
    anchorKey: "t",
    blocks: [
      {
        kind: "table",
        table: {
          header: ["A", "B"],
          rows: [["**Bold heading**", "see [[ref:target|here]]"]],
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
      // doc cell: no asterisks (bold became styling)
      { block_id: "c3t", block_type: 2, parent_id: "c3", text: "Bold heading" },
      { block_id: "c4", block_type: 33, parent_id: "row1", children: ["c4t"] },
      { block_id: "c4t", block_type: 2, parent_id: "c4", text: "see here" },
    ],
  );
  // Only the ref-bearing cell (c4) is patched; the bold-only cell is skipped
  // (no ref) but must still match for the table-shape sanity check to pass.
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.blockId, "c4t");
});

test("planSectionPatches preserves an unpaired single * in matched paragraph text", () => {
  // Literal `c-*` style tokens must NOT be stripped: only paired ** counts as
  // bold. The matcher and the elements rebuilder both have to honor this.
  const section: PrdSection = {
    level: 1,
    title: "S",
    anchorKey: "s",
    blocks: [
      { kind: "paragraph", text: "token c-* and [[ref:target|jump]]" },
    ],
  };
  const targets = planSectionPatchesForTest(
    section,
    "h1",
    [
      { block_id: "h1", block_type: 3, parent_id: "doc" },
      // Doc plain text retains the literal single `*` since it was never paired.
      { block_id: "p1", block_type: 2, parent_id: "doc", text: "token c-* and jump" },
    ],
    resolver,
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.blockId, "p1");
});

test("planSectionPatches raises when a ref-bearing paragraph contains an unsupported backtick mark", () => {
  // Refs combined with inline-code backticks are not in the corpus today; the
  // elements rebuilder cannot model them, so the guard refuses loudly instead
  // of writing back a literal backtick that would drift from the rendered form.
  const section: PrdSection = {
    level: 1,
    title: "S",
    anchorKey: "s",
    blocks: [
      { kind: "paragraph", text: "see `code` [[ref:target|here]]" },
    ],
  };
  assert.throws(
    () =>
      planSectionPatchesForTest(
        section,
        "h1",
        [
          { block_id: "h1", block_type: 3, parent_id: "doc" },
          // Doc plain text after markdown import: backticks stripped, ref as display text.
          { block_id: "p1", block_type: 2, parent_id: "doc", text: "see code here" },
        ],
        resolver,
      ),
    /refusing to rebuild elements/,
  );
});
