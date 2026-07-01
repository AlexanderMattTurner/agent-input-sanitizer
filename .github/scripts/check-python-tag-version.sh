#!/usr/bin/env bash
# Assert a `python-vX.Y.Z` release tag matches python/pyproject.toml's version,
# so a mistyped tag fails loudly here instead of publishing the wrong wheel to
# PyPI (immutable — a bad version can't be reuploaded). The Python client is
# versioned and tagged BY HAND (independently of the npm `vX.Y.Z` line), which is
# exactly the kind of manual step that drifts.
#
# Usage: check-python-tag-version.sh <git-ref>
#   <git-ref> is the pushed ref, e.g. refs/tags/python-v1.2.6 (GITHUB_REF).

set -euo pipefail

ref="${1:?usage: check-python-tag-version.sh <git-ref>}"

# Strip the refs/tags/python-v prefix, leaving the bare version (1.2.6).
tag_version="${ref#refs/tags/python-v}"
if [ "$tag_version" = "$ref" ]; then
  echo "::error::ref '$ref' is not a python-v* tag; this workflow only runs on those tags"
  exit 1
fi

# Pull `version = "..."` out of python/pyproject.toml. Matches the first
# non-comment version assignment, mirroring tests/test_python_version.py so the
# guard and the test agree on what "the version" is.
pyproject="python/pyproject.toml"
file_version=$(
  grep -E '^[[:space:]]*version[[:space:]]*=[[:space:]]*"' "$pyproject" |
    head -n1 |
    sed -E 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/'
)

if [ -z "$file_version" ]; then
  echo "::error::no version field found in $pyproject"
  exit 1
fi

if [ "$tag_version" != "$file_version" ]; then
  echo "::error::tag python-v$tag_version does not match $pyproject version $file_version — bump the version and retag"
  exit 1
fi

echo "Tag python-v$tag_version matches $pyproject version $file_version."
