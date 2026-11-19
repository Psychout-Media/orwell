"""ORW-109 - the DETECTOR SETS of the full-week tier, built from the code so they cannot drift (no hand-written list of canned lines or leak shapes).

  stand-in lines   every module-level canned reply in frontend/src/agent_loop.py (names ending _LINE / holding FALLBACK), read with `ast`, so a new stand-in the FE gains is
                   detected the day it lands; a rename that loses one of the known names fails test_live_full.py loudly instead of silently narrowing the net
  wall leaks       the FE's own operator-aside regexes (agent_loop._GAME_LEAK_*), the harness's machinery list (live_short.LEAK_RE), the reasoning shapes (live_compare), a raw `npc:<id>`,
                   and the narrator prompt's own text (every 8-word run of src/engine/momentPrompts.ts's BASE_GAME_MASTER_PROMPT, plus its ALL-CAPS rule labels)
  refusal-only     frontend/src/refusal_guard.py's own classifier
  player voice     frontend/src/player_voice_guard.py's own screen (the narrator writing the player's words)

The regexes and guards are IMPORTED from the front end when it is importable (the FE venv); without it the harness still runs with the `ast` / TS-derived sets and records
`degraded` so a report says which detectors were not live. Pure: no network, no model. Roles only.
"""
from __future__ import annotations

import ast
import importlib
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
AGENT_LOOP = os.path.join(ROOT, "frontend", "src", "agent_loop.py")
MOMENT_PROMPTS = os.path.join(ROOT, "src", "engine", "momentPrompts.ts")
STAND_IN_NAME = re.compile(r"^_[A-Z0-9_]*(?:_LINE|FALLBACK[A-Z0-9_]*)$")
PROMPT_RUN = 8   # a reply that repeats this many words in a row of the narrator prompt is prompt text, not narration
_cache: dict = {}


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def stand_in_table(path=None):
    """{constant name: text} for every canned reply the front end can show in place of a scene, read from the source with `ast` (string constants only)."""
    path = path or AGENT_LOOP
    if path in _cache.get("stand", {}):
        return _cache["stand"][path]
    out = {}
    try:
        tree = ast.parse(open(path, encoding="utf-8").read())
    except (OSError, SyntaxError):
        tree = ast.Module(body=[], type_ignores=[])
    for node in tree.body:
        targets = [t.id for t in getattr(node, "targets", []) if isinstance(t, ast.Name)] if isinstance(node, ast.Assign) else []
        for name in targets:
            if STAND_IN_NAME.match(name):
                try:
                    val = ast.literal_eval(node.value)
                except (ValueError, SyntaxError):
                    continue
                if isinstance(val, str) and len(val) >= 30:
                    out[name] = val
    _cache.setdefault("stand", {})[path] = out
    return out


def stand_in_hits(text, table=None):
    """The names of the canned lines a reply is made of or carries. A reply whose text holds the first 40 normalized characters of a stand-in counts (the FE itself matches
    its own fallbacks the same way, `_fallback_markers`)."""
    t = _norm(text)
    hits = []
    for name, line in (table if table is not None else stand_in_table()).items():
        head = _norm(line)[:40]
        if head and head in t:
            hits.append(name)
    return hits


def stand_in_only(text, table=None):
    """True when, with every stand-in line removed, no real narration is left (the player was shown ONLY a canned line)."""
    t = _norm(text)
    if not t:
        return False
    for line in (table if table is not None else stand_in_table()).values():
        t = t.replace(_norm(line), " ")
    rest = re.sub(r"\s+", " ", t).strip()
    return bool(stand_in_hits(text, table)) and len(rest) < 60


# --- the FE's own guards (imported when the FE is importable) ------------------------------------------------------------------------------------------------
def _fe():
    if "fe" in _cache:
        return _cache["fe"]
    fe = {"degraded": []}
    fdir = os.path.join(ROOT, "frontend")
    if fdir not in sys.path:
        sys.path.insert(0, fdir)
    for key, mod, attrs in (("agent_loop", "src.agent_loop", ("_GAME_LEAK_SENTENCE_RE", "_GAME_LEAK_START_RE")), ("refusal", "src.refusal_guard", ("strip_leading_refusal",)),
                            ("voice", "src.player_voice_guard", ("screen",))):
        try:
            m = importlib.import_module(mod)
            fe[key] = {a: getattr(m, a) for a in attrs}
        except Exception as e:  # noqa: BLE001 - a missing FE dependency only degrades the detector, never the run
            fe[key] = {}
            fe["degraded"].append(f"{key}: {type(e).__name__}")
    _cache["fe"] = fe
    return fe


def degraded():
    return list(_fe()["degraded"])


NPC_ID_RE = re.compile(r"\bnpc:[\w-]+", re.I)


def prompt_ngrams(path=None, n=PROMPT_RUN):
    """(set of n-word runs, set of ALL-CAPS rule labels) of the narrator base prompt, read from the TS source (its quoted string literals only)."""
    path = path or MOMENT_PROMPTS
    key = ("prompt", path, n)
    if key in _cache:
        return _cache[key]
    try:
        src = open(path, encoding="utf-8").read()
    except OSError:
        src = ""
    start = src.find("BASE_GAME_MASTER_PROMPT = [")
    end = src.find("].join", start) if start >= 0 else -1
    body = src[start:end] if start >= 0 and end > start else ""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', body)
    text = " ".join(p.replace('\\"', '"') for p in parts)
    words = _norm(text).split()
    grams = {" ".join(words[i:i + n]) for i in range(max(0, len(words) - n + 1))}
    labels = {m.group(1) for m in re.finditer(r"(?<![A-Za-z'])([A-Z][A-Z']+(?: [A-Z][A-Z']+)+)\b[.:]", text) if len(m.group(1)) >= 14}
    _cache[key] = (grams, labels)
    return _cache[key]


def prompt_text_hit(text, path=None):
    grams, labels = prompt_ngrams(path)
    for lab in labels:
        if lab in (text or ""):
            return f"prompt label {lab!r}"
    words = _norm(text).split()
    for i in range(max(0, len(words) - PROMPT_RUN + 1)):
        if " ".join(words[i:i + PROMPT_RUN]) in grams:
            return "a run of the narrator prompt's own words"
    return None


def wall_leaks(text, reasoning_re=None, machinery_re=None):
    """[(kind, snippet)] for everything in the PUBLIC bubble that must never be there: reasoning, a raw npc id, an operator aside, machinery names, the prompt's own text."""
    out = []
    t = text or ""
    for rx, kind in ((reasoning_re, "reasoning"), (machinery_re, "machinery")):
        m = rx.search(t) if rx else None
        if m:
            out.append((kind, m.group(0)[:60]))
    m = NPC_ID_RE.search(t)
    if m:
        out.append(("raw-npc-id", m.group(0)))
    agent = _fe().get("agent_loop") or {}
    for key in ("_GAME_LEAK_SENTENCE_RE", "_GAME_LEAK_START_RE"):
        rx = agent.get(key)
        m = rx.search(t) if rx else None
        if m:
            out.append(("operator-aside", m.group(0).strip()[:60]))
            break
    hit = prompt_text_hit(t)
    if hit:
        out.append(("prompt-text", hit))
    return out


def refusal_only(text):
    """True when the reply is only a refusal line (the FE's own classifier)."""
    fn = (_fe().get("refusal") or {}).get("strip_leading_refusal")
    t = (text or "").strip()
    if not fn or not t:
        return False
    try:
        rest, n = fn(t)
    except Exception:  # noqa: BLE001
        return False
    return bool(n) and len(rest.strip()) < 20


def player_voice_hits(text, player_msg):
    """The shapes of the narrator writing the player's words (the FE's own `screen`); empty when the guard is not importable."""
    fn = (_fe().get("voice") or {}).get("screen")
    if not fn or not text:
        return []
    try:
        _kept, facts = fn(text, player_msg)
    except Exception:  # noqa: BLE001
        return []
    return [f[0] if isinstance(f, (tuple, list)) else str(f) for f in facts]
