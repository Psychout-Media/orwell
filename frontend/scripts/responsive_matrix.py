#!/usr/bin/env python3
"""The responsive matrix gate (Stream S, mechanism part 5 — ruling #16).

Boots the real front-end (and, when available, the real engine with a staged
game) and drives the UI across the viewport matrix with MEASURABLE assertions:

  overflow  — no page-level horizontal scroll; no surface wider than its box
  overlap   — no registered game surface intersects another or the composer
              (the D2 collision rule, executable)
  crowding  — no visible text below the --fs-2xs floor (~11px); no nowrap
              line-box overflow
  touch     — ≥44px interactive boxes at coarse-pointer viewports (WCAG 2.5.5)
  200% pass — doubling the root font must not break the page

KNOWN failures carry a finding ID in XFAIL below and report as xfail (exit 0).
When a finding lands, its xfail flips to a hard assertion by REMOVING the entry
— the gate ratchets. An xpass prints a nudge to remove the entry.

Engine-staged surfaces (status HUD, decision card, …) are exercised when an
engine is reachable (ORWELL_MATRIX_ENGINE=url) or buildable; otherwise the run
covers the page chrome (composer, sidebar, settings, theme modal) — still the
S1/S5/S9 regression net. CI's fe-responsive job runs ENGINE-STAGED with
ORWELL_MATRIX_FINISH=1 (#651 gap 1), so the game + endgame surfaces are
measured on every FE PR. Usage:  python3 scripts/responsive_matrix.py

J5-19 — the ENDGAME mobile sweep (opt-in). stage_game() only creates a fresh
(turn-0) game, so the endgame surfaces (#orwell-retro self-gates on
recap.finished; the endgame decision card needs a live finale pending) never
render under the default run — leaving the endgame mobile UX asserted by
source-string tests only. Set ORWELL_MATRIX_FINISH=1 (with a reachable engine)
to fast-forward the staged season to FINISHED via the engine's player-channel
advanceGame/submitDecision loop, then mount #orwell-retro + the endgame decision
card and re-run the SAME overlap/tap/crowding sweep at the phone tiers. It is
guarded (off by default; no-op without an engine or a started game) and fail-
soft, so it can never change the default fresh-game run.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

FE_DIR = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("ORWELL_MATRIX_PORT", "8893"))
FE = f"http://127.0.0.1:{PORT}"
ENGINE_URL = os.environ.get("ORWELL_MATRIX_ENGINE", "")
# J5-19 opt-in: drive the staged game to a FINISHED season so the endgame surfaces
# (#orwell-retro, the endgame decision card) actually RENDER at the phone viewports — they
# self-gate on recap.finished / a live finale pending and never appear on a fresh turn-0 game,
# so the default stage_game() run measures ZERO endgame layout. Off by default (it needs a
# reachable engine and mutates the shared sandbox); CI/operators set ORWELL_MATRIX_FINISH=1.
FINISH_SEASON = os.environ.get("ORWELL_MATRIX_FINISH", "") not in ("", "0", "false", "no")
# The user identity the FE asserts to the engine. The matrix boots the FE anonymous
# (AUTH_ENABLED=false) → the FE sends NO X-Orwell-User header → the engine routes to its
# single-tenant "default" sandbox. To drive THAT SAME game directly we must match: send no
# user header too (override with ORWELL_MATRIX_USER only if the FE is wired multi-user).
MATRIX_USER = os.environ.get("ORWELL_MATRIX_USER", "")

# width, height, coarse-pointer?
VIEWPORTS = [
    ("tiny-320", 320, 568, True),
    ("phone-390", 390, 844, True),
    ("tablet-820", 820, 1180, True),
    ("laptop-1024", 1024, 768, False),   # the ~125%-scaling proxy (S1)
    ("desktop-1366", 1366, 768, False),  # the ruling's "standard PC"
    ("wide-1440", 1440, 900, False),
]

FS_FLOOR_PX = 10.5  # the --fs-2xs floor (~11px) with sub-pixel slack

# finding-ID → substring the failure line must contain. Remove an entry when its
# finding lands; the failure then breaks the gate for real.
XFAIL = {
    # Add ONLY with a finding ID (a filed issue), remove when the finding lands — the
    # gate then ratchets the family to a hard assertion.
    #
    # #1371 (LANDED) — the finished-season retrospective (#orwell-retro) now DOCKS into the gadget
    # rail on rail-visible tiers instead of floating the top-right slot window over the in-flow rail
    # + composer, and is height-capped on the narrow / no-rail tier so it can never reach the
    # composer. The four collision families (#1371-a retro↔composer, -b status↔retro, -c
    # presence↔retro, -d retro↔room-strip) are now hard assertions — no XFAIL entry.
    #
    # ── #1418 / S4-2 — the finale panel now co-renders on a FINISHED season ──────────────────────
    # S4-2 made finaleView() SURVIVE the flip to `finished` (it returns the completed reveal + the
    # crowned winner post-season instead of null), so #orwell-finale now RENDERS post-finish — where
    # it did not before. On the narrow tiers the post-finish house therefore carries TWO large
    # post-season floating surfaces at once (the finale panel AND the tall #orwell-retro, whose
    # narrow height-cap alone reaches ~300–580px): they cannot geometrically co-fit a phone viewport,
    # so the finale overlaps the retro. The finale↔decision-card overlaps are MATRIX ARTIFACTS — a
    # LIVE decision card (endgame card / synthetic face-grid) and a POST-FINISH finale never co-exist
    # in a real game (a finished season has no live pending), yet the matrix mounts them in the same
    # sub-pass. A correct fix is a COORDINATED post-finish layout (dock/yield one of the two co-equal
    # post-season surfaces) that needs the engine-staged matrix to verify; filed here so the gate is
    # unblocked and the real fix is tracked. REMOVE these when the coordinated layout lands.
    "#1418-finale-retro": "overlap:orwell-retro intersects id*='ofin'",
    "#1418-finale-deccard": "overlap:orwell-decision-card intersects id*='ofin'",
    "#1418-finale-odec": "overlap:id*='ofin' intersects class*='odec'",
    # The same post-finish finale panel is the only floating .ow-window left mispositioned under a
    # forced top banner on the narrow tier (its narrow-sheet slot position goes stale when the banner
    # appears); fixed by the same coordinated post-finish layout above.
    "#1418-finale-banner": "banner-inset: .ow-window top",
}

# #1822 — measure at MOTION QUIESCENCE. The sweeps read getBoundingClientRect on elements the
# sub-passes just (re)mounted; at the narrow tiers those surfaces animate in (the ≤768px rail
# presents as a bottom SHEET, #893), and a rect read mid-settle-transform measures a 44×44 tap
# target fractionally under the floor (~43.6px, printed rounded as "44x44") — an intermittent
# required-gate failure on unrelated PRs. The matrix asserts GEOMETRY, never motion craft, so all
# transitions/animations are stamped out for the audited page: every state change lands at its
# final layout instantly and every rect is a rest-state rect. (The tap-target XFAIL route is
# ratcheted shut by test_738_glass_polish_8_13_22 — this is the sanctioned fix, not a registry
# entry.)
QUIESCE_CSS = ("*, *::before, *::after { transition: none !important; "
               "animation: none !important; scroll-behavior: auto !important; }")


def quiesce_motion(page):
    """Disable CSS motion on the audited page so sweeps measure rest-state geometry (#1822)."""
    try:
        page.add_style_tag(content=QUIESCE_CSS)
    except Exception:
        pass  # never let the probe stylesheet sink a run — worst case is the old timing behavior

passes, failures, xfails, xpasses = [], [], [], []


def report(kind, line):
    if kind == "fail":
        for fid, needle in XFAIL.items():
            if needle in line:
                xfails.append(f"[{fid}] {line}")
                print(f"XFAIL[{fid}] {line}")
                return
        failures.append(line)
        print(f"FAIL  {line}")
    else:
        passes.append(line)


def boot_fe():
    env = dict(os.environ, ORWELL_GAME_BUILD="1", AUTH_ENABLED="false", LOCALHOST_BYPASS="true",
               # 2026-07-11: pin the legacy soft enrichment policy — the matrix wires no model, and
               # strict (the prod default) would refuse the /new-game creation it drives.
               ORWELL_ENRICHMENT_POLICY="soft")
    if ENGINE_URL:
        env["ORWELL_ENGINE_MCP_URL"] = ENGINE_URL
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=FE_DIR, stdout=open(f"/tmp/fe-matrix-{PORT}.log", "w"), stderr=subprocess.STDOUT, env=env)
    # 120s boot budget: on a loaded self-hosted runner (the whole CI fan-out
    # hammering one host during a merge wave) uvicorn's first 200 can take well
    # past 30s. Matches the deploy/smoke.sh FE-boot wait so neither flakes.
    for _ in range(240):
        try:
            if httpx.get(FE, timeout=1).status_code == 200:
                return proc
        except Exception:
            pass
        time.sleep(0.5)
        if proc.poll() is not None:
            sys.exit(f"FAIL — uvicorn exited early; see /tmp/fe-matrix-{PORT}.log")
    sys.exit("FAIL — front-end did not come up")


def stage_game():
    """Best-effort: create a game so the game surfaces render (needs an engine)."""
    if not ENGINE_URL:
        return False
    try:
        r = httpx.post(f"{FE}/api/orwell/new-game",
                       json={"playerName": "Matrix Player", "confirm": True}, timeout=60)
        return r.status_code == 200 and bool(r.json().get("started"))
    except Exception:
        return False


def _engine_tool(name, args=None):
    """Call a player-channel engine tool the SAME way the FE does (POST /player/call, no model
    cost — the engine narrator is the deterministic Echo). Returns the parsed `result` (or None).
    Fail-soft: any transport/JSON error → None, so this can never break the matrix run."""
    try:
        headers = {"Content-Type": "application/json"}
        if MATRIX_USER:
            headers["X-Orwell-User"] = MATRIX_USER
        r = httpx.post(f"{ENGINE_URL}/player/call",
                       json={"name": name, "args": args or {}}, headers=headers, timeout=60)
        if r.status_code != 200:
            return None
        return (r.json() or {}).get("result")
    except Exception:
        return None


# The autoResolve mapping mirrors the committed fast-forward harness
# (docs/audits/playtest-harness/s4ff.mjs autoResolve) — pick the cheapest legal answer for every
# pending kind so the loop reaches a finale/finished state deterministically. No content authoring:
# the engine owns every outcome; these are throwaway picks purely to advance the closed-set loop.
def _auto_resolve(p):
    kind = p.get("kind")
    opts = p.get("options") or []

    def opt(i):
        return opts[i]["id"] if len(opts) > i and isinstance(opts[i], dict) else None

    if kind == "nominations":
        return {"kind": kind, "choice": [opt(0), opt(1)]}
    if kind == "veto-decision":
        return {"kind": kind, "use": False}
    if kind == "spectator-choice":
        # 0133 — an early-evicted player: skip ahead to the finale (the cheapest legal answer for a throwaway driver).
        return {"kind": kind, "vote": "skip"}
    if kind == "finale-interview":
        return {"kind": kind, "vote": "gracious"}
    if kind == "secret-veto":
        # 0025 (ORWELL_REACTIVE_TWISTS): hold the one-time safety — an explicit boolean is REQUIRED
        # (the engine boundary refuses a missing `use`), and holding is the cheapest legal answer.
        return {"kind": kind, "use": False}
    if kind in ("comp-intent", "comp-round"):
        return {"kind": kind, "intent": "compete"}
    if kind == "houseguests-choice":
        return {"kind": kind, "vote": opt(0)}
    if kind == "replacement":
        return {"kind": kind, "replacement": opt(0)}
    if kind in ("eviction-vote", "tie-break", "final-eviction", "juror-vote"):
        return {"kind": kind, "vote": opt(0)}
    if kind == "goodbye-message":
        return {"kind": kind, "vote": opt(0), "statement": "Take care."}
    if kind == "finale-statement":
        return {"kind": kind, "statement": "I played my own game."}
    if kind == "finale-answer":
        appeals = p.get("appeals") or ["own-game"]
        return {"kind": kind, "appeal": appeals[0]}
    if kind == "juror-question":
        return {"kind": kind, "statement": "What was your biggest move?"}
    if kind == "exit-interview":
        # 0130 — the player-evictee's producer sit-down. The pending carries `stances`
        # (gracious/defiant/bitter) and the engine reads the pick from the shared single-pick field (`vote` OR `choice`) with `statement` as the words - NOT `stance`/`message` (the engine rejected those with 'a legal exit stance is required', so a staged season where the player was evicted never finished). Pick the first legal
        # posture + throwaway words so the finish loop clears the eviction and reaches endgame.
        stances = p.get("stances") or ["gracious"]
        return {"kind": kind, "vote": stances[0], "statement": "Take care."}
    if kind == "self-evict":
        # Never volunteer the player out of the game during a fast-forward.
        return None
    return {"kind": kind}


# A finale-family pending is where the high-stakes endgame decision card lives (final eviction, the
# juror vote, the finalist statement, …). We capture the LAST such pending seen while driving so the
# audit can render a real endgame decision card even after the game has finished (the card renders
# purely from its Vault-free PendingDecisionView detail — measuring it needs no live game).
_FINALE_KINDS = {"final-eviction", "finale-statement", "finale-answer",
                 "juror-question", "juror-vote", "goodbye-message", "tie-break",
                 "finale-interview"}


def finish_game():
    """Drive the staged game to a FINISHED season via the engine's player channel (opt-in,
    fail-soft, idempotent). Returns (finished: bool, endgame_pending: dict|None) — the latter is
    the last finale-family pending observed, so the audit can also render the endgame decision card.

    Guarded three ways so it can NEVER perturb the default run:
      • only when ORWELL_MATRIX_FINISH is set AND an engine URL is configured;
      • only if a started game is actually present (else it is a no-op);
      • every engine call is fail-soft (a transport error simply ends the loop).
    """
    if not (FINISH_SEASON and ENGINE_URL):
        return False, None
    gs = _engine_tool("getGameState")
    if not (isinstance(gs, dict) and gs.get("started")):
        return False, None  # nothing to finish — leave the matrix run untouched
    finished = bool(gs.get("finished"))
    endgame_pending = None
    consec_fail = 0
    for _ in range(4000):  # generous bound; a real season ends in well under this
        adv = _engine_tool("advanceGame")
        if not isinstance(adv, dict):
            consec_fail += 1
            if consec_fail > 5:
                break
            continue
        consec_fail = 0
        if adv.get("finished"):
            finished = True
            # 0133: the crowning response can carry the post-crowning `finale-interview` card — keep it as the
            # endgame card for the audit to render (a real card, deliberately left unanswered).
            fp = adv.get("pending")
            if fp and fp.get("kind") in _FINALE_KINDS:
                endgame_pending = fp
            break
        p = adv.get("pending")
        if not p:
            continue
        if p.get("kind") in _FINALE_KINDS:
            endgame_pending = p  # remember the latest endgame card for the audit
        decision = _auto_resolve(p)
        if decision is None:  # e.g. self-evict — do not resolve; just keep advancing
            continue
        sub = _engine_tool("submitDecision", decision)
        if not isinstance(sub, dict):
            consec_fail += 1
            if consec_fail > 5:
                break
            continue
        if sub.get("finished"):
            finished = True
            break
    return finished, endgame_pending


GAME_SURFACES = ["#orwell-status", "#orwell-presence",
                 "#orwell-retro", "#orwell-decision-card", "[id*='ofin']", "[class*='odec']",
                 # #933: the jump-to-bottom fab shares the above-composer slot with the decision card
                 # and overlapped it at <=360px. The card now hard-suppresses the fab (#948), so they
                 # never coexist — register the fab in the D2 overlap sweep so a regression that lets
                 # them paint together is caught (the fab is opacity:0/hidden otherwise, so is_visible()
                 # filters it out in the no-card case).
                 "#orwell-scroll-bottom",
                 # M3-1: the room-strip chips sit directly above the composer — register so the
                 # overlap sweep (and the generic overflow:page check) covers it at every phone
                 # tier down to tiny-320, proving it collapses gracefully on narrow viewports.
                 "#orwell-room-strip",
                 # #1875: the chat transcript — chyrons, message bubbles, and the reasoning
                 # accordion are now swept by the a11y/responsive gates. Registering here
                 # propagates to CROWD_SELECTOR automatically (both overlap and crowding sweeps).
                 "#chat-history"]
CHROME = {"composer": "#chat-form", "sidebar": "#sidebar"}

# #651 Gap 2: the crowding scan used to cover only settings + status + composer — a sub-floor font
# in the docked gadgets (presence/deals/cast), the decision/finale cards, or the retro shipped
# green even in a staged run. Scan EVERY registered game surface (reuse GAME_SURFACES so a newly
# registered surface is crowding-covered automatically) plus the page chrome.
CROWD_SELECTOR = ", ".join(
    ["#settings-modal *", ".settings-layout *", "#chat-form *"]
    + [f"{sel} *" for sel in GAME_SURFACES])


# #651: several sweeps OPEN the gadget-rail drawer (the touch sweep so its panel controls are in
# view; the banner sweep to measure the rail under the inset) — and audit_page runs several times
# on the SAME page (base, +endgame-card, +face-grid, +retro, +settings). A drawer left open bleeds
# the modal slide-over (with its docked #orwell-status/#orwell-presence cards) into every LATER
# sub-pass's D2 overlap sweep, manufacturing false "status intersects decision-card" collisions no
# real player state produces (the open drawer is a deliberate overlay — the #740 sweep exempts it
# for the same reason). Every sweep that opens the drawer must close it back down. Fail-soft.
def _close_drawer(page):
    try:
        page.evaluate(
            "(() => { const r = document.getElementById('gadget-rail');"
            " if (r) r.classList.remove('grail-open');"
            " document.querySelectorAll('.grail-scrim-on')"
            "  .forEach(e => e.classList.remove('grail-scrim-on')); })()")
        page.wait_for_timeout(200)
    except Exception:
        pass


def audit_page(page, vp_name, width, height, coarse, with_game):
    page.wait_for_timeout(2500)

    # #1875: mount test chat content (bubbles, reasoning accordion, chyrons) so the
    # overlap / crowding / tap-target sweeps cover the chat transcript during staged runs.
    # Mount AFTER the 2.5s settle and BEFORE the first sweep below. Fail-soft.
    mount_chat_transcript(page)

    # --- overflow: the page itself never scrolls horizontally -----------------
    over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    if over > 1:
        report("fail", f"{vp_name} overflow:page scrolls horizontally by {over}px")
    else:
        report("pass", f"{vp_name} overflow:page")

    # --- the composer is visible and clear of the bottom edge (E92) ----------
    comp = page.query_selector("#message") or page.query_selector(CHROME["composer"])
    cbox = comp.bounding_box() if comp and comp.is_visible() else None
    if not cbox:
        if with_game:
            report("fail", f"{vp_name} composer missing/invisible")
        else:
            # Pre-game with no model configured the holding state hides the
            # composer by design (F5) — a chrome-only run cannot assert it.
            report("pass", f"{vp_name} composer (skipped — holding state, no game)")
    else:
        if cbox["y"] + cbox["height"] > height - 8:
            report("fail", f"{vp_name} composer-bottom-inset: composer bottom at {cbox['y']+cbox['height']:.0f} of {height}")
        else:
            report("pass", f"{vp_name} composer inset")

    # --- overlap: registered surfaces vs each other and the composer (D2) ----
    boxes = {}
    els = {}
    for sel in GAME_SURFACES:
        el = page.query_selector(sel)
        if el and el.is_visible():
            b = _clipped_box(el)
            # M3-4: is_visible() doesn't account for opacity (only `display`/`visibility`/size) —
            # skip an element that is fully transparent (e.g. the scroll-bottom fab between shows,
            # which fades via opacity rather than display so its CSS transition can run). It isn't
            # painting anything, so it can't be "overlapping" a real surface.
            if b and b["width"] > 4 and b["height"] > 4 and b.get("opacity", 1) > 0.05:
                key = sel.strip('#[]*=\"')
                boxes[key] = b
                els[key] = el
    if cbox:
        for name, b in boxes.items():
            if _intersects(b, cbox):
                report("fail", f"{vp_name} overlap:{name} intersects the composer")
    names = list(boxes)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, c = names[i], names[j]
            if not _intersects(boxes[a], boxes[c]):
                continue
            # M3-4: two GAME_SURFACES selectors can resolve to the SAME element, or one nested
            # inside the other — e.g. the id selector `#orwell-decision-card` and the broader
            # `[class*='odec']` catch-all both match the card once it carries an .odec-* class
            # (the risk/done state) or once its own internal `.odec-*` children exist (every
            # decision card has one). That is nested DOM STRUCTURE, not a D2 surface collision —
            # skip a pair in an ancestor/descendant (or identical-element) relationship. A
            # genuinely separate overlapping surface (e.g. the scroll-bottom fab painting over
            # the card, the very regression `[class*='odec']` + `#orwell-scroll-bottom` guards
            # against) is unrelated in the DOM and is still reported below.
            nested = els[a].evaluate(
                "(node, other) => node === other || node.contains(other) || other.contains(node)",
                els[c],
            )
            if nested:
                continue
            # #1875 registered `#chat-history` (the transcript) as a surface. The transcript is the
            # scroll CANVAS: a FLOATING overlay — a non-docked .ow-window (finale, retro on the
            # no-rail tier) or a fixed/absolute fab (the jump-to-latest button, which exists to
            # float over the transcript) — paints above it BY DESIGN, exactly like the #740 open-
            # drawer exemption. Only an IN-FLOW surface (a docked panel, the room strip) colliding
            # with the transcript is a real layout bug, so that is still reported.
            if "chat-history" in (a, c):
                other = els[c] if a == "chat-history" else els[a]
                floats = other.evaluate(
                    "(n) => { const w = n.closest('.ow-window');"
                    " if (w && !w.classList.contains('ow-docked')) return true;"
                    " for (let e = n; e && e !== document.body; e = e.parentElement) {"
                    "   const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'absolute') return true; }"
                    " return false; }"
                )
                if floats:
                    continue
            report("fail", f"{vp_name} overlap:{a} intersects {c}")
    report("pass", f"{vp_name} overlap sweep ({len(boxes)} surfaces)")

    # --- #740: the gadget RAIL / cast-PIN card never sits over the composer ----
    # The conversation IS the game, so the composer (.chat-input-bar) must never be occluded by a
    # rail or pinned cast card. The desktop rail is an in-flow flex column (clears by construction);
    # the mobile drawer is a deliberate modal slide-over (opened on purpose, dismissed by ×/tap-out),
    # so a CLOSED rail and the OPEN drawer are both legitimate non-findings — we only flag a rail/pin
    # card that is actually painting over the composer while NOT the intentionally-open drawer.
    if cbox:
        rail_overlap = page.evaluate(
            """
            (() => {
              const comp = document.querySelector('.chat-input-bar');
              if (!comp) return [];
              const cs0 = getComputedStyle(comp);
              if (cs0.display === 'none' || cs0.visibility === 'hidden') return [];
              const cb = comp.getBoundingClientRect();
              if (cb.width <= 0 || cb.height <= 0) return [];
              const pad = 2;  // border/shadow grace, matching the py _intersects
              const hits = (b) => !(b.right - pad <= cb.left || cb.right - pad <= b.left ||
                                    b.bottom - pad <= cb.top || cb.bottom - pad <= b.top);
              const out = [];
              const rail = document.getElementById('gadget-rail');
              const drawerOpen = rail && rail.classList.contains('grail-open');
              // The cast-pin card + the whole rail (only when it has gone floating, never the
              // in-flow desktop column or the deliberate open drawer).
              const cands = [];
              if (rail && !rail.hasAttribute('hidden') && !drawerOpen) {
                const rp = getComputedStyle(rail).position;
                if (rp === 'fixed' || rp === 'absolute') cands.push(['gadget-rail(floating)', rail]);
              }
              const pin = document.getElementById('orwell-cast-pin');
              if (pin && getComputedStyle(pin).display !== 'none' && !drawerOpen) {
                // A cast-pin card that has escaped the rail body (orphaned onto <body>) and floats.
                const inRail = !!pin.closest('#gadget-rail-body');
                const pp = getComputedStyle(pin).position;
                if (!inRail && (pp === 'fixed' || pp === 'absolute')) cands.push(['cast-pin(orphaned)', pin]);
              }
              for (const [name, el] of cands) {
                const b = el.getBoundingClientRect();
                if (b.width > 4 && b.height > 4 && hits(b)) out.push(name);
              }
              return out;
            })()
            """
        )
        for name in (rail_overlap or []):
            report("fail", f"{vp_name} overlap:{name} intersects the composer")
        if not rail_overlap:
            report("pass", f"{vp_name} rail/cast-pin clears composer")

    # --- crowding: visible text at or above the floor; nowrap overflow -------
    crowd = page.evaluate(
        """(args) => {
          const out = [];
          const els = document.querySelectorAll(args.selector);
          let i = 0;
          for (const el of els) {
            if (i++ > 2500) break;
            if (!el.offsetParent || !el.textContent || !el.textContent.trim()) continue;
            if (el.children.length > 0) continue;
            const cs = getComputedStyle(el);
            const fs = parseFloat(cs.fontSize);
            if (fs && fs < args.floor) out.push('font ' + fs.toFixed(1) + 'px: ' + el.textContent.trim().slice(0, 30));
            if (cs.whiteSpace === 'nowrap' && cs.overflow === 'visible' && el.scrollWidth > el.clientWidth + 2)
              out.push('nowrap-overflow: ' + el.textContent.trim().slice(0, 30));
          }
          return out.slice(0, 6);
        }""",
        {"selector": CROWD_SELECTOR, "floor": FS_FLOOR_PX},
    )
    scope = "settings" if page.evaluate("!!document.querySelector('#settings-modal,[class*=settings-layout]')") else "page"
    for c in crowd:
        report("fail", f"{vp_name} crowding:{scope} {c}")
    if not crowd:
        report("pass", f"{vp_name} crowding")

    # --- touch: coarse-pointer floors ----------------------------------------
    # RESP-4 (#625): floor is the PROJECT 44px (WCAG 2.5.5), not the old 36px that let 36–43px
    # controls ship green. Selectors widened past `button`/`select` to the kit + composer + game
    # chrome that the narrow set missed (anchors-as-buttons, the gadget-rail/cast/window controls,
    # the composer icon buttons, the scroll-to-latest fab). The gadget-rail drawer is opened first
    # (fail-soft) so its panel controls are actually IN VIEW for the sweep instead of stowed.
    if coarse:
        try:
            page.evaluate("(document.querySelector('.gadget-rail-open,#gadget-rail-open')||{click(){}}).click()")
            page.wait_for_timeout(350)
        except Exception:
            pass
        # F4b: the visibility probe is getBoundingClientRect-based, NOT offsetParent-based.
        # `offsetParent` is null for every `position: fixed` element (and inside a transformed
        # ancestor), so the old filter SILENTLY EXCLUDED the fixed chrome this sweep is meant to
        # measure — the composer icon buttons, the scroll-bottom fab, the gadget-rail toggle, the
        # top corner controls. A rect + computed-style test treats a painted fixed/transformed
        # control as visible (a real box, not display:none / visibility:hidden / opacity:0), so the
        # 44px floor is actually enforced against it.
        small = page.evaluate("""
          [...document.querySelectorAll(
             'button, [role=button], a[role=button], a.btn, select, .settings-nav-item,'
             + '.input-icon-btn, .export-dl-btn, #orwell-scroll-bottom,'
             + '.gadget-rail-open, .gadget-rail-head button, .ow-controls button, .ow-dismiss,'
             + '.minimized-dock-x, .oc-pin, .oc-backfill, .opt-dismiss')]
            .filter(e => {
               if (e.classList.contains('tap-exempt')) return false;
               const cs = getComputedStyle(e);
               if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
               if (parseFloat(cs.opacity) === 0) return false;
               const r = e.getBoundingClientRect();
               return r.width > 0 && r.height > 0;  // painted box (valid for fixed/transformed els)
            })
            .map(e => { const r = e.getBoundingClientRect();
                        return { t: (e.innerText || e.ariaLabel || e.id || '?').slice(0, 20), w: r.width, h: r.height }; })
            .filter(b => b.w > 0 && b.h > 0 && (b.w < 44 || b.h < 44))
            .slice(0, 8)
        """)
        for s in small:
            report("fail", f"{vp_name} touch: {s['t']!r} {s['w']:.0f}x{s['h']:.0f}")
        if not small:
            report("pass", f"{vp_name} touch floors")

        # R-RSP-6 (#1877): flag interactive elements that are opacity:0 but painted
        invisible_tappable = page.evaluate("""
          [...document.querySelectorAll(
             'button, [role=button], a[role=button], a.btn, select, .settings-nav-item,'
             + '.input-icon-btn, .export-dl-btn, .ow-dismiss,'
             + '.folder-delete-btn, .folder-rename-btn')]
            .filter(e => {
               if (e.classList.contains('tap-exempt')) return false;
               const cs = getComputedStyle(e);
               if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
               if (parseFloat(cs.opacity) !== 0) return false;
               const r = e.getBoundingClientRect();
               return r.width > 0 && r.height > 0;
            })
            .map(e => { const r = e.getBoundingClientRect();
                        return { t: (e.innerText || e.ariaLabel || e.id || '?').slice(0, 20), w: r.width, h: r.height }; })
            .slice(0, 8)
        """)
        for s in invisible_tappable:
            report("fail", f"{vp_name} invisible-tappable: {s['t']!r} {s['w']:.0f}x{s['h']:.0f} (opacity:0 but painted)")
        if not invisible_tappable:
            report("pass", f"{vp_name} no invisible-tappable controls")
        _close_drawer(page)  # #651: never leak the opened drawer into the next sub-pass


def _intersects(a, b):
    pad = 2  # px of grace for borders/shadows
    return not (a["x"] + a["width"] - pad <= b["x"] or b["x"] + b["width"] - pad <= a["x"] or
                a["y"] + a["height"] - pad <= b["y"] or b["y"] + b["height"] - pad <= a["y"])


# M3-4: an element's raw getBoundingClientRect() (what Playwright's bounding_box() reports) is its
# full LAYOUT extent — it does NOT shrink when a scrollable ancestor clips/scrolls it (e.g. the
# decision card's OrwellSheet host, `.ow-sheet.ow-sheet-anchored .ow-sheet-body { max-height: 60vh;
# overflow: auto; }`, deliberately contains a long option list). A many-option decision at a short
# phone viewport can be TALLER than its own sheet, but a real player never sees it "overlap" the
# composer below — the sheet clips and scrolls it. Clip the measured box to every scrollable
# ancestor within a bounded walk so the D2 overlap sweep matches what actually PAINTS, not the
# unclipped layout box.
_CLIP_TO_SCROLL_ANCESTOR_JS = """
(el) => {
  const r = el.getBoundingClientRect();
  let clip = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  let node = el.parentElement, hops = 0;
  while (node && hops < 8) {
    const cs = getComputedStyle(node);
    if (/(auto|hidden|scroll)/.test(cs.overflowY) || /(auto|hidden|scroll)/.test(cs.overflowX)) {
      const pr = node.getBoundingClientRect();
      clip = {
        left: Math.max(clip.left, pr.left), top: Math.max(clip.top, pr.top),
        right: Math.min(clip.right, pr.right), bottom: Math.min(clip.bottom, pr.bottom),
      };
    }
    node = node.parentElement; hops++;
  }
  return { x: clip.left, y: clip.top,
           width: Math.max(0, clip.right - clip.left), height: Math.max(0, clip.bottom - clip.top),
           opacity: parseFloat(getComputedStyle(el).opacity) };
}
"""


def _clipped_box(el):
    """The element's box, clipped to any scrolling ancestor — see _CLIP_TO_SCROLL_ANCESTOR_JS.
    Also carries `opacity` so callers can skip an element that is in the DOM and
    `is_visible()`-true (has layout, no `visibility:hidden`) but fully transparent — e.g. a
    fixed-position affordance (the scroll-bottom fab) that fades via opacity, never `display`, so
    it is ALWAYS geometrically present at its anchored spot even while fully invisible/inert."""
    try:
        return el.evaluate(_CLIP_TO_SCROLL_ANCESTOR_JS)
    except Exception:
        return el.bounding_box()


# #758 — a top system-banner must RESERVE space + COMPRESS the fixed-chrome layer below it: no
# window / sidebar / rail / composer may sit UNDER the banner, and the lowest window stays in the
# viewport (compressed, not shifted off the bottom). The banner is position:fixed; the body
# padding-top only re-flows in-flow content — the fixed layer must consume --on-banner-inset.
#
# #758b — when MULTIPLE top banners stack (engine-status + a reconnecting notice + …, all in the
# ONE #orwell-notice-banner host), the reserved inset must equal the host's TOTAL live height, so
# nothing is covered by any banner. This sweep forces TWO banners (incl. a long multi-line one that
# wraps) and asserts BOTH that --on-banner-inset == the host height AND that no chrome sits under
# the combined stack.
def audit_banner(page, vp_name, width, height):
    # Force TWO deterministic top banners via the notice kit's own API, then open a top-slotted kit
    # window (+ a TALL one to prove compression) and show the rail. Fail-soft: if the kit/seam
    # isn't present (a degraded chrome-only DOM) the sweep no-ops rather than flaking.
    # The tall-window COMPRESSION probe runs on the wide tier only: on the narrow tier kit windows
    # are full-width SHEETS (the slot sheet-host) whose max-height cap (min(70dvh,560px)) can itself
    # exceed a tiny phone viewport — a sheet-host concern, not the banner-reserve one. On narrow we
    # still assert the load-bearing invariant: nothing renders UNDER the banner.
    wide = width > 768
    shown = page.evaluate(
        """(wide) => {
            const K = window.OrwellNoticeKit;
            if (!K || !K.create) return false;
            try {
              const n = K.create({ id: 'matrix-banner', kind: 'system-notice', severity: 'error',
                                   title: 'System: connection lost', placement: 'top-banner', persistDismiss: false });
              if (n.setBody) n.setBody('The house is offline — reconnecting…');
              n.show();
              // #766: a SECOND banner (equal severity ⇒ latest-wins) must REPLACE the first, never
              // stack — leaving the single long multi-line card, which also exercises the #758b
              // wrap/re-measure inset path on a narrow viewport.
              const n2 = K.create({ id: 'matrix-banner-2', kind: 'system-notice', severity: 'error',
                                    title: 'Big Brother engine unavailable.', placement: 'top-banner', persistDismiss: false });
              if (n2.setBody) n2.setBody('The app could not reach the game service at http://127.0.0.1:8765 — '
                + 'connection refused. The show cannot load until it is back. A long reason that wraps to '
                + 'several lines on a narrow viewport, exercising the height-measurement race.');
              n2.show();
            } catch (_) { return false; }
            try {
              if (window.OrwellWindowKit) {
                window.OrwellWindowKit.create({ id: 'matrix-banner-win', title: 'Banner Top', slot: 'top-left',
                  content: '<div style=\"height:140px\">top</div>' }).open();
                if (wide) window.OrwellWindowKit.create({ id: 'matrix-banner-tall', title: 'Banner Tall', slot: 'top-center',
                  content: '<div style=\"height:760px\">tall</div>' }).open();
              }
            } catch (_) {}
            try { (document.querySelector('.gadget-rail-open,#gadget-rail-open') || { click() {} }).click(); } catch (_) {}
            return true;
        }""",
        wide,
    )
    if not shown:
        report("pass", f"{vp_name} banner-inset (skipped — notice kit unavailable)")
        return
    page.wait_for_timeout(500)
    m = page.evaluate(
        """() => {
            const host = document.getElementById('orwell-notice-banner');
            const br = host ? host.getBoundingClientRect() : null;
            const insetVar = parseFloat(getComputedStyle(document.body).getPropertyValue('--on-banner-inset')) || 0;
            const cardCount = host ? host.children.length : 0;
            const sels = ['.ow-window', '#sidebar', '#gadget-rail', '.chat-input-bar', '#chat-form'];
            const rows = []; let lowestWin = -1;
            for (const sel of sels) {
              document.querySelectorAll(sel).forEach(el => {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') return;
                // #1371: a DOCKED kit window (.ow-docked) is rail-flow content inside the
                // scrollable #gadget-rail-body — its raw layout box legitimately runs taller than
                // the viewport (the rail scrolls), so it is NOT a floating window subject to the
                // banner compression / under-banner rules. The rail itself (#gadget-rail, measured
                // above) carries the fixed-chrome compression contract. Skip docked windows (mirrors
                // the overlap sweep's _clipped_box philosophy — docked opts out of floating geometry).
                if (sel === '.ow-window' && el.classList.contains('ow-docked')) return;
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return;
                rows.push({ sel, top: r.top, bottom: r.bottom });
                if (sel === '.ow-window' && r.bottom > lowestWin) lowestWin = r.bottom;
              });
            }
            return { bannerBottom: br ? br.bottom : 0, bannerHeight: br ? br.height : 0,
                     insetVar: insetVar, cardCount: cardCount, rows, lowestWin };
        }"""
    )
    bb = m["bannerBottom"]
    if bb <= 1:
        report("pass", f"{vp_name} banner-inset (banner did not render)")
        page.evaluate("['matrix-banner','matrix-banner-2'].forEach(id=>{const e=document.getElementById(id);if(e)e.remove();})")
        _close_drawer(page)
        return
    # #766: ONLY ONE top banner may EVER be present — after firing two banners the host must hold
    # EXACTLY ≤1 .on-card (the 2nd replaced the 1st), never a stack.
    if m["cardCount"] > 1:
        report("fail", f"{vp_name} banner-inset: host holds {m['cardCount']} banner cards — only one "
                       "may ever be present (#766: show() must replace, never stack)")
    else:
        report("pass", f"{vp_name} banner-inset single-card ({m['cardCount']} card — #766)")
    # #758b: the reserved inset must equal the (single) banner host's LIVE height — a stale/short
    # inset is exactly how the engine-status banner covered content (it can still wrap taller narrow).
    if abs(m["insetVar"] - m["bannerHeight"]) > 2:
        report("fail", f"{vp_name} banner-inset: --on-banner-inset {m['insetVar']:.0f} != banner host height "
                       f"{m['bannerHeight']:.0f} (the single banner's full height must be reserved)")
    else:
        report("pass", f"{vp_name} banner-inset height (inset {m['insetVar']:.0f}px == host)")
    under = [r for r in m["rows"] if r["top"] < bb - 2]   # 2px grace
    for r in under:
        report("fail", f"{vp_name} banner-inset: {r['sel']} top {r['top']:.0f} is under the banner bottom {bb:.0f}")
    # COMPRESSION (wide tier only): the lowest window must stay in the viewport — a tall window
    # shrinks below the banner rather than running off the bottom. The narrow sheet-host tier is
    # exempt (its sheets scroll/stack by design; the under-banner check still applies there).
    off_bottom = wide and m["lowestWin"] > height + 2
    if off_bottom:
        report("fail", f"{vp_name} banner-inset: lowest window bottom {m['lowestWin']:.0f} > viewport {height}")
    if not under and not off_bottom:
        report("pass", f"{vp_name} banner-inset ({len(m['rows'])} surfaces all below the banner"
                       f"{', in-viewport' if wide else ''})")
    # tear the forced banners + probe windows back down so the rest of the sweep measures clean
    page.evaluate(
        """() => {
            ['matrix-banner-win','matrix-banner-tall'].forEach(id => {
              const el = document.getElementById(id); if (el) el.remove();
            });
            const h = document.getElementById('orwell-notice-banner'); if (h) h.textContent = '';
            try { document.body.style.removeProperty('--on-banner-inset'); document.body.style.paddingTop = ''; } catch (_) {}
        }"""
    )
    _close_drawer(page)  # #651: this sweep opened the rail drawer too — see _close_drawer
    page.wait_for_timeout(150)


def mount_endgame_card(page, endgame_pending):
    """Render the endgame decision card by dispatching the engine's own Vault-free pending detail
    over the `orwell:pending` window event (exactly how chat.js arms it). The card renders from the
    detail alone — no live game is needed to MEASURE its layout (the matrix never clicks Confirm).
    Returns True if a card mounted. Fail-soft."""
    if not endgame_pending:
        return False
    try:
        import json as _json
        page.evaluate(
            "(p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }))",
            endgame_pending if isinstance(endgame_pending, dict) else _json.loads(_json.dumps(endgame_pending)),
        )
        page.wait_for_timeout(600)  # let the card's entrance animation settle
        return bool(page.query_selector("#orwell-decision-card"))
    except Exception:
        return False


def remove_endgame_card(page):
    """Tear the decision card back down so the next sub-pass measures a surface in ISOLATION — the
    live finale card and the post-season retro never co-exist in a real game (one is live, one is
    finished), so measuring them together would manufacture a false cross-surface overlap."""
    try:
        page.evaluate("(document.getElementById('orwell-decision-card')||{remove(){}}).remove()")
    except Exception:
        pass


# M3-4 (road-to-market — "faces on decisions"): a synthetic multi-option pending (mirrors the
# browser_smoke.py fixture convention — single-letter placeholder names, never a persona-plausible
# full name; the matrix never reaches a real game far enough to land a live "nominations" pending on
# a fresh turn-0 stage). Six houseguest options is enough to exercise the wrapped face-button GRID
# (not just a single row) at a phone width.
_FACE_GRID_PENDING = {
    "kind": "nominations",
    "prompt": "Name your two nominees for eviction this week.",
    "pick": 2,
    "binding": True,
    "options": [
        {"id": "npc:1", "name": "A"}, {"id": "npc:2", "name": "B"},
        {"id": "npc:3", "name": "C"}, {"id": "npc:4", "name": "D"},
        {"id": "npc:5", "name": "E"}, {"id": "npc:6", "name": "F"},
    ],
}


def mount_face_grid_card(page):
    """M3-4: force-mount a synthetic decision card carrying SEVERAL houseguest options (the
    face-button grid) via the SAME orwell:pending seam mount_endgame_card uses — so the matrix
    measures the grid's layout without depending on a live engine ever reaching a nominations
    pending on the fresh turn-0 game the default run stages. Fail-soft; needs no engine."""
    try:
        page.evaluate(
            "(p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }))",
            _FACE_GRID_PENDING,
        )
        page.wait_for_timeout(600)  # let the card's entrance animation + face renders settle
        return bool(page.query_selector("#orwell-decision-card .odec-face"))
    except Exception:
        return False


def mount_chat_transcript(page):
    """#1875: populate #chat-history with test content (bubbles, reasoning accordion, chyrons)
    so the a11y/responsive sweeps actually measure chat transcript surfaces during a staged run.
    Injects user + AI message bubbles (matching the app's real DOM class structure), a thinking
    section with visible reasoning content, and dispatches orwell:announcements for chyrons.
    Returns True if content was mounted. Fail-soft."""
    try:
        page.evaluate("""
            (() => {
                const ch = document.getElementById('chat-history');
                if (!ch) return false;
                // IDEMPOTENT: audit_state() runs this once per sub-pass (endgame card, retro,
                // settings…) on the SAME page — re-appending a fresh transcript each time stacked
                // duplicate bubbles down the column, under whatever card/window the pass mounted.
                if (document.getElementById('matrix-think-1')) return true;

                // User bubble — matches chat.js addMessage('user', …) DOM structure
                const ub = document.createElement('div');
                ub.className = 'msg msg-user';
                ub.innerHTML = '<div class="body">Hello, what is the current house situation?</div>';
                ch.appendChild(ub);

                // AI bubble — matches chat.js addMessage('assistant', …) DOM structure
                const ab = document.createElement('div');
                ab.className = 'msg msg-ai';
                ab.innerHTML = '<div class="body">I can help with that. The current power of veto holder is Kevin, and nominations are coming up soon.</div>';
                ch.appendChild(ab);

                // Thinking section (reasoning accordion) — EXPANDED, the way the live stream
                // opens it: the accordion body is `max-height:0; overflow:hidden` until it
                // carries `.expanded` (style.css .thinking-content.expanded), so without the
                // class the reasoning text is clipped away and never actually rendered.
                const ts = document.createElement('div');
                ts.className = 'thinking-section';
                ts.innerHTML = '<div class="thinking-header" data-thinking-id="matrix-think-1">'
                    + '<div class="thinking-header-left"><span class="live-think-header-text">Thinking\u2026</span></div>'
                    + '<span class="thinking-toggle live-think-toggle expanded" id="matrix-think-1-toggle"></span></div>'
                    + '<div class="thinking-content expanded" id="matrix-think-1">'
                    + '<div class="thinking-content-inner live-think-inner">Here is my reasoning about the game theory optimal play given your current position and the alliances at play this week.</div></div>';
                ch.appendChild(ts);

                // Chyron via announcement dispatch — matches orwellDecision.js orwell:announcements
                window.dispatchEvent(new CustomEvent('orwell:announcements', {
                    detail: {
                        announcements: [{
                            id: 'matrix-chyron-1',
                            kind: 'eviction',
                            headline: 'Test: A houseguest has been evicted from the Big Brother house'
                        }]
                    }
                }));

                return true;
            })()
        """)
        page.wait_for_timeout(300)  # let chyrons render
        return bool(page.query_selector("#chat-history .msg"))
    except Exception:
        return False


def _set_retro_dismissed(page, on):
    """POLL-PROOF retro isolation. #orwell-retro self-shows on its own 30s poll (render() →
    showPanel), which RACES a bare display:none the matrix sets to isolate a decision card —
    re-showing the retro mid-pass and manufacturing a false retro↔card overlap. The retro's render()
    honors the `orwell-retro-dismissed` sessionStorage flag (its onClose sets it), so SETTING it keeps
    the panel hidden THROUGH polls; CLEARING it (+ display:'') lets a pass show it again. Fail-soft."""
    try:
        if on:
            page.evaluate("(()=>{try{sessionStorage.setItem('orwell-retro-dismissed','1')}catch(_){}; "
                          "const e=document.getElementById('orwell-retro'); if(e)e.style.display='none';})()")
        else:
            page.evaluate("(()=>{try{sessionStorage.removeItem('orwell-retro-dismissed')}catch(_){}; "
                          "const e=document.getElementById('orwell-retro'); if(e)e.style.display='';})()")
    except Exception:
        pass


def mount_retro(page):
    """Build+show #orwell-retro via its headless seam (window._orwellRetroEnsure, mirrored from the
    other panels). On a finished season its own 30s poll fills the body (winner headline, highlights,
    the 44px 'Open the Vault' button); we wait for one tick so the tap sweep sees the real button.
    Returns True if the panel mounted visible. Fail-soft."""
    try:
        # An earlier card pass may have SUPPRESSED the panel (dismissed flag + display:none) to
        # isolate the card; clear that so the panel is its natural self for the retro measurement.
        _set_retro_dismissed(page, False)
        page.evaluate("typeof window._orwellRetroEnsure === 'function' && window._orwellRetroEnsure()")
        page.wait_for_timeout(1500)
        page.evaluate("(document.getElementById('orwell-retro')||{}).style&&(document.getElementById('orwell-retro').style.display='')")
        el = page.query_selector("#orwell-retro")
        return bool(el and el.is_visible())
    except Exception:
        return False


def main():
    from playwright.sync_api import sync_playwright
    proc = boot_fe()
    with_game = stage_game()
    print(f"== matrix: game surfaces {'STAGED' if with_game else 'absent (no engine — chrome-only run)'}")
    # J5-19 (opt-in): drive the staged season to a finished/endgame state so the endgame surfaces
    # actually render at the phone viewports. No-op + fail-soft unless ORWELL_MATRIX_FINISH is set and
    # the engine is reachable with a started game — it can never alter the default fresh-game run.
    finished, endgame_pending = (finish_game() if with_game else (False, None))
    if FINISH_SEASON:
        print(f"== matrix: endgame {'FINISHED' if finished else 'not reached'}"
              f"{' (endgame card captured)' if endgame_pending else ''}")
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for vp_name, w, h, coarse in VIEWPORTS:
                ctx = browser.new_context(viewport={"width": w, "height": h},
                                          has_touch=coarse)
                page = ctx.new_page()
                page.goto(FE, wait_until="domcontentloaded")
                quiesce_motion(page)  # #1822: sweeps measure rest-state geometry, never mid-settle
                audit_page(page, vp_name, w, h, coarse, with_game)

                # #758: a top system-banner must reserve space + compress the fixed-chrome layer
                # below it (no window/sidebar/rail/composer under the banner; lowest window stays
                # in-viewport). Forced shown here so it's measured at every viewport tier.
                audit_banner(page, vp_name, w, h)

                # J5-19: the endgame mobile sweep — only the phone tiers, only when a finished/endgame
                # season was actually reached. The endgame decision card (live finale) and the
                # post-season retro never co-exist in a real game, so each is mounted + measured in
                # ISOLATION by the SAME overflow/overlap/tap/crowding sweep — covering endgame UX that
                # was previously asserted by source-string tests only, never a viewport render.
                if (finished or endgame_pending) and vp_name in ("phone-390", "tiny-320"):
                    if mount_endgame_card(page, endgame_pending):
                        # On a finished season the retro panel may already be self-visible from its
                        # own background poll; suppress it for THIS pass so the live-card layout is
                        # measured alone (the two are never simultaneous in a real game). Poll-proof
                        # (the dismissed flag, not a bare display:none the 30s poll would undo).
                        _set_retro_dismissed(page, True)
                        audit_page(page, vp_name + "+endgame-card", w, h, coarse, with_game)
                        remove_endgame_card(page)
                    if mount_retro(page):
                        audit_page(page, vp_name + "+retro", w, h, coarse, with_game)

                # M3-4: the face-button grid — a synthetic multi-option decision (nominations, six
                # houseguest faces) mounted the SAME way as the endgame card above, but engine-
                # independent (a fresh turn-0 stage_game() never reaches nominations, and CI's
                # fe-responsive job runs with no ORWELL_MATRIX_ENGINE at all) — so this case runs
                # unconditionally at the phone tiers, covering the DoD's named "face-button grid on
                # the phone profile" regardless of whether a live game is staged.
                if vp_name in ("phone-390", "tiny-320"):
                    if mount_face_grid_card(page):
                        # #651: same isolation rule as the endgame-card pass above — on a FINISHED
                        # season (ORWELL_MATRIX_FINISH) the retro panel is self-visible from its own
                        # poll, but a live decision card and the post-season retro never co-exist in
                        # a real game; suppress the retro for THIS pass so the synthetic card's layout
                        # is measured alone, then restore it. Poll-proof (dismissed flag) so the 30s
                        # poll can't re-show the retro mid-pass and fake a retro↔card overlap.
                        _set_retro_dismissed(page, True)
                        audit_page(page, vp_name + "+face-grid", w, h, coarse, with_game)
                        _set_retro_dismissed(page, False)
                    remove_endgame_card(page)

                # G6: the settings tab rail keeps its LEFT orientation in any
                # modal wider than the 480 token (explicit user preference);
                # top-bar stacking is the last resort below it. #553: Settings is
                # now a kit OrwellWindow built lazily on first open — so #settings-modal
                # does NOT exist until opened. Open it for real (the gear fires
                # settings.js open(); a programmatic .click() works regardless of the
                # gear's own visibility), measure, then close via the kit ×.
                page.evaluate(
                    "(document.getElementById('user-bar-settings') ||"
                    " document.getElementById('tool-settings-btn') ||"
                    " document.getElementById('rail-settings') || {click(){}}).click()")
                # Wait for the open transition to SETTLE rather than guessing a fixed
                # delay. The kit window mounts, fades in, and the flex rail reflows; a
                # fixed 350ms could catch the rail mid-reflow under CI-runner load — a
                # boundary flake right at the 480 token (G6), since the orientation read
                # flips while the flex is still settling. Poll until two consecutive
                # measurements agree on orientation + rounded width, with a ceiling so a
                # genuinely missing modal still falls through to the `rail is None` report.
                _measure = """
                  (() => {
                    const overlay = document.querySelector('#settings-modal');
                    if (!overlay) return null;
                    const m = overlay.querySelector('.settings-modal-content');
                    const r = overlay.querySelector('.settings-sidebar');
                    const p = overlay.querySelector('.settings-panels');
                    if (!(m && r && p)) return null;
                    const rb = r.getBoundingClientRect(), pb = p.getBoundingClientRect();
                    return { modalW: m.getBoundingClientRect().width,
                             left: rb.x < pb.x && rb.height > rb.width };
                  })()
                """
                rail = _prev = None
                for _ in range(16):  # ~16 × 80ms = ~1.3s ceiling, early-exits once stable
                    page.wait_for_timeout(80)
                    snap = page.evaluate(_measure)
                    if (snap is not None and _prev is not None
                            and snap["left"] == _prev["left"]
                            and round(snap["modalW"]) == round(_prev["modalW"])):
                        rail = snap  # two agreeing reads — the reflow has settled
                        break
                    _prev = snap
                else:
                    rail = _prev  # never stabilized — report on the last read we got
                page.evaluate(
                    "(document.querySelector('#settings-modal .ow-close') || {click(){}}).click()")
                page.wait_for_timeout(250)  # let the close fly-away finish + the node teardown
                if rail is None:
                    report("fail", f"{vp_name} settings-rail: modal nodes missing")
                elif rail["modalW"] > 480 and not rail["left"]:
                    report("fail", f"{vp_name} settings-rail: stacked at a {rail['modalW']:.0f}px modal "
                                   "(G6 — the LEFT rail must survive above the 480 token)")
                elif rail["modalW"] <= 480 and rail["left"]:
                    report("fail", f"{vp_name} settings-rail: not stacked below the 480 token ({rail['modalW']:.0f}px)")
                else:
                    report("pass", f"{vp_name} settings-rail ({'left' if rail['left'] else 'stacked'} @ {rail['modalW']:.0f}px)")

                # settings open (the S1 surface) on a representative pair
                if vp_name in ("desktop-1366", "phone-390"):
                    page.evaluate("(document.querySelector('#settings-btn,[data-settings],[aria-label*=ettings]')||{click(){}}).click()")
                    page.wait_for_timeout(600)
                    audit_page(page, vp_name + "+settings", w, h, coarse, with_game)
                ctx.close()

            # the 200% root-font pass (one representative viewport)
            ctx = browser.new_context(viewport={"width": 1366, "height": 768})
            page = ctx.new_page()
            page.goto(FE, wait_until="domcontentloaded")
            quiesce_motion(page)  # #1822
            page.evaluate("document.documentElement.style.fontSize = '200%'")
            page.wait_for_timeout(1200)
            over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            if over > 1:
                report("fail", f"font-200% overflow:page scrolls horizontally by {over}px")
            else:
                report("pass", "font-200% page integrity")
            comp = page.query_selector("#message") or page.query_selector("#chat-form")
            if with_game and not (comp and comp.is_visible()):
                report("fail", "font-200% composer missing")
            ctx.close()
            browser.close()
    finally:
        proc.terminate()

    print(f"\n==== matrix: {len(passes)} pass · {len(xfails)} xfail (known findings) · {len(failures)} FAIL")
    for f in failures:
        print(f"  FAIL {f}")
    if xpasses:
        print("  (xpass — consider removing the XFAIL entries: " + ", ".join(xpasses) + ")")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
