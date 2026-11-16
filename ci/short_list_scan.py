"""ORW-511: the scanner behind the short-list guard (ci/check_short_lists.py) and the inventory (docs/audits/SHORT-LISTS-INVENTORY.md).

Finds, in TypeScript (src/), Python (frontend/ minus tests) and the front-end JS (frontend/static/js):
  list  : a string list the code DEALS from (random pick, hash/modulo index, sample, shuffle) shorter than LIMIT items
  example : an example line ("e.g.", "for example", "such as", "for instance") inside a STRING LITERAL (prompt text), never a comment
  menu  : a closed menu inside a string literal ("one of: a, b, c", "a | b | c" with 3+ quoted choices)
Comments and docstrings are never scanned: only text a program can send to a model or show a player.
Pure stdlib; the same code serves the guard, its tests and the inventory generator."""
from __future__ import annotations

import ast
import collections
import io
import re
import subprocess
import tokenize
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIMIT = 40  # a dealt string list shorter than this must be allowlisted with a reason (same threshold as the ORW-508 TS guard)
MIN_LIST = 3

EXAMPLE_RE = re.compile(r"\b(?:e\.g\.|e\.g\b|for example|for instance|such as|examples?:|eg:)", re.I)
MENU_ONEOF_RE = re.compile(
    r"\b(?:one of|pick from|choose from|chosen from|select from|from this list|from among|options?:|menu:)\b[^\n]{0,60}?"
    r"(?:[\"“'`][^\"”'`\n]{1,40}[\"”'`]\s*(?:,|/|\||or)\s*){2,}[\"“'`][^\"”'`\n]{1,40}[\"”'`]", re.I)
# three or more quoted sentences in a row inside one string: sample lines the model will copy, even with no "e.g." marker (ORW-511 review)
_Q = (r"(?:(?<![\w'\"])'(?=[^'\n]*\s)[^'\n]{5,110}'(?![\w'])"      # 'a quoted sample' with a space in it (so an apostrophe in prose is not one)
      r"|(?<![\w\"])\"(?=[^\"\n]*\s)[^\"\n]{5,110}\"(?![\w\"])"
      r"|“[^”\n]{5,110}”)")
# three or more quoted samples in a row, joined by a comma, "or", "and", a slash, a dash, a bullet or just whitespace; single or double quotes, short or long
QUOTED_SAMPLES_RE = re.compile(rf"(?:{_Q}\s*(?:,|;|/|\||\bor\b|\band\b|—|-|\u2022)?\s*){{3,}}")
# one quoted spoken line of four or more words ending in ? or ! (the sample line a model repeats verbatim); found as a quoted span, then filtered, so there is no nested quantifier
QUOTED_SPAN_RE = re.compile(r"[\"“']([^\"”'\n]{12,160})[\"”']")
MENU_PIPE_RE = re.compile(r"(?:[\"“'`][^\"”'`|\n]{1,40}[\"”'`]\s*\|\s*){2,}[\"“'`][^\"”'`|\n]{1,40}[\"”'`]")


@dataclass(frozen=True)
class Hit:
    kind: str       # list | example | menu
    lang: str       # ts | py | js
    path: str       # repo-relative
    line: int
    name: str       # list name, or a short stable label for text hits
    size: int = 0   # list length
    ctx: str = ""   # a short stretch of the string around a text hit (for review; not part of the guard's key)


# --------------------------------------------------------------------------- file discovery
def tracked(patterns: list[str]) -> list[str]:
    out = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z", *patterns], capture_output=True, check=True).stdout.decode()
    return [f for f in out.split("\0") if f]


def scan_files() -> dict[str, list[str]]:
    ts = [f for f in tracked(["src/**/*.ts", "src/*.ts"])]
    py = [f for f in tracked(["frontend/**/*.py", "frontend/*.py"]) if "/tests/" not in f and "/scripts/" not in f and not f.endswith("conftest.py")]
    js = [f for f in tracked(["frontend/static/js/*.js"])]
    return {"ts": sorted(set(ts)), "py": sorted(set(py)), "js": sorted(set(js))}


# --------------------------------------------------------------------------- JS/TS string-literal tokenizer
def js_strings(src: str) -> list[tuple[int, str]]:
    """(line, text) of every string / template literal; comments and regex literals skipped. Template text keeps its ${..} parts out."""
    out: list[tuple[int, str]] = []
    i, n, line = 0, len(src), 1
    prev = ""  # last significant char, to tell a regex literal from a division

    def read_template(i: int, line: int) -> tuple[int, int, str]:
        buf: list[str] = []
        i += 1
        while i < n:
            c = src[i]
            if c == "\\":
                buf.append(src[i + 1] if i + 1 < n else ""); line += src[i:i + 2].count("\n"); i += 2; continue
            if c == "`":
                return i + 1, line, "".join(buf)
            if c == "$" and src[i + 1:i + 2] == "{":
                depth = 1; i += 2
                while i < n and depth:
                    d = src[i]
                    if d == "\n": line += 1
                    if d == "`":
                        i, line, inner = read_template(i, line); out.append((line, inner)); continue
                    if d in "\"'":
                        j = i + 1
                        while j < n and src[j] != d:
                            j += 2 if src[j] == "\\" else 1
                        out.append((line, src[i + 1:j])); i = j + 1; continue
                    if d == "{": depth += 1
                    elif d == "}": depth -= 1
                    i += 1
                buf.append(" "); continue
            if c == "\n": line += 1
            buf.append(c); i += 1
        return i, line, "".join(buf)

    while i < n:
        c = src[i]
        if c == "\n":
            line += 1; i += 1; continue
        if c in " \t\r":
            i += 1; continue
        if c == "/" and src[i + 1:i + 2] == "/":
            j = src.find("\n", i); i = n if j < 0 else j; continue
        if c == "/" and src[i + 1:i + 2] == "*":
            j = src.find("*/", i + 2); j = n if j < 0 else j + 2
            line += src[i:j].count("\n"); i = j; continue
        if c in "\"'":
            j = i + 1; start = line
            while j < n and src[j] != c and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            out.append((start, re.sub(r"\\(.)", r"\1", src[i + 1:j]))); i = j + 1; prev = c; continue
        if c == "`":
            start = line
            i, line, text = read_template(i, line)
            out.append((start, text)); prev = "`"; continue
        if c == "/" and (prev == "" or prev in "(,=:[!&|?{};+-*%<>~^"):
            j = i + 1; incls = False
            while j < n and src[j] != "\n":
                if src[j] == "\\": j += 2; continue
                if src[j] == "[": incls = True
                elif src[j] == "]": incls = False
                elif src[j] == "/" and not incls: break
                j += 1
            i = j + 1; prev = "/"; continue
        prev = c; i += 1
    return out


# --------------------------------------------------------------------------- text hits (example / menu)
def _grouped(strings: list[tuple[int, str]]) -> list[tuple[list[tuple[int, int]], str]]:
    """Adjacent string literals (the lines of one prompt array or a `+` chain) joined with a space, so a quoted sample that wraps across literals is seen as one.
    Each group is ([(offset in the joined text, source line)], text)."""
    groups: list[tuple[list[tuple[int, int]], str]] = []
    marks: list[tuple[int, int]] = []
    cur = ""
    last_end = -10
    for line, text in strings:
        if cur and line <= last_end + 1:
            marks.append((len(cur) + 1, line)); cur += " " + text
        else:
            if cur: groups.append((marks, cur))
            marks, cur = [(0, line)], text
        last_end = line + text.count("\n")
    if cur: groups.append((marks, cur))
    return groups


def text_hits(lang: str, path: str, strings: list[tuple[int, str]]) -> list[Hit]:
    out: list[Hit] = []
    for marks, text in _grouped(strings):
        if len(text) < 25 or " " not in text:
            continue
        for m in QUOTED_SAMPLES_RE.finditer(text):
            line = max((ln for off, ln in marks if off <= m.start()), default=marks[0][1])
            out.append(Hit("menu", lang, path, line, "menu", 0, " ".join(text[m.start():m.start() + 80].split())))
    for line, text in strings:
        if len(text) < 25 or " " not in text:
            continue
        for m in QUOTED_SPAN_RE.finditer(text):
            inner = m.group(1).strip()
            if len(inner.split()) < 4 or inner[-1] not in "?!" or (m.start() > 0 and (text[m.start() - 1].isalnum())):
                continue
            out.append(Hit("example", lang, path, line + text[:m.start()].count("\n"), "example@quoted-line", 0, " ".join(text[max(0, m.start() - 40):m.end() + 40].split())))
        for k, m in enumerate(EXAMPLE_RE.finditer(text)):
            out.append(Hit("example", lang, path, line + text[:m.start()].count("\n"), f"example@{m.group(0).lower()}", 0, " ".join(text[max(0, m.start() - 60):m.end() + 70].split())))
        for m in list(MENU_ONEOF_RE.finditer(text)) + list(MENU_PIPE_RE.finditer(text)):
            out.append(Hit("menu", lang, path, line + text[:m.start()].count("\n"), "menu", 0, " ".join(text[max(0, m.start() - 40):m.end() + 40].split())))
    return out


# --------------------------------------------------------------------------- shared deal-use logic
DEAL_ID = r"(?:pick\w*|choice|choices|sample|shuffle|among|spreadFacet|oneOf)"


def ts_skeleton(src: str) -> str:
    """The source with comment text and string/template contents blanked (newlines and quote marks kept), so brace counting and deal patterns ignore them."""
    out = list(src)
    i, n = 0, len(src)
    prev = ""
    while i < n:
        c = src[i]
        if c == "/" and src[i + 1:i + 2] == "/":
            j = src.find("\n", i); j = n if j < 0 else j
            for k in range(i, j): out[k] = " "
            i = j; continue
        if c == "/" and src[i + 1:i + 2] == "*":
            j = src.find("*/", i + 2); j = n if j < 0 else j + 2
            for k in range(i, j):
                if src[k] != "\n": out[k] = " "
            i = j; continue
        if c in "\"'":
            j = i + 1
            while j < n and src[j] != c and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            for k in range(i + 1, min(j, n)): out[k] = " "
            i = j + 1; prev = c; continue
        if c == "`":
            j = i + 1; depth = 0
            while j < n:
                d = src[j]
                if d == "\\": j += 2; continue
                if d == "$" and src[j + 1:j + 2] == "{": depth += 1; j += 2; continue
                if d == "}" and depth: depth -= 1; j += 1; continue
                if d == "`" and not depth: break
                if not depth and d != "\n": out[j] = " "
                j += 1
            i = j + 1; prev = "`"; continue
        if c == "/" and (prev == "" or prev in "(,=:[!&|?{};+-*%<>~^"):
            j = i + 1; incls = False
            while j < n and src[j] != "\n":
                if src[j] == "\\": j += 2; continue
                if src[j] == "[": incls = True
                elif src[j] == "]": incls = False
                elif src[j] == "/" and not incls: break
                j += 1
            for k in range(i + 1, min(j, n)): out[k] = " "
            i = j + 1; prev = "/"; continue
        if not c.isspace(): prev = c
        i += 1
    return "".join(out)


def ts_depths(skel: str) -> list[int]:
    """Brace depth before each character (one pass per file)."""
    out = [0] * (len(skel) + 1)
    d = 0
    for i, ch in enumerate(skel):
        out[i] = d
        if ch == "{": d += 1
        elif ch == "}": d -= 1
    out[len(skel)] = d
    return out


def ts_scope(skel: str, depths: list[int], pos: int) -> tuple[str, bool]:
    """Text a binding declared at `pos` can be used in: to the end of its enclosing block, or the whole file when it is module level. Second item: module level."""
    depth = depths[pos]
    if depth <= 0:
        return skel, True
    j = pos
    while j < len(skel) and depths[j] >= depth:
        j += 1
    return skel[pos:j], False


_ALIASES: dict[int, tuple[str, list[tuple[str, frozenset]]]] = {}
NUMERIC_RHS_RE = re.compile(r"\.length\s*;?\s*$|%|[hH]ash|\.next\(|\.int\(|random|floor|\bint\(|\blen\(")  # an index or a count, not a copy of the list
ALIAS_LINE_RE = re.compile(r"^\s*(?:const |let |var )?([A-Za-z_]\w*)\s*(?::[^=\n]{0,40})?=(?!=)\s*(.*)$")


def _aliases(text: str) -> list[tuple[str, frozenset]]:
    hit = _ALIASES.get(id(text))
    if hit is None or hit[0] is not text:
        got = []
        for ln in text.split("\n"):
            if "=" in ln:
                m = ALIAS_LINE_RE.match(ln)
                if m and len(m.group(1)) > 2 and not NUMERIC_RHS_RE.search(m.group(2)):
                    got.append((m.group(1), frozenset(re.findall(r"[A-Za-z_]\w*", m.group(2)[:200]))))
        _ALIASES[id(text)] = (text, got)
        return got
    return hit[1]


_WORDS: dict[int, tuple[str, list[str], dict[str, list[int]]]] = {}


def _near(name: str, text: str) -> str:
    """The lines of `text` that mention `name` plus the line before each (a call can wrap), so a pattern is only run where the name occurs."""
    got = _WORDS.get(id(text))
    if got is None or got[0] is not text:
        lines = text.split("\n")
        idx: dict[str, list[int]] = {}
        for i, ln in enumerate(lines):
            for w in set(re.findall(r"[A-Za-z_]\w*", ln)):
                idx.setdefault(w, []).append(i)
        got = _WORDS[id(text)] = (text, lines, idx)
    _, lines, idx = got
    keep = sorted({j for i in idx.get(name, ()) for j in (i - 1, i) if j >= 0})
    return "\n".join(lines[j] for j in keep)


def dealt(base: str, texts: list[str], lang: str) -> bool:
    """Is the list bound to `base` dealt from in any of `texts`? Follows one-hop aliases (`const full = POOL[kind]`, `pool = x ? filtered : full`) so copying a list before picking is not a blind spot."""
    names = {base}
    for _ in range(3):
        grew = False
        for t in texts:
            if not any(n in t for n in names):
                continue
            for lhs, toks in _aliases(t):
                if lhs not in names and not names.isdisjoint(toks):
                    names.add(lhs); grew = True
        if not grew:
            break
    return any(deal_re(n, lang).search(_near(n, t)) for n in names for t in texts)


_DEAL_CACHE: dict[tuple[str, str], "re.Pattern[str]"] = {}


def deal_re(name: str, lang: str) -> "re.Pattern[str]":
    key = (name, lang)
    if key in _DEAL_CACHE:
        return _DEAL_CACHE[key]
    n = re.escape(name)
    r = rf"{n}(?:\.\w+|\[[^\]\n]*\])?"  # the list itself, or one table row of it
    if lang == "py":
        pat = (rf"{DEAL_ID}\(\s*(?:[\w.]+\s*,\s*)?{r}\b|%\s*len\(\s*{r}\s*\)|\b{n}(?:\[[^\]\n]*\])?\s*\[[^\]\n]*(?:random|randint|randrange|hash|crc|%|\bint\()"
               rf"|(?:randint|randrange|random\(\))[^\n]*len\(\s*{r}")
    else:
        pat = (rf"{DEAL_ID}\(\s*(?:[\w.]+\s*,\s*)?{r}(?![\w.])|%\s*{r}\.length|\*\s*{r}\.length|\b{r}\s*\[[^\]\n]*(?:\.int\(|\.next\(|Math\.random|Math\.floor|%|[hH]ash)")
    _DEAL_CACHE[key] = re.compile(pat)
    return _DEAL_CACHE[key]


# --------------------------------------------------------------------------- python
def py_docstring_nodes(tree: ast.AST) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            b = node.body[0]
            if isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant) and isinstance(b.value.value, str):
                ids.add(id(b.value))
    return ids


def _str_items(node: ast.AST) -> list[str] | None:
    elts = None
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        elts = node.elts
    elif isinstance(node, ast.Call) and node.args:
        # a wrapper such as frozenset([...]) or widen([...]): the first literal argument is the list
        return _str_items(node.args[0])
    if elts is None:
        return None
    out = []
    for e in elts:
        if isinstance(e, ast.Constant) and isinstance(e.value, str):
            out.append(e.value)
        else:
            return None
    return out


def _dict_rows(node: ast.AST) -> list[tuple[str, int]] | None:
    """{key: ("a","b","c"), ...}: the rows that are string lists, as (key, size); None when it is not such a table."""
    if not isinstance(node, ast.Dict):
        return None
    rows = []
    for k, v in zip(node.keys, node.values):
        items = _str_items(v) if v is not None else None
        if items is not None and len(items) >= MIN_LIST and isinstance(k, ast.Constant):
            rows.append((str(k.value), len(items)))
    return rows or None


def py_scan(path: str, src: str) -> tuple[list[tuple[Hit, str, bool]], list[Hit]]:
    """(named list candidates as (hit, scope text, module level), other hits)."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return [], []
    lines = src.split("\n")
    docs = py_docstring_nodes(tree)
    cands: list[tuple[Hit, str, bool]] = []
    others: list[Hit] = []
    strings: list[tuple[int, str]] = []
    stack: list[tuple[ast.AST, ast.AST | None]] = [(tree, None)]
    while stack:
        node, fn = stack.pop()
        nfn = node if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else fn
        for ch in ast.iter_child_nodes(node):
            stack.append((ch, nfn))
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) not in docs:
                strings.append((node.lineno, node.value))
            continue
        tgt = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            tgt, val = node.targets[0].id, node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            tgt, val = node.target.id, node.value
        if tgt:
            items = _str_items(val)
            rows = _dict_rows(val)
            if (items is not None and len(items) >= MIN_LIST) or rows:
                sc, mod = (src, True) if fn is None else ("\n".join(lines[fn.lineno - 1:fn.end_lineno]), False)
                if items is not None and len(items) >= MIN_LIST:
                    cands.append((Hit("list", "py", path, node.lineno, tgt, len(items)), sc, mod))
                for key, size in rows or []:
                    cands.append((Hit("list", "py", path, node.lineno, f"{tgt}.{key}", size), sc, mod))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("choice", "choices", "sample", "shuffle") and node.args:
            items = _str_items(node.args[0])
            if items is not None and len(items) >= MIN_LIST:
                others.append(Hit("list", "py", path, node.lineno, "inline", len(items)))
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.BinOp) and isinstance(node.slice.op, ast.Mod):
            items = _str_items(node.value)
            if items is not None and len(items) >= MIN_LIST:
                others.append(Hit("list", "py", path, node.lineno, "inline", len(items)))
    others += text_hits("py", path, strings)
    return cands, others


# --------------------------------------------------------------------------- typescript lists
def ts_string_array(src: str, i: int) -> list[str] | None:
    depth, q, esc, start = 0, None, False, i + 1
    items: list[str] = []
    j = i
    while j < len(src):
        c = src[j]
        if q:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == q: q = None
            j += 1; continue
        if c == "/" and src[j + 1:j + 2] == "/":
            j = src.find("\n", j)
            if j < 0: return None
            continue
        if c in "\"'`": q = c; j += 1; continue
        if c in "[({": depth += 1; j += 1; continue
        if c in "])}":
            depth -= 1
            if depth == 0: items.append(src[start:j]); break
            j += 1; continue
        if c == "," and depth == 1: items.append(src[start:j]); start = j + 1
        j += 1
    clean = [re.sub(r"//[^\n]*", "", x).strip() for x in items]
    clean = [x for x in clean if x]
    return clean if clean and all(re.fullmatch(r"([\"'`])[\s\S]*\1", x) for x in clean) else None


def _close_of(skel: str, i: int) -> int:
    """Index just past the bracket that opens at skel[i]."""
    depth = 0
    for j in range(i, len(skel)):
        if skel[j] in "[({": depth += 1
        elif skel[j] in "])}":
            depth -= 1
            if depth == 0: return j + 1
    return len(skel)


def ts_scan(path: str, src: str) -> tuple[list[tuple[Hit, str, bool]], list[Hit]]:
    skel = ts_skeleton(src)
    depths = ts_depths(skel)
    cands: list[tuple[Hit, str, bool]] = []
    decl = re.compile(r"(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*(?::[^=\n]{0,160})?=\s*")
    for m in decl.finditer(skel):
        name, at = m.group(1), m.end()
        line = skel.count("\n", 0, at) + 1
        head = skel[at:at + 80]
        scope, mod = ts_scope(skel, depths, m.start()) if depths[m.start()] > 0 else (skel, True)
        wrap = re.match(r"(?:[A-Za-z_][\w.]*\s*\(\s*)\[", head)
        if head.startswith("[") or wrap:
            i = at if head.startswith("[") else at + wrap.end() - 1
            items = ts_string_array(src, i)
            if items and len(items) >= MIN_LIST:
                cands.append((Hit("list", "ts", path, line, name, len(items)), scope, mod))
        elif head.startswith("{"):
            end = _close_of(skel, at)
            d = 0
            k = at
            while k < end:
                ch = skel[k]
                if ch in "[({": 
                    if ch == "[" and d == 1:
                        km = re.search(r"([\"']?)([\w-]+)\1\s*:\s*$", src[max(at, k - 60):k])
                        items = ts_string_array(src, k)
                        if km and items and len(items) >= MIN_LIST:
                            cands.append((Hit("list", "ts", path, skel.count("\n", 0, k) + 1, f"{name}.{km.group(2)}", len(items)), scope, mod))
                        k = _close_of(skel, k)
                        continue
                    d += 1
                elif ch in "])}": d -= 1
                k += 1
    others: list[Hit] = []
    for m in re.finditer(DEAL_ID + r"\w*\(\s*(?:[\w.]+\s*,\s*)?\[", skel):
        items = ts_string_array(src, m.end() - 1)
        if items and len(items) >= MIN_LIST:
            others.append(Hit("list", "ts", path, skel.count("\n", 0, m.end()) + 1, "inline", len(items)))
    for m in re.finditer(r"(?<![\w\]\)])\[", skel):
        items = ts_string_array(src, m.start())
        if items and len(items) >= MIN_LIST:
            j = _close_of(skel, m.start())
            if re.match(r"(?:\s*as\s+const)?\s*\[[^\]\n]*(?:%|Math\.floor|\.next\(|\.int\(|[hH]ash)", skel[j:j + 160]):
                others.append(Hit("list", "ts", path, skel.count("\n", 0, m.start()) + 1, "inline", len(items)))
    return cands, others


# --------------------------------------------------------------------------- driver
def read_sources() -> dict[str, dict[str, str]]:
    files = scan_files()
    out: dict[str, dict[str, str]] = {}
    for lang, fs in files.items():
        out[lang] = {}
        for f in fs:
            try:
                out[lang][f] = (ROOT / f).read_text(encoding="utf8")
            except (OSError, UnicodeDecodeError):
                pass
    return out


def _importers(srcs: dict[str, str], lang: str) -> dict[str, set[str]]:
    """name -> files that import it (so a module-level list is checked where it is used, not everywhere its name appears)."""
    idx: dict[str, set[str]] = collections.defaultdict(set)
    if lang == "ts":
        rx = re.compile(r"import\s*(?:type\s*)?\{([^}]*)\}\s*from")
        for f, src in srcs.items():
            for m in rx.finditer(src):
                for nm in re.split(r"[,\s]+", m.group(1)):
                    nm = nm.split(" as ")[0].strip()
                    if nm: idx[nm].add(f)
    else:
        rx = re.compile(r"from\s+[\w.]+\s+import\s*(\([^)]*\)|[^\n]*)")
        for f, src in srcs.items():
            for m in rx.finditer(src):
                for nm in re.split(r"[,\s()]+", m.group(1)):
                    if nm and nm != "as": idx[nm].add(f)
    return idx


def scan_sources(srcs: dict[str, dict[str, str]]) -> list[Hit]:
    """srcs = {"ts": {path: text}, "py": {...}, "js": {...}}. Pure: the guard test feeds it planted sources. Returns every dealt list of ANY size (the guard decides what a size needs)."""
    hits: list[Hit] = []
    skels = {f: ts_skeleton(t) for f, t in srcs.get("ts", {}).items()}
    imp = {"ts": _importers(srcs.get("ts", {}), "ts"), "py": _importers(srcs.get("py", {}), "py")}
    for lang in ("ts", "py", "js"):
        for f, src in srcs.get(lang, {}).items():
            if lang == "js":
                hits += text_hits("js", f, js_strings(src))
                continue
            cands, others = ts_scan(f, src) if lang == "ts" else py_scan(f, src)
            if lang == "ts":
                others += text_hits("ts", f, js_strings(src))
            for h, scope, mod in cands:
                base = h.name.split(".")[0]
                texts = [scope]
                if mod:
                    for g in imp[lang].get(base, ()):
                        if g != f:
                            texts.append(skels[g] if lang == "ts" else srcs["py"][g])
                if dealt(base, texts, lang):
                    hits.append(h)
            hits += others
    return sorted(set(hits), key=lambda h: (h.path, h.line, h.kind, h.name))


def scan() -> list[Hit]:
    return scan_sources(read_sources())
