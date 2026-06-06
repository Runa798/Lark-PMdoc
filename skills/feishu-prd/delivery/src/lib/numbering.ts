// Deterministic heading numbering.
// The content layer emits headings WITHOUT numbers; this pass walks the heading
// sequence and assigns numbers so they are always globally consistent — never
// left to an LLM to count.
//
// Scheme:
//   H1 -> 一、二、三 …            (Chinese numerals, independent counter)
//   H2 -> 1. 2. 3. …             (single GLOBAL running counter; does NOT reset per H1)
//   H3 -> <h2>.<n>               (n resets per H2)         e.g. 1.1 1.2
//   H4 -> <h2>.<h3>.<n>          (n resets per H3)         e.g. 1.1.1
//   H5 -> <h2>.<h3>.<h4>.<n>     (n resets per H4)         e.g. 1.1.1.1

export type HeadingLevel = 1 | 2 | 3 | 4 | 5;

export interface Heading {
  readonly level: HeadingLevel;
  readonly title: string;
}

export interface NumberedHeading extends Heading {
  /** Number prefix without the title, e.g. "一、", "1. ", "1.2 ". */
  readonly prefix: string;
  /** prefix + title, ready to render as the heading block text. */
  readonly numbered: string;
}

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;

/** Integer -> Chinese numeral. Covers 1..99; larger H1 counts are rejected so callers fix the manifest instead of emitting Arabic H1 numbers. */
export function toChineseNumeral(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`toChineseNumeral: expected positive integer, got ${n}`);
  if (n > 99) throw new Error(`toChineseNumeral: H1 count ${n} exceeds supported Chinese numbering range 1..99`);
  if (n < 10) return CN_DIGITS[n]!;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const tensPart = tens === 1 ? "十" : `${CN_DIGITS[tens]!}十`;
  return ones === 0 ? tensPart : `${tensPart}${CN_DIGITS[ones]!}`;
}

/** Assign numbering to a flat, document-order sequence of headings. */
export function numberHeadings(headings: readonly Heading[]): NumberedHeading[] {
  let h1 = 0;
  let h2 = 0; // global running counter, never reset
  let h3 = 0;
  let h4 = 0;
  let h5 = 0;
  let hasCurrentH2 = false;
  let hasCurrentH3 = false;
  let hasCurrentH4 = false;

  return headings.map((h) => {
    let prefix: string;
    switch (h.level) {
      case 1:
        h1 += 1;
        h3 = 0;
        h4 = 0;
        h5 = 0;
        hasCurrentH2 = false;
        hasCurrentH3 = false;
        hasCurrentH4 = false;
        prefix = `${toChineseNumeral(h1)}、`;
        break;
      case 2:
        h2 += 1;
        h3 = 0;
        h4 = 0;
        h5 = 0;
        hasCurrentH2 = true;
        hasCurrentH3 = false;
        hasCurrentH4 = false;
        prefix = `${h2}. `;
        break;
      case 3:
        if (!hasCurrentH2) throw new Error("H3 出现前必须先有 H2");
        h3 += 1;
        h4 = 0;
        h5 = 0;
        hasCurrentH3 = true;
        hasCurrentH4 = false;
        prefix = `${h2}.${h3} `;
        break;
      case 4:
        if (!hasCurrentH3) throw new Error("H4 出现前必须先有 H3");
        h4 += 1;
        h5 = 0;
        hasCurrentH4 = true;
        prefix = `${h2}.${h3}.${h4} `;
        break;
      case 5:
        if (!hasCurrentH4) throw new Error("H5 出现前必须先有 H4");
        h5 += 1;
        prefix = `${h2}.${h3}.${h4}.${h5} `;
        break;
    }
    return { ...h, prefix, numbered: `${prefix}${h.title}` };
  });
}
