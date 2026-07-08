#!/usr/bin/env node
/**
 * Expand the declarative mutation-shard config into a concrete shard matrix.
 *
 * `.github/mutation-shards.json` declares WHICH files to mutate, not the exact
 * line ranges: big files listed under `split` are chunked into `splitEvery`-line
 * slices computed from the file's CURRENT length, and every entry under `groups`
 * is a hand-balanced whole-file (or multi-file) shard. Deriving the ranges at CI
 * time means a growing file automatically gets more shards — no hand re-tiling,
 * and no shard can silently drift past the file's end.
 *
 * Both the workflow (to build the job matrix) and aggregate-mutation.mjs (to
 * demand one report per shard) call this on the same checkout, so the shard set
 * and its count are guaranteed identical — the gate can never score a subset.
 *
 * Usage: node expand-shards.mjs   → prints the shard array as JSON to stdout.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The open-ended sentinel the last slice of a split file uses so lines beyond
// the computed boundary (e.g. appended between checkout and Stryker's read) are
// still mutated. Mirrors Stryker's `file:start-end` --mutate syntax.
export const EOF_SENTINEL = 99999;

/**
 * @param {string} repoRoot absolute path to the repository root
 * @returns {{ id: string, mutate: string }[]} concrete shards for the matrix
 */
export function expandShards(repoRoot) {
  const config = JSON.parse(
    readFileSync(join(repoRoot, ".github", "mutation-shards.json"), "utf8"),
  );
  const { splitEvery } = config;
  if (!Number.isInteger(splitEvery) || splitEvery <= 0) {
    throw new Error(
      `mutation-shards.json splitEvery must be a positive integer, got ${JSON.stringify(splitEvery)}`,
    );
  }

  const shards = [];
  for (const { id, file } of config.split ?? []) {
    const lineCount = readFileSync(join(repoRoot, file), "utf8").split(
      "\n",
    ).length;
    const chunks = Math.max(1, Math.ceil(lineCount / splitEvery));
    for (let i = 0; i < chunks; i++) {
      const start = i * splitEvery + 1;
      // The last chunk ends open so the tail is always covered even if the file
      // grew past the last boundary since this expansion was computed.
      const end = i === chunks - 1 ? EOF_SENTINEL : (i + 1) * splitEvery;
      shards.push({ id: `${id}-${i + 1}`, mutate: `${file}:${start}-${end}` });
    }
  }
  for (const group of config.groups ?? []) {
    shards.push({ id: group.id, mutate: group.mutate });
  }
  return shards;
}

// Print the matrix only when run directly (not when imported by the aggregator).
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  process.stdout.write(JSON.stringify(expandShards(repoRoot)));
}
