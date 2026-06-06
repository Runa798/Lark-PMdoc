// Input validation for the delivery engine (plan §4.1).
// Centralises the boundary checks: workspace-relative paths, http(s)-only URLs,
// media extension/size limits, and the appendix "must be a clickable link, not a
// local file path" rule (plan D7 / §3.1).

import { resolve, relative, isAbsolute, extname } from "node:path";
import { statSync, type Stats } from "node:fs";

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function assertUrlScheme(url: string): string {
  if (!isHttpUrl(url)) throw new GuardError(`URL must be http(s): ${url}`);
  return url;
}

/** Appendix targets must be clickable http(s) URLs — never a server-local file path. */
export function assertAppendixLink(target: string): string {
  if (!isHttpUrl(target)) {
    throw new GuardError(`appendix link must be a clickable http(s) URL, not a local path: ${target}`);
  }
  return target;
}

/** Resolve `p` against the workspace root and reject any path that escapes it. */
export function assertWithinWorkspace(p: string, workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new GuardError(`path escapes workspace root: ${p}`);
  }
  return abs;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface MediaCheck {
  readonly kind: "image" | "file";
  readonly maxBytes?: number;
}

export function assertMediaFile(absPath: string, check: MediaCheck): void {
  let st: Stats;
  try {
    st = statSync(absPath);
  } catch {
    throw new GuardError(`media file not found: ${absPath}`);
  }
  if (!st.isFile()) throw new GuardError(`not a regular file: ${absPath}`);
  const max = check.maxBytes ?? (check.kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES);
  if (st.size > max) throw new GuardError(`media too large (${st.size} > ${max} bytes): ${absPath}`);
  if (check.kind === "image") {
    const ext = extname(absPath).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) throw new GuardError(`unsupported image extension "${ext}": ${absPath}`);
  }
}
