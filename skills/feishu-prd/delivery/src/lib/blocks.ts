import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { assertMediaFile, assertWithinWorkspace } from "./guard.ts";
import { LarkError, larkApi, runLark } from "./lark.ts";
import type { CalloutSpec, GridSpec, ImageSpec } from "./manifest.ts";

export type DocxBlockBody = Record<string, unknown>;

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

function textBlock(blockId: string, content: string): DocxBlockBody {
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

export function buildCalloutChildren(spec: CalloutSpec): readonly DocxBlockBody[] {
  const lines = calloutLines(spec);
  const textIds = lines.map((_line, i) => `${TEMP_CALLOUT_ID}_text_${i}`);
  const callout: Record<string, unknown> = {
    background_color: spec.backgroundColor ?? DEFAULT_CALLOUT_BACKGROUND,
    border_color: spec.borderColor ?? DEFAULT_CALLOUT_BORDER,
  };
  if (spec.emoji !== undefined) callout.emoji_id = spec.emoji;
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
  const paragraphs = gridParagraphs(spec);
  const textIds = paragraphs.map((_paragraph, i) => `${TEMP_GRID_RIGHT_COLUMN_ID}_text_${i}`);
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
      children: textIds,
    },
    ...paragraphs.map((paragraph, i) => textBlock(textIds[i]!, paragraph)),
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

async function replaceImage(docId: string, imageBlockId: string, fileToken: string, image: ImageSpec): Promise<void> {
  const replaceImageBody: Record<string, unknown> = { token: fileToken };
  if (image.width !== undefined) replaceImageBody.width = image.width;
  if (image.height !== undefined) replaceImageBody.height = image.height;
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
