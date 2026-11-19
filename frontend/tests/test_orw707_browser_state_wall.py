"""ORW-707 (PT-13, Vault Wall): what `/api/orwell/state` and the dossier hand the BROWSER, proven on the real stack (real engine bundle + real front end), no state injection.

A played game's `getGameState` carries every houseguest's full public card for the NARRATOR (biography, archetype, strategy style, identity line, voice, orientation, look), including the
houseguests who have not walked in yet. The player's browser may only receive what its panels render (who is in the house, whether they still play, the departure order, a mood word), and a
houseguest who has not arrived has no dossier to open. Roles only. Needs the built engine bundle (skips cleanly without it); browser lane = serial like the other real-stack pins.
"""
from __future__ import annotations

import json
import urllib.request

import pytest

from test_m0_3_midgen_join import _post_json, _stack  # noqa: F401  (the shared real-stack fixture)

pytestmark = pytest.mark.browser

# The closed set the browser may hold per houseguest (mirrors routes/orwell_routes.py `_BROWSER_HOUSEGUEST_KEYS`).
ALLOWED = {"id", "name", "status", "evictedSeq", "lastSeenMood"}
# The card facets that belong to the narrator and must never ride to the browser.
NARRATOR_ONLY = ("biography", "archetype", "strategyStyle", "identityConcept", "voice", "outOrientation", "demeanor",
                 "physicalCharacteristics", "castingType", "ethnicity", "genderPresentation", "background", "vocation", "hometown", "age", "presentation")


def _engine(stack, name, args=None):
    r = _post_json(stack["engine"], "/player/call", {"name": name, "args": args or {}})
    assert "result" in r, f"{name} -> {r}"
    return r["result"]



def _get(stack, path):
    with urllib.request.urlopen(stack["fe"] + path, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def _values_of(card):
    out = []
    for k in NARRATOR_ONLY:
        v = card.get(k)
        if isinstance(v, str) and len(v) >= 6:
            out.append(v)
        elif isinstance(v, dict):
            out.extend(x for x in v.values() if isinstance(x, str) and len(x) >= 6)
    return out


def test_state_sends_the_browser_no_narrator_facets_for_anyone(_stack):
    raw = _engine(_stack, "getGameState")
    assert raw.get("started") is True and len(raw["house"]) > 0
    assert any(c.get("biography") for c in raw["house"]), "precondition: the engine card really carries the profile (the leak surface exists)"
    body = _get(_stack, "/api/orwell/state")
    assert len(body["house"]) == len(raw["house"]), "the roster tiles still all render"
    for hg in body["house"]:
        assert set(hg) <= ALLOWED, f"a non-panel field reached the browser: {sorted(set(hg) - ALLOWED)}"
        assert hg.get("id") and hg.get("name")
    text = json.dumps({"house": body["house"], "premiere": body.get("premiere")})  # the player's own card is their own
    for card in raw["house"]:
        for v in _values_of(card):
            assert v not in text, f"a narrator-only card value reached the browser: {v[:60]}"
    for key in NARRATOR_ONLY:
        assert f'"{key}"' not in json.dumps(body["house"]), f"{key} key present in house[]"
    prem = body.get("premiere") or {}
    for row in (prem.get("met") or []) + (prem.get("remaining") or []):
        assert set(row) <= {"houseguest", "met"} and set(row["houseguest"]) <= {"id", "name"}, row


def test_dossier_of_a_houseguest_who_has_not_arrived_is_not_found(_stack):
    prem = _engine(_stack, "premiereIntros") or {}
    ent = prem.get("entrance") or {}
    if ent.get("stage") != "entrances":
        pytest.skip("the stack's premiere is past the entrances; the gate has nothing to hold")
    raw = _engine(_stack, "getGameState")
    met_ids = {r["houseguest"]["id"] for r in (raw.get("premiere") or {}).get("met", [])}
    outside = [c for c in raw["house"] if c["id"] not in met_ids]
    inside = [c for c in raw["house"] if c["id"] in met_ids]
    assert outside, "precondition: houseguests are still outside during the entrances"
    for c in outside:
        assert _get(_stack, f"/api/orwell/dossier/{c['id']}") == {"found": False}
    if inside:
        assert _get(_stack, f"/api/orwell/dossier/{inside[0]['id']}").get("found") is True
