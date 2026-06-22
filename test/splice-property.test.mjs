/**
 * Fast-check property tests for `spliceRanges` — the byte-exactness core of
 * Layer 2. The AST path only ever feeds it disjoint, in-bounds ranges, so its
 * documented defense-in-depth behavior (merging overlapping/nested/adjacent/
 * duplicate ranges) is otherwise unexercised. The headline invariant is the
 * Layer-2 promise: every byte *outside* the union of ranges is preserved
 * verbatim, in order.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  spliceRanges,
  COMMENT_PLACEHOLDER,
  HIDDEN_PLACEHOLDER,
} from "../src/html.mjs";
import { fcRunOptions } from "./test-helpers.mjs";

const runOptions = fcRunOptions({ numRuns: 500 });

// Text drawn from chars that can never form a placeholder. Both placeholders
// begin with "[", which this alphabet excludes, so any "[" in the output is an
// inserted placeholder — letting us strip placeholders unambiguously and
// compare what remains against the kept bytes computed independently.
const safeChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789 .,_-".split(""),
);
const safeText = fc
  .array(safeChar, { minLength: 0, maxLength: 60 })
  .map((chars) => chars.join(""));

// A range generator parameterized on the text length: 0 <= start <= end <= len,
// kind comment|hidden. Overlaps/nesting/adjacency/duplicates arise naturally.
const rangesFor = (len) =>
  fc.array(
    fc
      .tuple(
        fc.integer({ min: 0, max: len }),
        fc.integer({ min: 0, max: len }),
        fc.constantFrom(/** @type {const} */ ("comment"), "hidden"),
      )
      .map(([a, b, kind]) => ({
        start: Math.min(a, b),
        end: Math.max(a, b),
        kind,
      })),
    { maxLength: 6 },
  );

const stripPlaceholders = (text) =>
  text.split(COMMENT_PLACEHOLDER).join("").split(HIDDEN_PLACEHOLDER).join("");

// Independent (set-union, not the merge algorithm) computation of the bytes
// that must survive: every index not covered by any range, in order.
const keptBytes = (text, ranges) => {
  const covered = new Array(text.length).fill(false);
  for (const { start, end } of ranges)
    for (let i = start; i < end; i++) covered[i] = true;
  let out = "";
  for (let i = 0; i < text.length; i++) if (!covered[i]) out += text[i];
  return out;
};

describe("property: spliceRanges preserves bytes outside the ranges", () => {
  it("removing placeholders from the output yields exactly the kept bytes", () => {
    fc.assert(
      fc.property(
        safeText.chain((text) =>
          fc.tuple(fc.constant(text), rangesFor(text.length)),
        ),
        ([text, ranges]) => {
          const out = spliceRanges(text, ranges);
          assert.equal(stripPlaceholders(out), keptBytes(text, ranges));
        },
      ),
      runOptions,
    );
  });

  it("is a no-op when given no ranges", () => {
    fc.assert(
      fc.property(safeText, (text) => {
        assert.equal(spliceRanges(text, []), text);
      }),
      runOptions,
    );
  });

  it("never throws and returns a string even for out-of-bounds ranges", () => {
    fc.assert(
      fc.property(
        safeText.chain((text) =>
          fc.tuple(
            fc.constant(text),
            fc.array(
              fc
                .tuple(
                  fc.integer({ min: 0, max: text.length + 10 }),
                  fc.integer({ min: 0, max: text.length + 10 }),
                  fc.constantFrom(/** @type {const} */ ("comment"), "hidden"),
                )
                .map(([a, b, kind]) => ({
                  start: Math.min(a, b),
                  end: Math.max(a, b),
                  kind,
                })),
              { maxLength: 6 },
            ),
          ),
        ),
        ([text, ranges]) => {
          assert.equal(typeof spliceRanges(text, ranges), "string");
        },
      ),
      runOptions,
    );
  });
});
