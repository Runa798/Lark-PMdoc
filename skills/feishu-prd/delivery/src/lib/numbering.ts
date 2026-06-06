// Deterministic heading numbering (plan D14).
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

/** Integer -> Chinese numeral. Covers 1..99 (enough for PRD top-level sections). */
export function toChineseNumeral(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`toChineseNumeral: expected positive integer, got ${n}`);
  if (n > 99) return String(n); // beyond realistic H1 count: fall back to digits
  if (n < 10) return CN_DIGITS[n]!;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const tensPart = tens === 1 ? "十" : `${CN_DIGITS[tens]!}十`;
  return ones === 0 ? tensPart : `${tensPart}${CN_DIGITS[ones]!}`;
}

/** Assign D14 numbering to a flat, document-order sequence of headings. */
export function numberHeadings(headings: readonly Heading[]): NumberedHeading[] {
  let h1 = 0;
  let h2 = 0; // global running counter, never reset
  let h3 = 0;
  let h4 = 0;
  let h5 = 0;

  return headings.map((h) => {
    let prefix: string;
    switch (h.level) {
      case 1:
        h1 += 1;
        prefix = `${toChineseNumeral(h1)}、`;
        break;
      case 2:
        h2 += 1;
        h3 = 0;
        h4 = 0;
        h5 = 0;
        prefix = `${h2}. `;
        break;
      case 3:
        h3 += 1;
        h4 = 0;
        h5 = 0;
        prefix = `${h2}.${h3} `;
        break;
      case 4:
        h4 += 1;
        h5 = 0;
        prefix = `${h2}.${h3}.${h4} `;
        break;
      case 5:
        h5 += 1;
        prefix = `${h2}.${h3}.${h4}.${h5} `;
        break;
    }
    return { ...h, prefix, numbered: `${prefix}${h.title}` };
  });
}
