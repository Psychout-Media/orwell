#!/usr/bin/env python3
"""ORW-159: provably-dead CSS selector scanner / pruner for frontend/static/style.css.

A rule is DEAD only when EVERY selector in its list requires a class, id or attribute name that
appears NOWHERE in the game-build sources (static/*.html, static/js, static/app.js, static/sw.js,
static/lib, and every Python file that could emit HTML). Matching is deliberately conservative -- when
in doubt KEEP:

* any identifier-like token anywhere in a source file counts (strings, comments, concatenations);
* a token ending in ``-``/``_`` is a PREFIX: every class starting with it is live;
* a token starting with ``-``/``_`` is a SUFFIX: every class ending with it is live;
* attribute names are tried in kebab + camelCase form (``data-foo-bar`` / ``fooBar``);
* a selector's tag names, pseudo-classes and :is/:where/:has/:not arguments never prove anything dead.

Usage:  python3 scripts/orw159_dead_css.py [--apply]     (report, or rewrite style.css in place)
"""
from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.dirname(HERE)
CSS_PATH = os.path.join(FRONTEND, "static", "style.css")

_SKIP_DIRS = {"tests", ".venv", "node_modules", "__pycache__", "data", ".git", "licenses", "scripts"}
_EXTS = (".html", ".js", ".py", ".mjs", ".json", ".txt", ".md", ".svg", ".yaml")

_TOKEN = re.compile(r"[A-Za-z0-9_-]+")


def corpus_tokens() -> set[str]:
    toks: set[str] = set()
    for root, dirs, files in os.walk(FRONTEND):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for f in files:
            if not f.endswith(_EXTS):
                continue
            p = os.path.join(root, f)
            if os.path.relpath(p, FRONTEND) == os.path.join("static", "style.css"):
                continue
            try:
                with open(p, encoding="utf-8", errors="ignore") as fh:
                    txt = fh.read()
                if f.endswith(".html"):  # markup comments are not DOM (inline <script> is left intact)
                    txt = re.sub(r"<!--.*?-->", " ", txt, flags=re.S)
                toks.update(_TOKEN.findall(txt))
            except OSError:
                pass
    return toks


class Corpus:
    def __init__(self, tokens: set[str]):
        self.tokens = tokens
        self.prefixes = sorted({t for t in tokens if t.endswith(("-", "_")) and len(t) >= 2})
        self.suffixes = sorted({t for t in tokens if t.startswith(("-", "_")) and len(t) >= 2})

    def name_live(self, name: str) -> bool:
        if name in self.tokens:
            return True
        for p in self.prefixes:
            if name.startswith(p):
                return True
        for s in self.suffixes:
            if name.endswith(s):
                return True
        return False

    def attr_live(self, name: str) -> bool:
        camel = re.sub(r"-([a-z0-9])", lambda m: m.group(1).upper(), name)
        if name.startswith("data-"):
            camel = re.sub(r"-([a-z0-9])", lambda m: m.group(1).upper(), name[5:])
        return self.name_live(name) or camel in self.tokens


# ── minimal CSS structure parser ─────────────────────────────────────────────────────

def _skip_string_or_comment(s: str, i: int) -> int:
    """If s[i] opens a comment/string, return the index after it; else i."""
    c = s[i]
    if c == "/" and s.startswith("/*", i):
        j = s.find("*/", i + 2)
        return len(s) if j < 0 else j + 2
    if c in "\"'":
        j = i + 1
        while j < len(s):
            if s[j] == "\\":
                j += 2
                continue
            if s[j] == c:
                return j + 1
            j += 1
        return len(s)
    return i


def parse_rules(s: str, lo: int = 0, hi: int | None = None, depth: int = 0, out=None):
    """Yield dict(prelude, start, end, kind, depth, children?) for each top-level statement of s[lo:hi]."""
    hi = len(s) if hi is None else hi
    out = [] if out is None else out
    i = lo
    while i < hi:
        # skip whitespace/comments
        while i < hi:
            if s[i].isspace():
                i += 1
                continue
            j = _skip_string_or_comment(s, i) if s[i] == "/" else i
            if j != i:
                i = j
                continue
            break
        if i >= hi:
            break
        start = i
        # read prelude up to { or ;
        while i < hi and s[i] not in "{;":
            j = _skip_string_or_comment(s, i)
            i = j if j != i else i + 1
            if i < hi and s[i] == "(":  # parenthesised prelude chunk: still fine, no braces inside
                pass
        if i >= hi:
            break
        prelude = s[start:i]
        if s[i] == ";":
            out.append(dict(prelude=prelude.strip(), start=start, end=i + 1, kind="stmt", depth=depth))
            i += 1
            continue
        # block
        body_start = i + 1
        d = 1
        i += 1
        while i < hi and d:
            j = _skip_string_or_comment(s, i)
            if j != i:
                i = j
                continue
            if s[i] == "{":
                d += 1
            elif s[i] == "}":
                d -= 1
            i += 1
        end = i
        p = _strip_comments(prelude).strip()
        node = dict(prelude=p, start=start, end=end, body=(body_start, end - 1), depth=depth)
        if p.startswith("@"):
            name = re.match(r"@([-\w]+)", p).group(1).lower()
            node["kind"] = "at:" + name
            if name in ("media", "supports", "layer", "container", "document"):
                node["children"] = parse_rules(s, body_start, end - 1, depth + 1, [])
        else:
            node["kind"] = "rule"
        out.append(node)
    return out


def _strip_comments(t: str) -> str:
    return re.sub(r"/\*.*?\*/", "", t, flags=re.S)


# ── selector requirement extraction ───────────────────────────────────────────────────

def split_top(sel: str, sep=",") -> list[str]:
    parts, d, cur, i = [], 0, [], 0
    while i < len(sel):
        c = sel[i]
        j = _skip_string_or_comment(sel, i)
        if j != i:
            cur.append(sel[i:j])
            i = j
            continue
        if c in "([":
            d += 1
        elif c in ")]":
            d -= 1
        if c == sep and d == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


_IDENT = r"(?:[A-Za-z0-9_-]|\\.|[^\x00-\x7f])+"


def _unescape(n: str) -> str:
    return re.sub(r"\\(.)", r"\1", n)


def requirements(selector: str):
    """(classes, ids, attrs) that an element must carry to match ``selector`` (only positively
    required ones; :not()/:is()/:where()/:has() arguments are dropped, never used to prove deadness)."""
    s = _strip_comments(selector)
    # drop functional pseudo-classes wholesale (conservative)
    out, i = [], 0
    while i < len(s):
        m = re.compile(r":{1,2}[-\w]+\(").match(s, i)
        if m:
            d, j = 1, m.end()
            while j < len(s) and d:
                if s[j] == "(":
                    d += 1
                elif s[j] == ")":
                    d -= 1
                j += 1
            i = j
            continue
        out.append(s[i])
        i += 1
    s = "".join(out)
    attrs = []

    def _attr(m):
        a = m.group(1).strip()
        mm = re.match(r"([^\s~|^$*=\]]+)", a)
        if mm:
            attrs.append(mm.group(1).split("|")[-1])
        return " "

    s = re.sub(r"\[((?:[^\]\"']|\"[^\"]*\"|'[^']*')*)\]", _attr, s)
    classes = [_unescape(x) for x in re.findall(r"\.(" + _IDENT + ")", s)]
    ids = [_unescape(x) for x in re.findall(r"#(" + _IDENT + ")", s)]
    return classes, ids, attrs


_STD_ATTRS = {"type", "hidden", "disabled", "checked", "open", "href", "src", "role", "lang", "dir",
              "title", "value", "name", "id", "class", "style", "selected", "readonly", "required",
              "placeholder", "draggable", "contenteditable", "tabindex", "target", "rel", "aria-hidden",
              "inert", "popover"}


def selector_dead(selector: str, corpus: Corpus) -> str | None:
    """Return the proof (the missing name) if ``selector`` can match nothing, else None."""
    classes, ids, attrs = requirements(selector)
    for c in classes:
        if not corpus.name_live(c):
            return "." + c
    for i in ids:
        if not corpus.name_live(i):
            return "#" + i
    for a in attrs:
        if a.lower() in _STD_ATTRS or a.startswith("aria-"):
            continue
        if not corpus.attr_live(a):
            return "[" + a + "]"
    return None


def rule_dead(prelude: str, corpus: Corpus):
    sels = split_top(_strip_comments(prelude))
    if not sels:
        return None
    proofs = []
    for s in sels:
        p = selector_dead(s, corpus)
        if p is None:
            return None
        proofs.append(p)
    return proofs


def find_dead(css: str, corpus: Corpus):
    """List of (start, end, prelude, proofs) for provably-dead style rules, innermost-first spans."""
    dead = []

    def walk(nodes):
        for n in nodes:
            if n["kind"] == "rule":
                pr = rule_dead(n["prelude"], corpus)
                if pr:
                    dead.append((n["start"], n["end"], n["prelude"], pr))
            elif "children" in n:
                walk(n["children"])

    walk(parse_rules(css))
    return dead


def dead_keyframes(css: str, corpus: Corpus, removed_spans):
    """@keyframes whose name is referenced nowhere (corpus tokens or the surviving stylesheet)."""
    kept = _remove_spans(css, removed_spans)
    out = []
    for n in parse_rules(css):
        nodes = [n] + n.get("children", [])
        for m in nodes:
            if m["kind"].startswith("at:") and m["kind"].endswith("keyframes"):
                name = m["prelude"].split(None, 1)[1].strip()
                uses = len(re.findall(r"(?<![\w-])" + re.escape(name) + r"(?![\w-])", kept))
                # the @keyframes header itself is one occurrence
                if uses <= 1 and not corpus.name_live(name):
                    out.append((m["start"], m["end"], m["prelude"], ["@keyframes " + name]))
    return out


def _remove_spans(css: str, spans) -> str:
    spans = sorted((a, b) for a, b, *_ in spans)
    out, pos = [], 0
    for a, b in spans:
        if a < pos:
            continue
        out.append(css[pos:a])
        pos = b
    out.append(css[pos:])
    return "".join(out)


def prune_empty_at_blocks(css: str) -> str:
    """Drop @media/@supports blocks left with no statements."""
    changed = True
    while changed:
        changed = False
        spans = []

        def walk(nodes):
            for n in nodes:
                if "children" in n:
                    walk(n["children"])
                    inner = _strip_comments(css[n["body"][0]:n["body"][1]]).strip()
                    if not inner:
                        spans.append((n["start"], n["end"]))
        walk(parse_rules(css))
        if spans:
            css = _remove_spans(css, [(a, b) for a, b in spans])
            changed = True
    return css


def prune(css: str, corpus: Corpus):
    dead = find_dead(css, corpus)
    kf = dead_keyframes(css, corpus, dead)
    new = prune_empty_at_blocks(_remove_spans(css, dead + kf))
    new = re.sub(r"\n{3,}", "\n\n", new)
    return new, dead, kf


def main(argv):
    css = open(CSS_PATH, encoding="utf-8").read()
    corpus = Corpus(corpus_tokens())
    new, dead, kf = prune(css, corpus)
    print(f"dead rules: {len(dead)}  dead keyframes: {len(kf)}  bytes {len(css.encode())} -> {len(new.encode())}")
    if "--list" in argv:
        for _, _, p, pr in dead + kf:
            print(" ", p[:100].replace("\n", " "), "<-", ",".join(sorted(set(pr)))[:60])
    if "--apply" in argv:
        with open(CSS_PATH, "w", encoding="utf-8") as fh:
            fh.write(new)
        print("applied")


if __name__ == "__main__":
    main(sys.argv[1:])
