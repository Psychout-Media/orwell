"""M1-3 (audit A3) — the board renders on beatSeq delta; ceremony beats kick the rail.

The status HUD refetches on `orwell:gamechanged`, but a refetch can READ pre-commit state
(the goodbye-card-beside-a-stale-board race) and then nothing re-kicks until the 20–30s
poll. The fix threads the COMMITTED beatSeq from the seams that know it (chat tool result,
decision POST response) through THE single g15 dispatcher, and the panel catch-up-fetches
(bounded) until its read reaches the claimed beat. These are source pins on all four
seams; `test_g15_gamechanged.py` still proves the one-dispatcher rule.
"""
from __future__ import annotations

import os
import re

JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")


def _read(name: str) -> str:
    with open(os.path.join(JS, name), encoding="utf-8") as fh:
        return fh.read()


def test_dispatcher_coalesces_the_highest_beat_and_carries_it_in_detail():
    src = _read("platform.js")
    m = re.search(r"export function orwellGameChanged\(([^)]*)\)", src)
    assert m and "beatSeq" in m.group(1), "the single dispatcher accepts a beatSeq arg"
    assert re.search(r"b > _gameChangedBeat\)\s*_gameChangedBeat = b", src), (
        "the debounce window must coalesce to the HIGHEST beat seen")
    # The detail object is built in a local before dispatch (#1785 AC3 adds an optional correction).
    assert re.search(r"(?:detail:|const detail =)\s*\{[^}]*beatSeq", src), "the event detail carries beatSeq"
    assert re.search(r"new CustomEvent\('orwell:gamechanged',\s*\{\s*detail\s*\}", src), (
        "the dispatched event carries that detail")


def test_chat_tool_result_seam_passes_the_committed_beat():
    src = _read("chat.js")
    seam = re.search(
        r"let _beat\b.*?JSON\.parse\(json\.output.*?_beat = _parsed\.beatSeq.*?"
        r"window\.orwellGameChanged\('tool:' \+ json\.tool, _beat\b", src, re.S)
    assert seam, ("the game-mutating tool-result seam must parse the result's beatSeq "
                  "and pass it through the shared dispatcher")


def test_decision_post_passes_the_response_beat():
    src = _read("orwellDecision.js")
    assert re.search(
        r"_beat = \(\(await r\.json\(\)\) \|\| \{\}\)\.beatSeq.*?"
        r'window\.orwellGameChanged\("decision:" \+ kind, _beat\)', src, re.S), (
        "the decision confirm must read the commit's beatSeq off the response and pass it")


def test_status_panel_catch_up_fetches_until_the_claimed_beat():
    src = _read("orwellStatusPanel.js")
    assert re.search(r"async function refresh\(wantBeat\)", src), (
        "refresh() takes the claimed beat")
    assert re.search(r"got < want && _catchupTries < 3", src), (
        "the catch-up must be BOUNDED (never an unbounded refetch loop)")
    assert re.search(r"setTimeout\(\(\) => refresh\(want\), 1000\)", src), (
        "a raced read re-fetches shortly, instead of waiting out the poll interval")
    assert re.search(
        r'addEventListener\("orwell:gamechanged", \(e\) => \{.*?'
        r"start\(e && e\.detail \? e\.detail\.beatSeq : undefined\)", src, re.S), (
        "the gamechanged listener threads the event's beatSeq into the refetch")


def test_poll_cadence_unchanged():
    src = _read("orwellStatusPanel.js")
    assert re.search(r"const POLL_MS = 20000", src), (
        "M1-3 keeps the 20s poll cadence (the DoR decision) — freshness comes from the "
        "event path, not a faster poll")
