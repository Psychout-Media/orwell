"""ORW-1144 (test gap behind ORW-1125): act-first shipped with a crash on its main "acted" path because nothing played a turn per act-first outcome through the real loop. This does.

Real engine (dist/main.js) + the real FE turn route (the game's WebSocket `turn` rides the same `chat_stream` producer) + a scripted OpenAI-compatible stub as the FAKE MODEL (it answers the act-first round with a
scripted tool call, and the narrator with a scripted reply or tool call). ORWELL_ACT_FIRST is ON for the whole stack. One turn per outcome, each must run to a completed reply (`message_saved`, `[DONE]`, no error
event) and write exactly one ledger row that is not a failed turn:
  acted (direct applies only) | acted plus a narrator tool | noAction | skipped:no-cue | skipped:ungrounded | pre-filter skip (skipped:ooc).
The outcome itself is read off the FE's own `act-first outcome=` log line, so a test that passes cannot be one where the round never ran. Pre-#3476 the first two turns die (UnboundLocalError) and fail here.
Roles only; no player text. Needs the built engine bundle (`npm run build`)."""
from __future__ import annotations

import json
import os
import pathlib

import pytest

import test_m0_3_midgen_join as m03
from test_m0_3_midgen_join import STUB
from test_m0_3_midgen_join import _post_form, _post_json
from _ws_turn_driver import ws_turn

pytestmark = pytest.mark.browser


@pytest.fixture(scope="module")
def stack_af():
    prior = os.environ.get("ORWELL_ACT_FIRST")
    os.environ["ORWELL_ACT_FIRST"] = "1"  # the FE subprocess inherits it
    try:
        yield from m03._boot_stack(auth_user="orw1144")  # a real user: an anonymous stack has no owner, so the sync ledger would record nothing
    finally:
        if prior is None:
            os.environ.pop("ORWELL_ACT_FIRST", None)
        else:
            os.environ["ORWELL_ACT_FIRST"] = prior


def _new_game(stack):
    r = _post_json(stack["fe"], "/api/orwell/new-game", {"playerName": "P", "confirm": True, "seed": 1}, timeout=120, headers=stack["auth"])
    assert r.get("started"), r


def _session(stack, name):
    sid = _post_form(stack["fe"], "/api/session", {"name": name, "model": "stub-narrator", "skip_validation": "true", "endpoint_id": stack["endpoint_id"]}, headers=stack["auth"]).get("id")
    assert sid, "could not create the FE chat session"
    return sid


def _rows(stack):
    f = pathlib.Path(stack["fe_data"]) / "orwell_sync_ledger.json"
    if not f.exists():
        return []
    return [e for rows in json.loads(f.read_text()).values() for e in rows]


def _log(stack):
    return pathlib.Path(stack["fe_log"]).read_text(errors="replace")


# (name, expected act-first outcome, message, scripted act-first answer, narrator script)
_NARRATE = [{"deltas": ["The house settles."], "delay": 0}]
CASES = [
    ("acted-direct-only", "acted", "I head to the kitchen.", [{"name": "moveTo", "args": {"rooms": ["kitchen"]}}], _NARRATE),
    ("acted-plus-narrator-tool", "acted", "I walk over to the dining room.", [{"name": "moveTo", "args": {"rooms": ["dining-room"]}}],
     [{"tool_calls": [{"name": "advanceGame", "args": {}}]}, {"deltas": ["The day moves on."], "delay": 0}]),
    ("noAction", "noAction", "I wonder what is going on in the kitchen right now.", [], _NARRATE),
    ("skipped-no-cue", "skipped:no-cue", "Nice to meet you all.", None, _NARRATE),
    ("skipped-ungrounded", "skipped:ungrounded", "Hello everyone, how is the day going?", None, _NARRATE),
    ("prefilter-skip", "skipped:ooc", "ooc: brb one minute", None, _NARRATE),
]


def test_one_turn_per_act_first_outcome_runs_to_a_reply_and_a_ledger_row(stack_af):
    _new_game(stack_af)
    sid = _session(stack_af, "orw1144")
    problems = []
    for i, (name, outcome, text, act, narrate) in enumerate(CASES):
        STUB.script.clear()
        STUB.forced_script.clear()
        if act is not None:
            STUB.forced_script.append({"tool_calls": act})
        STUB.script.extend(narrate)
        rows_before, log_before = len(_rows(stack_af)), len(_log(stack_af))
        try:
            res = ws_turn(stack_af["fe"], sid, text, timeout=120, client_msg_id=f"orw1144-{i}", headers=stack_af["auth"])
        except Exception as exc:  # a typed refusal or a timeout is a failed turn
            problems.append(f"{name}: the turn did not complete ({type(exc).__name__})")
            continue
        body = res["body"].lower()
        if "event: error" in body or '"retry": true' in body:
            problems.append(f"{name}: the turn streamed an error event")
        if not res["done"] or not res["saved"]:
            problems.append(f"{name}: no completed reply (done={res['done']}, saved={len(res['saved'])})")
        new = _log(stack_af)[log_before:]
        if f"act-first outcome={outcome} " not in new:
            problems.append(f"{name}: the act-first round did not end as {outcome}")
        rows = _rows(stack_af)
        if len(rows) != rows_before + 1:
            problems.append(f"{name}: expected exactly one new ledger row, got {len(rows) - rows_before}")
        elif rows[-1].get("unledgered") == "failed" or rows[-1].get("drivenBy") == "error":
            problems.append(f"{name}: the turn was ledgered as a failure")
        elif outcome == "acted" and not any(str(b).startswith("act-first:") for b in (rows[-1].get("beltsFired") or {})):
            problems.append(f"{name}: an acted turn must carry its act-first commit on the ledger row")
        if name == "acted-plus-narrator-tool" and "advanceGame" not in (rows[-1].get("toolsCalled") or [] if rows else []):
            problems.append(f"{name}: the narrator's own tool call is missing from the ledger row")
        if "chat_stream generator failed" in new:
            problems.append(f"{name}: the chat_stream generator failed")
    if problems:
        print("DEBUG", os.listdir(stack_af["fe_data"]), [l for l in _log(stack_af).splitlines() if "sync-ledger" in l or "ledger" in l.lower()][-6:])
    assert not problems, "; ".join(problems)
