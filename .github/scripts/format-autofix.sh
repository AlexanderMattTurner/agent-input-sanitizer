#!/usr/bin/env bash
# Apply Prettier to the checked-out PR branch and, if it changed anything,
# commit the result and push it back. The push must use a PAT/App token (wired
# via the checkout `token:` input), not GITHUB_TOKEN: a GITHUB_TOKEN push does
# not re-trigger workflows, so the Required format-check would never re-run on
# the fixed commit and the PR would stay blocked.

set -euo pipefail

pnpm format

# `git diff --quiet` exits non-zero exactly when there are unstaged changes, so
# branch on it instead of swallowing the status.
if git diff --quiet; then
  echo "Already Prettier-clean; nothing to autofix."
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
# `style:` keeps the commit Conventional-Commits valid (the commit-msg hook runs
# here because postinstall set core.hooksPath).
git commit -m "style: apply prettier"
git push
