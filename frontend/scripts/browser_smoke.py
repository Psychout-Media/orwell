#!/usr/bin/env python3
"""Feature 0032 — front-end BROWSER smoke (the headless-browser gate for Tier 3).

The server-side boot smoke (scripts/boot_smoke.py) proves routes are gated, but it cannot
catch a broken browser module graph: the keep-set chat UI (static/app.js, static/js/chat.js)
imports several dropped modules, so deleting a dropped file without also removing its import
would 404 that module and break the app *in the browser* while the server still serves HTML.

This loads the real page in headless chromium and fails if:
  - any /static/*.js request returns >= 400 (a deleted-but-still-imported module), or
  - any uncaught page error fires (a missing reference / syntax error), or
  - the keep-set UI (sidebar, chat container, composer) does not mount.

It is the gate that makes the Tier-3 deletion safe: it stays green only while the keep-set
loads cleanly. Engine-down API 404s (e.g. /api/orwell game state) are expected and ignored —
we only assert on static module loads, uncaught errors, and the keep-set DOM.

Run:  python3 scripts/browser_smoke.py   (needs `playwright install chromium`)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # frontend/
PY = os.environ.get("PYTHON", sys.executable)
PORT = int(os.environ.get("ORWELL_FE_BROWSER_PORT", "8195"))

_fails: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("  ok  — " if cond else "  FAIL — ") + label)
    if not cond:
        _fails.append(label)


# #737 — THE PLAYER-TIER SURFACE REGISTRY (part of the #660 'all UI into kits' epic).
# `tests/surface_registry.json` is the single manifest that enumerates every player-tier
# surface FAMILY and the kit / shared component it MUST compose. The SOURCE-side drift guard
# (tests/test_737_surface_registry.py) proves the manifest matches the JS *source*; this
# smoke consumes the SAME manifest at RUNTIME to generalize the F-3 window ratchet past
# windows (see the #737-runtime census below).
def _load_surface_registry() -> dict:
    with open(os.path.join(ROOT, "tests", "surface_registry.json"), encoding="utf-8") as fh:
        return json.load(fh)


def _surface_registry_arg() -> list[dict]:
    """The manifest, projected to the minimal fields the in-browser census needs:
    each family's id, its root CSS-family class (sans leading dot), its composition
    seam global (sans `window.`), and its kind (kit / component / css)."""
    reg = _load_surface_registry()
    return [
        {
            "id": f["id"],
            "cls": f["css_family"].lstrip("."),
            "seam": (f.get("seam") or "").replace("window.", ""),
            "kind": f["kind"],
        }
        for f in reg.get("families", [])
    ]


# L33/L34: `frosted` is now ON by default for every theme, which paints
# backdrop-filter glass on every panel/modal/window. That heavy GPU effect makes
# headless-chromium report stacked window chrome (e.g. a modal's minimize button)
# as not-visible/not-stable, destabilizing the z-order / focus / restore suites
# (G14/F8/G2) that are about WINDOW MECHANICS, not the cosmetic frost. So the
# smoke seeds an EXPLICIT frosted-off theme preference before the first paint —
# the L33 contract is "an explicit saved choice wins" — to keep those mechanics
# deterministic. The frosted DEFAULT itself is covered by the pytest source gate
# (tests/test_l32_l33_l34_theme_defaults.py).
_SEED_NO_FROST_THEME = (
    "try { localStorage.setItem('orwell-theme', JSON.stringify("
    "{ name: 'dark', frosted: false, colors: "
    "{ bg:'#282c34', fg:'#9cdef2', panel:'#111111', border:'#355a66', red:'#e06c75' } }"
    ")); } catch (e) {}"
)


def new_page(browser, **kw):
    """A page with a deterministic, frosted-OFF theme seeded before first paint
    (see _SEED_NO_FROST_THEME) so the window-mechanics suites are stable under
    headless backdrop-filter rendering."""
    page = browser.new_page(**kw)
    page.add_init_script(_SEED_NO_FROST_THEME)
    return page


def boot():
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    # M2-2 session find (the #1086 shared-`data/` class, layout edition): the 0064 layout
    # sync persists window park state SERVER-side (data/orwell_layout.json). A prior play
    # session — or a smoke run that died inside the G16 park phase — leaves the cast window
    # `minimized: true`, and then EVERY later local run mounts it parked and times out at
    # the G16 open (a self-reinforcing false negative; CI never sees it because its checkout
    # starts clean). The layout file is volatile presentation state, never precious — scrub
    # it so the run starts from the same state CI does. (The golden driver's
    # scrub_stale_state() is the same discipline for the canonical-session binding.)
    try:
        os.remove(os.path.join(ROOT, "data", "orwell_layout.json"))
    except FileNotFoundError:
        pass
    env = dict(os.environ, ORWELL_GAME_BUILD="1", AUTH_ENABLED="false", LOCALHOST_BYPASS="true",
               # 2026-07-11: pin the legacy soft enrichment policy — the smoke wires no model, and
               # strict (the prod default) would refuse the game creation it drives.
               ORWELL_ENRICHMENT_POLICY="soft")
    proc = subprocess.Popen(
        [PY, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=ROOT, env=env, stdout=open(f"/tmp/fe-browser-{PORT}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{PORT}"
    # 120s boot budget — a loaded self-hosted runner during a merge wave can take
    # well past 60s for uvicorn's first response (matches responsive_matrix.py / smoke.sh).
    for _ in range(120):
        if proc.poll() is not None:
            sys.exit(f"FAIL — uvicorn exited early; see /tmp/fe-browser-{PORT}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(1)
    proc.terminate()
    sys.exit("FAIL — server never became ready")


def main() -> int:
    proc, base = boot()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = new_page(browser)
            page_errors: list[str] = []
            bad_js: list[tuple] = []
            ok_js: list[str] = []

            page.on("pageerror", lambda e: page_errors.append(str(e)))

            def on_response(resp):
                url = resp.url.split("?")[0]
                if "/static/" in url and url.endswith(".js"):
                    (ok_js if resp.status < 400 else bad_js).append((resp.status, url.split("/static/")[-1]))

            page.on("response", on_response)

            page.goto(base + "/", wait_until="load", timeout=30000)
            page.wait_for_timeout(6000)  # let module graph + async init settle

            check(len(ok_js) > 50, f"keep-set JS modules load ({len(ok_js)} static .js, 200)")
            check(not bad_js, f"no broken/missing JS module (4xx: {sorted(set(bad_js))})")
            check(not page_errors, f"no uncaught page errors ({page_errors[:5]})")
            check(page.query_selector("#sidebar") is not None, "keep-set DOM: sidebar mounted")
            check(page.query_selector("#chat-container") is not None, "keep-set DOM: chat container mounted")
            check(page.query_selector("textarea") is not None, "keep-set DOM: composer mounted")

            # Liquid-glass refraction (kube.io SVG technique) must actually WIN the cascade.
            # The frosted CSS sets `backdrop-filter: blur(..) !important` on the same glass
            # surfaces, so liquidGlass.js must set its inline url(#filter) with `important`
            # priority — a plain inline style LOSES to a stylesheet !important and the whole
            # effect silently dies (computed backdrop shows blur(), never url(#owlg-*)). This
            # guards that regression on a real Chromium engine (where the module is active).
            # new_page() seeds frosted-OFF for stable window mechanics, and the refraction only
            # runs under body.theme-frosted — so TEMPORARILY enable frosted, verify, then restore
            # frosted-off (don't disturb the window-mechanics suites that follow).
            page.evaluate("() => document.body.classList.add('theme-frosted')")
            lg = {"supported": True, "tagged": 0, "withUrl": 0}
            for _ in range(12):  # poll ~2.6s: the apply pass runs on rAF after the class flips
                try:
                    page.evaluate("() => window.OrwellLiquidGlass && window.OrwellLiquidGlass.refresh && window.OrwellLiquidGlass.refresh()")
                except Exception:
                    pass
                page.wait_for_timeout(220)
                lg = page.evaluate("""() => {
                  const g = window.OrwellLiquidGlass || {};
                  if (!g.supported) return { supported: false };
                  const tagged = [...document.querySelectorAll('[data-liquid-glass]')];
                  const withUrl = tagged.filter(e => (getComputedStyle(e).backdropFilter || '').includes('url('));
                  return { supported: true, tagged: tagged.length, withUrl: withUrl.length };
                }""")
                if not lg.get("supported") or lg.get("tagged", 0) > 0:
                    break

            # LIGHT-ON-LIGHT GUARD (owner: "'Orwell Chat' is light-on-light... can we check for
            # that"). On the LIGHT glass chrome (the kube music-player fill, rgba(255,255,255,0.6)),
            # text MUST be dark ink or it's unreadable. Several controls (the chat title, the
            # composer textarea/placeholder, the input icons) set their OWN light --fg with higher
            # specificity than the blanket chrome dark-ink rule, which is exactly how the title +
            # chat bar regressed. Probe the computed text color of each on light-glass chrome and
            # assert it is DARK (relative luminance well below the light surface), so light-on-light
            # can't silently come back. theme-frosted is still applied here (added for the
            # refraction check above); we measure before restoring frosted-off.
            lol = page.evaluate(
                """() => {
                  // WCAG relative luminance from a computed `rgb(...)`/`rgba(...)` string.
                  const lum = (c) => {
                    const m = (c || '').match(/[\\d.]+/g);
                    if (!m || m.length < 3) return null;
                    const f = [m[0], m[1], m[2]].map(v => {
                      const s = (+v) / 255;
                      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
                    });
                    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
                  };
                  const probe = (sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return { sel, missing: true };
                    const cs = getComputedStyle(el);
                    return { sel, color: cs.color, lum: lum(cs.color) };
                  };
                  const bar = document.querySelector('.chat-input-bar');
                  const surfLum = bar ? lum(getComputedStyle(bar).backgroundColor) : null;
                  // open the model-picker popover so its rows are measurable on the light glass
                  // (#1638: the picker is an OrwellPopoverKit `.ow-popover` surface now — clicking
                  // the trigger body-appends it; the "Select Model" dropdown regressed
                  // light-on-light too). Closed again before this probe returns.
                  const _pickerBtn = document.getElementById('model-picker-btn');
                  if (_pickerBtn) _pickerBtn.click();

                  // #725 (kit-level): inner text on GLASS CHROME surfaces (gadget cards, settings
                  // rows) used to go light-on-light because inner nodes set their OWN var(--fg) /
                  // color-mix(--fg N%, …) at higher specificity than the blanket container dark-ink.
                  // The fix redefines --fg to dark ink WITHIN those surfaces (full + muted resolve
                  // dark). Mount a representative gadget card (with a FULL + a MUTED row + a value)
                  // and a settings/admin row, then probe their inner text so the regression can't
                  // silently return. (Removed at the end of the probe.)
                  const mk = (html) => { const d = document.createElement('div'); d.innerHTML = html;
                    const n = d.firstElementChild; document.body.appendChild(n); return n; };
                  const og = mk('<section class="og-card og-probe-lol" style="display:block">'+
                    '<div class="og-head"><span class="og-icon">🌙</span><span class="og-title">Night Status</span></div>'+
                    '<div class="og-body">'+
                      '<div class="ogp-full" style="color:var(--fg)">Awake: 6 houseguests</div>'+
                      '<div class="ogp-muted" style="color:color-mix(in srgb, var(--fg) 60%, var(--panel))">winding down</div>'+
                    '</div></section>');
                  const ad = mk('<div class="admin-card adm-probe-lol" style="display:block">'+
                    '<div class="adm-row" style="color:color-mix(in srgb, var(--fg) 70%, var(--panel))">Setting label</div>'+
                    '</div>');
                  // The gadget RAIL HEADER ("The House" title) sits OUTSIDE the cards in the
                  // TRANSPARENT rail container, so it is NOT covered by the card dark-ink scope.
                  // It regressed light-on-light (rgb(238,241,244) on the light glass). Mount a
                  // representative rail head + title and prove its computed ink is dark.
                  const rl = mk('<div class="gadget-rail rail-probe-lol" style="display:flex">'+
                    '<div class="gadget-rail-head">'+
                      '<span class="gadget-rail-title">The House</span>'+
                      '<button class="gadget-rail-close">×</button>'+
                    '</div></div>');
                  // #742 (window-kit titlebar): the OrwellWindow kit's titlebar (.ow-titlebar /
                  // .ow-title) + the cast/finale/new-season window headers sit OUTSIDE the .ow-body
                  // dark-ink scope, so they kept resolving to the THEME --fg / --red — LIGHT ink on
                  // the LIGHT glass titlebar (measured ~1.09:1). Mount a kit window through the real
                  // OrwellWindowKit seam and probe its title ink so the regression can't return.
                  // (#orwell-headshot is the deliberate OPAQUE exception — light title there is
                  // correct — and is NOT probed by this light-glass sweep.)
                  let _kitProbe = null;
                  try {
                    if (window.OrwellWindowKit && window.OrwellWindowKit.create) {
                      _kitProbe = window.OrwellWindowKit.create({
                        id: 'ow-titlebar-lol-probe', title: 'Titlebar Probe', slot: 'top-left',
                        content: '<div style="padding:6px">body</div>',
                      });
                      _kitProbe.open();
                    }
                  } catch (_) {}
                  const out = {
                    surfLum,
                    title: probe('.chat-meta-overlay #current-meta'),
                    metaCount: probe('.chat-meta-overlay .chat-meta-count'),
                    costBadge: probe('.chat-meta-overlay .session-cost-display'),
                    textarea: probe('.chat-input-bar textarea#message'),
                    icon: probe('.chat-input-bar .input-icon-btn'),
                    picker: probe('.model-picker-btn'),
                    pickerLabel: probe('.model-picker-btn #model-picker-label'),
                    menu: probe('.ow-popover .model-picker-list'),
                    // #725 gadget card + settings row (full + muted inner text on glass chrome):
                    gadgetTitle: probe('.og-probe-lol .og-title'),
                    gadgetFull: probe('.og-probe-lol .ogp-full'),
                    gadgetMuted: probe('.og-probe-lol .ogp-muted'),
                    settingsRow: probe('.adm-probe-lol .adm-row'),
                    // gadget RAIL HEADER (outside the card scope) — "The House" title + control:
                    railTitle: probe('.rail-probe-lol .gadget-rail-title'),
                    railClose: probe('.rail-probe-lol .gadget-rail-close'),
                    // #742 window-kit titlebar — dark ink on the light-glass titlebar:
                    kitTitle: probe('#ow-titlebar-lol-probe .ow-title'),
                  };
                  // DARK-INK CHROME must NOT carry the DARK glass legibility shadow (a dark
                  // shadow under dark text reads as a smudgy "drop shadow"). The dark
                  // --ow-glass-text-shadow is reserved for LIGHT text on glass (chat bubbles,
                  // the light-on-dark dock chips). Probe the textShadow of every dark-ink chrome
                  // body-copy surface and assert NONE uses the dark (rgba(0,0,0,…)) halo.
                  const tsProbe = (sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return { sel, missing: true };
                    return { sel, ts: getComputedStyle(el).textShadow };
                  };
                  out.darkInkShadows = [
                    // NB (#8/#9): '.rail-probe-lol .gadget-rail-title' was removed — the rail head is
                    // now LIGHT ink over the dark container, so its DARK legibility halo is CORRECT
                    // (the dark halo is the bug only under DARK ink, not light ink).
                    '.og-probe-lol .og-body',
                    '.adm-probe-lol', '#sidebar',
                    // #742/#725: the dark-ink window-kit titlebar must carry the LIGHT halo, never
                    // the dark --ow-glass-text-shadow (a dark shadow under dark ink = a smudge).
                    '#ow-titlebar-lol-probe .ow-titlebar', '#ow-titlebar-lol-probe .ow-title',
                  ].map(tsProbe).filter(p => {
                    if (p.missing) return false;
                    const ts = (p.ts || 'none').toLowerCase();
                    if (ts === 'none' || ts === '') return false;
                    // flag any DARK (rgb(0,0,0,…) / rgba(0,0,0,…)) shadow on dark-ink chrome
                    return /rgba?\\(\\s*0\\s*,\\s*0\\s*,\\s*0/.test(ts);
                  });
                  // generic sweep: EVERY visible text node on a glass-chrome surface must be dark
                  // ink on the light glass (catch any future inner element that re-lights itself).
                  const sweep = [];
                  document.querySelectorAll('.og-card, .admin-card').forEach((card) => {
                    if (getComputedStyle(card).display === 'none') return;
                    card.querySelectorAll('*').forEach((el) => {
                      if (!el.childNodes) return;
                      // <option>/<optgroup> render in the native select popup (a separate surface,
                      // not styleable cross-browser) — they are NOT on-glass chrome text.
                      if (/^(OPTION|OPTGROUP)$/.test(el.tagName)) return;
                      // Decorative COLOR samples (theme swatches / preview tiles / color dots/chips)
                      // carry an INTENTIONAL color, not readable body text — exclude them so the
                      // sweep flags only accidental light-on-light TEXT, the #725 failure mode.
                      if (/\\b(swatch|preview|color-dot|colour-dot|color-chip|colorpick)\\b/.test(el.className || '')) return;
                      const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
                      if (!hasText) return;
                      const cs = getComputedStyle(el);
                      const a = cs.color.match(/[\\d.]+/g);
                      // skip fully-transparent text (alpha 0) — nothing painted
                      if (a && a.length >= 4 && (+a[3]) === 0) return;
                      // A node painting its OWN non-transparent background is a FILLED control (a
                      // sanctioned CTA / selected pill / toggle) — light text on it is correct and
                      // NOT the light-on-light bug. The bug is text riding the LIGHT GLASS directly,
                      // i.e. an element whose own background is (near-)transparent. Skip filled ones.
                      const bg = (getComputedStyle(el).backgroundColor || '').match(/[\\d.]+/g);
                      const bgAlpha = bg && bg.length >= 4 ? (+bg[3]) : (bg ? 1 : 0);
                      if (bgAlpha > 0.5) return;
                      const L = lum(cs.color);
                      if (L != null && L >= 0.4) sweep.push({ tag: el.tagName, cls: el.className, color: cs.color, lum: L });
                    });
                  });
                  out.sweepLight = sweep;
                  // close the model-picker popover we opened above so it can't overlap / linger
                  // into the later smoke steps (they query `.ow-popover[role=menu]` for the sort
                  // menus; our role=dialog picker is separate, but tidy up regardless).
                  try { if (window.OrwellPopoverKit) window.OrwellPopoverKit.closeAll(); } catch (_) {}
                  og.remove(); ad.remove(); rl.remove();
                  try { if (_kitProbe) _kitProbe.destroy(); } catch (_) {}
                  try { const k = document.getElementById('ow-titlebar-lol-probe'); if (k) k.remove(); } catch (_) {}
                  return out;
                }"""
            )
            # The chrome text controls must be DARK ink (luminance < 0.4) on the light glass.
            # (A light surface measures high luminance; light text on it is the bug.)
            for _name in ("title", "metaCount", "costBadge", "textarea", "icon",
                          "picker", "pickerLabel", "menu",
                          # #725 kit-level: gadget card (title/full/muted) + settings row
                          "gadgetTitle", "gadgetFull", "gadgetMuted", "settingsRow",
                          # NB (#8/#9): the gadget RAIL HEADER ("The House" title + controls) is NOT
                          # in this dark-ink list anymore — the rail is a TRANSPARENT container over
                          # the DARK app, so dark ink rendered it BLACK-on-black / illegible (owner
                          # report). It now takes LIGHT --fg ink + a dark halo (like the dock chips /
                          # chat bubbles); its legibility is asserted separately below.
                          # #742 window-kit titlebar — the .ow-title over the light-glass titlebar
                          # must be dark ink (it was ~1.09:1 light-on-light before the #742 fix).
                          "kitTitle"):
                _p = lol.get(_name) or {}
                if _p.get("missing"):
                    continue  # element legitimately absent — nothing to mis-color
                _l = _p.get("lum")
                check(_l is not None and _l < 0.4,
                      f"no light-on-light: {_name} text is dark ink on the light glass "
                      f"(lum={_l}, color={_p.get('color')})")
            # #8/#9: the gadget RAIL HEADER ("The House") is over the DARK app (transparent
            # container), so it must be LIGHT, LEGIBLE ink — never the dark #16191f that rendered it
            # black-on-black. Assert the title + control are LIGHT (high luminance) under glass.
            for _rname in ("railTitle", "railClose"):
                _rp = lol.get(_rname) or {}
                if _rp.get("missing"):
                    continue
                _rl = _rp.get("lum")
                check(_rl is not None and _rl >= 0.4,
                      f"#8/#9: {_rname} is LIGHT, legible ink over the dark rail container "
                      f"(not black-on-black) (lum={_rl}, color={_rp.get('color')})")
            # generic sweep over every text node on glass chrome — nothing light-on-light.
            _sweep = lol.get("sweepLight") or []
            check(not _sweep,
                  f"no light-on-light: glass-chrome text nodes are all dark ink ({_sweep[:6]})")
            # NO smudgy "drop shadow": dark-ink chrome body copy must NOT carry the DARK glass
            # legibility halo (that dark shadow is reserved for LIGHT text — chat bubbles + the
            # light-on-dark dock chips). Any dark rgba(0,0,0,…) shadow on dark-ink chrome is the bug.
            _darkShadows = lol.get("darkInkShadows") or []
            check(not _darkShadows,
                  f"no smudgy drop-shadow: dark-ink chrome text carries no DARK text-shadow "
                  f"({_darkShadows[:4]})")

            # ── #744 — RECEIVED-TRANSCRIPT APCA LEGIBILITY FLOOR (ship-first) ───────────
            # The transcript IS the game (read for hours): EVERY received bubble (.msg-ai) must
            # clear a real perceptual contrast floor over ANY wallpaper, INCLUDING a busy/saturated
            # mid-tone (the worst case where a bare polarity flip alone can wash out). We seed
            # received bubbles, drop a BUSY MID-TONE wallpaper behind them, run the adaptive pass,
            # then MEASURE APCA(resolved-ink ↔ scrim-composited-surface) per bubble and assert it
            # clears the floor. theme-frosted is still applied here (added above); we measure before
            # restoring frosted-off.
            apca744 = page.evaluate(
                """() => {
                  const AG = window.OrwellAdaptiveGlass;
                  if (!AG || !AG.apcaContrast) return { missing: true };
                  // a busy/saturated mid-tone wallpaper — the documented worst case.
                  let wp = document.getElementById('__wp');
                  if (!wp) { wp = document.createElement('div'); wp.id = '__wp';
                    wp.style.cssText = 'position:fixed;inset:0;z-index:-1'; document.body.prepend(wp); }
                  wp.style.background =
                    'linear-gradient(115deg,#4a7a8c 0%,#caa45a 22%,#6b5b8a 44%,#8c5a4a 62%,'
                    + '#3a6b5b 80%,#9a8c5a 100%)';
                  // ensure the wallpaper actually composites behind the chat for the sampler
                  document.body.style.background = 'transparent';
                  document.documentElement.style.background = 'transparent';
                  // seed two received bubbles + a sent bubble + a code block in a received bubble.
                  let ch = document.getElementById('chat-history');
                  if (!ch) { ch = document.createElement('div'); ch.id = 'chat-history';
                    ch.style.cssText = 'position:absolute;top:60px;left:60px;right:60px;'; document.body.appendChild(ch); }
                  const made = [];
                  const mk = (cls, html) => { const m = document.createElement('div'); m.className = 'msg ' + cls;
                    m.dataset.s744 = '1'; m.innerHTML = '<div class="role">R</div><div class="body">' + html + '</div>';
                    ch.appendChild(m); made.push(m); return m; };
                  mk('msg-ai', 'The house is quiet but for the hum of the cameras tonight.');
                  mk('msg-user', 'I want an ally before the comp.');
                  mk('msg-ai', 'Here is the play:<pre><code>if (trust > threat) ok();</code></pre>then waits.');
                  return { seeded: made.length };
                }"""
            )
            if not apca744.get("missing"):
                # let the adaptive pass + debounce settle, force a refresh, re-measure.
                for _ in range(8):
                    try:
                        page.evaluate("() => window.OrwellAdaptiveGlass && window.OrwellAdaptiveGlass.refresh && window.OrwellAdaptiveGlass.refresh()")
                    except Exception:
                        pass
                    page.wait_for_timeout(180)
                    measured = page.evaluate(
                        """() => {
                          const AG = window.OrwellAdaptiveGlass;
                          const FLOOR = AG.APCA_FLOOR || 60;
                          const parse = s => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
                            const p = m[1].split(/[,\\/\\s]+/).filter(Boolean); return [parseInt(p[0]),parseInt(p[1]),parseInt(p[2])]; };
                          const bd = el => {
                            const wp = document.getElementById('__wp'); const cs = getComputedStyle(wp);
                            // approximate the sampled wallpaper colour by the mid stop (smoke heuristic);
                            // the live module samples per-pixel — here we just need an opaque mid backdrop.
                            return parse(cs.backgroundColor) || [123,113,124];
                          };
                          const out = [];
                          document.querySelectorAll('.msg-ai[data-s744]').forEach((el, i) => {
                            const cs = getComputedStyle(el);
                            const ink = parse(cs.color);
                            // the resolved scrim surface = the bubble's own (opaque-composited) fill colour:
                            // computed background-color already has --ai-scrim-alpha applied; composite it
                            // over the wallpaper to get the surface the ink truly sits on.
                            const fill = parse(cs.backgroundColor); const a = parseFloat(el.style.getPropertyValue('--ai-scrim-alpha')) || 0.46;
                            const wallp = bd(el);
                            const surface = AG.compositeOver(fill || [56,60,68], a, wallp);
                            const lc = Math.abs(AG.apcaContrast(ink || [255,255,255], surface));
                            const attrLc = parseInt(el.getAttribute('data-apca-lc') || '0', 10);
                            out.push({ i, ink, lc: Math.round(lc), attrLc, floor: FLOOR });
                          });
                          return out;
                        }"""
                    )
                    if measured and all(b.get("attrLc", 0) > 0 for b in measured):
                        break
                check(bool(measured) and len(measured) >= 2,
                      f"#744: received transcript bubbles are present to measure ({apca744})")
                # the module's own per-bubble APCA verdict (data-apca-lc, set during the resolve)
                # must clear the floor for EVERY received bubble over the busy mid-tone wallpaper.
                _below = [b for b in measured if b.get("attrLc", 0) < b.get("floor", 60)]
                check(not _below,
                      f"#744: EVERY received bubble clears the APCA floor (Lc>=60) over a busy "
                      f"mid-tone wallpaper — frost+scrim escalation guarantees it ({measured})")

                # ── #738 item #1 — the OTHER worst case: a BUSY/LIGHT wallpaper ──────────────
                # DoD: "worst-case wallpaper" — a busy MID-TONE is only half of it. A busy/LIGHT
                # backdrop drives the polarity the OTHER way (DARK ink + light frost); a bare
                # polarity flip over a bright, high-frequency wall is exactly where a received
                # bubble can wash out. Swap the wallpaper on the SAME seeded bubbles, re-run the
                # adaptive pass, and assert every received bubble STILL clears the floor.
                page.evaluate(
                    """() => {
                      const wp = document.getElementById('__wp');
                      if (wp) wp.style.background =
                        'linear-gradient(115deg,#eef0d6 0%,#f4dca8 20%,#dbe6f2 42%,#f2d8de 64%,'
                        + '#e0f0e4 82%,#f4ecd2 100%)';
                    }"""
                )
                # Assert on the module's own per-bubble APCA verdict (data-apca-lc), computed from
                # its REAL per-pixel canvas sampling of the wallpaper — the same value that drives the
                # rendered scrim. (An in-smoke "independent" recompute can't sample a CSS *gradient*
                # backdrop: getComputedStyle('#__wp').backgroundColor is transparent for a gradient, so
                # it would measure ink over a fictional black surface, not the real wallpaper. The
                # module's canvas sample is the trustworthy signal; test_0744 pins the polarity fallback.)
                measured_light = None
                for _ in range(8):
                    try:
                        page.evaluate("() => window.OrwellAdaptiveGlass && window.OrwellAdaptiveGlass.refresh && window.OrwellAdaptiveGlass.refresh()")
                    except Exception:
                        pass
                    page.wait_for_timeout(180)
                    measured_light = page.evaluate(
                        """() => {
                          const FLOOR = (window.OrwellAdaptiveGlass && window.OrwellAdaptiveGlass.APCA_FLOOR) || 60;
                          const out = [];
                          document.querySelectorAll('.msg-ai[data-s744]').forEach((el, i) => {
                            out.push({ i, ink: getComputedStyle(el).color,
                                       attrLc: parseInt(el.getAttribute('data-apca-lc') || '0', 10), floor: FLOOR });
                          });
                          return out;
                        }"""
                    )
                    if measured_light and all(b.get("attrLc", 0) > 0 for b in measured_light):
                        break
                _below_light = [b for b in (measured_light or []) if b.get("attrLc", 0) < b.get("floor", 60)]
                check(bool(measured_light) and len(measured_light) >= 2 and not _below_light,
                      f"#738-1: EVERY received bubble clears the APCA floor (Lc>=60) over a busy "
                      f"LIGHT wallpaper too — polarity flip + scrim floor guarantees it ({measured_light})")

                # teardown the seeded bubbles + restore the page background so later suites are clean.
                page.evaluate(
                    """() => {
                      document.querySelectorAll('[data-s744]').forEach(e => e.remove());
                      const wp = document.getElementById('__wp'); if (wp) wp.style.background = '';
                      document.body.style.background = ''; document.documentElement.style.background = '';
                    }"""
                )

            # ── F-CONTRAST-1 — SECONDARY (`--fg-muted`) TEXT FLOOR OVER GLASS ─────────────
            # #744 floors the RECEIVED-bubble text; F-CONTRAST-1 extends the SAME APCA escalation to
            # the muted secondary text (`--fg-muted`, de-facto #888) rendered over the fixed light
            # glass — captions / gadget rows / settings sub-labels. The chrome stands down under the
            # glass theme (fixed light glass), so the floor is applied ONCE at the token level:
            # resolveMutedInk() composites the 0.60 white fill over the sampled backdrop and promotes
            # the muted ink toward --fg until APCA clears MUTED_FLOOR. We prove the floor holds over a
            # SWEEP of backdrops (incl. the worst case: a dark backdrop showing through the glass,
            # where #888 alone fails badly). (theme-frosted is still applied here.)
            muted = page.evaluate(
                """() => {
                  const AG = window.OrwellAdaptiveGlass;
                  if (!AG || !AG.resolveMutedInk) return { missing: true };
                  const FLOOR = AG.MUTED_FLOOR || 45;
                  const GLASS = [255, 255, 255], A = 0.60;   // the ONE light glass fill (kube 0.60)
                  const fg = [22, 25, 31];                    // the glass-chrome dark ink (--fg default)
                  // a sweep from pure-black through mid-tones to pure-white backdrops-through-glass.
                  const backs = [[0,0,0],[24,26,30],[60,72,90],[120,110,130],[150,150,150],
                                 [190,180,160],[230,230,235],[255,255,255]];
                  const out = [];
                  for (const bg of backs) {
                    const m = AG.resolveMutedInk(bg, fg);
                    const surface = AG.compositeOver(GLASS, A, bg);
                    // independent re-measure of the RESOLVED ink against the SAME light-glass surface.
                    const lc = Math.abs(AG.apcaContrast(m.ink, surface));
                    out.push({ bg, ink: m.ink, lc: Math.round(lc), reportLc: Math.round(m.lc),
                               floored: m.floored, floor: FLOOR });
                  }
                  return { floor: FLOOR, results: out };
                }"""
            )
            if not muted.get("missing"):
                results = muted.get("results", [])
                floor = muted.get("floor", 45)
                check(len(results) >= 6,
                      f"F-CONTRAST-1: muted-ink floor was measured across a backdrop sweep ({muted})")
                _below_muted = [r for r in results if r.get("lc", 0) < floor]
                check(not _below_muted,
                      f"F-CONTRAST-1: the floored --fg-muted ink clears the APCA secondary-text floor "
                      f"(Lc>={floor}) over the light glass for EVERY backdrop — promoting toward --fg "
                      f"guarantees it ({results})")
                # the worst case (a DARK backdrop through the 0.60 fill) MUST have actually escalated:
                # base #888 fails there, so `floored` proves the escalation fired (not a vacuous pass).
                dark_case = results[0] if results else {}
                check(dark_case.get("floored") is True,
                      f"F-CONTRAST-1: a dark backdrop through the glass DID escalate --fg-muted past "
                      f"#888 (else #888's ~Lc 13 would have leaked) ({dark_case})")

            page.evaluate("() => document.body.classList.remove('theme-frosted')")  # restore frosted-off
            try:
                page.evaluate("() => window.OrwellLiquidGlass && window.OrwellLiquidGlass.refresh && window.OrwellLiquidGlass.refresh()")
            except Exception:
                pass
            # Only assert when the module is active (Chromium) AND it found a surface to refract.
            # When tagged>0, EVERY one must show url() in its computed backdrop: that proves the
            # inline SVG refraction beat the CSS `!important` blur (the exact regression this guards).
            if lg.get("supported") and lg.get("tagged", 0) > 0:
                check(lg.get("withUrl", 0) == lg.get("tagged", 0),
                      f"liquid-glass refraction wins the cascade (computed backdrop = url(#filter), not clobbered by the !important blur) ({lg})")

            # Final FE batch: V3 phase labels + A3 delta announcer live in the status HUD.
            hud_a11y = page.evaluate("""() => {
              if (window._orwellStatusEnsure) window._orwellStatusEnsure();
              const el = document.getElementById('orwell-status');
              if (!el) return { ok: false };
              const a = el.querySelector('#os-announce');
              return { announcer: !!a, polite: a && a.getAttribute('aria-live') === 'polite',
                       hiddenVisually: a && a.offsetWidth <= 1 };
            }""")
            check(hud_a11y.get("announcer") is True and hud_a11y.get("polite") is True,
                  f"status HUD has a polite delta announcer ({hud_a11y})")
            # F-A11Y-1 (#1270): the narrator streams token-by-token into #chat-history, so it must
            # NOT be a polite live region (that re-announces every half-formed fragment). It carries
            # aria-live="off" (role="log" kept); completed replies are announced ONCE per round into
            # the dedicated visually-hidden #a11y-announcer polite/atomic region. Mirrors the pytest
            # gate test_hig_a11y_p1.py; this browser-smoke assertion was left stale by #1270.
            chat_a11y = page.evaluate("""() => {
              const log = document.getElementById('chat-history');
              const ann = document.getElementById('a11y-announcer');
              return { logLive: log && log.getAttribute('aria-live'),
                       hasAnnouncer: !!ann,
                       announcerPolite: ann && ann.getAttribute('aria-live') === 'polite',
                       announcerAtomic: ann && ann.getAttribute('aria-atomic') === 'true' };
            }""")
            check(chat_a11y.get("logLive") == "off",
                  f"chat log is NOT a flooding live region — #chat-history is aria-live=off ({chat_a11y})")
            check(chat_a11y.get("hasAnnouncer") is True and chat_a11y.get("announcerPolite") is True
                  and chat_a11y.get("announcerAtomic") is True,
                  f"a dedicated polite/atomic #a11y-announcer carries the once-per-round narration ({chat_a11y})")

            # C27: the game build ships no third-party CDN deps (KaTeX/Mermaid — no math or
            # diagrams in BB) and no workspace tour. Asserted on the SERVED page.
            served = page.content()
            check("cdn.jsdelivr.net" not in served, "game build: no jsdelivr CDN dependency")
            check("tourHints.js" not in served and "tourAutoplay.js" not in served,
                  "game build: workspace tour not shipped")

            # C23/C15: the game build marks the body, and the engine-down landing is a DARK
            # HOUSE holding card (game-framed), never the silent generic-workspace welcome.
            # (The smoke runs with the engine down, so this is the real F5 path.)
            gb_flag = page.evaluate("document.body.hasAttribute('data-game-build')")
            check(gb_flag is True, "game build marks <body data-game-build>")
            page.wait_for_timeout(1500)  # onboarding's route() resolves its probes
            holding = page.evaluate("""() => {
              const el = document.getElementById('orwell-onboarding');
              if (!el) return { mounted: false };
              return { mounted: true, dark: (el.textContent || '').includes('The house is dark') };
            }""")
            check(holding.get("mounted") is True, f"engine-down: holding card mounts ({holding})")
            check(holding.get("dark") is True, "engine-down: it's the dark-house card, not the form")
            tip_ok = page.evaluate("""() => {
              const t = (document.getElementById('welcome-tip') || {}).textContent || '';
              return !/compare mode|web search and code/i.test(t);
            }""")
            check(tip_ok is True, "welcome tip never names a dropped vertical")
            # No-trap invariant: a blocking holding card must be escapable by a REAL user
            # action (this smoke once force-removed it via JS to proceed — the same deadlock
            # a real operator hit on a fresh install). Dismiss it like a person would.
            has_out = page.evaluate(
                "!!document.querySelector('#orwell-onboarding [data-ob-dismiss]')")
            check(has_out is True, "holding card carries an explicit way out (dismiss button)")
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            escaped = page.evaluate("""() => ({
              gone: !document.getElementById('orwell-onboarding'),
              inertLeft: document.querySelectorAll('[inert]').length,
              // #925: the modal's backdrop scrim must go with the window. A lingering
              // [data-ow-scrim] is a full-viewport pointer-event sink that makes the
              // gear/menus unclickable (the orphan-scrim lockup).
              scrimsLeft: document.querySelectorAll('[data-ow-scrim]').length
            })""")
            check(escaped.get("gone") is True, "Escape dismisses the holding card")
            check(escaped.get("inertLeft") == 0, "dismissal un-inerts the page behind it")
            check(escaped.get("scrimsLeft") == 0, "#925: dismissal leaves no orphaned modal scrim")

            # 0050: character creation lives in the CHAT — onboarding never mounts a
            # data-entry form (the holding card is the only modal, and it has no inputs).
            page.evaluate("window._orwellOnboardingMount && window._orwellOnboardingMount()")
            page.wait_for_selector("#orwell-onboarding", timeout=3000)
            no_form = page.evaluate("""() => {
              const el = document.getElementById('orwell-onboarding');
              return el.querySelectorAll('input, select, textarea, form').length === 0;
            }""")
            check(no_form is True, "onboarding mounts NO data-entry form (the interview owns intake)")
            # Dismiss via the card's own button (the second real way out, alongside Escape).
            page.click("#orwell-onboarding [data-ob-dismiss]")
            page.wait_for_timeout(200)
            btn_out = page.evaluate("""() => ({
              gone: !document.getElementById('orwell-onboarding'),
              inertLeft: document.querySelectorAll('[inert]').length
            })""")
            check(btn_out.get("gone") is True, "dismiss button removes the holding card")
            check(btn_out.get("inertLeft") == 0, "no inert residue after button dismissal")

            # SEND-PATH RUNTIME GUARD (regression: #314 broke sending — chat.js called isGameBuild()
            # without importing it, so handleChatSubmit threw `ReferenceError: isGameBuild is not
            # defined` while building the optimistic placeholder bubble — BEFORE the chat POST fired;
            # the player could not send ANY message in the game build. Load-time error capture missed
            # it because the throw is in the SUBMIT path, never exercised by the smoke before.) We now
            # actually SUBMIT and assert the handler ran CLEAN: no new uncaught ReferenceError. (We do
            # NOT assert a chat POST fires — the smoke configures no LLM endpoint, so the handler
            # legitimately stops short of the fetch; the throw, if present, lands BEFORE that point.)
            errs_before = len(page_errors)
            page.fill("#message", "Smoke send-path check — does this submit cleanly?")
            page.wait_for_timeout(250)
            page.click(".send-btn")
            page.wait_for_timeout(1500)
            new_ref_errs = [e for e in page_errors[errs_before:] if "is not defined" in e or "ReferenceError" in e]
            check(not new_ref_errs, f"send path: submit runs with no ReferenceError ({new_ref_errs[:3]})")

            # THINKING / PUBLIC SPLIT (P1, owner ruling 2026-06-20): the model's reasoning must be
            # CLEANLY SEPARATED from the public bubble — never mixed in. Reasoning renders in a
            # condensed, DEFAULT-COLLAPSED "Thinking" accordion (debug-viewable, expandable); the
            # PUBLIC reply carries ONLY the in-character narration (no reasoning/draft/"rewind", no
            # engine lever names). Drive the real render chokepoint (markdown.js processWithThinking
            # — every reload + final-render path funnels through it) with a reply that carries a
            # <think> block naming engine levers, then assert at the DOM level. No LLM needed.
            think_probe = page.evaluate(
                """async () => {
                  const m = await import('/static/js/markdown.js');
                  const raw = '<think>Let me rewind that. I should call whereabouts and npcVoice, then a '
                    + 'social read via getGameState before narrating.</think>\\n\\nThe living room hums with tension.';
                  const host = document.createElement('div');
                  host.innerHTML = m.processWithThinking(raw);
                  document.body.appendChild(host);
                  // The PUBLIC reply = everything OUTSIDE the thinking accordion.
                  const accordions = [...host.querySelectorAll('.thinking-section')];
                  const accordionTxt = accordions.map(a => a.textContent || '').join(' ');
                  const clone = host.cloneNode(true);
                  clone.querySelectorAll('.thinking-section').forEach(a => a.remove());
                  const publicTxt = (clone.textContent || '');
                  // collapsed-by-default = no `.thinking-content.expanded` at render time.
                  const contents = [...host.querySelectorAll('.thinking-content')];
                  const out = {
                    showsAccordion: !!(m.gameBuildShowsThinkingAccordion && m.gameBuildShowsThinkingAccordion()),
                    scrubsReply: !!(m.gameBuildSuppressesThinking && m.gameBuildSuppressesThinking()),
                    accordions: accordions.length,
                    accordionHoldsReasoning: /whereabouts|npcVoice|getGameState/i.test(accordionTxt),
                    leversInPublicBubble: /whereabouts|npcVoice|getGameState|rewind/i.test(publicTxt),
                    replyKept: /living room/i.test(publicTxt),
                    expandedByDefault: contents.some(c => c.classList.contains('expanded')),
                  };
                  host.remove();
                  return out;
                }"""
            )
            check(think_probe.get("showsAccordion") is True,
                  f"game build shows the reasoning accordion by default ({think_probe})")
            check(think_probe.get("scrubsReply") is True,
                  f"game build scrubs reasoning out of the public reply ({think_probe})")
            check(think_probe.get("accordions") == 1,
                  f"game build: reasoning renders in exactly one accordion ({think_probe})")
            check(think_probe.get("accordionHoldsReasoning") is True,
                  f"game build: the accordion holds the reasoning ({think_probe})")
            check(think_probe.get("leversInPublicBubble") is False,
                  f"game build: NO reasoning/lever/'rewind' text in the public bubble ({think_probe})")
            check(think_probe.get("replyKept") is True,
                  f"game build: the in-character reply still renders in the bubble ({think_probe})")
            check(think_probe.get("expandedByDefault") is False,
                  f"game build: the thinking accordion is collapsed by default ({think_probe})")

            # L36 — the player's OUT-OF-CHARACTER aside channel. Drive the real bubble
            # renderer (chatRenderer.addMessage, the same path the live send + reload
            # both funnel through) with an OOC line, a normal line, and an `ooc:`-prefixed
            # line, then assert the produced DOM: the OOC bubbles carry the distinct
            # .msg-ooc class with the markers STRIPPED from the display text; the normal
            # bubble does NOT. No engine/LLM needed — pure render.
            ooc_probe = page.evaluate(
                """async () => {
                  const cr = await import('/static/js/chatRenderer.js');
                  const host = document.getElementById('chat-history');
                  const before = host.querySelectorAll('.msg-user').length;
                  cr.addMessage('user', '((what time is it in-game?))');
                  cr.addMessage('user', 'Hey, want to work together this week?');
                  cr.addMessage('user', 'ooc: what are my options?');
                  const bubbles = Array.prototype.slice.call(
                    host.querySelectorAll('.msg-user')).slice(before);
                  const rows = bubbles.map(b => ({
                    ooc: b.classList.contains('msg-ooc'),
                    text: (b.querySelector('.body') || {}).textContent || '',
                  }));
                  // the distinct production badge shows on an OOC bubble's role line
                  const badged = bubbles[0] &&
                    getComputedStyle(bubbles[0].querySelector('.role'), '::after')
                      .content.indexOf('production') !== -1;
                  return { rows: rows, badged: badged };
                }"""
            )
            _rows = ooc_probe.get("rows") or []
            check(len(_rows) == 3, f"L36: three user bubbles rendered ({ooc_probe})")
            check(_rows and _rows[0]["ooc"] is True and "(((" not in _rows[0]["text"]
                  and "what time is it in-game?" in _rows[0]["text"],
                  f"L36: ((...)) aside is .msg-ooc with markers stripped ({_rows[:1]})")
            check(len(_rows) > 1 and _rows[1]["ooc"] is False,
                  f"L36: a normal in-character line is NOT styled as an aside ({_rows[1:2]})")
            check(len(_rows) > 2 and _rows[2]["ooc"] is True
                  and _rows[2]["text"].strip().startswith("what are my options"),
                  f"L36: an `ooc:` aside is .msg-ooc with the prefix stripped ({_rows[2:3]})")
            check(ooc_probe.get("badged") is True,
                  f"L36: the OOC bubble carries the 'to production' badge ({ooc_probe})")
            # The old one-time OOC composer TIP is GONE. The reusable chat-bar hint
            # surface (orwellChatHint.js) is present but ships with ZERO active tips,
            # so nothing renders by default — and register()+show() is the one-entry
            # enable path. (The ((...))/ooc: INPUT detection above is unchanged.)
            hint_state = page.evaluate(
                """() => {
                  const old = document.getElementById('orwell-ooc-hint');
                  const api = window.OrwellChatHint;
                  const nothingUp = !document.getElementById('orwell-chat-hint');
                  // an unknown key never renders (the empty registry)
                  const unknownNoop = !!api && api.show('does-not-exist') === false;
                  return {
                    oldTipGone: !old,
                    apiPresent: !!(api && api.register && api.show && api.hide),
                    nothingUp: nothingUp,
                    unknownNoop: unknownNoop,
                  };
                }"""
            )
            check(hint_state.get("oldTipGone") is True,
                  f"the old OOC composer tip is removed ({hint_state})")
            check(hint_state.get("apiPresent") is True,
                  f"the shared chat-hint API is wired ({hint_state})")
            check(hint_state.get("nothingUp") is True and hint_state.get("unknownNoop") is True,
                  f"the chat-hint system ships with no active tips ({hint_state})")

            # C31/S5: the System Danger Zone only offers wipes for data the game build has.
            # ORW-161: the Settings DOM is lazy-mounted (an inert <template> stamped on first open), so open Settings the way a player does before looking inside it.
            page.evaluate("() => { const g = document.getElementById('user-bar-settings'); if (g) g.click(); }")
            page.wait_for_selector('button[data-wipe-kind="chats"]', state="attached", timeout=10000)
            wipes = page.evaluate("""() => {
              const vis = (k) => {
                const b = document.querySelector(`button[data-wipe-kind="${k}"]`);
                if (!b || !b.parentElement) return null;
                return getComputedStyle(b.parentElement).display !== 'none';
              };
              return { chats: vis('chats'), memory: vis('memory'), notes: vis('notes'), gallery: vis('gallery') };
            }""")
            check(wipes.get("chats") is True, f"system wipe: chats (live data) stays ({wipes})")
            check(wipes.get("memory") is False and wipes.get("notes") is False and wipes.get("gallery") is False,
                  f"system wipe: dropped verticals hidden under the game build ({wipes})")

            # C20: the confirm-on-binding decision guardrail. Dispatch a synthetic pending
            # (exactly what chat.js emits from an advanceGame result) and assert the card
            # renders the engine's prompt + legal options, enforces the pick count, and only
            # arms Confirm at exactly N selected. No engine needed — pure module behavior.
            page.evaluate("""
              window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: {
                kind: 'nominations', pick: 2,
                prompt: 'Name two houseguests for eviction.',
                options: [ {id:'npc:1',name:'A'}, {id:'npc:2',name:'B'}, {id:'npc:3',name:'C'} ],
              }}}));
            """)
            page.wait_for_selector("#orwell-decision-card", timeout=3000)
            opts = page.query_selector_all("#orwell-decision-card .odec-opt")
            check(len(opts) == 3, f"decision card renders the engine's legal options ({len(opts)})")
            confirm_disabled = page.evaluate("document.querySelector('#orwell-decision-card .odec-confirm').disabled")
            check(confirm_disabled is True, "decision card: Confirm disarmed until the pick count is met")
            opts[0].click()
            confirm_disabled = page.evaluate("document.querySelector('#orwell-decision-card .odec-confirm').disabled")
            check(confirm_disabled is True, "decision card: 1 of 2 selected still disarmed")
            opts[1].click()
            confirm_disabled = page.evaluate("document.querySelector('#orwell-decision-card .odec-confirm').disabled")
            check(confirm_disabled is False, "decision card: exactly 2 selected arms Confirm")
            opts[2].click()  # pick-count cap: a third selection is refused
            n_sel = page.evaluate('document.querySelectorAll(`#orwell-decision-card .odec-opt[aria-pressed="true"]`).length')
            check(n_sel == 2, "decision card: pick count capped at 2")
            page.evaluate("document.querySelector('#orwell-decision-card .odec-x').click()")
            check(page.query_selector("#orwell-decision-card") is None, "decision card: dismissible (prose path stays open)")

            # M1-4 (audit A4): a comp-round card with the STRUCTURED roster must render the roster
            # ONCE (the prompt's templated "Still in with you: …" sentence elides; the rest of the
            # prompt survives), and the disabled-Confirm hint must be fully visible inside the
            # card (the old -.2rem margin half-clipped its descenders at the bottom edge).
            page.evaluate("""
              window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: {
                kind: 'comp-round', intents: ['compete','throw','play-safe'], round: 1, binding: true,
                prompt: 'Set your approach to this competition: compete, throw (drop out), or play it safe. Still in with you: A, B, C, D, E, F, G, H, I, J, K, L, M, N, O. This locks in how you play the comp.',
                stillIn: [ {id:'npc:1',name:'A'}, {id:'npc:2',name:'B'}, {id:'npc:3',name:'C'} ],
              }}}));
            """)
            page.wait_for_selector("#orwell-decision-card .odec-stillin", timeout=3000)
            dedup = page.evaluate("""() => {
              const card = document.getElementById('orwell-decision-card');
              const prompt = (card.querySelector('.odec-prompt') || {}).textContent || '';
              const still = (card.querySelector('.odec-stillin') || {}).textContent || '';
              const hint = card.querySelector('.odec-hint');
              const cr = card.getBoundingClientRect();
              const hr = hint ? hint.getBoundingClientRect() : null;
              return {
                promptHasRoster: /Still in with you:/i.test(prompt),
                promptKeptRest: /Set your approach/.test(prompt) && /locks in how you play/.test(prompt),
                stillinOnce: /Still in:/.test(still),
                hintVisible: !!hr && hr.bottom <= cr.bottom + 0.5 && hr.height > 6,
              };
            }""")
            check(dedup.get("promptHasRoster") is False,
                  f"M1-4: the prompt's templated roster sentence elides when stillIn renders ({dedup})")
            check(dedup.get("promptKeptRest") is True,
                  f"M1-4: the rest of the engine prompt survives the elide ({dedup})")
            check(dedup.get("stillinOnce") is True,
                  f"M1-4: the structured roster renders (the ONE roster) ({dedup})")
            check(dedup.get("hintVisible") is True,
                  f"M1-4: the disabled-Confirm hint sits fully inside the card ({dedup})")
            page.evaluate("document.querySelector('#orwell-decision-card .odec-x').click()")

            # C25/A11Y-1: the holding card is a REAL modal — focus lands on the card,
            # Tab never escapes it, everything behind the scrim inert.
            page.evaluate("window._orwellOnboardingMount && window._orwellOnboardingMount()")
            page.wait_for_selector("#orwell-onboarding", timeout=3000)
            in_card = page.evaluate(
                "document.getElementById('orwell-onboarding').contains(document.activeElement)")
            check(in_card is True, "onboarding: initial focus lands in the card")
            for _ in range(12):  # tab hard — focus must stay inside the modal, never escape
                page.keyboard.press("Tab")
            trapped = page.evaluate(
                "document.getElementById('orwell-onboarding').contains(document.activeElement)")
            check(trapped is True, "onboarding: Tab stays INSIDE the card (focus trap)")
            sidebar_inert = page.evaluate("(document.getElementById('sidebar')||{}).inert === true "
                                          "|| document.querySelector('#sidebar') === null "
                                          "|| !!document.querySelector('#sidebar').closest('[inert]')")
            check(sidebar_inert is True, "onboarding: background is inert while mounted")

            # #870: modal-OVER-modal — opening a 2nd modal while onboarding is up must make the
            # 2nd the interactive TOP with the 1st inert beneath (it was a P1 lockup: the two
            # scrims shared a z and each inerted the other). Open a 2nd kit modal directly over
            # onboarding and assert the stack invariants, then close it and assert the 1st restores.
            stack2 = page.evaluate("""() => {
              const onb = document.getElementById('orwell-onboarding');
              const body = document.createElement('div');
              const inp = document.createElement('input'); inp.id = 'ob870-input';
              body.appendChild(inp);
              const w = window.OrwellWindowKit.create({
                id: 'ob870-second', title: 'Second modal', modal: true,
                minimizable: false, closable: true, draggable: false, resizable: false,
                persistLayout: false, content: body });
              w.open(document.querySelector('#orwell-onboarding [data-ob-choose-models]') || onb);
              window.__ob870 = w;
              const second = document.getElementById('ob870-second');
              const zEl = (el) => parseInt(getComputedStyle(el).zIndex, 10) || 0;
              const onbScrim = document.querySelector('.ow-scrim[data-ow-scrim="orwell-onboarding"]');
              const secScrim = document.querySelector('.ow-scrim[data-ow-scrim="ob870-second"]');
              return {
                bothMounted: !!(onb && second),
                // the 2nd modal is strictly above the 1st: its window tops the 1st window, its
                // scrim tops the 1st scrim (so its dim covers the lower modal), and its window
                // sits above its own scrim — no shared/colliding z (the #870 lockup).
                secondAboveFirst: !!(secScrim && onbScrim)
                  && zEl(second) > zEl(onb)
                  && zEl(secScrim) > zEl(onbScrim)
                  && zEl(second) > zEl(secScrim),
                // only the TOP modal is interactive: the 1st (lower) is inert, the 2nd is not
                firstInert: onb.inert === true || !!onb.closest('[inert]'),
                secondLive: second.inert !== true && !second.closest('[inert]'),
              };
            }""")
            check(stack2.get("bothMounted") is True, f"modal-stack: both modals mounted ({stack2})")
            check(stack2.get("secondAboveFirst") is True, "modal-stack: 2nd modal + scrim strictly above the 1st")
            check(stack2.get("firstInert") is True, "modal-stack: the 1st (lower) modal is inert beneath")
            check(stack2.get("secondLive") is True, "modal-stack: the 2nd (top) modal is interactive")
            # the top modal's own input is reachable/focusable (not blocked by the lower modal's scrim)
            page.evaluate("document.getElementById('ob870-input').focus()")
            top_focusable = page.evaluate("document.activeElement && document.activeElement.id === 'ob870-input'")
            check(top_focusable is True, "modal-stack: the top modal's controls are interactive")
            # close the 2nd → the 1st restores as the live, interactive top (un-inerted), no orphan scrim
            page.evaluate("window.__ob870.close()")
            page.wait_for_function("() => !document.getElementById('ob870-second') "
                                   "&& !document.querySelector('.ow-scrim[data-ow-scrim=\\\"ob870-second\\\"]')",
                                   timeout=3000)
            restored = page.evaluate("""() => {
              const onb = document.getElementById('orwell-onboarding');
              return {
                firstStillUp: !!onb,
                firstNowLive: !!onb && onb.inert !== true && !onb.closest('[inert]'),
                firstScrimUp: !!document.querySelector('.ow-scrim[data-ow-scrim="orwell-onboarding"]'),
              };
            }""")
            check(restored.get("firstStillUp") is True, "modal-stack: closing the 2nd leaves the 1st up")
            check(restored.get("firstNowLive") is True, "modal-stack: the 1st modal is interactive again after the 2nd closes")
            check(restored.get("firstScrimUp") is True, "modal-stack: the 1st modal keeps its own scrim")

            # #709: the onboarding modal is now a KIT window — it owns a separate .ow-scrim sibling +
            # the inert background. Dismiss it the real way (its own dismiss button → kit destroy),
            # which removes the window AND its scrim AND un-inerts — never a force `.remove()` (that
            # orphaned the scrim, which then intercepted every click below).
            page.click("#orwell-onboarding [data-ob-dismiss]")
            page.wait_for_function("() => !document.getElementById('orwell-onboarding') "
                                   "&& !document.querySelector('.ow-scrim') "
                                   "&& document.querySelectorAll('[inert]').length === 0",
                                   timeout=3000)

            # C25/E88: the Diary Room is a composer mode in the chat (no dialog) — ruling #4.
            page.evaluate("window._orwellOpenDiaryRoom && window._orwellOpenDiaryRoom()")
            # E88 (ruling #4): no floating dialog — the composer enters DR mode.
            check(page.evaluate("!document.getElementById('orwell-dr-modal')") is True,
                  "diary room: no floating dialog exists")
            check(page.evaluate("window._orwellDiaryRoomActive && window._orwellDiaryRoomActive()") is True,
                  "diary room: composer mode engages via the seam")
            check(page.evaluate("document.body.classList.contains('orwell-dr-mode')") is True,
                  "diary room: the composer carries the mode indicator")
            sb_btn = page.evaluate("(function(){ var b = document.getElementById('sidebar-diary-room-btn'); return !!(b && document.getElementById('sidebar').contains(b)); })()")
            check(sb_btn is True, "diary room: the standing trigger lives in the sidebar")
            dr_focus = page.evaluate("document.activeElement && document.activeElement.id === 'message'")
            check(dr_focus is True, "diary room: focus lands in the composer")
            page.keyboard.press("Escape")
            dr_closed = page.evaluate("!(window._orwellDiaryRoomActive && window._orwellDiaryRoomActive())")
            check(dr_closed is True, "diary room: Escape leaves the composer mode")

            # E90 (ruling #7): the theme trigger is icon-only in the sidebar's
            # bottom cluster, beside the settings gear, with an accessible name.
            tbtn = page.evaluate("""() => {
              const b = document.getElementById('tool-theme-btn');
              if (!b) return { ok: false };
              const bar = document.getElementById('sidebar-user-bar');
              return { ok: true, inCluster: !!(bar && bar.contains(b)),
                       named: !!(b.getAttribute('aria-label') || b.title),
                       textless: (b.textContent || '').trim() === '' };
            }""")
            check(tbtn.get("inCluster") is True, f"theme: trigger docks in the bottom cluster ({tbtn})")
            check(tbtn.get("named") is True, "theme: trigger has an accessible name")
            check(tbtn.get("textless") is True, "theme: trigger renders no text node")

            # H3: the theme picker's ONE home is the standing sidebar entry
            # (#tool-theme-btn — proven docked in the bottom cluster above). The old
            # Settings → Appearance Theme card is gone, so drive the picker the way a
            # player does: a real (trusted) click on the sidebar entry, then assert it
            # opens a populated theme grid. Also pin that the dropped appearance
            # launcher never comes back.
            check(page.evaluate("!document.getElementById('appearance-theme-btn')") is True,
                  "H3: appearance panel ships no theme launcher (the sidebar owns the picker)")
            page.click("#tool-theme-btn")
            page.wait_for_timeout(250)
            theme = page.evaluate(
                """() => {
                  const m = document.getElementById('theme-modal');
                  const grid = document.getElementById('themeGrid');
                  return { opened: m ? !m.classList.contains('hidden') : false,
                           themes: grid ? grid.children.length : 0 };
                }"""
            )
            check(bool(theme.get("opened")) and theme.get("themes", 0) > 0,
                  f"sidebar theme entry opens a populated theme grid ({theme})")

            # The SIDEBAR "Theme" entry must stay visible under the game build (its
            # Appearance → Sidebar toggle is on by default), while the other dropped
            # Tools items stay hidden. Hiding the whole #tools-section buried Theme even
            # with its toggle on; we now hide the non-Theme items individually.
            sidebar_theme = page.evaluate(
                """() => {
                  const vis = (id) => {
                    const el = document.getElementById(id);
                    if (!el) return null;
                    const cs = getComputedStyle(el);
                    return cs.display !== 'none' && el.offsetParent !== null;
                  };
                  return { theme: vis('tool-theme-btn'),
                           memory: vis('tool-memory-btn'),
                           tasks: vis('tool-tasks-btn') };
                }"""
            )
            check(sidebar_theme.get("theme") is True,
                  f"sidebar Theme entry is visible under the game build ({sidebar_theme})")
            check(sidebar_theme.get("memory") is False and sidebar_theme.get("tasks") is False,
                  f"other dropped Tools items stay hidden ({sidebar_theme})")
            # Close the theme picker before the finale block — it is now an
            # OrwellWindow KIT modal (.ow-window + its own .ow-scrim), and left
            # open its scrim sits ABOVE the non-modal finale panel (z~501) and
            # intercepts the trusted minimize click below. Close via the kit ×
            # (.ow-close) so the window AND its scrim tear down. Test isolation
            # only; closing it is the right teardown.
            page.evaluate("""() => {
              const t = document.getElementById('theme-modal');
              if (!t) return;
              const c = t.querySelector('.ow-close, .close-btn, .modal-close, [data-close]');
              if (c) c.click();
            }""")
            page.wait_for_timeout(300)
            # Belt: the kit close animation is ~190ms — make sure the scrim is gone
            # before the finale interactions (it would orphan-intercept otherwise).
            try:
                page.wait_for_function(
                    "() => !document.querySelector('.ow-scrim[data-ow-scrim=\"theme-modal\"]')",
                    timeout=2000)
            except Exception:
                pass

            # T20: a game panel's minimize BEHAVIOR — carried by the FINALE now (the remaining
            # kit game panel; H5 folded social into the sidebar). #573 GESTURE UNIFICATION
            # (window-system audit Direction B): a DOCKABLE window's minimize IS the dock —
            # ONE gesture, ONE destination (the control room). So the finale's minimize control
            # DOCKS the full window into the gadget rail (mounts into #gadget-rail-body as a
            # static .ow-docked window), NOT a chip in a separate "Windows" strip; undocking (⇱)
            # floats it back. A regression that drops the dock wiring (an in-place collapse, a
            # stranded/invisible docked window, or a re-split into two destinations) fails here,
            # not at a source grep.
            page.evaluate("window._orwellFinaleEnsure && window._orwellFinaleEnsure()")
            page.wait_for_selector("#orwell-finale", timeout=3000)
            check(page.evaluate("getComputedStyle(document.getElementById('orwell-finale')).display !== 'none'") is True,
                  "finale panel: mounts visible")
            page.wait_for_timeout(280)  # let the kit's open animation settle before measuring
            fin_cluster = page.evaluate("""[...document.querySelectorAll('#orwell-finale .ow-controls button')].map(b => {
              const r = b.getBoundingClientRect();
              const a = getComputedStyle(b, '::after');
              const aw = parseFloat(a.width) || 0, ah = parseFloat(a.height) || 0;
              return { label: b.getAttribute('aria-label'),
                       w: Math.round(Math.max(r.width, aw)), h: Math.round(Math.max(r.height, ah)) };
            })""")
            check(len(fin_cluster) >= 1 and all(c["label"] and c["w"] >= 24 and c["h"] >= 24 for c in fin_cluster),
                  f"finale composes the kit cluster (named, >=24px tap) ({fin_cluster})")
            # #573: these are TRUSTED clicks on purpose — the old evaluate() clicks worked on an
            # invisible dock and masked the stranded-window trap.
            page.click("#orwell-finale .ow-min")
            page.wait_for_timeout(400)  # the dock re-home is synchronous; a short settle for the onDock render
            min_state = page.evaluate("""() => {
              const el = document.getElementById('orwell-finale');
              const rail = document.getElementById('gadget-rail');
              const body = document.getElementById('gadget-rail-body');
              // R5/#1416b: read the docked flag under the SAME key the app writes — via the shared
              // helper (keys under ':local' in the no-auth smoke env where data-user is empty).
              const chip = document.querySelector('#minimized-dock .minimized-dock-chip[data-modal-id="orwell-finale"]');
              return { exists: !!el,
                       // minimize DOCKS the full window into the control room (static, in the rail body)…
                       docked: !!el && el.classList.contains('ow-docked'),
                       inRailBody: !!(el && body && body.contains(el)),
                       staticPos: !!el && getComputedStyle(el).position === 'static',
                       visible: !!el && getComputedStyle(el).display !== 'none',
                       railShown: !!rail && !rail.hasAttribute('hidden'),
                       dockedFlag: localStorage.getItem(window.orwellUserKey('orwell-orwell-finale-docked')),
                       // …and parks NO chip in the legacy "Windows" strip (the gesture split is retired).
                       noChip: !chip };
            }""")
            check(min_state.get("docked") is True and min_state.get("inRailBody") is True
                  and min_state.get("staticPos") is True,
                  f"T20/#573: minimize DOCKS the finale into the control-room rail ({min_state})")
            check(min_state.get("visible") is True and min_state.get("railShown") is True,
                  f"T20/#573: the docked finale is VISIBLE in the (shown) control room ({min_state})")
            check(min_state.get("dockedFlag") == "1" and min_state.get("noChip") is True,
                  f"T20/#573: the docked flag persists and NO chip is parked (one destination) ({min_state})")
            # Undock (⇱ float) — the single gesture back OUT — floats it; re-ensure re-shows it.
            page.click("#orwell-finale .ow-dock")
            page.evaluate("window._orwellFinaleEnsure && window._orwellFinaleEnsure()")
            page.wait_for_timeout(250)
            restored = page.evaluate("""() => {
              const el = document.getElementById('orwell-finale');
              // R5/#1416b: read the float flag via the shared helper (the key the app writes).
              return !!el && getComputedStyle(el).display !== 'none'
                && !el.classList.contains('ow-docked')
                && localStorage.getItem(window.orwellUserKey('orwell-orwell-finale-docked')) === '0';
            }""")
            check(restored is True,
                  "T20/#573: undocking floats the finale back (visible, un-docked, float persisted)")

            # F2 (DWE audit): drag must MOVE the panel — the slot restack used to revert
            # every windowDrag style write, leaving drag dead and offsets at (0,0).
            # #783: the finale panel opens at its bottom-right HUD slot, parked flush against
            # the 720px viewport bottom (y~635) — so the original DOWN-and-RIGHT drag was
            # fully clamped by clampPos() (observed y 635->635, x moved only ~5px) and the
            # check failed every run. Pin the panel to a top-left geometry with room below
            # and to the right FIRST, then drag down-right into that room. Harness-only,
            # Vault-free; drag direction is unchanged so the offset/restack checks below
            # still see a real positive delta.
            #
            # DRAG_TOL: the shared px tolerance for every tolerance-based drag/resize band
            # below (this F2 check + the kit/L11 checks). Headless trusted-pointer simulation
            # drifts a few px run-to-run (sub-pixel rounding + frame timing); +/-30px absorbs
            # that while still failing a dead/clamped drag (which lands tens of px off, ~0).
            DRAG_TOL = 30
            # NB: the slot system positions these windows with !important transform/inset,
            # so the reset must use setProperty(..., 'important') to win (a plain style write
            # is silently overridden — that left the panel parked at the edge).
            page.evaluate("""() => {
              Object.keys(localStorage)
                .filter(k => /^orwell-slot-offset:finale/.test(k))
                .forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
              const el = document.getElementById('orwell-finale');
              if (el) {
                el.style.setProperty('transform', 'none', 'important');
                el.style.setProperty('right', 'auto', 'important');
                el.style.setProperty('bottom', 'auto', 'important');
                el.style.setProperty('left', '80px', 'important');
                el.style.setProperty('top', '80px', 'important');
              }
            }""")
            page.wait_for_timeout(300)
            hdr = page.query_selector("#orwell-finale .ow-titlebar")
            hb = hdr.bounding_box()
            r0 = page.evaluate("document.getElementById('orwell-finale').getBoundingClientRect().toJSON()")
            # Tolerance-based (#783): assert the panel moved BY ~the intended drag delta in
            # the correct direction, not to an exact coordinate — absorbs sub-pixel/timing
            # drift while still failing a dead/clamped drag (which lands tens of px off, at
            # a ~0 delta). DRAG_TOL is shared with the kit checks above (rationale there).
            FIN_DX, FIN_DY = 150, 120  # intended drag delta (see loop below)
            page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
            page.mouse.down()
            for i in range(1, 9):
                page.mouse.move(hb["x"] + hb["width"] / 2 + FIN_DX * i / 8, hb["y"] + hb["height"] / 2 + FIN_DY * i / 8)
            page.mouse.up()
            page.wait_for_timeout(200)
            r1 = page.evaluate("document.getElementById('orwell-finale').getBoundingClientRect().toJSON()")
            f_dx, f_dy = r1["x"] - r0["x"], r1["y"] - r0["y"]
            check(abs(f_dx - FIN_DX) <= DRAG_TOL and abs(f_dy - FIN_DY) <= DRAG_TOL,
                  f"F2: dragging the title bar MOVES the panel by ~the drag delta "
                  f"(dx {f_dx:.0f}~{FIN_DX}, dy {f_dy:.0f}~{FIN_DY}, tol +/-{DRAG_TOL})")
            off = page.evaluate("""() => {
              const k = Object.keys(localStorage).find(k => k.startsWith('orwell-slot-offset:finale'));
              if (!k) return null;
              try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; }
            }""")
            check(bool(off) and (abs(off.get("dx", 0)) > 60 or abs(off.get("dy", 0)) > 40),
                  f"F2: the persisted slot offset is the real drag delta, not (0,0) ({off})")
            page.evaluate("window.OrwellSlots && window.OrwellSlots.restackAll()")  # provoke a restack
            page.wait_for_timeout(250)
            r2 = page.evaluate("document.getElementById('orwell-finale').getBoundingClientRect().toJSON()")
            check(abs(r2["x"] - r1["x"]) < 20 and abs(r2["y"] - r1["y"]) < 20,
                  f"F2: the dragged position survives an unrelated restack ({r1['x']:.0f},{r1['y']:.0f} -> {r2['x']:.0f},{r2['y']:.0f})")

            # The window KIT (Lane F / F-1): one class + one .ow-* family. Exercise a real
            # kit window end-to-end: chrome, trusted drag, Escape-parks, dock restore,
            # close-with-focus-return, clean teardown.
            # Housekeeping: the theme/settings assertions above leave their modals open;
            # a top modal legitimately outranks a kit window on Escape (DWE order), so
            # clear them before testing the kit's own Escape path.
            page.evaluate("""['theme-modal','settings-modal'].forEach(id => {
              const m = document.getElementById(id);
              if (m && !m.classList.contains('hidden')) {
                const b = m.querySelector('.ow-close, .close-btn, .modal-close-btn, [data-action="close"]');
                if (b) b.click(); else m.classList.add('hidden');
              }
            })""")
            page.wait_for_timeout(200)
            kit = page.evaluate("""() => {
              const gear = document.getElementById('user-bar-settings');
              if (gear) gear.focus();
              const w = window.OrwellWindowKit.create({
                id: 'ow-smoke-window', title: 'Production Test', slot: 'top-left', slotKey: 'owsmoke',
                // #896: give the window content with a definite WIDE intrinsic width (700px) so the
                // L11 corner/edge resize drags below stay UNDER the natural-content max-width cap and
                // keep exercising real resizing. (A trivial-content window is now correctly capped near
                // its content width — "no point going wider" — which the dedicated #896 checks assert.)
                content: '<div style="width:700px">kit smoke</div>', icon: '' });
              w.open(document.activeElement);
              window._owSmoke = w;
              const el = document.getElementById('ow-smoke-window');
              return { mounted: !!el, titlebar: !!el.querySelector('.ow-titlebar'),
                       title: el.querySelector('.ow-title').textContent,
                       focused: el.classList.contains('ow-focused') };
            }""")
            page.wait_for_timeout(280)  # let the open animation settle before measuring geometry
            # Under the frosted theme the controls are macOS traffic lights (12px discs)
            # with an INVISIBLE 44px ::after hit region (WCAG 2.5.5). Measure the EFFECTIVE
            # tap area (max of the disc box and the ::after) so the check tracks the real
            # target, not the visual disc size.
            kit["ctrls"] = page.evaluate("""[...document.querySelectorAll('#ow-smoke-window .ow-controls button')].map(b => {
              const r = b.getBoundingClientRect();
              const a = getComputedStyle(b, '::after');
              const aw = parseFloat(a.width) || 0, ah = parseFloat(a.height) || 0;
              return { label: b.getAttribute('aria-label'),
                       w: Math.round(Math.max(r.width, aw)), h: Math.round(Math.max(r.height, ah)) };
            })""")
            check(kit.get("mounted") is True and kit.get("titlebar") is True, f"kit: window mounts with titlebar ({kit})")
            check(all(c["w"] >= 24 and c["h"] >= 24 and c["label"] for c in kit.get("ctrls", [])),
                  f"kit: control cluster named + >=24px tap targets ({kit.get('ctrls')})")
            check(kit.get("focused") is True, "kit: opening focuses (ow-focused on top of the stack)")
            # Deterministic geometry before the drag/resize block (#783). Two real flake
            # drivers, BOTH harness-side (no product bug — the window drags/resizes fine):
            #   1. The kit restores a persisted winsize-<id>/slot-offset; a leftover LARGE
            #      size or low position from a prior run parks the window flush against the
            #      viewport bottom/right edge, where clampPos() pins a +120px drag/resize to
            #      ~0 (observed dy/dh deltas of ~0 instead of ~90). Even fresh, the default
            #      top-slot can sit only ~4px above the 720px viewport bottom — no room down.
            #   2. The ow-open scale animation must fully settle (transform: none) before we
            #      grab the titlebar, or the pointer lands on a transformed/stale rect.
            # Fix: clear every persisted geometry key for this window, then pin it to a small
            # top-left geometry with generous room BELOW and to the RIGHT so a +120/+90 drag
            # and resize always fit, then wait out the animation. Vault-free, harness-only.
            # The slot system positions via !important transform/inset, so use
            # setProperty(..., 'important') or the reset is silently overridden.
            page.evaluate("""() => {
              Object.keys(localStorage)
                .filter(k => /^(winsize-ow-smoke-window|winpos-ow-smoke-window|orwell-slot-offset:owsmoke)/.test(k))
                .forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
              const el = document.getElementById('ow-smoke-window');
              if (el) {
                el.style.setProperty('transform', 'none', 'important');
                el.style.setProperty('right', 'auto', 'important');
                el.style.setProperty('bottom', 'auto', 'important');
                el.style.setProperty('left', '60px', 'important');
                el.style.setProperty('top', '60px', 'important');
                el.style.setProperty('width', '320px', 'important');
                el.style.setProperty('height', '240px', 'important');
              }
            }""")
            page.wait_for_timeout(320)  # let the ow-open transform fully clear before measuring
            # Tolerance-based drag/resize assertions (#783): headless trusted-pointer
            # simulation drifts a few px run-to-run (sub-pixel rounding + frame timing —
            # e.g. a +120px drag lands as +118 or +122, observed flips like x603->602 vs
            # x595->594). So assert the window moved/resized BY APPROXIMATELY the intended
            # drag delta in the correct direction, within a px tolerance, instead of pinning
            # a near-exact final coordinate. The band [delta - DRAG_TOL, delta + DRAG_TOL]
            # absorbs the drift while keeping teeth: a window that doesn't move, moves the
            # wrong way, or doesn't resize lands far outside it (its measured delta is ~0 or
            # opposite-signed, dozens of px from the expected delta). (DRAG_TOL is defined
            # once, above the F2 finale-drag check, and shared by every drag/resize band.)
            DRAG_DX, DRAG_DY = 120, 90  # intended titlebar-drag delta (see loop below)
            kb = page.query_selector("#ow-smoke-window .ow-titlebar").bounding_box()
            page.mouse.move(kb["x"] + 40, kb["y"] + kb["height"] / 2)
            page.mouse.down()
            for i in range(1, 7):
                page.mouse.move(kb["x"] + 40 + DRAG_DX * i / 6, kb["y"] + kb["height"] / 2 + DRAG_DY * i / 6)
            page.mouse.up()
            page.wait_for_timeout(150)
            kmoved = page.evaluate("document.getElementById('ow-smoke-window').getBoundingClientRect().toJSON()")
            k_dx, k_dy = kmoved["x"] - kb["x"], kmoved["y"] - kb["y"]
            check(abs(k_dx - DRAG_DX) <= DRAG_TOL and abs(k_dy - DRAG_DY) <= DRAG_TOL,
                  f"kit: trusted drag moves the window by ~the drag delta "
                  f"(dx {k_dx:.0f}~{DRAG_DX}, dy {k_dy:.0f}~{DRAG_DY}, tol +/-{DRAG_TOL})")

            # L11: every kit window resizes from the SIDE and the CORNER on
            # desktop (edge-proximity grips), and the size persists under the
            # kit's one winsize-<id> key. Grab the bottom-right corner and drag
            # it out — width AND height must grow, and the chosen size sticks.
            # Same tolerance rationale as the drag check above (#783): assert the
            # corner drag GREW width and height by ~the intended +120/+90 delta within
            # DRAG_TOL, in the right direction. A window that fails to resize lands at a
            # ~0 delta, dozens of px below the band's lower edge, so the check still bites.
            CORNER_DW, CORNER_DH = 120, 90  # intended corner-drag delta (see loop below)
            rbefore = page.evaluate("document.getElementById('ow-smoke-window').getBoundingClientRect().toJSON()")
            cx = rbefore["x"] + rbefore["width"] - 2
            cy = rbefore["y"] + rbefore["height"] - 2
            page.mouse.move(cx, cy)
            page.mouse.down()
            for i in range(1, 7):
                page.mouse.move(cx + CORNER_DW * i / 6, cy + CORNER_DH * i / 6)
            page.mouse.up()
            page.wait_for_timeout(150)
            rcorner = page.evaluate("document.getElementById('ow-smoke-window').getBoundingClientRect().toJSON()")
            c_dw, c_dh = rcorner["width"] - rbefore["width"], rcorner["height"] - rbefore["height"]
            check(abs(c_dw - CORNER_DW) <= DRAG_TOL and abs(c_dh - CORNER_DH) <= DRAG_TOL,
                  f"L11: corner-drag resizes the window by ~the drag delta "
                  f"(dw {c_dw:.0f}~{CORNER_DW}, dh {c_dh:.0f}~{CORNER_DH}, tol +/-{DRAG_TOL})")
            # the right EDGE alone resizes width only (a true side grip) — same #783
            # tolerance: width grows by ~the +80 edge-drag delta within DRAG_TOL.
            EDGE_DW = 80  # intended right-edge-drag delta (see loop below)
            rmid = page.evaluate("document.getElementById('ow-smoke-window').getBoundingClientRect().toJSON()")
            ex = rmid["x"] + rmid["width"] - 2
            ey = rmid["y"] + rmid["height"] / 2
            page.mouse.move(ex, ey)
            page.mouse.down()
            for i in range(1, 5):
                page.mouse.move(ex + EDGE_DW * i / 4, ey)
            page.mouse.up()
            page.wait_for_timeout(120)
            redge = page.evaluate("""() => ({
              w: Math.round(document.getElementById('ow-smoke-window').getBoundingClientRect().width),
              saved: localStorage.getItem('winsize-ow-smoke-window'),
            })""")
            e_dw = redge["w"] - round(rmid["width"])
            check(abs(e_dw - EDGE_DW) <= DRAG_TOL,
                  f"L11: right-edge drag widens the window by ~the drag delta "
                  f"(dw {e_dw:.0f}~{EDGE_DW}, tol +/-{DRAG_TOL}, w {rmid['width']:.0f}->{redge['w']})")
            check(bool(redge["saved"]) and '"w"' in (redge["saved"] or ""),
                  f"L11: the resized geometry persists under winsize-ow-smoke-window ({redge['saved']!r})")

            # #896 — the MAX-WIDTH CAP. A window can't be dragged past min(natural content width,
            # viewport − margin): intrinsic-width content stops AT its content width (no dead space),
            # reflow content (no finite content cap) stops at the viewport cap with a clear edge gap.
            # First assert the exported cap math directly (deterministic), then prove a real over-drag
            # lands at it for both content shapes.
            cap = page.evaluate("""async () => {
              const mod = await import('/static/js/windowResize.js');
              const vw = window.innerWidth;
              const mk = (id, html) => {
                document.querySelectorAll('#'+id).forEach(n => n.remove());
                const w = window.OrwellWindowKit.create({ id, title: id, content: html, icon: '' });
                w.open(); return document.getElementById(id);
              };
              // Intrinsic: a fixed-width block → content cap binds, well under the viewport cap.
              const ei = mk('ow-cap-intrinsic', "<div style='width:420px'>fixed</div>");
              await new Promise(r => requestAnimationFrame(r));
              const capI = Math.round(mod.windowMaxWidth(ei, 240));
              // Reflow: a long paragraph that wraps to any width → content cap exceeds the viewport,
              // so the cap is the viewport cap (innerWidth − margin*2 == vw − 24).
              const er = mk('ow-cap-reflow', "<p style='margin:0'>" + ("wraps to any width ").repeat(40) + "</p>");
              await new Promise(r => requestAnimationFrame(r));
              const capR = Math.round(mod.windowMaxWidth(er, 240));
              ei.remove(); er.remove();
              return { vw, capI, capR, viewportCap: vw - 24 };
            }""")
            # intrinsic content cap binds: well under the viewport cap, ~ the content's own width.
            check(cap["capI"] < cap["viewportCap"] - 100 and 380 <= cap["capI"] <= 560,
                  f"#896: intrinsic content caps AT content width, not the viewport "
                  f"(cap={cap['capI']}, viewportCap={cap['viewportCap']})")
            # reflow content has no finite content cap → the viewport cap governs (vw − margin*2).
            check(cap["capR"] == cap["viewportCap"],
                  f"#896: reflow content caps at the viewport (cap={cap['capR']} == vw-24={cap['viewportCap']})")
            # a real over-drag of an intrinsic window stops at/near the content cap (no dead space)
            # and stays well inside the viewport (an obvious margin to the edge).
            overdrag = page.evaluate("""async () => {
              const id = 'ow-cap-drag';
              document.querySelectorAll('#'+id).forEach(n => n.remove());
              Object.keys(localStorage).filter(k => /^winsize-ow-cap-drag/.test(k)).forEach(k => localStorage.removeItem(k));
              const w = window.OrwellWindowKit.create({ id, title: id,
                content: "<div style='width:400px'>fixed</div>", icon: '' });
              w.open(); const el = document.getElementById(id);
              el.style.setProperty('transform','none','important'); el.style.setProperty('right','auto','important');
              el.style.setProperty('bottom','auto','important'); el.style.setProperty('left','40px','important');
              el.style.setProperty('top','60px','important'); el.style.setProperty('width','320px','important');
              el.style.setProperty('height','220px','important');
              await new Promise(r => setTimeout(r, 250));
              window.__capDrag = el; return el.getBoundingClientRect().toJSON();
            }""")
            cdx = overdrag["x"] + overdrag["width"] - 2
            cdy = overdrag["y"] + overdrag["height"] / 2
            page.mouse.move(cdx, cdy)
            page.mouse.down()
            for i in range(1, 13):  # drag the right edge FAR past the screen edge
                page.mouse.move(cdx + (cap["vw"] + 800) * i / 12, cdy)
            page.mouse.up()
            page.wait_for_timeout(150)
            capped = page.evaluate("document.getElementById('ow-cap-drag').getBoundingClientRect().toJSON()")
            page.evaluate("window.__capDrag && window.__capDrag.remove()")
            # width never crossed the content cap (intrinsic content → ~content width, well under viewport)
            check(round(capped["width"]) <= cap["capI"] + 4,
                  f"#896: an over-dragged intrinsic window stops at the content cap "
                  f"(width={capped['width']:.0f} <= {cap['capI']}+4)")
            # and the right edge keeps a clear gap to the viewport — never flush, never past it
            right_gap = cap["vw"] - (capped["x"] + capped["width"])
            check(right_gap >= 6,
                  f"#896: a maxed window keeps an obvious margin to the viewport edge "
                  f"(rightGap={right_gap:.0f}px >= 6)")

            page.mouse.move(640, 500)  # neutral ground: the arbiter's hovered-window pass must not fire
            page.evaluate("document.body.focus()")
            page.keyboard.press("Escape")
            page.wait_for_timeout(350)
            parked = page.evaluate("""() => {
              const dock = document.getElementById('minimized-dock');
              const rail = document.getElementById('gadget-rail');
              return {
                hidden: getComputedStyle(document.getElementById('ow-smoke-window')).display === 'none',
                chip: !!document.querySelector('#minimized-dock .minimized-dock-chip[data-modal-id="ow-smoke-window"]'),
                dockVisible: !!dock && getComputedStyle(dock).display !== 'none' && dock.getBoundingClientRect().height > 0,
                // #573 B — RAIL UNIFICATION: a NON-dockable window still parks to a chip, and that
                // chip's "Windows" dock is homed INTO the control-room rail (one destination for both
                // minimized chips and docked windows). Dockable windows now dock directly (T20/G16).
                dockInRail: !!(dock && rail && rail.contains(dock)),
              };
            }""")
            check(parked.get("hidden") is True and parked.get("chip") is True,
                  f"kit: Escape parks the top (non-dockable) window to the dock (F7) ({parked})")
            check(parked.get("dockVisible") is True,
                  f"F1: the Windows dock is VISIBLE while holding a chip ({parked})")
            check(parked.get("dockInRail") is True,
                  f"#573 B: the parked-chip dock is homed INTO the control-room rail ({parked})")
            page.click("#minimized-dock .minimized-dock-chip[data-modal-id='ow-smoke-window']")
            page.wait_for_timeout(250)
            check(page.evaluate("getComputedStyle(document.getElementById('ow-smoke-window')).display !== 'none'") is True,
                  "kit: dock chip restores the window (trusted click)")
            page.click("#ow-smoke-window .ow-close")
            page.wait_for_timeout(300)
            closed = page.evaluate("""() => ({
              gone: !document.getElementById('ow-smoke-window'),
              focusBack: document.activeElement && document.activeElement.id === 'user-bar-settings',
            })""")
            check(closed.get("gone") is True, f"kit: close tears the window down ({closed})")
            check(closed.get("focusBack") is True, f"kit: focus returns to the opener (F8) ({closed})")

            # Slot stacking is viewport-clamped (the vault/new-season collision fix):
            # two TALL windows in ONE slot must BOTH stay on-screen — never shoved
            # above the top (the original bug pushed the second window off-screen).
            stack = page.evaluate("""() => {
              const tall = '<div style="height:420px;width:340px">tall</div>';
              const a = window.OrwellWindowKit.create({ id: 'ow-stack-a', title: 'Stack A',
                slot: 'bottom-right', slotKey: 'owstacka', content: tall, icon: '' });
              const b = window.OrwellWindowKit.create({ id: 'ow-stack-b', title: 'Stack B',
                slot: 'bottom-right', slotKey: 'owstackb', content: tall, icon: '' });
              a.open(); b.open();
              window._owStackA = a; window._owStackB = b;
              if (window.OrwellSlots && window.OrwellSlots.restackAll) window.OrwellSlots.restackAll();
              const rect = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
              return { a: rect('ow-stack-a'), b: rect('ow-stack-b'),
                       vw: window.innerWidth, vh: window.innerHeight };
            }""")
            for nm in ("a", "b"):
                r = stack[nm]
                check(r["top"] >= -1 and r["left"] >= -1
                      and r["left"] <= stack["vw"] and r["top"] <= stack["vh"],
                      f"slot: stacked window '{nm}' stays in viewport "
                      f"(top={r['top']:.0f} left={r['left']:.0f} vw={stack['vw']} vh={stack['vh']})")
            page.evaluate("window._owStackA && window._owStackA.destroy(); "
                          "window._owStackB && window._owStackB.destroy();")
            page.wait_for_timeout(120)

            # VIEWPORT RE-CLAMP ON BROWSER RESIZE (the DWE windowing tail): a FLOATING
            # window dragged near an edge must re-clamp into a SHRUNKEN viewport when the
            # browser window resizes — the kit clamps on open/drag/resize but had no path
            # to react to a viewport shrink, so a window could strand partially off-screen
            # until touched. Open a window, shove it to the bottom-right corner, then shrink
            # window.innerWidth/innerHeight (real shim) + dispatch 'resize', and assert its
            # bounding rect stays inside the new viewport. The original innerWidth/Height are
            # restored after so later checks see the true viewport.
            reclamp = page.evaluate("""async () => {
              const realW = Object.getOwnPropertyDescriptor(window, 'innerWidth');
              const realH = Object.getOwnPropertyDescriptor(window, 'innerHeight');
              const trueW = window.innerWidth, trueH = window.innerHeight;
              const w = window.OrwellWindowKit.create({
                id: 'ow-reclamp-smoke', title: 'Reclamp Test', slot: 'bottom-right',
                slotKey: 'owreclamp', content: '<div style="width:300px;height:240px">x</div>',
                icon: '' });
              w.open();
              window._owReclamp = w;
              const el = document.getElementById('ow-reclamp-smoke');
              // Drag it (via the real slot drag-drop API) to the far bottom-right corner
              // of the CURRENT (large) viewport — the genuine "dragged near an edge" case.
              const r0 = el.getBoundingClientRect();
              if (w._slot) w._slot.saveDragOffset({
                left: trueW - r0.width - 6, top: trueH - r0.height - 6,
                width: r0.width, height: r0.height });
              const before = el.getBoundingClientRect().toJSON();
              // Shrink the viewport hard, then fire the real resize event.
              const newW = 520, newH = 420;
              Object.defineProperty(window, 'innerWidth', { value: newW, configurable: true });
              Object.defineProperty(window, 'innerHeight', { value: newH, configurable: true });
              window.dispatchEvent(new Event('resize'));
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
              await new Promise(r => setTimeout(r, 200));  // let the slot observer settle
              const after = el.getBoundingClientRect().toJSON();
              // restore the true viewport so downstream checks are unaffected — and
              // re-fire resize so any width-driven listeners recompute at the real size.
              if (realW) Object.defineProperty(window, 'innerWidth', realW);
              if (realH) Object.defineProperty(window, 'innerHeight', realH);
              window._owReclamp.close();
              window.dispatchEvent(new Event('resize'));
              await new Promise(r => requestAnimationFrame(r));
              return { before, after, newW, newH };
            }""")
            a = reclamp["after"]
            check(a["right"] <= reclamp["newW"] + 1 and a["bottom"] <= reclamp["newH"] + 1
                  and a["left"] >= -1 and a["top"] >= -1,
                  f"resize re-clamp: a floating window re-anchors INTO the shrunken viewport "
                  f"(right={a['right']:.0f}<= {reclamp['newW']}, bottom={a['bottom']:.0f}<= {reclamp['newH']})")
            check(a["width"] <= reclamp["newW"] - 7 and a["height"] <= reclamp["newH"] - 7,
                  f"resize re-clamp: an over-sized window shrinks to fit the viewport "
                  f"(w={a['width']:.0f}, h={a['height']:.0f} <= viewport-8)")
            page.wait_for_timeout(120)

            # 0054 Phase 2 — DOCKED kit mode: a dockable window can render its full
            # body INTO #gadget-rail-body (opting OUT of position:fixed + the slot
            # geometry — ONE position system), the docked flag persists per-window,
            # and undocking floats it back. (Engine is down, so we drive the kit seam
            # directly; the rail body exists in the game build.)
            dock = page.evaluate("""() => {
              const w = window.OrwellWindowKit.create({
                id: 'ow-dock-smoke', title: 'Dock Test', slot: 'top-left', slotKey: 'owdocksmoke',
                content: '<p>docked body</p>', icon: '', dockable: true, defaultDocked: false });
              w.open();
              window._owDock = w;
              const el = document.getElementById('ow-dock-smoke');
              const beforeFixed = getComputedStyle(el).position;  // floating: fixed
              const hasToggle = !!el.querySelector('.ow-controls .ow-dock');
              w.toggleDock();  // float -> dock
              const d = document.getElementById('ow-dock-smoke');
              const railBody = document.getElementById('gadget-rail-body');
              return {
                hasToggle,
                beforeFixed,
                inRail: !!railBody && railBody.contains(d),
                dockedClass: d.classList.contains('ow-docked'),
                dockedPos: getComputedStyle(d).position,   // docked: static
                kitWindow: d.hasAttribute('data-ow-window'),
                // R5/#1416b: read the docked flag via the shared helper (the key the app writes).
                flag: localStorage.getItem(window.orwellUserKey('orwell-ow-dock-smoke-docked')),
                noChip: !document.querySelector('#minimized-dock .minimized-dock-chip[data-modal-id="ow-dock-smoke"]'),
              };
            }""")
            check(dock.get("hasToggle") is True and dock.get("beforeFixed") == "fixed",
                  f"0054 P2: a dockable window has the dock toggle and floats first ({dock})")
            check(dock.get("inRail") is True and dock.get("dockedClass") is True
                  and dock.get("dockedPos") == "static" and dock.get("kitWindow") is True,
                  f"0054 P2: docking mounts the FULL window into the rail, static (no slot geometry) ({dock})")
            check(dock.get("flag") == "1" and dock.get("noChip") is True,
                  f"0054 P2: the docked flag persists and no chip dock is used ({dock})")
            undock = page.evaluate("""() => {
              window._owDock.toggleDock();  // dock -> float
              const d = document.getElementById('ow-dock-smoke');
              const railBody = document.getElementById('gadget-rail-body');
              const out = {
                floats: getComputedStyle(d).position === 'fixed',
                notDocked: !d.classList.contains('ow-docked'),
                notInRail: !(railBody && railBody.contains(d)),
                // R5/#1416b: read the float flag via the shared helper (the key the app writes).
                flag: localStorage.getItem(window.orwellUserKey('orwell-ow-dock-smoke-docked')),
              };
              window._owDock.close();
              return out;
            }""")
            check(undock.get("floats") is True and undock.get("notDocked") is True
                  and undock.get("notInRail") is True and undock.get("flag") == "0",
                  f"0054 P2: undocking floats it back and persists the float choice ({undock})")

            # A7 [ruling #19]: the Win7 fly-out — minimize applies the DISTINCT
            # ow-anim-minimize keyframe with a real fly vector toward the dock; close
            # applies the DISTINCT ow-anim-close keyframe. (Reduced-motion stripping is
            # source-pinned in pytest; here we prove the two motions are wired + named.)
            fly = page.evaluate("""() => {
              const w = window.OrwellWindowKit.create({
                id: 'ow-fly-smoke', title: 'Fly Test', slot: 'top-left', slotKey: 'owflysmoke',
                content: '<p>fly</p>', icon: '' });
              w.open();
              window._owFly = w;
              const el = document.getElementById('ow-fly-smoke');
              w.minimize();
              return { minClass: el.classList.contains('ow-anim-minimize'),
                       flyX: el.style.getPropertyValue('--ow-fly-x') };
            }""")
            check(fly.get("minClass") is True and fly.get("flyX") not in (None, ""),
                  f"A7: minimize applies the ow-anim-minimize fly-out with a fly vector ({fly})")
            page.wait_for_timeout(320)  # let the minimize settle (chip lands), then restore + close
            page.evaluate("""() => {
              const dock = document.querySelector('#minimized-dock .minimized-dock-chip[data-modal-id="ow-fly-smoke"]');
              if (dock) dock.click();
            }""")
            page.wait_for_timeout(150)
            flyc = page.evaluate("""() => {
              const el = document.getElementById('ow-fly-smoke');
              if (!el) return { closeClass: false };
              // drive close via the × button to exercise the distinct close keyframe
              const btn = el.querySelector('.ow-close');
              if (btn) btn.click();
              return { closeClass: el.classList.contains('ow-anim-close') };
            }""")
            check(flyc.get("closeClass") is True,
                  f"A7: close applies the distinct ow-anim-close keyframe ({flyc})")
            page.wait_for_timeout(260)  # let the close fly-away finish + tear down
            # Belt-and-suspenders cleanup: ensure no smoke window/chip lingers in the
            # kit stack or the dock before the G14/F8 .modal-family checks run.
            page.evaluate("""() => {
              ['_owDock', '_owFly', '_owSmoke'].forEach(k => {
                try { if (window[k] && window[k].destroy) window[k].destroy(); } catch (_) {}
                window[k] = null;
              });
              ['ow-dock-smoke', 'ow-fly-smoke', 'ow-smoke-window'].forEach(id => {
                const el = document.getElementById(id); if (el) el.remove();
                const chip = document.querySelector('#minimized-dock .minimized-dock-chip[data-modal-id="' + id + '"]');
                if (chip) chip.remove();
              });
            }""")
            page.wait_for_timeout(120)

            # G14 (DWE audit F9b) — UPDATED for the theme-kit migration: theme is
            # now an OrwellWindow KIT modal (.ow-window, like settings), NOT a
            # legacy minimizable .modal. So G14 now proves the ONE z-authority +
            # Escape ordering across TWO kit modals: open theme, open settings
            # fresh ON TOP, the fresh open sits visually ABOVE (elementFromPoint at
            # the content overlap), Escape closes settings first then theme
            # (OrwellWindowKit.dismissTop == visual/top order), and no kit window
            # carries an inline !important z.
            page.click("#tool-theme-btn")
            page.wait_for_timeout(600)
            check(page.evaluate("!!document.getElementById('theme-modal')") is True,
                  "G14: theme opens from the sidebar entry (kit window built)")
            # Both theme + settings are now MODAL kit windows — theme's scrim makes
            # the gear inert (correct modal behavior), so a trusted gear click can't
            # reach it. Open settings via its module to stack a second kit modal on
            # top (the point here is the z-authority between two kit modals).
            page.evaluate("import('/static/js/settings.js').then(m => (m.default||m).open())")
            page.wait_for_timeout(600)
            g14 = page.evaluate("""() => {
              const t = document.getElementById('theme-modal');   // the kit .ow-window
              const s = document.getElementById('settings-modal');
              const vis = (m) => m && getComputedStyle(m).display !== 'none';
              if (!vis(t) || !vis(s)) return { error: 'both must be open', theme: vis(t), settings: vis(s) };
              const r1 = t.getBoundingClientRect();   // both are .ow-window now
              const r2 = s.getBoundingClientRect();
              const L = Math.max(r1.left, r2.left), R = Math.min(r1.right, r2.right);
              const T = Math.max(r1.top, r2.top), B = Math.min(r1.bottom, r2.bottom);
              if (R <= L || B <= T) return { error: 'contents do not overlap' };
              const el = document.elementFromPoint((L + R) / 2, (T + B) / 2);
              const owner = el ? (el.closest('.modal, .ow-window') || {}).id || null : null;
              const importants = [...document.querySelectorAll('.modal, .ow-window')]
                .filter(m => m.style.getPropertyPriority('z-index') === 'important').map(m => m.id);
              return { owner, importants,
                       themeZ: parseInt(getComputedStyle(t).zIndex, 10) || 0,
                       settingsZ: parseInt(getComputedStyle(s).zIndex, 10) || 0 };
            }""")
            check(g14.get("owner") == "settings-modal" and g14.get("settingsZ", 0) > g14.get("themeZ", 0),
                  f"G14: a fresh kit modal sits visually ABOVE the earlier one ({g14})")
            check(g14.get("importants") == [], f"G14: no kit window carries an inline !important z-index ({g14})")
            page.mouse.move(640, 700)  # neutral ground: keep the arbiter's hovered-window pass out of it
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            g14esc = page.evaluate("""() => ({
              settingsClosed: !document.getElementById('settings-modal'),
              themeOpen: !!document.getElementById('theme-modal'),
            })""")
            check(g14esc.get("settingsClosed") is True and g14esc.get("themeOpen") is True,
                  f"G14: Escape closes the TOP kit modal (settings) FIRST ({g14esc})")
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            check(page.evaluate("!document.getElementById('theme-modal')") is True,
                  "G14: the second Escape closes the remaining kit modal (theme)")

            # F8 (wave 3): the WHOLE .modal family returns focus to its opener —
            # focus the gear for real, open settings, Escape, focus is back.
            page.focus("#user-bar-settings")
            page.click("#user-bar-settings")
            page.wait_for_timeout(400)
            check(page.evaluate("!!document.getElementById('settings-modal')") is True,
                  "F8: settings opens from the focused gear")
            page.keyboard.press("Escape")
            page.wait_for_timeout(350)
            f8 = page.evaluate("""() => ({
              closed: !document.getElementById('settings-modal'),
              focusBack: document.activeElement && document.activeElement.id === 'user-bar-settings',
            })""")
            check(f8.get("closed") is True, f"F8: Escape closes settings ({f8})")
            check(f8.get("focusBack") is True, f"F8: focus returns to the gear ({f8})")

            # #553: Settings is a MODAL dialog on the OrwellWindow kit — intentionally NOT
            # minimizable-to-dock (a scrim'd modal tucked to a dock chip is nonsense; Escape/×
            # dismiss it). Under the frosted macOS chrome the cluster renders the THREE-light
            # cluster, so a yellow minimize LIGHT may be present — but it MUST be inert (disabled):
            # it carries no click handler and never parks a dock chip, so the #553 intent (settings
            # cannot minimize-to-dock) holds. Assert any minimize affordance is disabled, never
            # functional. The legacy .modal-family minimize→restore contract is exercised below.
            page.click("#user-bar-settings")
            page.wait_for_timeout(300)
            check(page.evaluate("!!document.getElementById('settings-modal')") is True,
                  "G2: settings opens from the gear")
            check(page.evaluate("""() => {
                const m = document.querySelector('#settings-modal .ow-min, #settings-modal .modal-minimize-btn, #settings-modal .minimize-btn');
                return !m || m.disabled === true;
            }""") is True,
                  "G2/#553: the settings modal has no FUNCTIONAL minimize-to-dock (any light is inert/disabled)")
            # Interactive: a trusted click INSIDE the window lands — the Account tab activates.
            page.click("#settings-modal [data-settings-tab='account']")
            page.wait_for_timeout(150)
            check(page.evaluate("document.querySelector(\"#settings-modal [data-settings-tab='account']\").classList.contains('active')") is True,
                  "G2: the settings window is interactive (trusted click inside lands)")
            page.evaluate("(document.querySelector('#settings-modal .ow-close')||{click(){}}).click()")
            page.wait_for_timeout(250)
            # The Theme window migrated to the OrwellWindow kit too — it is a MODAL
            # dialog (minimizable:false), exactly like Settings: it must NOT have a
            # functional minimize-to-dock (a scrim'd modal tucked to a dock chip is
            # nonsense; Escape/× dismiss it). Open it, assert any minimize light is
            # inert/disabled and that × tears it (and its scrim) down.
            page.click("#tool-theme-btn")
            page.wait_for_timeout(300)
            check(page.evaluate("!!document.getElementById('theme-modal')") is True,
                  "G2: theme opens from the sidebar entry (kit modal)")
            check(page.evaluate("""() => {
                const m = document.querySelector('#theme-modal .ow-min, #theme-modal .modal-minimize-btn, #theme-modal .minimize-btn');
                return !m || m.disabled === true;
            }""") is True,
                  "G2: the theme kit modal has no FUNCTIONAL minimize-to-dock (any light is inert/disabled)")
            page.evaluate("(document.querySelector('#theme-modal .ow-close')||{click(){}}).click()")
            page.wait_for_timeout(300)
            g2t = page.evaluate("""() => ({
              gone: !document.getElementById('theme-modal'),
              scrimGone: !document.querySelector('.ow-scrim[data-ow-scrim="theme-modal"]'),
            })""")
            check(g2t.get("gone") is True and g2t.get("scrimGone") is True,
                  f"G2: the kit × tears the theme window AND its scrim down ({g2t})")

            # F11 (wave 3): Escape while the decision card holds focus = the x path —
            # dismissed, never submitted.
            page.evaluate("""window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: {
                kind: 'eviction-vote', pick: 1, prompt: 'Cast your vote.',
                options: [ {id:'npc:1',name:'A'}, {id:'npc:2',name:'B'} ] }}}));""")
            page.wait_for_selector("#orwell-decision-card", timeout=3000)
            page.focus("#orwell-decision-card .odec-opt")
            page.keyboard.press("Escape")
            page.wait_for_timeout(150)
            check(page.evaluate("!document.getElementById('orwell-decision-card')") is True,
                  "F11: Escape dismisses the focused decision card (never submits)")

            # G16 (G5 refresh-persistence audit, F1+F2) — driven FOR REAL on an
            # isolated page (its own context/localStorage) with the audit's
            # sanctioned route mocks: a live-game /state + /status + /roster keep
            # the gates and poll loops honest across reloads while the main smoke
            # page stays engine-down. Role-named payloads only (no cast names).
            #   F2 (kit parked-means-parked), on the CAST window: open via the
            #       seam, minimize (trusted click) → RELOAD → re-open via the
            #       seam: it must come back PARKED (hidden + dock chip, no
            #       snap-open) → restore via the chip → RELOAD → re-open: OPEN,
            #       no stale chip.
            #   F1: collapse the status HUD (trusted click) → RELOAD → still
            #       collapsed, restored from the SAME per-user+game key the
            #       header click writes (E71).
            g16 = new_page(browser)
            g16_state = (
                '{"started": true, "week": 1, "phase": "nominations",'
                ' "player": {"id": "player", "name": "The Player", "status": "active"},'
                ' "house": [{"id": "npc:1", "name": "A Houseguest", "status": "active"},'
                ' {"id": "npc:2", "name": "Another Houseguest", "status": "active"}]}'
            )
            g16_status = (
                '{"week": 1, "phase": "nominations",'
                ' "hoh": {"id": "npc:1", "name": "A Houseguest"},'
                ' "nominees": [{"id": "npc:2", "name": "Another Houseguest"}]}'
            )
            g16_roster = (
                '{"imagesAvailable": false, "roster": ['
                '{"id": "player", "name": "The Player", "status": "active", "isPlayer": true},'
                '{"id": "npc:1", "name": "A Houseguest", "status": "active"}]}'
            )

            def _g16_json(body):
                return lambda route: route.fulfill(
                    status=200, content_type="application/json", body=body)

            g16.route("**/api/orwell/state", _g16_json(g16_state))
            g16.route("**/api/orwell/status", _g16_json(g16_status))
            g16.route("**/api/orwell/roster", _g16_json(g16_roster))
            g16.route("**/api/orwell/health", _g16_json('{"engine": true}'))
            g16.route("**/api/orwell/finale", _g16_json('{"finale": null}'))

            def _g16_wait_js(expr, label, tries=75):
                # CSP keeps 'unsafe-eval' off the page, so wait_for_function's
                # string predicate is blocked — poll through evaluate (CDP) instead.
                for _ in range(tries):
                    if g16.evaluate(expr):
                        return True
                    g16.wait_for_timeout(200)
                check(False, label)
                return False

            g16.goto(base + "/", wait_until="load", timeout=30000)
            g16.wait_for_selector("#orwell-status", state="visible", timeout=15000)
            # F1, the act: collapse the HUD via its header (trusted click).
            # #640: the status panel composes the OrwellGadget kit — its header is the kit's
            # .og-head and the collapsed class is the kit's .og-collapsed (the E71 per-user+game
            # persistence key is unchanged, owned by the panel via persistCollapsed:false).
            g16.click("#orwell-status .og-head")
            f1_keys = g16.evaluate("""() => {
              return {
                collapsed: document.getElementById('orwell-status').classList.contains('og-collapsed'),
                keys: Object.keys(localStorage).filter(k => k.startsWith('orwell-status-collapsed')),
                // R5/#1416: the app derives its per-user key via window.orwellUserKey, which keys
                // under 'local' in the no-auth smoke env (data-user empty). Compute the expected
                // key the SAME way the app writes it — never the raw dataset.user derivation.
                expected: 'orwell-status-collapsed:' + window.orwellUserKey('The Player'),
              };
            }""")
            check(f1_keys.get("collapsed") is True
                  and f1_keys.get("keys") == [f1_keys.get("expected")],
                  f"G16/F1: the collapse writes under the per-user+game key ({f1_keys})")
            # F2, the act: open the cast window via the seam, then DOCK it (#573 unification —
            # its minimize control docks the full window into the control room; trusted click).
            _g16_wait_js("typeof window._orwellCastEnsure === 'function' && !!window.OrwellWindowKit",
                         "G16: the cast seam + the kit mount")
            g16.evaluate("window._orwellCastEnsure()")
            g16.wait_for_selector("#orwell-cast", state="visible", timeout=15000)

            # L16: a cast portrait is full COLOR while active/jury and grayscale ONLY
            # once EVICTED. Inject the three roster states into the real grid and read
            # the computed filter off each card's portrait img — the eviction state is
            # the one and only monochrome treatment.
            l16 = g16.evaluate("""() => {
              const grid = document.querySelector('#orwell-cast #oc-grid');
              if (!grid) return { ok: false, why: 'no-grid' };
              const mk = (cls) => {
                const card = document.createElement('div');
                card.className = 'oc-hg ' + cls;
                const holder = document.createElement('div'); holder.className = 'oc-portrait';
                const img = document.createElement('img');
                img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
                holder.appendChild(img); card.appendChild(holder); grid.appendChild(card);
                return getComputedStyle(img).filter;
              };
              return { ok: true,
                       active: mk(''), jury: mk('oc-out'),
                       evicted: mk('oc-out oc-evicted') };
            }""")
            gray = lambda f: bool(f) and "grayscale" in f and "grayscale(0" not in f.replace(" ", "")
            check(l16.get("ok") is True and not gray(l16.get("active", ""))
                  and not gray(l16.get("jury", "")) and gray(l16.get("evicted", "")),
                  f"L16: cast portraits are color until EVICTED, then grayscale ({l16})")

            # M2-2: with ZERO image provider configured (this smoke run wires none), every
            # placeholder card renders the DESIGNED monogram from the shared kit — the
            # id-seeded gradient+pattern SVG — never a flat letter-rectangle or a blank.
            m22 = g16.evaluate("""() => {
              const grid = document.querySelector('#orwell-cast #oc-grid');
              if (!grid) return { ok: false, why: 'no-grid' };
              const phs = Array.from(grid.querySelectorAll('.oc-ph.oc-monogram'));
              const designed = phs.filter(el => el.querySelector('svg.ow-mono-svg'));
              const gradients = designed.filter(el => el.querySelector('linearGradient'));
              return { ok: true, kit: !!window.OrwellMonogram,
                       placeholders: phs.length, designed: designed.length,
                       gradients: gradients.length };
            }""")
            check(m22.get("ok") is True and m22.get("kit") is True
                  and m22.get("placeholders", 0) > 0
                  and m22.get("designed") == m22.get("placeholders")
                  and m22.get("gradients") == m22.get("placeholders"),
                  f"M2-2: zero-provider cast renders the DESIGNED monogram on every placeholder ({m22})")

            # F2 — #573 GESTURE UNIFICATION: the cast is a DOCKABLE window, so its minimize IS
            # the dock (one gesture, one destination — the control room). The minimize control
            # DOCKS the full cast window into the gadget rail (mounts into #gadget-rail-body as a
            # static .ow-docked window), never a chip in a separate strip; the docked flag
            # persists per user+id and survives a reload; undocking (⇱) floats it back. This
            # block drives that docked-refresh cycle FOR REAL.
            g16.click("#orwell-cast .ow-min")
            g16.wait_for_selector(  # the dock re-home mounts the full window into the rail body
                "#gadget-rail-body > #orwell-cast.ow-docked", timeout=5000)
            # R5/#1416b: read the docked flag via the shared helper (the key the app now writes).
            f2_flag = g16.evaluate(
                "localStorage.getItem(window.orwellUserKey('orwell-orwell-cast-docked'))")
            check(f2_flag == "1", f"G16/F2: minimize DOCKS the cast and persists the docked flag ({f2_flag!r})")
            f2_dock = g16.evaluate("""() => {
              const cast = document.getElementById('orwell-cast');
              const body = document.getElementById('gadget-rail-body');
              const rail = document.getElementById('gadget-rail');
              return {
                docked: !!cast && cast.classList.contains('ow-docked'),
                inRailBody: !!(cast && body && body.contains(cast)),
                visible: !!cast && getComputedStyle(cast).display !== 'none',
                railShown: !!rail && !rail.hasAttribute('hidden'),
                noChip: !document.querySelector('#minimized-dock .minimized-dock-chip[data-modal-id="orwell-cast"]'),
              };
            }""")
            check(f2_dock.get("docked") is True and f2_dock.get("inRailBody") is True
                  and f2_dock.get("visible") is True and f2_dock.get("railShown") is True
                  and f2_dock.get("noChip") is True,
                  f"G16/F2: the cast docks into the (shown) control room, no chip parked ({f2_dock})")

            # RELOAD #1 — the whole point: both states must survive the refresh.
            g16.reload(wait_until="load", timeout=30000)
            g16.wait_for_selector("#orwell-status", state="visible", timeout=15000)
            f1_after = g16.evaluate("""() => {
              const hud = document.getElementById('orwell-status');
              const hdr = hud && hud.querySelector('.og-head');  // #640: the kit's header
              return { collapsed: !!hud && hud.classList.contains('og-collapsed'),
                       expanded: hdr ? hdr.getAttribute('aria-expanded') : null };
            }""")
            check(f1_after.get("collapsed") is True and f1_after.get("expanded") == "false",
                  f"G16/F1: after a reload the status HUD is still collapsed ({f1_after})")
            # F2: re-open via the seam — the DOCKED window must come back DOCKED in the rail.
            _g16_wait_js("typeof window._orwellCastEnsure === 'function' && !!window.OrwellWindowKit",
                         "G16: the cast seam + the kit after reload #1")
            g16.evaluate("window._orwellCastEnsure()")
            g16.wait_for_selector("#gadget-rail-body > #orwell-cast.ow-docked", timeout=5000)
            after1 = g16.evaluate("""() => {
              const cast = document.getElementById('orwell-cast');
              const body = document.getElementById('gadget-rail-body');
              const rail = document.getElementById('gadget-rail');
              return {
                docked: !!cast && cast.classList.contains('ow-docked'),
                inRailBody: !!(cast && body && body.contains(cast)),
                visible: !!cast && getComputedStyle(cast).display !== 'none',
                railShown: !!rail && !rail.hasAttribute('hidden'),
              };
            }""")
            check(after1.get("docked") is True and after1.get("inRailBody") is True,
                  f"G16/F2: re-opened after a reload, the cast window comes back DOCKED ({after1})")
            check(after1.get("visible") is True and after1.get("railShown") is True,
                  f"G16/F2: after a reload the docked cast is visible in the shown rail ({after1})")
            # Undock via the float toggle (trusted click) — floats back, un-docked durably.
            g16.click("#orwell-cast .ow-dock")
            g16.wait_for_timeout(250)
            restored1 = g16.evaluate("""() => ({
              visible: getComputedStyle(document.getElementById('orwell-cast')).display !== 'none',
              undocked: !document.getElementById('orwell-cast').classList.contains('ow-docked'),
              // R5/#1416b: read the float flag via the shared helper (the key the app writes).
              flag: localStorage.getItem(window.orwellUserKey('orwell-orwell-cast-docked')),
            })""")
            check(restored1.get("visible") is True and restored1.get("undocked") is True
                  and restored1.get("flag") == "0",
                  f"G16/F2: undocking floats the cast back AND clears the docked flag ({restored1})")

            # RELOAD #2 — floated means floated: the seam must open it FLOATING + visible now.
            g16.reload(wait_until="load", timeout=30000)
            _g16_wait_js("typeof window._orwellCastEnsure === 'function' && !!window.OrwellWindowKit",
                         "G16: the cast seam + the kit after reload #2")
            g16.evaluate("window._orwellCastEnsure()")
            g16.wait_for_selector("#orwell-cast", state="visible", timeout=15000)
            after2 = g16.evaluate("""() => ({
              visible: getComputedStyle(document.getElementById('orwell-cast')).display !== 'none',
              floating: !document.getElementById('orwell-cast').classList.contains('ow-docked'),
              chipGone: !document.querySelector('#minimized-dock .minimized-dock-chip[data-modal-id="orwell-cast"]'),
            })""")
            check(after2.get("visible") is True and after2.get("floating") is True
                  and after2.get("chipGone") is True,
                  f"G16/F2: after undock + reload the cast window comes back OPEN (floating), no stale chip ({after2})")
            g16.close()

            # 0051 — IN-CHARACTER IMAGES render (the owed browser-render validation): with a
            # provider configured (roster.imagesAvailable:true) and a real portrait URL on a
            # card, the cast grid must render an actual <img> that is PRESENT, has the served
            # src, and is SIZED on screen (non-zero, ~square holder) — not a zero-box or a
            # bare placeholder glyph. Driven for REAL through the live fetch→render path
            # (_orwellCastEnsure → /api/orwell/roster) on an isolated routed page, so this is
            # the same code that paints the player's actual cast portraits. Vault-free: the
            # roster projection carries only public id/name/status + the portrait URL.
            por = new_page(browser)
            # a 1x1 transparent GIF data-URI stands in for a generated portrait file (no engine,
            # no network) — the renderer treats it like any portrait src.
            _PORTRAIT_URI = ("data:image/gif;base64,"
                             "R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==")
            por_roster = (
                '{"imagesAvailable": true, "portraitsTotal": 2, "portraitsPresent": 2, "roster": ['
                '{"id": "player", "name": "The Player", "status": "active", "isPlayer": true,'
                ' "portrait": "' + _PORTRAIT_URI + '"},'
                '{"id": "npc:1", "name": "A Houseguest", "status": "active",'
                ' "portrait": "' + _PORTRAIT_URI + '"}]}'
            )
            por.route("**/api/orwell/roster", _g16_json(por_roster))
            por.route("**/api/orwell/health", _g16_json('{"engine": true}'))
            por.goto(base + "/", wait_until="load", timeout=30000)
            _por_ok = False
            for _ in range(75):  # CSP blocks string-predicate wait_for_function; poll via evaluate
                if por.evaluate("typeof window._orwellCastEnsure === 'function'"):
                    _por_ok = True
                    break
                por.wait_for_timeout(200)
            check(_por_ok, "0051: the cast seam mounts (portrait render page)")
            por.evaluate("window._orwellCastEnsure()")
            por.wait_for_selector("#orwell-cast #oc-grid img", timeout=8000)
            por.wait_for_timeout(400)  # let the kit open animation settle before measuring geometry
            por_img = por.evaluate("""() => {
              const grid = document.querySelector('#orwell-cast #oc-grid');
              const imgs = grid ? [...grid.querySelectorAll('.oc-portrait img')] : [];
              if (!imgs.length) return { count: 0 };
              const r = imgs[0].getBoundingClientRect();
              const holder = imgs[0].closest('.oc-portrait').getBoundingClientRect();
              return {
                count: imgs.length,
                hasSrc: !!imgs[0].getAttribute('src'),
                w: Math.round(r.width), h: Math.round(r.height),
                hw: Math.round(holder.width), hh: Math.round(holder.height),
                // a placeholder glyph (the person silhouette) renders instead of an <img>
                // when no portrait — assert these cards are NOT falling back to placeholders.
                placeholders: grid.querySelectorAll('.oc-portrait .oc-ph').length,
              };
            }""")
            check(por_img.get("count", 0) >= 2 and por_img.get("hasSrc") is True,
                  f"0051: a real portrait <img> renders per cast card ({por_img})")
            check(por_img.get("w", 0) >= 40 and por_img.get("h", 0) >= 40,
                  f"0051: the portrait img is SIZED on screen (non-zero box) ({por_img})")
            # the holder is the square (aspect-ratio 1/1) frame — width and height track each
            # other (a collapsed/overflowing card would show a wildly non-square holder).
            _hw, _hh = por_img.get("hw", 0), por_img.get("hh", 0)
            check(_hw >= 40 and _hh >= 40 and abs(_hw - _hh) <= max(6, round(_hw * 0.12)),
                  f"0051: the portrait holder is a sized ~1:1 frame, no overflow ({por_img})")
            check(por_img.get("placeholders", 1) == 0,
                  f"0051: provider-on cards render the image, not the placeholder glyph ({por_img})")
            por.close()

            # 0057 — SEASONS-AS-LEVELS render (the owed browser-render validation): the season
            # progress bar, the "Season N" chip, and the persistent post-season "New season"
            # surface must actually render — bar present & ≤5px & no horizontal overflow; chip
            # reads "Season N" past season 1; the post-season window MOUNTS. Driven for REAL
            # through each module's live refresh against routed Vault-free projections
            # (/season, /status, /state) on an isolated page. The terminal state
            # (moment:"post-season") forces the bar to 100% AND triggers the new-season panel.
            sea = new_page(browser)
            sea.route("**/api/orwell/season", _g16_json('{"season": 3}'))  # past season 1 → chip
            sea.route("**/api/orwell/status",
                      _g16_json('{"started": true, "week": 9, "phase": "finale"}'))
            sea.route("**/api/orwell/state", _g16_json(
                '{"started": true, "week": 9, "phase": "finale", "moment": "post-season",'
                ' "player": {"id": "player", "name": "The Player", "status": "active"},'
                ' "house": [{"id": "npc:1", "name": "A Houseguest", "status": "active"},'
                ' {"id": "npc:2", "name": "Another Houseguest", "status": "active"}]}'))
            sea.route("**/api/orwell/health", _g16_json('{"engine": true}'))
            sea.route("**/api/orwell/finale", _g16_json('{"finale": null}'))
            sea.goto(base + "/", wait_until="load", timeout=30000)
            _sea_ok = False
            for _ in range(75):
                if sea.evaluate("typeof window._orwellSeasonProgressEnsure === 'function'"
                                " && typeof window.orwellRefreshSeasonProgress === 'function'"):
                    _sea_ok = True
                    break
                sea.wait_for_timeout(200)
            check(_sea_ok, "0057: the season-progress seam + refresh mount")
            sea.evaluate("window.orwellRefreshSeasonProgress()")  # real refresh against the routes
            sea.wait_for_selector("#orwell-season-progress", timeout=8000)
            sea.wait_for_timeout(700)  # the .5s fill transition + the chip's settle reflow
            sea_bar = sea.evaluate("""() => {
              const bar = document.getElementById('orwell-season-progress');
              if (!bar) return { present: false };
              const r = bar.getBoundingClientRect();
              const fill = bar.querySelector('.osp-fill');
              const fr = fill ? fill.getBoundingClientRect() : null;
              return {
                present: true,
                visible: getComputedStyle(bar).display !== 'none',
                h: Math.round(r.height),
                w: Math.round(r.width),
                vw: window.innerWidth,
                role: bar.getAttribute('role'),
                valuenow: parseInt(bar.getAttribute('aria-valuenow') || '-1', 10),
                // post-season ⇒ fill at 100%, so the fill width tracks the bar width.
                fullFill: !!fr && r.width > 0 && fr.width >= r.width - 2,
                // the page itself must not scroll horizontally because of the bar.
                pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              };
            }""")
            check(sea_bar.get("present") is True and sea_bar.get("visible") is True
                  and sea_bar.get("role") == "progressbar",
                  f"0057: the season progress bar renders (a progressbar) ({sea_bar})")
            check(0 < sea_bar.get("h", 0) <= 5,
                  f"0057: the progress bar is a thin (<=5px) bar ({sea_bar})")
            check(sea_bar.get("w", 0) >= sea_bar.get("vw", 0) - 2 and sea_bar.get("pageOverflow", 99) <= 1,
                  f"0057: the bar spans the viewport WITHOUT adding a horizontal scrollbar ({sea_bar})")
            check(sea_bar.get("valuenow", -1) == 100 and sea_bar.get("fullFill") is True,
                  f"0057: post-season forces the fill to 100% ({sea_bar})")
            sea_chip = sea.evaluate("""() => {
              const chip = document.getElementById('orwell-season-chip');
              if (!chip) return { present: false };
              const r = chip.getBoundingClientRect();
              return { present: true, visible: getComputedStyle(chip).display !== 'none',
                       text: (chip.textContent || '').trim(),
                       right: Math.round(r.right), vw: window.innerWidth, top: Math.round(r.top) };
            }""")
            check(sea_chip.get("present") is True and sea_chip.get("visible") is True
                  and sea_chip.get("text") == "Season 3",
                  f"0057: the 'Season N' chip renders past season 1 ({sea_chip})")
            check(sea_chip.get("right", 99999) <= sea_chip.get("vw", 0) + 1 and sea_chip.get("top", -1) >= 0,
                  f"0057: the season chip sits inside the viewport (no overflow/overlap) ({sea_chip})")
            # the persistent post-season "New season" surface MOUNTS on the terminal state.
            _ns_ok = False
            for _ in range(75):
                if sea.evaluate("typeof window._orwellNewSeasonRefresh === 'function'"
                                " && !!window.OrwellWindowKit"):
                    _ns_ok = True
                    break
                sea.wait_for_timeout(200)
            check(_ns_ok, "0057: the new-season seam + the window kit mount")
            sea.evaluate("window._orwellNewSeasonRefresh()")  # real post-season gate + show()
            sea.wait_for_selector("#orwell-new-season", state="visible", timeout=8000)
            sea.wait_for_timeout(300)  # kit open animation
            sea_ns = sea.evaluate("""() => {
              const el = document.getElementById('orwell-new-season');
              if (!el) return { mounted: false };
              const r = el.getBoundingClientRect();
              return {
                mounted: true,
                visible: getComputedStyle(el).display !== 'none',
                kit: el.hasAttribute('data-ow-window'),
                keep: !!el.querySelector('[data-keep="1"]'),
                recast: !!el.querySelector('[data-keep="0"]'),
                w: Math.round(r.width), h: Math.round(r.height),
                // inside the viewport (the vault/new-season slot-collision fix) — never stranded.
                inView: r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1
                        && r.left >= -1 && r.top >= -1,
              };
            }""")
            check(sea_ns.get("mounted") is True and sea_ns.get("visible") is True
                  and sea_ns.get("kit") is True,
                  f"0057: the post-season 'New season' surface mounts (kit window) ({sea_ns})")
            check(sea_ns.get("keep") is True and sea_ns.get("recast") is True,
                  f"0057: it offers keep + recast ({sea_ns})")
            check(sea_ns.get("w", 0) >= 40 and sea_ns.get("h", 0) >= 40 and sea_ns.get("inView") is True,
                  f"0057: the new-season window is sized and inside the viewport (no overflow) ({sea_ns})")
            sea.close()

            # #642: the engine-down banner MIGRATED onto the OrwellNotice kit (a top-banner
            # system-notice). It is NOW non-dismissable (dismissible:false): an honest outage signal
            # auto-hides on health and must never carry a × the player could use to bury a real
            # problem. So the kit renders NO .on-dismiss affordance for this banner.
            page.evaluate("window.orwellRefreshEngineStatus && window.orwellRefreshEngineStatus()")
            page.wait_for_timeout(600)
            ban = page.evaluate("""() => {
              const card = document.querySelector('#orwell-engine-status');
              if (!card) return { present: false };
              return { present: true, hasDismiss: !!card.querySelector('.on-dismiss') };
            }""")
            if ban.get("present"):
                check(ban.get("hasDismiss") is False,
                      f"#642: engine-status banner is non-dismissable (no .on-dismiss ×) ({ban})")

            # F-3 (the ratchet, runtime half): every window-like surface on the page
            # is KIT-MANAGED — floating game panels carry [data-ow-window], and the
            # bespoke-chrome marker ('Drag to move' titlebars outside the kit) is extinct.
            ratchet = page.evaluate("""() => {
              const panels = ['orwell-finale']
                .map(id => document.getElementById(id)).filter(Boolean);
              const unkitted = panels.filter(el => !el.hasAttribute('data-ow-window')).map(el => el.id);
              const bespoke = [...document.querySelectorAll('[title="Drag to move"]')]
                .filter(el => !el.closest('[data-ow-window]')).length;
              const kitStack = window.OrwellWindowKit ? window.OrwellWindowKit.stackIds() : null;
              return { panels: panels.length, unkitted, bespoke,
                       kitStack: Array.isArray(kitStack) };
            }""")
            check(ratchet.get("unkitted") == [] and ratchet.get("bespoke") == 0,
                  f"F-3: every window-like surface is kit-managed ({ratchet})")
            check(ratchet.get("kitStack") is True, "F-3: the kit seam answers (stackIds)")

            # #737 (runtime half): GENERALIZE the F-3 window ratchet past windows, driven by
            # the surface_registry.json manifest. The SOURCE-side drift guard
            # (tests/test_737_surface_registry.py) proves the manifest matches the JS source;
            # this is its RUNTIME mirror. It censuses every player-tier surface family actually
            # MOUNTED in the live DOM — windows, rail-gadgets, above-composer notices, bottom
            # sheets, … — family-AGNOSTICALLY (it does not know the families in advance), then
            # proves each mounted surface resolves to a REGISTERED family / its kit seam. A
            # mounted surface whose family is not in the manifest FAILS, exactly the way the
            # source drift guard refuses an unregistered kit — but observed live. This is NOT
            # #113's visual/screenshot matrix (that is pixels); it is a structural DOM/kit-
            # membership census. Robust by design: a surface family simply NOT present in this
            # smoke run is not a failure — only a PRESENT-but-unregistered family fails.
            _reg_arg = _surface_registry_arg()
            registry_census = page.evaluate(
                """(reg) => {
                  const registeredClasses = new Set(reg.map(f => f.cls));
                  const registeredKitSeams = new Set(
                    reg.filter(f => f.kind === 'kit' && f.seam).map(f => f.seam));
                  const familyByClass = {};
                  reg.forEach(f => { familyByClass[f.cls] = f; });

                  // (A) Runtime seam census — the family-AGNOSTIC mirror of the source drift
                  //     guard's `_defined_kit_seams()`: every `window.Orwell*Kit` composition
                  //     object actually LOADED on this page (regex mirrors _KIT_DEF_RX).
                  const loadedKits = Object.keys(window).filter(
                    k => /^Orwell[A-Za-z0-9]+Kit$/.test(k)
                         && window[k] && typeof window[k] === 'object');

                  // (B) DOM-mounted surface-root census (family-AGNOSTIC). Every kit stamps a
                  //     BOOLEAN `data-<ns>-<name>` marker on each surface ROOT, and the root
                  //     also carries a `<ns>-*` primary class + the kit anatomy (a
                  //     `.<ns>-body`/`.<ns>-head` region, or a card/window/sheet-shaped class).
                  //     We find every such root WITHOUT knowing the family in advance, then
                  //     resolve its primary class against the manifest. (Kit-INTERNAL markers
                  //     carry a value — e.g. data-ow-scrim="<id>", data-on-kind="info" — so the
                  //     empty-value test skips them.)
                  const MARK_RX = /^data-([a-z][a-z0-9]{1,4})-[a-z][a-z0-9-]*$/;
                  const roots = [];
                  document.querySelectorAll('*').forEach(el => {
                    for (let i = 0; i < el.attributes.length; i++) {
                      const at = el.attributes[i];
                      if (at.value !== '') continue;         // root markers are boolean
                      const m = at.name.match(MARK_RX);
                      if (!m) continue;
                      const ns = m[1];
                      const primary = Array.prototype.find.call(
                        el.classList, c => c.startsWith(ns + '-'));
                      if (!primary) continue;
                      // A genuine surface ROOT carries the kit anatomy (a `.<ns>-body`/
                      // `.<ns>-head` region) OR a surface-shaped primary class. This filters
                      // decorative/animation elements that merely happen to carry a boolean
                      // `data-<ns>-*` marker + an `<ns>-*` state class (e.g. the blinking-eye
                      // lid: data-eye-lid + .eye-blinking) — position alone is too loose.
                      const structural =
                        el.querySelector('.' + ns + '-body, .' + ns + '-head')
                        || registeredClasses.has(primary)
                        || /-(card|window|sheet|panel|dialog|gadget|popover|modal|drawer)$/
                             .test(primary);
                      if (!structural) continue;
                      roots.push({ id: el.id || null, cls: primary, marker: at.name });
                      break;                                  // one root per element
                    }
                  });

                  const unregistered = roots
                    .filter(r => !registeredClasses.has(r.cls))
                    .map(r => ({ id: r.id, cls: r.cls, marker: r.marker }));
                  const present = [...new Set(roots.map(r => r.cls))]
                    .filter(c => registeredClasses.has(c));

                  // (C) Resolve-to-seam: every MOUNTED registered KIT family must have its
                  //     declared `window.Orwell*Kit` seam actually loaded — proves the
                  //     "resolves to its kit seam" linkage is real, not vacuous.
                  const seamGaps = present
                    .map(c => familyByClass[c])
                    .filter(f => f && f.kind === 'kit' && f.seam
                                 && !(window[f.seam] && typeof window[f.seam] === 'object'))
                    .map(f => f.id);

                  // A LOADED kit seam the manifest does not register (a new kit shipped
                  // without registering) — the runtime mirror of the source drift guard.
                  const unregisteredLoadedKits = loadedKits.filter(
                    k => !registeredKitSeams.has(k));

                  return { rootsFound: roots.length, present, unregistered, seamGaps,
                           loadedKits, unregisteredLoadedKits };
                }""",
                _reg_arg,
            )
            check(registry_census.get("unregistered") == [],
                  "#737 runtime: every MOUNTED surface family resolves to a registered kit "
                  f"family (present={registry_census.get('present')}, "
                  f"unregistered={registry_census.get('unregistered')})")
            check(registry_census.get("seamGaps") == [],
                  "#737 runtime: every mounted kit family resolves to its loaded kit seam "
                  f"(seamGaps={registry_census.get('seamGaps')}, "
                  f"loadedKits={registry_census.get('loadedKits')})")
            check(registry_census.get("unregisteredLoadedKits") == [],
                  "#737 runtime: every LOADED window.Orwell*Kit seam is registered "
                  f"(unregisteredLoadedKits={registry_census.get('unregisteredLoadedKits')})")

            # L12: the cast roster can be PINNED into the control-room gadget rail as a
            # compact gadget — it mounts INTO #gadget-rail-body, the pinned state
            # persists, and un-pinning hides it. (Engine is down here, so we inject a
            # synthetic roster face to prove the gadget renders + reveals the rail.)
            l12 = page.evaluate("""() => {
              if (!window.OrwellCastPin) return { ok: false, why: 'no-seam' };
              window.OrwellCastPin.setPinned(true);
              const el = document.getElementById('orwell-cast-pin');
              if (!el) return { ok: false, why: 'no-gadget' };
              const railBody = document.getElementById('gadget-rail-body');
              const inRail = !!railBody && railBody.contains(el);
              // simulate a render landing (the live path fetches /api/orwell/roster)
              el.style.display = 'block';
              el.querySelector('[data-role="portraits"]').innerHTML =
                '<div class="ocp-face"><span class="ocp-ph">x</span></div>' +
                '<div class="ocp-face ocp-evicted"><span class="ocp-ph">x</span></div>';
              // R5/#1416b: read the pinned flag via the shared helper (the key the app now writes).
              const flag = localStorage.getItem(window.orwellUserKey('orwell-cast-pinned'));
              const faces = el.querySelectorAll('.ocp-face').length;
              return { ok: true, inRail, flag, faces,
                       hasUnpin: !!el.querySelector('[data-act="unpin"]') };
            }""")
            check(l12.get("ok") is True and l12.get("inRail") is True
                  and l12.get("flag") == "1" and l12.get("faces") == 2
                  and l12.get("hasUnpin") is True,
                  f"L12: the cast pins into the gadget rail as a compact 2-portrait gadget ({l12})")
            l12b = page.evaluate("""() => {
              window.OrwellCastPin.setPinned(false);
              const el = document.getElementById('orwell-cast-pin');
              // R5/#1416b: read the pinned flag via the shared helper (the key the app now writes).
              return { hidden: getComputedStyle(el).display === 'none',
                       flag: localStorage.getItem(window.orwellUserKey('orwell-cast-pinned')) };
            }""")
            check(l12b.get("hidden") is True and l12b.get("flag") in (None, "0"),
                  f"L12: un-pinning hides the gadget and the pin flag is un-set ({l12b})")

            # L13: the rail gadgets reorder and the order PERSISTS. Reorder now happens in an
            # explicit edit mode (iOS-jiggle / HASS-dashboard style) — a labeled header toggle
            # enters a mode where gadgets wiggle and become keyboard-focusable for ↑/↓ reorder,
            # and the WHOLE gadget is pointer-draggable (touch + mouse). NO persistent overlay grip
            # (it covered content). The controller's reorder seam persists the sequence per-user.
            l13 = page.evaluate("""() => {
              const body = document.getElementById('gadget-rail-body');
              const rail = document.getElementById('gadget-rail');
              if (!body || !rail) return { ok: false, why: 'no-body' };
              rail.setAttribute('data-collapsed', 'false');
              if (window._orwellStatusEnsure) window._orwellStatusEnsure();
              // a synthetic second gadget so there's something to reorder past
              let probe = document.getElementById('orwell-l13-probe');
              if (!probe) {
                probe = document.createElement('section');
                probe.id = 'orwell-l13-probe';
                probe.style.display = 'block';
                probe.textContent = 'probe';
                body.appendChild(probe);
              }
              if (!window.OrwellGadgetRail || !window.OrwellGadgetRail.reorder)
                return { ok: false, why: 'no-reorder-seam' };
              const before = window.OrwellGadgetRail.currentOrder();
              window.OrwellGadgetRail.reorder(before.slice().reverse());
              const after = window.OrwellGadgetRail.currentOrder();
              // R5/#1416: read the order under the SAME key the app writes it — via the shared
              // helper (keys under 'local' in the no-auth smoke env where data-user is empty).
              const saved = localStorage.getItem(window.orwellUserKey('orwell-gadget-order'));
              // Edit mode: the header toggle is labeled; entering it makes the gadgets
              // keyboard-focusable; no overlay grip covers content.
              const btn = document.getElementById('gadget-rail-rearrange');
              const rearrangeLabeled = !!(btn && btn.getAttribute('aria-label'));
              if (btn) btn.click();
              const editOn = rail.getAttribute('data-edit') === 'true';
              const focusable = Array.prototype.every.call(body.children,
                c => !c.id || c.getAttribute('tabindex') === '0');
              const noOverlayGrip = body.querySelectorAll('.grail-drag').length === 0;
              if (btn) btn.click();  // exit edit mode (cleanup)
              return { ok: true, reversed: after.join() === before.slice().reverse().join(),
                       saved: !!saved, savedHasProbe: !!saved && saved.indexOf('orwell-l13-probe') !== -1,
                       rearrangeLabeled, editOn, focusable, noOverlayGrip };
            }""")
            check(l13.get("ok") is True and l13.get("reversed") is True
                  and l13.get("saved") is True and l13.get("savedHasProbe") is True,
                  f"L13: rail gadgets reorder and the order persists ({l13})")
            check(l13.get("rearrangeLabeled") is True and l13.get("editOn") is True
                  and l13.get("focusable") is True and l13.get("noOverlayGrip") is True,
                  f"L13: rearrange mode — labeled toggle, keyboard-focusable gadgets, no overlay grip ({l13})")
            # clean up the synthetic probe so it can't bleed into later assertions
            page.evaluate("""() => {
              const p = document.getElementById('orwell-l13-probe'); if (p) p.remove();
              // R5/#1416: clean up under the same helper-derived key the app writes.
              localStorage.removeItem(window.orwellUserKey('orwell-gadget-order'));
            }""")

            # Side-swap (⇄): swaps the dock AND the nav sidebar in LOCKSTEP. The bug was two
            # unsynced side-systems — ⇄ slid the sidebar over via flex `order` but its hamburger
            # stayed stranded over the relocated dock (a "sideways caret under the hamburger"
            # overlap). The fix makes the sidebar side the single source of truth: ⇄ routes
            # through the sidebar swap and syncRailSide mirrors the dock to the OPPOSITE edge.
            page.evaluate("""() => { const sb = document.getElementById('sidebar'); if (sb) sb.classList.remove('hidden'); }""")
            swap = page.evaluate("""() => {
              const sb = document.getElementById('sidebar');
              const snap = () => ({ right: sb.classList.contains('right-side'),
                                    gs: document.body.getAttribute('data-gadget-side') });
              const before = snap();
              document.getElementById('gadget-rail-swap').click();
              const mid = snap();
              document.getElementById('gadget-rail-swap').click();  // swap back
              const after = snap();
              return { before, mid, after };
            }""")
            # one ⇄ flips the sidebar side AND mirrors the dock to the opposite edge together
            check(swap["mid"]["right"] != swap["before"]["right"]
                  and (swap["mid"]["gs"] == "left") == swap["mid"]["right"],
                  f"L-swap: ⇄ flips the sidebar side AND mirrors the dock opposite, in sync ({swap})")
            # a second ⇄ restores the original layout (idempotent round-trip)
            check(swap["after"]["right"] == swap["before"]["right"]
                  and swap["after"]["gs"] == swap["before"]["gs"],
                  f"L-swap: a second ⇄ restores the original sides ({swap})")

            # 0054 strip refactor: the COLLAPSED icon strip is derived from the gadget
            # registry, filtered to the gadgets actually mounted-and-visible, in the rail's
            # current order. Collapse the rail and assert the strip maps 1:1 (same ids, same
            # order) to the active gadget set, and that each icon carries its gadget id so a
            # click acts on THAT gadget (not a blanket expand).
            strip11 = page.evaluate("""() => {
              if (window._orwellStatusEnsure) window._orwellStatusEnsure();
              const api = window.OrwellGadgetRail;
              if (!api || !api.activeGadgets) return { ok: false, why: 'no-api' };
              const rail = document.getElementById('gadget-rail');
              const wasCollapsed = rail.getAttribute('data-collapsed') === 'true';
              const toggle = document.getElementById('gadget-rail-toggle');
              if (!wasCollapsed && toggle) toggle.click();   // enter the icon-strip mode
              const active = api.activeGadgets();
              const strip = api.stripGadgets();
              const allReg = strip.every(id => api.registry.some(g => g.id === id));
              if (!wasCollapsed && toggle) toggle.click();   // restore expanded
              return { ok: true, active: active, strip: strip,
                       match: active.join() === strip.join(), allReg: allReg };
            }""")
            check(strip11.get("ok") is True and strip11.get("match") is True
                  and strip11.get("allReg") is True and len(strip11.get("strip") or []) >= 1,
                  f"0054: collapsed strip maps 1:1 to active gadgets, in order ({strip11})")

            # G3 (sidebar coherence, ruling 2026-06-11): every VISIBLE sidebar button
            # measures the SAME computed padding as the New Chat / Search rows (the
            # .list-item standard), and no collapse chevron renders on a section with
            # <=1 visible child — under the game build the Tools children are all
            # trimmed away, so its chevron was a button that visibly did nothing.
            g3 = page.evaluate("""() => {
              const vis = el => el.getClientRects().length > 0;
              const buttons = [...document.querySelectorAll(
                '#sidebar .list-item, #sidebar .section-header-flex, ' +
                '#sidebar .user-bar-btn, #sidebar .user-bar-left'
              )].filter(vis);
              const pads = [...new Set(buttons.map(el => {
                const s = getComputedStyle(el);
                return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' ');
              }))];
              const deadChevrons = [...document.querySelectorAll('#sidebar .section')]
                .filter(sec => {
                  const kids = [...sec.children].filter(c => !c.classList.contains('section-header-flex'));
                  const shown = kids.filter(k => getComputedStyle(k).display !== 'none' && vis(k));
                  return shown.length <= 1 && [...sec.querySelectorAll('.section-collapse-btn')].some(vis);
                }).map(sec => sec.id || '(anonymous section)');
              return { buttons: buttons.length, pads, deadChevrons };
            }""")
            check(g3.get("buttons", 0) >= 4 and g3.get("pads") == ["8px 8px 8px 8px"],
                  f"G3: every visible sidebar button measures the one 8px padding standard ({g3})")
            check(g3.get("deadChevrons") == [],
                  f"G3: no collapse chevron renders on a <=1-visible-child section ({g3.get('deadChevrons')})")

            # G10: the cast roster composes the kit — open via the seam, prove the
            # chrome, and prove CLOSE actually closes (the bespoke version's close
            # was silently defeated by its own display:flex beating [hidden]).
            page.evaluate("window._orwellCastEnsure && window._orwellCastEnsure()")
            page.wait_for_timeout(400)
            cast = page.evaluate("""() => {
              const el = document.getElementById('orwell-cast');
              if (!el) return { mounted: false };
              return { mounted: true, kit: el.hasAttribute('data-ow-window'),
                       modal: el.getAttribute('aria-modal'),
                       controls: [...el.querySelectorAll('.ow-controls button')].map(b => b.getAttribute('aria-label')) };
            }""")
            check(cast.get("mounted") is True and cast.get("kit") is True,
                  f"G10: the cast window is kit-managed ({cast})")
            check(cast.get("modal") is None and "Close" in (cast.get("controls") or []) and "Minimize" in (cast.get("controls") or []),
                  f"G10: non-modal with the full kit cluster ({cast})")
            page.click("#orwell-cast .ow-close")
            page.wait_for_timeout(350)
            check(page.evaluate("!document.getElementById('orwell-cast')") is True,
                  "G10: close CLOSES (trusted click; the [hidden] defeat is dead)")

            # G15: event-driven freshness — a mutation-path completion must refresh the
            # status HUD NOW (one ~250ms debounce + a beat), never "at the next 20-30s
            # poll". The HUD listener holds a direct reference to its refresh(), so the
            # faithful in-page spy is that refresh's own observable act: the immediate
            # /api/orwell/status fetch (window.orwellRefreshStatus IS the same function —
            # wrapped too, for any caller that goes through the window seam). Exactly two
            # surfaces fetch the status route on the gamechanged wave (the HUD + the
            # decision re-arm, both pinned in pytest), so a >=2 delta inside the short
            # window distinguishes the event wave from a coincidental single poll tick.
            g15_armed = page.evaluate("""() => {
              window._g15 = { events: 0, statusFetches: 0, hudSeamCalls: 0 };
              window.addEventListener('orwell:gamechanged', () => { window._g15.events++; });
              const _fetch = window.fetch;
              window.fetch = function (u) {
                try { if (String(u).indexOf('/api/orwell/status') !== -1) window._g15.statusFetches++; } catch (_) {}
                return _fetch.apply(this, arguments);
              };
              if (typeof window.orwellRefreshStatus === 'function') {
                const _r = window.orwellRefreshStatus;
                window.orwellRefreshStatus = function () { window._g15.hudSeamCalls++; return _r.apply(this, arguments); };
              }
              return typeof window.orwellGameChanged === 'function';
            }""")
            check(g15_armed is True, "G15: the shared dispatcher (window.orwellGameChanged) is mounted")
            g15_direct = page.evaluate("""() => new Promise(res => {
              const ev0 = window._g15.events, f0 = window._g15.statusFetches;
              window.orwellGameChanged('smoke:burst-1');
              window.orwellGameChanged('smoke:burst-2');
              window.orwellGameChanged('smoke:burst-3');
              setTimeout(() => res({ events: window._g15.events - ev0,
                                     statusFetches: window._g15.statusFetches - f0 }), 900);
            })""")
            check(g15_direct.get("events") == 1,
                  f"G15: a burst of helper calls coalesces into ONE gamechanged (debounce) ({g15_direct})")
            check(g15_direct.get("statusFetches", 0) >= 2,
                  f"G15: the status HUD refresh fired event-driven, inside one debounce ({g15_direct})")
            # The decision card's POST path: a routed fake stands in for the engine, the
            # card's success branch must nudge the panels the same way.
            # TRANSPORT PIN: this probe's engine fake is an HTTP route — but when the WS
            # Phase-1 handshake happens to land (it races the per-tab session id, so it is
            # host-timing dependent), the card sends the decision as a WS FRAME the route fake
            # can never see, and the probe fails on fast hosts / passes on slow ones. Pin the
            # card to the HTTP branch for this probe only (the WS decision path has its own
            # gates: the ws lanes + mirror-parity); restored right after.
            page.evaluate("""() => {
              const ws = window.OrwellWs;
              if (ws && ws.isActive) { window._g15wsActive = ws.isActive; ws.isActive = () => false; }
            }""")
            try:
                page.route("**/api/orwell/decision",
                           lambda route: route.fulfill(status=200, content_type="application/json",
                                                       body='{"ok": true}'))
                page.evaluate("""window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: {
                    kind: 'eviction-vote', pick: 1, prompt: 'G15 smoke: cast your vote.',
                    options: [ {id:'npc:1',name:'A'}, {id:'npc:2',name:'B'} ] }}}));""")
                page.wait_for_selector("#orwell-decision-card .odec-opt", timeout=3000)
                g15_decision = page.evaluate("""() => new Promise(res => {
                  const ev0 = window._g15.events, f0 = window._g15.statusFetches;
                  const card = document.getElementById('orwell-decision-card');
                  card.querySelector('.odec-opt').click();
                  const confirm = card.querySelector('.odec-confirm');
                  const armed = !confirm.disabled;
                  confirm.click();
                  setTimeout(() => res({ armed,
                                         locked: (card.textContent || '').indexOf('Locked in') !== -1,
                                         events: window._g15.events - ev0,
                                         statusFetches: window._g15.statusFetches - f0 }), 1200);
                })""")
                check(g15_decision.get("armed") is True and g15_decision.get("locked") is True,
                      f"G15: the decision card's POST completed against the routed fake ({g15_decision})")
                check(g15_decision.get("events") == 1 and g15_decision.get("statusFetches", 0) >= 2,
                      f"G15: a bound decision refreshes the panels without waiting a poll period ({g15_decision})")
            finally:
                # Restore the transport pin + the routed fake even on a timeout/eval error —
                # a page left forced onto HTTP would contaminate the later same-page checks.
                page.unroute("**/api/orwell/decision")
                page.evaluate("""() => {
                  const ws = window.OrwellWs;
                  if (ws && window._g15wsActive) { ws.isActive = window._g15wsActive; delete window._g15wsActive; }
                  const c = document.getElementById('orwell-decision-card'); if (c) c.remove();
                  const b = document.getElementById('message'); if (b) b.value = '';
                }""")

            # G10 ratchet tightening: any close/minimize-shaped control inside a
            # fixed-position surface must belong to the kit or the legacy .modal family.
            rogue_chrome = page.evaluate("""() => {
              const out = [];
              document.querySelectorAll('button[aria-label="Close"], button[aria-label="Minimize"]').forEach(b => {
                let n = b.parentElement, fixed = null;
                while (n && n !== document.body) {
                  if (getComputedStyle(n).position === 'fixed') { fixed = n; break; }
                  n = n.parentElement;
                }
                if (!fixed) return;
                if (fixed.closest('[data-ow-window]') || fixed.closest('.modal') || fixed.id === 'minimized-dock'
                    || fixed.id === 'orwell-engine-status' || fixed.id === 'orwell-onboarding') return;
                out.push(fixed.id || fixed.className.toString().slice(0, 30));
              });
              return out;
            }""")
            check(rogue_chrome == [], f"F-3+: no bespoke window chrome outside the kit/.modal families ({rogue_chrome})")

            # Hamburger / sidebar alignment: on a phone viewport the hamburger must sit on
            # the SAME side as the sidebar, whichever side that is. A stale CSS rule used to
            # hard-pin the hamburger right on mobile, so a left sidebar left them mismatched.
            mob = new_page(browser, viewport={"width": 390, "height": 844})
            mob.goto(base + "/", wait_until="load", timeout=30000)
            mob.wait_for_timeout(2500)

            def ham_vs_sidebar(force_right):
                return mob.evaluate(
                    """(forceRight) => {
                      const sb = document.getElementById('sidebar');
                      const hb = document.getElementById('hamburger-btn');
                      if (!sb || !hb) return { ok: false, why: 'missing' };
                      sb.classList.toggle('right-side', forceRight);
                      sb.classList.remove('hidden');
                      if (window.syncRailSide) window.syncRailSide();
                      const hr = hb.getBoundingClientRect(), sr = sb.getBoundingClientRect();
                      const sideOf = (r) => (r.left + r.right) / 2 < window.innerWidth / 2 ? 'L' : 'R';
                      return { ham: sideOf(hr), sidebar: sideOf(sr) };
                    }""",
                    force_right,
                )

            left_state = ham_vs_sidebar(False)
            right_state = ham_vs_sidebar(True)
            check(left_state.get("ham") == left_state.get("sidebar") == "L",
                  f"mobile: hamburger follows a LEFT sidebar ({left_state})")
            check(right_state.get("ham") == right_state.get("sidebar") == "R",
                  f"mobile: hamburger follows a RIGHT sidebar ({right_state})")

            # E64 (ruling #3): the status panel is SIDEBAR CHROME — on a phone it lives
            # inside the off-canvas drawer, so it can never cover the composer at all.
            hud_geo = mob.evaluate("""() => {
              if (window._orwellStatusEnsure) window._orwellStatusEnsure();
              const el = document.getElementById('orwell-status');
              const rail = document.getElementById('gadget-rail-body');
              if (!el || !rail) return { ok: false, why: 'missing' };
              const cs = getComputedStyle(el);
              return { ok: true, inRail: rail.contains(el), fixed: cs.position === 'fixed' };
            }""")
            check(hud_geo.get("inRail") is True, f"mobile: status panel lives in the gadget rail ({hud_geo})")
            check(hud_geo.get("fixed") is False, f"mobile: status panel is never fixed-position ({hud_geo})")
            # F3 (wave 1, amended by H5): with The House folded into the sidebar, the
            # finale is the one mobile game sheet — the slot engine's narrow sheet host
            # still owns its position: full-width, below the top bar, clear of the
            # composer (the D2 collision rule on narrow).
            f3 = mob.evaluate("""() => {
              window._orwellFinaleEnsure && window._orwellFinaleEnsure();
              return new Promise(res => setTimeout(() => {
                const f = document.getElementById('orwell-finale').getBoundingClientRect();
                const ta = document.getElementById('message') || document.querySelector('#chat-form textarea');
                const c = ta ? ta.getBoundingClientRect() : null;
                res({ f: { top: f.top, bottom: f.bottom, w: f.width },
                      clearsComposer: !!c && f.bottom <= c.top });
              }, 350));
            }""")
            check(f3["f"]["w"] >= 370, f"F3: the finale sheet stays full-width ({f3})")
            check(f3.get("clearsComposer") is True, f"F3: the finale sheet never covers the composer ({f3})")
            mob.close()

            # H6: the Chats auto-sort control reads "Tidy" ONCE. It is a split
            # control — the main "★ Tidy" (AI) plus an options chevron that
            # reveals the no-AI cleanup sub-row — and that sub-row must carry
            # its own distinct label, never a second bare "Tidy". A fresh boot
            # has zero chats (the section is hidden+collapsed), so un-hiding it
            # is the setup; the chevron clicks are real.
            #
            # #1638: the session-sort menu migrated onto OrwellMenuKit — clicking
            # #session-sort-btn body-appends a `.ow-popover[role=menu]` surface, and the
            # Tidy split-control (its #auto-sort-sessions-more / #auto-sort-sessions-noai-btn
            # children preserved) is re-parented into a menu row via the kit's render()
            # escape hatch. The H6 dedupe intent is unchanged; the DOM anchor is the kit
            # surface, not the retired #session-sort-dropdown tray.
            page.evaluate("""() => {
              const sec = document.getElementById('sessions-section');
              if (sec) sec.classList.remove('hidden', 'collapsed');
            }""")
            # the kit wires the trigger asynchronously (orwellMenu.js loads after app.js) —
            # attach() stamps aria-haspopup='menu' the moment it binds.
            page.wait_for_function(
                "() => { const b = document.getElementById('session-sort-btn');"
                " return b && b.getAttribute('aria-haspopup') === 'menu'; }"
            )
            page.click("#session-sort-btn")
            page.wait_for_selector(".ow-popover[role='menu']", timeout=3000)

            def h6_visible_tidy_labels():
                return page.evaluate("""() => {
                  const vis = el => el.getClientRects().length > 0 &&
                                    getComputedStyle(el).display !== 'none';
                  const out = [];
                  document.querySelectorAll('.ow-popover[role="menu"] *').forEach(el => {
                    if (!vis(el)) return;
                    const own = [...el.childNodes].filter(n => n.nodeType === 3)
                      .map(n => n.textContent).join(' ');
                    if (/\\bTidy\\b/.test(own)) out.push(el.id || el.className || el.tagName);
                  });
                  return out;
                }""")

            # the kit mounted exactly one menu surface carrying the Tidy split-control.
            h6_mount = page.evaluate("""() => {
              const surfaces = document.querySelectorAll('.ow-popover[role="menu"]');
              return { count: surfaces.length,
                       hasTidy: !!document.querySelector('.ow-popover[role="menu"] #auto-sort-sessions-btn'),
                       hasMore: !!document.querySelector('.ow-popover[role="menu"] #auto-sort-sessions-more') };
            }""")
            check(h6_mount.get("count") == 1 and h6_mount.get("hasTidy") is True
                  and h6_mount.get("hasMore") is True,
                  f"#1638: the session-sort menu mounts one kit surface holding the Tidy control ({h6_mount})")

            h6_closed = h6_visible_tidy_labels()
            check(h6_closed == ["auto-sort-icon"],
                  f"H6: ONE visible Tidy affordance with the options sub-row closed ({h6_closed})")
            page.click(".ow-popover[role='menu'] #auto-sort-sessions-more")  # the chevron reveals the no-AI sub-row
            page.wait_for_timeout(250)
            h6_open = h6_visible_tidy_labels()
            check(h6_open == ["auto-sort-icon"],
                  f"H6: STILL exactly one visible 'Tidy' with the sub-row expanded ({h6_open})")
            h6_noai = page.evaluate("""() => {
              const el = document.querySelector('.ow-popover[role="menu"] #auto-sort-sessions-noai-btn');
              if (!el) return { present: false };
              return { present: true,
                       visible: el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none',
                       text: (el.textContent || '').replace(/\\s+/g, ' ').trim() };
            }""")
            check(h6_noai.get("visible") is True and h6_noai.get("text", "").startswith("Clean up"),
                  f"H6: the revealed sub-row is the distinctly-labeled no-AI cleanup ({h6_noai})")
            page.evaluate("""() => {
              if (window.OrwellMenuKit) window.OrwellMenuKit.closeAll();
              const noai = document.getElementById('auto-sort-sessions-noai-btn');
              if (noai) noai.style.display = 'none';
              document.getElementById('sessions-section').classList.add('hidden', 'collapsed');
            }""")

            # H4 (sidebar icons): the collapsed rail's icons ALWAYS match the
            # expanded rows — single icon source. Every rail button is a clone
            # of its data-rail-source row's svg (sidebar-layout.js
            # syncRailIcons), and the JS-injected game chrome (Diary Room /
            # Cast / the status HUD) gets a mirrored rail button the same way.
            # Collapse the sidebar for REAL (the hamburger), then compare
            # per-entry drawing signatures between the two states.
            page.evaluate("""() => {  // clear floaters that could sit over the hamburger
              // The engine-status top-banner is non-dismissable now (commit 377110a:
              // dismissible:false — an honest outage signal, no × to wave it away), so there is
              // NO .on-dismiss to click. The REAL fix is the layout: .hamburger-btn now yields to
              // the banner via --on-banner-inset (style.css), dropping BELOW the banner's
              // pointer-intercepting full-width card so the click always lands. We additionally
              // hide the banner host here so this icon-parity assertion isn't height-sensitive on
              // a short viewport — but the click no longer DEPENDS on it (see the local repro that
              // proves #hamburger-btn is clickable with the banner up).
              const dismiss = document.querySelector('#orwell-engine-status .on-dismiss');
              if (dismiss) { dismiss.click(); return; }
              const host = document.getElementById('orwell-notice-banner');
              if (host) host.style.display = 'none';
            }""")
            page.wait_for_timeout(350)
            page.click("#hamburger-btn")
            page.wait_for_timeout(400)
            h4 = page.evaluate("""() => {
              const rail = document.getElementById('icon-rail');
              const sidebar = document.getElementById('sidebar');
              const railShown = rail && getComputedStyle(rail).display !== 'none';
              const collapsed = sidebar && sidebar.classList.contains('hidden');
              const GEOM = ['d','points','cx','cy','r','rx','ry','x','y','x1','y1','x2','y2','width','height'];
              const sig = (svg) => !svg ? null :
                [...svg.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse')]
                  .map(n => n.tagName + ':' + GEOM.map(a => n.getAttribute(a) || '').join(','))
                  .join('|');
              const iconSel = { 'rail-game-status': '.og-head svg' };  // #640: the kit header
              const entries = [...rail.querySelectorAll('.icon-rail-btn[data-rail-source]')].map(btn => {
                const src = document.getElementById(btn.dataset.railSource);
                const srcSvg = src && src.querySelector(iconSel[btn.id] || 'svg');
                return { id: btn.id,
                         visible: btn.getClientRects().length > 0,
                         hasIcon: !!btn.querySelector(':scope > svg'),
                         match: srcSvg ? sig(btn.querySelector(':scope > svg')) === sig(srcSvg) : null };
              });
              const mirrors = ['rail-diary-room', 'rail-cast', 'rail-game-status'].map(id => {
                const b = document.getElementById(id);
                const src = b && document.getElementById(b.dataset.railSource);
                return { id, exists: !!b, hasIcon: !!(b && b.querySelector('svg')),
                         gateMirrors: !!b && !!src &&
                           ((getComputedStyle(src).display === 'none') === (getComputedStyle(b).display === 'none')) };
              });
              return { railShown, collapsed,
                       total: entries.length,
                       comparedVisible: entries.filter(e => e.visible && e.match === true).length,
                       mismatch: entries.filter(e => e.match === false).map(e => e.id),
                       naked: entries.filter(e => e.visible && !e.hasIcon).map(e => e.id),
                       mirrors };
            }""")
            check(bool(h4.get("collapsed")) and bool(h4.get("railShown")),
                  f"H4: the hamburger collapses the sidebar to the icon rail ({h4.get('collapsed')}/{h4.get('railShown')})")
            check(h4.get("mismatch") == [],
                  f"H4: every rail icon EQUALS its expanded row's icon — same glyph both states ({h4.get('mismatch')})")
            check(h4.get("naked") == [],
                  f"H4: no visible paired rail button renders without its icon ({h4.get('naked')})")
            check(h4.get("comparedVisible", 0) >= 3,
                  f"H4: the comparison covered the visible rail ({h4.get('comparedVisible')} of {h4.get('total')} paired entries)")
            check(all(m["exists"] and m["hasIcon"] and m["gateMirrors"] for m in h4.get("mirrors", [])),
                  f"H4: injected game chrome (Diary Room / Cast / status HUD) gets gated rail mirrors with icons ({h4.get('mirrors')})")
            page.click("#hamburger-btn")  # restore the expanded sidebar
            page.wait_for_timeout(250)

            # G13 (gating cascades — the trim-zombie walk): the game build must
            # hide PARENTS/launchers with their items (the G3 Tools-chevron rule
            # generalized to the rest of the chrome): no shortcuts-modal row
            # names a dropped vertical, no overflow/export entry is present
            # whose handler is the build-refusal path, no empty non-admin
            # settings tab button renders, and the build's own trimmed
            # launchers stay invisible. The dropped list is DERIVED from the
            # build's own sources (src.settings + game-trim.css) — never typed
            # into this gate.
            import re as _re
            if ROOT not in sys.path:
                sys.path.insert(0, ROOT)
            from src.settings import GAME_DROP_SET, dropped_script_srcs
            g13_tokens = sorted(GAME_DROP_SET)
            g13_voice_dropped = any("tts-ai" in s for s in dropped_script_srcs())
            if g13_voice_dropped:
                g13_tokens += ["tts", "voice"]
            g13_rx = _re.compile(
                r"\b(" + "|".join(t.replace("_", "[ _-]") for t in g13_tokens) + r")\b",
                _re.IGNORECASE)

            def g13_zombies(labels):
                return [l for l in labels if g13_rx.search(l or "")]

            # (a) the chrome menus: an entry whose action the build refuses is
            # GONE from the DOM (hidden, never click-refused) — and the menus
            # keep their keep-set entries, so the trigger cascade must NOT have
            # over-hidden the launchers themselves.
            check(page.evaluate("!document.getElementById('export-doc-btn')") is True,
                  "G13: the export entry whose handler posts into a dropped vertical is removed from the DOM")
            if g13_voice_dropped:
                check(page.evaluate("!document.getElementById('overflow-tts-btn')") is True,
                      "G13: the TTS overflow entry goes with its unshipped voice module")
            # #1638: the composer overflow "+" wiring is DEFERRED — OrwellMenuKit.attach waits for the
            # sibling orwellMenu.js module to register the global (a setTimeout retry), and only then
            # sets aria-haspopup='menu'. Wait for that to settle before the kitWired + restore-path
            # probes so they aren't racing init (bounded + non-fatal — the checks below still report
            # accurately if it never settles, and the pre-#1638 checks in this block are unaffected).
            try:
                page.wait_for_function(
                    "() => document.getElementById('overflow-plus-btn') "
                    "&& typeof window._refreshOverflowChevron === 'function' "
                    "&& window.OrwellMenuKit "
                    "&& document.getElementById('overflow-plus-btn').getAttribute('aria-haspopup') === 'menu'",
                    timeout=5000)
            except Exception:
                pass
            g13_menus = page.evaluate("""() => {
              const vis = el => el && !el.hidden && getComputedStyle(el).display !== 'none';
              // #795: the top-center conversation caret DROPDOWN is gone — the only title-bar
              // affordance is a pencil that renames the current conversation inline. (Its
              // export sub-menu no longer exists in the title bar, so there is nothing to open.)
              const renamePencil = document.getElementById('topbar-rename-btn');
              // #1638: the composer overflow "+" now mounts through OrwellMenuKit — the kit
              // body-appends a .ow-popover[role=menu] surface (the role lives on .ow-popover; its
              // .ow-menu list holds the .ow-menu-item rows) and sets aria-haspopup='menu' + toggles
              // aria-expanded on the trigger. There is NO static #overflow-menu / .overflow-menu-item
              // anymore; the item set is built dynamically and the game-build gating lives in the
              // builder (buildOverflowItems) — so under the game build the "+" builds ZERO items and
              // its chevron is hidden (the G13 empty-chevron cascade, now builder-driven).
              const ovfTrigger = document.getElementById('overflow-plus-btn');
              const kitWired = ovfTrigger ? ovfTrigger.getAttribute('aria-haspopup') === 'menu' : false;
              let owMenuMounted = false;
              let ariaExpanded = ovfTrigger ? ovfTrigger.getAttribute('aria-expanded') : null;
              // The trigger is hidden under the game build (empty menu), so this only opens the kit
              // menu when the "+" is actually visible (the full build). Read the item labels from the
              // kit surface, not the retired #overflow-menu.
              if (vis(ovfTrigger)) {
                ovfTrigger.click();
                owMenuMounted = !!document.querySelector('.ow-popover[role="menu"]');
                ariaExpanded = ovfTrigger.getAttribute('aria-expanded');
              }
              const ovf = [...document.querySelectorAll('.ow-popover[role="menu"] .ow-menu-item')]
                .filter(vis).map(i => (i.textContent || '').replace(/\\s+/g, ' ').trim());
              // #831 (supersedes #760's paperclip): in the game build the SINGLE attach affordance
              // is the send button itself — an EMPTY composer paints it as a "+" in mode 'attach'
              // (opens the file picker); the standalone composer paperclip is dropped. Empty the
              // composer + refresh the icon so the probe reads the attach state deterministically,
              // regardless of any restored draft left by an earlier step.
              const msg = document.getElementById('message');
              if (msg) { msg.value = ''; try { msg.dispatchEvent(new Event('input', {bubbles: true})); } catch (_) {} }
              try { window._updateSendBtnIcon && window._updateSendBtnIcon(); } catch (_) {}
              const sendBtn = document.querySelector('.send-btn');
              const attachPaperclip = document.getElementById('composer-attach-btn');
              return { overflow: ovf,
                       renamePencilVisible: vis(renamePencil),
                       exportDropdownGone: !document.getElementById('export-dl-btn')
                                           && !document.getElementById('export-dropdown-menu'),
                       overflowTrigger: vis(ovfTrigger),
                       kitWired: kitWired,
                       owMenuMounted: owMenuMounted,
                       ariaExpanded: ariaExpanded,
                       sendAttachMode: sendBtn ? (sendBtn.dataset.mode || '') : null,
                       sendAttachTitle: sendBtn ? (sendBtn.title || '') : null,
                       paperclipGone: !vis(attachPaperclip),
                       trayAttachPresent: !!document.getElementById('overflow-attach-btn') };
            }""")
            page.keyboard.press("Escape")  # fold the overflow menu back
            page.evaluate("document.body.click()")  # and dismiss any open popup
            page.wait_for_timeout(500)
            # #795: the title bar carries a rename pencil and NO conversation dropdown switcher.
            check(g13_menus["renamePencilVisible"] is True,
                  "G13/#795: the title-bar rename pencil (#topbar-rename-btn) is visible")
            check(g13_menus["exportDropdownGone"] is True,
                  "G13/#795: the top-center caret 'More' dropdown is gone (no dropdown switcher)")
            # #1638: the composer overflow "+" is wired through OrwellMenuKit — its attach() sets
            # aria-haspopup='menu' on the trigger regardless of the trigger's own visibility, so this
            # positive "the kit is wired" check holds even under the game build (where the chevron is
            # hidden because the builder yields zero items).
            check(g13_menus["kitWired"] is True,
                  "#1638: the composer overflow '+' is wired through OrwellMenuKit "
                  "(aria-haspopup='menu' on #overflow-plus-btn)")
            # G13 re-expressed against the kit DOM: the gated entries (Attach files / TTS Mode)
            # never appear under the game build — the builder drops them — so there is no zombie
            # entry whose handler lands on a build-refusal path.
            check(g13_zombies(g13_menus["overflow"]) == [],
                  f"G13: no overflow item present whose handler is the refusal path ({g13_zombies(g13_menus['overflow'])})")
            # The cascade is HIDE-ONLY and emptiness-driven (the G3 Tools-chevron rule): a menu WITH
            # keep-set items keeps its trigger; a menu the builder empties (here, the game build drops
            # attach → the send-button "+" — and tts → its unshipped voice module) has its trigger
            # correctly hidden — never over-hidden, never left as a zombie that opens nothing. Now that
            # the menu is builder-driven the item read comes from the kit surface (.ow-popover[role=menu]
            # .ow-menu-item), not the retired #overflow-menu. So: trigger-visible IFF the menu builds
            # visible items.
            overflow_has_items = len(g13_menus["overflow"]) >= 1
            check(g13_menus["overflowTrigger"] is overflow_has_items,
                  "G13: the overflow chevron is visible IFF its menu builds keep-set items "
                  "(emptiness-driven + reversible — a non-empty menu keeps its trigger; an emptied "
                  "one hides it) "
                  f"(items={g13_menus['overflow']}, trigger={g13_menus['overflowTrigger']})")
            # And when the "+" IS visible (the full build), clicking it must mount the kit menu
            # surface + flip the trigger's aria-expanded — the kit's role=menu contract. (Skipped
            # when the chevron is hidden under the game build, where the two G13 checks above are the
            # load-bearing assertions.)
            check((not g13_menus["overflowTrigger"])
                  or (g13_menus["owMenuMounted"] is True and g13_menus["ariaExpanded"] == "true"),
                  "#1638: opening the visible '+' mounts the kit .ow-popover[role=menu] surface and "
                  f"sets aria-expanded=true (mounted={g13_menus['owMenuMounted']}, expanded={g13_menus['ariaExpanded']!r})")
            # #1638 restore-path (Greptile/CodeRabbit): the empty-chevron cascade MUST be REVERSIBLE —
            # a builder that goes empty→non-empty must UN-HIDE the "+", else the menu is permanently
            # unreachable (the hide-only bug). The existing probe above can't catch it: the game-build
            # builder is legitimately empty (attach/tts/mirrors all dropped/guarded), so it never has a
            # non-empty state to restore FROM. Drive the ONE builder branch reachable under the game
            # build — the TTS gate — to force non-empty (a <script src="data:…tts-ai.js"> + the
            # _overflowTtsEnabled flag; no network), prove the "+" is RESTORED + opens, then restore the
            # empty state so the G13 intent stays intact for the rest of the run.
            restore = page.evaluate("""() => {
              const vis = el => el && !el.hidden && getComputedStyle(el).display !== 'none';
              const plus = document.getElementById('overflow-plus-btn');
              if (!plus || typeof window._refreshOverflowChevron !== 'function')
                return { ok: false };
              window._refreshOverflowChevron();
              const startedDisplay = plus.style.display, startedVisible = vis(plus);
              const s = document.createElement('script');
              s.src = 'data:text/javascript,/*tts-ai.js*/'; s.dataset.owSmokeTts = '1';
              document.head.appendChild(s);
              window._overflowTtsEnabled = true;
              window._refreshOverflowChevron();
              const restoredDisplay = plus.style.display, restoredVisible = vis(plus);
              let opened = false, itemCount = 0;
              if (window.OrwellMenuKit && vis(plus)) {
                plus.click();
                const surf = document.querySelector('.ow-popover[role="menu"]');
                opened = !!surf;
                itemCount = surf ? surf.querySelectorAll('.ow-menu-item').length : 0;
                try { window.OrwellMenuKit.closeAll(); } catch (_) {}
              }
              window._overflowTtsEnabled = false; s.remove();
              window._refreshOverflowChevron();
              return { ok: true, startedDisplay, startedVisible, restoredDisplay, restoredVisible,
                       opened, itemCount, reHidden: !vis(plus) };
            }""")
            page.evaluate("document.body.click()")
            check(restore.get("ok") is True and restore.get("startedVisible") is False,
                  f"#1638 restore-path: the game-build '+' starts hidden (empty builder) ({restore})")
            check(restore.get("restoredDisplay") != "none" and restore.get("restoredVisible") is True,
                  "#1638 restore-path (bug#1): a non-empty builder RESTORES the hidden '+' — "
                  f"refreshOverflowChevron is REVERSIBLE, not hide-only ({restore})")
            check(restore.get("opened") is True and restore.get("itemCount", 0) >= 1,
                  f"#1638 restore-path: the restored '+' opens the kit menu carrying the built item ({restore})")
            check(restore.get("reHidden") is True,
                  f"#1638 restore-path: clearing the builder re-hides the '+' (empty state restored) ({restore})")
            # #831 (supersedes #760's paperclip): exactly one attach affordance in the game build —
            # the EMPTY composer's send button paints a "+" in mode 'attach' (opens the picker); the
            # standalone paperclip is dropped and the overflow-tray duplicate stays gone.
            check(g13_menus["sendAttachMode"] == "attach" and g13_menus["sendAttachTitle"] == "Attach a file",
                  "G13/#831: the empty-composer send button is the single attach affordance "
                  f"(mode 'attach', title 'Attach a file') ({g13_menus['sendAttachMode']!r}, {g13_menus['sendAttachTitle']!r})")
            check(g13_menus["paperclipGone"] is True,
                  "G13/#831: the redundant standalone composer paperclip is dropped (one attach control)")
            check(g13_menus["trayAttachPresent"] is False,
                  "G13/#831: the redundant overflow-tray 'Attach files' duplicate is gone (no two attach entry points)")

            # (b) the shortcuts modal: rows render, none names a dropped
            # vertical, and no category header floats over zero rows.
            page.click("#user-bar-settings")
            page.wait_for_timeout(300)
            page.click("#settings-modal [data-settings-tab='shortcuts']")
            page.wait_for_selector("#shortcuts-list .shortcut-row", timeout=4000)
            g13_sc = page.evaluate("""() => {
              const kids = [...document.getElementById('shortcuts-list').children];
              return {
                labels: [...document.querySelectorAll('#shortcuts-list .shortcut-row .shortcut-label')]
                  .map(e => (e.textContent || '').trim()),
                emptyCats: kids.filter((k, i) => k.classList.contains('shortcut-category') &&
                    (i === kids.length - 1 || kids[i + 1].classList.contains('shortcut-category')))
                  .map(k => (k.textContent || '').trim()),
              };
            }""")
            check(len(g13_sc["labels"]) >= 6,
                  f"G13: the shortcuts list renders its keep-set rows ({len(g13_sc['labels'])})")
            check(g13_zombies(g13_sc["labels"]) == [],
                  f"G13: no shortcuts-modal row names a dropped vertical ({g13_zombies(g13_sc['labels'])})")
            check(g13_sc["emptyCats"] == [],
                  f"G13: no empty shortcut category header renders ({g13_sc['emptyCats']})")

            # (c) the player tier: no settings tab button renders whose page
            # would be empty (every card admin-only) — and the cascade is
            # COMPUTED, not hand-listed: force one tab's cards admin-only and
            # its launcher hides and cannot be landed on.
            page.evaluate("window.__g13WasAdmin = !!window._isAdmin; window._isAdmin = false;")
            page.evaluate("(document.querySelector('#settings-modal .ow-close')||{click(){}}).click()")
            page.wait_for_timeout(300)
            page.click("#user-bar-settings")
            page.wait_for_timeout(250)
            g13_tabs = page.evaluate("""() => {
              const m = document.getElementById('settings-modal');
              return [...m.querySelectorAll('[data-settings-tab]')]
                .filter(b => getComputedStyle(b).display !== 'none')
                .map(b => {
                  const t = b.dataset.settingsTab;
                  const cards = [...m.querySelectorAll(`[data-settings-panel="${t}"] .admin-card`)];
                  return { tab: t, cards: cards.length,
                           allAdminOnly: cards.length > 0 && cards.every(c => c.classList.contains('admin-only')) };
                });
            }""")
            g13_empty_tabs = [t for t in g13_tabs if t["cards"] == 0 or t["allAdminOnly"]]
            check(len(g13_tabs) >= 3 and g13_empty_tabs == [],
                  f"G13: no empty non-admin settings tab button renders ({g13_empty_tabs or [t['tab'] for t in g13_tabs]})")
            page.evaluate("""() => {
              document.querySelectorAll('[data-settings-panel="shortcuts"] .admin-card')
                .forEach(c => c.classList.add('admin-only', 'g13-probe'));
              (document.querySelector('#settings-modal .ow-close')||{click(){}}).click();
            }""")
            page.wait_for_timeout(300)
            page.click("#user-bar-settings")
            page.wait_for_timeout(250)
            g13_probe = page.evaluate("""() => ({
              tabHidden: getComputedStyle(document.querySelector('[data-settings-tab="shortcuts"]')).display === 'none',
              landed: (document.querySelector('#settings-modal [data-settings-tab].active') || { dataset: {} }).dataset.settingsTab,
            })""")
            check(g13_probe.get("tabHidden") is True,
                  f"G13: a tab whose every card went admin-only hides its launcher for the player ({g13_probe})")
            check(g13_probe.get("landed") != "shortcuts",
                  f"G13: the hidden tab is not landable either ({g13_probe})")
            page.evaluate("""() => {
              document.querySelectorAll('.g13-probe').forEach(c => {
                c.classList.remove('admin-only', 'g13-probe');
                c.style.display = '';  // clear the inline hide syncAdminVisibility wrote
              });
              window._isAdmin = window.__g13WasAdmin;
              const m = document.getElementById('settings-modal');
              const b = m && m.querySelector('.ow-close');
              if (b) b.click();
            }""")
            page.wait_for_timeout(300)

            # (d) the rail: collapse to the icon rail for real, then prove every
            # launcher the build's own trim sheet (the unconditional first block
            # of game-trim.css) drops stays invisible, and no VISIBLE rail
            # launcher names a dropped vertical (coordinates with H4: a dropped
            # row hidden under the build yields no rail icon).
            with open(os.path.join(ROOT, "static", "css", "game-trim.css"), encoding="utf-8") as _fh:
                g13_trimmed_ids = sorted(set(_re.findall(r"#([A-Za-z][\w-]*)", _fh.read().split("{", 1)[0])))
            page.click("#hamburger-btn")
            page.wait_for_timeout(400)
            g13_rail = page.evaluate("""(trimmed) => {
              const vis = el => el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
              return {
                railShown: vis(document.getElementById('icon-rail')),
                rail: [...document.querySelectorAll('#icon-rail .icon-rail-btn')].filter(vis)
                  .map(b => ((b.id || '') + ' ' + (b.title || b.getAttribute('aria-label') || '')).trim()),
                trimmedVisible: trimmed.filter(id => vis(document.getElementById(id))),
              };
            }""", g13_trimmed_ids)
            check(g13_rail["railShown"] is True and len(g13_rail["rail"]) >= 3 and g13_zombies(g13_rail["rail"]) == [],
                  f"G13: no visible rail icon names a dropped vertical ({g13_zombies(g13_rail['rail']) or g13_rail['rail']})")
            check(g13_rail["trimmedVisible"] == [],
                  f"G13: every game-trim'd launcher stays invisible ({g13_rail['trimmedVisible']})")
            page.click("#hamburger-btn")  # restore the expanded sidebar
            page.wait_for_timeout(250)

            # G17 (refresh-persistence audit F3/F5/F7 + F4): the composer draft survives
            # a refresh as ONE per-user sessionStorage record {text, drMode,
            # pendingApproachId}; a Diary-Room draft re-enters DR mode BEFORE its text
            # lands (F5 — a restored confessional must never be sendable to the house);
            # an approach prefill keeps its pending chip; and the casting seat re-arms.
            # Driven for REAL on fresh pages: real typing, real reloads, real clicks.
            g17 = new_page(browser)
            # A STARTED game is staged with the sanctioned route-mock pattern (the G15
            # decision fake above; the G5 audit drove its DR cell against a real game):
            # the Diary-Room gate legitimately EXITS DR mode when no game is running, so
            # an engine-down page could never hold a restored confessional open.
            g17.route("**/api/orwell/state",
                      lambda r: r.fulfill(status=200, content_type="application/json",
                                          body='{"started": true, "week": 2, "phase": "social"}'))
            # The F5 ORDER SPY, armed before every navigation: at the exact moment the
            # restored text lands in #message (the restore's input dispatch), record
            # whether DR mode was ALREADY active on <body>. Synchronous truth, no race.
            g17.add_init_script("""
              window.__g17Order = [];
              window.addEventListener('input', (e) => {
                if (e.target && e.target.id === 'message' && e.target.value) {
                  window.__g17Order.push({
                    dr: document.body.classList.contains('orwell-dr-mode'),
                    text: e.target.value });
                }
              }, true);
            """)

            def g17_settle(p):
                p.wait_for_timeout(2500)
                # the engine-down boot mounts the dark-house card — dismiss like a person
                if p.query_selector("#orwell-onboarding"):
                    p.keyboard.press("Escape")
                    p.wait_for_timeout(200)

            g17.goto(base + "/", wait_until="load", timeout=30000)
            g17_settle(g17)

            # F3 (M1, the commission's literal text): a player-typed draft survives.
            g17.click("#message")
            g17.keyboard.type("I want to pull the HOH aside before the ceremony.")
            g17.wait_for_timeout(600)  # > the write debounce
            g17_rec = g17.evaluate("window._orwellComposerDraftPeek && window._orwellComposerDraftPeek()")
            check(bool(g17_rec) and g17_rec.get("text", "").startswith("I want to pull")
                  and "drMode" in g17_rec and "pendingApproachId" in g17_rec,
                  f"G17/F3: typing writes ONE draft record {{text, drMode, pendingApproachId}} ({g17_rec})")
            g17.reload(wait_until="load")
            g17_settle(g17)
            check(g17.input_value("#message") == "I want to pull the HOH aside before the ceremony.",
                  "G17/F3: the typed draft is restored into the composer after reload")

            # F5 (the privacy gate): a Diary-Room draft re-enters DR mode BEFORE the text.
            g17.click("#message")
            g17.keyboard.press("Control+a")
            g17.keyboard.press("Delete")  # empty the box for real (drops the record)
            g17.evaluate("window._orwellOpenDiaryRoom()")
            check(g17.evaluate("document.body.classList.contains('orwell-dr-mode')") is True,
                  "G17/F5 setup: the composer is in Diary-Room mode")
            g17.keyboard.type("Confessional: I'm secretly working with the nominee.")
            g17.wait_for_timeout(600)
            g17.reload(wait_until="load")
            g17_settle(g17)
            g17_order = g17.evaluate("window.__g17Order")
            check(len(g17_order) >= 1 and g17_order[0].get("dr") is True
                  and g17_order[0].get("text", "").startswith("Confessional:"),
                  f"G17/F5: DR mode was active BEFORE the restored text landed ({g17_order})")
            check(g17.evaluate("document.body.classList.contains('orwell-dr-mode')") is True
                  and g17.evaluate("window._orwellDiaryRoomActive && window._orwellDiaryRoomActive()") is True,
                  "G17/F5: the restored confessional draft sits in an ACTIVE Diary-Room composer")
            check(g17.evaluate("getComputedStyle(document.getElementById('orwell-dr-pill')).display") != "none",
                  "G17/F5: the DR pill is visible with the restored draft")
            check(g17.input_value("#message").startswith("Confessional:"),
                  "G17/F5: the confessional text itself is restored")
            g17.close()

            # P1 OOBE re-sequence (2026-06-20 owner ruling): the casting INTERVIEW is the player's
            # first interaction; the cast photo is now the FIRST casting STEP (engine-driven) and
            # OPTIONAL — a mid-interview box that appears only AFTER the producers ask (a rendered
            # .msg.msg-ai) and only while the engine still wants it (state.casting.missing includes
            # "castPhoto"). It no longer hard-gates the chat and never auto-mounts at page load.
            # Pre-game is staged with routed fakes (the sanctioned G5-audit pattern): state
            # started:false WITH the engine casting status, models live, intake not finalized.
            f4 = new_page(browser)
            # the engine still wants the cast-photo step until the FE POSTs uploaded/skipped; flip to
            # drop "castPhoto" from `missing` so the box closes (mirrors the engine advancing `next`).
            _photo_wanted = {"v": True}
            def _f4_state_body():
                if _photo_wanted["v"]:
                    return ('{"started": false, "casting": {"known": {}, '
                            '"missing": ["castPhoto", "playerName"], "next": "their cast photo", "ready": false}}')
                return ('{"started": false, "casting": {"known": {"castPhoto": "skipped"}, '
                        '"missing": ["playerName"], "next": "their name", "ready": false}}')
            f4.route("**/api/orwell/state",
                     lambda r: r.fulfill(status=200, content_type="application/json", body=_f4_state_body()))
            f4.route("**/api/models",
                     lambda r: r.fulfill(status=200, content_type="application/json",
                                         body='{"items": [{"models": ["m"], "offline": false}]}'))
            f4.route("**/api/orwell/portrait/intake",
                     lambda r: r.fulfill(status=200, content_type="application/json",
                                         body='{"present": false, "finalized": false, "candidates": 0}'))
            f4.route("**/api/orwell/portrait/library",
                     lambda r: r.fulfill(status=200, content_type="application/json",
                                         body='{"headshots": []}'))
            f4.route("**/api/orwell/game-session",
                     lambda r: r.fulfill(status=200, content_type="application/json",
                                         body='{"sessionId": null}'))
            # the FE marks the cast-photo step handled here (uploaded/skipped) — fake a clean record
            f4.route("**/api/orwell/casting/photo",
                     lambda r: r.fulfill(status=200, content_type="application/json", body='{"ok": true}'))
            f4.goto(base + "/", wait_until="load", timeout=30000)
            f4.wait_for_timeout(3000)  # route() probes + (a healthy feed) proceeds directly
            # the composer is NOT prefilled — the producers open the interview; the player never types first
            f4_seat0 = f4.input_value("#message")
            check(not f4_seat0.strip(),
                  f"P1: pre-game boot does NOT prefill the composer (no seat pre-prompt) ({f4_seat0!r})")
            # #874 (2026-07-09): the old SETUP WIZARD modal (data-ob-setup) is REMOVED for the healthy
            # case — a feed is configured in this env, so route() proceeds straight into the interview
            # with NO intervening gate/modal at all. No "Enter the house" CTA to click, nothing to wait
            # on but the producers' own opener.
            check(f4.evaluate("!document.getElementById('orwell-onboarding')") is True,
                  "P874: no onboarding modal mounts when a feed is already configured (healthy case)")
            # the cast-photo box is HIDDEN at boot — it follows the producers' question, never any
            # pre-game surface (no .msg.msg-ai has rendered yet, so the engine-gated box stays closed)
            check(f4.evaluate("!document.getElementById('orwell-headshot')") is True,
                  "P1: the cast-photo box is hidden at boot (it follows the producers' question)")
            # NO HARD GATE: the chat input + send are USABLE immediately — the interview runs before
            # any photo (the old "locked until a photo is secured" gate is retired).
            check(f4.evaluate("!document.getElementById('message').disabled") is True,
                  "P1: the chat input is USABLE pre-photo (the hard gate is retired)")
            check(f4.evaluate("() => { const s = document.querySelector('.send-btn'); return !(s && s.disabled); }") is True,
                  "P1: the send affordance is USABLE pre-photo")
            check(f4.evaluate("(document.getElementById('message').getAttribute('placeholder') || '')")
                  != "Add your cast photo to begin",
                  "P1: the composer placeholder is NOT the old hard-gate reason")
            # MID-INTERVIEW REVEAL: simulate the producers' opener (a rendered .msg.msg-ai); the
            # engine-gated step (casting.missing includes "castPhoto") now surfaces — but per Thing 2
            # the box NO LONGER auto-opens: a competition-style "Take your cast photo" pill appears
            # in the chat after the question, and clicking IT opens the box.
            f4.evaluate("""() => {
              const h = document.getElementById('chat-history');
              if (h) { const m = document.createElement('div'); m.className = 'msg msg-ai';
                       m.textContent = 'producer opener'; h.appendChild(m); }
              window.dispatchEvent(new CustomEvent('orwell:gamechanged'));
            }""")
            f4.wait_for_timeout(900)  # let route() surface the pill
            pill = f4.evaluate("""() => ({
              pill: !!document.getElementById('orwell-choose-character'),
              text: ((document.querySelector('.hs-choose-btn') || {}).textContent || '').trim(),
              // #913: the pill is now PINNED above the composer (the OrwellNotice zone), NOT appended
              // inline into chat-history where it scrolled away. Assert it is OUTSIDE chat-history.
              pinnedAboveComposer: (() => { const h=document.getElementById('chat-history'),
                                 p=document.getElementById('orwell-choose-character');
                return !!(p && (!h || !h.contains(p))); })(),
              boxAutoOpened: !!document.getElementById('orwell-headshot'),
            })""")
            check(pill.get("pill") is True and pill.get("text") == "Take your cast photo"
                  and pill.get("pinnedAboveComposer") is True and pill.get("boxAutoOpened") is False,
                  f"P1/Thing2/#913/M2-4: the 'Take your cast photo' pill appears pinned above the composer (not inline in history); the box does NOT auto-open ({pill})")
            # Clicking the pill opens the box (and removes the pill).
            f4.click(".hs-choose-btn")
            f4.wait_for_timeout(800)
            check(f4.evaluate("!document.getElementById('orwell-choose-character')") is True,
                  "P1/Thing2: clicking the pill removes it")
            cast_win = f4.evaluate("""() => {
              const el = document.getElementById('orwell-headshot');
              if (!el) return { mounted: false };
              return {
                mounted: true,
                kit: el.classList.contains('ow-window') && el.hasAttribute('data-ow-window'),
                title: (el.querySelector('.ow-title') || {}).textContent || '',
                lead: !!el.querySelector('.hs-lead'),
                skip: !!el.querySelector('#hs-skip'),
              };
            }""")
            check(cast_win.get("mounted") is True and cast_win.get("kit") is True,
                  f"P1: the cast-photo box reveals mid-interview as a kit OrwellWindow ({cast_win})")
            check(cast_win.get("title", "").strip().lower() == "your cast photo",
                  f"P1: the cast-photo window is title-cased ({cast_win})")
            check(cast_win.get("lead") is True,
                  f"P1: the ONE cast-photo instruction lives in the window body ({cast_win})")
            check(cast_win.get("skip") is True,
                  f"P1: the OPTIONAL 'Skip for now' affordance is present ({cast_win})")
            # A1 / J1-25 + J1-23: the cast-photo box is now a PROPER modal dialog. The audit
            # deferred its #1 launch-blocker (focus escaped into the chat; the card floated over
            # live narration with no scrim) to "a per-window modal option" — this is it: aria-modal,
            # a backdrop scrim that covers the viewport (figure/ground), and an INERT background
            # (the chat behind can't take focus). The scrim/inert lift the instant the box closes.
            modal_a11y = f4.evaluate("""() => {
              const el = document.getElementById('orwell-headshot');
              if (!el) return { ok: false };
              const scrim = document.querySelector('.ow-scrim[data-ow-scrim="orwell-headshot"]');
              const sr = scrim ? scrim.getBoundingClientRect() : null;
              const kids = [...document.body.children];
              return {
                ariaModal: el.getAttribute('aria-modal'),
                role: el.getAttribute('role'),
                scrim: !!scrim,
                scrimCovers: !!sr && sr.width >= window.innerWidth - 2 && sr.height >= window.innerHeight - 2,
                bgInertCount: kids.filter(n => n.inert || n.hasAttribute('inert')).length,
                dialogInert: el.inert || el.hasAttribute('inert'),
                scrimInert: !!scrim && (scrim.inert || scrim.hasAttribute('inert')),
                focusInside: el.contains(document.activeElement),
              };
            }""")
            check(modal_a11y.get("ariaModal") == "true" and modal_a11y.get("role") == "dialog",
                  f"P1/J1-25: the cast-photo box is a proper modal dialog (aria-modal) ({modal_a11y})")
            check(modal_a11y.get("scrim") is True and modal_a11y.get("scrimCovers") is True,
                  f"P1/J1-23: a backdrop scrim covers the viewport behind the cast-photo ({modal_a11y})")
            check((modal_a11y.get("bgInertCount") or 0) >= 1
                  and modal_a11y.get("dialogInert") is False and modal_a11y.get("scrimInert") is False,
                  f"P1/J1-25: the background is inert; the dialog + its scrim are not ({modal_a11y})")
            check(modal_a11y.get("focusInside") is True,
                  f"P1/J1-25: focus lands INSIDE the dialog, never on body ({modal_a11y})")
            # SKIP closes the box: the engine drops "castPhoto" from `missing`, so it never re-prompts
            # (and the chat was usable the whole time).
            _photo_wanted["v"] = False
            f4.click("#orwell-headshot #hs-skip")
            f4.wait_for_timeout(900)
            check(f4.evaluate("!document.getElementById('orwell-headshot')") is True,
                  "P1: skipping the cast photo closes the box (the step is optional)")
            # …and closing tears down ALL the modal chrome (no stuck scrim, no permanently-inert page).
            post_modal = f4.evaluate("""() => ({
              scrimGone: !document.querySelector('.ow-scrim[data-ow-scrim="orwell-headshot"]'),
              bgRestored: [...document.body.children].every(n => !n.inert && !n.hasAttribute('inert')),
            })""")
            check(post_modal.get("scrimGone") is True,
                  "P1/J1-25: closing the cast-photo removes the backdrop scrim")
            check(post_modal.get("bgRestored") is True,
                  "P1/J1-25: closing the cast-photo un-inerts the background")
            check(f4.evaluate("sessionStorage.getItem('orwell-interview-open')") == "1",
                  "P1: the fresh-session fence is still set once per interview (F7)")
            f4.close()

            # S1+S2 / F1 (2026-06-11 settings-wiring audit): the Shortcuts
            # persist→apply loop, driven for REAL. A rebind saves per-profile
            # (PUT /api/prefs/keybinds, C30) — but the runtime keymap booted
            # from /api/auth/settings only, a key nothing writes anymore, so
            # every custom shortcut silently reverted on reload while the tab
            # still rendered it as saved. Pin: rebind → reload → the new combo
            # is loaded AND fires; the old default no longer does.
            s1 = new_page(browser)
            s1.goto(base + "/", wait_until="load", timeout=30000)
            g17_settle(s1)
            s1.click("#user-bar-settings")
            s1.wait_for_timeout(300)
            s1.click("#settings-modal [data-settings-tab='shortcuts']")
            s1.wait_for_selector("#shortcuts-list .shortcut-key[data-action='search']", timeout=4000)
            s1.click("#shortcuts-list .shortcut-key[data-action='search']")  # start listening
            s1.keyboard.press("Control+Shift+M")  # preview the combo
            s1.keyboard.press("Enter")            # commit → saveKeybinds → the per-user store
            s1.wait_for_timeout(600)
            s1_saved = s1.evaluate(
                "fetch('/api/prefs/keybinds', { credentials: 'same-origin' })"
                ".then(r => r.json()).then(d => (d.value || {}).search)")
            check(s1_saved == "ctrl+shift+m",
                  f"S1/F1: the rebind round-trips through the per-user store ({s1_saved!r})")
            check(s1.evaluate("window._orwellKeybinds.search") == "ctrl+shift+m",
                  "S1/F1: the rebind is live in-page immediately after the save")
            s1.reload(wait_until="load")
            g17_settle(s1)  # the keymap's async boot (global seed → prefs layer) settles
            s1_kb = s1.evaluate("window._orwellKeybinds.search")
            check(s1_kb == "ctrl+shift+m",
                  f"S1/F1: the saved rebind survives a reload ({s1_kb!r}; pre-fix it reverted to 'ctrl+k')")
            s1.keyboard.press("Control+Shift+M")
            s1.wait_for_timeout(250)
            check(s1.evaluate("!document.getElementById('search-overlay').classList.contains('hidden')") is True,
                  "S1/F1: the rebound combo FIRES after reload (search opens)")
            s1.keyboard.press("Control+Shift+M")  # the toggle path closes it again
            s1.wait_for_timeout(250)
            check(s1.evaluate("document.getElementById('search-overlay').classList.contains('hidden')") is True,
                  "S1/F1: the rebound combo toggles closed")
            s1.keyboard.press("Control+k")
            s1.wait_for_timeout(250)
            check(s1.evaluate("document.getElementById('search-overlay').classList.contains('hidden')") is True,
                  "S1/F1: the OLD default no longer fires — the runtime serves the per-user layer")
            # leave the store clean for the next run (null pref ⇒ defaults)
            s1.evaluate(
                "fetch('/api/prefs/keybinds', { method: 'PUT', credentials: 'same-origin',"
                " headers: { 'Content-Type': 'application/json' },"
                " body: JSON.stringify({ value: null }) }).then(r => r.status)")
            s1.wait_for_timeout(300)
            s1.close()

            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except Exception:
            proc.kill()

    print()
    if _fails:
        print(f"FE BROWSER SMOKE FAILED ({len(_fails)})")
        return 1
    print("FE BROWSER SMOKE PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
