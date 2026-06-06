import test from "node:test";
import assert from "node:assert/strict";
import { numberHeadings, toChineseNumeral, type Heading } from "./lib/numbering.ts";

test("H2 numbering is global across H1 headings", () => {
  const headings: Heading[] = [
    { level: 1, title: "A" },
    { level: 2, title: "A1" },
    { level: 1, title: "B" },
    { level: 2, title: "B1" },
  ];

  assert.deepEqual(
    numberHeadings(headings).map((h) => h.prefix),
    ["一、", "1. ", "二、", "2. "],
  );
});

test("H3 and H4 numbering reset under their parent headings", () => {
  const headings: Heading[] = [
    { level: 2, title: "A" },
    { level: 3, title: "A1" },
    { level: 4, title: "A1a" },
    { level: 3, title: "A2" },
    { level: 4, title: "A2a" },
    { level: 2, title: "B" },
    { level: 3, title: "B1" },
    { level: 4, title: "B1a" },
  ];

  assert.deepEqual(
    numberHeadings(headings).map((h) => h.prefix),
    ["1. ", "1.1 ", "1.1.1 ", "1.2 ", "1.2.1 ", "2. ", "2.1 ", "2.1.1 "],
  );
});

test("H3 before H2 is rejected", () => {
  assert.throws(() => numberHeadings([{ level: 3, title: "orphan" }]), /H3 出现前必须先有 H2/);
});

test("Chinese numeral conversion rejects values above 99", () => {
  assert.throws(() => toChineseNumeral(100), /exceeds supported Chinese numbering range/);
});
