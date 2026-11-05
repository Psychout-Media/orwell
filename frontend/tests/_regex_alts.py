"""Test helper: split a compiled regex into its TOP-LEVEL `|` alternatives and rebuild it without one (the in-suite form of a mutation sweep that deletes a single alternative)."""
import re


def top_level_alternatives(src: str) -> "list[str]":
    parts, depth, cur, i, in_cls = [], 0, [], 0, False
    while i < len(src):
        c = src[i]
        if c == "\\":
            cur.append(src[i:i + 2]); i += 2; continue
        if in_cls:
            in_cls = c != "]"
        elif c == "[":
            in_cls = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "|" and depth == 0:
            parts.append("".join(cur)); cur = []; i += 1; continue
        cur.append(c); i += 1
    parts.append("".join(cur))
    return parts


def without(rx: "re.Pattern", idx: int) -> "re.Pattern":
    alts = top_level_alternatives(rx.pattern)
    return re.compile("|".join(a for i, a in enumerate(alts) if i != idx), rx.flags)
