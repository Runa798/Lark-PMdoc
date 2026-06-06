// Mermaid preprocessing: render each mermaid block to a PNG and rewrite it as an
// image block, so buildPrd only ever sees images (Feishu does not render
// mermaid). The actual rendering is INJECTED (MermaidRenderFn) — the engine
// stays portable and carries no host-specific mmdc/ssh details. Callers supply a
// render function for their environment (local mmdc, or a remote renderer).

import { extname } from "node:path";
import { assertWithinWorkspace, assertMediaFile } from "./guard.ts";
import type { BlockSpec, PrdManifest, PrdSection } from "./manifest.ts";

/** Render the mermaid source at `mmdAbsPath` to a PNG at `outPngAbsPath`. */
export type MermaidRenderFn = (mmdAbsPath: string, outPngAbsPath: string) => Promise<void>;

/** Replace a path's extension with `.png` (append if it has none). */
function toPngPath(p: string): string {
  const ext = extname(p);
  return ext === "" ? `${p}.png` : `${p.slice(0, -ext.length)}.png`;
}

async function resolveBlock(block: BlockSpec, workspaceRoot: string, render: MermaidRenderFn): Promise<BlockSpec> {
  if (block.kind !== "mermaid") return block;
  // mermaidPath is validated within the workspace; the PNG lives beside it, so it
  // inherits that containment without a second realpath of a not-yet-created file.
  const mmdAbs = assertWithinWorkspace(block.mermaidPath, workspaceRoot);
  const pngAbs = toPngPath(mmdAbs);
  const pngRel = toPngPath(block.mermaidPath);
  await render(mmdAbs, pngAbs);
  assertMediaFile(pngAbs, { kind: "image" });
  const image = block.caption !== undefined ? { path: pngRel, caption: block.caption } : { path: pngRel };
  return { kind: "image", image };
}

/** Return a copy of `manifest` with every mermaid block rendered and rewritten to an image block. */
export async function resolveMermaidToImages(
  manifest: PrdManifest,
  workspaceRoot: string,
  render: MermaidRenderFn,
): Promise<PrdManifest> {
  const sections: PrdSection[] = [];
  for (const section of manifest.sections) {
    const blocks: BlockSpec[] = [];
    for (const block of section.blocks) {
      blocks.push(await resolveBlock(block, workspaceRoot, render));
    }
    sections.push({ ...section, blocks });
  }
  return { ...manifest, sections };
}
