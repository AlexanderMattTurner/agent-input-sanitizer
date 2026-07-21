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

// const -> a string that matches that detector's pattern AND is a realistic
// credential-shaped value. Keep in lockstep with the SSOT via the assertions
// below (never hand-loosen an example to dodge a failure — fix the pre-gate).
/** @type {Record<string, string>} */
const DETECTOR_EXAMPLES = {
  AnthropicApiKeyDetector: `sk-ant-api03-${rep(93)}AA`,
  GoogleApiKeyDetector: `AIza${rep(35)}`,
  DigitalOceanTokenDetector: `dop_v1_${hex(64)}`,
  CloudflareOriginCaKeyDetector: `v1.0-${hex(24)}-${hex(146)}`,
  VaultTokenDetector: `hvs.${rep(90)}`,
  HashiCorpTerraformTokenDetector: `${rep(14)}.atlasv1.${rep(60)}`,
  GitHubFineGrainedPatDetector: `github_pat_${rep(82)}`,
  OpenRouterApiKeyDetector: `sk-or-v1-${hex(64)}`,
  GroqApiKeyDetector: `gsk_${rep(32)}`,
  XaiApiKeyDetector: `xai-${rep(40)}`,
  ReplicateApiTokenDetector: `r8_${rep(37)}`,
  GitHubClassicTokenDetector: `ghp_${rep(36)}`,
  GitLabAccessTokenDetector: `glpat-${rep(30)}`,
};

describe("JS pre-gate covers every detect-secrets SSOT detector", () => {
  it("example map covers exactly the live detector set (no missing/stale)", () => {
    const liveConsts = detectors.map((d) => d.const).sort();
    const mappedConsts = Object.keys(DETECTOR_EXAMPLES).sort();
    assert.deepEqual(
      mappedConsts,
      liveConsts,
      "DETECTOR_EXAMPLES must map exactly the detectors in secret-detectors.json — a mismatch means a detector was added/removed without wiring the JS SECRET_HINT pre-gate",
    );
  });

  for (const detector of detectors) {
    const example = DETECTOR_EXAMPLES[detector.const];
    it(`${detector.const}: example matches its SSOT pattern (non-vacuity)`, () => {
      assert.ok(example !== undefined, `no example for ${detector.const}`);
      const matched = detector.patterns.some((/** @type {string} */ p) =>
        new RegExp(p).test(example),
      );
      assert.ok(
        matched,
        `example for ${detector.const} no longer matches its detector pattern(s) — update the example to a real match`,
      );
    });

    it(`${detector.const}: a matching credential trips matchesSecretHint`, () => {
      assert.ok(
        matchesSecretHint(example),
        `SECRET_HINT does not cover ${detector.const} — add its shape to gates.mjs so the Layer-3 URL-exfil pre-gate can't silently miss a credential type the SSOT recognizes`,
      );
    });
  }
});
