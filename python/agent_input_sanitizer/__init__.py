"""Python client for ``agent-input-sanitizer``.

The sanitization logic has a single source of truth: the JavaScript in
``src/``. This module is a thin client that shells out to the
``bin/sanitize-cli.mjs`` CLI, so a Python pipeline gets byte-identical verdicts
without a second implementation to keep in sync. It requires Node.js (>=20) on
``PATH``; there is deliberately no pure-Python fallback, because a port is
exactly the drift this design avoids.

Two entry points, mirroring the CLI's two modes:

* :func:`sanitize` — one subprocess per call. Simplest; pays process-spawn cost
  (and ~200 ms HTML module-load when ``html=True``) every time.
* :class:`Sanitizer` — a long-lived worker process. Amortizes startup across
  many calls; use it as a context manager on the hot path.
"""

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

# The CLI lives at <repo>/bin/sanitize-cli.mjs; this module is at
# <repo>/python/agent_input_sanitizer/__init__.py, so the repo root is two
# parents up.
_CLI = Path(__file__).resolve().parents[2] / "bin" / "sanitize-cli.mjs"

__all__ = ["SanitizeResult", "sanitize", "Sanitizer"]


@dataclass(frozen=True)
class SanitizeResult:
    """The :func:`sanitize` return shape, mirroring the JS API.

    ``cleaned`` is the sanitized text; ``found`` names the neutralized
    categories; ``warnings`` carries the operator-facing notices. As in JS, any
    change to the text comes with at least one warning.
    """

    cleaned: str
    found: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _node_missing(node: str) -> RuntimeError:
    return RuntimeError(
        f"Node.js (>=20) is required but {node!r} was not found on PATH. "
        "agent-input-sanitizer keeps a single JavaScript source of truth and "
        "has no pure-Python fallback; install Node to use the Python client."
    )


def _parse_response(line: str) -> SanitizeResult:
    response = json.loads(line)
    if "error" in response:
        raise RuntimeError(f"sanitize CLI error: {response['error']}")
    return SanitizeResult(**response)


def sanitize(text: str, *, html: bool = False, node: str = "node") -> SanitizeResult:
    """Sanitize ``text`` via a one-shot CLI subprocess.

    Set ``html=True`` to run the HTML layers (Layers 2 & 3) in addition to the
    always-on Layer 1. ``node`` overrides the Node executable.
    """
    request = json.dumps({"text": text, "html": html})
    try:
        proc = subprocess.run(
            [node, str(_CLI)],
            input=request,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except FileNotFoundError as cause:
        raise _node_missing(node) from cause
    if proc.returncode != 0:
        raise RuntimeError(
            f"sanitize CLI failed (exit {proc.returncode}): {proc.stderr.strip()}"
        )
    return _parse_response(proc.stdout)


class Sanitizer:
    """A long-lived sanitizer worker, for the hot path.

    Spawns one ``node ... --worker`` process and feeds it newline-delimited JSON
    requests, so the (heavy, when ``html=True``) module load is paid once rather
    than per call. Use as a context manager::

        with Sanitizer() as s:
            for page in pages:
                result = s.sanitize(page, html=True)
    """

    def __init__(self, node: str = "node") -> None:
        self._node = node
        self._proc: subprocess.Popen | None = None

    def __enter__(self) -> "Sanitizer":
        try:
            self._proc = subprocess.Popen(
                [self._node, str(_CLI), "--worker"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except FileNotFoundError as cause:
            raise _node_missing(self._node) from cause
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def sanitize(self, text: str, *, html: bool = False) -> SanitizeResult:
        if self._proc is None or self._proc.poll() is not None:
            raise RuntimeError("worker is not running (use it as a context manager)")
        assert self._proc.stdin is not None and self._proc.stdout is not None
        self._proc.stdin.write(json.dumps({"text": text, "html": html}) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if line == "":
            stderr = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"sanitize worker exited unexpectedly: {stderr.strip()}")
        return _parse_response(line)

    def close(self) -> None:
        if self._proc is None:
            return
        if self._proc.stdin is not None:
            self._proc.stdin.close()
        self._proc.wait(timeout=5)
        self._proc = None
