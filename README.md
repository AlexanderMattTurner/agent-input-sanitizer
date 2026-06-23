# `agent-input-sanitizer`

Sanitize untrusted text **before any model sees it**—in an agent, RAG, or
tool-use pipeline. Provider-agnostic: it cleans bytes, not prompts.

It does three things, split across three entry points so the heavy HTML
dependency stays opt-in:

1. **Invisible-char + ANSI stripping** (`./invisible`, zero runtime deps) —
   removes zero-width spaces, bidi controls, variation selectors, tag
   characters, ANSI/SGR escapes, and other hidden code points used to smuggle
   instructions. Preserves ZWNJ/ZWJ where scripts (Arabic, Indic, emoji)
   require them.
2. **Hidden-HTML splicing** (`./html`)—splices out instructions buried in
   comments, `display:none`, off-screen, white-on-white, `hidden`/`aria-hidden`,
   etc. Leaves a placeholder; preserves every other byte verbatim.
3. **Exfil-URL detection** (`./html`, detection only)—reports URLs shaped to
   leak data off-origin (payloads in query/path, embedded credentials,
   `data:`/`javascript:` targets, off-origin redirects). Reports, never edits.

See [THREAT-MODEL.md](./THREAT-MODEL.md) for per-vector detail.

```sh
npm install agent-input-sanitizer
```

## Usage

### Convenience function

```js
import { sanitize } from "agent-input-sanitizer";

// Layer 1 only (invisible chars + ANSI), no heavy deps:
const { cleaned, found, warnings } = await sanitize(untrustedText);

// Opt into the HTML layers for web/HTML ingress:
const result = await sanitize(fetchedPageSource, { html: true });
//   result.cleaned   — hidden HTML spliced out, placeholders left in place
//   result.found     — stable category codes neutralized (e.g. ["cf-format", "hidden-html"])
//   result.warnings  — human-facing notices (long-run alerts, exfil reasons, …)
```

`sanitize` never throws and never silently drops content: any change to the
text comes with at least one `warnings` entry. The `{ html: true }` path
lazy-loads the HTML deps, so a Layer-1-only caller never pays for them.

### Zero-dependency invisible-char core

```js
import {
  stripInvisible,
  stripInvisibleWithReport,
} from "agent-input-sanitizer/invisible";

stripInvisible(text); // -> cleaned string
const { cleaned, found } = stripInvisibleWithReport(text);
//   found names exactly the category codes removed, e.g. ["variation-selectors"]
```

### HTML layer

Heavier—it pulls in the unified/remark/rehype graph (~200 ms of module-load
time). Import it directly only when you need it.

```js
import {
  sanitizeHtml,
  detectExfil,
  checkExfilUrl,
} from "agent-input-sanitizer/html";

const cleaned = sanitizeHtml(pageSource); // null when nothing to strip/report
const threats = detectExfil(pageSource); // null or [{ isImage, reason, target }]
const reason = checkExfilUrl(oneUrl); // null or a string reason
```

## Non-JS pipelines (Python, etc.)

The sanitization logic has a **single source of truth**: the JavaScript above.
A Python (or any-language) pipeline drives the _same_ verdicts—no second
implementation to drift—through the bundled CLI, which speaks JSON over
stdin/stdout. It requires Node.js (≥20) on `PATH`.

```sh
# One JSON request in, one JSON response out:
echo '{"text":"a​b","html":false}' | npx sanitize-cli
# → {"cleaned":"ab","found":["cf-format"],"warnings":["Stripped: Format chars (Cf)"]}

# Persistent worker: newline-delimited requests, one response line each.
sanitize-cli --worker
```

A thin Python client lives in [`python/`](./python). By default it pays the
heavy ~200 ms HTML module-load **once per process, not per call**: the first
`html=True` call spins up a shared worker and every later `html=True` call
reuses it. Layer-1-only calls stay one-shot, so a caller that never touches HTML
leaves no process running.

```python
from agent_input_sanitizer import sanitize

result = sanitize(untrusted_text)                 # Layer 1 only (one-shot)
result = sanitize(page_source, html=True)         # HTML layers — warm worker, reused
#   result.cleaned / result.found / result.warnings — mirrors the JS return shape

# Force the mode if you need to: persist=True keeps a process warm even for
# Layer-1 calls; persist=False spawns a fresh subprocess every time.
sanitize(text, persist=True)
```

The shared worker is torn down at interpreter exit; call `shutdown_worker()` to
stop it sooner. For a worker whose lifetime you own explicitly, use the
`Sanitizer` context manager:

```python
from agent_input_sanitizer import Sanitizer

with Sanitizer() as s:
    for page in pages:
        s.sanitize(page, html=True)
```

There is deliberately no pure-Python port: a port _is_ the drift this design
avoids. Don’t have Node? The client raises a loud error rather than silently
degrading.
