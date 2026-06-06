import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMermaidToImages, type MermaidRenderFn } from "./mermaid.ts";
import type { PrdManifest } from "./manifest.ts";

const PNG_STUB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function withWorkspace(fn: (root: string, render: MermaidRenderFn, rendered: string[]) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mermaid-test-"));
  const rendered: string[] = [];
  const render: MermaidRenderFn = async (mmdAbsPath, outPngAbsPath) => {
    rendered.push(mmdAbsPath);
    writeFileSync(outPngAbsPath, PNG_STUB);
  };
  return fn(root, render, rendered).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("resolveMermaidToImages rewrites mermaid to image and leaves other blocks", async () => {
  await withWorkspace(async (root, render, rendered) => {
    writeFileSync(join(root, "diag.mmd"), "flowchart TD\n A --> B");
    const manifest: PrdManifest = {
      title: "T",
      sections: [
        {
          level: 1,
          title: "S",
          anchorKey: "s",
          blocks: [
            { kind: "paragraph", text: "intro" },
            { kind: "mermaid", mermaidPath: "diag.mmd", caption: "流程" },
          ],
        },
      ],
    };
    const out = await resolveMermaidToImages(manifest, root, render);
    assert.equal(rendered.length, 1);
    assert.deepEqual(out.sections[0]!.blocks[0], { kind: "paragraph", text: "intro" });
    assert.deepEqual(out.sections[0]!.blocks[1], { kind: "image", image: { path: "diag.png", caption: "流程" } });
  });
});

test("resolveMermaidToImages omits caption when the mermaid block has none", async () => {
  await withWorkspace(async (root, render) => {
    writeFileSync(join(root, "x.mmd"), "flowchart TD\n A --> B");
    const manifest: PrdManifest = {
      title: "T",
      sections: [{ level: 1, title: "S", anchorKey: "s", blocks: [{ kind: "mermaid", mermaidPath: "x.mmd" }] }],
    };
    const out = await resolveMermaidToImages(manifest, root, render);
    assert.deepEqual(out.sections[0]!.blocks[0], { kind: "image", image: { path: "x.png" } });
  });
});

test("resolveMermaidToImages rejects a mermaid path escaping the workspace", async () => {
  await withWorkspace(async (root, render) => {
    const manifest: PrdManifest = {
      title: "T",
      sections: [{ level: 1, title: "S", anchorKey: "s", blocks: [{ kind: "mermaid", mermaidPath: "../escape.mmd" }] }],
    };
    await assert.rejects(() => resolveMermaidToImages(manifest, root, render));
  });
});
