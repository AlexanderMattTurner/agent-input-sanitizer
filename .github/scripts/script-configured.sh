#!/usr/bin/env bash
# Classify whether package.json configures $1 as a real script.
#
#   exit 0  -> configured (script present, body is not the placeholder)
#   exit 1  -> not configured (script absent, or still the "ERROR: Configure"
#              placeholder emitted by the template's unfilled scripts)
#   exit 2  -> package.json is malformed (jq PARSE failure) — fail LOUD
#
# The exit-2 case is the load-bearing distinction: conflating a corrupt
# package.json with "not configured" lets the caller skip the step and a
# required check (node-tests / lint) report GREEN with zero work run. Mirrors
# has_script() in .claude/hooks/lib-checks.sh.
#
# Used by lint / test workflows via script-configured-output.sh to skip steps
# in repos that haven't filled in the placeholder scripts.

set -uo pipefail

: "${1:?script name required}"

# `2>&1` captures jq's own error text; a non-zero jq exit here is a PARSE
# failure (invalid JSON), NOT a missing key — `// empty` makes a missing key a
# clean empty string with exit 0.
if ! val=$(jq -r --arg name "$1" '.scripts[$name] // empty' package.json 2>&1); then
  echo "ERROR: package.json is not valid JSON, cannot check for script \"$1\": $val" >&2
  exit 2
fi

# Empty (absent) or placeholder body => not configured (exit 1 via set -e on the
# final failing test); otherwise exit 0.
[[ -n "$val" && "$val" != *"ERROR: Configure"* ]]
