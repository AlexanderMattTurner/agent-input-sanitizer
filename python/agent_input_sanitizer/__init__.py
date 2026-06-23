"""Python client for ``agent-input-sanitizer``.

The sanitization logic has a single source of truth: the JavaScript in
``src/``. This module is a thin client that shells out to the
``bin/sanitize-cli.mjs`` CLI, so a Python pipeline gets byte-identical verdicts
without a second implementation to keep in sync. It requires Node.js (>=20) on
``PATH``; there is deliberately no pure-Python fallback, because a port is
exactly the drift this design avoids.

Entry points:

* :func:`sanitize` — the one call most callers need. By default it pays the
  heavy ~200 ms HTML module-load only ONCE: the first ``html=True`` call spins
  up a shared, process-wide worker and every later ``html=True`` call reuses it
  (Layer-1-only calls stay one-shot, so a caller that never touches HTML never
  leaves a process running). Override with ``persist=True``/``False``.
* :class:`Sanitizer` — an explicitly-scoped long-lived worker, for callers that
  want to own the process lifetime via a context manager.
* :func:`shutdown_worker` — tear down the shared worker eagerly (it is also torn
  down at interpreter exit).
"""

import atexit
import json
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path

# The CLI lives at <repo>/bin/sanitize-cli.mjs; this module is at
# <repo>/python/agent_input_sanitizer/__init__.py, so the repo root is two
# parents up.
_CLI = Path(__file__).resolve().parents[2] / "bin" / "sanitize-cli.mjs"

__all__ = ["SanitizeResult", "sanitize", "Sanitizer", "shutdown_worker"]


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


def sanitize(
    text: str,
    *,
    html: bool = False,
    persist: bool | None = None,
    node: str = "node",
) -> SanitizeResult:
    """Sanitize ``text``.

    Set ``html=True`` to run the HTML layers (Layers 2 & 3) in addition to the
    always-on Layer 1.

    ``persist`` selects how the Node process is managed:

    * ``None`` (default) — persist exactly when ``html=True``. HTML's ~200 ms
      module-load is then paid once for the whole process: the first such call
      starts the shared worker and the rest reuse it. Layer-1-only calls stay
      one-shot so a non-HTML caller leaves no process running.
    * ``True`` — always route through the shared worker.
    * ``False`` — always spawn a fresh one-shot subprocess.

    ``node`` overrides the Node executable (only honored when starting a fresh
    process; an already-running shared worker keeps the executable it began with).
    """
    if persist is None:
        persist = html
    if persist:
        with _shared_worker_lock:
            return _shared_worker(node).sanitize(text, html=html)

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

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

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


# Process-wide worker backing the persistent path of `sanitize`. The lock is
# held across each full request/response so concurrent persistent callers can't
# interleave writes and reads on the one shared pipe (which would desync the
# protocol); it also guards spin-up and teardown of `_worker` itself.
_worker: Sanitizer | None = None
_shared_worker_lock = threading.Lock()
_atexit_registered = False


def _shared_worker(node: str) -> Sanitizer:
    """Return the shared worker, starting it on first use. Caller holds the lock.

    A worker found dead (its prior request already raised, so the failure was
    surfaced loudly) is discarded and replaced, so the persistent path
    self-heals rather than wedging every later call on a corpse.
    """
    global _worker, _atexit_registered
    if _worker is not None and not _worker.is_alive():
        _worker = None
    if _worker is None:
        _worker = Sanitizer(node=node).__enter__()
        if not _atexit_registered:
            atexit.register(shutdown_worker)
            _atexit_registered = True
    return _worker


def shutdown_worker() -> None:
    """Tear down the shared persistent worker if one is running. Idempotent."""
    global _worker
    with _shared_worker_lock:
        if _worker is None:
            return
        _worker.close()
        _worker = None
