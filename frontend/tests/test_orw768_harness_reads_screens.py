"""ORW-768 (browser wall, part 2): the live-run tier plays AS A PLAYER, so it reads only what a player's screens read, from the routes the screens read them from.

After the nested closed shape of `/api/orwell/state` (ORW-733) the state no longer carries `whereabouts`, the pending card's options, `clockLabel` or the premiere entrance. The full-week tier composes its
read from /state + /status + /whereabouts (`live_truth.screen_view`); the rehearsal-kit drivers read the rig's engine for what no screen shows. Roles only; sentinels are not names.
"""
from __future__ import annotations

import importlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "live-run"))
sys.path.insert(0, str(ROOT / "scripts" / "rehearsal-kit"))
import live_full as lf  # noqa: E402
import live_full_eval as ev  # noqa: E402
import live_truth as lt  # noqa: E402

orwell_routes = importlib.import_module("routes.orwell_routes")
FIX = pathlib.Path(__file__).parent / "fixtures"
S = "ZZ-sentinel-768"


def _shape_paths(spec, p=""):
    out = set()
    if spec is True:
        out.add(p)
    elif isinstance(spec, dict):
        for k, sub in spec.items():
            out |= _shape_paths(sub, f"{p}.{k}" if p else k)
    elif isinstance(spec, list):
        out |= _shape_paths(spec[0], p + "[]")
    return out


def test_every_state_key_the_harness_reads_is_on_the_browser_shape():
    paths = _shape_paths(orwell_routes._BROWSER_STATE_SHAPE)
    missing = [k for k in lt.STATE_READS if k not in paths and not any(x.startswith(k + ".") or x.startswith(k + "[]") for x in paths)]
    assert not missing, f"the live-run tier reads /api/orwell/state keys the wall drops: {missing}"


def test_the_harness_never_reads_a_dropped_state_key_by_name():
    for f in ("live_full.py", "live_truth.py", "live_full_eval.py"):
        src = (ROOT / "scripts" / "live-run" / f).read_text()
        assert "clockLabel" not in src, f
        assert "/api/orwell/state" not in src.replace("GET /api/orwell/state", "") or f == "live_full.py", f   # only the world's own read names the route; the checks take the composed view


def test_whereabouts_and_the_card_come_from_their_own_routes_not_the_state():
    state = {"phase": "nominations", "week": 1, "pending": {"kind": "nominations"}, "house": [], "whereabouts": {"present": [{"name": S}]}}   # a state that (wrongly) held both
    status = {"pending": {"kind": "nominations", "options": [{"id": "a"}, {"id": "b"}, {"id": "c"}]}, "winner": None, "finished": False}
    state["house"] = [{"id": "a", "name": "Aa Bb", "status": "active"}, {"id": "b", "name": "Cc Dd", "status": "evicted"}]
    state["player"] = {"id": "me", "name": "Gg Hh", "status": "active"}
    where = {"whereabouts": {"present": [{"id": "x", "name": "Aa Bb"}]}}
    v = lt.screen_view(state, status, where)
    f = lt.facts(v)
    assert [o["id"] for o in f["pending"]["options"]] == ["a", "b", "c"]            # the card's options: /status
    assert f["present"] == ["Aa Bb"]                                                    # who is here: /whereabouts
    assert f["counts"] == {"house": 2, "room": 2, "others": 1}                          # headcounts: the tiles still in the game plus the player, and the strip's room: derived, never read from a hidden field
    assert lf.decision_body(f["pending"], "me") == {"kind": "nominations", "choice": ["a", "b"]}
    gone = lt.facts(lt.screen_view(state, None, None))                                 # a failed route leaves the key absent: not invented
    assert gone["pending"] == {"kind": "nominations"} and gone["counts"] is None


def test_the_clock_is_the_day_part_a_hud_shows_and_no_minutes_are_judged():
    assert lt.clock_label({"timeOfDay": "evening", "dayNumber": 4}) == "evening, Day 4" and lt.clock_label({}) is None
    assert lt.band_position("morning, Day 1") == 0 and lt.band_position("late-night, Day 1") == 4 and lt.band_position("morning, Day 2") == 5
    assert any("minute" in x for x in lt.NOT_JUDGED) and any("planned or hidden" in x for x in lt.NOT_JUDGED)
    _, data = ev.build_report({}, [], [], {"turns": 0, "fail_counts": {}, "longest_due_wait": 0, "t1_fail_turns": 0, "stall": False, "livelock": False}, {}, "PASS")
    assert data["not_judged"] == lt.NOT_JUDGED


def test_every_replayed_state_is_a_payload_the_browser_wall_would_really_send():
    """Positive control for the stub and the recorded fixtures: /state in them is a fixed point of the real projection (no key the wall drops, nothing the wall would reshape)."""
    steps, first = lf.stub_week(None)
    for name in ("live_full_healthy_week.json", "live_full_orw10_veto_stall.json"):
        rec = json.load(open(FIX / name))
        for sc in [rec["first"]] + [s["state"] for s in rec["steps"]]:
            st = sc["screens"]["state"]
            assert orwell_routes._browser_state_projection(st) == st, name
            for route, shape in (("status", orwell_routes._BROWSER_STATUS_SHAPE), ("whereabouts", orwell_routes._BROWSER_WHEREABOUTS_SHAPE)):
                assert orwell_routes._project_for_browser(sc["screens"][route], shape) == sc["screens"][route], (name, route)
    for sc in [first] + [s["state"] for s in steps]:
        assert orwell_routes._browser_state_projection(sc["screens"]["state"]) == sc["screens"]["state"]
        assert orwell_routes._project_for_browser(sc["screens"]["status"], orwell_routes._BROWSER_STATUS_SHAPE) == sc["screens"]["status"]


def test_a_planted_hidden_key_in_the_state_never_reaches_a_check():
    """If a state carried a planned/hidden key, the wall removes it before the harness; and nothing in the composed view is added by the harness itself."""
    raw = {"phase": "veto-ceremony", "week": 1, "ceremony": {"hoh": {"id": "h", "name": "Aa Bb"}, "nominees": [], "veto": {"holder": None, "plannedOutcome": S}}, "plannedReplacement": S}
    browser = orwell_routes._browser_state_projection(raw)
    assert S not in json.dumps(lt.screen_view(browser, {}, None))
