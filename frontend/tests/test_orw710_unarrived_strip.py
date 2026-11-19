"""ORW-710 (Vault Wall): the premiere strip never names a houseguest who has not walked in. The engine ships no name or card for them (they are not in `house`; `premiere.remaining` carries one anonymous
placeholder each). The strip draws an unlit, nameless tile per placeholder, its label taken from the placeholder's own data (no phrase list in the page). Source-pinned: the FE pytest lane has no DOM runtime."""
import os

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = open(os.path.join(FE, "static", "js", "orwellStatusPanel.js"), encoding="utf-8").read()


def _strip_fn() -> str:
    i = SRC.index("function renderPremiereStrip(")
    j = SRC.index("// ORW-650 (0133 watch mode)", i)
    return SRC[i:j]


def test_strip_draws_a_nameless_unlit_tile_per_placeholder():
    fn = _strip_fn()
    assert "prem.remaining" in fn and "placeholder: true" in fn
    assert 'name: ""' in fn  # the tile carries no houseguest name
    assert "!card.placeholder && (card.isPlayer" in fn  # a placeholder is never lit
    assert "!card.placeholder && window.OrwellMonogram.portraitFor" in fn  # and never asks for a portrait


def test_placeholder_label_comes_from_data_not_a_page_phrase():
    fn = _strip_fn()
    assert "label: hg.name != null ? String(hg.name)" in fn
    assert "card.placeholder ? card.label" in fn
