// Orchestrator: turn a delivery manifest into a Feishu PRD document.
//
// Flow (verified in 11-delivery-gaps-test.md):
//   1. assert the active lark-cli account (by open_id)
//   2. render the manifest to numbered Lark-flavored Markdown
//   3. `docs +create --markdown -` (MCP path; absorbs ≤50 / rate-limit / paging)
//   4. insert media/path-B blocks per section, anchored by the section's numbered title

import { basename, dirname } from "node:path";
import { renderManifestMarkdown } from "./lib/markdown.ts";
import { LarkError, larkApi, larkDocs, assertActiveAccount } from "./lib/lark.ts";
import { assertWithinWorkspace, assertMediaFile } from "./lib/guard.ts";
import {
  findBlockIdByText,
  insertCallout,
  insertGridLeftImageRightText,
  setTableColumnWidths,
} from "./lib/blocks.ts";
import type { PrdManifest, ImageSpec, PrdSection } from "./lib/manifest.ts";
import { validateManifest } from "./lib/validate.ts";

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isBuildResult(v: unknown): v is BuildResult {
  return (
    isRecord(v) &&
    typeof v.doc_id === "string" &&
    v.doc_id.trim() !== "" &&
    typeof v.doc_url === "string" &&
    v.doc_url.trim() !== ""
  );
}

function requireBuildResult(v: unknown, context: string): BuildResult {
  if (!isBuildResult(v)) {
    throw new LarkError(`${context} did not return doc_id/doc_url`, v);
  }
  return v;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function timestampMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1_000_000_000_000 ? v : v * 1_000;
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const numeric = Number(v);
  if (Number.isFinite(numeric)) return numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function stringValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function fileCreatedMs(f: Record<string, unknown>): number | undefined {
  return timestampMs(f.created_time ?? f.create_time ?? f.created_at);
}

function fileBuildResult(f: Record<string, unknown>): BuildResult | undefined {
  const docId = stringValue(f.doc_id) ?? stringValue(f.token) ?? stringValue(f.file_token);
  const docUrl = stringValue(f.doc_url) ?? stringValue(f.url);
  return docId !== undefined && docUrl !== undefined ? { doc_id: docId, doc_url: docUrl } : undefined;
}

function extractDriveFiles(data: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(data)) return [];
  const files = data.files ?? data.items;
  return Array.isArray(files) ? files.filter(isRecord) : [];
}

interface RecentDriveFile {
  readonly file: Record<string, unknown>;
  readonly createdMs: number;
}

function isRecentDriveFile(v: { readonly file: Record<string, unknown>; readonly createdMs: number | undefined }): v is RecentDriveFile {
  return v.createdMs !== undefined;
}

async function findRecentlyCreatedDoc(title: string, folderToken: string | undefined, createdAfterMs: number): Promise<BuildResult | undefined> {
  const params: Record<string, unknown> = { page_size: 50 };
  if (folderToken !== undefined) params.folder_token = folderToken;
  const data = await larkApi({ method: "GET", path: "/open-apis/drive/v1/files", params });
  const upperBound = Date.now() + 60_000;
  const candidates = extractDriveFiles(data)
    .filter((f) => f.name === title && f.type === "docx")
    .map((f) => ({ file: f, createdMs: fileCreatedMs(f) }))
    .filter(isRecentDriveFile)
    .filter((f) => f.createdMs >= createdAfterMs - 60_000 && f.createdMs <= upperBound)
    .sort((a, b) => b.createdMs - a.createdMs);
  for (const candidate of candidates) {
    const result = fileBuildResult(candidate.file);
    if (result !== undefined) return result;
  }
  return undefined;
}

function isAmbiguousCreateError(e: unknown): e is LarkError {
  return e instanceof LarkError && (e.retryable || e.message.includes("timed out"));
}

async function createResilient(title: string, markdown: string, folderToken: string | undefined): Promise<BuildResult> {
  const args = ["+create", "--title", title, "--markdown", "-"];
  if (folderToken !== undefined) args.push("--folder-token", folderToken);
  const createdAfterMs = Date.now();

  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return requireBuildResult(await larkDocs(args, { stdin: markdown }), "docs +create");
    } catch (e) {
      if (!isAmbiguousCreateError(e)) throw e;
      // EOF and timeout on +create are ambiguous: Feishu may have created the doc while the CLI lost the response.
      const recovered = await findRecentlyCreatedDoc(title, folderToken, createdAfterMs);
      if (recovered !== undefined) return recovered;
      if (attempt === 2) throw e;
      await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 200));
    }
  }

  throw new LarkError("docs +create exhausted retries");
}

const IMPLEMENTED_BLOCK_KINDS = new Set(["paragraph", "list", "table", "callout", "grid", "image"]);

interface TopLevelBlock {
  readonly block_id: string;
  readonly block_type: number;
}

interface BlockLike {
  readonly kind?: unknown;
}

function assertNoUnsupportedBlocks(m: PrdManifest): void {
  const unsupported: string[] = [];
  for (const section of m.sections) {
    for (const block of section.blocks as readonly BlockLike[]) {
      const kind = typeof block.kind === "string" ? block.kind : "<unknown>";
      if (!IMPLEMENTED_BLOCK_KINDS.has(kind)) unsupported.push(`${section.title}: ${kind}`);
    }
  }
  if (unsupported.length > 0) {
    throw new Error(`unsupported manifest block kind(s); refusing to drop content:\n- ${unsupported.join("\n- ")}`);
  }
}

function nextPageToken(data: Record<string, unknown>): string | undefined {
  const token = data.page_token ?? data.next_page_token;
  return typeof token === "string" && token.trim() !== "" ? token : undefined;
}

function isTopLevelChild(v: unknown, docId: string): v is TopLevelBlock {
  return (
    isRecord(v) &&
    v.parent_id === docId &&
    typeof v.block_id === "string" &&
    typeof v.block_type === "number"
  );
}

async function getTopLevelChildren(docId: string): Promise<readonly TopLevelBlock[]> {
  const blocks: TopLevelBlock[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, unknown> = { page_size: 500 };
    if (pageToken !== undefined) params.page_token = pageToken;
    const data = await larkApi({
      method: "GET",
      path: `/open-apis/docx/v1/documents/${docId}/blocks`,
      params,
    });
    if (!isRecord(data) || !Array.isArray(data.items)) {
      throw new LarkError("GET blocks did not return items", data);
    }
    blocks.push(...data.items.filter((item) => isTopLevelChild(item, docId)));
    if (data.has_more === true) {
      pageToken = nextPageToken(data);
      if (pageToken === undefined) throw new LarkError("GET blocks has_more without page_token", data);
    } else {
      pageToken = undefined;
    }
  } while (pageToken !== undefined);
  return blocks;
}

function isHeadingBlockType(blockType: number): boolean {
  return blockType >= 3 && blockType <= 9;
}

function needsPathBProcessing(section: PrdSection): boolean {
  return section.blocks.some(
    (block) =>
      block.kind === "callout" ||
      block.kind === "grid" ||
      (block.kind === "table" && block.table.columnWidths !== undefined),
  );
}

function firstColumnWidths(section: PrdSection): readonly number[] | undefined {
  for (const block of section.blocks) {
    if (block.kind === "table" && block.table.columnWidths !== undefined) return block.table.columnWidths;
  }
  return undefined;
}

async function requireSectionHeadingId(docId: string, anchorText: string): Promise<string> {
  const headingId = await findBlockIdByText(docId, anchorText);
  if (headingId === undefined) throw new Error(`created document is missing section heading "${anchorText}"`);
  return headingId;
}

function requireHeadingIndex(children: readonly TopLevelBlock[], headingId: string, anchorText: string): number {
  const index = children.findIndex((child) => child.block_id === headingId);
  if (index < 0) {
    throw new Error(`section heading "${anchorText}" (${headingId}) is not a top-level block`);
  }
  return index;
}

function firstTableAfterHeading(children: readonly TopLevelBlock[], headingIndex: number): string | undefined {
  for (let i = headingIndex + 1; i < children.length; i++) {
    const child = children[i]!;
    if (isHeadingBlockType(child.block_type)) return undefined;
    if (child.block_type === 31) return child.block_id;
  }
  return undefined;
}

async function applyPathBSectionBlocks(
  docId: string,
  anchorText: string,
  section: PrdSection,
  workspaceRoot: string,
): Promise<void> {
  if (!needsPathBProcessing(section)) return;

  const headingId = await requireSectionHeadingId(docId, anchorText);
  let insertedPathBBlocks = 0;
  for (const block of section.blocks) {
    if (block.kind !== "callout" && block.kind !== "grid") continue;
    const children = await getTopLevelChildren(docId);
    const headingIndex = requireHeadingIndex(children, headingId, anchorText);
    const index = headingIndex + 1 + insertedPathBBlocks;
    if (block.kind === "callout") {
      await insertCallout(docId, docId, index, block.callout);
    } else {
      await insertGridLeftImageRightText(docId, docId, index, block.grid, workspaceRoot);
    }
    insertedPathBBlocks += 1;
  }

  const columnWidths = firstColumnWidths(section);
  if (columnWidths === undefined) return;
  const children = await getTopLevelChildren(docId);
  const headingIndex = requireHeadingIndex(children, headingId, anchorText);
  const tableId = firstTableAfterHeading(children, headingIndex);
  if (tableId === undefined) throw new Error(`created document is missing a table under section "${anchorText}"`);
  await setTableColumnWidths(docId, tableId, columnWidths);
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
  validateManifest(opts.manifest);
  assertNoUnsupportedBlocks(opts.manifest);
  await assertActiveAccount(opts.expectedOpenId);

  const { markdown, numbered } = renderManifestMarkdown(opts.manifest);
  const created = await createResilient(opts.manifest.title, markdown, opts.folderToken);

  for (let i = 0; i < opts.manifest.sections.length; i++) {
    const section = opts.manifest.sections[i]!;
    const anchorText = numbered[i]!.numbered;
    for (const b of section.blocks) {
      if (b.kind === "image") {
        await insertImage(created.doc_id, anchorText, b.image, opts.workspaceRoot);
      }
    }
    await applyPathBSectionBlocks(created.doc_id, anchorText, section, opts.workspaceRoot);
  }

  return created;
}
