#!/usr/bin/env python3
"""The rendered a11y gate (Stream S / ruling #16 — #651 gap 3, issue #1375).

A sibling of `responsive_matrix.py` that reuses its ENGINE-STAGED matrix
(`ORWELL_MATRIX_ENGINE` / `ORWELL_MATRIX_FINISH=1` staging — chrome + game +
endgame surfaces) and, instead of measuring geometry, asserts two RENDERED
accessibility invariants the source-pinned Python checks cannot see:

  axe      — inject axe-core into each staged surface and run it; FAIL on any
             WCAG level-A / level-AA violation and any ARIA-category violation
             (axe's own `color-contrast` rule is DISABLED here — contrast is
             owned by the sweep below so the two concerns never double-count).
  contrast — a RENDERED WCAG (4.5:1 / 3:1) + APCA(Lc) sweep. It does NOT try to
             composite the CSS box stack (this app paints its themed backdrop
             from FIXED sibling layers — body/html are transparent — so an
             ancestor composite is structurally wrong). Instead it screenshots
             each state with all text made transparent, then samples the TRUE
             rendered backdrop pixels behind every text run: glass, scrims,
             backdrop-filter blur and images are all included exactly as painted
             — the "computed glass/scrim contrast the source-pinned checks can't
             see." APCA Lc rides along for the polarity-aware read #738 works in.
             Text over a NON-UNIFORM backdrop (a busy photo/portrait) is reported
             INDETERMINATE and never hard-gated (its contrast is a judgment call).

KNOWN violations carry a finding ID in XFAIL below and report as xfail (exit 0).
When a finding LANDS, its xfail flips to a hard assertion by REMOVING the entry —
the gate ratchets. An xpass (an XFAIL id that never fired) prints a nudge to
remove the stale entry. Any UNKNOWN violation FAILS the gate. Never silent.

Findings are DEDUPED by a stable needle across viewports/sub-passes: an axe rule
and a computed-contrast element are viewport-invariant (the rule fires on the
same DOM; a color/size failure is theme-driven, not width-driven), so one unique
violation reports once no matter how many tiers hit it. That keeps the registry
small and the ratchet honest.

Engine-staged surfaces are exercised when an engine is reachable
(ORWELL_MATRIX_ENGINE=url); otherwise the run covers the page chrome (composer,
sidebar, settings, onboarding) — still the a11y regression net. CI runs it
ENGINE-STAGED with ORWELL_MATRIX_FINISH=1 (mirroring the fe-responsive job) so
the game + endgame surfaces are audited on every FE PR. axe-core is VENDORED at
`frontend/tests/vendor/axe.min.js` (npm `axe-core`; injected via Playwright with
a bypass-CSP test context — no network, no CDN) so the gate is hermetic. Usage:
    python3 scripts/a11y_matrix.py
"""
import io
import os
import sys
from pathlib import Path

# The staging half is responsive_matrix.py's, imported wholesale (its module body is
# side-effect-free — only constants + defs; main() is under __main__). We reuse boot_fe /
# stage_game / finish_game / the mount_* helpers / GAME_SURFACES / CHROME so this gate audits the
# IDENTICAL surface set the geometry gate measures, and can NEVER drift from it. We deliberately do
# NOT edit responsive_matrix.py (another lane owns it) — we only consume it.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import responsive_matrix as rm  # noqa: E402

VENDOR_AXE = Path(__file__).resolve().parents[1] / "tests" / "vendor" / "axe.min.js"

# Optional dedicated port so this gate and the geometry gate can co-exist on one host without a
# clash (in CI they are separate jobs; locally they may overlap). Falls back to rm's own default.
if os.environ.get("ORWELL_A11Y_PORT"):
    rm.PORT = int(os.environ["ORWELL_A11Y_PORT"])
    rm.FE = f"http://127.0.0.1:{rm.PORT}"

# axe is fast, but we run it per viewport × several mounted sub-states — a representative subset of
# rm.VIEWPORTS (a narrow coarse-pointer phone, a tablet reflow tier, and a standard desktop) bounds
# wall-clock while still covering the phone/desktop split a11y regressions cluster around. width,
# height, coarse-pointer?
A11Y_VIEWPORTS = [
    ("phone-390", 390, 844, True),
    ("tablet-820", 820, 1180, True),
    ("desktop-1366", 1366, 768, False),
]

# The axe ruleset: WCAG 2.0/2.1 level A + AA, PLUS every ARIA-category rule (cat.aria) — exactly the
# "level-A/AA + ARIA violations" the DoD names. `color-contrast` is disabled: the contrast sweep
# below owns it (axe returns "incomplete" — not a violation — on glass/backdrop-filter it can't
# resolve, which is precisely the gap the rendered sweep fills).
AXE_OPTIONS = {
    "runOnly": {"type": "tag", "values": ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "cat.aria"]},
    "resultTypes": ["violations"],
    "rules": {"color-contrast": {"enabled": False}},
}

# ── XFAIL registry ────────────────────────────────────────────────────────────────────────────
# finding-id → the substring the failure LINE must contain (same shape as responsive_matrix.py's
# XFAIL). A finding LINE that contains the needle reports xfail (exit 0) instead of failing the
# gate. Each entry is a KNOWN, pre-existing violation on main; issue #1375 tracks the batch and the
# lead files each as its OWN issue (swap the placeholder id for the real one). REMOVE an entry the
# moment its violation is fixed — the gate then ratchets that family to a hard assertion. An xpass
# (an id whose needle never fired this run) prints a nudge to remove it; it never fails the gate, so
# a surface that doesn't render in a given run (e.g. an engine-less chrome-only run) is harmless.
#
# Two needle shapes (both are stable prefixes; the volatile numbers/text trail after them):
#   "a11y:<rule-id>"                    — an axe WCAG-A/AA or ARIA rule (viewport-invariant).
#   "contrast:<surface>:<tag[.class|@ancestor]>" — a rendered-contrast element on a named surface.
#
# Populated from the first ENGINE-STAGED run on main (2026-07-11, engine-staged + FINISHED season).
# Every entry below is a REAL rendered contrast finding for the lead to file — NOT a false positive.
XFAIL = {
    # #1375-a REMOVED (#1644): the decision-card disabled-Confirm hint no longer hard-codes white ink.
    # It now follows its host surface (body.theme-frosted .odec .odec-hint { color: inherit } in
    # orwellDecision.js) — DARK #16191f on the light OrwellNotice kit glass (the common path the
    # engine-staged matrix renders), LIGHT over the bare-mount dark edge — so the finding clears AA
    # and the gate ratchets it to a hard assertion. (Stale description had it as "dark-on-dark".)
    # #1375-e / -f / -i REMOVED (A5, 2026-11-04): the sidebar "New Chat" label, the "Orwell" brand title and the user-bar name (under the settings scrim) did not fire in the engine-staged
    # matrix - locally AND in CI (8 audit passes incl. both +settings readings, same xpass list both times) - so they ratchet to hard assertions. (#1375-h / #1418-finale-contrast below
    # stay: CI reports "endgame not reached", so the retro/finale surfaces are NOT audited there and "never fired" proves nothing; #1916 stays: its element now reads INDETERMINATE.)
    # The post-season retro window (#orwell-retro) is a SYSTEMIC low-contrast surface: dark text +
    # dark window-kit controls (× – ⇲), the "The Season, Watched Back" title, the winner headline,
    # and the eviction list all render at ~3.6:1 on its light-ish glass. Its body is filled by a
    # background poll (nondeterministic element set), so this is deliberately a SURFACE-LEVEL entry —
    # the lead files ONE issue ("the retro window has systemic dark-on-glass contrast"). REMOVE this
    # one entry when the retro window's glass/token is fixed and the whole surface ratchets clean.
    "#1375-h": "contrast:orwell-retro:",
    # #1418 / S4-2: the finale panel (#orwell-finale) now SURVIVES the flip to `finished` (S4-2 makes
    # finaleView return the completed reveal + crowned winner post-season), so it RENDERS on a finished
    # season and is audited here for the first time. It is the SAME systemic dark-on-glass surface as
    # the retro (#1375-h): the finalist/reveal names + the vote tally all read var(--fg) at ~3.66:1 on
    # the mid-tone glass. Deliberately a SURFACE-LEVEL entry (mirrors #1375-h) tracked with the #738
    # Liquid-Glass legibility batch — REMOVE it when the shared glass/token contrast fix lands and the
    # whole surface ratchets clean.
    "#1418-finale-contrast": "contrast:orwell-finale:",
    # #1916-think-contrast REMOVED (A47, 2026-11-05): the engine-staged matrix (8 audit passes, game + endgame card staged) never fires it, and the reasoning body ("Here is my reasoning ...")
    # measures 13.10-15.73:1 over its textured backdrop (INDETERMINATE band, far above AA 4.5). The one-off 3.48:1 (dark ink over teal) was not reproducible in any staged pass.
    # #1418 / S4-2: the finale body (#orwell-finale > .ow-body) is a scrollable region without keyboard
    # access (axe scrollable-region-focusable) — a KIT-level gap (the shared OrwellWindow `.ow-body`
    # scroll container is not tabbable) that only surfaces now that the finale renders on a finished
    # season with enough content to overflow. Tracked as a kit a11y follow-up (add tabindex to the
    # scrollable kit body); REMOVE when the kit makes its scroll region focusable.
    "#1418-finale-scroll": "a11y:scrollable-region-focusable",
}

# Optional per-entry CONTEXT constraint: when an XFAIL id appears here, a finding is accepted
# as that XFAIL only if EVERY context that hit it contains the token — a hit in any other
# context is a real FAIL, never absorbed by the registry (needles are substring-matched, so a
# selector-only needle would otherwise exempt the element everywhere).
XFAIL_CONTEXT = {
    # (no live entries: #1375-i, the settings-scrim reading, was removed with the A5 ratchet. The mechanism - an entry narrowed to one sweep context - stays and is exercised with a
    # synthetic entry in tests/test_a11y_xfail_context.py.)
}

# Findings are collected into `found` keyed by their stable needle so a violation seen at N
# viewports/sub-passes is ONE entry. value = {"line": representative line, "hits": {contexts}}.
found = {}
passes = 0
xfail_hits = set()  # which XFAIL needles actually fired (to flag stale/xpass entries)


def record(line, context):
    """Record a unique finding (deduped by its stable needle) with the context that hit it."""
    key = line.split("  ::", 1)[0].strip()
    slot = found.setdefault(key, {"line": line, "hits": set()})
    slot["hits"].add(context)


def classify_and_report():
    """Split the deduped findings into fail/xfail via the XFAIL registry; print + return exit code."""
    failures, xfails, indeterminate = [], [], []
    for key, slot in sorted(found.items()):
        line = slot["line"]
        if line.startswith("contrast-indeterminate:"):
            indeterminate.append(f"INDET {line}  ::seen {len(slot['hits'])}x")
            continue
        matched = None
        for fid, needle in XFAIL.items():
            if needle in line:
                matched = fid
                break
        # A context-constrained entry only absorbs hits from its own context (see XFAIL_CONTEXT).
        if matched and matched in XFAIL_CONTEXT:
            token = XFAIL_CONTEXT[matched]
            if not all(token in ctx for ctx in slot["hits"]):
                # The needle DID fire — record it so the xpass report never suggests removing
                # an entry whose element is actively failing (just outside the exempt context).
                xfail_hits.add(matched)
                matched = None
        if matched:
            xfail_hits.add(matched)
            xfails.append(f"XFAIL[{matched}] {line}  ::seen {len(slot['hits'])}x")
        else:
            failures.append(f"FAIL  {line}  ::seen {len(slot['hits'])}x")

    for x in xfails:
        print(x)
    for i in indeterminate:
        print(i)
    for f in failures:
        print(f)

    xpasses = [fid for fid in XFAIL if fid not in xfail_hits]
    print(f"\n==== a11y-matrix: {passes} audit pass(es) · {len(xfails)} xfail (known findings) · "
          f"{len(indeterminate)} indeterminate (not gated) · {len(failures)} FAIL")
    for f in failures:
        print(f"  {f}")
    if xpasses:
        print("  (xpass — these XFAIL ids never fired; the finding may be fixed — consider removing: "
              + ", ".join(xpasses) + ")")
    return 1 if failures else 0


# ── the axe audit ───────────────────────────────────────────────────────────────────────────────
def _axe_js():
    try:
        return VENDOR_AXE.read_text(encoding="utf-8")
    except Exception as e:  # a missing vendor file is a hard, loud setup error — never a silent skip
        sys.exit(f"FAIL — cannot read vendored axe-core at {VENDOR_AXE}: {e}")


def audit_axe(page, context, axe_src):
    """Inject axe-core and run it; record every WCAG-A/AA + ARIA violation (deduped by rule).

    The page enforces a strict CSP, so axe is injected into a `bypass_csp=True` test context (set on
    the browser context in main()); CSP governs the PRODUCTION script-loading posture, never the
    accessibility of the rendered DOM, so bypassing it to run the auditor cannot change a finding."""
    try:
        if not page.evaluate("typeof window.axe !== 'undefined'"):
            page.add_script_tag(content=axe_src)
        results = page.evaluate("(opts) => axe.run(document, opts)", AXE_OPTIONS)
    except Exception as e:
        # A broken axe run is loud (a dead gate is worse than a red one) — but not xfail-able.
        record(f"a11y:AXE-RUN-FAILED {str(e)[:120]}", context)
        return
    for v in results.get("violations", []):
        rule = v.get("id", "?")
        impact = v.get("impact") or "?"
        help_txt = (v.get("help") or "").strip()
        nodes = v.get("nodes", [])
        sample = ""
        if nodes:
            tgt = nodes[0].get("target") or []
            sample = " ".join(t if isinstance(t, str) else " ".join(t) for t in tgt)[:80]
        # Stable needle prefix "a11y:<rule>"; volatile detail trails after the "::" dedup marker.
        record(f"a11y:{rule} [{impact}] {help_txt} ({len(nodes)} node(s), e.g. {sample})", context)


# ── the rendered contrast sweep (WCAG 4.5:1 / 3:1 + APCA Lc, sampled from real pixels) ────────────
# Collect every visible text LEAF under the audited surfaces with its viewport rect + computed text
# color + font metrics. Then screenshot the state with all text transparent, and sample the true
# backdrop pixels behind each run.
_COLLECT_JS = r"""
(args) => {
  const {selector, maxNodes, vw, vh} = args;
  function surfaceOf(el){
    if(el.closest('#settings-modal, .settings-layout')) return 'settings';
    if(el.closest('#chat-form, .chat-input-bar')) return 'composer';
    if(el.closest('#sidebar')) return 'sidebar';
    if(el.closest('[data-ow-scrim], #orwell-onboarding, .ob-card')) return 'onboarding';
    const own = el.closest("[id^='orwell-']");
    if(own) return own.id;
    return 'page';
  }
  function firstClass(el){
    return (el.className && typeof el.className === 'string')
      ? el.className.trim().split(/\s+/)[0] : '';
  }
  function elKey(el){
    const cls = firstClass(el);
    const id = el.id ? '#'+el.id : '';
    let own = id + (cls ? '.'+cls : '');
    // A class/id-less element (e.g. a bare <span> label) gets a WEAK, over-broad needle. Qualify it
    // by its nearest classed ancestor so the XFAIL ratchet stays specific (a NEW bare-span regression
    // elsewhere on the same surface must still fail, not silently match a broad "span" entry).
    if(!own){
      let a = el.parentElement, hops = 0;
      while(a && hops < 4){ const c = firstClass(a); if(c){ own = '@'+c; break; } a = a.parentElement; hops++; }
    }
    let key = el.tagName.toLowerCase() + own;
    // The finding key keeps only the FIRST class, so several buttons collapse to one key
    // (e.g. the decision card's disabled Confirm + its enabled option/Cancel buttons all read
    // button.ow-btn). WCAG 1.4.3 exempts INACTIVE controls, so mark the disabled state in the key:
    // a disabled-only XFAIL then absorbs the exempt control WITHOUT masking a real regression on an
    // ENABLED sibling (which keeps the bare key and still gates).
    try {
      if(el.matches && el.matches(':disabled, [disabled], [aria-disabled="true"]')) key += ':disabled';
    } catch(_e){}
    return key;
  }
  function parseColor(str){
    if(!str || str === 'transparent') return null;
    const m = str.match(/rgba?\(([^)]+)\)/i);
    if(!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
    if(p.length < 3 || p.some(isNaN)) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  const EMOJI_ONLY = /^(?:\p{Emoji_Presentation}[\u{1F3FB}-\u{1F3FF}]?|\p{Extended_Pictographic}\uFE0F|\p{Regional_Indicator}|[\u200D\uFE0F]|\s)+$/u;
  const out = [];
  const seen = new Set();
  const els = document.querySelectorAll(selector);
  let i = 0;
  for(const el of els){
    if(i++ > maxNodes) break;
    if(!el.offsetParent) continue;
    if(el.children.length > 0) continue;              // leaf text only
    const txt = (el.textContent || '').trim();
    if(!txt) continue;
    const cs = getComputedStyle(el);
    if(cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) continue;
    const fg = parseColor(cs.color);
    if(!fg) continue;
    // A near-zero text-color alpha means the VISIBLE glyph is painted some other way (a ::before /
    // background / SVG icon) and this text node is an invisible a11y fallback — not a contrast
    // subject. (The x-ray CSS also transparents pseudo-elements, so we can't read that glyph anyway.)
    if(fg[3] < 0.15) continue;
    // A color-emoji glyph (e.g. a decorative chyron icon) paints its OWN bitmap colors — the CSS
    // `color` the sweep would compare is never the ink the eye sees, so it is not a contrast
    // subject (a WCAG ratio for it is meaningless). Only presentation-emoji runs are skipped; a
    // text-style symbol (▾, ✓, ©) still paints in CSS color and stays audited.
    if(EMOJI_ONLY.test(txt)) continue;
    const r = el.getBoundingClientRect();
    if(r.width < 3 || r.height < 3) continue;
    // Must be within the viewport (the screenshot is viewport-clipped; off-screen boxes can't be
    // sampled). A little grace at the edges.
    if(r.bottom <= 1 || r.right <= 1 || r.top >= vh - 1 || r.left >= vw - 1) continue;
    // CLIP + OCCLUSION: the sweep samples whatever pixels sit at the text's rect, so text that is
    // NOT actually painted there — clipped away by an overflow ancestor (a collapsed accordion's
    // max-height:0 body) or covered by another layer (a modal scrim/window, a card stacked over
    // the transcript) — would be scored against the OCCLUDER's pixels with its own (invisible)
    // ink: a measurement artifact, not a contrast finding. Intersect the rect with every clipping
    // ancestor, then keep only the sample points where a hit-test lands on this element (or its
    // own subtree/ancestor chain — a pointer-events:none label hit-tests to its parent). Text with
    // no visible sample point is skipped; a partially covered run is sampled only where visible.
    let cx0 = r.left, cy0 = r.top, cx1 = r.right, cy1 = r.bottom;
    for(let a = el.parentElement; a && a !== document.body; a = a.parentElement){
      const acs = getComputedStyle(a);
      if(acs.overflowX === 'visible' && acs.overflowY === 'visible') continue;
      const ar = a.getBoundingClientRect();
      cx0 = Math.max(cx0, ar.left); cy0 = Math.max(cy0, ar.top);
      cx1 = Math.min(cx1, ar.right); cy1 = Math.min(cy1, ar.bottom);
    }
    if(cx1 - cx0 < 3 || cy1 - cy0 < 3) continue;       // clipped away — never painted
    // Sample on a text LINE that is actually inside the visible (clipped) region — not the element's
    // midpoint, which can be clipped away while other lines of a long reply/reasoning block are still
    // on screen (greptile #1915: visible low-contrast text was skipped until scrolled to its middle).
    // Keep that line's HORIZONTAL extent too, so wrapped / right-aligned text is sampled only across
    // the glyphs of the chosen line, never the empty backdrop beside it (cubic #1915).
    let yc = null, lx = r.x, lw = r.width;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      for(const lr of range.getClientRects()){
        const ly = lr.y + lr.height / 2;
        if(lr.height >= 3 && lr.width >= 3 && ly >= cy0 && ly <= cy1 && ly >= 0 && ly < vh){
          yc = ly; lx = lr.x; lw = lr.width; break;
        }
      }
    } catch(_e) { /* fall back to the midpoint below */ }
    if(yc === null){
      const mid = r.y + r.height / 2;
      if(mid >= cy0 && mid <= cy1) yc = mid;
    }
    if(yc === null) continue;
    const n = lw >= 24 ? 7 : 3;
    const pts = [];
    for(let k = 0; k < n; k++){
      const xv = lx + 2 + (lw - 4) * (k / (n - 1));
      if(xv < cx0 || xv > cx1 || xv < 0 || xv >= vw) continue;
      const hit = document.elementFromPoint(xv, yc);
      if(hit && (hit === el || el.contains(hit) || hit.contains(el))) pts.push(xv);
    }
    if(!pts.length) continue;                          // fully occluded — not what the eye reads
    const surface = surfaceOf(el);
    const key = 'contrast:' + surface + ':' + elKey(el);
    if(seen.has(key)) continue;                        // one row per surface:element
    seen.add(key);
    out.push({
      key, surface, pts, yc,
      x: r.x, y: r.y, w: r.width, h: r.height,
      fg,                                              // [r,g,b,a]
      fs: Math.round((parseFloat(cs.fontSize) || 16) * 10) / 10,
      bold: (parseInt(cs.fontWeight, 10) || 400) >= 700,
      sample: txt.slice(0, 32),
    });
    if(out.length > 260) break;
  }
  return out;
}
"""

# The style that makes every text run transparent so a screenshot shows ONLY the painted backdrop
# (glass/scrim/blur/images) at each text location. `color: transparent` and dropping text-shadow /
# caret / placeholder ink never move layout, so every rect stays valid.
# `transition: none` makes the ink drop INSTANT: several surfaces carry `transition: all …` /
# color transitions (e.g. the reasoning accordion), so without it the screenshot caught text
# still mid-fade and sampled glyph pixels as "backdrop".
_XRAY_CSS = ("*, *::before, *::after { color: transparent !important;"
             " text-shadow: none !important; caret-color: transparent !important;"
             " -webkit-text-fill-color: transparent !important; transition: none !important; }"
             " ::placeholder { color: transparent !important; }")

# Reuse rm.GAME_SURFACES so a newly-registered game surface is contrast-covered automatically, plus
# the page chrome + onboarding. Leaf text under any of these is swept.
_CONTRAST_SELECTOR = ", ".join(
    ["#chat-form *", "#sidebar *", "#settings-modal *", ".settings-layout *",
     "[data-ow-scrim] *", "#orwell-onboarding *", "#chat-history *"]
    + [f"{sel} *" for sel in rm.GAME_SURFACES])


def _srgb_lin(v):
    v /= 255.0
    return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4


def _rel_lum(c):
    return 0.2126 * _srgb_lin(c[0]) + 0.7152 * _srgb_lin(c[1]) + 0.0722 * _srgb_lin(c[2])


def _wcag_ratio(fg, bg):
    l1, l2 = _rel_lum(fg), _rel_lum(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def _apca_y(c):
    return (0.2126729 * (c[0] / 255.0) ** 2.4
            + 0.7151522 * (c[1] / 255.0) ** 2.4
            + 0.0721750 * (c[2] / 255.0) ** 2.4)


def _apca_lc(txt, bg):
    """APCA-W3 (SA98G) lightness contrast — the polarity-aware Lc (sign = polarity)."""
    blk_thrs, blk_clmp, dymin, lo_clip, off = 0.022, 1.414, 0.0005, 0.1, 0.027
    ty, by = _apca_y(txt), _apca_y(bg)
    ty = ty if ty > blk_thrs else ty + (blk_thrs - ty) ** blk_clmp
    by = by if by > blk_thrs else by + (blk_thrs - by) ** blk_clmp
    if abs(by - ty) < dymin:
        return 0.0
    if by > ty:  # dark text on light bg
        s = (by ** 0.56 - ty ** 0.57) * 1.14
        c = 0.0 if s < lo_clip else s - off
    else:        # light text on dark bg
        s = (by ** 0.65 - ty ** 0.62) * 1.14
        c = 0.0 if s > -lo_clip else s + off
    return c * 100.0


def _over(fg, bg):
    """fg [r,g,b,a] over opaque bg [r,g,b] → composited [r,g,b] (straight-alpha source-over)."""
    a = fg[3]
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)]


def audit_contrast(page, context, w, h):
    """Screenshot-behind-text WCAG+APCA sweep; record each WCAG failure (deduped by surface:element)."""
    from PIL import Image

    try:
        cands = page.evaluate(_COLLECT_JS,
                              {"selector": _CONTRAST_SELECTOR, "maxNodes": 3000, "vw": w, "vh": h})
    except Exception as e:
        record(f"contrast:COLLECT-FAILED {str(e)[:120]}", context)
        return
    if not cands:
        return
    # Screenshot with text X-rayed out so we sample the real backdrop. add_style_tag needs the
    # bypass_csp context (set in main()); we remove the style right after so later passes are clean.
    style = None
    try:
        style = page.add_style_tag(content=_XRAY_CSS)
        page.wait_for_timeout(120)
        png = page.screenshot()  # viewport-clipped (deviceScaleFactor=1 ⇒ 1px == 1 CSS px)
    except Exception as e:
        record(f"contrast:SCREENSHOT-FAILED {str(e)[:120]}", context)
        return
    finally:
        if style is not None:
            try:
                style.evaluate("e => e.remove()")
            except Exception:
                pass
    img = Image.open(io.BytesIO(png)).convert("RGB")
    iw, ih = img.size
    px = img.load()
    scale = iw / float(w) if w else 1.0  # 1.0 at DPR=1; robust if a context ever sets DPR>1

    def sample(cx, cy):
        ix, iy = int(round(cx * scale)), int(round(cy * scale))
        ix = min(max(ix, 0), iw - 1)
        iy = min(max(iy, 0), ih - 1)
        return px[ix, iy]

    for c in cands:
        # Sample a horizontal band of points across the run at its vertical center; text is
        # transparent so every point is pure backdrop. A non-uniform backdrop (busy photo) is a
        # judgment call — reported indeterminate, never hard-gated.
        # The sample points are the VISIBLE ones the collector hit-tested (clipped/occluded points
        # already dropped there), at the run's vertical center.
        yc = c["yc"]
        bgs = [sample(xv, yc) for xv in c["pts"]]
        fg = c["fg"]
        fs, bold = c["fs"], c["bold"]
        large = fs >= 24 or (fs >= 18.66 and bold)
        req = 3.0 if large else 4.5

        def contrast_at(bg):
            f = _over(fg, bg) if fg[3] < 1 else fg[:3]
            return _wcag_ratio(f, bg), _apca_lc(f, bg)

        verdicts = [contrast_at(bg) for bg in bgs]
        ratios = [v[0] for v in verdicts]
        # per-channel median backdrop for the reported number
        med_bg = [sorted(ch)[len(ch) // 2] for ch in zip(*bgs)]
        med_ratio, med_lc = contrast_at(med_bg)
        # A textured backdrop (a portrait/photo behind glass) is a seed-varying JUDGMENT call, not a
        # stable flat-glass finding — its per-sample luminance varies a lot. If the sampled band's
        # luminance spread is wide, treat it as indeterminate (report, never gate). The threshold sits
        # WELL above the widest flat-glass panel spread seen on main (~0.05) and well below a typical
        # photo's, so it demotes only genuine imagery — belt-and-suspenders with the straddle check.
        lums = [_rel_lum(bg) for bg in bgs]
        if max(lums) - min(lums) > 0.10:
            record(f"contrast-indeterminate:{c['surface']}:{c['sample']!r} "
                   f"(textured backdrop, WCAG {min(ratios):.2f}–{max(ratios):.2f}:1 — not gated)",
                   context)
            continue
        # A small deadband below the threshold keeps the gate flake-proof: only a CLEAR, uniform
        # failure hard-gates; anything straddling the line (or non-uniform across samples) is
        # reported indeterminate, never gated. Sampling is deterministic (text x-rayed, motion
        # frozen), so this deadband is insurance against rounding at the exact boundary, not a hole.
        DEADBAND = 0.2
        if min(ratios) >= req:
            continue  # every sample passes — nothing to report
        if max(ratios) >= req - DEADBAND:
            # Straddles the threshold or a non-uniform backdrop (e.g. a portrait/photo) — contrast
            # varies across the run or sits on the line; a flat verdict would be arbitrary. Report,
            # never gate.
            record(f"contrast-indeterminate:{c['surface']}:{c['sample']!r} "
                   f"(borderline/non-uniform, WCAG {min(ratios):.2f}–{max(ratios):.2f}:1 — not gated)",
                   context)
            continue
        pol = "light-on-dark" if med_lc < 0 else "dark-on-light"
        record(f"{c['key']} — WCAG {med_ratio:.2f}:1 < {req} "
               f"(APCA Lc {round(med_lc)} {pol}, {fs}px{'/bold' if bold else ''}, "
               f"fg=rgb{tuple(round(v) for v in fg[:3])} bg=rgb{tuple(int(v) for v in med_bg)}) "
               f"{c['sample']!r}", context)


# ── the audit sweep for one rendered state ────────────────────────────────────────────────────────
def audit_state(page, context, axe_src, w, h):
    global passes
    page.wait_for_timeout(600)  # let the state settle before auditing
    # #1875: mount test chat content (bubbles, reasoning accordion, chyrons) so the
    # axe and contrast sweeps cover the chat transcript during staged runs.
    rm.mount_chat_transcript(page)
    audit_axe(page, context, axe_src)
    audit_contrast(page, context, w, h)
    passes += 1


_SETTINGS_BTN_JS = """(document.getElementById('user-bar-settings')
    || document.getElementById('tool-settings-btn')
    || document.getElementById('rail-settings')
    || document.querySelector('#settings-btn,[data-settings],[aria-label*=ettings]'))"""


def _open_settings_by_keyboard(page):
    """Open Settings the way a KEYBOARD user does: focus the gear button and press Enter. Returns
    the opener's id (None if there is no focusable gear). The kit records document.activeElement
    at open() as the opener (orwellWindow.open), so the button must actually HOLD focus — a
    synthetic JS .click() leaves focus wherever it was (e.g. the composer), and the kit then
    rightly returns focus there on close."""
    opener_id = page.evaluate("""() => {
        const btn = %s;
        if (!btn) return null;
        btn.focus();
        return document.activeElement === btn ? (btn.id || '') : null;
    }""" % _SETTINGS_BTN_JS)
    if opener_id is None:
        return None
    page.keyboard.press("Enter")
    page.wait_for_timeout(700)
    return opener_id


def _keyboard_regression_test(page):
    """Regression test for keyboard focus trap, focus restore, and arrow-key move/resize.

    Opens the settings window (#settings-modal, an OrwellWindow kit modal) from the keyboard, then
    tests focus trapping (orwellWindow._trapFocus), focus restore to the opener on close
    (orwellWindow._teardown → _owReturnFocus), and the titlebar's arrow-key move / Shift+arrow
    resize (orwellWindow._onTitlebarKey). The move/resize affordance lives on the focusable
    .ow-titlebar (advertised via aria-keyshortcuts) — arrows pressed inside the window BODY keep
    their native meaning (scroll, caret, select) and must never move the window — so the titlebar
    is focused before the arrows are pressed. Returns a list of failure descriptions; an empty
    list means all checks passed.
    """
    failures = []
    win_sel = "#settings-modal"

    # 1. Open the settings window from the keyboard (the opener is the focused gear button).
    opener_id = _open_settings_by_keyboard(page)
    if opener_id is None:
        failures.append("Settings button not found/focusable — cannot test keyboard regression")
        return failures
    if not page.query_selector(f"{win_sel}.ow-window"):
        failures.append("Settings .ow-window not visible after keyboard open")
        return failures

    # 2. Focus Trap Test (orwellWindow._trapFocus) — Tab 10 times; focus must stay inside.
    for i in range(10):
        page.keyboard.press("Tab")
        page.wait_for_timeout(50)
        if not page.evaluate(f"!!document.activeElement?.closest('{win_sel}')"):
            failures.append(
                f"Focus trap broken at Tab {i + 1}: active element outside the settings window")
            break

    # 3. Focus Restore Test — Escape closes the modal and focus returns to the opener.
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    restored_id = page.evaluate("document.activeElement?.id || ''")
    if page.query_selector(f"{win_sel}.ow-window"):
        failures.append("Escape did not close the settings window")
    elif restored_id != opener_id:
        failures.append(
            f"Focus restore failed: expected opener id '{opener_id}', "
            f"got active id '{restored_id}'")

    # 4. Arrow Key Move/Resize Test — re-open, focus the titlebar, then press the arrows.
    if _open_settings_by_keyboard(page) is None or not page.query_selector(f"{win_sel}.ow-window"):
        failures.append("Settings window did not re-open for the arrow-key test")
        return failures
    focused_tb = page.evaluate(f"""() => {{
        const tb = document.querySelector('{win_sel} .ow-titlebar');
        if (!tb) return false;
        tb.focus();
        return document.activeElement === tb && !!tb.getAttribute('aria-keyshortcuts');
    }}""")
    if not focused_tb:
        failures.append("Settings titlebar is not keyboard-focusable / advertises no arrow keys")
        return failures

    def geom():
        return page.evaluate(f"""() => {{
            const r = document.querySelector('{win_sel}').getBoundingClientRect();
            return {{top: Math.round(r.top), height: Math.round(r.height)}};
        }}""")

    g0 = geom()
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(100)
    g1 = geom()
    if g1["top"] == g0["top"]:
        failures.append("ArrowDown did not move window: top unchanged")
    # Shrink (Shift+ArrowUp): a grow could legitimately be capped at the viewport bottom.
    page.keyboard.press("Shift+ArrowUp")
    page.wait_for_timeout(100)
    g2 = geom()
    if g2["height"] == g1["height"]:
        failures.append("Shift+ArrowUp did not resize window: height unchanged")

    # Leave the page as found: close the window again.
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    return failures


def main():
    from playwright.sync_api import sync_playwright

    axe_src = _axe_js()
    proc = rm.boot_fe()
    with_game = rm.stage_game()
    print(f"== a11y-matrix: game surfaces {'STAGED' if with_game else 'absent (no engine — chrome-only run)'}")
    finished, endgame_pending = (rm.finish_game() if with_game else (False, None))
    if rm.FINISH_SEASON:
        print(f"== a11y-matrix: endgame {'FINISHED' if finished else 'not reached'}"
              f"{' (endgame card captured)' if endgame_pending else ''}")

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for vp_name, w, h, coarse in A11Y_VIEWPORTS:
                # bypass_csp so the vendored axe-core + the x-ray style inject into the strict-CSP
                # page (a TEST-context concession; it never changes what the page renders).
                # reduced_motion="reduce" freezes the glass sheen/elastic animations (the app honors
                # prefers-reduced-motion per its liquid-glass a11y overrides) so the backdrop we
                # sample is a STILL frame — deterministic pixel reads, no animation-sweep flake.
                ctx = browser.new_context(viewport={"width": w, "height": h},
                                          has_touch=coarse, bypass_csp=True,
                                          reduced_motion="reduce")
                page = ctx.new_page()
                page.goto(rm.FE, wait_until="domcontentloaded")
                audit_state(page, vp_name, axe_src, w, h)

                # #1876: keyboard regression test on the desktop chrome surface
                if vp_name == "desktop-1366":
                    for err in _keyboard_regression_test(page):
                        record(f"a11y:keyboard-regression {err}", vp_name)

                # Endgame surfaces (live finale card + the post-season retro) render only at the phone
                # tier here, mounted in ISOLATION via rm's own seams (they never co-exist in a real
                # game). Each gets the full axe + contrast sweep — a11y coverage the source-string
                # tests never had.
                if (finished or endgame_pending) and vp_name in ("phone-390",):
                    if rm.mount_endgame_card(page, endgame_pending):
                        page.evaluate("(document.getElementById('orwell-retro')||{}).style&&"
                                      "(document.getElementById('orwell-retro').style.display='none')")
                        audit_state(page, vp_name + "+endgame-card", axe_src, w, h)
                        rm.remove_endgame_card(page)
                    if rm.mount_retro(page):
                        audit_state(page, vp_name + "+retro", axe_src, w, h)

                # The face-button grid — a synthetic multi-option decision, mounted engine-independent
                # (so it runs even in CI's chrome-only default) at the phone tier.
                if vp_name in ("phone-390",):
                    if rm.mount_face_grid_card(page):
                        page.evaluate("(document.getElementById('orwell-retro')||{}).style&&"
                                      "(document.getElementById('orwell-retro').style.display='none')")
                        audit_state(page, vp_name + "+face-grid", axe_src, w, h)
                    rm.remove_endgame_card(page)

                # Settings (the S1 surface) on a representative pair — opened for real via the gear.
                if vp_name in ("desktop-1366", "phone-390"):
                    page.evaluate(
                        "(document.getElementById('user-bar-settings') ||"
                        " document.getElementById('tool-settings-btn') ||"
                        " document.getElementById('rail-settings') ||"
                        " document.querySelector('#settings-btn,[data-settings],[aria-label*=ettings]')"
                        " || {click(){}}).click()")
                    page.wait_for_timeout(700)
                    if page.query_selector("#settings-modal"):
                        audit_state(page, vp_name + "+settings", axe_src, w, h)
                        page.evaluate("(document.querySelector('#settings-modal .ow-close')||{click(){}}).click()")
                        page.wait_for_timeout(200)
                ctx.close()
            browser.close()
    finally:
        proc.terminate()

    sys.exit(classify_and_report())


if __name__ == "__main__":
    main()
