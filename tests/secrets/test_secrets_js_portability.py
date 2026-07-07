"""data/secret-detectors.json's patterns must stay portable to JavaScript RegExp
(see its `description`). `detectors.py`'s `_assert_js_portable` is the machine
check that gates this at load time; these tests pin its precision (every
construct it must reject, and that today's SSOT entries are all clean) so a
future edit to the check itself can't silently stop gating.
"""

import json

import pytest

import agent_input_sanitizer.secrets.detectors as D

# One sample per construct `_assert_js_portable` must reject, built minimally
# around the construct so a weakened regex in the check itself still fails a
# case (e.g. dropping the `+` in the inline-flag matcher would let `(?:` through
# but must still catch `(?i:`).
JS_INCOMPATIBLE_PATTERNS = [
    ("named group", r"(?P<name>foo)"),
    ("named backreference", r"foo(?P=name)"),
    ("numbered backreference", r"(foo)\1"),
    ("inline flag, whole-pattern", r"(?i)foo"),
    ("inline flag, scoped group", r"(?i:foo)"),
    (r"\A anchor", r"\Afoo"),
    (r"\Z anchor", r"foo\Z"),
]


@pytest.mark.parametrize(
    "label, pattern",
    JS_INCOMPATIBLE_PATTERNS,
    ids=[p[0] for p in JS_INCOMPATIBLE_PATTERNS],
)
def test_assert_js_portable_rejects_incompatible_construct(label, pattern):
    with pytest.raises(ValueError, match="JS-incompatible construct"):
        D._assert_js_portable(pattern)


# JS-portable constructs the check must NOT flag: non-capturing groups,
# lookahead/lookbehind, character classes, quantifiers, escaped metacharacters.
JS_PORTABLE_PATTERNS = [
    "(?:foo|bar)-[A-Za-z0-9_-]{20}",
    "(?<![A-Za-z0-9])foo(?![A-Za-z0-9])",
    r"v1\.0-[a-f0-9]{24}",
    "hv[sb]\\.[A-Za-z0-9_-]{90,300}",
]


@pytest.mark.parametrize("pattern", JS_PORTABLE_PATTERNS)
def test_assert_js_portable_accepts_portable_construct(pattern):
    D._assert_js_portable(pattern)  # must not raise


def test_every_ssot_pattern_is_js_portable():
    """Calls `_assert_js_portable` directly against every currently-shipped
    pattern, independent of `_load_denylists`'s own wiring — so a future change
    that loosens the loader (e.g. wrapping it in try/except) still has this
    covering the validator against real data, not just the synthetic cases
    above."""
    detectors = json.loads(D.DETECTORS_FILE.read_text())["detectors"]
    assert detectors, "no detectors in data/secret-detectors.json"
    for entry in detectors:
        for pattern in entry["patterns"]:
            D._assert_js_portable(pattern)  # must not raise
