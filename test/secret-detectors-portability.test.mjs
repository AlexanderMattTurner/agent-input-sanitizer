import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { matchesSecretHint } from "../src/gates.mjs";

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

/**
 * SSOT-coverage contract: the JS pre-gate `matchesSecretHint` (gates.mjs
 * `SECRET_HINT`/`SECRET_HINT_EXT`) MUST fire on every credential shape the
 * Python detect-secrets SSOT recognizes. `SECRET_HINT` cannot be *derived* from
 * the SSOT at this layer — the JSON is not shipped in the npm package (see
 * package.json `files`), `gates.mjs` is deliberately dependency-free and on the
 * lazy-load root path, and the pre-gate is intentionally a *broader, shorter-run
 * superset* (it also covers AWS `AKIA…`, JWT `eyJ…`, Slack `xox…`, Stripe
 * `sk_live_`, bare keywords, … that are not detectors here) whose run lengths
 * are trimmed for ReDoS-safety; a mechanical projection would either drop those
 * arms or risk widening a precision-critical path. So the two are pinned by this
 * contract instead: it enumerates the live SSOT and fails the moment a detector
 * is added/changed without a matching pre-gate arm, killing the silent-drift
 * hazard.
 *
 * Each canonical example is asserted to (a) match its own detector pattern —
 * anchoring it to the SSOT so a tightened detector regex breaks the test rather
 * than passing vacuously — and (b) trip `matchesSecretHint`, proving pre-gate
 * coverage. The example map must cover EXACTLY the live detector set, so adding
 * a detector to the JSON without wiring the pre-gate fails CI here.
 */
const rep = (/** @type {number} */ n) => "A".repeat(n);
const hex = (/** @type {number} */ n) =>
  "a1b2".repeat(Math.ceil(n / 4)).slice(0, n);

// `${const}[${patternIndex}]` -> a string that matches THAT pattern and is a
// realistic credential-shaped value. Keyed per PATTERN, not per detector, so a
// detector with several distinct shapes (e.g. GitLab's glpat-/glcbt-) is covered
// shape-by-shape. Keep in lockstep with the SSOT via the assertions below (never
// hand-loosen an example to dodge a failure — extend the pre-gate instead).
/** @type {Record<string, string>} */
const PATTERN_EXAMPLES = {
  "AnthropicApiKeyDetector[0]": `sk-ant-api03-${rep(93)}AA`,
  "GoogleApiKeyDetector[0]": `AIza${rep(35)}`,
  "DigitalOceanTokenDetector[0]": `dop_v1_${hex(64)}`,
  "CloudflareOriginCaKeyDetector[0]": `v1.0-${hex(24)}-${hex(146)}`,
  "VaultTokenDetector[0]": `hvs.${rep(90)}`,
  "HashiCorpTerraformTokenDetector[0]": `${rep(14)}.atlasv1.${rep(60)}`,
  "GitHubFineGrainedPatDetector[0]": `github_pat_${rep(82)}`,
  "OpenRouterApiKeyDetector[0]": `sk-or-v1-${hex(64)}`,
  "GroqApiKeyDetector[0]": `gsk_${rep(32)}`,
  "XaiApiKeyDetector[0]": `xai-${rep(40)}`,
  "ReplicateApiTokenDetector[0]": `r8_${rep(37)}`,
  "GitHubClassicTokenDetector[0]": `ghp_${rep(36)}`,
  "GitLabAccessTokenDetector[0]": `glpat-${rep(30)}`,
  "GitLabAccessTokenDetector[1]": `glcbt-ab_${rep(30)}`,
};

// [label, pattern, example] for every pattern in the SSOT, so completeness and
// coverage are enforced pattern-by-pattern.
const PATTERN_CASES = detectors.flatMap((d) =>
  d.patterns.map((p, i) => {
    const label = `${d.const}[${i}]`;
    return [label, p, PATTERN_EXAMPLES[label]];
  }),
);

describe("JS pre-gate covers every detect-secrets SSOT pattern", () => {
  it("example map covers exactly the live pattern set (no missing/stale)", () => {
    const liveLabels = PATTERN_CASES.map(([label]) => label).sort();
    const mappedLabels = Object.keys(PATTERN_EXAMPLES).sort();
    assert.deepEqual(
      mappedLabels,
      liveLabels,
      "PATTERN_EXAMPLES must map exactly the patterns in secret-detectors.json — a mismatch means a detector/pattern was added or removed without wiring the JS SECRET_HINT pre-gate",
    );
  });

  for (const [label, pattern, example] of PATTERN_CASES) {
    it(`${label}: example matches its SSOT pattern (non-vacuity)`, () => {
      assert.ok(example !== undefined, `no example for ${label}`);
      assert.ok(
        new RegExp(pattern).test(example),
        `example for ${label} no longer matches its detector pattern — update the example to a real match`,
      );
    });

    it(`${label}: a matching credential trips matchesSecretHint`, () => {
      assert.ok(
        matchesSecretHint(example),
        `SECRET_HINT does not cover ${label} — add its shape to gates.mjs so the Layer-3 URL-exfil pre-gate can't silently miss a credential shape the SSOT recognizes`,
      );
    });
  }
});
