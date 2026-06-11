// Delivery manifest — the typed contract between the content layer (which writes
// the prose) and the delivery layer (which renders it into Feishu).
//
// The content layer emits sections with headings WITHOUT numbers (numbering is a
// deterministic engine pass) and a list of typed blocks. Text blocks
// (paragraph/list/table) go through the markdown create path; media and callouts
// are inserted afterwards by the orchestrator, anchored by the numbered title.

import type { HeadingLevel } from "./numbering.ts";

export interface TableSpec {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly columnWidths?: readonly number[];
}

export interface ListSpec {
  readonly style: "ordered" | "unordered";
  readonly items: readonly string[];
}

export interface ImageSpec {
  /** workspace-relative path to a local image file. */
  readonly path: string;
  readonly caption?: string;
  readonly align?: "left" | "center" | "right";
  readonly width?: number;
  readonly height?: number;
}

export interface CalloutSpec {
  readonly emoji?: string;
  readonly text?: string;
  readonly lines?: readonly string[];
  readonly backgroundColor?: number;
  readonly borderColor?: number;
}

export type GridRightBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly style: "ordered" | "unordered"; readonly items: readonly string[] };

export interface GridSpec {
  readonly image: ImageSpec;
  readonly text?: string;
  readonly paragraphs?: readonly string[];
  readonly blocks?: readonly GridRightBlock[];
  readonly widthRatios?: readonly [number, number];
}

export interface AppendixLink {
  readonly text: string;
  /** must be a clickable http(s) URL — never a server-local file path. */
  readonly url: string;
}

export type BlockSpec =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly list: ListSpec }
  | { readonly kind: "table"; readonly table: TableSpec }
  | { readonly kind: "callout"; readonly callout: CalloutSpec }
  | { readonly kind: "grid"; readonly grid: GridSpec }
  | { readonly kind: "image"; readonly image: ImageSpec }
  | { readonly kind: "mermaid"; readonly mermaidPath: string; readonly caption?: string };

export interface PrdSection {
  readonly level: HeadingLevel;
  /** title WITHOUT a leading number; the engine numbers it. */
  readonly title: string;
  /** stable anchor for incremental edits / media targeting. */
  readonly anchorKey: string;
  /**
   * Stable identifier for in-document cross-references. When set, other
   * sections may link here from inline text using `[[ref:anchorId|display]]`.
   * Must be unique across the manifest when present.
   */
  readonly anchorId?: string;
  readonly blocks: readonly BlockSpec[];
}

export interface PrdManifest {
  readonly title: string;
  /**
   * Document-level blocks rendered *before* the first section heading.
   *
   * Typical use: a 2-column info table (product/doc version, date, owner, status)
   * that the reviewer expects at the very top of the document, with no heading
   * of its own. Because preamble blocks have no heading anchor above them, the
   * delivery engine can only emit them through the markdown create path —
   * `validate.ts` restricts preamble to `paragraph` / `list` / `table`. Media
   * and callouts (which need a heading anchor for precise post-create insertion)
   * are not allowed here; put them in a section instead.
   */
  readonly preamble?: readonly BlockSpec[];
  readonly sections: readonly PrdSection[];
}
