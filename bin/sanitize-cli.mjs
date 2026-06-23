#!/usr/bin/env node
/**
 * Single-source-of-truth CLI over the sanitizer's data-in/data-out entry points,
 * for non-JS pipelines.
 *
 * The logic lives once, in `src/`. This CLI is the supported escape hatch for
 * callers that can't import the JavaScript directly (a Python pipeline, say): it
 * speaks JSON over stdin/stdout so any language drives the exact same verdicts
 * without a second implementation to keep in sync. Only the entry points with no
 * injected callback are exposed — the agent-pipeline seams that take a homoglyph
 * scanner, redactor, or file-access object have no language-agnostic wire form
 * and stay JS-only.
 *
 * Protocol — a request is a JSON object with an `op` (default `"sanitize"` so a
 * bare `{ text, html }` keeps working). Per op:
 *
 *   sanitize           { text, html? }            -> { cleaned, found, warnings }
 *   sanitizeText       { text, html?, exfilScan? } -> { cleaned, warnings, modified, sgrNote }
 *   classifyPrompt     { text }                    -> { action, reason? }
 *   scanInstructionFiles { globs, cwd? }           -> { findings: [{ file, findings }] }
 *   cleanFile          { path }                    -> { changed }
 *
 * A failure response is `{ "error": string }`. Two modes, same binary:
 *
 *   one-shot (default): read ONE JSON object from stdin (may span lines), write
 *     ONE response line. A malformed request propagates — non-zero exit, stack
 *     on stderr — so a scripted caller fails loudly.
 *
 *   worker (`--worker`): read newline-delimited JSON requests until EOF, write
 *     one response line per request, in order. A malformed request yields an
 *     `{ "error" }` line and the worker keeps serving — the specific, necessary
 *     recovery that makes a long-lived process usable across independent
 *     requests (one bad line must not drop the whole pipe). JSON string-encodes
 *     every newline, so one request and one response always occupy one line each.
 */
import process from "node:process";
import readline from "node:readline";

import { sanitize } from "../src/index.mjs";

/** @param {Record<string, unknown>} req @param {string} key */
function requireString(req, key) {
  if (typeof req[key] !== "string")
    throw new Error(`request.${key} must be a string`);
}

/** Operations the CLI exposes. Each takes the parsed request, returns the JSON
 * payload object. Non-`sanitize` modules are imported lazily so a caller that
 * only ever sanitizes never loads prompt/output/instructions code. */
const OPS = {
  async sanitize(req) {
    requireString(req, "text");
    const { cleaned, found, warnings } = await sanitize(req.text, {
      html: Boolean(req.html),
    });
    return { cleaned, found, warnings };
  },

  async sanitizeText(req) {
    requireString(req, "text");
    // Layers 1–3 only: redact (Layer 4) and filterInjection (Layer 5) are
    // injected JS callbacks with no wire form, so they're never set here.
    const { sanitizeText } = await import("../src/output.mjs");
    const { cleaned, warnings, modified, sgrNote } = await sanitizeText(
      req.text,
      {
        html: Boolean(req.html),
        exfilScan: Boolean(req.exfilScan),
      },
    );
    return { cleaned, warnings, modified, sgrNote };
  },

  async classifyPrompt(req) {
    requireString(req, "text");
    const { classifyPrompt } = await import("../src/prompt.mjs");
    return classifyPrompt(req.text);
  },

  async scanInstructionFiles(req) {
    if (
      !Array.isArray(req.globs) ||
      req.globs.some((g) => typeof g !== "string")
    )
      throw new Error("request.globs must be an array of strings");
    const { scanInstructionFiles } = await import("../src/instructions.mjs");
    const opts = typeof req.cwd === "string" ? { cwd: req.cwd } : {};
    return { findings: scanInstructionFiles(req.globs, opts) };
  },

  async cleanFile(req) {
    requireString(req, "path");
    const { cleanFile } = await import("../src/instructions.mjs");
    return { changed: cleanFile(req.path) };
  },
};

/**
 * Run one request through the named `op` and serialize the response.
 * Throws on a malformed request or unknown op; the caller decides whether that
 * propagates (one-shot) or becomes an `{ error }` line (worker).
 * @param {string} payload  a single JSON request object
 * @returns {Promise<string>} a single-line JSON response
 */
async function handle(payload) {
  const request = JSON.parse(payload);
  const op = request.op ?? "sanitize";
  const run = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
  if (!run) throw new Error(`unknown op: ${op}`);
  return JSON.stringify(await run(request));
}

/** @param {NodeJS.ReadableStream} stream */
async function readAll(stream) {
  stream.setEncoding("utf8");
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

async function runWorker() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  // `for await` drives lines sequentially, awaiting each `handle`, so responses
  // leave in request order. The try/catch is the worker's whole reason to
  // exist: a single malformed request reports an error and the loop continues
  // rather than tearing down a pipe other requests are still using.
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let response;
    try {
      response = await handle(line);
    } catch (err) {
      response = JSON.stringify({ error: err?.message ?? String(err) });
    }
    process.stdout.write(`${response}\n`);
  }
}

async function runOneShot() {
  // No try/catch: a bad request or a (contract-impossible) `sanitize` throw
  // propagates to a non-zero exit with the stack on stderr — fail loudly.
  const response = await handle(await readAll(process.stdin));
  process.stdout.write(`${response}\n`);
}

await (process.argv.includes("--worker") ? runWorker() : runOneShot());
