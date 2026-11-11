"""M2-5 (audit B4/B7) — narrator identity + production-slate beat styling.

Owner pick (2026-07-08): the transcript author is the show's **production voice** — never the
model name. "Orwell" stays product chrome (wordmark, tab, admin).

#1626 increment 2 RELAXED the original "Production is phase-invariant" rule to
**producer-name-invariance**: the byline DEFAULTS to "Production" (`GAME_NARRATOR`, the single
registry constant + the parked P-1 rebrand's one line) and, once the engine resolves the season's
seeded Vault-free producer name, the byline reflects THAT producer — dynamic, but STABLE PER SEASON
(the same producer every phase/turn, not per-phase). Every game-build author site reads the dynamic
`gameNarrator()` getter (window.ORWELL_GAME_NARRATOR, fail-open to "Production"), the stream hands the
name to the client via the `orwell_narrator` event, and the monogram seeds off the same name.

Beats still render as production slates in the game build: no lowercase "done" debug tail (failures
stay literal — operator truth), slate type on the label, one aligned rail.
"""
from __future__ import annotations

import os
import re

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel: str) -> str:
    with open(os.path.join(FE, rel), encoding="utf-8") as fh:
        return fh.read()


def test_the_default_narrator_is_one_constant_in_the_registry():
    """The DEFAULT byline is still one registry constant (the pre-resolution value + the P-1
    rebrand's one line), and it seeds the window global that the dynamic getter reads."""
    beats = _read("static/js/orwellToolBeats.js")
    assert "export const GAME_NARRATOR = 'Production';" in beats
    assert "window.ORWELL_GAME_NARRATOR = GAME_NARRATOR" in beats


def test_the_byline_is_the_dynamic_producer_name_defaulting_to_production():
    """#1626: the byline is the season's producer name (dynamic), STABLE PER SEASON, defaulting to
    'Production' when unresolved. The registry exposes a getter/setter over window.ORWELL_GAME_NARRATOR,
    both fail-open to the "Production" default."""
    beats = _read("static/js/orwellToolBeats.js")
    # a getter reads the resolved window value, else the GAME_NARRATOR default
    assert "export function gameNarrator()" in beats
    assert "window.ORWELL_GAME_NARRATOR" in beats and "GAME_NARRATOR" in beats  # falls back to default
    # a setter resolves the producer name onto the window global (fail-open to the default)
    assert "export function setGameNarrator(name)" in beats


def test_no_game_build_author_site_hardcodes_a_name():
    """Every game-build sender label reads the DYNAMIC getter (not a frozen const, not a literal) —
    so the byline tracks the season's producer and a rebrand still needs no per-site hunt."""
    for rel in ("static/js/chat.js", "static/js/chatRenderer.js"):
        js = _read(rel)
        assert not re.search(r"isGameBuild\(\) \? ['\"]Orwell['\"]", js), \
            f"{rel}: a game-build author site still hardcodes 'Orwell'"
        assert "gameNarrator()" in js, f"{rel}: a game-build author site must read the dynamic byline"
        # the frozen const must NOT be the byline at an author site (it is only the registry default)
        assert "isGameBuild() ? GAME_NARRATOR" not in js, \
            f"{rel}: byline still pinned to the frozen const instead of gameNarrator()"


def test_the_producer_name_is_plumbed_from_engine_to_client():
    """The producer byline reaches the client end to end: the engine's Vault-free `producerName`
    (moment prompt) is stashed FE-side, then emitted on the chat stream as an `orwell_narrator`
    event the client consumes to set the byline. Fail-open at every hop."""
    helpers = _read("routes/chat_helpers.py")
    # stashed from the moment prompt (both live-game and casting framing), exposed via a getter
    assert "producerName" in helpers
    assert "def last_framed_producer_name(" in helpers
    loop = _read("src/agent_loop.py")
    # emitted on the stream (game/casting turns only), read from the stash
    assert "last_framed_producer_name" in loop
    assert '"type": "orwell_narrator"' in loop
    # the client sets its byline from that event (main + mirror parsers) and persists it season-scoped
    chat = _read("static/js/chat.js")
    assert chat.count("json.type === 'orwell_narrator'") >= 2   # main + mirror/resume parsers
    assert "setGameNarrator(json.name)" in chat
    assert "orwell.gameNarrator" in chat  # sessionStorage key — reload keeps it for the same season


def test_the_producer_byline_is_cleared_at_the_reset_boundary_but_survives_casting_hiccups(monkeypatch):
    """BEHAVIORAL (CodeRabbit Major / Greptile P1): the cached producer is cleared ONLY at the true
    season-reset boundary (an ACTIVE season transitioning to not-started), NOT on every steady-state
    casting turn. So (1) at the boundary the prior season's producer is removed (a new season starts
    from "Production"), but (2) a later casting turn whose get_moment_prompt hiccups PRESERVES the
    already-stashed producer instead of wiping resumed/new clients back to "Production" (Greptile P1)."""
    import asyncio
    import importlib
    orwell_engine = importlib.import_module("src.orwell_engine")
    ch = importlib.import_module("routes.chat_helpers")

    def _run(coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)  # game build defaults ON

    async def not_started(user=None):
        return {"started": False, "moment": "character-creation"}

    async def mp_no_producer(moment=None, user=None, **_kw):
        return {"systemPrompt": "CASTING"}  # a new season's interview — no producer resolved yet

    monkeypatch.setattr(orwell_engine, "get_game_state", not_started)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", mp_no_producer)

    try:
        # (1) BOUNDARY: the season WAS active, now it's not-started ⇒ the prior producer is cleared.
        ch._GAME_WAS_ACTIVE.clear()
        ch._GAME_WAS_ACTIVE.add("p")
        ch._LAST_FRAMED_PRODUCER_NAME["p"] = "Prev Producer"
        _run(ch.apply_game_framing([{"role": "system", "content": "base"}], "p"))
        assert "p" not in ch._LAST_FRAMED_PRODUCER_NAME
        assert ch.last_framed_producer_name("p") is None

        # (2) STEADY CASTING HICCUP (Greptile P1): a later casting turn (NOT the active→inactive edge)
        # whose get_moment_prompt THROWS must PRESERVE the already-stashed producer, not wipe it.
        async def mp_boom(moment=None, user=None, **_kw):
            raise RuntimeError("transient engine hiccup")

        monkeypatch.setattr(orwell_engine, "get_moment_prompt", mp_boom)
        ch._GAME_WAS_ACTIVE.clear()  # steady-state casting: never active this turn
        ch._LAST_FRAMED_PRODUCER_NAME["p"] = "Stable Producer"
        _run(ch.apply_game_framing([{"role": "system", "content": "base"}], "p"))
        assert ch.last_framed_producer_name("p") == "Stable Producer"

        # (3) at the boundary, a new season that DOES resolve a producer yields the NEW one.
        async def mp_new_producer(moment=None, user=None, **_kw):
            return {"systemPrompt": "CASTING", "producerName": "New Producer"}

        monkeypatch.setattr(orwell_engine, "get_moment_prompt", mp_new_producer)
        ch._GAME_WAS_ACTIVE.clear()
        ch._GAME_WAS_ACTIVE.add("p")
        ch._LAST_FRAMED_PRODUCER_NAME["p"] = "Prev Producer"
        _run(ch.apply_game_framing([{"role": "system", "content": "base"}], "p"))
        assert ch.last_framed_producer_name("p") == "New Producer"
    finally:
        ch._LAST_FRAMED_PRODUCER_NAME.pop("p", None)
        ch._GAME_WAS_ACTIVE.clear()


def test_stash_producer_name_is_fail_open_but_not_silent():
    """`_stash_producer_name` must be fail-open (a non-mapping/blank prompt never raises and never
    clobbers a good name) WITHOUT a silent `except Exception: pass` (owner ruling #1599 / Ruff
    S110/BLE001) — it narrows and logs at debug."""
    from routes import chat_helpers as ch
    # the source must not carry a blind swallow; it narrows + logs instead
    src = _read("routes/chat_helpers.py")
    fn = src[src.index("def _stash_producer_name("):src.index("def last_framed_producer_name(")]
    assert "except Exception:\n        pass" not in fn, "no silent fail-soft (owner ruling #1599)"
    assert "logger.debug(" in fn, "the skipped path must log the reason"
    # behavior: strips, is fail-open on a non-mapping/blank prompt, and never clobbers a good name
    key = "__m2_5_test_user__"
    ch._LAST_FRAMED_PRODUCER_NAME.pop(key, None)
    try:
        ch._stash_producer_name(key, {"producerName": "  The Producer  "})
        assert ch.last_framed_producer_name(key) == "The Producer"   # stripped
        ch._stash_producer_name(key, None)                            # non-mapping ⇒ no raise, no clobber
        ch._stash_producer_name(key, ["not", "a", "dict"])            # non-mapping ⇒ no raise, no clobber
        ch._stash_producer_name(key, {"producerName": "   "})         # blank ⇒ keep the prior value
        ch._stash_producer_name(key, {})                             # missing ⇒ keep the prior value
        assert ch.last_framed_producer_name(key) == "The Producer"
    finally:
        ch._LAST_FRAMED_PRODUCER_NAME.pop(key, None)


def test_client_refreshes_the_already_mounted_live_byline():
    """#1626 review item 3: both stream handlers create the assistant holder BEFORE reading the SSE,
    so the live bubble must be re-labeled when the producer resolves mid-stream (not only at
    finalize/reload). The refresh routes through the canonical role-label path, preserving an
    explicit character label."""
    chat = _read("static/js/chat.js")
    assert "function _refreshLiveByline(" in chat
    # it re-applies via the canonical labeler, carrying the holder's explicit character label through
    assert "_setRoleModelLabel(roleEl, liveHolder._requestedModel, liveHolder._actualModel" in chat
    assert "characterName: liveHolder._characterName" in chat
    # both the primary and the mirror/resume handlers refresh the live holder
    assert chat.count("_refreshLiveByline(holder)") >= 2


def _orwell_narrator_handler_slices(chat):
    """Return (primary, resume) source slices of the two `orwell_narrator` SSE handlers."""
    i1 = chat.index("json.type === 'orwell_narrator'")
    i2 = chat.index("json.type === 'orwell_narrator'", i1 + 1)
    primary = chat[i1:chat.index("} else if", i1)]
    resume = chat[i2:chat.index("} else if", i2)]
    return primary, resume


def test_client_persisted_byline_is_a_per_session_map():
    """#1626 review item 2 (+ Greptile P1 timing): the persisted narrator is a PER-SESSION map
    ({[sid]: name}), not one tab-wide record, so visiting session B never overwrites A. The restore is
    keyed by the NOW-ACTIVE session; because the module-eval read runs before currentSessionId is set,
    the authoritative restore is a hook selectSession invokes once the active sid is known."""
    chat = _read("static/js/chat.js")
    # a per-session map, not a single {sid,name} record
    assert "function _readNarratorMap(" in chat
    assert "m[sid] = String(name)" in chat
    assert "_persistNarratorForSession(streamSessionId, json.name)" in chat  # primary
    assert "_persistNarratorForSession(sessionId, json.name)" in chat        # mirror/resume
    # the reapply hook restores by the active sid (or defaults) and is exposed for selectSession
    assert "function orwellReapplyNarrator(" in chat
    assert "_readNarratorMap()[sid]" in chat
    assert "orwellReapplyNarrator," in chat  # on the chatModule public API
    # selectSession invokes the hook once the active sid is known (the Greptile timing fix)
    sessions = _read("static/js/sessions.js")
    assert "orwellReapplyNarrator(id)" in sessions


def test_client_active_session_guard_on_the_byline():
    """#1626 review item 1 (Major): a BACKGROUND stream must persist its producer but must NOT hijack
    the byline of the session the user is viewing. Both handlers persist unconditionally, then gate
    setGameNarrator + the live refresh on the stream being the ACTIVE session."""
    chat = _read("static/js/chat.js")
    primary, resume = _orwell_narrator_handler_slices(chat)
    # primary: persist FIRST (always), then the byline only when this stream is not background
    assert "_persistNarratorForSession(streamSessionId, json.name)" in primary
    assert "if (!_isBg) {" in primary
    assert primary.index("_persistNarratorForSession") < primary.index("if (!_isBg)")
    assert primary.index("if (!_isBg)") < primary.index("setGameNarrator")
    # resume: persist FIRST (always), then the byline only when the resumed session is active
    assert "_persistNarratorForSession(sessionId, json.name)" in resume
    assert "getCurrentSessionId() !== sessionId" in resume and "if (_activeNow) {" in resume
    assert resume.index("_persistNarratorForSession") < resume.index("if (_activeNow)")
    assert resume.index("if (_activeNow)") < resume.index("setGameNarrator")


def test_client_char_label_initialized_at_holder_creation():
    """#1626 review item 3: holder._characterName must be seeded at holder creation (both the primary
    and resume paths) from the same source model_info reads, so an orwell_narrator refresh arriving
    BEFORE model_info preserves a preset NPC label instead of clobbering it with the producer name."""
    chat = _read("static/js/chat.js")
    # primary: seeded from _charNameInit (the preset source model_info also falls back to)
    assert "holder._characterName = _charNameInit;" in chat
    # resume: seeded from the same presets source at creation
    assert "holder._characterName = presetsModule.getCharacterName ? presetsModule.getCharacterName() : '';" in chat


def test_product_chrome_keeps_orwell():
    """The rename is scoped to the FICTION: slash/compacted meta-bubbles (product voice)
    keep 'Orwell' — the product name is not erased, just kept out of the narration."""
    renderer = _read("static/js/chatRenderer.js")
    assert "(isSlash || isCompacted) ? 'Orwell'" in renderer


def test_game_build_slates_drop_the_done_tail():
    chat = _read("static/js/chat.js")
    assert "(ok && isGameBuild()) ? ''" in chat, "success slates must carry no debug tail"
    assert "'failed'" in chat, "failures stay literal (operator truth)"
    # PR #1235 review: the RELOAD path mirrors the live suppression + the outcome marker
    renderer = _read("static/js/chatRenderer.js")
    assert "(ok && isGameBuild()) ? ''" in renderer, "reload must mirror the live done-tail rule"
    assert "ow-slate-outcome" in renderer


def test_slate_styling_is_game_build_scoped():
    css = _read("static/css/game-trim.css")
    assert "body[data-game-build] .agent-thread-node" in css
    assert "body[data-game-build] .agent-thread-tool" in css
    # outcome slates keep richer type via the PERSISTENT marker (the reveal class is
    # transient — cleared after the entrance animation)
    assert "ow-slate-outcome" in css
    chat = _read("static/js/chat.js")
    assert "ow-ceremony-reveal ow-slate-outcome" in chat
