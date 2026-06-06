import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject } from "./lib/lark.ts";

test("extractJsonObject handles noisy output, string braces, escapes, and trailing text", () => {
  const mixed = [
    "[WARN] proxy detected",
    '{"msg":"literal { brace } and escaped \\" quote","nested":{"path":"C:\\\\tmp\\\\file"},"ok":true}',
    "request finished",
  ].join("\n");

  const parsed = JSON.parse(extractJsonObject(mixed)) as { msg: string; nested: { path: string }; ok: boolean };
  assert.equal(parsed.msg, 'literal { brace } and escaped " quote');
  assert.equal(parsed.nested.path, "C:\\tmp\\file");
  assert.equal(parsed.ok, true);
});
