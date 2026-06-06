// Thin wrapper around the `lark-cli` binary.
//
// Security (plan §4.1): invoked via spawn + argument array (never a shell
// string) so there is no command-injection surface; outbound proxy is forced to
// the-local-proxy; access tokens are never logged.
//
// I/O contract (verified in 11-delivery-gaps-test.md):
//   - success JSON is on stdout; diagnostics / `[WARN] proxy detected` /
//     media progress lines are on stderr; on failure the error JSON may be on
//     stderr. Some commands (e.g. `config show`) print a trailing non-JSON line,
//     so we extract the first balanced {...} object rather than parsing blindly.

import { spawn } from "node:child_process";
import { withRetry } from "./retry.ts";

const PROXY = "http://127.0.0.1:0";

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
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504, 99991400]);

function textIsRetryable(detail: unknown): boolean {
  return typeof detail === "string" && RETRYABLE_TEXT.test(detail);
}

export interface RunOptions {
  /** stdin payload, e.g. for `--markdown -`. */
  readonly stdin?: string;
  /** working directory; lark-cli requires --file/@file to be relative to cwd. */
  readonly cwd?: string;
}

function withProxyEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY };
}

interface RawResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function spawnLark(args: readonly string[], opts: RunOptions): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("lark-cli", [...args], { env: withProxyEnv(), cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/** Extract the first balanced JSON object from mixed CLI output. */
function extractJsonObject(s: string): string {
  const start = s.indexOf("{");
  if (start < 0) throw new LarkError("no JSON object in lark-cli output", s.slice(0, 200));
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
  throw new LarkError("unbalanced JSON in lark-cli output", s.slice(start, start + 200));
}

/** Run lark-cli and return parsed JSON from stdout; throws on non-zero exit. */
export async function runLark(args: readonly string[], opts: RunOptions = {}): Promise<unknown> {
  const { stdout, stderr, code } = await spawnLark(args, opts);
  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new LarkError(`lark-cli exited ${code}: ${args.join(" ")}`, detail, textIsRetryable(detail));
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
  return withRetry(async () => {
    const res = (await runLark(args)) as ApiEnvelope;
    if (res.code !== 0) {
      const retryable = RETRYABLE_CODES.has(res.code) || textIsRetryable(res.msg);
      throw new LarkError(`Feishu API code ${res.code}: ${res.msg}`, res, retryable);
    }
    return res.data;
  });
}

/** High-level `lark-cli docs ...` helper. Returns `data`; throws unless ok === true. */
export async function larkDocs(args: readonly string[], opts: RunOptions = {}): Promise<unknown> {
  return withRetry(async () => {
    const res = (await runLark(["docs", ...args], opts)) as DocsEnvelope;
    if (!res.ok) {
      const retryable = textIsRetryable(JSON.stringify(res.error ?? ""));
      throw new LarkError("lark-cli docs command failed", res.error, retryable);
    }
    return res.data;
  });
}

/**
 * Assert the active lark-cli account matches the expected open_id (plan §4.1).
 * Identity is checked by open_id, never by display name (the account was renamed).
 */
export async function assertActiveAccount(expectedOpenId: string): Promise<void> {
  const cfg = (await runLark(["config", "show"])) as { users?: string };
  if (!cfg.users || !cfg.users.includes(expectedOpenId)) {
    throw new LarkError(
      `active lark-cli account mismatch: expected open_id ${expectedOpenId}, got "${cfg.users ?? "<none>"}"`,
    );
  }
}
