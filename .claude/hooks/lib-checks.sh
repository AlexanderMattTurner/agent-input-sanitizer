#!/bin/bash
# Shared helpers for Claude Code hook scripts

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" || exit 1

exists() { command -v "$1" &>/dev/null; }

# has_script parses package.json with jq. Without jq it would return "no such
# script" for everything, silently skipping every configured check (fail open).
# Require jq up front so a missing dependency fails the gate closed instead.
if [[ -f package.json ]] && ! command -v jq &>/dev/null; then
  echo "lib-checks: jq is required to read package.json scripts but is not installed" >&2
  exit 1
fi

has_script() {
  [[ -f package.json ]] || return 1
  local val
  val=$(jq -r --arg name "$1" '.scripts[$name] // empty' package.json 2>/dev/null)
  [[ -n "$val" && "$val" != *"ERROR: Configure"* ]]
}
