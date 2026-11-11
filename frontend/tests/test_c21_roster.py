"""Queue C21 (slice) — the house TALLY + self-status badge.

#955: the status panel originally listed every houseguest by name ("The House · 16/16" +
a full text roster). That per-person name list DUPLICATED the cast photo gallery
(#orwell-cast, which shows photos + names + eviction grayscale), so it was removed — the
cast gallery is now the single roster surface. The status panel keeps only the at-a-glance
attrition count ("The House · N/N"), the self role badge, and the premiere objective, all
from the engine's already-Vault-free getGameState().house[] and the public ceremony status.
Static source contract (the HUD is pure JS), plus a Vault-free guard that the tally consumes
only public facets.
"""

import os
import re

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")


def _panel() -> str:
    with open(os.path.join(STATIC, "orwellStatusPanel.js"), encoding="utf-8") as f:
        return f.read()


def test_house_tally_is_rendered_from_state():
    src = _panel()
    assert "renderRoster(" in src
    assert 'OrwellGame.get("state"' in src     # getGameState — the tally source (ORW-165: read through the shared game-state store, which owns the /api/orwell/state fetch)
    assert 'id="os-roster-h"' in src           # the "The House · N/N" header element


def test_no_text_name_list_in_status_panel():
    # #955: the redundant per-person name LIST is gone — the cast photo gallery is the roster.
    src = _panel()
    assert 'id="os-roster"' not in src, "the text houseguest name-list container must be removed"
    assert "os-hg" not in src, "per-houseguest name rows (.os-hg) must be removed"


def test_attrition_count_shown():
    src = _panel()
    # active/total derived from house[] + the player; rendered in the tally header
    assert "activeCount" in src and "/\" + total" in src
    assert '"The House · "' in src         # the "The House · N/N" header text


def test_self_role_badge_from_public_facts_only():
    src = _panel()
    assert "function selfBadge(" in src
    badge = src[src.index("function selfBadge("): src.index("function selfBadge(") + 700]
    # derived by id-comparison against public ceremony facts — HOH / block / veto / seat
    for token in ('"HOH"', '"ON THE BLOCK"', '"VETO"', '"EVICTED"', '"JURY"'):
        assert token in badge, token
    # NEVER a safe/target standing read (0020)
    for forbidden in ("safe", "target", "trust", "threat", "danger"):
        assert forbidden not in badge.lower(), f"self badge must not assert a standing: {forbidden}"


def test_tally_consumes_only_public_facets():
    # Vault-free by construction: the tally touches status / count only, never any
    # hidden stat, soul, or relationship field.
    src = _panel()
    body = src[src.index("function renderRoster("): src.index("function renderRoster(") + 1400]
    accessed = set(re.findall(r"\.(\w+)", body))
    # NB: not ".hidden" — that's the DOM property on the badge element, not a game field.
    leaky = {"trust", "affinity", "threat", "stats", "physical", "mental", "social",
             "soul", "emotional", "archetype", "confidence"}
    assert not (accessed & leaky), f"tally reads hidden fields: {accessed & leaky}"


def test_tally_fails_open_without_state():
    # /state best-effort: render must guard a null state and still show ceremony rows.
    src = _panel()
    assert "if (!house)" in src
    assert "st._state !== undefined" in src     # tally only renders when state was fetched
