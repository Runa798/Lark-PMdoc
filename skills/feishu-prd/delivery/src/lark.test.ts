import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { concatChunks, extractJsonObject } from "./lib/lark.ts";

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

test("concatChunks preserves multi-byte UTF-8 codepoints split across buffer boundaries", () => {
  // CJK "席" is encoded as 0xE5 0xB8 0xAD (3 bytes); decoding either half on
  // its own yields U+FFFD (replacement char). concatChunks must defer decoding
  // until after the bytes are joined so the original character round-trips.
  const original = "席位缩减";
  const bytes = Buffer.from(original, "utf8");
  // Split at byte 1 (mid-first-character) and byte 4 (mid-second-character)
  // to exercise both intra-character and inter-character splits.
  const a = bytes.subarray(0, 1);
  const b = bytes.subarray(1, 4);
  const c = bytes.subarray(4);

  const decoded = concatChunks([a, b, c]);
  assert.equal(decoded, original);
  assert.ok(!decoded.includes("�"), "must not contain U+FFFD replacement chars");

  // Sanity: the naive per-chunk decoder *would* corrupt this input. If this
  // assertion ever starts failing it means the test no longer demonstrates
  // the bug it was written to prevent.
  const naive = a.toString() + b.toString() + c.toString();
  assert.ok(naive.includes("�"), "naive per-chunk decode should corrupt the input");
});

test("concatChunks handles empty input and single chunk", () => {
  assert.equal(concatChunks([]), "");
  assert.equal(concatChunks([Buffer.from("hello", "utf8")]), "hello");
});

test("spawned subprocess output with mid-character chunk split decodes cleanly", async () => {
  // Drive a real child process that writes a CJK character one byte at a time,
  // forcing the parent to receive multiple 'data' events that each carry an
  // incomplete UTF-8 sequence. The chunk-collection pattern used in spawnLark
  // must yield the original string with no U+FFFD.
  const original = "席位缩减";
  const script = `
    const bytes = Buffer.from(${JSON.stringify(original)}, "utf8");
    let i = 0;
    const writeNext = () => {
      if (i >= bytes.length) return process.stdout.end();
      process.stdout.write(bytes.subarray(i, i + 1));
      i += 1;
      // setImmediate ensures the parent's 'data' handler runs between writes,
      // producing one chunk per byte instead of one combined chunk.
      setImmediate(writeNext);
    };
    writeNext();
  `;

  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script]);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", () => resolve(concatChunks(chunks)));
  });

  assert.equal(result, original);
  assert.ok(!result.includes("�"), "decoded output must not contain U+FFFD");
});
