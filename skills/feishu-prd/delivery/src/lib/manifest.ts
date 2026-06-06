// Delivery manifest — the typed contract between the content layer (which writes
// the prose) and the delivery layer (which renders it into Feishu). Plan §1.3.
//
// The content layer emits sections with headings WITHOUT numbers (numbering is a
// deterministic engine pass, plan D14) and a list of typed blocks. Text blocks
// (paragraph/list/table) go through the markdown create path; media and callouts
// are inserted afterwards by the orchestrator, anchored by the numbered title.

import type { HeadingLevel } from "./numbering.ts";

export interface TableSpec {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
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
  readonly text: string;
}

export interface AppendixLink {
  readonly text: string;
  /** must be a clickable http(s) URL — never a server-local file path (D7/§3.1). */
  readonly url: string;
}

export type BlockSpec =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly list: ListSpec }
  | { readonly kind: "table"; readonly table: TableSpec }
  | { readonly kind: "callout"; readonly callout: CalloutSpec }
  | { readonly kind: "image"; readonly image: ImageSpec }
  | { readonly kind: "mermaid"; readonly mermaidPath: string; readonly caption?: string };

export interface PrdSection {
  readonly level: HeadingLevel;
  /** title WITHOUT a leading number; the engine numbers it (D14). */
  readonly title: string;
  /** stable anchor for incremental edits / media targeting. */
  readonly anchorKey: string;
  readonly blocks: readonly BlockSpec[];
}

export interface PrdManifest {
  readonly title: string;
  readonly sections: readonly PrdSection[];
}
