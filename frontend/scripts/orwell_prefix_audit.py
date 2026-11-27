#!/usr/bin/env python3
"""ORW-555: the prompt-prefix audit. Offline: fake games, no model call, no network, no secrets.

A prompt-prefix cache (DeepSeek's) bills a request's leading bytes at about 1/50 of the miss price, and only up to the
first byte that differs from an earlier request. So the question for every call site is: for two consecutive calls, where is
the first differing byte, and what share of the second prompt lies before it (the "stable-prefix share")?

    # 1. the engine half of the narrator prompt, N consecutive turns of a fake game (needs node_modules; no model):
    npx tsx scripts/probes/promptPrefix.ts --turns 4 --out turns.json
    # 2. the report (this script builds the real wire messages around that file and captures every other site's messages):
    python frontend/scripts/orwell_prefix_audit.py --turns turns.json [--json]

Sizes are characters of the serialized request; tokens are estimated as chars / 4.1 (the repo's own estimator). The real tokenizer
and the provider's block granularity are not available offline, so shares are close to, not equal to, the provider's cached share.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import copy
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

CHARS_PER_TOKEN = 4.1
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"


# ── measuring ────────────────────────────────────────────────────────────────────────

def serialize(messages: list) -> str:
    """The request body's message list as one string, the way the prefix is laid out on the wire."""
    return json.dumps(messages, ensure_ascii=False, separators=(",", ":"), sort_keys=False)


def common_prefix_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    # binary search the first mismatch, then confirm linearly (strings are up to ~400k chars)
    lo, hi = 0, n
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if a[:mid] == b[:mid]:
            lo = mid
        else:
            hi = mid - 1
    i = lo
    return i


def measure(a_msgs: list, b_msgs: list) -> dict:
    """Stable-prefix share of request B given request A just before it: chars before the first differing byte / chars of B."""
    a, b = serialize(a_msgs), serialize(b_msgs)
    n = common_prefix_len(a, b)
    return {
        "chars": len(b), "tokens": round(len(b) / CHARS_PER_TOKEN), "prefixChars": n,
        "prefixTokens": round(n / CHARS_PER_TOKEN), "share": round(n / len(b), 4) if b else None,
        "firstDiff": _where(b, n),
    }


def _where(b: str, n: int) -> str:
    """A short, quote-free description of where the first difference sits (the text around it, clipped)."""
    lo = max(0, n - 60)
    return b[lo:n + 60].replace("\\n", " ").replace("\n", " ")


# ── the narrator ─────────────────────────────────────────────────────────────────────

def _history(turns: int, chars: int = 1400) -> list:
    out = []
    for i in range(turns):
        out.append({"role": "user", "content": f"Player line {i}: I talk to the housemate about the plan for the week and ask a question number {i}."})
        out.append({"role": "assistant", "content": (f"Narration {i}. " + "The light moves across the room while everyone settles in and talks. " * 40)[:chars]})
    return out


def narrator_wire(turn: dict, history: list, *, now: dt.datetime, tail: bool = True) -> list:
    """The messages the model receives for one narrator round-1 request, built with the REAL front-end functions:
    the engine's system prompt (+ the safety policy) -> `_build_system_prompt` (date block + tool contract) -> the volatile-tail
    reorder -> the DeepSeek system-message consolidation. (The Show Brief and the hard-constraints block are appended last, as `build_chat_context` does.)"""
    from src import agent_loop as al
    from src import user_time
    from src.llm_core import _consolidate_system_messages
    from src.prompt_security import UNTRUSTED_CONTEXT_POLICY

    messages = [{"role": "system", "content": turn["systemPrompt"]}, {"role": "system", "content": UNTRUSTED_CONTEXT_POLICY}] + copy.deepcopy(history)
    if turn.get("showBrief"):   # build_chat_context appends these two last, after the transcript
        messages.append({"role": "system", "content": turn["showBrief"]})
    if turn.get("hardConstraints"):
        messages.append({"role": "system", "content": turn["hardConstraints"]})
    real = user_time.current_datetime_prompt
    user_time.current_datetime_prompt = lambda now_utc=None: real(now)   # the same clock reading the wire would carry at `now`
    try:
        built, _ = al._build_system_prompt(messages, "deepseek-v4-flash", None, None, game_mode=True, suppress_local_context=True)
    finally:
        user_time.current_datetime_prompt = real
    wire = al._volatile_tail_wire(built) if tail else built
    return _consolidate_system_messages(list(wire), DEEPSEEK_URL, "openai")


def audit_narrator(turns: list, *, tail: bool = True) -> dict:
    hist = _history(len(turns) + 6)
    base = dt.datetime(2026, 11, 16, 19, 4, tzinfo=dt.timezone.utc)
    wires = []
    for k, t in enumerate(turns):
        # the stored chat up to turn k, then this turn's player message (which is the next stored row, so turn k+1 repeats it byte for byte)
        h = hist[: 2 * (k + 4) + 1]
        wires.append(narrator_wire(t, h, now=base + dt.timedelta(minutes=3 * k), tail=tail))
    rows = [measure(wires[i - 1], wires[i]) for i in range(1, len(wires))]
    return {"rows": rows, "meanShare": round(sum(r["share"] for r in rows) / len(rows), 4)}


def audit_brief(turns: list) -> dict:
    """Where section 7 (ALREADY USED) sits inside the Show Brief and the brief inside the request, and what changes in it."""
    out = []
    for t in turns[1:]:
        text = t["showBrief"]
        i = text.find("7. ALREADY USED")
        out.append({"briefChars": len(text), "section7At": i, "section7Chars": (len(text) - i) if i >= 0 else 0,
                    "section7IsLast": i >= 0 and "\n\n8." not in text[i:], "sections": t.get("briefSections")})
    return {"turns": out}


# ── the multi-day history (day summary + verbatim recall) ────────────────────────────

def audit_recall() -> dict:
    """Three consecutive turns on day 3 of a fake game, the second of which fires the verbatim recall. Before: the recall sat right after
    the `[Story so far]` block (the pre-fix placement, rebuilt here); after: where `apply_recall` puts it now."""
    from src import orwell_day_condense as dc
    from src import orwell_transcript_recall as tr

    def row(role, text, day=None):
        m = {"role": role, "content": text}
        if day is not None:
            m["metadata"] = {"game_day": day}
        return m

    rows = [row("system", "base prompt")]
    for d in (1, 2, 3):
        for i in range(10):
            rows.append(row("user", f"talk {d} {i} about dinner and the lighthouse key {i} flowerpot {d}"))
            rows.append(row("assistant", (f"reply {d} {i}. " + "The house hums and the dishes pile up. " * 25), d))
    ledger = [{"day": 1, "tier": "day", "text": "day one", "events": [], "themes": []},
              {"day": 2, "tier": "day", "text": "day two", "events": [], "themes": []}]
    queries = ["Let's make dinner together?", "Where was that lighthouse key flowerpot hidden again?", "Who is sitting by the pool right now?"]
    result = {}
    for label in ("before", "after"):
        wires = []
        cur = list(rows)
        for q in queries:
            cur = cur + [row("user", q)]
            view = dc.apply_prompt_view(cur, ledger)
            names: list = []
            if label == "after":
                withr = tr.apply_recall(cur, view, names)
            else:
                text = tr.build_recall(cur, view, tr._last_user_text(view), names)
                si = next((i for i, m in enumerate(view) if m.get("role") == "system" and str(m.get("content", "")).startswith("[Story so far]")), None)
                withr = view if (not text or si is None) else view[: si + 1] + [{"role": "user", "content": text}] + view[si + 1:]
            wires.append([{k: v for k, v in m.items() if k != "_protected"} for m in withr])
            cur = cur + [row("assistant", f"answer to {q} " + "x" * 600, 3)]
        result[label] = [measure(wires[i - 1], wires[i]) for i in range(1, len(wires))]
    return result



# ── the soft input-budget trim (sliding window) ──────────────────────────────────────

def _convo(n: int) -> list:
    return _history(n, chars=2400)


def audit_trim(budget_tokens: int = 48_000, start_turns: int = 80, steps: int = 6, system_chars: int = 76_000) -> dict:
    """Consecutive turns once the history no longer fits the input budget. `trim_for_context` (what the agent loop calls) drops the OLDEST
    turns until the request fits, so each new turn moves the cut by about one turn and the prefix after the system message shifts: only
    the system messages stay a stable prefix. `proposedHysteresis` was the SIMULATION of a policy (cut a quarter of the budget at once, then hold
    the cut until the budget is exceeded again); since ORW-555's follow-up it IS the shipped trim (context_compactor `TRIM_TARGET_SHARE`, `ORWELL_TRIM_HYSTERESIS`),
    so the two lines now read alike."""
    from src.context_compactor import estimate_tokens, trim_for_context

    sys_msg = {"role": "system", "content": "S" * system_chars}
    out: dict = {"budgetTokens": budget_tokens}
    for label in ("shipped", "proposedHysteresis"):
        wires = []
        cut = 0   # proposed policy state: number of oldest rows currently cut
        for k in range(steps):
            conv = _convo(start_turns + k)
            msgs = [sys_msg] + conv
            if label == "shipped":
                wires.append(trim_for_context(msgs, budget_tokens, preserve_system=True))
            else:
                budget_rows = budget_tokens - estimate_tokens([sys_msg])
                def fits(c):
                    return estimate_tokens(conv[c:]) <= budget_rows
                if not fits(cut):
                    target = int(budget_rows * 0.75)
                    while cut < len(conv) - 1 and estimate_tokens(conv[cut:]) > target:
                        cut += 2
                wires.append([sys_msg] + conv[cut:])
        out[label] = [measure(wires[i - 1], wires[i]) for i in range(1, len(wires))]
    return out


# ── the other call sites: capture the messages each really builds ────────────────────

def _capture_llm_call_async(captured: list) -> Callable:
    async def fake(*_a, **kw):
        captured.append(copy.deepcopy(kw.get("messages")))
        return ""
    return fake


def _run(coro):
    return asyncio.run(coro)


def _site_day_condense() -> list:
    from src import orwell_day_condense as dc
    return [dc._day_messages(3, "Player: hi\nNarration: " + "words " * 400, 120), dc._day_messages(4, "Player: hey\nNarration: " + "other " * 600, 150)]


def _site_extractions() -> list:
    from src import agent_loop as al
    out: list = []
    houses = [[{"id": "npc:1", "name": "Alex Quill"}, {"id": "npc:2", "name": "Bram Torrey"}]] * 2
    inputs = [("I walk to the kitchen", "She follows you into the kitchen and starts the kettle."),
              ("Let's go outside", "Bram leads you out to the yard and shuts the door.")]
    import src.llm_core as lc
    real = lc.llm_call_async
    cap: list = []
    lc.llm_call_async = _capture_llm_call_async(cap)
    try:
        for name, fn_name in (("scene+moves (merged)", "_merged_turn_extract"), ("npc-move", "_move_npc_extract"), ("player-move", "_move_player_extract")):
            cap.clear()
            for (lu, nar), house in zip(inputs, houses):
                fn = getattr(al, fn_name)
                if fn_name == "_move_player_extract":
                    _run(fn(nar, lu, DEEPSEEK_URL, "deepseek-v4-flash", {}, None))
                else:
                    _run(fn(nar, lu, house, DEEPSEEK_URL, "deepseek-v4-flash", {}, None))
            out.append((name, [c for c in cap if c]))
    finally:
        lc.llm_call_async = real
    return out


def _site_simple() -> list:
    """(name, [messages call 1, messages call 2]) for the sites whose message builders are plain functions."""
    out = []

    def add(name, fn):
        try:
            out.append((name, fn()))
        except Exception as e:  # recorded, never hidden: a site we could not build is reported as not measurable
            out.append((name, f"not measurable: {type(e).__name__}"))

    from src import orwell_day_condense as dc
    add("day-condense (one call)", lambda: _site_day_condense())
    add("day-condense (chunk n of m)", lambda: [dc._chunk_messages(3, 1, 3, "Player: hi\n" + "w " * 500, 90), dc._chunk_messages(3, 2, 3, "Player: ho\n" + "v " * 500, 90)])
    add("day-condense (merge)", lambda: [dc._merge_messages(3, ["note one " * 20, "note two " * 20], 150), dc._merge_messages(4, ["note a " * 30, "note b " * 25], 160)])
    from src import orwell_gen_competitions as gc
    stag = lambda w, d: {"type": "endurance", "format": "endurance", "winner": {"name": w}, "dropOrder": [{"name": n} for n in d],
                         "participants": [{"name": n} for n in [w] + d], "library": {"name": "Lib", "premise": "premise text"}}
    add("competitions", lambda: [gc._synthesis_messages(stag("Ann Lee", ["Bo Ray", "Cy Day"])), gc._synthesis_messages(stag("Di Fox", ["Ed Gil", "Fay Hu", "Gus Ito"]))])
    from src import orwell_zeitgeist as zg
    add("zeitgeist", lambda: [zg._synthesis_messages("June 2026", "research one " * 50), zg._synthesis_messages("June 2026", "research two " * 70)])
    from src import orwell_offscreen_texture as ot
    add("offscreen-texture", lambda: [ot._voicing_messages("alliance-talk", ["npc:1", "npc:2"], "They talk quietly.", "zeit " * 30), ot._voicing_messages("rivalry", ["npc:3", "npc:4"], "They argue.", "zeit " * 30)])
    from src import orwell_npc_minds_words as nm
    card = lambda i: {"id": f"npc:{i}", "name": f"Name{i}", "age": 20 + i, "job": "barista", "hometown": "Town"}
    add("npc-minds (traits)", lambda: [nm.traits_messages(card(1)), nm.traits_messages(card(2))])
    from src import orwell_cast_genesis as cg
    roster = lambda n: [{"id": f"npc:{i}"} for i in range(1, n + 1)]
    add("cast-genesis", lambda: [cg.build_genesis_messages(roster(1), {}, used_names=[]), cg.build_genesis_messages([{"id": "npc:2"}], {}, used_names=["Ann Lee", "Bo Ray"], used_facets={"hometowns": ["Reno"], "vocations": ["nurse"], "castSize": 15})])
    from src import orwell_house_reflections as hr
    story = lambda: {"id": "npc:1", "name": "Alex", "events": [{"night": 1, "text": "x"}]}
    add("house-reflections", lambda: [hr.reflection_messages(story(), 1), hr.reflection_messages(story(), 2)])
    from src import orwell_cast_identity as ci
    add("cast-identity", lambda: [ci.build_identity_messages([{"id": "npc:1", "name": "Alex Quill"}]), ci.build_identity_messages([{"id": "npc:1", "name": "Alex Quill"}, {"id": "npc:2", "name": "Bram Torrey"}])])
    return out


def audit_sites() -> list:
    rows = []
    try:
        pairs = _site_simple() + _site_extractions()
    except Exception as e:
        return [{"site": "all", "note": f"not measurable: {type(e).__name__}: {e}"}]
    for name, calls in pairs:
        if isinstance(calls, str) or len(calls) < 2:
            rows.append({"site": name, "note": calls if isinstance(calls, str) else "fewer than two calls captured"})
            continue
        rows.append({"site": name, **measure(calls[0], calls[1])})
    return rows


# ── report ───────────────────────────────────────────────────────────────────────────

def build_report(turns: list) -> dict:
    return {
        "narrator": {"withVolatileTail": audit_narrator(turns, tail=True), "withoutVolatileTail": audit_narrator(turns, tail=False)},
        "brief": audit_brief(turns), "recall": audit_recall(), "trim": audit_trim(), "sites": audit_sites(),
    }


def _pct(x) -> str:
    return "n/a" if x is None else f"{100 * x:5.1f}%"


def render(rep: dict) -> str:
    L = ["Prompt-prefix audit (stable-prefix share = chars before the first differing byte / chars of the request)", ""]
    for k, label in (("withoutVolatileTail", "Narrator, round 1, WITHOUT the volatile-tail reorder"), ("withVolatileTail", "Narrator, round 1, as shipped")):
        n = rep["narrator"][k]
        L.append(f"{label}: mean {_pct(n['meanShare'])}")
        for r in n["rows"]:
            L.append(f"  {r['tokens']:>7} tok, prefix {r['prefixTokens']:>7} tok, share {_pct(r['share'])}; first difference at: ...{r['firstDiff'][:90]}...")
    L.append("")
    for t in rep["brief"]["turns"]:
        L.append(f"Show Brief: {t['briefChars']} chars; section 7 starts at char {t['section7At']} ({t['section7Chars']} chars, last section: {t['section7IsLast']})")
    L.append("")
    for k in ("before", "after"):
        L.append(f"Recall turn, {k} the fix: " + ", ".join(f"turn {i + 2} share {_pct(r['share'])}" for i, r in enumerate(rep["recall"][k])))
    L.append("")
    t = rep["trim"]
    L.append(f"History over the {t['budgetTokens']}-token input budget, consecutive turns:")
    for k in ("shipped", "proposedHysteresis"):
        L.append(f"  {k:<20} " + ", ".join(_pct(r["share"]).strip() for r in t[k]))
    L.append("")
    L.append("Other call sites (two consecutive calls, fake inputs):")
    for r in rep["sites"]:
        if "note" in r:
            L.append(f"  {r['site']:<32} {r['note']}")
        else:
            L.append(f"  {r['site']:<32} {r['tokens']:>6} tok  prefix {r['prefixTokens']:>6} tok  share {_pct(r['share'])}")
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--turns", required=True, help="JSON from scripts/probes/promptPrefix.ts")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    turns = json.loads(Path(a.turns).read_text(encoding="utf-8"))
    rep = build_report(turns)
    print(json.dumps(rep, indent=2) if a.json else render(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
