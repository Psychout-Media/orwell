"""A87 - every `outline: none` / `outline: 0` must come with a visible keyboard-focus replacement, or be on something a keyboard cannot focus, with an explicit reason. A bare `outline: none` on a button or
input is an invisible-focus bug (WCAG 2.4.7), so a NEW one fails here. Source lint over frontend/static (style.css, the orwell*.js embedded <style> strings, login/demo html).

Rule (per declaration):
  1. the same rule block also gives a ring: a non-none `outline`, a non-none `box-shadow`, or a `border`/`border-color`/`background` change; OR
  2. (style.css only) another rule on the same base selector's :focus / :focus-visible gives a ring; OR
  3. it is allow-listed below with the reason a keyboard user is not left without a visible focus.
Roles only."""
import os
import re

import pytest

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
NONE_RE = re.compile(r"outline\s*:\s*(?:none|0)\b[^;}]*")

# (file basename, selector/snippet prefix) -> reason. A new bare outline:none needs an entry HERE with a reason, or a ring.
ALLOW = {
    ("style.css", "pre.editing code.editing"): "an editable text surface: the caret is the focus indicator and the enclosing pre.editing carries the edit-mode frame",
    ("style.css", '[tabindex="-1"]:focus'): "programmatic focus targets (tabindex=-1 containers/dialogs focused by script); not keyboard-reachable, a ring on a whole dialog is noise",
    ("style.css", ".memory-toolbar-btn:disabled"): "a disabled button is not focusable",
    ("style.css", ".ask-user-card:focus"): "the card is a programmatic focus target (tabIndex = -1, moved to when it appears); the choices inside it are the focusable controls and have their own rings",
    ("style.css", ".ow-resize-handle:focus-visible"): "the ring is drawn by the `.ow-resize-handle:focus-visible::before` rule (a pseudo-element, which this lint's sibling check does not see)",
    ("orwellMenu.js", ".ow-popover:focus"): "the popover container is a programmatic focus target; its items carry the rings",
}


def _strip_comments(t):
    return re.sub(r"/\*.*?\*/", "", t, flags=re.S)


def _rules(css):
    css = _strip_comments(css)
    out, stack, buf = [], [], ""
    for ch in css:
        if ch == "{":
            stack.append(buf.strip()); buf = ""
        elif ch == "}":
            sel = stack.pop() if stack else ""
            body, buf = buf, ""
            if body.strip() and not sel.startswith("@"):
                out.append((" ".join(sel.split()), body.strip()))
        else:
            buf += ch
    return out


def _decls(body, prop):
    return re.findall(r"(?:^|;)\s*" + prop + r"\s*:\s*([^;]+)", body)


def _has_ring(body):
    if any(not re.match(r"\s*(none|0)\b", v) for v in _decls(body, "outline")):
        return True
    if any(v.strip() and not re.match(r"\s*none\b", v) for v in _decls(body, "box-shadow")):
        return True
    return any(_decls(body, p) for p in ("border-color", "border", "background", "background-color", "border-bottom-color"))


def _sels(sel):
    return [x.strip() for x in sel.split(",")]


def _base(s):
    return re.sub(r":(focus-visible|focus|hover|active|disabled|focus-within)\b", "", s).strip()


def _allowed(fname, text):
    return any(f == fname and text.lstrip().startswith(prefix) for (f, prefix) in ALLOW)


def css_offenders(css_text=None):
    rules = _rules(css_text if css_text is not None else open(os.path.join(STATIC, "style.css"), encoding="utf-8").read())
    bad = []
    for sel, body in rules:
        m = NONE_RE.search(body)
        if not m or _has_ring(body.replace(m.group(0), "")) or _allowed("style.css", sel):
            continue
        bases = {_base(s) for s in _sels(sel)}
        sibling = any(
            s2 != sel and re.search(r":focus(-visible|-within)?\b", x) and _base(x) in bases and _has_ring(b2)
            for s2, b2 in rules for x in _sels(s2)
        )
        if not sibling:
            bad.append(("style.css", sel[:100]))
    return bad


def embedded_offenders():
    bad = []
    for fn in sorted(os.listdir(os.path.join(STATIC, "js"))) + ["login.html", "element_kit_demo.html"]:
        path = os.path.join(STATIC, "js", fn) if fn.endswith(".js") else os.path.join(STATIC, fn)
        if not os.path.exists(path):
            continue
        text = open(path, encoding="utf-8", errors="replace").read()
        for m in NONE_RE.finditer(text):
            a = text.rfind("{", 0, m.start())
            b = text.find("}", m.end())
            block = text[a + 1:b if b != -1 else len(text)]
            head = text[max(0, a - 160):a]
            if _has_ring(block.replace(m.group(0), "")) or _allowed(fn, head.split("\n")[-1].split("'")[-1].split('"')[-1]) or any(f == fn and p in head for (f, p) in ALLOW):
                continue
            bad.append((fn, " ".join((head + "{" + block)[-150:].split())))
    return bad


def test_every_outline_none_in_style_css_has_a_visible_replacement_or_a_reason():
    bad = css_offenders()
    assert not bad, "bare `outline: none` with no visible focus replacement (give it a ring, or allow-list with a reason):\n" + "\n".join(map(str, bad))


def test_every_outline_none_in_embedded_styles_has_a_visible_replacement_or_a_reason():
    bad = embedded_offenders()
    assert not bad, "bare `outline: none` in an embedded style with no visible focus replacement:\n" + "\n".join(map(str, bad))


def test_the_lint_is_not_vacuous_and_catches_a_new_bare_outline_none():
    real = open(os.path.join(STATIC, "style.css"), encoding="utf-8").read()
    assert sum(1 for _, b in _rules(real) if NONE_RE.search(b)) >= 40, "the scan should see the ~55 outline:none rules"
    assert ("style.css", ".a87-new-button:focus-visible") in css_offenders(real + "\n.a87-new-button:focus-visible { outline: none; }\n")
    assert css_offenders(real + "\n.a87-ok-button:focus-visible { outline: none; box-shadow: 0 0 0 2px red; }\n") == [], "a rule that supplies its own ring is fine"
    assert css_offenders(real + "\n.a87-sibling { outline: none; }\n.a87-sibling:focus-visible { box-shadow: 0 0 0 2px red; }\n") == [], "a sibling :focus-visible ring counts"


def test_allowlist_entries_all_have_reasons():
    assert all(len(r) > 30 for r in ALLOW.values())
