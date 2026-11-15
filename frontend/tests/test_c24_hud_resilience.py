"""Queue C24 (slice) — HUD resilience (U5).

Static source contract (the HUDs are pure JS), like the other HUD tests:
  U5 — a transient engine hiccup keeps the last-known panel up (offline dot), instead of
       vanishing the player's only readout; only a genuine "no game" hides it.
"""

import os

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")


def _read(name):
    with open(os.path.join(STATIC, name), encoding="utf-8") as f:
        return f.read()


# --- U5: resilience -------------------------------------------------------------------

def test_status_panel_keeps_last_known_on_engine_hiccup():
    src = _read("orwellStatusPanel.js")
    # an offline indicator exists and a "_shown" guard distinguishes hiccup from no-game
    assert 'id="os-stale"' in src and "markStale(" in src
    assert "_shown" in src
    ref = src[src.index("async function refresh("): src.index("async function refresh(") + 800]
    # hiccup -> keep the readout; the offline dot shows only once the feed has been down for a release-sized gap (ORW-406: 10 s)
    assert "Date.now() - _failSince >= 10000)) markStale(true)" in ref and "if (_shown && ((typeof navigator" in ref  # ORW-437: a browser with no link (navigator.onLine === false) also flags the feed at once
    assert "else if (_shown) _scheduleStaleCheck()" in ref
    assert "else hidePanel()" in ref                      # never shown → nothing to keep


def test_status_panel_hides_only_on_genuine_no_game():
    src = _read("orwellStatusPanel.js")
    # the no-game branch (week < 1) clears _shown and the stale dot, then hides
    body = src[src.index("function render(st)"): src.index("function render(st)") + 600]
    assert "_shown = false" in body and "hidePanel()" in body
    assert "_shown = true" in body                        # a real game marks shown
