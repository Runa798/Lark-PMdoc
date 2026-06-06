// Exponential-backoff retry for transient lark-cli / Feishu failures.
// Needed because the markdown create/update path rides Feishu's hosted MCP
// (`mcp.feishu.cn`), which intermittently drops connections (EOF). Only errors
// flagged `retryable` are retried, so
// validation errors (e.g. missing title) fail fast.

export interface RetryOptions {
  /** max ADDITIONAL attempts after the first (default 3). */
  readonly retries?: number;
  readonly baseMs?: number;
  readonly factor?: number;
  readonly maxMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRetryable(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { retryable?: boolean }).retryable === true;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseMs ?? 500;
  const factor = opts.factor ?? 2;
  const cap = opts.maxMs ?? 8000;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || attempt >= retries) throw e;
      const backoff = Math.min(cap, base * factor ** attempt) + Math.floor(Math.random() * 200);
      attempt += 1;
      await sleep(backoff);
    }
  }
}
