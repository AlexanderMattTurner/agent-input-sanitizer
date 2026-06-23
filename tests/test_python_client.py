"""Tests for the Python client (`python/agent_input_sanitizer`).

The client is a thin bridge to the Node CLI, so these assert the bridge holds:
Layer 1 strips, the html flag reaches Layers 2/3, the persistent worker agrees
with the one-shot path, and a missing Node fails loudly. The sanitization
verdicts themselves are owned by the JS suite — here the CLI is the source of
truth and the client must faithfully relay it.
"""

import shutil
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "python"))

from agent_input_sanitizer import Sanitizer, SanitizeResult, sanitize  # noqa: E402

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="Node.js required for the CLI bridge"
)

ZERO_WIDTH_SPACE = "​"
HIDDEN_HTML = '<div style="display:none">leak</div>'


def test_strips_invisible_layer1() -> None:
    result = sanitize(f"a{ZERO_WIDTH_SPACE}b")
    assert result.cleaned == "ab"
    assert result.found == ["cf-format"]
    assert result.warnings  # any change carries a warning


def test_clean_text_passes_through_unchanged() -> None:
    result = sanitize("hello world")
    assert result == SanitizeResult(cleaned="hello world", found=[], warnings=[])


def test_html_flag_reaches_layer2() -> None:
    assert "leak" in sanitize(HIDDEN_HTML, html=False).cleaned  # Layer 1 only
    assert "leak" not in sanitize(HIDDEN_HTML, html=True).cleaned  # hidden removed


def test_worker_matches_oneshot() -> None:
    texts = [f"a{ZERO_WIDTH_SPACE}b", "plain", HIDDEN_HTML]
    with Sanitizer() as worker:
        for text in texts:
            assert worker.sanitize(text, html=True) == sanitize(text, html=True)


def test_worker_preserves_embedded_newlines() -> None:
    text = f"line1\nline2{ZERO_WIDTH_SPACE}"
    with Sanitizer() as worker:
        assert worker.sanitize(text) == sanitize(text)


def test_missing_node_fails_loudly() -> None:
    with pytest.raises(RuntimeError, match="Node.js"):
        sanitize("x", node="definitely-not-a-real-node-binary")


def test_worker_missing_node_fails_loudly() -> None:
    with pytest.raises(RuntimeError, match="Node.js"):
        with Sanitizer(node="definitely-not-a-real-node-binary"):
            pass
