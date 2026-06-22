// @ts-check
"use strict";

const fs = require("fs");

const MIN_CONTENT_LENGTH = 10;
const PHONE_HOME_DIR = "/tmp/phone-home";

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Strip HTML comments to a fixed point. A single pass is incomplete: removing
 * one `<!-- ... -->` can splice its neighbours into a brand-new `<!--`
 * introducer the same pass already scanned past (e.g. `<!-<!-- -->->` →
 * `<!-->`), so iterate until the string stops changing. Each changed pass
 * consumes at least one comment, so the count is bounded by the input length.
 * @param {string} text
 * @returns {string}
 */
function stripHtmlComments(text) {
  let prev = text;
  let out = prev.replace(HTML_COMMENT_RE, "");
  while (out !== prev) {
    prev = out;
    out = prev.replace(HTML_COMMENT_RE, "");
  }
  return out;
}

/**
 * Extract "Lessons Learned" from a merged PR body, filter noise, and write
 * the cleaned text to a temp file for gitleaks scanning.
 *
 * Called by the phone-home workflow via actions/github-script.
 *
 * @param {object}  params
 * @param {object}  params.context  - GitHub Actions webhook event context
 * @param {{ setOutput(name: string, value: string): void }} params.core
 */
module.exports = async ({ context, core }) => {
  const prBody = context.payload.pull_request.body || "";
  const repo = `${context.repo.owner}/${context.repo.repo}`;
  const templateRepo = process.env.TEMPLATE_REPO;

  if (!templateRepo) {
    throw new Error("TEMPLATE_REPO env var is required");
  }

  if (repo === templateRepo) {
    console.log("This IS the template repo, skipping phone-home");
    return;
  }

  // Opening anchor allows only h2/h3 ("## "/"### ") so we extract lessons
  // written at heading level, not an inline "#### Lessons Learned" note. The
  // terminating lookahead is deliberately wider (#{2,6}) so ANY following
  // heading ends the section. Don't widen the opening anchor to match.
  const lessonsMatch = prBody.match(
    /(?:^|\n)#{2,3} Lessons Learned[ \t]*\n([\s\S]*?)(?=\n#{2,6} |\n---|\s*$)/i,
  );
  if (!lessonsMatch) {
    console.log(
      'No "Lessons Learned" section found in PR body, skipping phone-home',
    );
    return;
  }

  const lessons = lessonsMatch[1].trim();
  if (!lessons || lessons.length < MIN_CONTENT_LENGTH) {
    console.log("Lessons section is empty or too short, skipping");
    return;
  }

  // Strip HTML comments first with a newline-aware pattern so multi-line
  // <!-- ... --> placeholders are removed too (a per-line /^<!--.*-->$/ only
  // catches single-line comments), iterating to a fixed point so removals that
  // splice a new comment marker together don't survive.
  const filtered = stripHtmlComments(lessons)
    .split("\n")
    .filter((line) => !line.trim().match(/^<[^>]*>$/))
    .filter(
      (line) => !line.trim().match(/^https:\/\/claude\.ai\/code\/session_/),
    )
    .filter((line) => !line.trim().match(/^```/))
    .join("\n")
    .trim();
  if (!filtered || filtered.length < MIN_CONTENT_LENGTH) {
    console.log(
      "Lessons section only contains template placeholders, skipping",
    );
    return;
  }

  const stripped = filtered.replace(/\*\*(What|Where|Why)\*\*:\s*/g, "").trim();
  if (!stripped || stripped.length < MIN_CONTENT_LENGTH) {
    console.log("Lessons section only contains template skeleton, skipping");
    return;
  }

  fs.mkdirSync(PHONE_HOME_DIR, { recursive: true });
  fs.writeFileSync(`${PHONE_HOME_DIR}/lessons.txt`, filtered);

  core.setOutput("has_lessons", "true");
  core.setOutput("pr_title", context.payload.pull_request.title);
  core.setOutput("pr_url", context.payload.pull_request.html_url);
  core.setOutput("source_repo", repo);
};
