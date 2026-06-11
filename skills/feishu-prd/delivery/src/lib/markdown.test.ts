import test from "node:test";
import assert from "node:assert/strict";
import { renderManifestMarkdown } from "./markdown.ts";
import type { PrdManifest } from "./manifest.ts";

test("renderManifestMarkdown strips [[ref:...]] syntax to plain display text in paragraphs", () => {
  const m: PrdManifest = {
    title: "Doc",
    sections: [
      {
        level: 1,
        title: "Body",
        anchorKey: "body",
        anchorId: "body",
        blocks: [{ kind: "paragraph", text: "see [[ref:body|this section]] for context" }],
      },
    ],
  };
  const { markdown } = renderManifestMarkdown(m);
  assert.ok(markdown.includes("see this section for context"), `got:\n${markdown}`);
  assert.ok(!markdown.includes("[[ref:"), "ref syntax must not survive into create-markdown");
});

test("renderManifestMarkdown strips refs inside table cells and escapes display pipes", () => {
  const m: PrdManifest = {
    title: "Doc",
    sections: [
      {
        level: 1,
        title: "Tbl",
        anchorKey: "tbl",
        anchorId: "tbl",
        blocks: [
          {
            kind: "table",
            table: {
              header: ["col"],
              rows: [["link to [[ref:tbl|left | right]]"]],
            },
          },
        ],
      },
    ],
  };
  const { markdown } = renderManifestMarkdown(m);
  assert.ok(markdown.includes("link to left \\| right"), `got:\n${markdown}`);
});

test("renderManifestMarkdown strips refs inside ordered list items", () => {
  const m: PrdManifest = {
    title: "Doc",
    sections: [
      {
        level: 1,
        title: "List",
        anchorKey: "list",
        anchorId: "list",
        blocks: [
          {
            kind: "list",
            list: { style: "ordered", items: ["jump to [[ref:list|here]]"] },
          },
        ],
      },
    ],
  };
  const { markdown } = renderManifestMarkdown(m);
  assert.ok(markdown.includes("1. jump to here"), `got:\n${markdown}`);
});

test("renderManifestMarkdown emits preamble blocks before the first heading", () => {
  const m: PrdManifest = {
    title: "Doc",
    preamble: [
      {
        kind: "table",
        table: {
          header: ["字段", "值"],
          rows: [
            ["产品版本", "v1.0"],
            ["文档版本", "v1.0-rev3"],
          ],
        },
      },
    ],
    sections: [
      {
        level: 1,
        title: "Overview",
        anchorKey: "overview",
        blocks: [{ kind: "paragraph", text: "body" }],
      },
    ],
  };
  const { markdown } = renderManifestMarkdown(m);
  const tableIdx = markdown.indexOf("| 字段 | 值 |");
  const headingIdx = markdown.indexOf("# 一、Overview");
  assert.ok(tableIdx >= 0, `expected preamble table in markdown, got:\n${markdown}`);
  assert.ok(headingIdx >= 0, `expected first heading in markdown, got:\n${markdown}`);
  assert.ok(tableIdx < headingIdx, "preamble table must appear before the first heading");
});
