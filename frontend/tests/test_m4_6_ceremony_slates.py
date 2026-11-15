"""M4-6 (road-to-market, idea 7) — CEREMONY SLATES.

A curated set of resolved beats (HOH win / nominations / veto win / veto ceremony / eviction
result — the week roll rides the HOH card, see orwellToolBeats.js's own comment for why) render
as a DESIGNED FULL-WIDTH card — portrait (OrwellMonogram) + name + role line — beside the
compact `.ow-slate-outcome` chip the beat already gets (M2-5). `orwellCeremonySlate` (the
descriptor builder) and `orwellRenderCeremonySlate` (the ONE shared DOM builder) both live in
orwellToolBeats.js; chat.js (live) and chatRenderer.js (reload) both call them with the SAME
tool-result JSON shape, so a re-opened transcript paints byte-identical cards to what the
player saw live (the DoD's "renders identically on reload").

Five halves, mirroring the L42 / M2-5 test conventions:
  * PAYLOAD-NOT-PROSE — the real JS `orwellCeremonySlate` is executed in Node over sample tool
    results; it derives every field from structured JSON (event.participants / status.veto /
    status.week / eviction.votesRevealed), never a regex over narration text.
  * SLATE-SET PIN — the DoR's fixed beat set maps to exactly the five kinds named.
  * LIVE == RELOAD — both render paths import the SAME two functions from orwellToolBeats.js
    (single source; neither path reimplements the descriptor or the markup locally).
  * VAULT-FREE — the ceremony-slate block never reaches for a hidden/soul/relationship field.
  * REDUCED-MOTION — the card's entrance animation is neutralized under
    `prefers-reduced-motion: reduce`.

Plus a runtime half: drive the REAL chatRenderer.addMessage reload path in headless chromium
over a fabricated multi-beat turn (the LLM-stub-blind render path — the #822/#873/#834 lesson)
and assert the actual cards it paints.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess

import pytest

from _settle import app_ready

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static", "js")


def _read(*parts):
    with open(os.path.join(FRONTEND, *parts), encoding="utf-8") as f:
        return f.read()


BEATS_JS = _read("static", "js", "orwellToolBeats.js")


# ─────────────────────────────────────────────────────────────────────────────
# PAYLOAD-NOT-PROSE — the real orwellCeremonySlate() executed in Node.
# ─────────────────────────────────────────────────────────────────────────────

def _node_slates(cases):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available for the behavioral ceremony-slate check")
    mod = os.path.join(STATIC, "orwellToolBeats.js").replace("\\", "/")
    payload = json.dumps(cases)
    script = (
        f"import {{ orwellCeremonySlate }} from 'file://{mod}';\n"
        f"const cases = {payload};\n"
        "const out = cases.map(c => orwellCeremonySlate(c[0], c[1]));\n"
        "process.stdout.write(JSON.stringify(out));\n"
    )
    proc = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, f"node failed: {proc.stderr}"
    return json.loads(proc.stdout)


def _adv(event, status_extra=None, eviction=None):
    status = {
        "beatSeq": 1, "week": 3, "phase": "x", "day": 1,
        "hoh": None, "nominees": [], "veto": {"holder": None, "used": False, "players": []},
        "pending": None, "finished": False, "winner": None,
    }
    if status_extra:
        status.update(status_extra)
    out = {"started": True, "beatSeq": 1, "event": event, "pending": None,
           "status": status, "finished": False, "winner": None}
    if eviction:
        out["eviction"] = eviction
    return json.dumps(out)


def test_hoh_win_slate_carries_the_week_roll():
    hoh_event = {"beat": "hoh-competition", "content": "Priya Anand wins Head of Household",
                 "participants": [{"id": "hg-3", "name": "Priya Anand"}]}
    out = _node_slates([["advanceGame", _adv(hoh_event, {"week": 4})]])
    s = out[0]
    assert s["kind"] == "hoh"
    assert s["week"] == 4 and s["weekRoll"] is True
    assert s["subjects"] == [{"id": "hg-3", "name": "Priya Anand"}]
    assert s["kicker"] == "Week 4 · Head of Household"
    assert s["badge"] == "hoh"


def test_nominations_slate_shows_the_two_nominees_not_the_hoh():
    nom_event = {"beat": "nominations", "content": "Priya nominates Cole and Jess",
                 "participants": [{"id": "hg-3", "name": "Priya Anand"},
                                   {"id": "hg-5", "name": "Cole"}, {"id": "hg-6", "name": "Jess"}]}
    out = _node_slates([["advanceGame", _adv(nom_event)]])
    s = out[0]
    assert s["kind"] == "nominations"
    assert [x["name"] for x in s["subjects"]] == ["Cole", "Jess"]
    assert s["kicker"] == "Nominated by Priya Anand"
    assert s["badge"] == "nominee"


def test_veto_win_slate_reads_the_structured_status_holder_not_the_field():
    # participants carries the FULL drawn field (folds consequence for all six) — the winner is
    # NOT necessarily participants[0], so the deriver must use status.veto.holder instead.
    veto_event = {"beat": "veto-competition", "content": "Jess wins the Power of Veto",
                  "participants": [{"id": "hg-3", "name": "Priya Anand"}, {"id": "hg-6", "name": "Jess"},
                                    {"id": "hg-7", "name": "Marcus"}]}
    out = _node_slates([["advanceGame", _adv(veto_event, {
        "veto": {"holder": {"id": "hg-6", "name": "Jess"}, "used": False, "players": []},
    })]])
    s = out[0]
    assert s["kind"] == "veto-win"
    assert s["subjects"] == [{"id": "hg-6", "name": "Jess"}]
    assert s["badge"] == "veto"


def test_eviction_slate_carries_the_anonymized_ballot_tally():
    ev_event = {"beat": "eviction-result", "content": "Marcus Webb leaves the house",
                "participants": [{"id": "hg-7", "name": "Marcus Webb"}]}
    eviction = {"stage": "result",
                "nominees": [{"id": "hg-7", "name": "Marcus Webb"}, {"id": "hg-9", "name": "Dana"}],
                "votesRevealed": [{"votedFor": {"id": "hg-7", "name": "Marcus Webb"}},
                                   {"votedFor": {"id": "hg-7", "name": "Marcus Webb"}},
                                   {"votedFor": {"id": "hg-9", "name": "Dana"}}]}
    out = _node_slates([["advanceGame", _adv(ev_event, eviction=eviction)]])
    s = out[0]
    assert s["kind"] == "eviction"
    assert s["subjects"] == [{"id": "hg-7", "name": "Marcus Webb"}]
    assert s["headline"] == "Marcus Webb leaves the house (2-1)"
    assert s["badge"] is None, "eviction is the L16 grayscale-only rule — never a badge"


def test_veto_ceremony_slate_has_no_badge_and_shows_up_to_three_faces():
    vc_event = {"beat": "veto-ceremony",
                "content": "Jess uses the veto on Cole; Priya names Marcus as the replacement",
                "participants": [{"id": "hg-6", "name": "Jess"}, {"id": "hg-5", "name": "Cole"},
                                   {"id": "hg-3", "name": "Priya"}, {"id": "hg-7", "name": "Marcus"}]}
    out = _node_slates([["advanceGame", _adv(vc_event)]])
    s = out[0]
    assert s["kind"] == "veto-ceremony"
    assert len(s["subjects"]) == 3, "shows up to 3 of the (variable-shape) participants"
    assert s["badge"] is None


def test_non_ceremony_tools_and_pending_blocks_never_produce_a_slate():
    out = _node_slates([
        ["recordInteraction", json.dumps({"ok": True})],
        ["gameStatus", ""],
        ["advanceGame", "not json"],
        ["advanceGame", json.dumps({"pending": {"kind": "nominations"}})],  # blocked, no event
        ["advanceGame", _adv({"beat": "comp-elimination", "content": "x is dropped",
                               "participants": [{"id": "hg-1", "name": "x"}]})],  # not slate-worthy
    ])
    assert out == [None, None, None, None, None]


def test_no_regex_extraction_over_narration_text():
    """ADR 0005 (never parsed from prose): the deriver reads structured JSON fields only — it
    must contain no regex/pattern-match machinery at all (that would be the tell of a fallback
    that scrapes a name out of narration/content text instead of a structured field)."""
    start = BEATS_JS.index("export function orwellCeremonySlate")
    end = BEATS_JS.index("export function orwellRenderCeremonySlate")
    body = BEATS_JS[start:end]
    for token in (".match(", ".exec(", "RegExp(", "new RegExp"):
        assert token not in body, f"orwellCeremonySlate must never regex-extract from prose ({token!r} found)"
    # it reads ev.content ONCE, as an opaque string appended verbatim (same L42-sanctioned
    # pattern orwellBeatOutcome already uses) — never split/searched for a name.
    assert "String(ev.content)" in body
    assert ".split(" not in body and ".search(" not in body


# ─────────────────────────────────────────────────────────────────────────────
# SLATE-SET PIN — the DoR's fixed beat set, exactly.
# ─────────────────────────────────────────────────────────────────────────────

def test_slate_set_matches_the_dor_exactly():
    assert "export const CEREMONY_SLATE_KIND" in BEATS_JS
    start = BEATS_JS.index("export const CEREMONY_SLATE_KIND")
    end = BEATS_JS.index("};", start)
    block = BEATS_JS[start:end]
    expected = {
        "'hoh-competition'": "'hoh'",
        "'nominations'": "'nominations'",
        "'veto-competition'": "'veto-win'",
        "'veto-ceremony'": "'veto-ceremony'",
        "'eviction-result'": "'eviction'",
        "'eviction'": "'eviction'",
    }
    for beat_key, kind_val in expected.items():
        assert f"{beat_key}: {kind_val}" in block, f"missing/changed slate mapping for {beat_key}"


# ─────────────────────────────────────────────────────────────────────────────
# LIVE == RELOAD — one shared descriptor builder + one shared DOM builder.
# ─────────────────────────────────────────────────────────────────────────────

def test_both_render_paths_import_the_same_shared_functions():
    chat = _read("static", "js", "chat.js")
    renderer = _read("static", "js", "chatRenderer.js")
    for js, label in ((chat, "chat.js"), (renderer, "chatRenderer.js")):
        imp = re.search(
            r"import\s*\{[^}]*\borwellCeremonySlate\b[^}]*\borwellRenderCeremonySlate\b[^}]*\}"
            r"\s*from\s*'\./orwellToolBeats\.js'",
            js,
        )
        assert imp, f"{label} must import both ceremony-slate helpers from the single registry"


def test_live_path_calls_the_shared_builders_on_the_tool_result():
    chat = _read("static", "js", "chat.js")
    assert "orwellCeremonySlate(json.tool, json.output)" in chat
    assert "orwellRenderCeremonySlate(_slate)" in chat
    # gated to the game build + a successful result (never the workspace build / a failed call)
    assert "if (ok && isGameBuild()) {" in chat


def test_live_multi_beat_turn_preserves_slate_order():
    """Two+ ceremony beats in one .agent-thread must keep EVENT order live: the insertion walks
    its anchor past .ow-cslate siblings already appended for that thread. Always inserting
    'afterend' of the thread itself REVERSED them — diverging from the reload path's sequential
    anchoring and breaking .ow-cslate mirror parity (Greptile P1, PR #1243)."""
    chat = _read("static", "js", "chat.js")
    blk = chat[chat.index("orwellCeremonySlate(json.tool"):]
    blk = blk[: blk.index("insertAdjacentElement")]
    assert "nextElementSibling" in blk and "ow-cslate" in blk, \
        "live slate insertion must anchor past prior slates in the same thread (order-preserving)"


def test_reload_merged_rounds_preserve_slate_order():
    """The reload twin: consecutive rounds merging into the same reused threadWrap must not reset
    the slate anchor to threadWrap (that inserted a later round's slates BEFORE a prior round's).
    The anchor walks past .ow-cslate siblings first — mirroring the live path (review P1)."""
    renderer = _read("static", "js", "chatRenderer.js")
    blk = renderer[renderer.index("let _slateAnchor = threadWrap"):]
    blk = blk[: blk.index("for (const _slate of _pendingSlates)")]
    assert "nextElementSibling" in blk and "ow-cslate" in blk, \
        "reload slate insertion must walk the anchor past prior rounds' slates (order-preserving)"


def test_reload_path_calls_the_shared_builders_on_the_persisted_event():
    renderer = _read("static", "js", "chatRenderer.js")
    assert "orwellCeremonySlate(ev.tool, ev.output)" in renderer
    assert "orwellRenderCeremonySlate(_slate)" in renderer
    assert "if (ok && _gbBeat) {" in renderer


def test_neither_render_path_reimplements_the_descriptor_locally():
    """Drift guard: a divergence would look like a SECOND definition of the slate-kind map or
    role/badge tables inside chat.js/chatRenderer.js instead of importing them."""
    for rel in ("static/js/chat.js", "static/js/chatRenderer.js"):
        js = _read(rel)
        assert "CEREMONY_SLATE_KIND" not in js, f"{rel} must not redefine the slate-kind map"
        assert "function orwellCeremonySlate" not in js
        assert "function orwellRenderCeremonySlate" not in js


# ─────────────────────────────────────────────────────────────────────────────
# VAULT-FREE — the ceremony-slate block never reaches for hidden state.
# ─────────────────────────────────────────────────────────────────────────────

def test_ceremony_slate_block_is_vault_free_by_construction():
    start = BEATS_JS.index("// ── M4-6 — CEREMONY SLATES")
    end = BEATS_JS.index("export function orwellRenderCeremonySlate") + len("export function orwellRenderCeremonySlate")
    # walk to the end of that function body too
    tail_start = BEATS_JS.index("export function orwellRenderCeremonySlate")
    depth = 0
    i = BEATS_JS.index("{", tail_start)
    j = i
    while True:
        if BEATS_JS[j] == "{":
            depth += 1
        elif BEATS_JS[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    block = BEATS_JS[start:j + 1]
    # Same banned set as the L42 precedent (test_l42_beat_outcome.py) — deliberately excludes
    # "vault" itself, since the explanatory comments here legitimately say "Vault-free" (the
    # codebase-wide convention for documenting the absence of a leak, CLAUDE.md included).
    for banned in ["lean", "secret", "soul", "trust", "affinity", "threat", "script", "hidden"]:
        # word-boundary match — a plain substring check false-positives on e.g. "Boolean"
        # containing "lean", which the M2-5/L42 sibling tests don't happen to hit but this
        # block's DOM-builder prose (filter(Boolean)) does.
        assert not re.search(rf"\b{re.escape(banned)}\b", block), \
            f"M4-6 ceremony-slate block must not read a hidden field ({banned!r})"


# ─────────────────────────────────────────────────────────────────────────────
# REDUCED-MOTION
# ─────────────────────────────────────────────────────────────────────────────

def _css_rule(selector_literal, text):
    idx = text.find(selector_literal)
    assert idx != -1, f"no CSS rule found for {selector_literal!r}"
    open_brace = text.find("{", idx)
    depth = 1
    i = open_brace + 1
    while depth and i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
        i += 1
    return text[idx:i]


def test_slate_entrance_is_animated_and_reduced_motion_strips_it():
    css = _read("static", "css", "game-trim.css")
    assert ".ow-cslate {" in css
    assert "@keyframes ow-cslate-in" in css
    rule = _css_rule("body[data-game-build] .ow-cslate {\n  animation:", css)
    assert "ow-cslate-in" in rule
    # a prefers-reduced-motion block forces animation: none on the same selector
    rm_idx = css.find("@media (prefers-reduced-motion: reduce)")
    found = False
    while rm_idx != -1:
        block_start = css.find("{", rm_idx)
        depth = 1
        i = block_start + 1
        while depth and i < len(css):
            if css[i] == "{":
                depth += 1
            elif css[i] == "}":
                depth -= 1
            i += 1
        block = css[block_start:i]
        if ".ow-cslate" in block and "animation: none" in block:
            found = True
            break
        rm_idx = css.find("@media (prefers-reduced-motion: reduce)", rm_idx + 1)
    assert found, "prefers-reduced-motion must force `animation: none` on .ow-cslate"


def test_slate_styling_is_game_build_scoped():
    css = _read("static", "css", "game-trim.css")
    for sel in (".ow-cslate {", ".ow-cslate-faces {", ".ow-cslate-face-holder {",
                ".ow-cslate-kicker {", ".ow-cslate-names {", ".ow-cslate-line {"):
        assert f"body[data-game-build] {sel}" in css, f"{sel} must be scoped to the game build"


def test_eviction_kind_keeps_the_l16_grayscale_rule():
    """The shared DOM builder must pass status:'evicted' to OrwellMonogram ONLY for the
    eviction kind — the same monochrome-only rule the cast roster/rail chips already use."""
    start = BEATS_JS.index("export function orwellRenderCeremonySlate")
    body = BEATS_JS[start:start + 1500]
    assert "slate.kind === 'eviction'" in body
    assert "evicted ? 'evicted' : 'active'" in body


# ─────────────────────────────────────────────────────────────────────────────
# Regression pin for issue #1324 — ceremony-slate faces were PERMANENTLY starved of real
# portraits: the DOM builder never passed `portrait` to OrwellMonogram.face() at all (deliberate
# at the time — "ID-SEEDED mode… so live vs. reload can never visually diverge"), so a slate
# rendered the monogram forever even once a generated portrait existed. The fix resolves the
# portrait SYNCHRONOUSLY from OrwellMonogram's shared cache at render time — both render paths
# still read whatever snapshot of the SAME cache is loaded in memory when they paint, so
# determinism is preserved without starving the surface.
# ─────────────────────────────────────────────────────────────────────────────

def test_slate_faces_resolve_a_real_portrait_from_the_shared_cache():
    start = BEATS_JS.index("export function orwellRenderCeremonySlate")
    end = BEATS_JS.index("\n}\n", start)
    body = BEATS_JS[start:end]
    assert "window.OrwellMonogram.portraitFor" in body, \
        "slate faces must consult the shared portrait cache, not render monogram-only forever"
    # the resolved portrait rides INTO face()'s own card — never a hardcoded null.
    assert re.search(r"portrait:\s*cached\s*&&\s*cached\.portrait", body)


def test_slate_faces_never_fetch_directly():
    """The DOM builder stays synchronous — it reads the ALREADY-warm shared cache
    (orwellMonogram.js owns the one out-of-band fetch), never fetches inline itself, so a
    slate's paint never blocks on / races a network round-trip."""
    start = BEATS_JS.index("export function orwellRenderCeremonySlate")
    end = BEATS_JS.index("\n}\n", start)
    body = BEATS_JS[start:end]
    assert "fetch(" not in body


def test_live_and_reload_read_the_same_cache_snapshot_by_construction():
    """LIVE == RELOAD for faces too: both paths call the ONE shared orwellRenderCeremonySlate
    (already proven above), and that function's only portrait source is
    `window.OrwellMonogram.portraitFor` — there is no second, path-specific portrait lookup for
    either render path to diverge through."""
    for js, label in ((_read("static", "js", "chat.js"), "chat.js"),
                       (_read("static", "js", "chatRenderer.js"), "chatRenderer.js")):
        assert "portraitFor" not in js, \
            f"{label} must not read the portrait cache itself — only orwellRenderCeremonySlate does"


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL chatRenderer.addMessage reload path in headless chromium
# (the LLM-stub-blind render path — the #822/#873/#834 lesson).
# ─────────────────────────────────────────────────────────────────────────────

import sys
import time
import urllib.request


from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-m46-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-m46-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError("server never became ready")


_EVICTION_METADATA = {
    "timestamp": "2026-07-08T21:40:00.000Z",
    "round_texts": ["The house holds its breath for the final vote reveal."],
    "tool_events": [{
        "round": 1, "tool": "advanceGame", "command": "advanceGame", "exit_code": 0,
        "output": json.dumps({
            "started": True, "beatSeq": 39,
            "event": {"beat": "eviction-result", "content": "Marcus Webb leaves the house",
                      "participants": [{"id": "hg-7", "name": "Marcus Webb"}]},
            "pending": None,
            "status": {"beatSeq": 39, "week": 2, "phase": "hoh-competition", "day": 1,
                       "hoh": None, "nominees": [], "veto": {"holder": None, "used": False, "players": []},
                       "pending": None, "finished": False, "winner": None},
            "finished": False, "winner": None,
            "eviction": {"stage": "result",
                         "nominees": [{"id": "hg-7", "name": "Marcus Webb"}, {"id": "hg-9", "name": "Dana Ruiz"}],
                         "votesRevealed": [{"votedFor": {"id": "hg-7", "name": "Marcus Webb"}},
                                            {"votedFor": {"id": "hg-7", "name": "Marcus Webb"}},
                                            {"votedFor": {"id": "hg-9", "name": "Dana Ruiz"}}]},
        }),
    }],
}

_HARNESS = r"""
(meta) => {
  const chat = window.chatModule;
  if (!chat || !chat.addMessage) return { error: 'chatModule.addMessage missing' };
  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };
  box.innerHTML = '';
  chat.addMessage('assistant', '', 'test-model', meta);
  const card = box.querySelector('.ow-cslate');
  if (!card) return { error: 'no .ow-cslate card rendered' };
  return {
    kind: card.getAttribute('data-ow-cslate'),
    names: (card.querySelector('.ow-cslate-names') || {}).textContent,
    kicker: (card.querySelector('.ow-cslate-kicker') || {}).textContent,
    line: (card.querySelector('.ow-cslate-line') || {}).textContent,
    hasFace: !!card.querySelector('.ow-mono-svg, img'),
    grayscale: !!card.querySelector('.ow-mono-evicted'),
    hasBadge: !!card.querySelector('.ow-mono-badge'),
    isAfterThread: card.previousElementSibling ? card.previousElementSibling.classList.contains('agent-thread') : false,
  };
}
"""


def test_reload_path_renders_a_real_eviction_slate_card():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")

    env = dict(os.environ)
    env.setdefault("AUTH_ENABLED", "false")
    env.setdefault("ORWELL_GAME_BUILD", "1")
    port = _free_port()
    proc = None
    try:
        proc, base = _boot(env, port)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as e:
                pytest.skip(f"chromium unavailable: {e}")
            page = browser.new_page()
            page.goto(base + "/", wait_until="load", timeout=30000)
            app_ready(page)
            result = page.evaluate(_HARNESS, _EVICTION_METADATA)
            browser.close()
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()

    assert not result.get("error"), result.get("error")
    assert result["kind"] == "eviction"
    assert "Marcus Webb" in result["names"]
    assert result["kicker"] == "Evicted"
    assert "(2-1)" in result["line"], "the anonymized ballot tally rides the headline"
    assert result["hasFace"], "the card must render an OrwellMonogram/portrait face"
    assert result["grayscale"], "an evicted subject renders the L16 grayscale rule"
    assert not result["hasBadge"], "eviction never gets a role badge (L16: grayscale only)"
    assert result["isAfterThread"], "the card sits right after the beat's compact thread chip"
