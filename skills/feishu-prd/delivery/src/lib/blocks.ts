import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { assertMediaFile, assertWithinWorkspace } from "./guard.ts";
import { LarkError, larkApi, runLark } from "./lark.ts";
import type { CalloutSpec, GridSpec, ImageSpec } from "./manifest.ts";
import { parseInlineRefs } from "./refs.ts";
import { withRetry } from "./retry.ts";

export type DocxBlockBody = Record<string, unknown>;

type TemporaryBlockBody = DocxBlockBody & { readonly block_id: string };
type RichTextKey = "text" | "bullet" | "ordered";
type OrderedSequence = "1" | "auto";

interface LinkStyle {
  readonly url: string;
}

interface TextElementStyle {
  readonly bold?: true;
  readonly inline_code?: true;
  readonly link?: LinkStyle;
}

export interface TextRunElement {
  readonly text_run: {
    readonly content: string;
    readonly text_element_style: TextElementStyle;
  };
}

/**
 * Resolves a manifest `[[ref:anchorId|...]]` to a clickable docx URL. Returning
 * `undefined` means the ref cannot be resolved yet (e.g. during the markdown
 * create pass when heading block_ids do not yet exist) — callers in that phase
 * must use `parseInlineBold` so refs are degraded to plain text.
 */
export type RefResolver = (anchorId: string) => string | undefined;

const DEFAULT_CALLOUT_BACKGROUND = 1;
const DEFAULT_CALLOUT_BORDER = 4;
const DEFAULT_GRID_WIDTH_RATIOS = [40, 60] as const;

const TEMP_CALLOUT_ID = "tmp_callout";
const TEMP_GRID_ID = "tmp_grid";
const TEMP_GRID_LEFT_COLUMN_ID = "tmp_grid_left_column";
const TEMP_GRID_RIGHT_COLUMN_ID = "tmp_grid_right_column";
const TEMP_GRID_IMAGE_ID = "tmp_grid_image";

export interface InsertGridResult {
  readonly gridId: string;
  readonly imageBlockId: string;
  readonly fileToken: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

interface InlineStyle {
  readonly bold: boolean;
  readonly inlineCode: boolean;
  readonly linkUrl?: string;
}

function styleEquals(a: InlineStyle, b: InlineStyle): boolean {
  return a.bold === b.bold && a.inlineCode === b.inlineCode && a.linkUrl === b.linkUrl;
}

function makeRun(content: string, style: InlineStyle): TextRunElement {
  const elementStyle: { bold?: true; inline_code?: true; link?: LinkStyle } = {};
  if (style.bold) elementStyle.bold = true;
  if (style.inlineCode) elementStyle.inline_code = true;
  if (style.linkUrl !== undefined) {
    // The docx server stores the URL verbatim (PATCH update_text_elements does
    // not percent-decode it on read), and the raw URL is the form verified to
    // navigate when clicked — percent-encoding the whole URL is stored as-is
    // and breaks in-document anchor jumps because the encoded form is treated
    // as a relative path.
    elementStyle.link = { url: style.linkUrl };
  }
  return {
    text_run: {
      content,
      text_element_style: elementStyle,
    },
  };
}

function pushRun(elements: TextRunElement[], content: string, style: InlineStyle): void {
  if (content === "") return;
  const previous = elements[elements.length - 1];
  if (previous !== undefined) {
    const previousStyle: InlineStyle = {
      bold: previous.text_run.text_element_style.bold === true,
      inlineCode: previous.text_run.text_element_style.inline_code === true,
      linkUrl: previous.text_run.text_element_style.link?.url,
    };
    // Coalesce same-style adjacent runs. Both sides are raw URLs (makeRun
    // stores the URL verbatim), so the comparison is consistent.
    if (styleEquals(previousStyle, style)) {
      elements[elements.length - 1] = makeRun(`${previous.text_run.content}${content}`, style);
      return;
    }
  }
  elements.push(makeRun(content, style));
}

/**
 * Parse a single text segment that contains no `[[ref:...]]` syntax, emitting
 * runs that respect paired `**bold**` and paired `` `inline code` ``. The two
 * marks may nest in either direction (`` **`x`** `` and `` `**x**` `` both
 * produce a single run with bold+inline_code). Unpaired `**` or `` ` `` are
 * emitted literally — the docx markdown importer treats unpaired marks as
 * literal characters too, so the rebuilt run text stays aligned with what the
 * doc actually renders.
 */
function parseMarksInSegment(
  content: string,
  baseStyle: InlineStyle,
  elements: TextRunElement[],
): void {
  const open = findNextOpenMark(content, 0);
  if (open === undefined) {
    pushRun(elements, content, baseStyle);
    return;
  }

  const close = content.indexOf(open.delim, open.index + open.delim.length);
  if (close === -1) {
    // Unpaired opener — emit the entire remaining content verbatim under the
    // base style. Matches the markdown importer behaviour for stray marks.
    pushRun(elements, content, baseStyle);
    return;
  }

  if (close === open.index + open.delim.length) {
    // Empty pair (`****` or ` `` `): keep both delimiters literally so the
    // rebuilt text matches the importer's verbatim handling.
    pushRun(elements, content.slice(0, close + open.delim.length), baseStyle);
    parseMarksInSegment(content.slice(close + open.delim.length), baseStyle, elements);
    return;
  }

  pushRun(elements, content.slice(0, open.index), baseStyle);
  const innerStyle: InlineStyle =
    open.kind === "bold"
      ? { ...baseStyle, bold: true }
      : { ...baseStyle, inlineCode: true };
  parseMarksInSegment(content.slice(open.index + open.delim.length, close), innerStyle, elements);
  parseMarksInSegment(content.slice(close + open.delim.length), baseStyle, elements);
}

type MarkKind = "bold" | "code";
interface NextMark {
  readonly kind: MarkKind;
  readonly delim: "**" | "`";
  readonly index: number;
}

function findNextOpenMark(content: string, from: number): NextMark | undefined {
  const boldAt = content.indexOf("**", from);
  const codeAt = content.indexOf("`", from);
  if (boldAt === -1 && codeAt === -1) return undefined;
  if (boldAt === -1) return { kind: "code", delim: "`", index: codeAt };
  if (codeAt === -1) return { kind: "bold", delim: "**", index: boldAt };
  if (codeAt < boldAt) return { kind: "code", delim: "`", index: codeAt };
  return { kind: "bold", delim: "**", index: boldAt };
}

/**
 * Parse manifest inline text — `**bold**`, `` `inline code` `` and
 * `[[ref:anchorId|display]]` — into docx text_run elements. `resolveRef`
 * returns a clickable URL for an anchorId or `undefined` if the ref is
 * unknown; unresolved refs are rendered as plain (display) text so the
 * caller can decide how to surface the failure.
 *
 * Bold and inline-code styling INSIDE a ref display segment are preserved
 * (a run can be bold and/or inline-code AND linked); they do not cross ref
 * boundaries (the ref text is its own segment). `**` and `` ` `` may nest in
 * either order; unpaired marks are emitted verbatim.
 */
export function parseInlineRich(content: string, resolveRef: RefResolver): readonly TextRunElement[] {
  const elements: TextRunElement[] = [];
  for (const segment of parseInlineRefs(content)) {
    const linkUrl = segment.kind === "ref" ? resolveRef(segment.anchorId) : undefined;
    parseMarksInSegment(segment.text, { bold: false, inlineCode: false, linkUrl }, elements);
  }
  return elements.length > 0 ? elements : [makeRun("", { bold: false, inlineCode: false })];
}

/**
 * Backward-compatible bold-only parser. Refs in the content are stripped to
 * their plain display text (used during the markdown create pass before
 * heading block_ids are known).
 */
export function parseInlineBold(content: string): readonly TextRunElement[] {
  return parseInlineRich(content, () => undefined);
}

/** Apply a fully-rendered elements array to a block via update_text_elements. */
export async function patchBlockTextElements(
  docId: string,
  blockId: string,
  elements: readonly TextRunElement[],
): Promise<void> {
  await withRetry(() =>
    larkApi({
      method: "PATCH",
      path: `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
      data: { update_text_elements: { elements: [...elements] } },
    }),
  );
}

function textBlock(blockId: string, content: string, resolveRef?: RefResolver): TemporaryBlockBody {
  const elements = resolveRef === undefined
    ? [{ text_run: { content, text_element_style: {} as TextElementStyle } }]
    : [...parseInlineRich(content, resolveRef)];
  return {
    block_id: blockId,
    block_type: 2,
    text: { elements },
  };
}

function richTextBlock(
  blockId: string,
  key: RichTextKey,
  elements: readonly TextRunElement[],
  sequence?: OrderedSequence,
): TemporaryBlockBody {
  switch (key) {
    case "text":
      return {
        block_id: blockId,
        block_type: 2,
        text: { elements },
      };
    case "bullet":
      return {
        block_id: blockId,
        block_type: 12,
        bullet: { elements },
      };
    case "ordered":
      if (sequence === undefined) throw new Error("ordered sequence is required");
      return {
        block_id: blockId,
        block_type: 13,
        ordered: {
          elements,
          style: { sequence },
        },
      };
  }
}

function calloutLines(spec: CalloutSpec): readonly string[] {
  const lines = spec.lines ?? (spec.text !== undefined ? spec.text.split(/\r?\n/) : []);
  return lines.length > 0 ? lines : [""];
}

function gridParagraphs(spec: GridSpec): readonly string[] {
  const paragraphs = spec.paragraphs ?? (spec.text !== undefined ? spec.text.split(/\r?\n/) : []);
  return paragraphs.length > 0 ? paragraphs : [""];
}

function gridWidthRatios(spec: GridSpec): readonly [number, number] {
  return spec.widthRatios ?? DEFAULT_GRID_WIDTH_RATIOS;
}

function gridRightBlocks(spec: GridSpec, resolveRef: RefResolver): readonly TemporaryBlockBody[] {
  if (spec.blocks === undefined) {
    return gridParagraphs(spec).map((paragraph, i) =>
      richTextBlock(`${TEMP_GRID_RIGHT_COLUMN_ID}_text_${i}`, "text", parseInlineRich(paragraph, resolveRef)),
    );
  }

  const blocks: TemporaryBlockBody[] = [];
  let n = 0;
  for (const block of spec.blocks) {
    if (block.kind === "paragraph") {
      blocks.push(richTextBlock(`${TEMP_GRID_RIGHT_COLUMN_ID}_block_${n}`, "text", parseInlineRich(block.text, resolveRef)));
      n += 1;
      continue;
    }

    block.items.forEach((item, i) => {
      const blockId = `${TEMP_GRID_RIGHT_COLUMN_ID}_block_${n}`;
      if (block.style === "ordered") {
        blocks.push(richTextBlock(blockId, "ordered", parseInlineRich(item, resolveRef), i === 0 ? "1" : "auto"));
      } else {
        blocks.push(richTextBlock(blockId, "bullet", parseInlineRich(item, resolveRef)));
      }
      n += 1;
    });
  }
  return blocks;
}

export function buildCalloutChildren(spec: CalloutSpec, resolveRef?: RefResolver): readonly DocxBlockBody[] {
  const lines = calloutLines(spec);
  const textIds = lines.map((_line, i) => `${TEMP_CALLOUT_ID}_text_${i}`);
  const callout: Record<string, unknown> = {
    background_color: spec.backgroundColor ?? DEFAULT_CALLOUT_BACKGROUND,
    border_color: spec.borderColor ?? DEFAULT_CALLOUT_BORDER,
  };
  if (spec.emoji !== undefined) {
    // Feishu emoji_id must be an official enum key, NOT a Unicode character.
    // See: https://open.feishu.cn/document/docs/docs/data-structure/emoji.md
    const EMOJI_MAP: Record<string, string> = {
      "⚠️": "warning",
      "ℹ️": "information_source",
      "💡": "bulb",
      "✅": "white_check_mark",
      "❌": "x",
      "🔥": "fire",
      "⭐": "star",
      "📌": "pushpin",
      "🚀": "rocket",
      "📝": "memo",
      "🎯": "dart",
      "❗": "exclamation",
      "💬": "speech_balloon",
      "📋": "clipboard",
      "🔗": "link",
      "⏰": "alarm_clock",
      "🎉": "tada",
      "👍": "thumbsup",
      "❓": "question",
      "💰": "moneybag",
      "📊": "bar_chart",
      "🔧": "wrench",
    };
    const mapped = EMOJI_MAP[spec.emoji];
    if (mapped !== undefined) {
      callout.emoji_id = mapped;
    } else if (/^[a-z][a-z0-9_]*$/.test(spec.emoji)) {
      // Already a normalized Feishu enum key (e.g. "warning", "bulb")
      callout.emoji_id = spec.emoji;
    } else {
      // Unknown Unicode emoji — omit rather than send invalid value
      // that would cause schema mismatch (error 1770006)
    }
  }
  return [
    {
      block_id: TEMP_CALLOUT_ID,
      block_type: 19,
      callout,
      children: textIds,
    },
    ...lines.map((line, i) => textBlock(textIds[i]!, line, resolveRef)),
  ];
}

export function buildGridDescendants(spec: GridSpec, resolveRef?: RefResolver): readonly DocxBlockBody[] {
  const [leftRatio, rightRatio] = gridWidthRatios(spec);
  const rightBlocks = gridRightBlocks(spec, resolveRef ?? (() => undefined));
  const rightBlockIds = rightBlocks.map((block) => block.block_id);
  return [
    {
      block_id: TEMP_GRID_ID,
      block_type: 24,
      grid: { column_size: 2 },
      children: [TEMP_GRID_LEFT_COLUMN_ID, TEMP_GRID_RIGHT_COLUMN_ID],
    },
    {
      block_id: TEMP_GRID_LEFT_COLUMN_ID,
      block_type: 25,
      grid_column: { width_ratio: leftRatio },
      children: [TEMP_GRID_IMAGE_ID],
    },
    {
      block_id: TEMP_GRID_IMAGE_ID,
      block_type: 27,
      image: {},
    },
    {
      block_id: TEMP_GRID_RIGHT_COLUMN_ID,
      block_type: 25,
      grid_column: { width_ratio: rightRatio },
      children: rightBlockIds,
    },
    ...rightBlocks,
  ];
}

function blockIdForTemporary(data: unknown, temporaryBlockId: string): string {
  if (!isRecord(data) || !Array.isArray(data.block_id_relations)) {
    throw new LarkError(`missing block_id_relations for ${temporaryBlockId}`, data);
  }
  for (const relation of data.block_id_relations) {
    if (!isRecord(relation)) continue;
    if (relation.temporary_block_id === temporaryBlockId && typeof relation.block_id === "string") {
      return relation.block_id;
    }
  }
  throw new LarkError(`missing block_id relation for ${temporaryBlockId}`, data);
}

function apiEnvelopeData(v: unknown, context: string): unknown {
  if (!isRecord(v) || typeof v.code !== "number") {
    throw new LarkError(`${context} did not return an API envelope`, v);
  }
  if (v.code !== 0) {
    throw new LarkError(`${context} returned code ${v.code}: ${typeof v.msg === "string" ? v.msg : "<no msg>"}`, v);
  }
  return v.data;
}

function fileTokenFromUpload(data: unknown): string {
  if (!isRecord(data) || typeof data.file_token !== "string" || data.file_token.trim() === "") {
    throw new LarkError("media upload did not return file_token", data);
  }
  return data.file_token;
}

async function uploadDocxImage(docId: string, imageBlockId: string, absPath: string): Promise<string> {
  const st = statSync(absPath);
  const data = {
    file_name: basename(absPath),
    parent_type: "docx_image",
    parent_node: imageBlockId,
    size: String(st.size),
    extra: JSON.stringify({ drive_route_token: docId }),
  };
  const res = await withRetry(
    () =>
      runLark(
        [
          "api",
          "POST",
          "/open-apis/drive/v1/medias/upload_all",
          "--data",
          JSON.stringify(data),
          "--file",
          `file=${basename(absPath)}`,
        ],
        { cwd: dirname(absPath) },
      ),
    { retries: 4, baseMs: 2000, maxMs: 15000 },
  );
  return fileTokenFromUpload(apiEnvelopeData(res, "media upload"));
}

const ALIGN_MAP: Record<string, number> = { left: 1, center: 2, right: 3 };

async function replaceImage(docId: string, imageBlockId: string, fileToken: string, image: ImageSpec): Promise<void> {
  const replaceImageBody: Record<string, unknown> = { token: fileToken };
  if (image.width !== undefined && Number.isInteger(image.width) && image.width > 0) {
    replaceImageBody.width = image.width;
  }
  if (image.height !== undefined && Number.isInteger(image.height) && image.height > 0) {
    replaceImageBody.height = image.height;
  }
  if (image.align !== undefined && ALIGN_MAP[image.align] !== undefined) {
    replaceImageBody.align = ALIGN_MAP[image.align];
  }
  if (image.caption !== undefined && image.caption.trim() !== "") {
    replaceImageBody.caption = { content: image.caption };
  }
  await larkApi({
    method: "PATCH",
    path: `/open-apis/docx/v1/documents/${docId}/blocks/batch_update`,
    data: {
      requests: [
        {
          block_id: imageBlockId,
          replace_image: replaceImageBody,
        },
      ],
    },
  });
}

export async function insertCallout(
  docId: string,
  parentId: string,
  index: number,
  spec: CalloutSpec,
  resolveRef?: RefResolver,
): Promise<string> {
  const data = await larkApi({
    method: "POST",
    path: `/open-apis/docx/v1/documents/${docId}/blocks/${parentId}/descendant`,
    data: {
      index,
      children_id: [TEMP_CALLOUT_ID],
      descendants: buildCalloutChildren(spec, resolveRef),
    },
  });
  return blockIdForTemporary(data, TEMP_CALLOUT_ID);
}

async function setGridColumnWidthRatios(docId: string, gridId: string, widthRatios: readonly [number, number]): Promise<void> {
  await larkApi({
    method: "PATCH",
    path: `/open-apis/docx/v1/documents/${docId}/blocks/${gridId}`,
    data: {
      update_grid_column_width_ratio: {
        width_ratios: [...widthRatios],
      },
    },
  });
}

export async function insertGridLeftImageRightText(
  docId: string,
  parentId: string,
  index: number,
  spec: GridSpec,
  workspaceRoot: string,
  resolveRef?: RefResolver,
): Promise<InsertGridResult> {
  const abs = assertWithinWorkspace(spec.image.path, workspaceRoot);
  assertMediaFile(abs, { kind: "image" });
  const data = await larkApi({
    method: "POST",
    path: `/open-apis/docx/v1/documents/${docId}/blocks/${parentId}/descendant`,
    data: {
      index,
      children_id: [TEMP_GRID_ID],
      descendants: buildGridDescendants(spec, resolveRef),
    },
  });
  const gridId = blockIdForTemporary(data, TEMP_GRID_ID);
  const imageBlockId = blockIdForTemporary(data, TEMP_GRID_IMAGE_ID);
  await setGridColumnWidthRatios(docId, gridId, gridWidthRatios(spec));
  const fileToken = await uploadDocxImage(docId, imageBlockId, abs);
  await replaceImage(docId, imageBlockId, fileToken, spec.image);
  return { gridId, imageBlockId, fileToken };
}

export async function setTableColumnWidths(docId: string, tableId: string, widths: readonly number[]): Promise<void> {
  for (let columnIndex = 0; columnIndex < widths.length; columnIndex++) {
    await larkApi({
      method: "PATCH",
      path: `/open-apis/docx/v1/documents/${docId}/blocks/${tableId}`,
      data: {
        update_table_property: {
          column_index: columnIndex,
          column_width: widths[columnIndex],
        },
      },
    });
  }
}

function textRunContents(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(textRunContents);
  if (!isRecord(v)) return [];
  const current =
    isRecord(v.text_run) && typeof v.text_run.content === "string" ? [v.text_run.content] : [];
  return [...current, ...Object.values(v).flatMap(textRunContents)];
}

function nextPageToken(data: Record<string, unknown>): string | undefined {
  const token = data.page_token ?? data.next_page_token;
  return typeof token === "string" && token.trim() !== "" ? token : undefined;
}

export async function findBlockIdByText(docId: string, text: string): Promise<string | undefined> {
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
    for (const item of data.items) {
      if (!isRecord(item) || typeof item.block_id !== "string") continue;
      if (textRunContents(item).join("") === text) return item.block_id;
    }
    pageToken = data.has_more === true ? nextPageToken(data) : undefined;
  } while (pageToken !== undefined);
  return undefined;
}
