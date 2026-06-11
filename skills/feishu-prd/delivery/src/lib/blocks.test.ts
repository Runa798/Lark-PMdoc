import test from "node:test";
import assert from "node:assert/strict";
import { buildCalloutChildren, buildGridDescendants, parseInlineBold, parseInlineRich } from "./blocks.ts";

test("buildCalloutChildren builds a colored callout with text descendants", () => {
  assert.deepEqual(buildCalloutChildren({ lines: ["A", "B"], backgroundColor: 2, borderColor: 5 }), [
    {
      block_id: "tmp_callout",
      block_type: 19,
      callout: {
        background_color: 2,
        border_color: 5,
      },
      children: ["tmp_callout_text_0", "tmp_callout_text_1"],
    },
    {
      block_id: "tmp_callout_text_0",
      block_type: 2,
      text: {
        elements: [
          {
            text_run: {
              content: "A",
              text_element_style: {},
            },
          },
        ],
      },
    },
    {
      block_id: "tmp_callout_text_1",
      block_type: 2,
      text: {
        elements: [
          {
            text_run: {
              content: "B",
              text_element_style: {},
            },
          },
        ],
      },
    },
  ]);
});

test("buildCalloutChildren defaults colors and splits text lines", () => {
  const blocks = buildCalloutChildren({ text: "one\ntwo" });
  assert.deepEqual(blocks[0], {
    block_id: "tmp_callout",
    block_type: 19,
    callout: {
      background_color: 1,
      border_color: 4,
    },
    children: ["tmp_callout_text_0", "tmp_callout_text_1"],
  });
  assert.deepEqual(
    blocks.slice(1).map((block) => JSON.stringify(block)),
    [
      JSON.stringify({
        block_id: "tmp_callout_text_0",
        block_type: 2,
        text: { elements: [{ text_run: { content: "one", text_element_style: {} } }] },
      }),
      JSON.stringify({
        block_id: "tmp_callout_text_1",
        block_type: 2,
        text: { elements: [{ text_run: { content: "two", text_element_style: {} } }] },
      }),
    ],
  );
});

test("buildGridDescendants builds a left-image right-text grid with default width ratios", () => {
  assert.deepEqual(
    buildGridDescendants({
      image: { path: "image.png", width: 120 },
      text: "Right side",
    }),
    [
      {
        block_id: "tmp_grid",
        block_type: 24,
        grid: { column_size: 2 },
        children: ["tmp_grid_left_column", "tmp_grid_right_column"],
      },
      {
        block_id: "tmp_grid_left_column",
        block_type: 25,
        grid_column: { width_ratio: 40 },
        children: ["tmp_grid_image"],
      },
      {
        block_id: "tmp_grid_image",
        block_type: 27,
        image: {},
      },
      {
        block_id: "tmp_grid_right_column",
        block_type: 25,
        grid_column: { width_ratio: 60 },
        children: ["tmp_grid_right_column_text_0"],
      },
      {
        block_id: "tmp_grid_right_column_text_0",
        block_type: 2,
        text: {
          elements: [
            {
              text_run: {
                content: "Right side",
                text_element_style: {},
              },
            },
          ],
        },
      },
    ],
  );
});

test("buildGridDescendants supports custom ratios and multiple right paragraphs", () => {
  const blocks = buildGridDescendants({
    image: { path: "image.png" },
    paragraphs: ["P1", "P2"],
    widthRatios: [35, 65],
  });

  assert.deepEqual(blocks[1], {
    block_id: "tmp_grid_left_column",
    block_type: 25,
    grid_column: { width_ratio: 35 },
    children: ["tmp_grid_image"],
  });
  assert.deepEqual(blocks[3], {
    block_id: "tmp_grid_right_column",
    block_type: 25,
    grid_column: { width_ratio: 65 },
    children: ["tmp_grid_right_column_text_0", "tmp_grid_right_column_text_1"],
  });
});

test("buildGridDescendants renders grid paragraph blocks with inline bold runs", () => {
  const blocks = buildGridDescendants({
    image: { path: "image.png" },
    blocks: [{ kind: "paragraph", text: "Before **bold** after" }],
  });

  assert.deepEqual(blocks[4], {
    block_id: "tmp_grid_right_column_block_0",
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content: "Before ",
            text_element_style: {},
          },
        },
        {
          text_run: {
            content: "bold",
            text_element_style: { bold: true },
          },
        },
        {
          text_run: {
            content: " after",
            text_element_style: {},
          },
        },
      ],
    },
  });
});

test("buildGridDescendants renders unordered grid list items as bullet blocks", () => {
  const blocks = buildGridDescendants({
    image: { path: "image.png" },
    blocks: [{ kind: "list", style: "unordered", items: ["Item"] }],
  });

  assert.deepEqual(blocks[4], {
    block_id: "tmp_grid_right_column_block_0",
    block_type: 12,
    bullet: {
      elements: [
        {
          text_run: {
            content: "Item",
            text_element_style: {},
          },
        },
      ],
    },
  });
});

test("buildGridDescendants renders ordered grid list items with explicit sequence", () => {
  const blocks = buildGridDescendants({
    image: { path: "image.png" },
    blocks: [{ kind: "list", style: "ordered", items: ["First", "Second"] }],
  });

  assert.deepEqual(blocks[4], {
    block_id: "tmp_grid_right_column_block_0",
    block_type: 13,
    ordered: {
      elements: [
        {
          text_run: {
            content: "First",
            text_element_style: {},
          },
        },
      ],
      style: { sequence: "1" },
    },
  });
  assert.deepEqual(blocks[5], {
    block_id: "tmp_grid_right_column_block_1",
    block_type: 13,
    ordered: {
      elements: [
        {
          text_run: {
            content: "Second",
            text_element_style: {},
          },
        },
      ],
      style: { sequence: "auto" },
    },
  });
});

test("buildGridDescendants keeps mixed grid block children ordered with unique ids", () => {
  const blocks = buildGridDescendants({
    image: { path: "image.png" },
    blocks: [
      { kind: "paragraph", text: "Intro" },
      { kind: "list", style: "unordered", items: ["One", "Two"] },
    ],
  });

  const ids = blocks.slice(4).map((block) => block.block_id);
  assert.deepEqual(blocks[3], {
    block_id: "tmp_grid_right_column",
    block_type: 25,
    grid_column: { width_ratio: 60 },
    children: ["tmp_grid_right_column_block_0", "tmp_grid_right_column_block_1", "tmp_grid_right_column_block_2"],
  });
  assert.deepEqual(ids, ["tmp_grid_right_column_block_0", "tmp_grid_right_column_block_1", "tmp_grid_right_column_block_2"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("parseInlineBold degrades [[ref:...]] syntax to its plain display text", () => {
  // The markdown create pass uses parseInlineBold; refs cannot become links
  // until the heading map exists in pass-2.
  assert.deepEqual(parseInlineBold("see [[ref:a|that bit]] now"), [
    {
      text_run: {
        content: "see that bit now",
        text_element_style: {},
      },
    },
  ]);
});

test("parseInlineRich emits a link run for a resolved ref and keeps surrounding text styles", () => {
  const elements = parseInlineRich("before [[ref:a|jump]] after", (id) =>
    id === "a" ? "https://example.test/docx/D#H1" : undefined,
  );
  assert.deepEqual(elements, [
    { text_run: { content: "before ", text_element_style: {} } },
    {
      text_run: {
        content: "jump",
        text_element_style: { link: { url: encodeURIComponent("https://example.test/docx/D#H1") } },
      },
    },
    { text_run: { content: " after", text_element_style: {} } },
  ]);
});

test("parseInlineRich preserves bold styling around and inside a ref", () => {
  const elements = parseInlineRich("**lead** plus [[ref:a|tail **bold tail**]] end", (id) =>
    id === "a" ? "https://example.test/docx/D#H2" : undefined,
  );
  const expectedUrl = encodeURIComponent("https://example.test/docx/D#H2");
  assert.deepEqual(elements, [
    { text_run: { content: "lead", text_element_style: { bold: true } } },
    { text_run: { content: " plus ", text_element_style: {} } },
    { text_run: { content: "tail ", text_element_style: { link: { url: expectedUrl } } } },
    {
      text_run: {
        content: "bold tail",
        text_element_style: { bold: true, link: { url: expectedUrl } },
      },
    },
    { text_run: { content: " end", text_element_style: {} } },
  ]);
});

test("parseInlineRich degrades an unresolved ref to plain text without raising", () => {
  const elements = parseInlineRich("a [[ref:missing|x]] b", () => undefined);
  assert.deepEqual(elements, [{ text_run: { content: "a x b", text_element_style: {} } }]);
});

test("buildCalloutChildren bakes a link run into the callout text when the resolver supplies a URL", () => {
  const blocks = buildCalloutChildren(
    { lines: ["see [[ref:a|here]] for context"] },
    (id) => (id === "a" ? "https://example.test/docx/D#H3" : undefined),
  );
  const url = encodeURIComponent("https://example.test/docx/D#H3");
  assert.deepEqual(blocks[1], {
    block_id: "tmp_callout_text_0",
    block_type: 2,
    text: {
      elements: [
        { text_run: { content: "see ", text_element_style: {} } },
        { text_run: { content: "here", text_element_style: { link: { url } } } },
        { text_run: { content: " for context", text_element_style: {} } },
      ],
    },
  });
});

test("buildGridDescendants bakes link runs into a grid right-column list when refs resolve", () => {
  const blocks = buildGridDescendants(
    {
      image: { path: "image.png" },
      blocks: [{ kind: "list", style: "unordered", items: ["jump [[ref:a|there]]"] }],
    },
    (id) => (id === "a" ? "https://example.test/docx/D#H4" : undefined),
  );
  const url = encodeURIComponent("https://example.test/docx/D#H4");
  assert.deepEqual(blocks[4], {
    block_id: "tmp_grid_right_column_block_0",
    block_type: 12,
    bullet: {
      elements: [
        { text_run: { content: "jump ", text_element_style: {} } },
        { text_run: { content: "there", text_element_style: { link: { url } } } },
      ],
    },
  });
});
