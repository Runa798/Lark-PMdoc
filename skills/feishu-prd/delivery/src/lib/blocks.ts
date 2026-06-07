import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { assertMediaFile, assertWithinWorkspace } from "./guard.ts";
import { LarkError, larkApi, runLark } from "./lark.ts";
import type { CalloutSpec, GridSpec, ImageSpec } from "./manifest.ts";

export type DocxBlockBody = Record<string, unknown>;

type TemporaryBlockBody = DocxBlockBody & { readonly block_id: string };
type RichTextKey = "text" | "bullet" | "ordered";
type OrderedSequence = "1" | "auto";

interface TextElementStyle {
  readonly bold?: true;
}

interface TextRunElement {
  readonly text_run: {
    readonly content: string;
    readonly text_element_style: TextElementStyle;
  };
}

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

function textRun(content: string, bold: boolean): TextRunElement {
  return {
    text_run: {
      content,
      text_element_style: bold ? { bold: true } : {},
    },
  };
}

function pushInlineRun(elements: TextRunElement[], content: string, bold: boolean): void {
  if (content === "") return;
  const previous = elements[elements.length - 1];
  if (previous !== undefined && (previous.text_run.text_element_style.bold === true) === bold) {
    elements[elements.length - 1] = textRun(`${previous.text_run.content}${content}`, bold);
    return;
  }
  elements.push(textRun(content, bold));
}

export function parseInlineBold(content: string): readonly TextRunElement[] {
  if (!content.includes("**")) return [textRun(content, false)];

  const elements: TextRunElement[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const open = content.indexOf("**", cursor);
    if (open === -1) {
      pushInlineRun(elements, content.slice(cursor), false);
      break;
    }

    const close = content.indexOf("**", open + 2);
    if (close === -1) {
      pushInlineRun(elements, content.slice(cursor), false);
      break;
    }

    if (close === open + 2) {
      pushInlineRun(elements, content.slice(cursor, close + 2), false);
      cursor = close + 2;
      continue;
    }

    pushInlineRun(elements, content.slice(cursor, open), false);
    pushInlineRun(elements, content.slice(open + 2, close), true);
    cursor = close + 2;
  }

  return elements.length > 0 ? elements : [textRun("", false)];
}

function textBlock(blockId: string, content: string): TemporaryBlockBody {
  return {
    block_id: blockId,
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content,
            text_element_style: {},
          },
        },
      ],
    },
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

function gridRightBlocks(spec: GridSpec): readonly TemporaryBlockBody[] {
  if (spec.blocks === undefined) {
    return gridParagraphs(spec).map((paragraph, i) => textBlock(`${TEMP_GRID_RIGHT_COLUMN_ID}_text_${i}`, paragraph));
  }

  const blocks: TemporaryBlockBody[] = [];
  let n = 0;
  for (const block of spec.blocks) {
    if (block.kind === "paragraph") {
      blocks.push(richTextBlock(`${TEMP_GRID_RIGHT_COLUMN_ID}_block_${n}`, "text", parseInlineBold(block.text)));
      n += 1;
      continue;
    }

    block.items.forEach((item, i) => {
      const blockId = `${TEMP_GRID_RIGHT_COLUMN_ID}_block_${n}`;
      if (block.style === "ordered") {
        blocks.push(richTextBlock(blockId, "ordered", parseInlineBold(item), i === 0 ? "1" : "auto"));
      } else {
        blocks.push(richTextBlock(blockId, "bullet", parseInlineBold(item)));
      }
      n += 1;
    });
  }
  return blocks;
}

export function buildCalloutChildren(spec: CalloutSpec): readonly DocxBlockBody[] {
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
    ...lines.map((line, i) => textBlock(textIds[i]!, line)),
  ];
}

export function buildGridDescendants(spec: GridSpec): readonly DocxBlockBody[] {
  const [leftRatio, rightRatio] = gridWidthRatios(spec);
  const rightBlocks = gridRightBlocks(spec);
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
  const res = await runLark(
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

export async function insertCallout(docId: string, parentId: string, index: number, spec: CalloutSpec): Promise<string> {
  const data = await larkApi({
    method: "POST",
    path: `/open-apis/docx/v1/documents/${docId}/blocks/${parentId}/descendant`,
    data: {
      index,
      children_id: [TEMP_CALLOUT_ID],
      descendants: buildCalloutChildren(spec),
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
): Promise<InsertGridResult> {
  const abs = assertWithinWorkspace(spec.image.path, workspaceRoot);
  assertMediaFile(abs, { kind: "image" });
  const data = await larkApi({
    method: "POST",
    path: `/open-apis/docx/v1/documents/${docId}/blocks/${parentId}/descendant`,
    data: {
      index,
      children_id: [TEMP_GRID_ID],
      descendants: buildGridDescendants(spec),
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
