// Orchestrator: turn a delivery manifest into a Feishu PRD document.
//
// Flow (verified in 11-delivery-gaps-test.md):
//   1. assert the active lark-cli account (by open_id)
//   2. render the manifest to numbered Lark-flavored Markdown
//   3. `docs +create --markdown -` (MCP path; absorbs ≤50 / rate-limit / paging)
//   4. insert media per section, anchored by the section's numbered title
//
// Callouts, left-image-right-text grids, and custom table column widths are not
// expressible here and are applied by separate path-B steps (see plan §3.0).

import { basename, dirname } from "node:path";
import { renderManifestMarkdown } from "./lib/markdown.ts";
import { larkDocs, assertActiveAccount } from "./lib/lark.ts";
import { assertWithinWorkspace, assertMediaFile } from "./lib/guard.ts";
import type { PrdManifest, ImageSpec } from "./lib/manifest.ts";

export interface BuildOptions {
  readonly manifest: PrdManifest;
  /** root used to resolve workspace-relative image paths. */
  readonly workspaceRoot: string;
  /** strict-mode account guard: the open_id the active lark-cli account must be. */
  readonly expectedOpenId: string;
  readonly folderToken?: string;
}

export interface BuildResult {
  readonly doc_id: string;
  readonly doc_url: string;
}

async function insertImage(
  docId: string,
  anchorText: string,
  img: ImageSpec,
  workspaceRoot: string,
): Promise<void> {
  const abs = assertWithinWorkspace(img.path, workspaceRoot);
  assertMediaFile(abs, { kind: "image" });
  const args = [
    "+media-insert",
    "--type",
    "image",
    "--doc",
    docId,
    "--file",
    basename(abs),
    "--selection-with-ellipsis",
    anchorText,
  ];
  if (img.caption !== undefined) args.push("--caption", img.caption);
  if (img.align !== undefined) args.push("--align", img.align);
  if (img.width !== undefined) args.push("--width", String(img.width));
  if (img.height !== undefined) args.push("--height", String(img.height));
  // lark-cli requires --file to be relative to cwd, so run from the file's dir.
  await larkDocs(args, { cwd: dirname(abs) });
}

export async function buildPrd(opts: BuildOptions): Promise<BuildResult> {
  await assertActiveAccount(opts.expectedOpenId);

  const { markdown, numbered } = renderManifestMarkdown(opts.manifest);

  const createArgs = ["+create", "--title", opts.manifest.title, "--markdown", "-"];
  if (opts.folderToken !== undefined) createArgs.push("--folder-token", opts.folderToken);
  const created = (await larkDocs(createArgs, { stdin: markdown })) as BuildResult;

  for (let i = 0; i < opts.manifest.sections.length; i++) {
    const section = opts.manifest.sections[i]!;
    const anchorText = numbered[i]!.numbered;
    for (const b of section.blocks) {
      if (b.kind === "image") {
        await insertImage(created.doc_id, anchorText, b.image, opts.workspaceRoot);
      }
    }
  }

  return created;
}
