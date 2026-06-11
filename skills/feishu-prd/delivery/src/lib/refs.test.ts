import test from "node:test";
import assert from "node:assert/strict";
import { collectRefAnchorIds, hasRef, parseInlineRefs, stripRefs } from "./refs.ts";

test("parseInlineRefs returns a single text segment when no ref syntax is present", () => {
  assert.deepEqual(parseInlineRefs("plain text"), [{ kind: "text", text: "plain text" }]);
});

test("parseInlineRefs splits a single ref between two text spans", () => {
  assert.deepEqual(parseInlineRefs("see [[ref:section-a|that part]] for details"), [
    { kind: "text", text: "see " },
    { kind: "ref", anchorId: "section-a", text: "that part" },
    { kind: "text", text: " for details" },
  ]);
});

test("parseInlineRefs trims whitespace inside the anchorId but preserves display text", () => {
  assert.deepEqual(parseInlineRefs("[[ref:  spaced-id |Display Text]]"), [
    { kind: "ref", anchorId: "spaced-id", text: "Display Text" },
  ]);
});

test("parseInlineRefs handles back-to-back refs with no surrounding text", () => {
  assert.deepEqual(parseInlineRefs("[[ref:a|A]][[ref:b|B]]"), [
    { kind: "ref", anchorId: "a", text: "A" },
    { kind: "ref", anchorId: "b", text: "B" },
  ]);
});

test("parseInlineRefs returns an empty array for empty input", () => {
  assert.deepEqual(parseInlineRefs(""), []);
});

test("stripRefs replaces refs with their display text and leaves plain text alone", () => {
  assert.equal(stripRefs("before [[ref:x|display]] after"), "before display after");
  assert.equal(stripRefs("no refs here"), "no refs here");
});

test("stripRefs preserves pipe characters that appear in the display text", () => {
  // A pipe in display text must survive because the markdown table renderer
  // escapes pipes only after stripRefs runs.
  assert.equal(stripRefs("[[ref:x|left | right]]"), "left | right");
});

test("hasRef returns true only when at least one well-formed ref is present", () => {
  assert.equal(hasRef("plain"), false);
  assert.equal(hasRef("[[ref:x|y]]"), true);
  // Almost-but-not-ref tokens must not trigger:
  assert.equal(hasRef("[[ref:no-display]]"), false);
});

test("collectRefAnchorIds returns anchorIds in source order with duplicates preserved", () => {
  assert.deepEqual(collectRefAnchorIds("[[ref:a|A]] and [[ref:b|B]] and [[ref:a|A again]]"), ["a", "b", "a"]);
  assert.deepEqual(collectRefAnchorIds("plain"), []);
});
