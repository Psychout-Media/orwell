"""ORW-1042 (audit 11-26 A3): belt telemetry counts attempts as well as applied corrections, and the advance-stall nudge is counted when it is sent.

1. Every consequence belt notes an ATTEMPT where its gate passed and its extraction is next (`_note_belt_attempt`), beside the success-gated applied count
   (`_note_belt` / `note_belt_fire`); the admin snapshot's `beltPrecision` gives attempts, applied and missed per belt. The prefetch's extract-only pass is not an attempt.
2. `advance-stall-nudge` is noted where the nudge is appended to the messages, not where the stall is first seen.
Roles only; no live model."""
import importlib
import inspect
import re

al = importlib.import_module("src.agent_loop")
ledger = importlib.import_module("src.orwell_sync_ledger")


def _reset():
    ledger._BELT_ATTEMPTS.clear()
    ledger._BELT_APPLIED.clear()


def test_attempts_applied_and_missed_per_belt():
    _reset()
    for _ in range(3):
        ledger.note_belt_attempt("auto-confide")
    ledger.note_belt_fire("p", "auto-confide")
    ledger.note_belt_fire("p", "forced-advance:stall")  # applied only (no attempt counter): not a precision row
    prec = ledger.get_belt_precision()
    assert prec == {"auto-confide": {"attempts": 3, "applied": 1, "missed": 2}}
    _reset()


def test_the_prefetch_extract_only_pass_is_not_an_attempt():
    _reset()
    tok = al._BELT_EXTRACT_ONLY.set(True)
    try:
        al._note_belt_attempt("auto-record-scene")
    finally:
        al._BELT_EXTRACT_ONLY.reset(tok)
    assert ledger.get_belt_precision() == {}
    al._note_belt_attempt("auto-record-scene")
    assert ledger.get_belt_precision()["auto-record-scene"]["attempts"] == 1
    _reset()


def test_every_belt_that_makes_an_extraction_call_notes_its_attempt():
    """A new consequence belt without an attempt counter fails here (its misses would be invisible)."""
    src = inspect.getsource(al)
    names = re.findall(r"^async def (_auto_[a-z_]+)\(", src, re.M)
    missing = []
    for n in names:
        body = inspect.getsource(getattr(al, n))
        extracts = re.search(r"await (_belt_llm|llm_call_async|_[a-z_]*_extract)\(", body)
        if extracts and "_note_belt_attempt(" not in body:
            missing.append(n)
    assert not missing, f"belts with an extraction call and no attempt counter: {missing}"


def test_the_stall_nudge_is_counted_where_it_is_sent_not_where_the_stall_is_seen():
    src = inspect.getsource(al)
    sent = 'messages.append({"role": "system", "content": _nudge})\n'
    i = src.index(sent)
    assert '_note_belt(owner, "advance-stall-nudge")' in src[i:i + 400], "counted right after the nudge is appended"
    assert src.count('_note_belt(owner, "advance-stall-nudge")') == 1, "and nowhere else (not at the trigger)"
