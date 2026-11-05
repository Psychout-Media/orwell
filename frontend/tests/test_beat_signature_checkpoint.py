"""The BEAT-SIGNATURE CHECKPOINT (layer 2 of the chat↔engine desync spine).

The pending-barrier (test_pending_barrier.py) catches the GM narrating PAST an open PLAYER
decision. It cannot catch the OTHER desync class: an advanceGame-driven beat with NO pending,
where the GM narrated an OUTCOME the engine never committed — "X is evicted", crowning the
finale winner a beat early, or a mis-narrated eviction tally. This second layer snapshots the
engine board before/after a turn, diffs the turn's full narration against that delta, and when
the narration asserts an outcome the board never moved on, stashes a forceful RE-GROUND
directive that apply_game_framing injects on the NEXT turn. Field-specific + conservative: a
false alarm is worse than a missed one, so each claim is checked against its own signature field.
"""

import asyncio
import importlib
import os

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── _beat_signature: the compact, comparable board snapshot ─────────────── #

def test_beat_signature_shape_from_sample_dicts():
    status = {
        "week": 5,
        "phase": "eviction",
        "hoh": {"id": "npc:3", "name": "A"},
        "nominees": [{"id": "npc:2"}, {"id": "npc:1"}],
        "veto": {"holder": {"id": "npc:4"}, "used": True, "players": []},
        "pending": {"kind": "eviction-vote"},
    }
    state = {
        "week": 5,
        "phase": "eviction",
        "finished": False,
        "house": [
            {"id": "player", "status": "active"},
            {"id": "npc:1", "status": "evicted"},
            {"id": "npc:2", "status": "active"},
        ],
    }
    sig = chat_helpers._beat_signature(status, state)
    assert sig == {
        "week": 5,
        "phase": "eviction",
        "pending": "eviction-vote",
        "hoh": "npc:3",
        "hohName": "A",                # A2 — the HOH's public name (for the wrong-identity guard)
        "noms": ["npc:1", "npc:2"],   # sorted
        "nomNames": [],                # #561 — nominee names (none named in this sample)
        "activeNames": [],             # #561 — active roster names (none named in this sample)
        "vetoHolder": "npc:4",
        "vetoHolderName": None,        # A2 — no name on the veto-holder node in this sample
        "vetoUsed": True,
        "playerIsHoh": None,           # A2 — no player card in this sample → unknown, never judged
        "playerHasVeto": None,
        "playerStatus": None,          # #1659 R2 — no player card ⇒ unknown status, the removal guard stands down
        "evicted": 1,                  # count of non-active house members
        "evictedNames": [],            # ADR 0009 D3 Part B — names of those out of the house (none named here)
        "finished": False,
        "room": None,                  # 0076 — player's live room (no `whereabouts` in this sample)
        "present": [],                 # 0076 — present company names (none in this sample)
        "finalHohPart": None,          # A17 - no Final-HOH part pending in this sample
        "compSig": None,               # A-9 — the competition pending's round-aware identity (none in this sample)
        "vetoFieldIds": [],            # F-3 — the veto competition field (none in this sample)
        "vetoFieldNames": [],
        "playerId": None,              # F-3 — the player id (no player in this sample)
        "compNotDue": None,            # N-16 - the engine says the scheduled competition is not due (None: no schedule in this sample)
        "evictionBallots": None,       # A-15 — the engine projects no `eviction` key in this sample ⇒ unknown (never judged)
        "evictionEvictee": None,       # P3 — tonight's committed evictee (none in this sample)
        "ballotCounts": None,          # PO 2026-11-04 — per-nominee ballot counts once ballots are read (none in this sample)
        "playerName": None,            # A-15 — the player's display name (role-claim guard roster; none in this sample)
        "beatSeq": None,               # A-9 — the engine beat counter (absent in this sample)
    }


def test_beat_signature_is_fail_safe_on_missing_fields():
    # Empty / odd shapes degrade to neutral values, never raise.
    sig = chat_helpers._beat_signature({}, {})
    assert sig["week"] is None and sig["phase"] is None and sig["pending"] is None
    assert sig["hoh"] is None and sig["noms"] == [] and sig["vetoHolder"] is None
    assert sig["vetoUsed"] is False and sig["evicted"] == 0 and sig["finished"] is False
    assert sig["evictedNames"] == []  # ADR 0009 D3 Part B — no house ⇒ no out-of-house names
    assert sig["room"] is None and sig["present"] == []  # 0076 — no whereabouts ⇒ neutral presence
    # Non-dict args also fail safe.
    assert chat_helpers._beat_signature(None, None)["evicted"] == 0
    assert chat_helpers._beat_signature("x", 7)["finished"] is False


# ── _narration_claims_outcome: the field-specific desync detector ───────── #

def test_eviction_claim_with_unchanged_count_is_a_desync():
    before = {"evicted": 2, "finished": False, "phase": "eviction", "week": 4}
    after = {"evicted": 2, "finished": False, "phase": "eviction", "week": 4}
    out = chat_helpers._narration_claims_outcome(
        "After a tense vote, Chandler is evicted from the house.", before, after,
    )
    assert out and "RE-GROUND" in out
    assert "EVICTION" in out
    # It states the real board and forbids repeating the outcome.
    assert "evicted" in out.lower()
    assert "did not" in out.lower() or "do NOT" in out
    assert "source of truth" in out.lower()


def test_winner_claim_when_not_finished_is_a_desync():
    before = {"evicted": 13, "finished": False, "phase": "finale", "week": 12}
    after = {"evicted": 13, "finished": False, "phase": "finale", "week": 12}
    out = chat_helpers._narration_claims_outcome(
        "Cynthia Hawkins is the winner of Big Brother, confetti raining down!", before, after,
    )
    assert out and "WINNER" in out
    assert "not finished" in out.lower()


def test_finale_tally_claim_when_not_finished_is_a_desync():
    before = {"evicted": 13, "finished": False, "phase": "finale", "week": 12}
    after = {"evicted": 13, "finished": False, "phase": "finale", "week": 12}
    out = chat_helpers._narration_claims_outcome(
        "The jury delivers its verdict: 8 votes to 1.", before, after,
    )
    assert out and "TALLY" in out


def test_new_hoh_claim_with_unchanged_hoh_is_a_desync():
    before = {"hoh": "npc:3", "evicted": 2, "finished": False, "phase": "hoh", "week": 3}
    after = {"hoh": "npc:3", "evicted": 2, "finished": False, "phase": "hoh", "week": 3}
    out = chat_helpers._narration_claims_outcome(
        "Marcus wins the Head of Household competition!", before, after,
    )
    assert out and "HEAD OF HOUSEHOLD" in out


# ── the conservative side: real outcomes + plain prose return None ──────── #

def test_eviction_claim_with_incremented_count_is_clean():
    before = {"evicted": 2, "finished": False, "phase": "eviction", "week": 4}
    after = {"evicted": 3, "finished": False, "phase": "eviction", "week": 4}  # someone left
    assert chat_helpers._narration_claims_outcome(
        "Chandler is evicted from the house.", before, after,
    ) is None


def test_winner_claim_with_finished_true_is_clean():
    before = {"evicted": 13, "finished": False, "phase": "finale", "week": 12}
    after = {"evicted": 13, "finished": True, "phase": "finale", "week": 12}  # season over
    assert chat_helpers._narration_claims_outcome(
        "Cynthia is the winner of Big Brother.", before, after,
    ) is None


def test_plain_social_narration_claims_nothing():
    before = {"evicted": 2, "finished": False, "phase": "social", "week": 3, "hoh": "npc:1"}
    after = {"evicted": 2, "finished": False, "phase": "social", "week": 3, "hoh": "npc:1"}
    assert chat_helpers._narration_claims_outcome(
        "They sit by the pool and trade reads on the house. Nothing is decided.", before, after,
    ) is None


def test_fresh_hoh_crown_is_not_a_desync():
    # before HOH empty → after HOH set: a real new reign, not a phantom one.
    before = {"hoh": None, "evicted": 0, "finished": False, "phase": "hoh", "week": 1}
    after = {"hoh": "npc:9", "evicted": 0, "finished": False, "phase": "hoh", "week": 1}
    assert chat_helpers._narration_claims_outcome(
        "Priya wins the first Head of Household of the season!", before, after,
    ) is None


def test_no_signatures_or_empty_narration_is_clean():
    assert chat_helpers._narration_claims_outcome("", {"evicted": 1}, {"evicted": 1}) is None
    assert chat_helpers._narration_claims_outcome("X is evicted.", {}, {}) is None


# ── record_post_turn_desync_check: stashes the re-ground on a real desync ── #

def test_post_turn_check_sets_reground_on_real_desync(monkeypatch):
    """A turn that narrated an eviction the engine never committed leaves a re-ground directive
    queued for the user; a clean turn leaves the queue empty."""
    user = "u-desync"
    chat_helpers._DESYNC_REGROUND.pop(user, None)
    # BEFORE signature: the board the turn started on (2 evicted, not finished).
    chat_helpers._LAST_BEAT_SIG[user] = {
        "week": 4, "phase": "eviction", "pending": None, "hoh": "npc:1",
        "noms": ["npc:2", "npc:3"], "vetoHolder": None, "vetoUsed": False,
        "evicted": 2, "finished": False,
    }

    # AFTER the turn the board did NOT move (still 2 evicted) — but the GM narrated an eviction.
    async def fake_status(user=None):
        return {
            "week": 4, "phase": "eviction", "hoh": {"id": "npc:1"},
            "nominees": [{"id": "npc:2"}, {"id": "npc:3"}],
            "veto": {"holder": None, "used": False, "players": []}, "pending": None,
        }

    async def fake_state(user=None):
        return {
            "week": 4, "phase": "eviction", "finished": False,
            "house": [
                {"id": "player", "status": "active"},
                {"id": "npc:8", "status": "evicted"},
                {"id": "npc:9", "status": "evicted"},
                {"id": "npc:2", "status": "active"},
            ],
        }

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)

    _run(chat_helpers.record_post_turn_desync_check(
        user, "The houseguests are stunned: Chandler is evicted from the house."))
    assert user in chat_helpers._DESYNC_REGROUND
    assert "RE-GROUND" in chat_helpers._DESYNC_REGROUND[user]
    chat_helpers._DESYNC_REGROUND.pop(user, None)


def test_post_turn_check_leaves_clean_turn_untouched(monkeypatch):
    user = "u-clean"
    chat_helpers._DESYNC_REGROUND.pop(user, None)
    chat_helpers._LAST_BEAT_SIG[user] = {
        "week": 3, "phase": "social", "pending": None, "hoh": "npc:1",
        "noms": [], "vetoHolder": None, "vetoUsed": False,
        "evicted": 2, "finished": False,
    }

    async def fake_status(user=None):
        return {"week": 3, "phase": "social", "hoh": {"id": "npc:1"},
                "nominees": [], "veto": {}, "pending": None}

    async def fake_state(user=None):
        return {"week": 3, "phase": "social", "finished": False,
                "house": [{"id": "player", "status": "active"},
                          {"id": "npc:8", "status": "evicted"},
                          {"id": "npc:9", "status": "evicted"}]}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)

    _run(chat_helpers.record_post_turn_desync_check(
        user, "They linger in the kitchen, trading quiet reads. The house feels calm tonight."))
    assert user not in chat_helpers._DESYNC_REGROUND


def test_post_turn_check_is_fail_open(monkeypatch):
    """An engine hiccup during the post-turn capture must not raise — the turn that's finishing
    is already streamed; this is best-effort."""
    user = "u-boom"
    chat_helpers._DESYNC_REGROUND.pop(user, None)
    chat_helpers._LAST_BEAT_SIG[user] = {"evicted": 1, "finished": False}

    async def boom_status(user=None):
        raise RuntimeError("engine blip")

    monkeypatch.setattr(orwell_engine, "game_status", boom_status)
    # Must not raise; no directive stashed.
    _run(chat_helpers.record_post_turn_desync_check(user, "X is evicted."))
    assert user not in chat_helpers._DESYNC_REGROUND


# ── integration: apply_game_framing consumes the re-ground + stores the sig ─ #

def test_framing_injects_and_consumes_reground(monkeypatch):
    """When a re-ground is queued for the user, the next framed game turn appends it to the GM
    prompt and pops it (consume once) — and stores the current beat signature for the next check."""
    user = "u-frame"
    chat_helpers._DESYNC_REGROUND[user] = "RE-GROUND ON THE BOARD — test directive."
    chat_helpers._LAST_BEAT_SIG.pop(user, None)

    async def fake_state(user=None, **kw):
        return {"started": True, "phase": "eviction", "moment": "eviction"}

    async def fake_moment(moment, user=None):
        return {"systemPrompt": "MOMENT-PROMPT"}

    async def fake_status(user=None):
        return {"week": 5, "phase": "eviction", "hoh": {"id": "npc:1"},
                "nominees": [], "veto": {}, "pending": None}

    async def no_advance(user=None):
        raise AssertionError("no advance while framing a settled phase here")

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", no_advance)
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)

    preface = []
    _engine, game_active, _feed = _run(
        chat_helpers.apply_game_framing(preface, user, False, session_id="sess-rg")
    )
    assert game_active is True
    content = preface[0]["content"]
    assert content.startswith("MOMENT-PROMPT")
    assert "RE-GROUND ON THE BOARD — test directive." in content
    # consumed once
    assert user not in chat_helpers._DESYNC_REGROUND
    # current signature captured for the next post-turn check
    assert chat_helpers._LAST_BEAT_SIG.get(user) is not None
    assert chat_helpers._LAST_BEAT_SIG[user]["week"] == 5


# ── source-pins: the wiring stays where the spine expects it ────────────── #

def _read(*parts):
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(base, *parts), encoding="utf-8") as fh:
        return fh.read()


def test_agent_loop_calls_post_turn_desync_check_in_live_path():
    src = _read("src", "agent_loop.py")
    assert "record_post_turn_desync_check(" in src
    # F16 (#1014): the desync layer rides the finished live-game turn guarded on `_is_live_game`
    # ALONE (no longer `and owner`) — so it fires single-tenant (`owner=None` under AUTH_ENABLED=false)
    # too. Fail-open.
    call = src.index("record_post_turn_desync_check(")
    head = src.rindex("if _is_live_game:", 0, call)
    # The gate guarding this call must NOT also require `owner` (that made it inert single-tenant).
    assert "if _is_live_game and owner:" not in src[head:call]
    assert "try:" in src[head:call]
    assert "except Exception" in src[call:call + 600]


def test_framing_consumes_reground_and_stores_signature():
    src = _read("routes", "chat_helpers.py")
    # #1045: the checkpoint now keys the desync stores via the STABLE _desync_key (canonical-session
    # fallback when user=None) so the spine functions single-tenant. The consume + capture run inside
    # apply_game_framing's started branch, fail-open.
    assert "_DESYNC_REGROUND.pop(_dkey, None)" in src
    assert "_LAST_BEAT_SIG[_dkey] = await _capture_beat_signature(user)" in src
    consume = src.index("_DESYNC_REGROUND.pop(_dkey")
    assert "beat-signature checkpoint skipped" in src
    assert "except Exception" in src[consume:consume + 600]
