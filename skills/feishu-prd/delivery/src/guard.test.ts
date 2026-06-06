import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMediaFile, assertUrlScheme, assertWithinWorkspace, GuardError } from "./lib/guard.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "feishu-prd-guard-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("assertWithinWorkspace accepts normal workspace paths", () => {
  withTempDir((root) => {
    writeFileSync(join(root, "image.png"), "png");
    assert.equal(assertWithinWorkspace("image.png", root), join(root, "image.png"));
  });
});

test("assertWithinWorkspace rejects parent traversal", () => {
  withTempDir((root) => {
    assert.throws(() => assertWithinWorkspace("../outside.png", root), GuardError);
  });
});

test("assertWithinWorkspace rejects symlinks escaping the workspace", () => {
  withTempDir((root) => {
    const outside = mkdtempSync(join(tmpdir(), "feishu-prd-outside-"));
    try {
      const outsideFile = join(outside, "secret.png");
      writeFileSync(outsideFile, "png");
      symlinkSync(outsideFile, join(root, "link.png"));
      assert.throws(() => assertWithinWorkspace("link.png", root), GuardError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("assertUrlScheme accepts only http and https URLs", () => {
  assert.equal(assertUrlScheme("https://example.com/a"), "https://example.com/a");
  assert.equal(assertUrlScheme("http://example.com/a"), "http://example.com/a");
  assert.throws(() => assertUrlScheme("file:///tmp/a"), GuardError);
});

test("assertMediaFile validates image extension and size", () => {
  withTempDir((root) => {
    const image = join(root, "image.png");
    const text = join(root, "image.txt");
    writeFileSync(image, "png");
    writeFileSync(text, "txt");

    assert.doesNotThrow(() => assertMediaFile(image, { kind: "image" }));
    assert.throws(() => assertMediaFile(text, { kind: "image" }), GuardError);
    assert.throws(() => assertMediaFile(image, { kind: "image", maxBytes: 1 }), GuardError);
  });
});
