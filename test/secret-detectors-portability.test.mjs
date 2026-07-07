import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * data/secret-detectors.json declares (in its own `description`) that every
 * detector pattern stays portable to JavaScript `RegExp` so a JS consumer can
 * share the set. This test is that guarantee: it loads the same file the Python
 * engine loads and validates each pattern with the REAL JS parser rather than a
 * Python-side re-approximation of JS's grammar.
 *
 * Two gates, because compiling is necessary but not sufficient:
 *   1. `new RegExp(pattern)` — the authoritative syntax gate. Python-only
 *      constructs (named groups, inline flags, atomic groups `(?>…)`,
 *      possessive quantifiers `x*+`, conditionals `(?(1)…)`, inline comments
 *      `(?#…)`) throw here, so any of them fails the suite.
 *   2. A textual `\A` / `\Z` guard — these two COMPILE in JS but silently
 *      diverge: JS reads `\A`/`\Z` as the literals "A"/"Z", not Python's
 *      start/end anchors. The parser can't flag a compile-but-diverge construct,
 *      so it needs an explicit text check.
 */

const DETECTORS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "python",
  "agent_input_sanitizer",
  "secrets",
  "data",
  "secret-detectors.json",
);

const detectors = JSON.parse(readFileSync(DETECTORS_FILE, "utf8")).detectors;

// [label, pattern] for every pattern across every detector, so a failure names
// which entry broke.
const PATTERNS = detectors.flatMap((d) =>
  d.patterns.map((p, i) => [`${d.const}[${i}]`, p]),
);

// `\A` and `\Z` compile in JS but mean the literal letter, not Python's anchors.
const SEMANTIC_DIVERGENCE = /\\[AZ]/;

describe("secret-detectors.json patterns are JS-portable", () => {
  it("has patterns to check (non-vacuity)", () => {
    assert.ok(PATTERNS.length > 0, "no detector patterns loaded");
  });

  for (const [label, pattern] of PATTERNS) {
    it(`${label} compiles under JS RegExp`, () => {
      assert.doesNotThrow(
        () => new RegExp(pattern),
        `pattern is not valid JavaScript RegExp: ${pattern}`,
      );
    });

    it(`${label} avoids the \\A/\\Z semantic-divergence trap`, () => {
      assert.equal(
        SEMANTIC_DIVERGENCE.test(pattern),
        false,
        `pattern uses \\A or \\Z, which JS reads as a literal, not an anchor: ${pattern}`,
      );
    });
  }
});
