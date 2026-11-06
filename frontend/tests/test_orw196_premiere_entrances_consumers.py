"""ORW-196: the engine now reports premiereIntros complete=false / remaining=[anonymous placeholders] while the staged entrances run. The FE consumers that read `complete`/`remaining` must stay quiet in
that stage (arrivals are engine-released, not a gap to steer the player through). Roles only. SYNC tests."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
agent_loop = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")

ENTRANCES = {"stage": "entrances", "index": 5, "total": 16, "playerPosition": 3, "arrivedNames": []}
PLACEHOLDER = {"houseguest": {"id": "npc:9", "name": "(not yet arrived)"}, "met": False}


def _view(**kw):
    base = {"complete": False, "powerReachable": False, "metCount": 6, "total": 16, "hotReads": 5,
            "remaining": [PLACEHOLDER], "met": [], "entrance": ENTRANCES}
    base.update(kw)
    return base


def test_progress_directive_is_silent_during_entrances():
    assert ch._premiere_progress_directive(_view()) is None


def test_progress_directive_still_fires_without_an_entrance_stage():
    """The legacy (entrances OFF) shape is unchanged: an incomplete, unreachable premiere still gets the wayfinding frame."""
    v = _view()
    v.pop("entrance")
    assert ch._premiere_progress_directive(v)


def test_whereabouts_is_not_forced_during_entrances():
    forced = agent_loop._forced_tool_choice_for_whereabouts(
        set(), game_mode="live", premiere_view=_view(), frozen_whereabouts=None, last_turn_called_whereabouts=False)
    assert forced is None


def test_whereabouts_still_forced_on_an_incomplete_premiere_without_entrances():
    v = _view()
    v.pop("entrance")
    forced = agent_loop._forced_tool_choice_for_whereabouts(
        set(), game_mode="live", premiere_view=v, frozen_whereabouts=None, last_turn_called_whereabouts=False)
    assert forced is not None


def test_name_belt_marks_nobody_during_entrances(monkeypatch):
    marked = []

    async def fake_intros(user=None):
        return _view()

    async def fake_mark(hg_id, user=None, via=None):
        marked.append(hg_id)
        return {}

    monkeypatch.setattr(orwell_engine, "premiere_intros", fake_intros)
    monkeypatch.setattr(orwell_engine, "mark_houseguest_met", fake_mark)
    n = asyncio.get_event_loop().run_until_complete(agent_loop._auto_mark_premiere_intros("(not the next arrival, not yet) waits outside.", None))
    assert n == 0 and marked == []
