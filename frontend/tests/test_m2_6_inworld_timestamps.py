"""M2-6 (audit B5) — in-world timestamps on transcript beats.

A live-game beat's transcript stamp should read the GAME MOMENT ("Week 1 · Eviction night ·
Late night"), with the real wall clock demoted to hover/metadata (the `title`). Pre-game
(casting) keeps a NEUTRAL wall-clock stamp — the producer interview is out-of-fiction and must
not be dated by the game clock. No engine change: the moment is formatted from the Vault-free
public status the FE already fetches (week / phase / time-of-day on `GameStateView`).

This gate pins BOTH halves of the render contract:
  • server — `_format_game_moment` turns the public status into the moment string (None pre-game),
    `apply_game_framing` stashes it, and the persist site stamps it into assistant-message metadata
    ONLY on a game-active turn (via `game_moment=` on `save_assistant_response`) + rides it on the
    `message_saved` event for the live/mirror bubble;
  • client — `chatRenderer.roleTimestamp(when, moment)` prefers the moment as the primary stamp and
    demotes the wall clock to the `title`; the AI-header call sites pass `metadata.game_moment`.
"""
from __future__ import annotations

import os
import re

from routes.chat_helpers import _format_game_moment, current_game_moment, _LAST_FRAMED_GAME_MOMENT

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel: str) -> str:
    with open(os.path.join(FE, rel), encoding="utf-8") as fh:
        return fh.read()


# ── server: the moment string comes from the public status (no engine change) ──

def test_format_moment_is_none_pre_game():
    # Casting / not started ⇒ neutral stamp (None), never a game moment.
    assert _format_game_moment({"started": False}) is None
    assert _format_game_moment({}) is None
    assert _format_game_moment(None) is None


def test_format_moment_joins_week_phase_time():
    # The three public status fields, in show vocabulary, joined by " · ".
    got = _format_game_moment(
        {"started": True, "week": 1, "phase": "eviction", "timeOfDay": "late-night"}
    )
    assert got == "Week 1 · Eviction night · Late night"


def test_format_moment_omits_absent_time_of_day():
    # The clock is opt-in: with no timeOfDay the stamp is still an in-world moment.
    assert _format_game_moment({"started": True, "week": 2, "phase": "nominations"}) == "Week 2 · Nominations"


def test_format_moment_omits_nonpositive_week():
    # Premiere before week 1 is minted: no "Week 0" — just phase (+ time).
    assert _format_game_moment(
        {"started": True, "week": 0, "phase": "premiere", "timeOfDay": "morning"}
    ) == "Premiere · Morning"


def test_current_game_moment_reads_the_stash_default_keyed():
    _LAST_FRAMED_GAME_MOMENT.pop("default", None)
    _LAST_FRAMED_GAME_MOMENT.pop("u_m26", None)
    try:
        _LAST_FRAMED_GAME_MOMENT["u_m26"] = "Week 3 · Veto ceremony · Afternoon"
        assert current_game_moment("u_m26") == "Week 3 · Veto ceremony · Afternoon"
        assert current_game_moment("someone-else") is None
        # None user falls back to the "default" key (auth-off single-user posture).
        _LAST_FRAMED_GAME_MOMENT["default"] = "Week 4 · Jury · Evening"
        assert current_game_moment(None) == "Week 4 · Jury · Evening"
    finally:
        _LAST_FRAMED_GAME_MOMENT.pop("u_m26", None)
        _LAST_FRAMED_GAME_MOMENT.pop("default", None)


def test_framing_stashes_the_moment_zero_extra_read():
    # apply_game_framing formats + stashes the moment from the SAME framing state read.
    helpers = _read("routes/chat_helpers.py")
    assert "_LAST_FRAMED_GAME_MOMENT[user or \"default\"] = _format_game_moment(game_state)" in helpers


def test_save_assistant_response_stamps_game_moment_metadata():
    helpers = _read("routes/chat_helpers.py")
    # The param exists and the value is stamped into the persisted metadata.
    assert re.search(r"def save_assistant_response\([\s\S]*?game_moment: str = None", helpers)
    assert 'md["game_moment"] = game_moment' in helpers


# ── persist site: game-active gates the stamp; casting stays neutral ──

def test_persist_site_stamps_only_when_game_active():
    routes = _read("routes/chat_routes.py")
    # Both persist sites (chat mode + agent mode) compute the moment gated on game_active.
    occurrences = routes.count(
        "_game_moment = current_game_moment(ctx.user) if ctx.game_active else None"
    )
    assert occurrences == 2, f"expected the game-active-gated moment at both persist sites, got {occurrences}"
    # It is passed into the persisted metadata AND rides the live/mirror message_saved event.
    assert routes.count("game_moment=_game_moment") == 2
    assert routes.count('"moment": _game_moment') == 2


# ── client: roleTimestamp prefers the moment, demotes the wall clock to the title ──

def test_role_timestamp_prefers_moment_and_demotes_wall_clock():
    js = _read("static/js/chatRenderer.js")
    # New signature carries the in-world moment.
    assert "export function roleTimestamp(when, moment)" in js
    body = js.split("export function roleTimestamp(when, moment)", 1)[1].split("\n}", 1)[0]
    # The moment leads (primary textContent) when present…
    assert "typeof moment === 'string' && moment.trim()" in body
    assert "ts.textContent = moment.trim();" in body
    # …and the wall clock is demoted to hover (title) / metadata (dataset), never the body text
    # in the moment branch. The neutral (no-moment) branch keeps the wall clock as the text.
    assert "ts.dataset.wallClock = wall;" in body
    assert "ts.title = d.toLocaleString();" in body
    assert "ts.textContent = wall;" in body  # the pre-game / no-moment neutral stamp


def test_ai_header_call_sites_pass_game_moment():
    js = _read("static/js/chatRenderer.js")
    # The AI-header renders (first-visible agent header + the general assistant header) source the
    # stamp from metadata.game_moment.
    assert js.count("roleTimestamp(metadata?.timestamp, metadata?.game_moment)") >= 2


def test_live_and_mirror_paths_carry_the_moment():
    js = _read("static/js/chat.js")
    # _applyServerTimestamp takes the moment and prefers it over the server wall clock.
    assert "function _applyServerTimestamp(holderEl, iso, moment)" in js
    assert "span.textContent = moment.trim();" in js
    # The mirror finalize-in-place carries the moment onto the canonical bubble metadata.
    assert "meta_.game_moment = serverMoment;" in js


def test_ws_splice_live_bubble_shows_the_moment():
    # WS transport (ADR 0017): the live mirror bubble (window B) applies the moment from the
    # message_saved frame during the stream, so it reads the in-world stamp like the sender — not
    # the wall clock until the settle reconcile. The wall clock is demoted to hover (title) +
    # metadata (dataset.wallClock) the SAME way chat.js _applyServerTimestamp / chatRenderer.js
    # roleTimestamp do, sourcing the SERVER-minted `d.ts` the frame carries (identical hover across
    # windows), with a fallback to the bubble's existing wall-clock text when `ts` is absent.
    #
    # This is a source-pin (like the sibling render-contract checks): the LIVE DOM behaviour of this
    # exact WS message_saved path is exercised end-to-end by the mirror-parity WS gate
    # (docs/audits/playtest-harness/mirror_live_parity.mjs — real two-window browser). A Node/browser
    # unit here would need the whole chatWsSplice import graph (HTMLInputElement et al.), which
    # balloons scope for a nitpick, so the pins below + the gate are the coverage.
    js = _read("static/js/chatWsSplice.js")
    assert "d.type === 'message_saved'" in js
    assert "typeof d.moment === 'string' && d.moment.trim()" in js
    # moment leads the visible stamp + carries the marker class
    assert "_ts.textContent = d.moment.trim();" in js
    assert "_ts.classList.add('role-timestamp-moment');" in js
    # wall clock demoted to hover (title) + dataset, sourced from the server-minted `d.ts`
    assert "var _wd = d.ts ? new Date(d.ts) : null;" in js
    assert "_ts.title = _wd.toLocaleString();" in js
    assert "_ts.dataset.wallClock = _wd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });" in js
    # fallback preserves the existing wall clock when the frame has no ts
    assert "_ts.dataset.wallClock = _ts.textContent;" in js


def test_disconnect_partial_save_stamps_game_moment():
    # Greptile P1: a disconnect / stopped-partial save is still an in-game beat — it must stamp the
    # in-world moment so the reloaded partial reads the game moment, not the wall clock (the bug M2-6
    # removes). Both the chat-mode and agent-mode disconnect saves compute it, gated on game_active
    # (casting → None ⇒ key absent), from the same source as the [DONE] save.
    routes = _read("routes/chat_routes.py")
    assert routes.count("current_game_moment(ctx.user) if ctx.game_active else None") >= 4  # 2 [DONE] + 2 disconnect
    # ORW-230: both disconnect handlers save through the one `save_stopped_partial`, handing it the moment,
    # and the helper stamps it (behaviour: test_orw230_unclosed_think_save.py reloads it from the DB).
    assert "game_moment=_stopped_moment," in routes
    assert "game_moment=_stopped_moment2," in routes
    helpers = _read("routes/chat_helpers.py")
    save = helpers[helpers.index("def save_stopped_partial("):]
    assert 'md["game_moment"] = game_moment' in save[:2500]
