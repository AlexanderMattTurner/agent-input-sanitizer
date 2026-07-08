// @ts-check
"use strict";

const fs = require("fs");

const LABEL = "nightly-fuzz";
const LOG_FILE = "fuzz-output.log";
// Keep the issue body bounded: the tail of the run holds fast-check's
// counterexample + seed, which is what makes the failure reproducible.
const MAX_TAIL_LINES = 80;
const MAX_TAIL_CHARS = 6000;

/**
 * Open (or update) a single rollup issue when the nightly unseeded fuzz run
 * finds a failing input. Called by fuzz-nightly.yaml via actions/github-script
 * only on failure. Idempotent: one open `nightly-fuzz` issue at a time — later
 * failures append a comment rather than spawning duplicates.
 *
 * @param {object} params
 * @param {import("@octokit/rest").Octokit} params.github
 * @param {object} params.context - GitHub Actions run context
 * @param {{ notice(msg: string): void }} params.core
 */
module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  let log = "";
  try {
    log = fs.readFileSync(LOG_FILE, "utf8");
  } catch {
    log = "";
  }
  const tail =
    log.split("\n").slice(-MAX_TAIL_LINES).join("\n").slice(-MAX_TAIL_CHARS) ||
    "(no test output was captured)";

  const body = [
    "The nightly unseeded fuzz run (`fuzz-nightly.yaml`) hit a failing input.",
    "",
    "Unlike PR CI, this run lets fast-check pick its own random seed, so it " +
      "explores inputs the fixed-seed PR runs never try. A failure here means " +
      '"go look" — reproduce locally by re-running the failing suite with the ' +
      "seed fast-check prints below.",
    "",
    `- Run: ${runUrl}`,
    "",
    "```",
    tail,
    "```",
  ].join("\n");

  const existing = await github.rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
    labels: LABEL,
    per_page: 1,
  });

  if (existing.data.length > 0) {
    const issueNumber = existing.data[0].number;
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    core.notice(
      `Appended nightly fuzz failure to existing issue #${issueNumber}`,
    );
    return;
  }

  const created = await github.rest.issues.create({
    owner,
    repo,
    title: "Nightly fuzz found a failing input",
    body,
    labels: [LABEL],
  });
  core.notice(`Opened nightly fuzz issue #${created.data.number}`);
};
