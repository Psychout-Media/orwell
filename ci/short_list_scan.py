"""ORW-511: the scanner behind the short-list guard (ci/check_short_lists.py) and the inventory (docs/audits/SHORT-LISTS-INVENTORY.md).

Finds, in TypeScript (src/), Python (frontend/ minus tests) and the front-end JS (frontend/static/js):
  list  : a string list the code DEALS from (random pick, hash/modulo index, sample, shuffle) shorter than LIMIT items
  example : an example line ("e.g.", "for example", "such as", "for instance") inside a STRING LITERAL (prompt text), never a comment
  menu  : a closed menu inside a string literal ("one of: a, b, c", "a | b | c" with 3+ quoted choices)
Comments and docstrings are never scanned: only text a program can send to a model or show a player.
Pure stdlib; the same code serves the guard, its tests and the inventory generator."""
from __future__ import annotations

import ast
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
def text_hits(lang: str, path: str, strings: list[tuple[int, str]]) -> list[Hit]:
    out: list[Hit] = []
    for line, text in strings:
        if len(text) < 25 or " " not in text:
            continue
        for k, m in enumerate(EXAMPLE_RE.finditer(text)):
            out.append(Hit("example", lang, path, line + text[:m.start()].count("\n"), f"example@{m.group(0).lower()}", 0, " ".join(text[max(0, m.start() - 60):m.end() + 70].split())))
        for m in list(MENU_ONEOF_RE.finditer(text)) + list(MENU_PIPE_RE.finditer(text)):
            out.append(Hit("menu", lang, path, line + text[:m.start()].count("\n"), "menu", 0, " ".join(text[max(0, m.start() - 40):m.end() + 40].split())))
    return out


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
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("frozenset", "tuple", "list", "set") and len(node.args) == 1:
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


def py_scan(path: str, src: str, deal_pool: str) -> tuple[list[Hit], list[Hit]]:
    """(named list candidates, other hits). Candidates still need the deal-use check against `deal_pool`."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return [], []
    cands: list[Hit] = []
    others: list[Hit] = []
    for node in ast.walk(tree):
        tgt = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            tgt, val = node.targets[0].id, node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            tgt, val = node.target.id, node.value
        if tgt:
            items = _str_items(val)
            if items is not None and len(items) >= MIN_LIST:
                cands.append(Hit("list", "py", path, node.lineno, tgt, len(items)))
        # inline: x.choice([..]) / random.sample([..]) / [..][i % n]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("choice", "choices", "sample", "shuffle") and node.args:
            items = _str_items(node.args[0])
            if items is not None and len(items) >= MIN_LIST:
                others.append(Hit("list", "py", path, node.lineno, "inline", len(items)))
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.BinOp) and isinstance(node.slice.op, ast.Mod):
            items = _str_items(node.value)
            if items is not None and len(items) >= MIN_LIST:
                others.append(Hit("list", "py", path, node.lineno, "inline", len(items)))
    docs = py_docstring_nodes(tree)
    strings = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
            strings.append((node.lineno, node.value))
    others += text_hits("py", path, strings)
    return cands, others


_IDX: dict[int, dict[str, list[str]]] = {}


def _lines_with(name: str, pool: str) -> str:
    idx = _IDX.get(id(pool))
    if idx is None:
        idx = {}
        for ln in pool.split("\n"):
            for w in set(re.findall(r"[A-Za-z_]\w*", ln)):
                idx.setdefault(w, []).append(ln)
        _IDX[id(pool)] = idx
    return "\n".join(idx.get(name, []))


def deal_use(name: str, pool: str, lang: str) -> bool:
    pool = _lines_with(name, pool)
    n = re.escape(name)
    if lang == "py":
        pat = (rf"(?:choice|choices|sample|shuffle|pick\w*)\(\s*(?:[\w.]+,\s*)?{n}\b|%\s*len\(\s*{n}\s*\)|\b{n}\s*\[[^\]\n]*(?:random|randint|randrange|hash|crc|%)"
               rf"|\b{n}\[\s*int\(|len\(\s*{n}\s*\)\s*\)")
    else:
        pat = (rf"(?:pick\(\s*{n}\b|spreadFacet\([^)]*\b{n}\b|\b{n}\[[^\]]*(?:int|next)\(|%\s*{n}\.length|\b{n}\.length\)|{n}\)\s*%|sample\(\s*{n}\b|\(\s*{n}\b[^)]*\bpick)")
    return re.search(pat, pool) is not None


# --------------------------------------------------------------------------- typescript lists (same design as the ORW-508 guard)
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


def ts_scan(path: str, src: str) -> tuple[list[Hit], list[Hit]]:
    cands: list[Hit] = []
    decl = re.compile(r"(?:^|\n)[ \t]*(?:export\s+)?(?:const|let)\s+([A-Za-z_]\w*)\s*(?::[^=\n]{0,120})?=\s*\[")
    for m in decl.finditer(src):
        items = ts_string_array(src, m.end() - 1)
        if items and len(items) >= MIN_LIST:
            cands.append(Hit("list", "ts", path, src.count("\n", 0, m.end()) + 1, m.group(1), len(items)))
    others: list[Hit] = []
    for m in re.finditer(r"\bpick\w*\(\s*(?:[\w.]+\s*,\s*)?\[", src):
        items = ts_string_array(src, m.end() - 1)
        if items and len(items) >= MIN_LIST:
            others.append(Hit("list", "ts", path, src.count("\n", 0, m.end()) + 1, "inline", len(items)))
    for m in re.finditer(r"(?<![\w\]])\[", src):
        items = ts_string_array(src, m.start())
        if items and len(items) >= MIN_LIST:
            end = m.start()
            depth = 0
            # find the closing bracket index to look at what follows it
            j, q = m.start(), None
            while j < len(src):
                c = src[j]
                if q:
                    if c == "\\": j += 2; continue
                    if c == q: q = None
                elif c in "\"'`": q = c
                elif c == "[": depth += 1
                elif c == "]":
                    depth -= 1
                    if depth == 0: break
                j += 1
            if re.match(r"\s*\[[^\]\n]*%", src[j + 1:j + 120]):
                others.append(Hit("list", "ts", path, src.count("\n", 0, m.start()) + 1, "inline", len(items)))
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


def scan_sources(srcs: dict[str, dict[str, str]], limit: int = LIMIT) -> list[Hit]:
    """srcs = {"ts": {path: text}, "py": {...}, "js": {...}}. Pure: the guard test feeds it planted sources."""
    pools = {lang: "\n".join(srcs.get(lang, {}).values()) for lang in ("ts", "py", "js")}
    hits: list[Hit] = []
    for lang in ("ts", "py", "js"):
        for f, src in srcs.get(lang, {}).items():
            if lang == "py":
                cands, others = py_scan(f, src, pools["py"])
            elif lang == "ts":
                cands, others = ts_scan(f, src)
                others += text_hits("ts", f, js_strings(src))
            else:
                cands = []
                others = text_hits("js", f, js_strings(src))
            for c in cands:
                if c.size < limit and deal_use(c.name, pools[lang], lang):
                    hits.append(c)
            hits += [o for o in others if o.kind != "list" or o.size < limit]
    return sorted(set(hits), key=lambda h: (h.path, h.line, h.kind, h.name))


def scan(limit: int = LIMIT) -> list[Hit]:
    return scan_sources(read_sources(), limit)
