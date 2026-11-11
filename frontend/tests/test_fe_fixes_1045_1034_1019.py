"""FE fixes — #1045 (F16 guard single-tenant + running-count regexes), #1034 (casting framing),
#1019 / F9 (pending-aware framed beat key).

These exercise three chat_helpers fixes the live drive surfaced:

  • #1045 part 1 — the pre-emission outcome guard keyed its per-turn baseline on `user`; under a
    single-tenant path (AUTH_ENABLED=false) `user=None`, so the baseline was effectively inert and
    the guard FAILED OPEN every turn. The fix keys the desync stores via `_desync_key` — `user` when
    present, else the canonical game-session id — so the guard functions single-tenant too. Cross-user
    isolation must stay intact (a real user always keys on its own identity, never the session).
  • #1045 part 2 — the eviction-claim regexes missed live running-count phrasings ("eight votes to
    evict", "nine to one … eleven to evict", "unanimous", "out of the house/game"). The engine NEVER
    counts (anonymized ballots only), so ANY tally / "N to M" / committed-exit narrated before the
    engine's eviction commit is a fabrication to HOLD.
  • #1034 — the casting framing must keep the producer persona (no "drop the persona"), stay out of an
    informal/meta register, and avoid degenerate ultra-terse turns.
  • #1019 / F9 — a comp-intent submitted via the decision-card POST resolves the engine's `pending`
    WITHOUT moving (week, phase, moment); folding the open pending's `kind` into the framed beat key
    lets a resolved pending flip peer-advance detection. Back-compat: NO open pending → the original
    3-tuple key (byte-identical).

Roles only — proper nouns inside narration strings are throwaway tokens exercising the regexes, never
canonical cast.
"""

import asyncio
import importlib
import os

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
orwell_game_session = importlib.import_module("src.orwell_game_session")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as fh:
        return fh.read()


# Board fakes (mirrors the sibling 0065 guard tests): a stable eviction-phase board where the
# evicted count does NOT move, so any eviction/tally claim during the eviction phase is a phantom.
def _board_fakes(monkeypatch, *, phase="eviction", evicted=0, finished=False, week=1):
    house = [{"id": "player", "status": "active"}, {"id": "npc:2", "status": "active"}]
    for i in range(evicted):
        house.append({"id": f"npc:{100 + i}", "status": "evicted"})

    async def fake_status(user=None):
        return {"week": week, "phase": phase, "hoh": {"id": "npc:1"},
                "nominees": [{"id": "npc:2"}, {"id": "npc:3"}],
                "veto": {"holder": None, "used": False, "players": []},
                "pending": None, "beatSeq": 7}

    async def fake_state(user=None, **kw):
        return {"week": week, "phase": phase, "finished": finished, "house": house, "beatSeq": 7}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)


def _evict_sig(**kw):
    base = {"week": 1, "phase": "eviction", "pending": None, "hoh": "npc:1",
            "noms": ["npc:2", "npc:3"], "vetoHolder": None, "vetoUsed": False,
            "evicted": 0, "finished": False}
    base.update(kw)
    return base


# ════════════════════════════════════════════════════════════════════════════
#  #1045 part 1 — the guard functions single-tenant (user=None, keyed on session)
# ════════════════════════════════════════════════════════════════════════════

def test_desync_key_uses_user_when_present():
    """A real (truthy) user keys on its own identity — never the session fallback."""
    assert chat_helpers._desync_key("real-user") == "real-user"


def test_desync_key_falls_back_to_canonical_session_when_userless(monkeypatch):
    """user=None → key on the canonical game-session id (`gs:<id>`), so the guard has a stable
    per-game baseline single-tenant too."""
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda user: "sess-XYZ")
    assert chat_helpers._desync_key(None) == "gs:sess-XYZ"


def test_desync_key_falls_back_to_raw_user_when_no_binding(monkeypatch):
    """No canonical binding yet → fall soft to the raw `user` (byte-identical to prior behaviour)."""
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda user: None)
    assert chat_helpers._desync_key(None) is None


def test_guard_fires_with_user_none_keyed_on_session(monkeypatch):
    """THE #1045 REGRESSION: with user=None and a baseline stashed under the canonical-session key,
    a phantom eviction (ahead of the engine commit) is HELD — the guard is NOT inert single-tenant.

    Pre-fix the guard read `_LAST_BEAT_SIG.get(None)` (empty) and emitted; post-fix it reads the
    session-keyed baseline and holds. Fail-before / pass-after."""
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda user: "sess-single")
    key = "gs:sess-single"
    chat_helpers._LAST_BEAT_SIG.pop(key, None)
    chat_helpers._DESYNC_REGROUND.pop(key, None)
    # the baseline the framing checkpoint would have stashed for this userless single-tenant turn
    chat_helpers._LAST_BEAT_SIG[key] = _evict_sig(phase="eviction", evicted=0)
    _board_fakes(monkeypatch, phase="eviction", evicted=0)  # the engine has NOT committed an eviction

    emit = _run(chat_helpers.screen_streamed_outcome(
        None, "Eleven to evict — a landslide. You have been voted out of the house."))
    assert emit is False, "the guard must HOLD a phantom eviction even when user=None"
    assert key in chat_helpers._DESYNC_REGROUND
    assert "RE-GROUND" in chat_helpers._DESYNC_REGROUND[key]
    chat_helpers._LAST_BEAT_SIG.pop(key, None)
    chat_helpers._DESYNC_REGROUND.pop(key, None)


def test_guard_with_user_none_holds_a_tally_ahead_of_phase(monkeypatch):
    """A self-counted running TALLY narrated during the eviction phase before the commit is HELD
    single-tenant too (the engine never hands the player a count)."""
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda user: "sess-tally")
    key = "gs:sess-tally"
    chat_helpers._LAST_BEAT_SIG.pop(key, None)
    chat_helpers._DESYNC_REGROUND.pop(key, None)
    chat_helpers._LAST_BEAT_SIG[key] = _evict_sig(phase="eviction", evicted=0)
    _board_fakes(monkeypatch, phase="eviction", evicted=0)

    emit = _run(chat_helpers.screen_streamed_outcome(
        None, "Nine to one — that's the majority, the vote is unanimous against you."))
    assert emit is False
    assert key in chat_helpers._DESYNC_REGROUND
    chat_helpers._LAST_BEAT_SIG.pop(key, None)
    chat_helpers._DESYNC_REGROUND.pop(key, None)


def test_cross_user_isolation_preserved(monkeypatch):
    """Two DIFFERENT real users never collide: each keys on its own identity, never the session
    fallback. A baseline stashed for user A must NOT ground a guard call for user B."""
    # If the session fallback ever engaged for a real user, this binding would leak A's baseline to B.
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda user: "shared-sess")
    chat_helpers._LAST_BEAT_SIG.pop("userA", None)
    chat_helpers._LAST_BEAT_SIG.pop("userB", None)
    chat_helpers._DESYNC_REGROUND.pop("userA", None)
    chat_helpers._DESYNC_REGROUND.pop("userB", None)
    # only user A has a baseline; user B has none.
    chat_helpers._LAST_BEAT_SIG["userA"] = _evict_sig(phase="eviction", evicted=0)
    _board_fakes(monkeypatch, phase="eviction", evicted=0)

    # user B has NO baseline → uncertain → EMIT (never grounds against A's baseline / the session).
    emit_b = _run(chat_helpers.screen_streamed_outcome(
        "userB", "You have been voted out of the house."))
    assert emit_b is True, "user B must not be grounded by user A's baseline (isolation)"
    assert "userB" not in chat_helpers._DESYNC_REGROUND
    # user A still grounds correctly against its OWN baseline → HOLD.
    emit_a = _run(chat_helpers.screen_streamed_outcome(
        "userA", "You have been voted out of the house."))
    assert emit_a is False
    assert "userA" in chat_helpers._DESYNC_REGROUND
    chat_helpers._LAST_BEAT_SIG.pop("userA", None)
    chat_helpers._DESYNC_REGROUND.pop("userA", None)


# ════════════════════════════════════════════════════════════════════════════
#  #1045 part 2 — broadened running-count / committed-exit eviction regexes
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("text", [
    "Eight votes to evict you tonight.",
    "Eleven to evict — a landslide.",
    "You have been voted out.",
    "You are now out of the house.",
    "They are out of the game.",
    "A unanimous vote to evict.",
])
def test_broadened_evicted_claims_match(text):
    assert chat_helpers._CLAIM_EVICTED_RE.search(text), text


@pytest.mark.parametrize("text", [
    "The lights are out.",
    "She is leaving the kitchen.",
    "If you get evicted, you'd join the jury.",
])
def test_broadened_evicted_claims_do_not_overmatch(text):
    assert not chat_helpers._CLAIM_EVICTED_RE.search(text), text


@pytest.mark.parametrize("text", [
    "Nine to one.",
    "Ten to one in favour.",
    "Eleven to evict.",
    "The count is 8 votes to 7.",
])
def test_broadened_tally_claims_match(text):
    assert chat_helpers._CLAIM_TALLY_RE.search(text), text


@pytest.mark.parametrize("text", [
    "One or two of them might flip.",
    "She walks over to one corner of the room.",
])
def test_broadened_tally_claims_do_not_overmatch(text):
    assert not chat_helpers._CLAIM_TALLY_RE.search(text), text


@pytest.mark.parametrize("text", [
    "The vote is unanimous.",
    "Unanimously, the house evicts you.",
    "That's the majority.",
])
def test_unanimous_is_an_eviction_result_claim(text):
    assert chat_helpers._CLAIM_EVICT_RESULT_RE.search(text), text


@pytest.mark.parametrize("text", [
    "Eight votes to evict you tonight.",
    "Nine to one — the vote is unanimous.",
    "You are now out of the house.",
])
def test_pre_filter_routes_new_phrasings_to_the_verify(text):
    """Every broadened phrasing flows through the cheap closed-set pre-filter (the union of the
    _CLAIM_* detectors) so the live-board verify gets a chance to HOLD it."""
    assert chat_helpers._sentence_has_closed_set_claim(text), text


# ════════════════════════════════════════════════════════════════════════════
#  #1034 — casting framing: producer persona, no meta/informal, min substance
# ════════════════════════════════════════════════════════════════════════════

def test_casting_register_note_reinforces_persona_and_substance():
    src = _read("routes", "chat_helpers.py")
    # A casting-register reinforcement constant exists and is appended to the pre-game framing.
    assert "CASTING_REGISTER_NOTE" in src
    # It is wired into the pre-game (no-season) framing branch.
    note = chat_helpers.CASTING_REGISTER_NOTE.lower()
    # producer persona held (no "drop the persona" fourth-wall break)
    assert "persona" in note
    # forbids the informal/meta register the live drive surfaced ("lol")
    assert "lol" in note or "informal" in note or "meta" in note
    # demands a minimum substance per turn (the degenerate "Name." collapse)
    assert "substance" in note or "one word" in note or "terse" in note


def test_casting_register_note_appended_in_pre_game_branch():
    src = _read("routes", "chat_helpers.py")
    assert "CASTING_REGISTER_NOTE" in src
    # appended onto the pre-game prompt (the no-season casting branch).
    assert "pre_prompt = pre_prompt + " in src and "CASTING_REGISTER_NOTE" in src


# ════════════════════════════════════════════════════════════════════════════
#  #1019 / F9 — the pending-aware framed beat key
# ════════════════════════════════════════════════════════════════════════════

def _framing_fakes(monkeypatch, *, pending=None, moment="competition", phase="hoh-competition", week=1):
    async def fake_state(user=None, **kw):
        return {"started": True, "week": week, "phase": phase, "moment": moment,
                "pending": pending, "beatSeq": 7}

    async def fake_moment(moment, user=None, **_kw):
        return {"systemPrompt": "MOMENT-PROMPT"}

    async def fake_status(user=None):
        return {"week": week, "phase": phase, "hoh": {"id": "npc:1"},
                "nominees": [], "veto": {}, "pending": pending, "beatSeq": 7}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)


def test_framed_beat_key_is_three_tuple_without_pending(monkeypatch):
    """No open pending → the framed key stays the original (week, phase, moment) 3-tuple — byte
    identical to the prior contract (single-tab / seeded gates unchanged)."""
    user = "u-f9-nopending"
    chat_helpers._LAST_FRAMED_BEAT_KEY.pop(user, None)
    _framing_fakes(monkeypatch, pending=None, moment="competition", phase="hoh-competition")
    _run(chat_helpers.apply_game_framing([], user, False, session_id="sess-f9a"))
    key = chat_helpers._LAST_FRAMED_BEAT_KEY.get(user)
    assert key == (1, "hoh-competition", "competition")
    chat_helpers._LAST_FRAMED_BEAT_KEY.pop(user, None)


def test_framed_beat_key_folds_open_pending_kind(monkeypatch):
    """An open comp-intent pending → the framed key carries its `kind` as a 4th element, so when the
    decision-card POST resolves it (the next read drops back to a 3-tuple / a different pending) the
    key DIFFERS and peer-advance detection flips (F9 — the swallowed advance)."""
    user = "u-f9-pending"
    chat_helpers._LAST_FRAMED_BEAT_KEY.pop(user, None)
    _framing_fakes(monkeypatch, pending={"kind": "comp-intent"}, moment="competition",
                   phase="hoh-competition")
    _run(chat_helpers.apply_game_framing([], user, False, session_id="sess-f9b"))
    key = chat_helpers._LAST_FRAMED_BEAT_KEY.get(user)
    assert key == (1, "hoh-competition", "competition", "comp-intent")

    # Now the pending resolved out of band (POST) — the unchanged (week, phase, moment) read used by
    # the agent loop's _beat_key_at_read is a 3-tuple, which DIFFERS from the stashed 4-tuple.
    from src.agent_loop import _peer_advanced_since_framing
    resolved_read = (1, "hoh-competition", "competition")  # pending cleared, beat otherwise unchanged
    assert _peer_advanced_since_framing(False, key, resolved_read) is True
    chat_helpers._LAST_FRAMED_BEAT_KEY.pop(user, None)
