"""0130 — eviction night after the player's goodbye must reach the result.

The player's ``goodbye-message`` resolves the LAST player-owned gate of the eviction sub-loop, but
``submitDecision`` returns only the goodbye beat; the engine still owes ``exit-interview`` →
``eviction-result``. ``_post_decision_tail`` used to fire ONE follow-up ``advance_game`` and stopped at the
exit interview. It now advances until the engine reports the eviction sub-loop done (bounded), so the
HTTP and WS decision paths both land on the result.

The engine is stubbed with the same beat chain the real engine produces (pinned engine-side by
``tests/unit/postGoodbyeBeatChain.test.ts``). Roles only — no houseguest names.
"""

import importlib

orwell_routes = importlib.import_module("routes.orwell_routes")


def _view(beat, *, staging=True, pending=None, finished=False, seq=0):
    return {
        "beatSeq": seq,
        "event": {"beat": beat},
        "pending": pending,
        "finished": finished,
        "eviction": {"stage": beat} if staging else None,
    }


class _FakeEngine:
    """Scripted ``advance_game``: yields the queued views in order and records each call's key."""

    def __init__(self, views):
        self.views = list(views)
        self.keys = []
        self.seqs = []
        self.cleared = 0

    async def advance_game(self, expected_beat_seq=None, idempotency_key=None, user=None):
        self.keys.append(idempotency_key)
        self.seqs.append(expected_beat_seq)
        if not self.views:
            raise AssertionError("advanced past the scripted chain")
        return self.views.pop(0)

    def remember_pending(self, res, user=None):
        pass

    def clear_pending(self, user=None):
        self.cleared += 1


def _install(monkeypatch, fake):
    from src import orwell_engine

    monkeypatch.setattr(orwell_engine, "advance_game", fake.advance_game)
    monkeypatch.setattr(orwell_engine, "remember_pending", fake.remember_pending)
    monkeypatch.setattr(orwell_engine, "clear_pending", fake.clear_pending)
    monkeypatch.setattr(orwell_routes, "_publish_game_updated", lambda user: None)


def _goodbye_res():
    return _view("eviction-goodbye", seq=10)


async def test_goodbye_advances_through_exit_interview_to_the_result(monkeypatch):
    fake = _FakeEngine([_view("exit-interview", seq=11), _view("eviction-result", staging=False, seq=12)])
    _install(monkeypatch, fake)
    res = await orwell_routes._post_decision_tail(
        {"kind": "goodbye-message"}, _goodbye_res(), "u", "goodbye-message", "dec:gb|1")
    assert res["event"]["beat"] == "eviction-result"
    assert not fake.views, "both owed beats were delivered"
    # Each step has its own key: a shared one would replay the first view instead of advancing.
    assert fake.keys == ["dec:gb|1:gb-adv", "dec:gb|1:gb-adv:1"]
    # Each step is a CAS on the PRIOR view's beatSeq, so a concurrent advance makes the step stale.
    assert fake.seqs == [10, 11]


async def test_stale_step_stops_instead_of_advancing_a_new_week(monkeypatch):
    class _Stale(_FakeEngine):
        async def advance_game(self, expected_beat_seq=None, idempotency_key=None, user=None):
            if self.keys:  # the 2nd step: someone else already advanced past the result
                self.keys.append(idempotency_key)
                raise RuntimeError("409 stale-beat")
            return await super().advance_game(expected_beat_seq, idempotency_key, user)

    fake = _Stale([_view("exit-interview", seq=11)])
    _install(monkeypatch, fake)
    res = await orwell_routes._post_decision_tail(
        {"kind": "goodbye-message"}, _goodbye_res(), "u", "goodbye-message", "k")
    assert res["event"]["beat"] == "exit-interview", "keeps the last good view"
    assert len(fake.keys) == 2, "the stale step was the last advance attempted"


async def test_whitespace_only_idempotency_key_derives_no_followup_keys(monkeypatch):
    fake = _FakeEngine([_view("eviction-result", staging=False, seq=11)])
    _install(monkeypatch, fake)
    await orwell_routes._post_decision_tail(
        {"kind": "goodbye-message"}, _goodbye_res(), "u", "goodbye-message", "   ")
    assert fake.keys == [None]


async def test_stops_at_a_player_pending(monkeypatch):
    pending = {"kind": "exit-interview", "by": "player"}
    fake = _FakeEngine([_view("exit-interview", pending=pending)])
    _install(monkeypatch, fake)
    res = await orwell_routes._post_decision_tail(
        {"kind": "goodbye-message"}, _goodbye_res(), "u", "goodbye-message", None)
    assert res["pending"] == pending
    assert fake.keys == [None], "one advance, then the player owns the next gate"


async def test_advance_loop_is_bounded(monkeypatch):
    cap = orwell_routes._POST_GOODBYE_MAX_ADVANCES
    fake = _FakeEngine([_view("exit-interview") for _ in range(cap + 5)])
    _install(monkeypatch, fake)
    await orwell_routes._post_decision_tail(
        {"kind": "goodbye-message"}, _goodbye_res(), "u", "goodbye-message", None)
    assert len(fake.keys) == cap, "a misbehaving engine can never spin the tail"


async def test_engine_error_keeps_the_last_good_view(monkeypatch):
    fake = _FakeEngine([_view("exit-interview")])
    _install(monkeypatch, fake)  # second advance raises AssertionError (nothing queued)
    res = await orwell_routes._post_decision_tail(
        {"kind": "goodbye-message"}, _goodbye_res(), "u", "goodbye-message", None)
    assert res["event"]["beat"] == "exit-interview"
    assert len(fake.keys) == 2, "stop-on-error: one good advance, then the failing one, and no more"


async def test_other_decisions_do_not_advance(monkeypatch):
    fake = _FakeEngine([])
    _install(monkeypatch, fake)
    res = await orwell_routes._post_decision_tail(
        {"kind": "eviction-vote"}, _view("eviction-reveal"), "u", "eviction-vote", None)
    assert fake.keys == []
    assert res["event"]["beat"] == "eviction-reveal"
