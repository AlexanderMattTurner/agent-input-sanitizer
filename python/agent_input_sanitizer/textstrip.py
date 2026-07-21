"""Stdlib-only removal of ANSI escapes and invisible payload characters.

This is a pure-Python port of the byte-level strip that ``src/invisible.mjs``'s
``applyLayer1`` performs (ANSI/terminal escapes + payload-capable invisible
Unicode). It exists because some consumers must run the strip where the Node CLI
bridge cannot: a bare ``python3`` filter in a minimal sandbox with no Node, no
pip extras, and no ``detect-secrets``. The CLI-bridged entry points in
``__init__`` stay the single source for everything that CAN reach Node; this
module is the sanctioned exception for the no-Node context, exactly like
:mod:`agent_input_sanitizer.invisible` (charset) and the ``secrets`` engine.

The deletion set is the PINNED cross-language SSOT from :mod:`.invisible`
(``invisible_charset`` = the pinned ``Cf`` set UNION the generated non-``Cf``
extras), NOT the local interpreter's ``unicodedata`` ``Cf`` category. That
distinction is load-bearing: CPython and Node ship different Unicode versions, so
resolving ``Cf`` live under-strips every code point in the version delta (a key
spliced with e.g. U+13439 escapes an older interpreter though the JS layer strips
it). Reading the pinned set makes this port version-locked to the JS layer.

The two implementations (this and JS ``applyLayer1``) are kept in agreement by a
behavioral equivalence test over a payload corpus, not by trusting the ports to
match by inspection.
"""

import re

from .invisible import invisible_charset

# ANSI/terminal escape sequences after an ESC (0x1b) introducer, in alternation
# order (first match wins, so the bounded CSI/OSC arms precede the general arm):
#   * CSI      — ESC [ params intermediates final  (whole sequence removed)
#   * OSC      — ESC ] body BEL|ST                 (whole sequence + terminator removed)
#   * general  — ESC + zero-or-more intermediate bytes (0x20-0x2f) + one final
#                byte (0x30-0x7e): the nF/Fp/Fs/Fe escape grammar, so it removes a
#                charset-select (``ESC ( B``), a RIS reset (``ESC c``), a cursor
#                save/restore (``ESC 7`` / ``ESC 8``), and every bare two-char Fe
#                escape (``ESC M``). A TRUNCATED CSI/OSC (``ESC [`` / ``ESC ]``
#                with no final/terminator) also lands here — its bracket is itself
#                a final byte, so only ``ESC + bracket`` is taken and the inert
#                body is left, rather than eaten to end-of-string.
ANSI_RE = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])"
)
# A residual raw ESC the arms above cannot consume — a lone ESC at end of input,
# an ESC before a C0 control (``ESC``+newline, ``ESC ESC``) — is swept
# unconditionally, so no raw ESC ever survives. That sweep, not the sequence
# regex, is the guarantee (``src/invisible.mjs`` secures the same invariant the
# same way, via a final introducer sweep).
ESC_RE = re.compile("\x1b")


def strip_untrusted(text: str) -> str:
    """Return ``text`` with ANSI escapes and invisible/format Unicode removed.

    Deletion-only (the output is a subsequence of the input) and idempotent;
    never raises on lone surrogates or astral input. The invisible deletion set
    is the pinned cross-language SSOT, so this strips exactly what the JS layer's
    ``applyLayer1`` strips regardless of this interpreter's Unicode version.
    """
    text = ANSI_RE.sub("", text)
    text = ESC_RE.sub("", text)
    invisible = invisible_charset()
    return "".join(c for c in text if ord(c) not in invisible)
