/**
 * Lazy-load invariant: importing the package root (`index.mjs`) must NOT pull
 * in the heavy HTML layer (`html.mjs` and its remark/rehype/unified graph,
 * ~200ms of module-load time). The root only `await import()`s that module
 * inside `sanitize({ html: true })`; everything it re-exports at module scope —
 * including the Layer 2/3 pre-gates — comes from the dependency-free
 * `gates.mjs`, never from `html.mjs`.
 *
 * This is the entire rationale for extracting `gates.mjs`, so it gets a
 * behavioral guard: a future `export … from "./html.mjs"` slipped into
 * `index.mjs` would silently reintroduce the eager load, and only this test
 * would catch it. We record the real module-resolution graph via a `module`
 * customization hook rather than grepping source, so the assertion tracks what
 * actually loads, not what the imports happen to look like.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const srcUrl = (file) =>
  new URL(`../src/${file}`, import.meta.url).href.replace(/"/g, '\\"');

// The heavy graph that the Layer-1 path must never trigger: the lazy `html.mjs`
// module itself and every dependency only it pulls in.
const HEAVY = /(?:\/html\.mjs$)|remark|rehype|unified|unist|style-to-object/;

// Run `import(entryUrl)` in a fresh process under a resolve hook that appends
// every resolved module URL to `outPath`. The hook runs off-thread, but module
// resolution is awaited by the importer, so once `await import()` returns the
// file holds the complete graph — no timing race.
function resolvedGraph(entryUrl) {
  const outPath = path.join(
    os.tmpdir(),
    `llm-sanitizer-graph-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const hookSrc = [
    'import { appendFileSync } from "node:fs";',
    "let outPath;",
    "export async function initialize(data) { outPath = data.outPath; }",
    "export async function resolve(specifier, context, next) {",
    "  const result = await next(specifier, context);",
    "  appendFileSync(outPath, result.url + String.fromCharCode(10));",
    "  return result;",
    "}",
  ].join("\n");
  const runner = [
    'import { register } from "node:module";',
    `register("data:text/javascript,${encodeURIComponent(hookSrc)}", {`,
    "  parentURL: import.meta.url,",
    `  data: { outPath: ${JSON.stringify(outPath)} },`,
    "});",
    `await import("${entryUrl}");`,
  ].join("\n");
  execFileSync(process.execPath, ["--input-type=module", "-e", runner], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  try {
    return readFileSync(outPath, "utf8").split("\n").filter(Boolean);
  } finally {
    rmSync(outPath, { force: true });
  }
}

describe("lazy-load invariant", () => {
  it("importing the package root does not load the HTML/remark graph", () => {
    const graph = resolvedGraph(srcUrl("index.mjs"));
    // Positive markers: the recorder works and the root graph really loaded —
    // so a clean negative result below is "heavy graph absent", not "hook dead".
    assert.ok(
      graph.some((url) => url.endsWith("/index.mjs")),
      "recorder saw no index.mjs — the resolve hook is not working",
    );
    assert.ok(
      graph.some((url) => url.endsWith("/gates.mjs")),
      "root did not load gates.mjs — pre-gate re-export path changed",
    );
    const leaked = graph.filter((url) => HEAVY.test(url));
    assert.deepEqual(
      leaked,
      [],
      `package root eagerly loaded the heavy HTML graph: ${leaked.join(", ")}`,
    );
  });

  it("importing the HTML subpath DOES load the remark graph (negative test is not vacuous)", () => {
    const graph = resolvedGraph(srcUrl("html.mjs"));
    assert.ok(
      graph.some((url) => HEAVY.test(url)),
      "html.mjs loaded none of the heavy deps — the leak detector can never fire, so the root test would pass vacuously",
    );
  });
});
