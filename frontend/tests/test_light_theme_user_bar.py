"""The sidebar user chip/footer rides the frosted MATERIAL's polarity (APP-OV-3).

History: the footer band was first a hardcoded dark chip (`rgba(14,16,22,.55)` + `#fff` ink —
wrong on light palettes), then a theme-token band (`var(--bg)` + `var(--fg)` ink). The
2026-07-14 theme audit (APP-OV-3, the §0 systemic polarity class) overturned the token band
too: the frosted material is a LIGHT surface REGARDLESS of theme tokens, so on the default
DARK theme the var(--bg) band rendered a DARK capsule with light ink sitting on the LIGHT
frosted sidebar — the exact polarity glitch the audit calls out. The durable rule (§0): an
element inside glass either composes the kit's material-fixed fills or it is a latent
wrong-polarity bug.

The fix mirrors how the kit surfaces do it: the footer chip paints the ONE light glass
(`var(--ow-glass-light-color)` — material-fixed white translucent, reads identically over any
theme/backdrop), and the username + account icons fall back to the sidebar's blanket DARK
chrome ink (#16191f + light halo). The chip still guarantees the AA backing the old band
existed for: white .60 stacked on the sidebar's .60 glass composites ≥ ~0.84 white even over
the darkest backdrop, so the dark ink clears 4.5:1 everywhere. Flat tier untouched (the rule
stays body.theme-frosted-scoped).

SOURCE pins (fast `fe-unit` lane, no browser) + a BROWSER gate (computed styles over the REAL
stylesheet with the light and dark token sets — proves the chip + ink render light-glass/dark-
ink on BOTH palettes). Roles only; Vault-free (chrome only).
"""

import functools
import http.server
import os
import re
import socketserver
import threading

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static")

with open(os.path.join(STATIC, "style.css"), encoding="utf-8") as _f:
    CSS = _f.read()


# ── source pins: the frosted sidebar footer/labels derive from theme tokens ───────────────


def test_frosted_user_bar_band_is_the_kit_light_glass():
    """APP-OV-3: the footer chip paints the kit's ONE light glass (material-fixed), never a
    theme-token band (which inverts polarity on the light frosted material) and never the
    original hardcoded dark chip."""
    m = re.search(r"body\.theme-frosted\s+#sidebar\s+\.sidebar-user-bar\s*\{[^}]*\}", CSS, re.S)
    assert m, "missing the frosted user-bar footer chip rule"
    body = m.group(0)
    assert "var(--ow-glass-light-color" in body, \
        "the user-bar chip must paint the kit light glass (var(--ow-glass-light-color)) — APP-OV-3"
    assert "color-mix(in srgb, var(--bg" not in body, \
        "the var(--bg) token band must not come back (dark capsule on the light frosted sidebar)"
    assert "rgba(14, 16, 22" not in body and "rgba(14,16,22" not in body, \
        "the hardcoded dark band (the light-theme 'dark chip' bug) must not come back"


def test_frosted_sidebar_label_ink_is_dark_chrome_ink():
    """APP-OV-5 (2026-07-15): the frosted #sidebar is a FIXED light-glass material
    (`background: var(--ow-glass-light-color)` — the ~.60 white kube fill, applied regardless of
    the theme tokens — style.css L20396/L20420), so its brand title + New-Chat label sit on light
    glass and MUST take the sidebar's blanket dark chrome ink (#16191f + a LIGHT halo), exactly
    like every other node under the `#sidebar *` rule and like the username on the footer chip.

    This SUPERSEDES the old "labels float on unbounded glass over dark game content ⇒ theme --fg"
    reasoning: the sidebar never goes dark on the dark theme (a fixed .60-white fill only lightens
    the backdrop), so the theme's LIGHT cool var(--fg) here rendered light-on-light — the owner's
    unreadable 'Orwell' wordmark + 'New Chat'. Measured (headless, real stylesheet): the brand
    surface is IDENTICAL on the light and dark token sets, so its polarity is theme-independent."""
    # Scope the match to the enclosing @media (prefers-reduced-transparency: no-preference)
    # block: an identical selector at top level or in the `reduce` branch must NOT satisfy this
    # test (the loose regex passed even when the rule sat outside the no-preference block).
    m = re.search(
        r"@media\s*\(\s*prefers-reduced-transparency:\s*no-preference\s*\)\s*\{\s*"
        r"body\.theme-frosted\s+#sidebar\s+\.sidebar-brand-title,\s*"
        r"body\.theme-frosted\s+#sidebar\s+#sidebar-new-chat-btn\s+\.grow\s*\{[^}]*\}",
        CSS, re.S)
    assert m, ("missing the frosted sidebar label ink rule (.sidebar-brand-title et al.) inside "
               "the @media (prefers-reduced-transparency: no-preference) block")
    body = m.group(0)
    assert "#16191f" in body, \
        "the label ink must be the sidebar's dark chrome ink (#16191f) on the light glass"
    assert "var(--fg" not in body, \
        "the theme's LIGHT cool var(--fg) is the light-on-light polarity bug this fix removes"
    assert "color: #fff" not in body, \
        "the hardcoded white ink (light-on-light on a light palette) must not come back"
    # the legibility halo must be a text-shadow DECLARATION using the LIGHT white rgba halo the
    # rest of the light-glass chrome uses — matched DIRECTLY (not "rgba token anywhere in body")
    # so a stray rgba elsewhere in the rule can't satisfy it, and the declaration must exist.
    halo = re.search(r"text-shadow\s*:\s*([^;}]+)", body)
    assert halo, "the label needs a text-shadow legibility halo declaration"
    halo = halo.group(1)
    assert "rgba(255,255,255" in halo or "rgba(255, 255, 255" in halo, \
        "the text-shadow must use the LIGHT white rgba halo the rest of the light-glass chrome uses"
    # RETAINED: a var(--bg)-derived DARK halo does nothing on the light surface (and smudges under
    # dark ink) — it must not come back.
    assert "var(--bg" not in halo, \
        "the old var(--bg)-derived DARK halo (invisible on light glass) must not come back"
    # APP-OV-3: no frosted rule may force the username back onto var(--fg) — light ink on the
    # light-glass chip is the polarity bug this fix removes.
    # `[^{}]*` (not `[^}]*`) in the body so an @media wrapper can't swallow its first nested
    # rule — each innermost rule pairs with its own selector even one level inside an at-rule.
    for sel, rule_body in re.findall(r"([^{}]+)\{([^{}]*)\}", CSS):
        if "#user-bar-name" in sel and "theme-frosted" in sel:
            assert "var(--fg" not in rule_body, (
                "a frosted rule flips #user-bar-name back to var(--fg) — on the light-glass "
                "footer chip the username must keep the sidebar's dark chrome ink (APP-OV-3)")


def test_user_bar_carries_no_other_hardcoded_background():
    """Belt-and-braces: no OTHER .sidebar-user-bar rule may (re)introduce a polarity-fixed
    background — every background it paints is transparent or token/material-derived."""
    for m in re.finditer(r"[^{}]*\.sidebar-user-bar[^{}]*\{[^{}]*\}", CSS, re.S):
        rule = m.group(0)
        for decl in re.findall(r"background(?:-color)?\s*:\s*([^;]+);", rule):
            v = decl.strip()
            assert v.startswith(("transparent", "var(", "color-mix(")), (
                f".sidebar-user-bar paints a hardcoded background {v!r} — use the kit material "
                "tokens (the light-theme dark-chip bug shape)")


# ── browser gate: rendered polarity is correct on BOTH themes ─────────────────────────────

_PORT = int(os.environ.get("ORWELL_USERBAR_PORT", "8799"))

#: Token sets copied from static/js/theme.js's THEMES map (same deliberate copy-as-trip-wire
#: rationale scripts/theme_consistency.py documents for its BASE_THEME_COLORS).
LIGHT = {"bg": "#f0ebe3", "fg": "#5a5248", "panel": "#faf6f0", "border": "#d4cdc2"}
GLASS_DARK = {"bg": "#15171c", "fg": "#eef1f4", "panel": "#1d2026", "border": "#3a3f47"}


def _chromium_path():
    from _chromium import chromium_path  # shared locator: sandbox paths, then Playwright's own install dir (CI)
    return chromium_path()


@pytest.fixture(scope="module")
def _static_server():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=STATIC)

    class _Q(socketserver.TCPServer):
        allow_reuse_address = True

    httpd = _Q(("127.0.0.1", _PORT), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{_PORT}"
    finally:
        httpd.shutdown()


# The REAL stylesheet over the real sidebar-footer DOM shape (index.html's
# .sidebar-user-bar cluster), body.theme-frosted like every default theme.
_HARNESS = """
<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/style.css">
</head><body class="theme-frosted">
  <div id="sidebar" class="sidebar">
    <div class="sidebar-header"><span class="sidebar-brand-title">Orwell</span></div>
    <div class="sidebar-user-bar" id="sidebar-user-bar">
      <div class="user-bar-left" id="user-bar-profile">
        <span class="user-bar-name" id="user-bar-name">User</span>
      </div>
    </div>
  </div>
</body></html>
"""

# Applies a theme token set (the same custom properties theme.js applyColors sets) and reads
# back the COMPUTED footer band + label inks, parsed to numeric rgba (handles both the
# rgb()/rgba() and color(srgb …) serializations of a resolved color-mix()).
_PROBE_JS = """
(tokens) => {
  const rs = document.documentElement.style;
  rs.setProperty('--bg', tokens.bg);
  rs.setProperty('--fg', tokens.fg);
  rs.setProperty('--panel', tokens.panel);
  rs.setProperty('--border', tokens.border);
  const parse = (s) => {
    let m = /^rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)$/.exec(s);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4], raw: s };
    m = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)$/.exec(s);
    if (m) return { r: 255 * +m[1], g: 255 * +m[2], b: 255 * +m[3],
                    a: m[4] === undefined ? 1 : +m[4], raw: s };
    return { raw: s };
  };
  return {
    band: parse(getComputedStyle(document.querySelector('.sidebar-user-bar')).backgroundColor),
    name: parse(getComputedStyle(document.getElementById('user-bar-name')).color),
    brand: parse(getComputedStyle(document.querySelector('.sidebar-brand-title')).color),
  };
}
"""


def _mean(c):
    assert "r" in c, f"unparseable computed color: {c.get('raw')!r}"
    return (c["r"] + c["g"] + c["b"]) / 3.0


def test_user_bar_polarity_follows_the_theme(_static_server):
    """APP-OV-3 / APP-OV-5: the frosted material is LIGHT regardless of theme tokens, so on BOTH
    token sets the footer chip renders as light glass and the username as dark chrome ink. The
    brand title takes the SAME dark chrome ink on both themes (APP-OV-5): the sidebar is a fixed
    .60-white glass panel that never goes dark on the dark theme, so its ink is theme-independent
    dark — it just lacks the username's double-glass backing chip. Rendered from the real
    stylesheet, so a reintroduced token-polarity band (the dark-capsule-on-light-sidebar glitch)
    or a light-cool var(--fg) label (light-on-light) fails here."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    base = _static_server
    with sync_playwright() as pw:
        exe = _chromium_path()
        try:
            browser = pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
        except Exception:
            pytest.skip("chromium unavailable")
        try:
            page = browser.new_page()
            page.goto(base + "/__h", wait_until="domcontentloaded")  # establish origin
            page.set_content(_HARNESS, wait_until="load")
            # the stylesheet is applied once the base rule's flex layout lands.
            page.wait_for_function(
                "() => getComputedStyle(document.querySelector('.sidebar-user-bar'))"
                ".display === 'flex'", timeout=10000)

            light = page.evaluate(_PROBE_JS, LIGHT)
            # the chip: the kit's ONE light glass — a translucent white wash.
            assert 0.30 <= light["band"]["a"] <= 0.85, \
                f"the chip should stay a translucent wash ({light['band']['raw']})"
            assert _mean(light["band"]) > 180, \
                f"LIGHT theme: the user-bar chip must render LIGHT glass ({light['band']['raw']})"
            # the ink: the sidebar's dark chrome ink on the light chip.
            assert _mean(light["name"]) < 128, \
                f"LIGHT theme: the username ink must render DARK ({light['name']['raw']})"
            assert _mean(light["brand"]) < 128, \
                f"LIGHT theme: the brand-title ink must render DARK ({light['brand']['raw']})"

            dark = page.evaluate(_PROBE_JS, GLASS_DARK)
            # APP-OV-3: the chip is MATERIAL-fixed — it stays light glass on the dark theme too
            # (the old var(--bg) band rendered a dark capsule on the light frosted sidebar).
            assert 0.30 <= dark["band"]["a"] <= 0.85, \
                f"the chip should stay a translucent wash ({dark['band']['raw']})"
            assert _mean(dark["band"]) > 180, \
                f"DARK glass theme: the user-bar chip must stay LIGHT glass ({dark['band']['raw']})"
            assert _mean(dark["name"]) < 128, \
                f"DARK glass theme: the username ink must be the DARK chrome ink ({dark['name']['raw']})"
            # APP-OV-5: the sidebar is a FIXED light-glass material (it never darkens on the dark
            # theme), so the brand title takes the same DARK chrome ink as the username + the rest
            # of the sidebar — a light-cool var(--fg) label here would be the light-on-light bug.
            # Pin the EXACT chrome ink #16191f == (22, 25, 31), not merely "dark" — a cascade
            # override to black or another dark hue would slip past a brightness-only mean check.
            assert (dark["brand"].get("r"), dark["brand"].get("g"), dark["brand"].get("b")) == (22, 25, 31), \
                f"DARK glass theme: the brand-title ink must be the DARK chrome ink ({dark['brand']['raw']})"
        finally:
            browser.close()
