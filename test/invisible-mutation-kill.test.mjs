/**
 * Targeted mutation-kill tests for src/invisible.mjs.
 *
 * Each test pins the EXACT behavior at a branch/boundary a currently-surviving
 * Stryker mutant changes, exercised only through the public exported API. The
 * comment above each block names the mutant(s) it targets (line + mutator).
 * All assertions pass on the unmutated source.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  stripInvisible,
  stripInvisibleWithReport,
  payloadInvisibleView,
} from "../src/invisible.mjs";
import { cp } from "./test-helpers.mjs";

const ZWNJ = cp(0x200c);
const ZWJ = cp(0x200d);
const HANGUL_FILLER = cp(0x115f); // a Hangul filler; needs a Hangul anchor to survive

// ─── isCjkIdeograph END boundary (line 364: `cp <= end` → `cp < end`) ──────────
// An ideographic variation selector (U+E0100) is preserved only after a CJK
// ideograph. Base U+9FFF is the LAST code point of the CJK Unified block, so a
// `cp <= end` → `cp < end` mutant stops recognizing it and strips the selector.
describe("mutation-kill: isCjkIdeograph end boundary", () => {
  it("preserves an ideographic selector after U+9FFF (Unified block end)", () => {
    const input = cp(0x9fff) + cp(0xe0100);
    const { cleaned, found } = stripInvisibleWithReport(input);
    assert.equal(cleaned, input);
    assert.deepEqual(found, []);
  });
});

// ─── isBrahmicConsonant END boundary (line 396: `cp <= end` → `cp < end`) ──────
// A ZWJ after a virama is preserved only when the virama sits on a real Brahmic
// consonant. U+0939 (HA) is the LAST of the Devanagari KA–HA span, so the end
// mutant strips the conjunct joiner.
describe("mutation-kill: isBrahmicConsonant end boundary", () => {
  it("preserves a ZWJ conjunct on U+0939 HA (Devanagari KA–HA end)", () => {
    const input = cp(0x939) + cp(0x94d) + ZWJ + cp(0x915);
    const { cleaned, found } = stripInvisibleWithReport(input);
    assert.equal(cleaned, input);
    assert.deepEqual(found, []);
  });
});

// ─── isBrailleCell range (line 421: `cp <= 0x28ff`/`cp >= 0x2801`) ─────────────
// A U+2800 BRAILLE PATTERN BLANK is preserved only next to a real (non-blank)
// Braille cell. Pin both ends of the anchor range so `cp <= 0x28ff` → `cp <
// 0x28ff` (end) and `cp >= 0x2801` → `cp > 0x2801` (start) both strip the blank.
describe("mutation-kill: isBrailleCell anchor range", () => {
  for (const [label, anchor] of [
    ["first cell U+2801", 0x2801],
    ["last cell U+28FF", 0x28ff],
  ]) {
    it(`preserves a U+2800 blank anchored by the ${label}`, () => {
      const input = cp(anchor) + cp(0x2800);
      const { cleaned, found } = stripInvisibleWithReport(input);
      assert.equal(cleaned, input);
      assert.deepEqual(found, []);
    });
  }
});

// ─── isHangul range boundaries (lines 430-435) ────────────────────────────────
// A Hangul filler is preserved only next to a real Hangul jamo/syllable. Each
// entry pins the FIRST and LAST code point of one isHangul range, killing the
// per-range EqualityOperator mutants (`cp >= start`→`cp > start`, `cp <=
// end`→`cp < end`), the ConditionalExpression `false` mutants (a whole range
// forced false), and the LogicalOperator `||`→`&&` mutants across ranges (an
// anchor in exactly one range would fail an AND-joined chain). The filler is
// placed BEFORE the anchor (prev=""), so this also kills line 781's `isHangul(prev)
// || isHangul(next)` → `&&`.
describe("mutation-kill: isHangul range boundaries", () => {
  const ranges = [
    ["Hangul Jamo", 0x1100, 0x11ff], // line 430
    ["Hangul Compatibility Jamo", 0x3130, 0x318f], // line 431
    ["Jamo Extended-A", 0xa960, 0xa97f], // line 432
    ["Hangul Syllables", 0xac00, 0xd7a3], // line 433
    ["Jamo Extended-B", 0xd7b0, 0xd7ff], // line 434
    ["Halfwidth Jamo", 0xffa1, 0xffdc], // line 435
  ];
  for (const [name, start, end] of ranges) {
    for (const [where, anchor] of [
      ["start", start],
      ["end", end],
    ]) {
      const hex = anchor.toString(16).toUpperCase();
      it(`preserves a Hangul filler anchored by ${name} ${where} U+${hex}`, () => {
        const input = HANGUL_FILLER + cp(anchor);
        const { cleaned, found } = stripInvisibleWithReport(input);
        assert.equal(cleaned, input);
        assert.deepEqual(found, []);
      });
    }
  }
});

// ─── isPreservedJoiner ZWJ single-neighbour rule ──────────────────────────────
// (line 557: `cp === ZWNJ ? lc && rc : lc || rc` — ConditionalExpression `true`
//  and LogicalOperator `lc && rc`). A ZWJ forces a connected form and is kept
//  with a cursive letter on just ONE side. beh (D) · ZWJ · hamza (U): lc=true,
//  rc=false, so `lc || rc` preserves it; a `lc && rc` mutant would strip it.
describe("mutation-kill: ZWJ preserved with a single cursive neighbour", () => {
  it("preserves a ZWJ between beh (cursive) and hamza (non-joining)", () => {
    const input = cp(0x628) + ZWJ + cp(0x621);
    const { cleaned, found } = stripInvisibleWithReport(input);
    assert.equal(cleaned, input);
    assert.deepEqual(found, []);
  });
});

// ─── isCursiveLetter (line 462: ConditionalExpression `false`, StringLiteral) ──
// A ZWNJ between two cursive letters is preserved. beh · ZWNJ · beh (both
// Joining_Type D): if isCursiveLetter is forced false (or its "D" literal is
// blanked), lc/rc collapse to false and the ZWNJ is stripped.
describe("mutation-kill: isCursiveLetter recognizes D-type letters", () => {
  it("preserves a ZWNJ between two beh letters (both Joining_Type D)", () => {
    const input = cp(0x628) + ZWNJ + cp(0x628);
    const { cleaned, found } = stripInvisibleWithReport(input);
    assert.equal(cleaned, input);
    assert.deepEqual(found, []);
  });
});

// ─── payloadInvisibleView (lines 933-935) ─────────────────────────────────────
// Visible code points map to a space, PAYLOAD invisibles pass through verbatim.
// Kills: line 933 `let out = ""` (StringLiteral prefix), line 934 `i <
// cps.length`→`i <= cps.length` (a trailing extra char), line 935
// ConditionalExpression `true` (would echo visibles) and the `" "` StringLiteral
// (would blank them).
describe("mutation-kill: payloadInvisibleView masking", () => {
  it("maps visibles to spaces and keeps a payload ZWSP in place", () => {
    const input = "a" + cp(0x200b) + "b"; // ZWSP is Cf payload (not carve-preserved)
    assert.equal(payloadInvisibleView(input), " " + cp(0x200b) + " ");
  });

  it("returns exactly one space per visible char (length-exact)", () => {
    assert.equal(payloadInvisibleView("ab"), "  ");
  });
});

// ─── stripInvisibleWithReport leading-BOM guard (line 960: Conditional `true`) ─
// hasLeadingBom must be false for text with no leading U+FEFF; a Conditional
// `true` mutant would always slice off the first char and re-prepend a BOM.
describe("mutation-kill: no spurious leading-BOM handling", () => {
  it("leaves BOM-free text and its first char untouched", () => {
    assert.equal(stripInvisible("abc"), "abc");
    const { cleaned } = stripInvisibleWithReport("hello");
    assert.equal(cleaned, "hello");
  });
});

// ─── tag-sequence decode + registration (line 715 arithmetic; preserve path) ──
// A registered subregional flag is preserved verbatim. Tag chars decode as
// `cp − 0xE0000`; a `+ 0xE0000` mutant garbles the payload so it no longer names
// a registered subdivision and the flag's tag run is stripped.
describe("mutation-kill: registered flag tag sequence preserved", () => {
  it("preserves the Scotland flag (🏴 gbsct CANCEL) verbatim", () => {
    const flag =
      cp(0x1f3f4) +
      [..."gbsct"].map((c) => cp(0xe0000 + c.charCodeAt(0))).join("") +
      cp(0xe007f);
    const { cleaned, found } = stripInvisibleWithReport(flag);
    assert.equal(cleaned, flag);
    assert.deepEqual(found, []);
  });
});
