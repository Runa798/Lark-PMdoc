import test from "node:test";
import assert from "node:assert/strict";
import { renderManifestMarkdown } from "./markdown.ts";
import type { PrdManifest } from "./manifest.ts";

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
