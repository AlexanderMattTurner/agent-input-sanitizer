#!/usr/bin/env bash
# Daily release-pipeline canary: assert that npm's published versions, the
# repo's v* git tags, and CHANGELOG.md's top dated heading all agree on the
# latest release. Two real incidents motivated this — a publish loop that
# silently no-op'd and a changelog promotion that silently degraded — both
# invisible until a human went looking. The comparison logic (max-semver over
# `npm view versions --json`, NOT the `latest` dist-tag, which lags; tag and
# changelog cross-checks) lives in ci-truth-serum's `release-canary` console
# script; this wrapper only resolves the pinned rev and the package name.
#
# The ci-truth-serum rev is read from .pre-commit-config.yaml — its single
# source in this repo (same convention as sync-required-checks.sh) — so the
# canary and the pre-commit lints can never run different ci-truth-serum
# versions.
set -euo pipefail

ref="$(awk '/repo:.*ci-truth-serum$/{f=1; next} f && /^[[:space:]]*rev:/{print $2; exit}' .pre-commit-config.yaml)"
if [[ ! "$ref" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Could not read a 40-char ci-truth-serum rev from .pre-commit-config.yaml (got: '${ref}')" >&2
  exit 1
fi

pkg="$(node -p "require('./package.json').name")"
if [[ -z "$pkg" ]]; then
  echo "Could not read the package name from package.json" >&2
  exit 1
fi

uv run --no-project \
  --with "ci-truth-serum @ git+https://github.com/alexander-turner/ci-truth-serum@${ref}" \
  release-canary --package "$pkg"
