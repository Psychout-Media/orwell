"""ORW-1156 gate: a replay of the 11-28 session SHAPES (as codes, synthetic sentences) through the claim check. BEFORE = the claims with no commit behind them in what main would show;
AFTER = the same after the check's withhold / commit / regenerate path. After must be zero. Roles only: no player chat, no cast text."""
import pytest

from src import claim_commit as cc
from src import engine_read_cache
from src import predisplay_check as pc

OWNER = "replay-owner"
WH = {"room": "bedroom-a", "roomNames": {}, "present": []}
NIGHT = {"timeOfDay": "night", "whereabouts": WH}
MORNING = {"timeOfDay": "morning", "whereabouts": WH}

# code, the narration as first generated, the player's own message (a plain role sentence), the commits the model made itself, what the redo says when told the real state
SHAPES = [
    ("S4-bed-claimed-in-prose-asked", "You claim the single bed by the window. Rowan frowns.", "I claim a single bed in here.", [], "The beds stand ready. Rowan frowns."),
    ("S5-bed-claimed-in-prose-not-asked", "You grab the bunk by the door as Rowan watches.", "Hello everyone.", [], "Rowan watches the bunks, undecided."),
    ("S6-alliance-from-npc-line", "Rowan pitches it with a grin. You shake on it: the alliance is formed.", "What do you mean by that?", [], "Rowan pitches it with a grin, and waits."),
    ("S7-deal-struck-without-yes", "You strike a deal with Rowan over the counter.", "Let me think about it.", [], "Rowan lays out terms over the counter."),
    ("S9-correct-bed-with-commit", "You claim the single bed by the window.", "I claim a single bed in here.", ["claimBed"], None),
]


def _unbacked(text, state, owner):
    return cc.unbacked(text, state, owner)


def _replay(monkeypatch):
    cur = {"state": NIGHT}
    monkeypatch.setattr(engine_read_cache, "peek", lambda *a, **k: cur["state"])
    before = after = committed = regenerated = 0
    rows = []
    for code, text, user, model_tools, redo in SHAPES:
        cc.end_turn(OWNER)
        cur["state"] = NIGHT
        for t in model_tools:
            cc.note_event(OWNER, {"tool": t, "exit_code": 0})
            if t == "turnIn":
                cur["state"] = MORNING
        b = len(_unbacked(text, cur["state"], OWNER))
        sp = pc.split_at_first_conflict(text, OWNER)
        shown = text if sp is None else sp.keep
        if sp is not None:
            plan = cc.commit_plan(sp.conflicts, user, rooms=("bedroom-a", "bedroom-b", "kitchen"), here="bedroom-a")
            for tool, _args in plan:
                if tool in ("turnIn", "claimBed"):
                    cc.note_event(OWNER, {"tool": tool, "exit_code": 0})
                    committed += 1
                    if tool == "turnIn":
                        cur["state"] = MORNING
            regenerated += 1
            shown += text[len(sp.keep):] if plan else (redo or "")
        a = len(_unbacked(shown, cur["state"], OWNER))
        before += b
        after += a
        rows.append((code, b, a))
    return before, after, committed, regenerated, rows


def test_replay_zero_claims_without_commit_after(monkeypatch):
    before, after, committed, regenerated, rows = _replay(monkeypatch)
    print(f"ORW-1156 replay: claims without commit BEFORE={before} AFTER={after} committed-through-real-tool={committed} regenerated={regenerated}")
    for r in rows:
        print("  ", r)
    assert before == 4  # S4 to S7 each make one unbacked claim; S9 is backed (sleep shapes are ORW-1154's, not counted here)
    assert after == 0
    assert committed == 1 and regenerated == 4  # S4 (claimBed) is committed; every other unbacked reply is redone


def test_main_shows_all_of_them():
    """On main nothing joined a claim to a commit: the same replay with the check off shows every unbacked claim (the failing-before half)."""
    import re
    shown = sum(len(cc.extract_claims(t)) for _, t, _, tools, _ in SHAPES if not tools)
    assert shown == 4
