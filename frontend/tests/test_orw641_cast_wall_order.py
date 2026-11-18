"""ORW-641 - the cast photo wall reorders by the week.

Order: HOH, veto holder, nominees, everyone else still in the house A-Z by first name, then the
departed (jury or evicted) with the most recently evicted first. A double role is placed once, at
the highest. The player has no special slot. Public facts only: the roster card's status and its
public eviction place, plus the ceremony roles the status board already serves.

BEHAVIORAL: the real pure `orderRoster` is executed in Node. STRUCTURAL: the renderer uses it, and
the route carries the public eviction place through (positive ints only).
"""
import json
import os
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAST_PATH = os.path.join(FRONTEND, "static", "js", "orwellCast.js")
with open(CAST_PATH, encoding="utf-8") as _f:
    CAST = _f.read()
BEGIN, END = "// ORW-641 ORDER-BEGIN", "// ORW-641 ORDER-END"
FN = CAST[CAST.index(BEGIN):CAST.index(END)]

node = pytest.mark.skipif(shutil.which("node") is None, reason="node not available")


def _order(roster, roles):
    script = FN + "\nconst d = JSON.parse(process.argv[1]);\nprocess.stdout.write(JSON.stringify(orderRoster(d.roster, d.roles).map(h => h.id)));"
    out = subprocess.run(["node", "-e", script, json.dumps({"roster": roster, "roles": roles})],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def hg(i, name, status="active", seq=None, **kw):
    d = {"id": i, "name": name, "status": status, **kw}
    if seq is not None:
        d["evictedSeq"] = seq
    return d


@node
def test_roles_then_alphabetical_then_departed_latest_first():
    roster = [
        hg("e1", "Zed", "evicted", 1), hg("n1", "Nora"), hg("e3", "Yan", "jury", 3), hg("a1", "bea Kim"),
        hg("h", "Quinn"), hg("v", "Pat"), hg("a2", "Adel"), hg("e2", "Xia", "evicted", 2),
        hg("n2", "Mo"), hg("p", "Cy", isPlayer=True),
    ]
    roles = {"h": "hoh", "v": "veto", "n1": "nominee", "n2": "nominee"}
    got = _order(roster, roles)
    assert got[:2] == ["h", "v"]
    assert sorted(got[2:4]) == ["n1", "n2"]
    assert got[4:7] == ["a2", "a1", "p"]  # first name A-Z, case-insensitive; the player has no special slot
    assert got[7:] == ["e3", "e2", "e1"]  # departed last, most recently out first


@node
def test_double_role_is_placed_once_at_the_highest():
    roster = [hg("a", "Ann"), hg("b", "Bo"), hg("c", "Cal")]
    # the roles map holds one role per id (the status board resolves precedence); the order is stable
    assert _order(roster, {"c": "hoh", "b": "nominee"}) == ["c", "b", "a"]
    assert sorted(_order(roster, {"c": "hoh", "b": "hoh"})) == ["a", "b", "c"]


@node
def test_name_keyed_roles_and_no_roles_and_missing_seq_are_safe():
    roster = [hg("b", "Bo"), hg("a", "Ann"), hg("x", "Xu", "evicted"), hg("y", "Yo", "evicted", 2)]
    assert _order(roster, {}) == ["a", "b", "y", "x"]
    assert _order(roster, {"Bo": "hoh"})[0] == "b"
    assert _order(roster, None) == ["a", "b", "y", "x"]
    assert _order(None, None) == []


def test_renderer_uses_the_pure_order_and_it_is_exposed():
    assert "orderRoster(roster, _roles)" in CAST
    assert "window.OrwellCastOrder = { orderRoster }" in CAST
    assert "const order = { active: 0, jury: 1, evicted: 2 }" not in CAST


def test_route_carries_only_a_positive_int_eviction_place():
    from routes.orwell_routes import _roster_evicted_seq
    assert _roster_evicted_seq({"evictedSeq": 3}) == {"evictedSeq": 3}
    for bad in (0, -1, True, "2", 1.5, None):
        assert _roster_evicted_seq({"evictedSeq": bad}) == {}
    assert _roster_evicted_seq({}) == {}
