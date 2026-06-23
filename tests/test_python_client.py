"""Tests for the Python client (`python/agent_input_sanitizer`).

The client is a thin bridge to the Node CLI, so these assert the bridge holds:
Layer 1 strips, the html flag reaches Layers 2/3, the persistent worker agrees
with the one-shot path, and a missing Node fails loudly. The sanitization
verdicts themselves are owned by the JS suite — here the CLI is the source of
truth and the client must faithfully relay it.
"""

import shutil
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "python"))

import agent_input_sanitizer as ais  # noqa: E402
from agent_input_sanitizer import (  # noqa: E402
    Sanitizer,
    SanitizeResult,
    sanitize,
    shutdown_worker,
)

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="Node.js required for the CLI bridge"
)

ZERO_WIDTH_SPACE = "​"
HIDDEN_HTML = '<div style="display:none">leak</div>'


@pytest.fixture(autouse=True)
def _no_shared_worker_leak() -> Iterator[None]:
    """Each test starts and ends with no shared worker, so persistence state
    can't bleed across tests."""
    shutdown_worker()
    assert ais._worker is None
    yield
    shutdown_worker()


def test_strips_invisible_layer1() -> None:
    result = sanitize(f"a{ZERO_WIDTH_SPACE}b")
    assert result.cleaned == "ab"
    assert result.found == ["cf-format"]
    assert result.warnings  # any change carries a warning


def test_clean_text_passes_through_unchanged() -> None:
    result = sanitize("hello world")
    assert result == SanitizeResult(cleaned="hello world", found=[], warnings=[])


def test_empty_input() -> None:
    assert sanitize("") == SanitizeResult(cleaned="", found=[], warnings=[])


def test_html_flag_reaches_layer2() -> None:
    assert "leak" in sanitize(HIDDEN_HTML, html=False).cleaned  # Layer 1 only
    assert "leak" not in sanitize(HIDDEN_HTML, html=True).cleaned  # hidden removed


def test_html_amortizes_load_via_shared_worker() -> None:
    # Default persist=None ⇒ html calls reuse one warm worker: the ~200 ms
    # module-load is paid once, not per call.
    first = sanitize(HIDDEN_HTML, html=True)
    worker = ais._worker
    assert worker is not None and worker.is_alive()
    second = sanitize(f"a{ZERO_WIDTH_SPACE}b", html=True)
    assert ais._worker is worker  # same process reused, not respawned
    assert "leak" not in first.cleaned
    assert second.cleaned == "ab"


def test_shared_worker_self_heals_after_death() -> None:
    # The riskiest path: a dead shared worker must be reaped and respawned, not
    # left wedging every later persistent call on a corpse.
    sanitize(HIDDEN_HTML, html=True)
    dead = ais._worker
    assert dead is not None
    dead._proc.kill()
    dead._proc.wait()
    assert not dead.is_alive()

    result = sanitize(f"a{ZERO_WIDTH_SPACE}b", html=True, persist=True)
    assert ais._worker is not None and ais._worker.is_alive()
    assert ais._worker is not dead  # a fresh process, not the corpse
    assert result.cleaned == "ab"


def test_layer1_default_stays_oneshot() -> None:
    # A caller that never touches HTML must not leave a process running.
    sanitize(f"a{ZERO_WIDTH_SPACE}b")
    assert ais._worker is None


def test_persist_true_forces_worker_for_layer1() -> None:
    sanitize("plain", persist=True)
    assert ais._worker is not None and ais._worker.is_alive()


def test_persist_false_forces_oneshot_for_html() -> None:
    result = sanitize(HIDDEN_HTML, html=True, persist=False)
    assert ais._worker is None
    assert "leak" not in result.cleaned


def test_shutdown_worker_is_idempotent() -> None:
    sanitize("x", persist=True)
    assert ais._worker is not None
    shutdown_worker()
    assert ais._worker is None
    shutdown_worker()  # second call is a no-op, not an error
    assert ais._worker is None


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
