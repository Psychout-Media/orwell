"""ORW-1015: cacheable ES modules, one classic-script bundle, minified CSS. Pure functions plus a small in-memory bundle registry.

Why runtime and not a build step (the decision, recorded here and on the card): the deploy has no front-end build step, and a committed build
artifact would conflict on every front-end PR (many lanes edit these files at once) and drift from source. Doing it when the page shell is built
needs nothing at deploy time, cannot go stale (it is derived from the files that are served, per build id), and every step falls back to the
untouched original on any doubt, so the worst case is today's behaviour. Kill switch: ORWELL_STATIC_BUNDLE=0.

  1. Modules. `<script type="module" src>` and `<link rel="modulepreload">` URLs under /static get `?b=<build>`, and an inline import map maps
     every /static/app.js and /static/js/**.js URL to the same `?b=<build>` URL. A relative `import './x.js'` resolves to /static/js/x.js, the map
     turns that into /static/js/x.js?b=<build>, which is exactly the URL the tag asked for, so one module record exists per module (never loaded
     twice) and every one is `immutable` for a year (app._RevalidatingStatic). A deploy changes the build id, so every URL changes with it.
  2. Classic scripts. Runs of adjacent synchronous classic `<script src>` tags are served as ONE concatenated file at the position of the first tag
     (order preserved; deferred and module scripts do not execute during parsing, so moving later classic scripts up to the first one's place
     changes nothing they can observe, and only whitespace and comments may sit between the tags of a run). A run is left unbundled when any file in
     it begins with a "use strict" directive, or two files declare the same top-level const/let/class (a bundle would turn that into one SyntaxError
     that kills the whole bundle), or a file cannot be read.
  3. CSS. Comments and redundant whitespace are removed (strings and url(...) are untouched), cached by file mtime.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from typing import Dict, List, Optional, Tuple

BUNDLE_PREFIX = "_bundle/"

# name (e.g. "classic-1a2b3c4d5e6f.js") -> bytes; filled when a page shell is built, read by the static mount.
_BUNDLES: Dict[str, bytes] = {}
_LOCK = threading.Lock()

_TAG_RE = re.compile(r"<(script|link)\b([^>]*)>", re.I)
_SRC_RE = re.compile(r'(\bsrc=")(/static/[^"?#]+\.js)(")')
_HREF_RE = re.compile(r'(\bhref=")(/static/[^"?#]+\.js)(")')
_SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script>", re.S | re.I)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
_CLASSIC_SRC_ATTR_RE = re.compile(r'^\s*src="(/static/[^"?#]+\.js)(\?b=[^"]*)?"\s*$')
_LEXICAL_RE = re.compile(r"(?m)^(?:const|let|class)\s+([A-Za-z_$][\w$]*)")
_USE_STRICT_RE = re.compile(r"""\A\s*(?:(?://[^\n]*|/\*.*?\*/)\s*)*(['"])use strict\1""", re.S)


def bundling_enabled() -> bool:
    return os.environ.get("ORWELL_STATIC_BUNDLE", "1").strip().lower() not in ("0", "false", "no", "off")


def files_fingerprint(static_dir: str) -> tuple:
    """(mtime, size) of every script the transform reads. Part of the page-shell cache key only when the build id is not a real one (local
    dev, where an edit does not change the id), so a changed script rebuilds the bundle."""
    out = []
    for url in module_files(static_dir):
        try:
            st = os.stat(os.path.join(static_dir, url[len("/static/"):]))
            out.append((url, st.st_mtime_ns, st.st_size))
        except OSError:
            pass
    return tuple(out)


def get_bundle(name: str) -> Optional[bytes]:
    with _LOCK:
        return _BUNDLES.get(name)


def _quote(build: str) -> str:
    import urllib.parse as _up
    return _up.quote(build, safe="")


def stamp_module_urls(html: str, build: str) -> str:
    """`?b=<build>` on module script tags and modulepreload links (the URL the import map gives the same module)."""
    q = _quote(build)

    def one(m: "re.Match") -> str:
        kind, attrs = m.group(1).lower(), m.group(2)
        if kind == "script" and re.search(r'\btype="module"', attrs):
            pat = _SRC_RE
        elif kind == "link" and re.search(r'\brel="modulepreload"', attrs):
            pat = _HREF_RE
        else:
            return m.group(0)
        new_attrs = pat.sub(lambda a: f"{a.group(1)}{a.group(2)}?b={q}{a.group(3)}", attrs, count=1)
        return f"<{m.group(1)}{new_attrs}>"

    return _TAG_RE.sub(one, html)


def module_files(static_dir: str, exclude: Tuple[str, ...] = ()) -> List[str]:
    """Every /static URL path an import can resolve to: app.js and everything under js/ (a classic file in the map is harmless)."""
    out = []
    if os.path.isfile(os.path.join(static_dir, "app.js")):
        out.append("/static/app.js")
    base = os.path.join(static_dir, "js")
    for root, _dirs, files in os.walk(base):
        for fn in files:
            if fn.endswith(".js"):
                rel = os.path.relpath(os.path.join(root, fn), static_dir).replace(os.sep, "/")
                out.append("/static/" + rel)
    # a dropped vertical's script is not shipped (and its name must not appear in the served page); if a kept module still imports it,
    # that one import loads the plain URL and no tag loads it, so it cannot be loaded twice.
    return sorted(p for p in out if not any(p.endswith("/" + d) for d in exclude))


def import_map_tag(static_dir: str, build: str, exclude: Tuple[str, ...] = ()) -> str:
    q = _quote(build)
    imports = {p: f"{p}?b={q}" for p in module_files(static_dir, exclude)}
    body = json.dumps({"imports": imports}, separators=(",", ":")).replace("<", "\\u003c")
    return f'<script type="importmap" nonce="{{{{CSP_NONCE}}}}">{body}</script>\n'


def insert_import_map(html: str, static_dir: str, build: str, exclude: Tuple[str, ...] = ()) -> str:
    """Put the import map before the first module script or modulepreload (an import map after a module fetch started is ignored)."""
    m = re.search(r'<link\b[^>]*\brel="modulepreload"|<script\b[^>]*\btype="module"', html)
    if not m:
        return html
    return html[:m.start()] + import_map_tag(static_dir, build, exclude) + html[m.start():]


# ── classic-script bundling ─────────────────────────────────────────────────────────────────────────────────────

def _classify(attrs: str, body: str) -> Tuple[str, Optional[str]]:
    """('bundle', path) for a plain classic `<script src>`; ('barrier', None) for any other script that runs during parsing; ('skip', None)
    for scripts that do not execute during parsing (module, defer, async) or are not JavaScript (import map, JSON)."""
    a = attrs.lower()
    mtype = re.search(r'\btype\s*=\s*"([^"]*)"', a)
    if mtype and mtype.group(1) not in ("", "text/javascript", "application/javascript"):
        return "skip", None
    if re.search(r"\b(defer|async)\b", a):
        return "skip", None
    m = _CLASSIC_SRC_ATTR_RE.match(attrs)
    if m and not body.strip():
        return "bundle", m.group(1)
    return "barrier", None


def _gap_is_clean(gap: str) -> bool:
    return not _SCRIPT_RE.sub("", _COMMENT_RE.sub("", gap)).strip()


def _read(static_dir: str, url_path: str) -> Optional[str]:
    try:
        with open(os.path.join(static_dir, url_path[len("/static/"):]), "r", encoding="utf-8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError):
        return None


def _run_ok(texts: List[str]) -> bool:
    seen = set()
    for t in texts:
        if _USE_STRICT_RE.match(t):
            return False
        for name in set(_LEXICAL_RE.findall(t)):
            if name in seen:
                return False
            seen.add(name)
    return True


def bundle_classic_scripts(html: str, static_dir: str, build: str, stamped: bool) -> str:
    """Replace each run of adjacent classic scripts by one bundle tag. Returns the page unchanged for anything it does not fully understand."""
    tags = list(_SCRIPT_RE.finditer(html))
    runs: List[List[re.Match]] = []
    cur: List[re.Match] = []
    for m in tags:
        kind, _p = _classify(m.group(1), m.group(2))
        if kind == "barrier":
            if cur:
                runs.append(cur)
            cur = []
        elif kind == "bundle":
            if cur and not _gap_is_clean(html[cur[-1].end():m.start()]):
                runs.append(cur)
                cur = []
            cur.append(m)
    if cur:
        runs.append(cur)
    edits: List[Tuple[int, int, str]] = []   # (start, end, replacement) over the original text
    for run in runs:
        if len(run) < 2:
            continue
        paths = [_CLASSIC_SRC_ATTR_RE.match(m.group(1)).group(1) for m in run]
        texts = [_read(static_dir, p) for p in paths]
        if any(t is None for t in texts) or not _run_ok(texts):
            continue
        blob = "".join(f"{t}\n;\n" for t in texts).encode("utf-8")
        name = f"classic-{hashlib.sha256(blob).hexdigest()[:12]}.js"
        with _LOCK:
            _BUNDLES[name] = blob
        tag = f'<script src="/static/{BUNDLE_PREFIX}{name}"></script>'
        edits.append((run[0].start(), run[0].end(), tag))
        for m in run[1:]:
            edits.append((m.start(), m.end(), ""))
    for start, end, rep in sorted(edits, reverse=True):
        html = html[:start] + rep + html[end:]
    return html


def transform_page(html: str, static_dir: str, build: str, stamped: bool, exclude: Tuple[str, ...] = ()) -> str:
    """The whole page-shell transform. `stamped` = build-stamping is on (a real build id); without it only bundling can apply."""
    if not bundling_enabled():
        return html
    try:
        out = html
        if stamped:
            out = insert_import_map(stamp_module_urls(out, build), static_dir, build, exclude)
        return bundle_classic_scripts(out, static_dir, build, stamped)
    except Exception:  # failsoft-ok: any surprise serves the untouched page (today's behaviour)
        return html


# ── CSS minification ────────────────────────────────────────────────────────────────────────────────────────────

_CSS_TOKEN_RE = re.compile(
    r'''("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')'''      # 1: a string, kept as is
    r'''|(url\(\s*[^)'"]*\))'''                       # 2: an unquoted url(...), kept as is (data URIs may hold anything)
    r'''|(/\*.*?\*/)'''                                # 3: a comment
    r'''|(\s+)''',                                     # 4: whitespace
    re.S)
_CSS_PUNCT = "{};,"


def minify_css(text: str) -> str:
    """Drop comments and collapse whitespace; a space is kept only where it separates two tokens. Strings and url(...) are never touched."""
    out: List[str] = []

    pending_space = False
    pos = 0
    for m in _CSS_TOKEN_RE.finditer(text):
        if m.start() > pos:
            chunk = text[pos:m.start()]
            _emit(out, chunk, pending_space)
            pending_space = False
        pos = m.end()
        if m.group(3) is not None or m.group(4) is not None:
            pending_space = True
        else:
            _emit(out, m.group(0), pending_space)
            pending_space = False
    if pos < len(text):
        _emit(out, text[pos:], pending_space)
    return "".join(out).strip()


def _emit(out: List[str], chunk: str, pending_space: bool) -> None:
    if pending_space and out and out[-1][-1:] not in _CSS_PUNCT and chunk[:1] not in _CSS_PUNCT:
        out.append(" ")
    out.append(chunk)


_CSS_CACHE: Dict[tuple, Tuple[bytes, str]] = {}


def minified_css_file(full_path: str) -> Optional[Tuple[bytes, str]]:
    """(minified bytes, etag) for a CSS file, cached by path + mtime + size; None when it cannot be read."""
    try:
        st = os.stat(full_path)
        key = (full_path, st.st_mtime_ns, st.st_size)
        hit = _CSS_CACHE.get(key)
        if hit is not None:
            return hit
        with open(full_path, "r", encoding="utf-8") as fh:
            body = minify_css(fh.read()).encode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    val = (body, '"' + hashlib.sha256(body).hexdigest()[:20] + '"')
    with _LOCK:
        for k in [k for k in _CSS_CACHE if k[0] == full_path]:
            del _CSS_CACHE[k]
        _CSS_CACHE[key] = val
    return val
