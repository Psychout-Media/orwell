"""Lane G22 — the Cast window renders portraits PROGRESSIVELY (stream-feel).

Portrait generation (0051) is a server-side background job: faces land one by
one over several seconds. Two defects made the panel feel dead, both pinned
shut here:

  1. a fixed 30s poll — a finished portrait could sit unseen for up to half a
     minute, and the whole set then popped in at once on the next tick;
  2. render() wiped the grid and rebuilt EVERY card each poll — already-loaded
     <img> nodes re-mounted (flicker), with no per-face arrival.

The G22 shape (orwellCast.js only):

  * adaptive cadence — FAST_POLL_MS while the roster reports a run in flight
    (imagesAvailable with portraitsPresent < portraitsTotal), the idle POLL_MS
    once complete or providerless; ONE self-rescheduling setTimeout, cleared
    before every re-arm, still gated on the panel being open + tab visible;
  * keyed incremental render — a Map of roster id → card, upserted in place;
    an <img> src is assigned only on a real transition (never re-assigned the
    same url), vanished ids drop, and ordering MOVES live nodes (no re-mount);
  * a gentle fade-in on a just-landed face, disabled under
    prefers-reduced-motion.

Pins are CODE identifiers (the suite convention — see test_h2b's helpers),
never comment prose, so a comment edit can't trip them. Roles only (player /
NPC / houseguest) — no names.
"""

import os
import re

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


def _block(text, start, end):
    """Slice a source block between two unique markers."""
    i = text.index(start)
    j = text.index(end, i)
    return text[i:j]


def _js():
    return _read("static/js/orwellCast.js")


def _render_body():
    return _block(_js(), "function render(data) {", "async function refreshRoster")


# ── 1. adaptive poll cadence ──────────────────────────────────────────────────


def test_fast_poll_constant_exists_and_is_faster_than_idle():
    js = _js()
    fast = re.search(r"const FAST_POLL_MS\s*=\s*(\d+)", js)
    idle = re.search(r"const POLL_MS\s*=\s*(\d+)", js)
    assert fast, "FAST_POLL_MS must exist (the in-flight cadence)"
    assert idle, "POLL_MS (the idle cadence) must survive"
    assert int(fast.group(1)) < int(idle.group(1)), \
        "the generating cadence must be faster than the idle cadence"


def test_cadence_decision_reads_the_g20_roster_counters():
    body = _render_body()
    assert "portraitsTotal" in body, "the decision reads the server total"
    assert "portraitsPresent" in body, "the decision reads the server present-count"
    assert "_imagesAvailable" in body, "no provider ⇒ never the fast cadence"
    assert "total > present" in body, "in flight ⇔ total > present"
    assert re.search(r"_pollDelay\s*=.*FAST_POLL_MS.*POLL_MS", body), \
        "the next delay must pick FAST_POLL_MS while generating, else POLL_MS"


def test_poll_is_one_self_rescheduling_timeout_never_stacked():
    js = _js()
    sched = _block(js, "function scheduleNextPoll()", "function togglePanel")
    assert "clearTimeout(_timer)" in sched, "clear before re-arm — timers never stack"
    assert "_timer = setTimeout(" in sched, "a self-rescheduling timeout, not an interval"
    assert "_pollDelay" in sched, "the re-arm uses the recomputed adaptive delay"
    assert "_open && !document.hidden" in sched, \
        "the existing open + tab-visible poll guard survives"
    # The roster poll no longer rides a fixed interval; the one remaining
    # setInterval is the 20s sidebar gate poll.
    toggle = _block(js, "function togglePanel(open) {", "window._orwellCastEnsure")
    assert "setInterval" not in toggle
    assert js.count("setInterval(") == 1, \
        "only the sidebar gate keeps a fixed interval — the roster poll is adaptive"
    # The open path arms the loop only after the first refresh computed the delay.
    assert "refreshRoster().then(scheduleNextPoll)" in toggle


def test_gamechanged_hooks_rearm_the_adaptive_poll():
    js = _js()
    assert re.search(r"addEventListener\(\s*['\"]orwell:gamechanged['\"]", js), \
        "the gamechanged subscription survives"
    assert "window.orwellRefreshCast" in js, "the public refresh hook survives"
    # Both hooks chain into the scheduler so a cadence flip applies now,
    # not at the stale timer's next tick.
    hooks = js[js.index("window.orwellRefreshCast"):]
    assert hooks.count("refreshRoster().then(scheduleNextPoll)") >= 2


# ── 2. keyed incremental render (no wholesale wipe) ───────────────────────────


def test_populated_render_is_a_keyed_upsert_not_a_wholesale_wipe():
    js = _js()
    assert "new Map(" in js, "the roster-id → card registry must exist"
    body = _render_body()
    assert "cardKey(" in body, "cards are keyed by the stable roster id"
    assert "_cards.get(" in body and "_cards.set(" in body, "upsert by id"
    assert "_cards.delete(" in body, "vanished ids are dropped (defensive)"
    # The per-poll wholesale wipe is gone: the grid is never innerHTML-cleared.
    assert re.search(r"grid\.innerHTML\s*=", js) is None, \
        "no grid.innerHTML wipe anywhere — cards persist across polls"
    # The only teardown path is the explicit empty state (pre-season / reset).
    empty_branch = _block(body, "if (!roster.length)", 'empty.style.display = "none"')
    assert "_cards.clear()" in empty_branch


def test_img_src_is_assigned_only_on_a_real_transition():
    js = _js()
    upd = _block(js, "function updateCard(", "function render(data)")
    assert "url !== entry.portrait" in upd, \
        "an unchanged portrait url is never re-assigned (no refetch, no flicker)"
    sp = _block(js, "function setPortrait(", "function makeCard(")
    assert "img.src = url" in sp, "the src write lives in the one transition helper"
    assert 'img.loading = "lazy"' in sp, "lazy-loading survives"
    assert "img.onerror" in sp, "the placeholder fallback on a broken image survives"


def test_reorder_moves_live_nodes_instead_of_rebuilding():
    body = _render_body()
    # The status tiers + stable ordering survive…
    assert "order = { active: 0, jury: 1, evicted: 2 }" in body
    # …and re-ordering appends EXISTING elements (appendChild MOVES a live node —
    # no re-mount, so loaded images do not reload).
    assert "grid.appendChild(node)" in body
    assert "desired.some((node, i) => current[i] !== node)" in body, \
        "re-append only when the DOM order actually drifted"


def test_status_flip_updates_label_and_grayscale_in_place():
    js = _js()
    upd = _block(js, "function updateCard(", "function render(data)")
    assert 'classList.toggle("oc-out"' in upd, "evicted/jury dimming tracks status"
    assert "statusLabel(" in upd, "the status label tracks status"


# ── 3. the arrival fade ───────────────────────────────────────────────────────


def test_just_landed_fade_exists_and_is_reduced_motion_guarded():
    js = _js()
    assert "@keyframes ocFadeIn" in js, "the fade keyframes ship in the panel style"
    assert "oc-justin" in js, "the just-landed class exists"
    guarded = _block(js, "prefers-reduced-motion: reduce", "</style>")
    assert "oc-justin" in guarded and "animation: none" in guarded, \
        "reduced motion must disable the fade"
    # The fade marks an ARRIVAL on a live card: the upgrade path passes the landed
    # flag; a brand-new card's first paint does not animate.
    upd = _block(js, "function updateCard(", "function render(data)")
    assert "setPortrait(entry, url, !!url)" in upd
    mk = _block(js, "function makeCard(", "function updateCard(")
    assert "setPortrait(entry, hg.portrait || null, false)" in mk


# ── 4. kept behavior (cheap adjacency checks; their own suites pin the rest) ──


def test_kept_g9_lever_g20_copy_and_g11_reporting_survive():
    js = _js()
    assert "requestBackfill" in js and "oc-backfill" in js, "the G9 manual lever"
    assert "remaining…" in js, "the G20 live-remainder actions note"
    assert js.count('OrwellReport.fail("cast"') >= 2, \
        "both fetch paths still report through the G11 hook"


def test_j2_15_placeholder_is_a_per_houseguest_monogram():
    """J2-15 → M2-2: a portrait-less roster must read as distinct people, not 15 identical 👤.

    The placeholder is now the DESIGNED monogram from the shared OrwellMonogram kit
    (id-seeded gradient + pattern + initials — audit B3 retired the flat letter-rectangle);
    the legacy name-hue initial stays only as the no-kit fallback so a card never blanks.
    Vault-free either way: seeded from the public id/name only."""
    js = _js()
    sp = _block(js, "function setPortrait(", "function makeCard(")
    assert "oc-monogram" in sp, "placeholder should use the monogram class"
    assert "OrwellMonogram.svg(" in sp, "the designed template comes from the shared kit"
    # the fallback keeps the deterministic name→hue initial (kit unavailable ⇒ never blank)
    assert "nameHue(" in sp and "--oc-mono-hue" in sp
    assert ".oc-ph.oc-monogram" in js  # the holder CSS survives (sizing)
    # the hue is derived from the NAME only — never a hidden/Vault attribute
    nh = _block(js, "function nameHue(", "function cardKey(")
    assert "name" in nh and "hg." not in nh, "nameHue must read the name string, not a roster field"


def test_render_only_touches_roster_fields_the_route_returns():
    """Vault-free by construction: the card builders read exactly the public
    roster card fields (id / name / status / isPlayer / portrait) — no other
    `hg.` property is ever dereferenced, so a hidden field could not render
    even if one leaked into the payload."""
    js = _js()
    start = js.index("function cardKey(")
    end = js.index("async function refreshRoster")
    fields = set(re.findall(r"\bhg\.([A-Za-z_$][\w$]*)", js[start:end]))
    # ORW-343: `lastSeenMood` is a public roster card field too (a short mood WORD the roster route carries through only when it is a short string; never a number or a cause).
    assert fields <= {"id", "name", "status", "isPlayer", "portrait", "lastSeenMood"}, \
        f"render must only read public roster card fields, found {sorted(fields)}"
