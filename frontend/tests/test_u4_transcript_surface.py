"""U4 chunk 1 — transcript surface: E65 (gamechanged dispatcher + fresh session),
E93 (the played record is not editable), D3/E66 (pending survives reload)."""
import importlib
import re
from pathlib import Path

FE = Path(__file__).resolve().parents[1]
JS = FE / "static" / "js"
CHAT = (JS / "chat.js").read_text(encoding="utf-8")
RENDERER = (JS / "chatRenderer.js").read_text(encoding="utf-8")
DECISION = (JS / "orwellDecision.js").read_text(encoding="utf-8")
ONBOARD = (JS / "orwellOnboarding.js").read_text(encoding="utf-8")
STATUSP = (JS / "orwellStatusPanel.js").read_text(encoding="utf-8")
ROUTES = (FE / "routes" / "orwell_routes.py").read_text(encoding="utf-8")
TOOLS = (FE / "src" / "tool_implementations.py").read_text(encoding="utf-8")


# ── E65: the event finally has a dispatcher ───────────────────────────────────

def test_e65_gamechanged_is_dispatched_from_the_tool_stream():
    # G15: chat.js no longer hand-rolls the dispatch (the E65 inline one was nested
    # under the advanceGame/submitDecision branch and could never fire) — the
    # tool-result seam now routes every game-mutating tool, lifecycle ones
    # included, through THE one debounced dispatcher in platform.js. The full
    # dispatcher contract is pinned in test_g15_gamechanged.py.
    assert "window.orwellGameChanged" in CHAT
    # #1412 (R1b): the seam no longer hard-codes tool-name literals (the old
    # `[…'createCharacter'…'manageSandbox'…].includes(json.tool)` array is gone) — it consumes the
    # shared manifest lookup. Pin the manifest-driven dispatch (the tool set lives in platform.js
    # ORWELL_MUTATING_TOOLS, pinned registry-equal by test_1412_mutating_manifest.py).
    assert "window.orwellIsMutatingTool(json.tool)" in CHAT


def test_e65_restart_opens_a_fresh_session():
    assert "_orwellFreshSession" in ONBOARD, "the fresh-session seam lives with takeASeat"
    assert "_orwellFreshSession" in CHAT, "createCharacter success must invoke it"
    assert "sessionStorage.removeItem(SEAT_TAKEN_KEY)" in ONBOARD


# ── E93: the played record ────────────────────────────────────────────────────

def test_e93_game_transcript_keeps_only_record_safe_actions():
    # Owner ruling: in the game build the transcript is the PLAYED RECORD, not a chat
    # scratchpad. GM/narration messages keep Copy + Re-narrate (regen, relabeled) + the
    # separate Speak/TTS button; the record-altering + chatbot-utility actions (edit,
    # rewrite-shorter, explain-simpler, fork, delete) are dropped.
    assert "_GAME_KEEP = new Set(['copy', 'regen'])" in RENDERER
    assert "'Re-narrate'" in RENDERER
    assert "data-game-build" in RENDERER
    # Owner ruling (liquid-glass follow-up): SENT (player) messages carry NO per-message
    # action icons in the game build — under the glass theme the lone gray "Copy" glyph was
    # illegible on the blue fill, and the played-record model already strips the
    # record-altering actions, so the sent footer uses an EMPTY action pool.
    assert re.search(
        r"const userPool\s*=\s*document\.body\.hasAttribute\(['\"]data-game-build['\"]\)\s*\?\s*\[\s*\]",
        RENDERER,
    ), "sent-bubble footer must use an EMPTY action pool in the game build (no icons)"


def test_e93_game_active_flag_is_maintained_by_the_status_poll():
    assert 'dataset.gameActive = "1"' in STATUSP
    assert 'dataset.gameActive = ""' in STATUSP


# ── D3/E66: pending survives a reload ─────────────────────────────────────────

def test_d3_pending_cache_round_trips():
    oe = importlib.import_module("src.orwell_engine")
    oe.remember_pending({"pending": {"kind": "nominations", "options": []}}, user="t")
    assert oe.last_pending(user="t")["kind"] == "nominations"
    oe.remember_pending({"pending": None}, user="t")  # bound ⇒ cleared
    assert oe.last_pending(user="t") is None


def test_d3_every_advanceview_chokepoint_feeds_the_cache():
    # Five chokepoints now: do_advance_game + do_submit_decision RECORD the pending, do_create_character
    # CLEARS it (a casting card carries no `pending`) — the restart-door hygiene that stops a finished
    # season's decision card bleeding into season 2 — do_request_self_eviction (0061) records the raised
    # self-evict confirmation so the confirm card survives a reload too, and do_turn_in (ADR 0006 / #1385,
    # the bedtime lever) returns an AdvanceView, so it feeds the cache on the same contract.
    assert TOOLS.count("orwell_engine.remember_pending(res") == 5, \
        "advance + submit + self-evict request + turnIn record the pending; createCharacter clears it on a new season"
    assert "orwell_engine.remember_pending(res" in ROUTES, "the decision route + new-game route too"


def test_restart_door_clears_the_stale_decision_card(monkeypatch):
    # Play-through bug (2026-06-18, live finale → next season): the FE caches the last pending so
    # the decision card survives a reload (D3/E66). But createCharacter — the restart door — never
    # cleared it, so a finished season's card (e.g. a juror-vote, under the OLD player's name)
    # stayed armed on /api/orwell/status through the whole of season 2's premiere. createCharacter
    # must wipe the cache for the user.
    import asyncio
    oe = importlib.import_module("src.orwell_engine")
    ti = importlib.import_module("src.tool_implementations")

    # Season 1 left a phantom card armed for this user.
    oe.remember_pending({"pending": {"kind": "juror-vote", "options": [{"id": "npc:5"}]}}, user="u")
    assert oe.last_pending(user="u") is not None

    async def fake_create(*a, **k):
        return {"playerName": "P", "characterType": "x", "portraitPrompts": []}  # a casting card, no `pending`
    monkeypatch.setattr(oe, "create_character", fake_create)

    res = asyncio.get_event_loop().run_until_complete(
        ti.do_create_character('{"playerName": "P"}', owner="u"))
    assert res["exit_code"] == 0
    assert oe.last_pending(user="u") is None, "the restart door must clear the prior season's card"


def test_d3_status_route_serves_the_cached_pending():
    # The pending rides the status response so the decision card re-arms after a reload.
    # R9-FE-1: the engine's own `pending` (on gameStatus, persisted 0030) is AUTHORITATIVE —
    # a present value, INCLUDING null, is trusted as-is; the FE cache is consulted ONLY when the
    # engine OMITS the key (an older engine). The old `or` re-surfaced a stale card on present-null.
    assert 'if isinstance(st, dict) and "pending" not in st:' in ROUTES
    assert 'st["pending"] = orwell_engine.last_pending' in ROUTES
    # The poll must never advance the game (ADR 0003) — the route reads, only. Scope the check to
    # the orwell_status FUNCTION BODY (up to the next `@router`/`def`), so a sanctioned advance in a
    # DIFFERENT route (F14: the goodbye follow-up in orwell_decision) is never a false positive.
    _m = re.search(r'def orwell_status\b', ROUTES)
    assert _m is not None
    _rest = ROUTES[_m.end():]
    _nxt = re.search(r'\n    @router\.|\n    async def |\n    def ', _rest)
    _status_body = _rest[: _nxt.start()] if _nxt else _rest
    assert "advance_game" not in _status_body, "the status poll route must never advance the game"


def test_d3_decision_card_rearms_on_boot_and_gamechanged():
    assert "rearmFromStatus" in DECISION
    assert '"orwell:gamechanged", rearmFromStatus' in DECISION.replace("'", '"')


def test_d3_status_route_live(monkeypatch):
    """End-to-end: a cached pending rides the status response."""
    oe = importlib.import_module("src.orwell_engine")
    orwell_routes = importlib.import_module("routes.orwell_routes")

    async def fake_status(user=None):
        return {"week": 2, "phase": "nominations", "hoh": None, "nominees": [], "veto": None}
    monkeypatch.setattr(oe, "game_status", fake_status)
    oe.remember_pending({"pending": {"kind": "nominations", "options": [{"id": "npc:1"}]}}, user=None)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    client = TestClient(app)
    r = client.get("/api/orwell/status")
    assert r.status_code == 200
    body = r.json()
    assert body.get("pending", {}).get("kind") == "nominations"
    oe.remember_pending({"pending": None}, user=None)
    assert client.get("/api/orwell/status").json().get("pending") is None


# ── D6/W8: the game build is self-contained (no third-party CDN) ─────────────

def test_d6_game_build_serves_no_jsdelivr():
    import importlib
    from fastapi.testclient import TestClient
    app_mod = importlib.import_module("app")
    client = TestClient(app_mod.app)
    r = client.get("/", headers={"host": "127.0.0.1"})
    # The index may require auth in some configs; only assert when it serves.
    if r.status_code == 200 and "<html" in r.text.lower():
        assert "cdn.jsdelivr.net" not in r.text, "the game build must not reference a CDN (D6/W8)"


def test_j1_02_game_build_composer_placeholder_is_in_voice():
    """UX audit J1-02: the composer placeholder named the APP ("Message Orwell…"),
    out-of-voice for an immersive house — the player speaks to the houseguests /
    Big Brother, not "Orwell". The game-build serve swaps it to an in-voice prompt;
    the full inherited workspace keeps the app copy."""
    # Source pins (auth-independent): the swap, the build-default restore target, and
    # the responsive handler restoring from it rather than a hardcoded string.
    app_py = (FE / "app.py").read_text(encoding="utf-8")
    assert 'html.replace("Message Orwell...", "Say or do something…")' in app_py
    html = (FE / "static" / "index.html").read_text(encoding="utf-8")
    assert 'data-default-placeholder="Message Orwell..."' in html, (
        "the textarea needs a build-default restore target the server can swap."
    )
    app_js = (FE / "static" / "app.js").read_text(encoding="utf-8")
    assert "dataset.defaultPlaceholder" in app_js, (
        "the responsive placeholder-hide must restore from the build default, not a "
        "hardcoded 'Message Orwell...' that would reintroduce the app-name copy."
    )
    # Served-HTML check when the index serves (game build is on by default).
    import importlib
    from fastapi.testclient import TestClient
    client = TestClient(importlib.import_module("app").app)
    r = client.get("/", headers={"host": "127.0.0.1"})
    if r.status_code == 200 and 'id="message"' in r.text:
        from src.settings import game_build_enabled
        if game_build_enabled():
            assert "Say or do something…" in r.text
            assert 'placeholder="Message Orwell..."' not in r.text


# ── E94 (FE half): first-class attach + attachments ride game turns ──────────

def test_e94_composer_paperclip_is_first_class_under_game_build():
    html = (FE / "static" / "index.html").read_text(encoding="utf-8")
    assert 'id="composer-attach-btn"' in html, "the paperclip must live IN the composer row (E94)"
    app_js = (FE / "static" / "app.js").read_text(encoding="utf-8")
    assert "composer-attach-btn" in app_js and "file-input" in app_js, \
        "the paperclip drives the same file-input flow"


def test_e94_game_framing_does_not_strip_attachments(monkeypatch):
    """A game-active turn keeps BOTH the GM framing and the attachment: the
    framing only prepends to the preface; the attachment rides the user
    message's content + metadata untouched."""
    import asyncio
    import importlib
    ch = importlib.import_module("routes.chat_helpers")
    oe = importlib.import_module("src.orwell_engine")

    async def fake_state(user=None, retry=None, timeout=None):
        return {"started": True, "week": 2, "phase": "nominations", "moment": "scene"}

    async def fake_moment(moment, user=None, timeout=None, **_kw):
        return {"systemPrompt": "GM-FRAMING-SENTINEL: you are the house"}

    monkeypatch.setattr(ch, "_fetch_game_state", fake_state, raising=True)
    monkeypatch.setattr(oe, "get_moment_prompt", fake_moment, raising=False)

    preface = []
    engine_available, game_active, feed_down = asyncio.get_event_loop().run_until_complete(
        ch.apply_game_framing(preface, user="e94"))
    assert game_active is True and feed_down is False
    framed = " ".join(str(p) for p in preface)
    assert "GM-FRAMING-SENTINEL" in framed, "the GM moment prompt frames the turn"

    # The attachment pipeline is independent of the framing: metadata survives.
    pm = ch.PreprocessedMessage(
        enhanced_message="look at this photo from home",
        user_content=[{"type": "text", "text": "look at this photo from home"},
                      {"type": "image_url", "image_url": {"url": "data:image/png;base64,xx"}}],
        text_for_context="look at this photo from home",
        youtube_transcripts=[],
        attachment_meta=[{"name": "home.png", "kind": "image"}],
    )

    class _Sess:
        def __init__(self): self.msgs = []
        def add_message(self, m): self.msgs.append(m)

    class _Handler:
        def update_session_name_if_needed(self, *a, **k): pass

    sess = _Sess()
    ch.add_user_message(sess, _Handler(), pm)
    msg = sess.msgs[0]
    assert msg.metadata == {"attachments": [{"name": "home.png", "kind": "image"}]}
    assert any(isinstance(c, dict) and c.get("type") == "image_url" for c in msg.content), \
        "the image content block rides the game turn"


# ── 0052 (ruling #13): the house themes lead the picker ──────────────────────

HOUSE = ["the-feed", "telescreen", "room-101", "memory-wall", "sequester"]


def _themes_in_order():
    import re as _re
    theme_js = (FE / "static" / "js" / "theme.js").read_text(encoding="utf-8")
    body = _re.search(r"export const THEMES = \{(.*?)\n\};", theme_js, _re.S).group(1)
    return _re.findall(r"^\s*'?([a-z0-9-]+)'?:\s*\{", body, _re.M), body


def test_0052_house_themes_are_first_in_the_picker():
    # The color-agnostic 'glass' theme now LEADS the picker (owner directive: Glass is
    # the default + first); the house set follows immediately after it.
    order, _ = _themes_in_order()
    assert order[0] == "glass", f"the picker must open with glass, got {order[:1]}"
    assert order[1:6] == HOUSE, f"the house set must follow glass, got {order[1:6]}"


def test_0052_house_palettes_meet_aa_contrast():
    import re as _re
    _, body = _themes_in_order()

    def lum(hexstr):
        r, g, b = (int(hexstr[i:i + 2], 16) / 255 for i in (0, 2, 4))
        f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)

    for name in HOUSE:
        m = _re.search(rf"'{name}':\s*\{{\s*bg:'#([0-9a-f]{{6}})',\s*fg:'#([0-9a-f]{{6}})',\s*panel:'#([0-9a-f]{{6}})'", body)
        assert m, f"{name} palette missing/odd shape"
        bg, fg, panel = m.group(1), m.group(2), m.group(3)
        for ground in (bg, panel):  # the frost composites toward the panel/bg
            l1, l2 = sorted((lum(fg), lum(ground)), reverse=True)
            ratio = (l1 + 0.05) / (l2 + 0.05)
            assert ratio >= 4.5, f"{name}: fg on #{ground} is {ratio:.2f}:1 (< AA 4.5)"


def test_0052_frost_is_capability_gated_and_off_the_chat_column():
    css = (FE / "static" / "css" / "orwellHouseThemes.css").read_text(encoding="utf-8")
    assert "@supports (backdrop-filter" in css, "frost needs the no-support fallback"
    assert "backdrop-filter: blur(" in css
    assert "chat-history" not in css and "#message" not in css, \
        "frost never touches the chat text column (readability first)"


def test_0052_motion_is_reduced_motion_gated_never_the_frost():
    css = (FE / "static" / "css" / "orwellHouseThemes.css").read_text(encoding="utf-8")
    assert "@media (prefers-reduced-motion: no-preference)" in css
    # every keyframe lives inside the motion gate
    pre_gate = css.split("@media (prefers-reduced-motion: no-preference)")[0]
    assert "@keyframes" not in pre_gate, "motion outside the reduced-motion gate"
    # the frost lives OUTSIDE it (reduced motion strips motion, never frost)
    assert "backdrop-filter" in pre_gate


def test_0052_theme_js_applies_the_house_treatment():
    theme_js = (FE / "static" / "js" / "theme.js").read_text(encoding="utf-8")
    assert "house-theme" in theme_js and "--panel-frost" in theme_js
    assert "house: true" in theme_js
