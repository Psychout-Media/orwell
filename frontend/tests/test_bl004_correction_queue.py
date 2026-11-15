"""BL-004 (2026-07-16 full-playtest audit) — the correction-queue CAPACITY + voiced-correction gate.

The audited premiere session's single-slot ``_DESYNC_REGROUND`` correction store dropped **17 of 24**
queued prose corrections: a fresh closed-set re-ground OVERWROTE an unconsumed one, and a second
correction queued while one was "in flight" was silently DEFERRED. Worse, even the correction that DID
survive was applied internally but there was no signal it was ever VOICED back to the player.

This pins the fix:
  * ``_DESYNC_REGROUND[key]`` is a BOUNDED, ``\\n\\n``-joined FIFO of closed-set corrections — enqueue
    APPENDS a distinct correction (never clobbers a prior distinct one), an EXACT repeat is de-duped,
    and a hard cap ``log()``s the dropped oldest segment (no silent truncation, per CLAUDE.md);
  * a DRAINED correction (consumed into the next framed prompt) records a SUCCESS-GATED belt fire
    (``desync-reground-voiced``) so voiced-vs-merely-queued is measurable (belt-telemetry contract:
    a fire means an APPLIED correction, never a mere selection).

Closed-set ONLY (ADR 0005) — every correction is a board/state re-ground, never creative prose; the
expressive-non-collapse gate stays the proof of that and is untouched here. Roles only — no names.
"""

import asyncio
import importlib
import logging
import os

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
ledger = importlib.import_module("src.orwell_sync_ledger")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _read(rel):
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(base, *rel.split("/")), encoding="utf-8") as fh:
        return fh.read()


@pytest.fixture(autouse=True)
def _clean():
    chat_helpers._DESYNC_REGROUND.clear()
    chat_helpers._LAST_BEAT_SIG.clear()
    ledger._PENDING_BELTS.clear()
    yield
    chat_helpers._DESYNC_REGROUND.clear()
    chat_helpers._LAST_BEAT_SIG.clear()
    ledger._PENDING_BELTS.clear()


# ── the bounded FIFO queue: append distinct, dedup identical, cap+log ─────────────────────────

def test_distinct_corrections_accumulate_and_never_clobber():
    key = "bl004-distinct"
    assert chat_helpers._reground_enqueue(key, "RE-GROUND A — a fabricated HOH win.") is True
    # A SECOND, distinct correction arrives while the first is still queued ("in flight") — the audited
    # single slot DROPPED it; the queue must keep BOTH.
    assert chat_helpers._reground_enqueue(key, "RE-GROUND B — a fabricated player removal.") is True
    combined = chat_helpers._DESYNC_REGROUND[key]
    assert "RE-GROUND A" in combined, "the first correction must NOT be clobbered by the second"
    assert "RE-GROUND B" in combined, "the second correction must NOT be silently dropped"
    # FIFO order preserved (drain in order).
    assert combined.index("RE-GROUND A") < combined.index("RE-GROUND B")


def test_exact_repeat_is_deduped_not_stacked():
    key = "bl004-dedup"
    d = "RE-GROUND — the SAME drift, re-detected next turn."
    chat_helpers._reground_enqueue(key, d)
    chat_helpers._reground_enqueue(key, d)
    chat_helpers._reground_enqueue(key, d)
    segs = chat_helpers._DESYNC_REGROUND[key].split(chat_helpers._REGROUND_SEP)
    assert segs.count(d) == 1, "an identical correction must not stack (nag-spam), just stay queued"


def test_hard_cap_drops_oldest_with_a_log_never_silently(caplog):
    key = "bl004-cap"
    cap = chat_helpers._REGROUND_QUEUE_CAP
    with caplog.at_level(logging.WARNING, logger="routes.chat_helpers"):
        for i in range(cap + 3):
            chat_helpers._reground_enqueue(key, f"RE-GROUND correction #{i}.")
    segs = chat_helpers._DESYNC_REGROUND[key].split(chat_helpers._REGROUND_SEP)
    assert len(segs) == cap, "the queue is bounded at the cap"
    # The three OLDEST were dropped — but LOUDLY (no silent truncation).
    assert "correction #0." not in chat_helpers._DESYNC_REGROUND[key]
    assert "correction #2." not in chat_helpers._DESYNC_REGROUND[key]
    assert f"correction #{cap + 2}." in chat_helpers._DESYNC_REGROUND[key], "the newest is kept"
    drop_logs = [r.getMessage() for r in caplog.records if "dropped the OLDEST" in r.getMessage()]
    assert len(drop_logs) == 3, "every capacity drop is logged — never a silent truncation"


def test_remove_pops_only_the_named_segment():
    key = "bl004-remove"
    chat_helpers._reground_enqueue(key, "KEEP — a concurrent peer's correction.")
    chat_helpers._reground_enqueue(key, "MINE — my own reconcile's correction.")
    chat_helpers._reground_remove(key, "MINE — my own reconcile's correction.")
    combined = chat_helpers._DESYNC_REGROUND[key]
    assert "KEEP" in combined and "MINE" not in combined, "remove clears only the named segment"
    # Removing the last segment pops the key entirely.
    chat_helpers._reground_remove(key, "KEEP — a concurrent peer's correction.")
    assert key not in chat_helpers._DESYNC_REGROUND


def test_enqueue_refuses_an_empty_directive_but_allows_a_none_key():
    assert chat_helpers._reground_enqueue("k", "") is False     # empty directive ⇒ refused
    assert "k" not in chat_helpers._DESYNC_REGROUND
    # a None key is VALID — the userless single-tenant fallback stores/consumes under None (the store's
    # readers pop that same None key). This preserves the prior single-slot behaviour.
    chat_helpers._DESYNC_REGROUND.pop(None, None)
    assert chat_helpers._reground_enqueue(None, "RE-GROUND — single-tenant fallback.") is True
    assert None in chat_helpers._DESYNC_REGROUND
    chat_helpers._DESYNC_REGROUND.pop(None, None)


# ── the real BL-004 regression: the post-turn board check must COMBINE, not clobber ───────────

def test_post_turn_board_check_combines_with_a_prior_distinct_correction(monkeypatch):
    """The site that stashes a fabricated-outcome re-ground (``record_post_turn_desync_check``) used to
    OVERWRITE — so a second fabrication a turn later dropped the first. It must now COMBINE."""
    user = "bl004-board"
    chat_helpers._DESYNC_REGROUND[user] = "PRIOR RE-GROUND — a distinct earlier board correction."
    chat_helpers._LAST_BEAT_SIG[user] = {
        "week": 4, "phase": "eviction", "pending": None, "hoh": "npc:1",
        "noms": ["npc:2", "npc:3"], "vetoHolder": None, "vetoUsed": False,
        "evicted": 2, "finished": False,
    }

    async def fake_status(user=None):
        return {"week": 4, "phase": "eviction", "hoh": {"id": "npc:1"},
                "nominees": [{"id": "npc:2"}, {"id": "npc:3"}],
                "veto": {"holder": None, "used": False, "players": []}, "pending": None}

    async def fake_state(user=None):
        return {"week": 4, "phase": "eviction", "finished": False,
                "house": [{"id": "player", "status": "active"},
                          {"id": "npc:8", "status": "evicted"},
                          {"id": "npc:9", "status": "evicted"},
                          {"id": "npc:2", "status": "active"}]}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)

    _run(chat_helpers.record_post_turn_desync_check(
        user, "The houseguests are stunned: someone is evicted from the house."))
    combined = chat_helpers._DESYNC_REGROUND[user]
    assert "a distinct earlier board correction" in combined, "the prior correction must survive"
    assert "EVICTION" in combined, "the new fabrication re-ground is added too"


# ── the voiced-correction verification signal: a drained correction fires the success-gated belt ──

def _patch_framing(monkeypatch):
    async def fake_state(user=None, **kw):
        return {"started": True, "phase": "eviction", "moment": "eviction"}

    async def fake_moment(moment, user=None, **_kw):
        return {"systemPrompt": "MOMENT-PROMPT"}

    async def fake_status(user=None):
        return {"week": 5, "phase": "eviction", "hoh": {"id": "npc:1"},
                "nominees": [], "veto": {}, "pending": None}

    async def no_advance(user=None, **kw):
        raise AssertionError("no advance while framing a settled phase here")

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", no_advance)
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)


def test_a_drained_correction_is_voiced_as_a_success_gated_belt(monkeypatch):
    """When ``apply_game_framing`` DRAINS a queued correction into the next prompt, it records the
    ``desync-reground-voiced`` belt — the measurable proof the correction was APPLIED (voiced), not
    merely selected. No queued correction ⇒ no belt (success-gated)."""
    user = "bl004-voiced"
    chat_helpers._DESYNC_REGROUND[user] = "RE-GROUND ON THE BOARD — voice-me directive."
    _patch_framing(monkeypatch)

    preface = []
    _run(chat_helpers.apply_game_framing(preface, user, False, session_id="sess-voiced"))
    assert "voice-me directive." in preface[0]["content"], "the correction is drained into the prompt"
    # the success-gated belt fired for the voiced correction
    assert ledger.get_belt_totals(user).get("desync-reground-voiced") == 1


def test_no_queued_correction_fires_no_voiced_belt(monkeypatch):
    """Success-gating: a clean turn with nothing queued must NOT fire the voiced belt."""
    user = "bl004-clean"
    chat_helpers._DESYNC_REGROUND.pop(user, None)
    _patch_framing(monkeypatch)

    preface = []
    _run(chat_helpers.apply_game_framing(preface, user, False, session_id="sess-clean"))
    assert "desync-reground-voiced" not in ledger.get_belt_totals(user)


# ── the agent-loop faithfulness path routes its store through the bounded queue ──────────────

def test_faith_queue_reground_routes_through_the_bounded_queue():
    """The pinned drop site (``_faith_queue_reground``) enqueues through the bounded helper. It still
    DEFERS to an in-flight board re-ground (that redundancy dedup is intentional), but on an empty
    queue it queues via the shared helper, not a raw single-slot assignment."""
    al = importlib.import_module("src.agent_loop")
    src = _read("src/agent_loop.py")
    assert "_reground_enqueue(" in src, "the faith path must route through the shared bounded helper"
    chat_helpers._DESYNC_REGROUND.pop("owner", None)
    assert al._faith_queue_reground("owner", al._FAITH_REGROUND_DIRECTIVE) is True
    assert "owner" in chat_helpers._DESYNC_REGROUND


def test_single_tenant_store_and_read_share_the_canonical_key(monkeypatch):
    """A single-tenant/auth-off correction (owner=None) is stored under `_desync_key(None)` — the
    canonical `gs:<id>`, NOT raw None. Every READER (the overseer desync signal in agent_loop, the
    drain in apply_game_framing) must key off `_desync_key(owner)` too, or the queued correction is
    invisible on the deploy-default AUTH_ENABLED=false path. Pins that contract."""
    ogs = importlib.import_module("src.orwell_game_session")
    monkeypatch.setattr(ogs, "get_game_session", lambda user=None: "sess-canon-42")
    # owner=None resolves to the canonical session key — this is what every WRITER computes before
    # enqueuing (the overseer fix + `_faith_queue_reground` both pass `_desync_key(owner)`).
    key = chat_helpers._desync_key(None)
    assert key == "gs:sess-canon-42", "owner=None must resolve to the canonical gs:<id> key"
    assert chat_helpers._reground_enqueue(key, "RE-GROUND — single-tenant board drift.") is True
    # The store lands under the canonical key — a raw `None in …` reader would MISS it.
    assert key in chat_helpers._DESYNC_REGROUND
    assert None not in chat_helpers._DESYNC_REGROUND
    # The overseer reader pattern (matching agent_loop) finds it via _desync_key; the old raw one does not.
    assert (chat_helpers._desync_key(None) in chat_helpers._DESYNC_REGROUND) is True
    assert (None in chat_helpers._DESYNC_REGROUND) is False
