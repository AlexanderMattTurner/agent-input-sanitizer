#!/bin/bash
# Validates Claude Code skills have required structure per best practices.
# Based on analysis of common skills failures:
#   https://cashandcache.substack.com/p/i-analyzed-40-claude-skills-failures
#
# Checks enforced:
#   1. YAML frontmatter present (starts with ---)
#   2. name: field in frontmatter (descriptive identifier)
#   3. description: field in frontmatter (2+ sentences for activation context)
#   4. ## Examples section in body (real input/output pairs prevent generic output) [optional]
#
# Skills must use directory format: .claude/skills/<name>/SKILL.md
# Flat files (.claude/skills/<name>.md) are rejected.
#
# Usage: lint-skills.sh [files...]

set -euo pipefail

errors=0

for file in "$@"; do
  # Skip if not under .claude/skills/
  [[ "$file" != *".claude/skills/"* ]] && continue

  basename_file=$(basename "$file")
  grandparent=$(basename "$(dirname "$(dirname "$file")")")

  # Reject flat files directly in .claude/skills/
  dirname_file=$(basename "$(dirname "$file")")
  if [[ "$dirname_file" == "skills" && "$basename_file" == *.md ]]; then
    echo "ERROR: $file uses flat file format — convert to .claude/skills/$(basename "$file" .md)/SKILL.md" >&2
    errors=$((errors + 1))
    continue
  fi

  # Only validate SKILL.md entrypoints; skip supporting files
  [[ "$grandparent" != "skills" || "$basename_file" != "SKILL.md" ]] && continue

  # Check for YAML frontmatter opening delimiter
  if ! head -1 "$file" | grep -q '^---$'; then
    echo "ERROR: $file missing YAML frontmatter (must start with ---)" >&2
    errors=$((errors + 1))
    continue
  fi

  # Check for YAML frontmatter closing delimiter
  if ! awk '/^---$/{n++} END{exit (n<2)}' "$file"; then
    echo "ERROR: $file missing closing '---' YAML frontmatter delimiter" >&2
    errors=$((errors + 1))
    continue
  fi

  # Extract frontmatter (between first and second ---), filtering YAML comments.
  # A frontmatter that is entirely comments makes `grep -v '^#'` exit 1, which
  # under `set -e` would abort the whole linter — branch on the exit code
  # instead (grep exit 1 = "no non-comment lines", any other code = real error).
  fm_raw=$(awk '/^---$/{n++; next} n==1' "$file")
  if frontmatter=$(printf '%s\n' "$fm_raw" | grep -v '^#'); then
    : # non-comment lines found
  else
    grep_rc=$? # exit status of the `if` condition = grep's (pipefail on)
    [[ "$grep_rc" -eq 1 ]] || exit "$grep_rc"
    frontmatter=""
  fi

  # Check frontmatter has name field
  if ! echo "$frontmatter" | grep -q '^name:'; then
    echo "ERROR: $file missing 'name:' in frontmatter" >&2
    errors=$((errors + 1))
  fi

  # Check frontmatter has description field
  if ! echo "$frontmatter" | grep -q '^description:'; then
    echo "ERROR: $file missing 'description:' in frontmatter" >&2
    errors=$((errors + 1))
  fi

  # Check description is multi-sentence (at least 2 periods).
  # Extract the description value (its line plus any indented continuation
  # lines) from the frontmatter only. A sed range like /^description:/,/^[a-z]/p
  # includes the *next* top-level key's line, so its periods leak into the
  # count; instead, stop at — and exclude — the next top-level key.
  # `tr -dc` strips everything except '.', so a description with zero periods
  # still produces an empty (not failing) result — required under `pipefail`.
  desc_block=$(awk '
    /^---$/ { n++; next }
    n == 1 {
      if ($0 ~ /^description:/) { indesc = 1; print; next }
      if (indesc && $0 ~ /^[A-Za-z][A-Za-z0-9_-]*:/) { indesc = 0 }
      if (indesc) print
    }
  ' "$file")
  periods=$(printf '%s' "$desc_block" | tr -dc '.')
  if [[ "${#periods}" -lt 2 ]]; then
    echo "ERROR: $file description too short — use 2-3 sentences with specific activation triggers" >&2
    errors=$((errors + 1))
  fi

  # Warn (but don't fail) if Examples section is missing
  body=$(awk '/^---$/{n++; next} n>=2' "$file")
  if ! echo "$body" | grep -q '^## Examples'; then
    echo "WARN: $file missing '## Examples' section — consider adding 2-3 real input/output examples" >&2
  fi
done

[[ "$errors" -gt 0 ]] && exit 1 || exit 0
