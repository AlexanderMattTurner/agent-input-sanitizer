/**
 * Static inventory of every regex in src/*.mjs, for the JS-side ReDoS guard
 * (tests/test_redos_js_static_guard.py). Parses each source with the
 * TypeScript compiler (a dev dependency — a real JS parser, not a hand-rolled
 * regex-over-regex approximation) and emits, as JSON on stdout:
 *
 *   [{ "file": "src/html.mjs", "line": 12, "pattern": "...", "flags": "..." }]
 *
 * Collected forms:
 *   - regex literals: /pattern/flags
 *   - `new RegExp("pattern")` / `RegExp("pattern", "flags")` where the pattern
 *     is a plain string literal (a dynamically built pattern has no static
 *     text to analyze; none exist in src/ today, and the paired guard test
 *     asserts the total inventory count so a new dynamic construction site
 *     shows up as a count change, not a silent hole).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");

/** @type {{file: string, line: number, pattern: string, flags: string}[]} */
const found = [];

for (const name of readdirSync(srcDir).sort()) {
  if (!name.endsWith(".mjs")) continue;
  const rel = `src/${name}`;
  const text = readFileSync(join(srcDir, name), "utf8");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true);

  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      const lastSlash = node.text.lastIndexOf("/");
      found.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        pattern: node.text.slice(1, lastSlash),
        flags: node.text.slice(lastSlash + 1),
      });
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "RegExp" &&
      node.arguments?.length &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const flagsArg = node.arguments[1];
      found.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        pattern: node.arguments[0].text,
        flags:
          flagsArg && ts.isStringLiteralLike(flagsArg) ? flagsArg.text : "",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

process.stdout.write(JSON.stringify(found, null, 2) + "\n");
