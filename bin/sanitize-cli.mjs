#!/usr/bin/env node
/**
 * Single-source-of-truth CLI over `sanitize()` for non-JS pipelines.
 *
 * The sanitization logic lives once, in `src/`. This CLI is the supported
 * escape hatch for callers that can't import the JavaScript directly (a Python
 * pipeline, say): it speaks JSON over stdin/stdout so any language can drive the
 * exact same verdicts without a second implementation to keep in sync.
 *
 * Protocol — a request is a JSON object `{ "text": string, "html"?: boolean }`;
 * a success response is `{ "cleaned", "found", "warnings" }` (the `sanitize`
 * return shape) and a failure response is `{ "error": string }`. Two modes,
 * same binary:
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

/**
 * Run one request through `sanitize` and serialize the response.
 * Throws on a malformed request (non-string `text`); the caller decides whether
 * that propagates (one-shot) or becomes an `{ error }` line (worker).
 * @param {string} payload  a single JSON request object
 * @returns {Promise<string>} a single-line JSON response
 */
async function handle(payload) {
  const request = JSON.parse(payload);
  if (typeof request.text !== "string")
    throw new Error("request.text must be a string");
  const { cleaned, found, warnings } = await sanitize(request.text, {
    html: Boolean(request.html),
  });
  return JSON.stringify({ cleaned, found, warnings });
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
