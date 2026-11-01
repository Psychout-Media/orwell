"""#887 — consolidate the two "jump to bottom" buttons into ONE.

The chat used to ship two scroll-to-latest controls:
  - the CIRCLE  #orwell-scroll-bottom (static/js/orwellScrollBottom.js, #538) — the keeper;
  - the SQUIRCLE #scroll-bottom-btn (class .scroll-nav-btn, an inline index.html script) —
    retired here. It overlapped the decision card (#933) because of fixed offsets.

The owner's ruling (#887): keep the circle, but
  1. anchor it to the .chat-input-bar composer rect (port the squircle's reposition()),
  2. give it a NEUTRAL hairline border (no accent hue in any state — only the unread badge
     keeps the sanctioned accent),
  3. SMOOTH-scroll on click (honoring prefers-reduced-motion),
  4. retire the squircle entirely (markup + inline script + .scroll-nav-btn CSS).

These are source-pinned convention checks — they live outside obvious keywords, so run the
WHOLE FE suite, not a -k subset (a subset can pass green while the real gate fails).
"""
import re
from pathlib import Path

FE = Path(__file__).resolve().parents[1]
JS_DIR = FE / "static" / "js"
OSB = (JS_DIR / "orwellScrollBottom.js").read_text(encoding="utf-8")
INDEX = (FE / "static" / "index.html").read_text(encoding="utf-8")
STYLE = (FE / "static" / "style.css").read_text(encoding="utf-8")
MODEL_PICKER = (JS_DIR / "modelPicker.js").read_text(encoding="utf-8")

# Every static JS file — the "exists once" / "no stray reference" sweeps.
ALL_JS = sorted((FE / "static").rglob("*.js"))


# ── 1. exactly ONE jump-to-bottom button survives ─────────────────────────────

def test_the_squircle_markup_is_gone_from_index_html():
    # No <button id="scroll-bottom-btn"> element anywhere.
    assert not re.search(r"<button[^>]*id=['\"]scroll-bottom-btn['\"]", INDEX), \
        "the retired squircle button markup is still in index.html"


def test_the_squircle_class_markup_is_gone():
    # The .scroll-nav-btn class should no longer be applied to any element.
    assert 'class="scroll-nav-btn"' not in INDEX
    assert "class='scroll-nav-btn'" not in INDEX


def test_the_surviving_button_is_the_circle():
    # The keeper is created by orwellScrollBottom.js with id orwell-scroll-bottom and is round.
    assert 'BTN_ID = "orwell-scroll-bottom"' in OSB
    assert "border-radius: 50%" in OSB


# ── 2. the squircle's inline reposition script is gone ────────────────────────

def test_squircle_inline_script_removed_from_index():
    # The retired inline IIFE referenced getElementById('scroll-bottom-btn') and a bare
    # reposition() that anchored bottomBtn to the chat bar. Both must be gone from index.html.
    assert "getElementById('scroll-bottom-btn')" not in INDEX
    assert "getElementById(\"scroll-bottom-btn\")" not in INDEX
    assert "bottomBtn" not in INDEX


# ── 3. the squircle's CSS rules are gone ──────────────────────────────────────

def test_scroll_nav_btn_css_rules_removed():
    # No real CSS selector/rule for .scroll-nav-btn or #scroll-bottom-btn survives.
    # (A descriptive code comment mentioning the retired names is allowed; an actual rule
    #  block — selector followed by `{` — is not.)
    for sel in (r"\.scroll-nav-btn", r"#scroll-bottom-btn"):
        # selector immediately (modulo combinators/commas/::before/.show/:hover) followed by {
        rule = re.compile(sel + r"[^\{;\n]*\{")
        assert not rule.search(STYLE), \
            f"a CSS rule for {sel} still exists in style.css"


def test_scroll_nav_btn_not_in_any_selector_list():
    # The tap-target coarse-pointer group + the responsive @media list must no longer name
    # the dead class as a selector. Strip line comments first so the audit comment is ignored.
    css_no_comments = re.sub(r"/\*.*?\*/", "", STYLE, flags=re.S)
    assert ".scroll-nav-btn" not in css_no_comments


# ── 4. the survivor keeps a NEUTRAL hairline border (no accent in any state) ───

def test_circle_border_is_neutral_not_accent():
    # The injected CSS string in orwellScrollBottom.js must not put the accent on the border.
    # Pull the JS template-string CSS body and inspect every `border`/`border-color` decl.
    border_decls = re.findall(r"border(?:-color)?:\s*[^\"]+", OSB)
    assert border_decls, "no border declaration found in orwellScrollBottom.js CSS"
    for decl in border_decls:
        assert "--accent" not in decl, \
            f"the button outline still references the accent color: {decl!r}"
    # And it positively uses a neutral hairline (the kit's glass-rim border / a white hairline).
    assert ("--ow-glass-rim-border" in OSB) or ("rgba(255,255,255" in OSB), \
        "the circle should use a neutral hairline border"


def test_no_accent_hover_border_on_the_circle():
    # The old hover rule flipped the border to --accent / #6d4aff. That must be gone.
    assert "#6d4aff" not in OSB
    # The :hover/:focus-visible rule must not set a border-color at all.
    hover = re.search(r":hover[^{]*\{[^}]*\}", OSB)
    # crude: ensure no 'border-color: var(--accent' anywhere
    assert "border-color: var(--accent" not in OSB


# ── 5. the click SMOOTH-scrolls (reduced-motion safe), not instant-only ───────

def test_click_uses_smooth_scroll_honoring_reduced_motion():
    assert "behavior: \"smooth\"" in OSB or "behavior: 'smooth'" in OSB, \
        "the click handler should smooth-scroll"
    assert "prefersReducedMotion" in OSB, \
        "smooth scroll must honor prefers-reduced-motion (instant when reduced)"
    # The old unconditional scrollHistoryInstant() call should no longer drive the click.
    # (It's fine if the symbol is absent entirely; assert it isn't the click path.)
    assert "scrollHistoryInstant()" not in OSB


# ── 6. the survivor is composer-anchored (ported reposition) ──────────────────

def test_circle_is_composer_anchored():
    assert "function reposition" in OSB
    assert ".chat-input-bar" in OSB
    # The squircle's anchoring math, ported: bottom = innerHeight - top + 16, right = innerWidth -
    # rect.right + 8. `top` starts at the composer's top and lifts to the room strip's top when the
    # strip sits directly above the composer (so the fab never paints over the room chips).
    assert "var top = rect.top;" in OSB
    assert 'getElementById("orwell-room-strip")' in OSB
    assert "window.innerHeight - top + 16" in OSB
    assert "window.innerWidth - rect.right + 8" in OSB


# ── 7. the model-picker hide/restore points at the survivor ───────────────────

def test_model_picker_targets_the_surviving_button():
    assert "getElementById('scroll-bottom-btn')" not in MODEL_PICKER
    assert MODEL_PICKER.count("getElementById('orwell-scroll-bottom')") == 2, \
        "model picker should hide/restore #orwell-scroll-bottom (the single survivor)"


# ── 8. no other JS still creates/targets the retired squircle id ──────────────

def test_no_js_references_the_retired_squircle_id():
    offenders = []
    for p in ALL_JS:
        txt = p.read_text(encoding="utf-8")
        # Ignore descriptive comments; flag an actual id reference.
        no_comments = re.sub(r"//.*", "", txt)
        no_comments = re.sub(r"/\*.*?\*/", "", no_comments, flags=re.S)
        if "scroll-bottom-btn" in no_comments and "orwell-scroll-bottom" not in \
                no_comments.replace("scroll-bottom-btn", "", 0):
            # crude guard: the only allowed token is orwell-scroll-bottom
            for m in re.finditer(r"['\"]([\w-]*scroll-bottom-btn)['\"]", no_comments):
                if m.group(1) != "orwell-scroll-bottom":
                    offenders.append(f"{p.name}: {m.group(1)}")
    assert not offenders, f"stray references to the retired squircle id: {offenders}"


# ── 9. #948 — the button is mutually exclusive with the decision card ──────────
# A decision card only appears at the bottom; the button only when scrolled up — so they must
# never coexist (they share the above-composer slot and overlapped, #933). A visible
# #orwell-decision-card hard-suppresses #orwell-scroll-bottom.

def test_decision_card_suppression_helper_exists():
    assert "function decisionCardVisible" in OSB
    assert "orwell-decision-card" in OSB, \
        "the suppression must key on the real decision-card id (#orwell-decision-card)"


def test_update_suppresses_button_when_card_visible():
    # The hide-condition (the `if (...)` that drops .osb-show) must include decisionCardVisible()
    # so a card wins over scroll position. Match from `if (nearBottom(box)` up to the `{` that
    # opens the branch body.
    hide_cond = re.search(r"if \(nearBottom\(box\).*?\)\s*\{", OSB, flags=re.S)
    assert hide_cond, "could not find the hide-condition in update()"
    assert "decisionCardVisible()" in hide_cond.group(0), \
        "update()'s hide-condition must include decisionCardVisible() (card wins over scroll pos)"


def test_button_rechecks_on_card_mount_and_unmount():
    # The card mounts OUTSIDE #chat-history (into a sheet/notice) and is .remove()'d on dismiss,
    # so a body-subtree observer (or the orwell:pending event) must re-run update().
    assert "function watchDecisionCard" in OSB
    assert "document.body" in OSB and "subtree: true" in OSB, \
        "a body-subtree MutationObserver should re-check on card mount/unmount"
    assert ('addEventListener("orwell:pending"' in OSB
            or "addEventListener('orwell:pending'" in OSB), \
        "should also re-check on the orwell:pending event (fast belt)"
    assert "watchDecisionCard()" in OSB, "watchDecisionCard must be wired in start()"
