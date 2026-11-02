"""Liquid glass — SVG-refraction progressive enhancement (SOURCE-PINS).

Pins the wiring + the hard contracts that are easy to break by accident:
  1. the module exists and is LOADED in index.html (after the kit scripts);
  2. it FEATURE-DETECTS — Chromium gate + the `backdrop-filter: url(#x)` capability
     test — and is FAIL-SOFT (every apply path drops to the CSS glass on error);
  3. it carries the kube.io technique (feImage → feDisplacementMap with R/G channel
     selectors, a squircle edge profile, 128-neutral encoding);
  4. it EXCLUDES the gating #orwell-headshot dialog (stays opaque);
  5. the CSS blur-glass FALLBACK rules still exist in style.css — a regression guard
     so a future edit can't delete the baseline the SVG layer enhances.

The live visual behavior (edges refract over busy content, center stays crisp,
fallback intact) is proven by the Playwright screenshots captured in the PR.
"""
import os
import re

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*parts):
    with open(os.path.join(FRONTEND, *parts), encoding="utf-8") as f:
        return f.read()


JS = _read("static", "js", "liquidGlass.js")
INDEX = _read("static", "index.html")
CSS = _read("static", "style.css")


# ── 1. module exists + is loaded after the kits ───────────────────────────────

def test_module_file_exists_and_is_nonempty():
    assert len(JS) > 500


def test_module_loaded_in_index_after_the_kits():
    assert "liquidGlass.js" in INDEX
    # must load AFTER the window + gadget kits so .ow-*/.og-* surfaces exist.
    win = INDEX.index("orwellWindow.js")
    gad = INDEX.index("orwellGadget.js")
    lg = INDEX.index("liquidGlass.js")
    assert lg > win and lg > gad


# ── 2. feature-detection (Chromium gate) + fail-soft ──────────────────────────

def test_feature_detects_backdrop_filter_url_support():
    assert "CSS.supports" in JS
    assert 'backdrop-filter", "url(#x)"' in JS or "backdrop-filter','url(#x)'" in JS


def test_feature_detects_chromium_engine_and_excludes_firefox_safari():
    # Chrome-gate: include Chromium, exclude the engines that lie about support.
    assert "Firefox" in JS  # Gecko exclusion
    assert "Safari" in JS   # Safari exclusion
    assert re.search(r"Chrome\|Chromium\|CriOS", JS)


def test_unsupported_is_a_noop_marker_not_a_surface_touch():
    # On the unsupported path the module sets supported:false and must NOT clear or
    # set backdrop-filter on anything — the CSS glass stands untouched.
    assert "supported: false" in JS
    assert "function () {}" in JS  # the no-op refresh on the unsupported marker


def test_fail_soft_paths_drop_to_css_glass():
    # apply errors fall back to clearFrom (removes our override → CSS glass);
    # boot errors clearAll. Both wrapped in try/catch.
    assert "clearFrom(el)" in JS
    assert "clearAll()" in JS
    assert JS.count("catch (_)") >= 5  # pervasive fail-soft


# ── 3. the kube.io SVG-refraction technique is present ────────────────────────

def test_uses_feimage_and_fedisplacementmap_with_rg_channels():
    assert "feImage" in JS
    assert "feDisplacementMap" in JS
    assert 'xChannelSelector", "R"' in JS
    assert 'yChannelSelector", "G"' in JS
    assert '"in", "SourceGraphic"' in JS
    assert '"in2", "displacement_map"' in JS


def test_specular_rim_highlight_via_feblend():
    # The kube.io feBlend specular layer: a SECOND generated rim-light image
    # (white, alpha = highlight intensity) loaded as its own feImage and screened
    # over the refracted backdrop so a bright lit edge rides the rim. Rim light =
    # max(0, outwardNormal · fixed lightDir)^POWER, confined to the edge band.
    assert "SPEC_ENABLE" in JS
    assert "SPEC_ANGLE_DEG" in JS
    assert "specUrl" in JS                 # the separate specular map is generated
    assert '"result", "specular_layer"' in JS
    assert "feBlend" in JS
    assert '"mode", "screen"' in JS        # screen = lighten → the lit rim


def test_displacement_map_uses_squircle_edge_and_neutral_128():
    assert "squircle" in JS.lower()
    assert "SQUIRCLE_N" in JS
    # 128 = neutral displacement encoding (R=x, G=y).
    assert "128 + dr * 127" in JS
    assert "128 + dg * 127" in JS


def test_edge_bleed_clamp_map_outer_edge_is_neutral():
    # THE "RING" FIX. The squircle profile is maximal at the very perimeter (t=0 ⇒ push=1.0),
    # so feDisplacementMap at the outermost row/col samples the backdrop up to `scale` px BEYOND
    # the surface — at the rounded corners that pulls outside content into the rim, a refraction
    # halo. The kube article's own constraint: displacement must fall to NEUTRAL at the outer
    # edge. So squircleProfile WINDOWS the magnitude to 0 at the very edge (a smoothstep lead-in
    # over EDGE_NEUTRAL of the bezel band), and the specular hairline fades the same way — the
    # perimeter pixels are byte-neutral, so no out-of-bounds sample → no bleed ring. This is a
    # source-pin so the clamp can't silently regress.
    assert "EDGE_NEUTRAL" in JS
    assert re.search(r"var EDGE_NEUTRAL\s*=\s*0?\.\d+", JS), "EDGE_NEUTRAL must be a small >0 fraction"
    # the clamp is applied inside squircleProfile (the displacement magnitude window).
    sp = re.search(r"function squircleProfile\(t\) \{(.*?)\n  \}", JS, re.S).group(1)
    assert "EDGE_NEUTRAL" in sp, "the edge-neutral window must live inside squircleProfile"
    assert "3 - 2 * u" in sp, "smoothstep lead-in (0 at the very edge → peak inward)"
    # and the specular rim fades to 0 at the very edge too (no bright pixel on the corner).
    assert "SPEC_BAND * EDGE_NEUTRAL" in JS


def test_edge_bleed_clamp_menus_clip_backdrop_to_rounded_rect():
    # Belt-and-suspenders for the refraction ring: the transient menus/popovers clip the
    # SVG-refraction backdrop to their OWN rounded-rect (overflow:hidden under the frosted
    # theme) so any residual corner halo past the border-radius is clipped away. Scoped to the
    # leaf popovers only (no submenu/shadow to clip); chrome panels are untouched. (#1638: the
    # model picker folded from `.model-picker-menu` onto the shared `.ow-popover` kit surface, and
    # the dead `.overflow-menu` member was retired from this clip in the dead-CSS sweep — no element
    # carries `.overflow-menu` anymore, so the refracted leaf popovers are `.dropdown` + `.ow-popover`.)
    block = re.search(
        r"body\.theme-frosted \.dropdown,\s*"
        r"body\.theme-frosted \.ow-popover \{([^}]*)\}",
        CSS, re.S)
    assert block, "the transient leaf popovers must share a frosted clip rule"
    assert "overflow: hidden" in block.group(1)


def test_applied_via_backdrop_filter_url():
    assert "url(#" in JS
    # Applied via setProperty with `important` priority — NOT a plain `el.style.backdropFilter =`.
    # The frosted CSS sets `backdrop-filter: blur(..) !important` on the same surfaces, and a
    # plain inline style LOSES to a stylesheet !important — so the SVG refraction must be set
    # with `important` priority to win the cascade (an inline !important outranks it). Without
    # this the url(#filter) is silently clobbered by the blur and the effect never renders.
    assert 'setProperty("backdrop-filter"' in JS
    assert 'setProperty("-webkit-backdrop-filter"' in JS
    assert '"important"' in JS


def test_tunable_constants_exist_at_top():
    for c in ("SCALE", "RADIUS", "EDGE", "SQUIRCLE_N", "EDGE_NEUTRAL"):
        assert re.search(r"var " + c + r"\s*=", JS), c


# ── 4. the gating dialog stays opaque (excluded) ──────────────────────────────

def test_orwell_headshot_is_excluded_from_refraction():
    assert "orwell-headshot" in JS
    assert "EXCLUDE_IDS" in JS


# ── perf posture: capped, ResizeObserver (not poll), debounced ────────────────

def test_perf_posture_capped_and_observer_based():
    assert "MAX_LIVE_SURFACES" in JS
    assert "ResizeObserver" in JS
    assert "DEBOUNCE" in JS
    # active only under the frosted theme.
    assert "theme-frosted" in JS


def test_reduced_motion_safe():
    assert "prefers-reduced-motion" in JS
    assert "SCALE_REDUCED" in JS


# ── 5. the CSS blur-glass FALLBACK must remain intact (regression guard) ───────

def test_css_blur_glass_baseline_still_exists():
    # The shipped frosted baseline the SVG layer enhances — these must NOT be
    # deleted by a future edit (non-Chrome relies entirely on them).
    assert "body.theme-frosted .ow-window" in CSS
    assert "body.theme-frosted .og-card" in CSS
    assert "body.theme-frosted .chat-input-bar" in CSS
    # the baseline uses a real backdrop blur (the fallback frost).
    assert re.search(r"body\.theme-frosted \.ow-window\s*\{[^}]*backdrop-filter:\s*blur", CSS, re.S)


def test_headshot_stays_opaque_in_css():
    # the gating dialog's opaque override survives (no refraction + no blur on it).
    assert "body.theme-frosted #orwell-headshot.ow-window" in CSS


# ── 6. Control-Center dock glass (scope: iOS Control Center) ───────────────────

def test_control_center_dock_is_glassed():
    # The minimized-window dock reads as an iOS Control-Center module grid: rounded
    # translucent glass shell + chip TILES in a wrapping row.
    assert "body.theme-frosted #minimized-dock.ow-has-rows" in CSS
    assert re.search(r"#minimized-dock\.ow-has-rows[^}]*backdrop-filter", CSS, re.S) \
        or re.search(r"#minimized-dock\.ow-has-rows[^}]*--ow-glass-backdrop", CSS, re.S)
    # chips become a wrapping tile grid (row + wrap), not a stacked list.
    assert re.search(r"#minimized-dock \.minimized-dock-rows[^}]*flex-wrap:\s*wrap", CSS, re.S)
    # the dock is a refraction target in the JS too.
    assert "minimized-dock" in JS


# ── 7. animated-bg default + reduced-motion gate (scope: alive backdrop) ───────

def test_game_build_default_theme_has_animated_bg():
    theme = _read("static", "js", "theme.js")
    # The default theme ships an animated background so the glass has dynamic
    # content to refract. The glass theme's wallpaper is now the SHARED login
    # mesh gradient (the same aurora the login screen lenses) rendered into #__wp,
    # not the old perlin-flow canvas. The fresh-session resolver must still apply
    # the default theme's pattern (not drop to 'none').
    assert "DEFAULT_THEME = 'glass'" in theme
    assert re.search(r"\bglass\s*:\s*'glass-mesh'", theme), \
        "the glass theme's default bg pattern must be the shared login mesh ('glass-mesh')"
    # fresh session resolves the active theme's pattern, not 'none'.
    assert "THEME_DEFAULT_PATTERN[activeName]" in theme


def test_animated_bg_is_reduced_motion_gated():
    theme = _read("static", "js", "theme.js")
    # canvas patterns freeze to a STILL frame under reduced-motion (no dead bg, no motion).
    assert "_bgStaticInit" in theme
    assert "_prefersReducedMotion()" in theme


# ── 8. adaptive-contrast / always-readable text floor ─────────────────────────

def test_adaptive_contrast_tint_floor_exists():
    # text contrast is anchored by a NEUTRAL dark veil + a text-shadow (not a hued
    # tint) — the structural "always readable" guarantee over an animated bg.
    assert "--ow-glass-veil-dark" in CSS
    assert "--ow-glass-text-shadow" in CSS


def test_luminance_helper_available_for_contrast():
    # the existing WCAG luminance helpers (reused pattern) are present + exported.
    hexjs = _read("static", "js", "color", "hex.js")
    assert "relativeLuminance" in hexjs
    assert "contrastRatioFromLum" in hexjs
    assert "onAccentColor" in hexjs


# ── 9. Apple HIG accessibility trio (reduced-transparency / contrast) ──────────

def test_reduced_transparency_solid_fallback():
    # prefers-reduced-transparency → SOLID surfaces (no translucency/blur/refraction).
    assert "@media (prefers-reduced-transparency: reduce)" in CSS
    # the solid fallback drops backdrop-filter to none under that query.
    block = CSS[CSS.index("@media (prefers-reduced-transparency: reduce)"):]
    # window widened: the reduced-transparency selector list grew with the kit rollout
    # (the icon-rail a11y fallback among others), pushing the declaration block down.
    assert "backdrop-filter: none" in block[:1600]
    # the JS ALSO bails (no inline filter that would defeat the CSS solid fallback).
    assert "reducedTransparency" in JS
    assert "prefers-reduced-transparency" in JS


def test_increased_contrast_strengthens_glass():
    assert "@media (prefers-contrast: more)" in CSS
    block = CSS[CSS.index("@media (prefers-contrast: more)"):]
    # increased-contrast strengthens the neutral anchor / borders for legibility.
    # (window widened: the contrast block's selector list grew with the kit rollout,
    # pushing the border-color property further down.)
    assert "--ow-glass-veil-dark" in block[:1600] or "border-color" in block[:1600]


# ── 10. Apple HIG visual language (concentric radii, luminous edge, float) ─────

def test_apple_language_tokens_present():
    assert "--ow-glass-radius" in CSS          # very-rounded surface radius
    assert "--ow-glass-radius-inner" in CSS    # concentric inner-control radius
    assert "--ow-glass-edge" in CSS            # luminous edge highlight
    assert "--ow-glass-float" in CSS           # soft outer float shadow


def test_chat_bubbles_are_imessage_glass_but_not_svg_refracted():
    # Owner ruling + the iOS 26 Messages reference: Apple's own Messages makes the
    # bubbles Liquid Glass — RECEIVED = neutral translucent frosted glass, SENT = the
    # system-blue tint, white vibrant text. We match that under body.theme-frosted.
    def _block(sel):
        i = CSS.index(sel)
        return CSS[i:CSS.index("}", i) + 1]
    received = _block("body.theme-frosted .msg-ai {")
    sent = _block("body.theme-frosted .msg-user {")
    # received bubbles carry a translucent frosted-glass material (backdrop blur).
    assert "backdrop-filter" in received and "blur(" in received
    # sent bubbles carry the iMessage system blue (a BACKGROUND tint, not text).
    # (the AA-safe deeper system blue #0a5cc4 — white on raw #0a84ff is only ~3.65:1)
    assert "10,92,196" in sent or "rgba(10, 92, 196" in sent
    # bubbles are NEVER in the JS SVG refraction set (perf — many bubbles on screen):
    # the CSS glass blur is their material, but liquidGlass.js must not target them.
    assert ".message" not in JS and ".bubble" not in JS
    assert "msg-ai" not in JS and "msg-user" not in JS


# ── 11. typography legibility on glass (no thin weights) ───────────────────────

def test_no_thin_font_weights_on_glass():
    # Apple HIG Typography: floor glass text at Regular (400); clamp stray thin weights.
    assert "font-weight: 400" in CSS
    assert 'font-weight:300' in CSS  # the clamp targets stray inline thin weights


# ── 12. perf: mobile element cap (scope: mobile-friendly) ──────────────────────

def test_mobile_hard_caps_refracted_count():
    assert "MAX_LIVE_SURFACES_MOBILE" in JS
    assert "activeMaxSurfaces" in JS
    # the mobile cap is strictly lower than desktop.
    m_desktop = int(re.search(r"MAX_LIVE_SURFACES\s*=\s*(\d+)", JS).group(1))
    m_mobile = int(re.search(r"MAX_LIVE_SURFACES_MOBILE\s*=\s*(\d+)", JS).group(1))
    assert m_mobile < m_desktop


# ── 13. Apple-parity material: luminous (not darkening) + specular + float ──────

def test_glass_material_is_neutral_frost_not_colored():
    # Owner correction: Liquid Glass has NO hue of its own — a NEUTRAL white/dark veil;
    # color comes ONLY from the backdrop. So the veils are neutral rgba (no --panel/--fg
    # hue) and saturation is RESTRAINED (<=125%, Apple is subtle — high sat reads colored).
    assert "--ow-glass-veil-light" in CSS and "--ow-glass-veil-dark" in CSS
    # the veils are neutral (white / near-black rgba), not a hued theme color.
    assert re.search(r"--ow-glass-veil-light:\s*rgba\(255,\s*255,\s*255", CSS)
    # backdrop saturation restrained (neutral frost, not colored glass).
    sat = re.findall(r"--ow-glass-backdrop[^:]*:\s*[^;]*saturate\((\d+)%\)", CSS)
    assert sat and all(int(s) <= 125 for s in sat), f"saturation too high (colored glass): {sat}"
    # a SLIGHT luminosity lift (Apple ios_glass_over_dark is subtle — a gentle lift,
    # not a strong brighten), but a real one (> 1.1).
    m = re.search(r"--ow-glass-backdrop:\s*[^;]*brightness\(([\d.]+)\)", CSS)
    assert m and float(m.group(1)) >= 1.1


def test_directional_luminous_edge_rim():
    # Apple ios_glass_over_dark "tell": a thin DIRECTIONAL luminous rim around the
    # perimeter, brightest on one side (here bottom-left), thinning at the opposite —
    # NOT a flat uniform border or a heavy fill bloom.
    assert "DIRECTIONAL LUMINOUS EDGE RIM" in CSS
    assert re.search(r"inset 2px -2px 2px -1px rgba\(255,255,255", CSS)   # bright bottom-left rim
    assert re.search(r"inset -1px 1px 2px -1px rgba\(255,255,255", CSS)   # fainter top-right rim


def test_soft_outer_float_shadow_is_genuine_elevation():
    m = re.search(r"--ow-glass-float:\s*([^;]+);", CSS)
    assert m
    # a wide soft ambient shadow (>= ~40px blur) = real elevation off the content.
    blurs = [int(x) for x in re.findall(r"\d+px\s+(\d+)px", m.group(1))]
    assert blurs and max(blurs) >= 40, "float shadow too tight to read as elevation"


# ── 14. Fluid morph on interaction (Apple: controls come to life) ──────────────

def test_controls_morph_on_hover_and_press():
    # glass controls lighten + lift on hover, depress on press — reduced-motion gated.
    assert "Fluid morph on interaction" in CSS
    assert "translateY(-1px) scale(1.015)" in CSS   # hover lift
    assert "scale(0.97)" in CSS                       # press depress
    # reduced-motion strips the transition/transform.
    rm_blocks = re.findall(r"@media \(prefers-reduced-motion: reduce\)\s*\{(.*?)\n\}", CSS, re.S)
    assert any("transform: none" in b for b in rm_blocks)


# ── 15. Apple Liquid Glass BUTTON SYSTEM (HIG Buttons) ─────────────────────────

def test_button_system_present_with_hierarchy():
    assert "Apple Liquid Glass BUTTON SYSTEM" in CSS
    # capsule/disc radius token + glass material.
    assert "--ow-btn-radius" in CSS
    assert "--ow-btn-glass" in CSS


def test_window_controls_are_circular_glass_discs():
    # min/close/dock become circular glass discs (icon-only).
    block = CSS[CSS.index("Apple Liquid Glass BUTTON SYSTEM"):]
    assert re.search(r"\.ow-controls button\s*\{[^}]*border-radius:\s*50%", block, re.S)
    # >=44px hit region via an invisible ::after (WCAG 2.5.5).
    assert re.search(r"\.ow-controls button::after\s*\{[^}]*width:\s*44px", block, re.S)


def test_prominent_actions_are_neutral_glass_not_accent():
    # Owner correction: glass is colorless — the PROMINENT action is distinguished by
    # LUMINOSITY + WEIGHT (brighter/opaquer neutral glass + Semibold), NOT an accent hue.
    block = CSS[CSS.index("Apple Liquid Glass BUTTON SYSTEM"):]
    assert ".odec-confirm" in block and ".send-btn" in block
    # the prominent base uses a neutral white fill, never an accent var.
    prom = re.search(r"\.ow-btn-prominent\s*\{(.*?)\}", block, re.S).group(1)
    assert "rgba(255,255,255" in prom and "--accent" not in prom and "--ow-accent" not in prom
    # the real prominent buttons (send/confirm) carry no accent fill either.
    sendblk = re.search(r"body\.theme-frosted \.send-btn\s*\{(.*?)\}", block, re.S).group(1)
    assert "--accent" not in sendblk and "--on-accent" not in sendblk


def test_buttons_have_hover_press_and_disabled_states():
    block = CSS[CSS.index("Apple Liquid Glass BUTTON SYSTEM"):]
    assert ":active" in block            # press
    assert ":hover" in block             # hover
    assert ":disabled" in block          # disabled/unavailable
    # disabled reads clearly inert.
    assert re.search(r":disabled\s*\{[^}]*cursor:\s*not-allowed", block, re.S)


def test_button_morph_is_reduced_motion_gated():
    block = CSS[CSS.index("Apple Liquid Glass BUTTON SYSTEM"):]
    rm = re.search(r"@media \(prefers-reduced-motion: reduce\)\s*\{(.*)$", block, re.S).group(1)
    assert "transform: none" in rm


# ── 16. macOS traffic lights + iOS toggle/slider colors (parity) ───────────────

def test_traffic_lights_top_left_colored_when_focused():
    # window controls are macOS traffic lights: close=red, min=yellow when focused;
    # neutral grey when unfocused; cluster ordered to the LEFT. (The third green/max
    # light was dropped — owner ruling; see test_maximize_control_removed_from_all_windows.)
    assert re.search(r"\.ow-window\.ow-focused .ow-controls \.ow-close\s*\{[^}]*#ff5f57", CSS, re.S)
    assert re.search(r"\.ow-window\.ow-focused .ow-controls \.ow-min\s*\{[^}]*#febc2e", CSS, re.S)
    # unfocused → neutral grey.
    assert re.search(r"\.ow-window:not\(\.ow-focused\) .ow-controls", CSS, re.S)
    # cluster to the left (order:-1) and the title centered.
    assert re.search(r"\.ow-controls\s*\{[^}]*order:\s*-1", CSS, re.S)
    assert re.search(r"\.ow-title\s*\{[^}]*left:\s*50%", CSS, re.S)


def test_maximize_control_removed_from_all_windows():
    # Owner ruling (#768): the inert maximize/zoom control is GONE from every kit window —
    # it only crowded the centered titlebar title at thin widths and was inert everywhere.
    # The kit must NOT create an .ow-max button, the maximizable opt, or the .ow-max-enabled
    # class. NB: the GREEN traffic light is back as the DOCK toggle (#709) — a real,
    # functional control gated to dockable windows — NOT a maximize button. So we assert the
    # maximize machinery is gone, but the green color is allowed (it's the dock dot now).
    win = _read("static", "js", "orwellWindow.js")
    assert "ow-max" not in win
    assert "maximizable" not in win
    assert "ow-max-enabled" not in win
    assert ".ow-max" not in CSS


def test_green_dock_light_always_rendered_greyed_when_not_dockable():
    # #709 + 2026-07-16 (Apple Genius rendered-parity, the traffic-light-cluster nit): the
    # GREEN macOS traffic light is the DOCK toggle, presented in the slot the removed
    # maximize/zoom light used to hold — a real, functional control (dock -> control-room
    # gadget, and back), NOT a maximize button, on dockable windows. Real macOS renders the
    # CONSTANT 3-light cluster with inert lights GREYED, never omitted — so the kit now
    # ALWAYS builds the .ow-dock button; on a non-dockable window it is disabled + greyed
    # (no empty slot, no omission), mirroring the yellow minimize light's own disabled
    # placeholder pattern.
    win = _read("static", "js", "orwellWindow.js")
    # the .ow-dock button is created UNCONDITIONALLY (not gated behind `if (this.o.dockable)`).
    # (the .ow-dock class may carry a trailing `tap-exempt` so the kit's coarse-pointer
    # sizing escapes the global 44px tap floor — mobile titlebar-control proportion fix.)
    assert re.search(r"className = 'ow-dock\b", win)
    # dockable branches to the functional toggle; non-dockable disables the placeholder.
    assert re.search(r"if \(this\.o\.dockable\)\s*\{[^}]*toggleDock", win, re.S)
    assert re.search(r"aria-label',\s*'Zoom \(unavailable\)'", win)
    assert re.search(r"else\s*\{[^}]*b\.disabled = true;", win, re.S)
    # green disc, focused, in the maximize slot (order 2, rightmost of the three lights).
    assert re.search(r"\.ow-window\.ow-focused .ow-controls \.ow-dock\s*\{[^}]*#28c840", CSS, re.S)
    assert re.search(r"\.ow-controls \.ow-dock\s*\{ order: 2", CSS)
    # styled as a 12px traffic-light disc alongside close + min (shares the disc rule).
    assert re.search(
        r"\.ow-controls \.ow-close,\s*body\.theme-frosted \.ow-controls \.ow-min,\s*"
        r"body\.theme-frosted \.ow-controls \.ow-dock \{[^}]*border-radius:\s*50%",
        CSS, re.S)
    # the dock GLYPH is a decorative ::before revealed on hover/focus of the cluster (the
    # same macOS hover-glyph mechanic as close/min), and flips dock↔float by docked state.
    assert re.search(r"\.ow-controls \.ow-dock::before\s*\{ content:", CSS, re.S)
    assert re.search(r"\.ow-window\.ow-docked\b[^{]*\.ow-controls \.ow-dock::before", CSS, re.S)
    assert re.search(r"\.ow-titlebar:hover .ow-controls \.ow-dock::before", CSS, re.S)
    # a11y: the dock toggle carries an aria-label, and the lights get a focus-visible ring.
    assert "aria-label" in re.search(r"className = 'ow-dock[^']*';(.*?)controls\.appendChild", win, re.S).group(1)
    assert re.search(r"\.ow-controls \.ow-dock:focus-visible \{[^}]*outline:", CSS, re.S)
    # the greyed/inert placeholder shares the SAME disabled-disc rule as the yellow light,
    # and the legacy (non-frosted) chrome hides it (that 3-light treatment is frosted-only).
    assert re.search(r"\.ow-controls \.ow-min\[disabled\],\s*body\.theme-frosted \.ow-controls \.ow-dock\[disabled\]", CSS, re.S)
    assert re.search(r"body:not\(\.theme-frosted\) \.ow-controls \.ow-dock\[disabled\] \{ display: none; \}", win)


def test_disabled_dock_light_stays_glyphless_on_hover():
    # CodeRabbit #1687: the titlebar-hover `::before` reveal sets the dock/min glyph color on
    # the pseudo-element directly, which beats the disabled button's own `color: transparent`
    # — so a non-dockable (or non-minimizable) window would flash an active-looking dock/undock
    # arrow when the titlebar is hovered. A suppression rule keeps any disabled disc glyphless
    # under hover/focus. Pin both themes' rules so a future hover-glyph edit can't silently
    # re-expose it.
    assert re.search(
        r"\.ow-titlebar:hover \.ow-controls \.ow-dock\[disabled\]::before[^{]*\{[^}]*"
        r"color:\s*transparent",
        CSS, re.S), "frosted: disabled dock disc must stay glyphless on titlebar hover"
    assert re.search(
        r"\.ow-controls button\[disabled\]:focus-visible::before[^{]*\{[^}]*color:\s*transparent",
        CSS, re.S), "a disabled disc must stay glyphless on focus-visible too"


def test_three_light_cluster_close_min_dock():
    # The cluster is close (red) + minimize (yellow) + dock/zoom (green) on EVERY window —
    # the constant macOS 3-light cluster (2026-07-16). The min AND dock buttons are both
    # built unconditionally so a closable-only, non-dockable window (e.g. Settings) still
    # shows red + greyed-yellow + greyed-green, never a lone red or a 2-light cluster — the
    # capability only gates enabled-ness, never presence.
    win = _read("static", "js", "orwellWindow.js")
    assert "const canMin = this.o.minimizable && !this._docked;" in win
    assert "if (!canMin) { b.disabled = true; }" in win
    # the disabled yellow AND green lights are greyed/inert (visible placeholders).
    assert re.search(r"\.ow-controls \.ow-min\[disabled\],\s*body\.theme-frosted \.ow-controls \.ow-dock\[disabled\]", CSS, re.S)
    # close + min + dock (green) keep their traffic-light order.
    assert re.search(r"\.ow-controls \.ow-close \{ order: 0", CSS)
    assert re.search(r"\.ow-controls \.ow-min   \{ order: 1", CSS)
    assert re.search(r"\.ow-controls \.ow-dock  \{ order: 2", CSS)


def test_compact_pin_is_monochrome_kit_control():
    # Owner ruling (#769 first-pass → #771 proper reskin): the Cast "Compact pin" control is
    # a FIRST-CLASS kit button — a MONOCHROME inline SVG (currentColor), NOT a full-color
    # emoji pushpin; it rides .ow-btn (the shared glass material) and styles on glass with the
    # kit's dark legible ink + a soft white hairline, no accent on the text. The exhaustive
    # state/markup gate lives in test_0771_compact_pin_kit.py; this keeps the headline contract
    # pinned alongside the rest of the glass kit.
    cast = _read("static", "js", "orwellCast.js")
    # the oc-pin button carries an inline SVG glyph (currentColor, kit language)…
    assert re.search(r'id="oc-pin"[^>]*>\s*<svg[^>]*stroke="currentColor"', cast)
    # …it is a first-class kit button (rides .ow-btn)…
    assert re.search(r'class="oc-pin ow-btn[^"]*"', cast)
    # …and NO full-color emoji pushpin glyph.
    assert "📌" not in cast
    # the .oc-pin button text is the kit's dark chrome ink (legible on glass), never an accent.
    pinblk = re.search(r"#orwell-cast \.oc-pin \{(.*?)\}", cast, re.S).group(1)
    assert "--accent" not in pinblk and "#16191f" in pinblk
    # on the frosted glass it carries the kit's soft white hairline (rgba(255,255,255,0.14)).
    assert re.search(
        r"body\.theme-frosted #orwell-cast[^{]*\.oc-pin[^{]*\{[^}]*rgba\(255,255,255,0\.14\)",
        cast, re.S)


def test_ios_toggle_blue_and_slider_green():
    assert "--ow-ios-blue" in CSS and "--ow-ios-green" in CSS
    # toggle ON = system blue (mirror iOS).
    assert re.search(r"\.toggle input:checked \+ \.slider[^{]*\{[^}]*--ow-ios-blue", CSS, re.S)
    # slider track = system green.
    assert re.search(r'input\[type="range"\]\s*\{[^}]*--ow-ios-green', CSS, re.S)


def test_titlebar_accessory_not_a_traffic_light():
    # a right-side accessory (settings Peek) is hosted outside .ow-controls.
    assert ".ow-titlebar-accessory" in CSS
    s = _read("static", "js", "settings.js")
    assert "ow-titlebar-accessory" in s


# ── 17. GLASS BUTTONS get the SVG refraction (#709 — kube.io demos it on pills) ──

def test_glass_button_variants_in_refraction_selector_set():
    # The high-emphasis glass button variants are refraction targets — the SAME
    # feImage→feDisplacementMap technique as the chrome surfaces. They live in the JS
    # SELECTORS list (kube.io demos the effect on pill buttons → the authentic look).
    # (#1653: .ow-btn-icon is NO LONGER here — it became a FLAT chrome button, excluded from
    # refraction via BTN_NO_REFRACT below, not a glass-refraction target.)
    sel_block = re.search(r"var SELECTORS = \[(.*?)\];", JS, re.S).group(1)
    for sel in (".ow-btn-prominent", ".ow-btn-secondary",
                ".ow-btn-group", ".ow-btn"):
        assert '"' + sel + '"' in sel_block, sel


def test_plain_and_solid_and_grouped_buttons_are_excluded_from_refraction():
    # Non-glass / opaque / glass-on-glass variants must NEVER refract:
    #   .ow-btn-plain            → borderless, no glass material
    #   .ow-btn-destructive-solid → opaque red plate (not translucent glass)
    #   .ow-btn-group > .ow-btn   → members ride the group's ONE backdrop sample
    assert "BTN_NO_REFRACT" in JS
    assert "isRefractableButton" in JS
    no_refract = re.search(r"var BTN_NO_REFRACT\s*=\s*\"([^\"]+)\"", JS).group(1)
    assert ".ow-btn-plain" in no_refract
    assert ".ow-btn-destructive-solid" in no_refract
    assert ".ow-btn-group > .ow-btn" in no_refract
    # #1653: the flat icon chrome button (backdrop-filter:none by design) is ALSO excluded —
    # it carries the base .ow-btn class the catch-all would otherwise collect + refract.
    assert ".ow-btn-icon" in no_refract
    # the exclusion guard is enforced on BOTH the collect and the apply paths.
    assert "if (!isRefractableButton(el)) continue;" in JS
    assert "if (!isRefractableButton(el)) { clearFrom(el); return; }" in JS


def test_button_refraction_applied_via_backdrop_filter_not_filter():
    # CRITICAL: the refraction must ride backdrop-filter (refracts the backdrop BEHIND
    # the button) — NEVER `filter:` (which would displace the button's own label/glyph).
    # The single apply path (applyTo) sets ONLY backdrop-filter; the module never sets a
    # plain `filter` on a live surface (the SVG `feImage`/`feColorMatrix` etc. are filter
    # PRIMITIVES inside the <filter>, not a CSS `filter:` on the element).
    assert 'setProperty("backdrop-filter"' in JS
    assert 'setProperty("-webkit-backdrop-filter"' in JS
    # no CSS `filter:` is ever assigned to a refracted element (only backdrop-filter is).
    assert "setProperty(\"filter\"" not in JS
    assert ".style.filter" not in JS


def test_glass_buttons_are_lowest_refraction_priority_after_chrome():
    # The cap fills from the top of SELECTORS; the big chrome panels must outrank the
    # buttons so a button-heavy view never starves the windows/sidebar/composer. The
    # button selectors are appended LAST (lowest priority → dropped first under the cap).
    sel_block = re.search(r"var SELECTORS = \[(.*?)\];", JS, re.S).group(1)
    chrome_first = sel_block.index('".ow-window"')
    btn_first = sel_block.index('".ow-btn-prominent"')
    assert chrome_first < btn_first, "buttons must rank below chrome in the cap order"
    # and the cap itself is unchanged (buttons share size buckets, so cost is per-size).
    assert "MAX_LIVE_SURFACES" in JS


def test_button_glass_css_backdrop_filter_is_overridable_no_important():
    # The Full-Glass inline `backdrop-filter: url(#…) !important` must win over the CSS
    # button-glass material — so the CSS .ow-btn backdrop-filter must NOT carry
    # !important (an inline !important only outranks a stylesheet rule WITHOUT one). Guard
    # the cascade: the .ow-btn base material declaration stays plain.
    blk = re.search(r"body\.theme-frosted \.ow-btn \{(.*?)\n\}", CSS, re.S).group(1)
    # only actual DECLARATION lines (the property starts the line), not comment prose.
    bf = [ln for ln in blk.splitlines()
          if re.match(r"\s*-?(webkit-)?backdrop-filter\s*:", ln)]
    assert bf, "the .ow-btn base must declare a CSS glass material (the fallback)"
    assert all("!important" not in ln for ln in bf), \
        "an !important on .ow-btn backdrop-filter would clobber the Full-Glass refraction"


def test_button_refraction_remount_watched():
    # buttons mount/unmount constantly (decision cards, menus); the mount observer must
    # schedule a refraction pass when a glass button appears.
    assert ".ow-btn" in JS  # covered above, but the mount-watch selector must include it
    mo = re.search(r"var sel = \"([^\"]*\.ow-btn[^\"]*)\";", JS)
    assert mo, "the watchMounts selector must include .ow-btn / .ow-btn-group"
