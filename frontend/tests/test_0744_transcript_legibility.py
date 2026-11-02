"""Issue #744 — chat-transcript legibility floor + APCA polarity (SHIP-FIRST).

The chat transcript IS the game (read for hours) and is the most-cited legibility gap.
Today the RECEIVED bubble (`.msg-ai`) flips ink polarity (dark over light wallpaper /
white over dark) at a single linear-Y threshold (0.22) — but a BUSY or saturated MID-TONE
wallpaper can leave the transcript below a real contrast floor with polarity alone.

The fix, source-pinned here (these are convention checks, not live render — the live
render proof is scripts/browser_smoke.py's #744 block + the worktree render-verify):

  1. RECEIVED bubbles (`.msg-ai`) carry a FLOORED opaque-enough scrim — a CSS var
     `--ai-scrim-alpha` driving the frost fill — never SVG refraction over the wallpaper
     (the bubble is deliberately NOT in the JS refraction set). The scrim is the legibility
     backstop (Apple's own move per the legibility reference image), tuned so a worst-case
     wallpaper clears the floor while a clear wallpaper still reads as glass.
  2. adaptiveGlass.js upgrades the linear-Y polarity flip with an APCA (Lc) contrast check
     on the resolved ink↔backdrop pair, and ESCALATES the LOCAL per-bubble scrim (raises
     `--ai-scrim-alpha` on that one element) until the APCA floor is met. No global
     body `theme-tinted` state (that's #739).
  3. APCA floor = Lc 60 (APCA "bronze" body-text minimum).
  4. SENT bubbles (`.msg-user`) keep their fixed white-ink floor (blue glass) — not regressed.
"""

import re
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[1]
ADAPTIVE = FRONTEND / "static" / "js" / "adaptiveGlass.js"
STYLE = FRONTEND / "static" / "style.css"


@pytest.fixture(scope="module")
def adaptive_src():
    return ADAPTIVE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def style_src():
    return STYLE.read_text(encoding="utf-8")


# ── 1. The per-bubble scrim floor on the RECEIVED bubble ──────────────────────

def test_msg_ai_glass_uses_floored_scrim_var(style_src):
    """The theme-frosted .msg-ai frost fill is driven by --ai-scrim-alpha so the floor is
    one source of truth AND adaptiveGlass.js can escalate it per-bubble."""
    block = _frosted_msg_ai_block(style_src)
    assert "--ai-scrim-alpha" in block, ".msg-ai glass must define --ai-scrim-alpha (the scrim floor knob)"
    # the background-color fill must READ the var (so the JS escalation lands on the same fill)
    assert re.search(r"background-color:\s*rgba\([^)]*var\(--ai-scrim-alpha", block), \
        ".msg-ai background-color must use rgba(... var(--ai-scrim-alpha ...)) — the floored scrim"


def test_msg_ai_scrim_floor_is_opaque_enough_but_not_solid(style_src):
    """The default scrim alpha is a real floor (>= 0.40 so a busy mid-tone can't wash out)
    yet stays translucent (< 1.0 — a frost, never a flat solid that kills the glass look)."""
    block = _frosted_msg_ai_block(style_src)
    m = re.search(r"--ai-scrim-alpha:\s*([0-9.]+)", block)
    assert m, ".msg-ai must set a default --ai-scrim-alpha"
    alpha = float(m.group(1))
    assert 0.40 <= alpha < 1.0, f"scrim floor {alpha} must be opaque-enough (>=0.40) yet glass (<1.0)"


def test_msg_ai_is_frost_only_never_svg_refraction(style_src, adaptive_src):
    """Received bubbles use FROST ONLY over the wallpaper — never SVG refraction. The bubble
    must not be url(#...)-filtered, and must not be in adaptiveGlass.js's refraction surface set."""
    block = _frosted_msg_ai_block(style_src)
    assert "url(#" not in block, ".msg-ai must not apply an SVG refraction filter (frost only)"
    # backdrop-filter on the bubble is a plain blur/saturate, no url() lens
    bf = re.findall(r"backdrop-filter:\s*([^;]+);", block)
    for v in bf:
        assert "url(" not in v, f".msg-ai backdrop-filter must be frost (blur/saturate), not a lens: {v}"


# ── 2. APCA helper + per-bubble escalation in adaptiveGlass.js ────────────────

def test_apca_helper_present(adaptive_src):
    """adaptiveGlass.js carries an APCA contrast helper (the WCAG-3 perceptual model) — the
    upgrade over the bare linear-Y flip."""
    assert "function apcaContrast" in adaptive_src, "an apcaContrast() helper must exist"
    # the APCA-W3 reverse-polarity exponents are load-bearing (light-on-dark is the dark-wall case)
    assert "0.65" in adaptive_src and "0.62" in adaptive_src, \
        "APCA reverse-polarity (light-on-dark) exponents must be present"
    assert "0.56" in adaptive_src and "0.57" in adaptive_src, \
        "APCA normal-polarity (dark-on-light) exponents must be present"


def test_apca_floor_is_lc_60(adaptive_src):
    assert re.search(r"APCA_FLOOR\s*=\s*60\b", adaptive_src), \
        "the APCA floor must be Lc 60 (APCA bronze body-text minimum)"


def test_per_bubble_scrim_escalation_to_meet_floor(adaptive_src):
    """After choosing polarity, the module composites the scrim over the backdrop and ESCALATES
    the LOCAL per-bubble scrim alpha until APCA clears the floor."""
    assert "function compositeOver" in adaptive_src, "must composite the scrim over the backdrop"
    assert "function resolveBubbleScrim" in adaptive_src, "must resolve a per-bubble scrim by APCA"
    # the escalation loop climbs alpha while below the floor (compares |Lc| to APCA_FLOOR)
    assert re.search(r"lc\s*>=\s*APCA_FLOOR", adaptive_src), \
        "escalation must stop once APCA >= APCA_FLOOR"
    assert "SCRIM_STEP" in adaptive_src and "SCRIM_MAX" in adaptive_src, \
        "escalation must climb by a step toward a cap"
    # the escalation lands on the SAME CSS var the floor uses (one source of truth)
    assert "--ai-scrim-alpha" in adaptive_src, \
        "the JS escalation must drive --ai-scrim-alpha (shared with the CSS floor)"


def test_escalation_is_local_not_global_theme_tinted(adaptive_src):
    """#744 is a LOCAL per-bubble escalation — it must NOT introduce a global body theme-tinted
    state (that's #739, blocked on #730)."""
    # the escalation must never set a global theme-tinted state on the body/document (it is local
    # per-bubble). Forbid actually MUTATING such a class — a prose mention of #739 is fine.
    assert not re.search(r"classList\.(add|toggle)\(\s*['\"]theme-tinted", adaptive_src), \
        "must not add a global theme-tinted body class (out of scope — that is #739)"
    assert not re.search(r"(document\.body|document\.documentElement)\b[^\n;]*theme-tinted", adaptive_src), \
        "must not apply a global theme-tinted state to body/document (that is #739)"


def test_floor_falls_back_to_the_stronger_polarity(adaptive_src):
    """#738 item #1 — the legibility floor is non-negotiable. If the linear-Y-PREFERRED polarity
    can't reach APCA_FLOOR even at the scrim cap (a starved mid-tone right at the flip boundary),
    resolveBubbleScrim must fall back to whichever polarity contrasts MORE — so a received bubble
    is legible over ANY wallpaper, not just the threshold-preferred half. (At the extremes the
    preferred polarity always wins, so this only bites the ambiguous middle.)"""
    # the per-polarity escalation is factored so BOTH polarities can be measured & compared
    assert "function _escalateScrim" in adaptive_src, \
        "per-polarity scrim escalation must be factored (_escalateScrim) so both polarities are measurable"
    # the fallback triggers only when the preferred polarity misses the floor …
    assert re.search(r"pref\.lc\s*<\s*APCA_FLOOR", adaptive_src), \
        "resolveBubbleScrim must detect the preferred polarity failing the floor"
    # … and then picks the polarity with the higher achieved APCA
    assert re.search(r"alt\.lc\s*>\s*pref\.lc", adaptive_src), \
        "resolveBubbleScrim must fall back to the higher-APCA polarity when the preferred can't reach the floor"


def test_only_msg_ai_is_the_adaptive_bubble(adaptive_src):
    """The adaptive bubble target is the RECEIVED bubble only (.msg-ai) — sent bubbles never adapt."""
    assert re.search(r'BUBBLE_ADAPTIVE\s*=\s*"\.msg-ai"', adaptive_src), \
        "the adaptive bubble selector must be .msg-ai (received only)"


# ── 3. SENT bubble keeps its fixed white-ink floor (no regression) ────────────

def test_sent_bubble_keeps_fixed_white_ink_blue_glass(style_src):
    """.msg-user (sent) keeps its fixed white ink over the system-blue glass — never adapts,
    never gets the received scrim var."""
    block = _frosted_msg_user_block(style_src)
    # The AA-safe deeper system blue (#0a5cc4) — the raw #0a84ff can't carry white text at 4.5:1.
    assert "rgba(10,92,196" in block, ".msg-user must keep the (AA-safe) system-blue glass fill"
    # white ink floor is asserted right after the fill block
    assert re.search(r"\.msg-user[^{]*\{[^}]*color:\s*#fff", style_src, re.S) or \
        re.search(r"\.msg-user\s*,\s*\n\s*body\.theme-frosted\s+\.msg-user\s+\.body\s*\{[^}]*#fff", style_src, re.S), \
        ".msg-user must keep a fixed white-ink floor"
    assert "--ai-scrim-alpha" not in block, ".msg-user must NOT carry the received-bubble scrim var"


# ── 4. a11y trio: reduced transparency already forces bubbles solid ───────────

def test_reduced_transparency_forces_bubbles_solid(style_src):
    """Under prefers-reduced-transparency the bubbles already go solid (scrim moot). The fix
    must not break that — the solid override for .msg-ai must remain."""
    assert re.search(
        r"@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{[^@]*body\.theme-frosted\s+\.msg-ai",
        style_src, re.S), \
        "reduced-transparency must still force .msg-ai to a solid (opaque) fill"


# ── helpers ───────────────────────────────────────────────────────────────────

def _frosted_msg_ai_block(css: str) -> str:
    """The first `body.theme-frosted .msg-ai { ... }` rule body (the glass fill block)."""
    m = re.search(r"body\.theme-frosted\s+\.msg-ai\s*\{(.*?)\}", css, re.S)
    assert m, "could not find the theme-frosted .msg-ai glass block"
    return m.group(1)


def _frosted_msg_user_block(css: str) -> str:
    m = re.search(r"body\.theme-frosted\s+\.msg-user\s*\{(.*?)\}", css, re.S)
    assert m, "could not find the theme-frosted .msg-user glass block"
    return m.group(1)
