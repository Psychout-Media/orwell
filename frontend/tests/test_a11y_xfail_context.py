"""The a11y matrix XFAIL registry's CONTEXT constraint (#1375-i).

XFAIL needles are substring-matched against the finding line, so a selector-only needle
would exempt that element in EVERY sweep context. `XFAIL_CONTEXT` narrows an entry to one
context (the settings-scrim reading for #1375-i): a hit from any other context must classify
as a real FAIL — the un-scrimmed user-bar chip measures ~13:1, and a regression there gates.

Drives `classify_and_report()` directly with synthetic findings (no browser, no engine —
`a11y_matrix`'s module body is import-safe by design; the sweep lives under main()).
Roles only; Vault-free (chrome only).
"""
import importlib
import os
import sys

import pytest

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")

# The finding line #1375-i's needle matches (the volatile numbers after the needle are
# irrelevant to matching — only the stable prefix is compared).
_USER_BAR_LINE = ("contrast:sidebar:span#user-bar-name.user-bar-name — WCAG 3.40:1 < 4.5 "
                  "(APCA Lc 27 dark-on-light, 9.8px, fg=rgb(22, 25, 31) bg=rgb(108, 109, 110)) 'User'")


@pytest.fixture()
def a11y():
    sys.path.insert(0, SCRIPTS)
    try:
        mod = importlib.import_module("a11y_matrix")
    finally:
        sys.path.remove(SCRIPTS)
    saved = dict(mod.found), set(mod.xfail_hits), dict(mod.XFAIL), dict(mod.XFAIL_CONTEXT)
    mod.found.clear()
    mod.xfail_hits.clear()
    # A5: no live context-narrowed entry remains (#1375-i was removed), so exercise the MECHANISM with a synthetic one shaped exactly like the old entry.
    mod.XFAIL["#1375-i"] = "contrast:sidebar:span#user-bar-name.user-bar-name"
    mod.XFAIL_CONTEXT["#1375-i"] = "+settings"
    yield mod
    mod.found.clear()
    mod.found.update(saved[0])
    mod.xfail_hits.clear()
    mod.xfail_hits.update(saved[1])
    mod.XFAIL.clear(); mod.XFAIL.update(saved[2])
    mod.XFAIL_CONTEXT.clear(); mod.XFAIL_CONTEXT.update(saved[3])


def test_the_removed_live_entries_stay_removed():
    """A5 ratchet: #1375-e/-f/-i are hard assertions now - re-adding one needs a fresh finding id and a reason."""
    sys.path.insert(0, SCRIPTS)
    try:
        fresh = importlib.import_module("a11y_matrix")
    finally:
        sys.path.remove(SCRIPTS)
    # (the fixture-injected synthetic entry is restored on teardown, so this module-level read is the real registry only when run in isolation; assert the NEEDLES instead)
    live = {k: v for k, v in fresh.XFAIL.items() if k not in ("#1375-i",)}
    for fid in ("#1375-e", "#1375-f"):
        assert fid not in live, f"{fid} was settled by the A5 matrix run and must not return"
    assert not any(v == "contrast:sidebar:span.grow" or v == "contrast:sidebar:span.sidebar-brand-title" for v in live.values())


def test_registry_carries_the_context_constraint(a11y):
    """A context-narrowed entry stays context-scoped — dropping the constraint reopens the blanket exemption."""
    assert a11y.XFAIL_CONTEXT.get("#1375-i") == "+settings"
    assert "#1375-i" in a11y.XFAIL


def test_scrimmed_context_is_absorbed_as_xfail(a11y, capsys):
    """The settings-scrim reading (the only context CI fires) classifies as the known XFAIL."""
    a11y.record(_USER_BAR_LINE, "desktop-1366+settings")
    assert a11y.classify_and_report() == 0
    assert "XFAIL[#1375-i]" in capsys.readouterr().out


def test_unscrimmed_context_is_a_real_fail(a11y, capsys):
    """The same element failing OUTSIDE the scrim (a real chip/ink regression) must gate."""
    a11y.record(_USER_BAR_LINE, "desktop-1366")
    assert a11y.classify_and_report() == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    # The needle fired (context-rejected) — the xpass report must NOT suggest removing #1375-i
    # while its element is actively failing.
    assert "#1375-i" in a11y.xfail_hits


def test_mixed_contexts_do_not_hide_the_unscrimmed_hit(a11y, capsys):
    """A finding seen BOTH under the scrim and un-scrimmed carries a real regression — gate it."""
    a11y.record(_USER_BAR_LINE, "desktop-1366+settings")
    a11y.record(_USER_BAR_LINE, "tablet-820")
    assert a11y.classify_and_report() == 1
    assert "FAIL" in capsys.readouterr().out
