// Thin wrapper around the `lark-cli` binary.
//
// Security: invoked via spawn + argument array (never a shell
// string) so there is no command-injection surface; access tokens are never
// logged.
//
// Networking: lark-cli talks to Feishu directly using its own configured app
// credentials, so the delivery layer needs no proxy or special network setup.
// If your environment routes other traffic through a proxy, that is an
// environment concern — do not hard-code one here.
//
// I/O contract (verified against the live lark-cli):
//   - success JSON is on stdout; diagnostics / media progress lines are on
//     stderr; on failure the error JSON may be on stderr. Some commands (e.g.
//     `config show`) print a trailing non-JSON line, so we extract the first
//     balanced {...} object rather than parsing blindly.

import { spawn } from "node:child_process";
import { withRetry } from "./retry.ts";

/**
 * Concatenate child-process output chunks and decode once as UTF-8.
 *
 * Decoding each chunk independently (`buf.toString()` per `data` event) breaks
 * multi-byte UTF-8 codepoints that happen to straddle a chunk boundary: each
 * half decodes to U+FFFD. This is silent — replacement chars don't break JSON
 * structure but corrupt string contents — and triggers on large CJK responses
 * where chunk boundaries land mid-character. Buffering and decoding once is
 * the simplest correct fix.
 */
export function concatChunks(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks as Buffer[]).toString("utf8");
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class LarkError extends Error {
  readonly detail: unknown;
  readonly retryable: boolean;
  constructor(message: string, detail?: unknown, retryable = false) {
    super(message);
    this.name = "LarkError";
    this.detail = detail;
    this.retryable = retryable;
  }
}

// Transient signals worth retrying (mostly the hosted-MCP path dropping connections).
const RETRYABLE_TEXT =
  /EOF|transport failed|timeout|i\/o timeout|connection (reset|refused)|TLS handshake|temporarily|EAI_AGAIN|ECONNRESET|ETIMEDOUT|\b50[234]\b/i;
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504, 1061001, 99991400]);
// Freshly created docs sometimes return code 2200 with this exact message on the
// first read because the user_access_token scope grant has not propagated to all
// edge nodes yet (observed 1-2 min propagation window). The error clears on its
// own. We match by message substring rather than adding 2200 to RETRYABLE_CODES
// because 2200 can also mean a real permission/scope error that must surface.
const RETRYABLE_SCOPE_LAG_MESSAGE = "check incr user_access_token scope";

function textIsRetryable(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  return RETRYABLE_TEXT.test(detail) || detail.includes(RETRYABLE_SCOPE_LAG_MESSAGE);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function retryableCodeIn(detail: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof detail === "number") return RETRYABLE_CODES.has(detail);
  if (typeof detail === "string") {
    const n = Number(detail);
    return Number.isInteger(n) && RETRYABLE_CODES.has(n);
  }
  if (Array.isArray(detail)) return detail.some((v) => retryableCodeIn(v, depth + 1));
  if (!isRecord(detail)) return false;
  if (retryableCodeIn(detail.code, depth + 1)) return true;
  return Object.values(detail).some((v) => (isRecord(v) || Array.isArray(v)) && retryableCodeIn(v, depth + 1));
}

function textHasRetryableCode(s: string): boolean {
  const matches = s.matchAll(/\bcode\b\D{0,16}(\d{3,8})/gi);
  for (const match of matches) {
    const code = Number(match[1]);
    if (RETRYABLE_CODES.has(code)) return true;
  }
  return false;
}

function detailIsRetryable(detail: unknown): boolean {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return textIsRetryable(text) || (typeof text === "string" && textHasRetryableCode(text)) || retryableCodeIn(detail);
}

function sanitizeArgs(args: readonly string[]): string {
  const sanitized: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      sanitized.push("<redacted>");
      redactNext = false;
      continue;
    }
    if (arg === "--data" || arg === "--params") {
      sanitized.push(arg);
      redactNext = true;
      continue;
    }
    if (arg.startsWith("--data=")) {
      sanitized.push("--data=<redacted>");
      continue;
    }
    if (arg.startsWith("--params=")) {
      sanitized.push("--params=<redacted>");
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized.join(" ");
}

function redactSensitive(s: string): string {
  const jsonKeys = /"([A-Za-z0-9_]*(?:token|secret|authorization)[A-Za-z0-9_]*)"\s*:\s*"[^"]*"/gi;
  const kvKeys = /\b([A-Za-z0-9_]*(?:token|secret|authorization)[A-Za-z0-9_]*)\b(\s*[:=]\s*)([^\s,;{}]+)/gi;
  return s
    .replace(jsonKeys, (_match, key: string) => `"${key}":"<redacted>"`)
    .replace(kvKeys, (_match, key: string, sep: string) => `${key}${sep}<redacted>`)
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "<redacted>")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "<redacted>");
}

export interface RunOptions {
  /** stdin payload, e.g. for `--markdown -`. */
  readonly stdin?: string;
  /** working directory; lark-cli requires --file/@file to be relative to cwd. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

interface RawResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function spawnLark(args: readonly string[], opts: RunOptions): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("lark-cli", [...args], { cwd: opts.cwd });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, timeoutMs);
    const clearTimers = (): void => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    // Buffer raw chunks and decode once on close so that multi-byte UTF-8
    // characters straddling a chunk boundary don't get mangled into U+FFFD.
    child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));
    child.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(new LarkError(`failed to start lark-cli: ${sanitizeArgs(args)}`, redactSensitive(e.message), textIsRetryable(e.message)));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const stdout = concatChunks(stdoutChunks);
      const stderr = concatChunks(stderrChunks);
      if (timedOut) {
        const detail = redactSensitive(stderr.trim() || stdout.trim());
        reject(new LarkError(`lark-cli timed out after ${timeoutMs}ms: ${sanitizeArgs(args)}`, detail, false));
        return;
      }
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/** Extract the first balanced JSON object from mixed CLI output. */
export function extractJsonObject(s: string): string {
  const start = s.indexOf("{");
  if (start < 0) throw new LarkError("no JSON object in lark-cli output", redactSensitive(s.slice(0, 200)));
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  throw new LarkError("unbalanced JSON in lark-cli output", redactSensitive(s.slice(start, start + 200)));
}

/** Run lark-cli and return parsed JSON from stdout; throws on non-zero exit. */
export async function runLark(args: readonly string[], opts: RunOptions = {}): Promise<unknown> {
  const { stdout, stderr, code } = await spawnLark(args, opts);
  if (code !== 0) {
    const detail = redactSensitive(stderr.trim() || stdout.trim());
    throw new LarkError(`lark-cli exited ${code}: ${sanitizeArgs(args)}`, detail, detailIsRetryable(detail));
  }
  return JSON.parse(extractJsonObject(stdout));
}

interface ApiEnvelope {
  readonly code: number;
  readonly msg: string;
  readonly data?: unknown;
}

interface DocsEnvelope {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
}

export interface ApiCall {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly params?: Record<string, unknown>;
  readonly data?: Record<string, unknown>;
}

/** Raw documented open-apis call (`lark-cli api ...`). Returns `data`; throws unless code === 0. */
export async function larkApi(call: ApiCall): Promise<unknown> {
  const args = ["api", call.method, call.path];
  if (call.params) args.push("--params", JSON.stringify(call.params));
  if (call.data) args.push("--data", JSON.stringify(call.data));
  const invoke = async (): Promise<unknown> => {
    const res = (await runLark(args)) as ApiEnvelope;
    if (res.code !== 0) {
      const retryable = RETRYABLE_CODES.has(res.code) || textIsRetryable(res.msg);
      throw new LarkError(`Feishu API code ${res.code}: ${res.msg}`, res, retryable);
    }
    return res.data;
  };
  return call.method === "GET" ? withRetry(invoke) : invoke();
}

/** High-level `lark-cli docs ...` helper. Returns `data`; throws unless ok === true. */
export async function larkDocs(args: readonly string[], opts: RunOptions = {}): Promise<unknown> {
  const res = (await runLark(["docs", ...args], opts)) as DocsEnvelope;
  if (!res.ok) {
    throw new LarkError("lark-cli docs command failed", res.error, detailIsRetryable(res.error));
  }
  return res.data;
}

/**
 * Assert the active lark-cli account matches the expected open_id.
 * Identity is checked by open_id, never by display name (the account was renamed).
 */
export async function assertActiveAccount(expectedOpenId: string): Promise<void> {
  const cfg = (await runLark(["config", "show"])) as { users?: string };
  const openIds = new Set(cfg.users?.match(/ou_[0-9a-f]{32}/g) ?? []);
  if (!openIds.has(expectedOpenId)) {
    throw new LarkError(
      `active lark-cli account mismatch: expected open_id ${expectedOpenId}, got "${cfg.users ?? "<none>"}"`,
    );
  }
}
