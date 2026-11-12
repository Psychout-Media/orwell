"""WebSocket Phase-1 — the SERVER half (browser ↔ FE, Hop 1).

One multiplexed WebSocket per canonical session, per ADR 0017 Phase 1 and the frozen wire spec
``docs/design/websocket-phase1-protocol.md``. It **swaps the pipe** under the proven consistency
model — it does not invent one. The load-bearing FE seams it re-hosts on the socket:

  * the ``hello``→``bind``→``ack`` handshake (§2) that binds + liveness-validates the canonical
    session BEFORE any subscribe — closing the #1085/#1086 window-collapse / reply-strip class by
    construction (a socket is never ``ack``-bound to a dead id, so no channel is ever subscribed to a
    404), reusing the EXACT existing helpers (``resolve_live_game_session`` / ``bind_game_session`` /
    ``_is_live_chat_session``); the resolution BRANCH is server-derived from authenticated engine
    state, never from anything the client sent (§2.2 forge guard);
  * the ``chat`` channel (§3) — a thin socket adapter over ``agent_runs.subscribe(canonicalId,
    from_seq)``: an ``ack{fromSeq, headSeq}`` first, then replay-from-``fromSeq`` → live-tail wrapped
    as ``event`` frames, gated on ``has_run`` (terminal-but-buffered still mirrors, ADR 0012), the
    reasoning split riding INSIDE the payload as a ``thinking`` flag (never a separate channel — the
    reasoning-scrub contract, ADR 0015);
  * the ``turn`` / ``decision`` up-frames (§3.5) relayed into the UNCHANGED ``agent_runs.start`` /
    engine path with the ``expectedBeatSeq`` compare-and-swap (0065) — a stale token ⇒ an ``error``
    frame ``{code:"stale-beat"}`` (the socket-native form of HTTP 409 ``stale-beat``), refused before
    any write;
  * the ``state`` / ``hud`` edge pings (§4) bridged from ``session_events`` — ids + ``beatSeq`` only,
    never a state body, so the Vault Wall stays trivially intact (the client re-reads its own
    Vault-free projection endpoint on the edge).

**Invariants (hard):** never a byte of Vault data crosses the socket (only the Vault-free projections
the SSE/poll surfaces already carry); every ``hello``/``bind``/``subscribe``/``turn``/``decision`` is
owner-guarded (cross-user isolation 0021 — one socket ↔ one user); reasoning rides inside the ``chat``
payload, never a second public channel; bind-before-subscribe.

The ``layout`` channel leg is now WIRED (#1293): it rides the same per-session ``session_events`` bus
and its per-device ``patch_layout(user, deviceId, …)`` re-key has merged, so ``_run_layout_channel`` /
``_handle_layout`` below are live (per-device LWW, ADR 0017 §5 — geometry is per-device, only game
state syncs). The route is registered; the client ATTEMPTS the upgrade in the game build, which is WebSocket-only
(ORW-44, 2026-11-12: the ``ORWELL_WS_TRANSPORT`` rollback flag is gone).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from typing import Any, AsyncGenerator, Callable, Optional

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from src import agent_runs
from src import session_events
from src import orwell_game_session as ogs

logger = logging.getLogger(__name__)

# Socket-level heartbeat: mirror ``session_events._HEARTBEAT_S`` (§1.2). The server sends
# ``{"t":"ping"}`` on this cadence; a live client replies ``{"t":"pong"}``.
_HEARTBEAT_S = 20.0

# The sanctioned binding-decision kinds — the socket-native ``decision`` up-frame is the C20 confirm
# path over the WS (ADR 0003 §4): it posts the player's EXPLICIT selection engine-direct, so prose can
# never bind through it, and every kind is validated before it reaches the engine (the same legality
# gate the HTTP ``/decision`` route's local ``_DECISION_KINDS`` enforces — kept in lockstep with the
# canonical set in ``routes/orwell_routes.py``). This is the guard that keeps the WS ``submit_decision``
# call a sanctioned progression, not a UI-driven game bypass (test_b66_augment_guard).
from src.orwell_engine import DECISION_KINDS as _DECISION_KINDS  # ONE source (orwell_engine)


# ── monkeypatchable seams (kept module-level so tests can swap them without a booted app) ──────────

def _auth_disabled() -> bool:
    """True when the operator turned auth off (``AUTH_ENABLED=false``). Mirrors the parse the rest of
    the FE uses; single-tenant then, so every socket is the one ``default`` bucket."""
    import os
    return os.getenv("AUTH_ENABLED", "true").lower() == "false"


def _origin_netloc(origin: str) -> Optional[str]:
    """The ``host[:port]`` authority of an ``Origin`` value (``scheme://host[:port]``), lowercased and
    with the scheme's DEFAULT port stripped so an explicit ``:80``/``:443`` matches a bare ``Host``
    header (browsers omit default ports in both, but normalize defensively). ``None`` if unparseable /
    hostless (an opaque ``Origin`` like ``null`` — which a sandboxed/foreign context sends)."""
    from urllib.parse import urlsplit
    try:
        parts = urlsplit((origin or "").strip())
    except Exception:
        return None
    host = (parts.hostname or "").lower()
    if not host:
        return None
    if ":" in host:
        # IPv6 literal — urlsplit STRIPS the brackets (``http://[::1]:7000`` → hostname ``::1``), while
        # the browser's request ``Host`` keeps the bracketed authority (``[::1]:7000``). Restore the
        # brackets so the composed authority matches the Host side (ADR 0074 LAN/local-HTTPS IPv6
        # exposure) — otherwise a same-origin IPv6 client is falsely rejected.
        host = f"[{host}]"
    scheme = (parts.scheme or "").lower()
    try:
        port = parts.port
    except ValueError:
        return None
    if port is None or (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        return host
    return f"{host}:{port}"


def _host_authority(host: str, expected_scheme: str = "") -> str:
    """Normalize a request ``Host`` header for a same-origin comparison against an ``Origin`` netloc,
    SCHEME-AWARE so the port leg stays internally consistent with the scheme leg of the guard.

    The ``Host`` header carries no scheme, but the same-origin check now enforces scheme too — so only
    the EXPECTED external scheme's default port is bare-host-equivalent: ``:443`` iff the deploy is
    ``https``/``wss``, ``:80`` iff ``http``/``ws``. Stripping BOTH regardless of scheme (the old
    behavior) was a real inconsistency (greptile P1): under ``X-Forwarded-Proto: https`` a
    ``Host: victim:80`` would collapse to ``victim`` and falsely match ``https://victim`` even though
    ``https://victim:80`` ≠ ``https://victim`` (the port IS part of the origin). Now:

      * expected ``https``/``wss`` → strip only ``:443`` (``victim:443``→``victim``; ``victim:80`` stays
        ``victim:80`` → will NOT match ``https://victim`` → correctly rejected).
      * expected ``http``/``ws``   → strip only ``:80``.
      * indeterminate ("" — no XFP and an unknowable request scheme, the case the caller ALSO skips the
        scheme leg for) → best-effort strip either default port (we cannot know which applies, and the
        scheme leg is skipped, so acceptance is not weakened — an unknowable-scheme deploy is not broken).

    IPv6 bracket-safe: an address literal ending in ``]`` never matches a ``:80``/``:443`` suffix, so
    ``[::1]:443``→``[::1]`` (only under https) while ``[::443]`` is untouched. A non-default port (e.g.
    ``:7000`` for LAN) is always preserved so it must still match the Origin's port. A browser cannot
    forge ``Host`` from page JS, so stripping the matching default port is no security loss."""
    h = (host or "").strip().lower()
    es = (expected_scheme or "").lower()
    if es in ("https", "wss"):
        return h[:-4] if h.endswith(":443") else h
    if es in ("http", "ws"):
        return h[:-3] if h.endswith(":80") else h
    # Indeterminate external scheme — best-effort (the caller skips the scheme leg in this case).
    if h.endswith(":80"):
        return h[:-3]
    if h.endswith(":443"):
        return h[:-4]
    return h


def _expected_external_scheme(websocket: WebSocket) -> str:
    """The scheme the BROWSER used to reach the deploy — the external, TLS-terminator-facing scheme,
    used to complete the same-origin check (a web Origin is scheme+host+port, so ``host[:port]`` alone
    is not a full same-origin match: ``http://host`` and ``https://host`` are DIFFERENT origins and a
    same-host-plaintext page must stay outside the trust boundary).

    Derivation, in order (handles the ADR 0074 TLS-terminated deploys — Caddy / Cloudflare / Newt /
    bare local-HTTPS — where the browser speaks ``wss``/``https`` but the FE's OWN hop from the
    terminator is plaintext ``ws``, so ``websocket.url.scheme`` is ``ws`` and a naive ws→http map would
    wrongly reject a legitimate ``https`` Origin and break every tunnel/HTTPS deploy):

      1. ``X-Forwarded-Proto`` (first value, lowercased) if the terminator set it — all four supported
         terminators do, INCLUDING bare local-HTTPS (Caddy). This is the external scheme verbatim.
      2. Else map the request's own scheme (``websocket.url.scheme``): ``wss``→``https``, ``ws``→``http``
         (direct-uvicorn LAN plaintext ⇒ ``http``; a direct TLS uvicorn ⇒ ``https``).

    Returns ``""`` when it cannot be determined (no XFP, unknown request scheme) — the caller then does
    NOT enforce the scheme leg (accept on host match alone) rather than break a deploy whose scheme is
    unknowable, per the coordinator's don't-break-the-deploy rule."""
    try:
        xfp = websocket.headers.get("x-forwarded-proto")
    except Exception:
        xfp = None
    if xfp:
        first = xfp.split(",")[0].strip().lower()
        if first:
            return first
    try:
        req_scheme = (websocket.url.scheme or "").lower()
    except Exception:
        req_scheme = ""
    if req_scheme == "wss":
        return "https"
    if req_scheme == "ws":
        return "http"
    if req_scheme in ("http", "https"):
        return req_scheme
    return ""


def _allowed_ws_origins() -> set:
    """The explicit cross-origin allowlist for a WS upgrade — the SAME ``ALLOWED_ORIGINS`` the app's
    credentialed CORS layer trusts (``app.py`` / ``core.middleware``), normalized to
    ``scheme://host[:port]`` (default port stripped, lowercased). No new origin model: the WS guard
    reuses exactly the origins the rest of the app already sanctions for cross-site credentialed
    reads. An empty/unset value ⇒ empty set (the same-origin ``Host`` match below is the floor)."""
    import os
    raw = (os.getenv("ALLOWED_ORIGINS") or "").strip()
    out = set()
    for o in raw.split(","):
        o = o.strip()
        if not o or o == "*":
            continue
        netloc = _origin_netloc(o)
        scheme = o.split("://", 1)[0].lower() if "://" in o else ""
        if netloc and scheme:
            out.add(f"{scheme}://{netloc}")
    return out


def _ws_origin_allowed(websocket: WebSocket) -> bool:
    """Cross-Site WebSocket-Hijacking (CSWSH) defense — protocol spec §1.1. A browser attaches the
    session cookie to a CROSS-SITE WS upgrade automatically, and the HTTP CORS / TrustedHost middleware
    does NOT cover a WebSocket handshake, so cookie auth alone cannot stop a malicious page from opening
    an authenticated socket to a victim's session. This enforces an ``Origin`` allowlist BEFORE any
    ``hello``/``bind``/frame is processed — it sits ALONGSIDE the cookie auth (``_ws_current_user``) +
    owner guard (``_ws_owns``), never in place of them.

    The rule (spec §1.1 — reject a present-and-foreign Origin):

      * **No ``Origin`` header → allow.** A browser ALWAYS sends ``Origin`` on a cross-site WS
        handshake, so the CSWSH attack surface always carries one; the absent case is a non-browser /
        native / same-origin server-side / test client (which also does not auto-attach the victim's
        cookie), so refusing it would break legitimate non-browser paths for no security gain.
      * **``Origin`` present → allow IFF** it is same-origin with the request — its **scheme + host[:port]**
        match the deploy's own **external scheme** (X-Forwarded-Proto / request scheme, ADR 0074) + ``Host``
        (so ``http://host`` is NOT accepted against an ``https``/``wss`` deploy; LAN + tunnel/HTTPS exposure
        per ADR 0007/0014 still works with no hard-coded domain) **OR** it is in the configured
        ``ALLOWED_ORIGINS`` allowlist (the same origins the credentialed CORS layer trusts).
      * **Otherwise (present + foreign / opaque ``null``) → reject** (the upgrade is refused, no ack).

    A browser cannot forge either ``Origin`` or ``Host`` from page JS, and in a public deployment
    ``Host`` is additionally pinned by ``TrustedHostMiddleware`` — so the same-origin comparison is
    robust against the browser-driven CSWSH attack even with ``ALLOWED_HOSTS`` unset."""
    try:
        origin = websocket.headers.get("origin")
    except Exception:
        # No header surface at all (a non-Starlette/test transport) — treat as the absent-Origin
        # non-browser path (allow); cookie auth + owner guard still apply below.
        return True
    if not origin:
        return True  # non-browser / same-origin native / test path — CSWSH always carries an Origin
    origin_netloc = _origin_netloc(origin)
    if origin_netloc is None:
        return False  # present but opaque/unparseable (e.g. "null") → foreign
    origin_scheme = origin.split("://", 1)[0].lower() if "://" in origin else ""
    # 1) Same-origin: the Origin's SCHEME + host[:port] equal the deploy's own external scheme + Host.
    #    Host authority is normalized the SAME way _origin_netloc normalizes the Origin (strip the
    #    scheme's default port) so a proxy-set `Host: host:443` still matches a bare `https://host`
    #    Origin (greptile P1) — a browser cannot forge Host, so this is no security loss. The SCHEME leg
    #    (greptile P1): a web origin is scheme+host+port, so `http://host` must NOT be accepted against
    #    an `https`/`wss` deploy (a same-host-plaintext page stays outside the trust boundary). The
    #    expected external scheme comes from X-Forwarded-Proto / the request scheme (ADR 0074 tunnels
    #    terminate TLS then hop plaintext to the FE, so we cannot read it off `websocket.url` alone).
    #    When the external scheme is indeterminate (""), the scheme leg is skipped (host match alone) so
    #    an unknowable-scheme deploy is not broken.
    #    The port normalization is SCHEME-AWARE (greptile P1): _host_authority strips ONLY the expected
    #    scheme's default port, so under https a `Host: host:80` does NOT collapse to `host` (port is
    #    part of the origin) — the port and scheme legs stay internally consistent.
    expected_scheme = _expected_external_scheme(websocket)
    try:
        host = _host_authority(websocket.headers.get("host") or "", expected_scheme)
    except Exception:
        host = ""
    if host and origin_netloc == host:
        if (not expected_scheme) or (origin_scheme == expected_scheme):
            return True
        # host matches but scheme does not → same-host different-scheme; fall through (may still be
        # explicitly allowlisted below, else reject).
    # 2) Explicit allowlist — the CORS ALLOWED_ORIGINS the app already sanctions (scheme+host+port).
    scheme = origin_scheme
    if scheme and f"{scheme}://{origin_netloc}" in _allowed_ws_origins():
        return True
    return False


def _ws_current_user(websocket: WebSocket) -> Optional[str]:
    """Resolve the authenticated user for a WebSocket upgrade.

    ``BaseHTTPMiddleware`` (the app's ``AuthMiddleware``) only wraps HTTP scope, so ``request.state``
    is NOT populated for a socket — the WS route resolves the user itself from the SAME session cookie
    every ``/api/*`` route reads (protocol spec §1.1). ``AUTH_ENABLED=false`` ⇒ the single-tenant
    ``default`` bucket (``None``), identical to ``get_current_user`` returning ``None`` elsewhere."""
    if _auth_disabled():
        return None
    try:
        from routes.auth_routes import SESSION_COOKIE
        token = websocket.cookies.get(SESSION_COOKIE)
        am = getattr(websocket.app.state, "auth_manager", None)
        if am is not None and am.validate_token(token):
            return am.get_username_for_token(token)
    except Exception:
        logger.debug("[ws] cookie user resolution failed", exc_info=True)
    return None


def _is_live(session_id: str) -> bool:
    """Is ``session_id`` a LIVE chat-session row? Delegates to the SAME predicate the HTTP canonical
    resolver uses (``chat_helpers._is_live_chat_session``, GAP-1). Fail-soft: a lookup error resolves
    True so a transient hiccup never unbinds a good id / refuses a good socket (only a CONFIRMED-dead
    id is dropped, matching ``resolve_live_game_session``)."""
    if not session_id:
        return False
    try:
        from routes import chat_helpers
        return bool(chat_helpers._is_live_chat_session(session_id))
    except Exception:
        logger.debug("[ws] liveness lookup failed for %s", session_id, exc_info=True)
        return True


def _localhost_bypass_env() -> bool:
    return os.getenv("LOCALHOST_BYPASS", "false").strip().lower() == "true"


def _ws_localhost_bypass(websocket: WebSocket) -> bool:
    """The documented dev bypass: LOCALHOST_BYPASS=true AND a DIRECT loopback peer (no proxy headers) —
    the same rule the HTTP AuthMiddleware applies, so a tunnelled/proxied socket never qualifies."""
    if not _localhost_bypass_env():
        return False
    from core.middleware import is_trusted_loopback
    return is_trusted_loopback(websocket)  # a WebSocket has the .client / .headers the check reads


def _ws_owns(user: Optional[str], session_id: str) -> bool:
    """Owner guard for a WebSocket (cross-user isolation 0021). Mirrors ``_verify_session_owner``:
    a persisted row's ``owner`` must match; an id with no DB row is an in-memory ghost / fresh per-tab
    id the resolving user just created (it cannot name another user's row), so it is ownable. Auth-off
    ⇒ single-tenant, always owned."""
    if _auth_disabled():
        return True
    if not session_id:
        return False
    if not user:
        # Auth ON and no resolved user: ``ws_session`` only lets such a socket in under the documented
        # LOCALHOST_BYPASS dev mode (trusted direct loopback, single tenant — like auth-off). Anything
        # else owns nothing.
        return _localhost_bypass_env()
    try:
        from core.database import SessionLocal, Session as DBSession
        db = SessionLocal()
        try:
            row = db.query(DBSession.owner).filter(DBSession.id == session_id).first()
        finally:
            db.close()
    except Exception:
        logger.debug("[ws] owner lookup failed for %s", session_id, exc_info=True)
        return True  # fail-soft: a transient DB error must not lock a legitimate owner out
    if row is None:
        # No persisted row: an in-memory ghost session is owned by whoever created it. Mirror
        # ``session_routes._verify_session_owner``: a ghost that belongs to ANOTHER user is not ours;
        # an id nobody holds is a fresh per-tab id the resolving user just created (ownable).
        try:
            from core.models import _session_manager as _sm
            ghost = getattr(_sm, "sessions", {}).get(session_id) if _sm is not None else None
        except Exception:
            logger.debug("[ws] ghost owner lookup failed for %s", session_id, exc_info=True)
            return True
        return ghost is None or getattr(ghost, "owner", None) == user
    return row.owner == user


async def _engine_state(user: Optional[str]) -> dict:
    """The user's Vault-free game state (``started`` + ``beatSeq``), fail-soft to ``{}`` so a
    handshake never crashes on an engine hiccup (it just resolves the pre-game / per-tab branch)."""
    try:
        from src import orwell_engine
        # ORW-166: the polled (<=400 ms, single-flight, mutation-invalidated) read - every bus edge and handshake used to hit the engine afresh just to read beatSeq, and a burst of edges queued behind the narrator's own calls.
        st = await orwell_engine.get_game_state_polled(user=user)
        return st if isinstance(st, dict) else {}
    except Exception:
        logger.debug("[ws] engine state fetch failed for user=%s", user, exc_info=True)
        return {}


def _beat_seq_of(state: dict) -> Optional[int]:
    bs = state.get("beatSeq")
    return bs if (isinstance(bs, int) and not isinstance(bs, bool)) else None


# ── the turn producer injection point (see module docstring — the FE chat pipeline lives in ──────────
#    routes/chat_routes.py's inline chat_stream closure and cannot be reused without a shared refactor
#    that change owns, exactly like the per-device layout leg). The WS ``turn`` relay carries the CAS +
#    framing + ``agent_runs.start`` wiring; the content producer is injected here. Until wired, a
#    ``turn`` up-frame answers with an explicit ``error{code:"turn-relay-unwired"}`` — NEVER a silent
#    no-op (the four-place-wiring lesson: a silently-dropped relay is the worst failure).

_TurnStreamFactory = Callable[[dict, str, Optional[str]], AsyncGenerator[str, None]]
_turn_stream_factory: Optional[_TurnStreamFactory] = None


def set_turn_stream_factory(fn: Optional[_TurnStreamFactory]) -> None:
    """Register the producer that turns a ``turn`` up-frame ``d`` + canonical id + user into the SSE
    event stream ``agent_runs.start`` drains (the same strings ``chat_stream`` produces). The default
    (unset) relay refuses with ``turn-relay-unwired`` rather than silently dropping the turn."""
    global _turn_stream_factory
    _turn_stream_factory = fn


# ── canonical resolution (server-derived branch — §2.2; the client NEVER picks it) ─────────────────

def _resolve_canonical(user: Optional[str], per_tab_id: str, started: bool) -> tuple[str, bool, bool]:
    """Return ``(canonicalId, adopted, live)`` exactly as ``_resolve_canonical_session`` +
    ``resolve_live_game_session`` decide it, driven by SERVER-derived ``started`` (never a client flag):

      * NOT started (casting / pre-game, GAP-2-b1) → strictly the per-tab id (two casting tabs never
        mirror, by design).
      * started → the first-writer-wins bound id IFF it still resolves live (a confirmed-dead binding
        is unbound as a side effect and falls back); else first-writer bind THIS tab (only if the
        per-tab id is itself a live row) and adopt; else the per-tab id, ``live=False`` (no live
        fallback → the client shows the reconnect affordance rather than subscribing a dead channel).

    ``adopted=True`` means this socket LOST the bind race and adopted a different id (the socket-native
    replacement for the ``canonical_session`` re-point, done at handshake before any subscribe — so no
    settle-time reload strips a just-streamed reply, #1086)."""
    if not started:
        return per_tab_id, False, _is_live(per_tab_id)
    canonical = ogs.resolve_live_game_session(user, _is_live)  # live bound id, or None (+unbind dead)
    if canonical:
        return canonical, (canonical != per_tab_id), True
    if _is_live(per_tab_id):
        bound = ogs.bind_game_session(user, per_tab_id)  # first-writer-wins
        return bound, (bound != per_tab_id), _is_live(bound)
    return per_tab_id, False, False


# ── the route ──────────────────────────────────────────────────────────────────────────────────────
#
# ``ws_session`` is module-level (not a route-closure) so the fe-unit tests can drive it directly with
# an in-process fake WebSocket in ONE event loop — the repo's async idiom (``test_0064_turn_queue.py``)
# — where the WS handler, ``agent_runs.start``, and the gate-controlled fake run all share the loop.
# ``setup_ws_routes`` just binds it to the path.

async def ws_session(websocket: WebSocket) -> None:
        # CSWSH guard (protocol §1.1) — FIRST, before accept or any frame. A foreign-origin upgrade is
        # refused at handshake time (policy-violation close 1008, no accept, no ack): a browser attaches
        # the session cookie to a cross-site WS upgrade automatically, so cookie auth alone cannot stop a
        # malicious page from opening an authenticated socket. Same-origin browser clients (matching
        # Origin) and non-browser/native/test paths (no Origin header) are unaffected. This is IN
        # ADDITION to the cookie auth + owner guard below.
        if not _ws_origin_allowed(websocket):
            with contextlib.suppress(Exception):
                await websocket.close(code=1008)  # 1008 = policy violation
            return
        # AUTH GATE — the HTTP AuthMiddleware does not wrap a WebSocket, so with auth ON a socket that
        # resolves no user would otherwise be accepted into the ``None`` (shared/default) bucket. Refuse
        # it at the handshake with the same policy-violation close as the origin guard (no accept, no
        # frame). ``AUTH_ENABLED=false`` is unchanged: single-tenant, ``user`` stays None by design.
        user = _ws_current_user(websocket)
        if user is None and not _auth_disabled() and not _ws_localhost_bypass(websocket):
            with contextlib.suppress(Exception):
                await websocket.close(code=1008)
            return
        await websocket.accept()

        # One send lock: background channel tasks + the receive loop + the heartbeat all serialize
        # their writes through it (Starlette's send is not concurrency-safe across tasks).
        send_lock = asyncio.Lock()

        async def send(frame: dict) -> None:
            async with send_lock:
                await websocket.send_text(json.dumps(frame))

        # Per-socket binding + channel tasks.
        sock: dict[str, Any] = {"canonical": None, "live": False, "beatSeq": None}
        channel_tasks: dict[str, asyncio.Task] = {}
        # #1087: the canonical id each state/hud channel task was SPAWNED for. A same-socket
        # re-subscribe for the SAME canonical is deduped to a no-op (see _handle_subscribe) — a
        # respawn would run a fresh `session_events.subscribe()`, which REPLAYS the per-session
        # event ring (ADR 0012 §3.4b) back at a window that already consumed it, feeding the
        # client's gamechanged→rebind loop. A genuinely NEW socket (fresh window / reconnect after
        # a drop) gets a fresh ws_session call — and therefore a fresh task + the ring replay that
        # durability exists for.
        channel_canonicals: dict[str, Any] = {}

        async def _heartbeat() -> None:
            try:
                while True:
                    await asyncio.sleep(_HEARTBEAT_S)
                    await send({"t": "ping"})
            except (asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                return
            except Exception:
                return

        hb_task = asyncio.create_task(_heartbeat())

        # ── channel adapters ──────────────────────────────────────────────────────────────────────

        async def _run_chat_channel(cid: str, from_seq: int) -> None:
            """§3 — ack-first, then replay-from-``from_seq`` → live-tail over the SHIPPED
            ``agent_runs.subscribe`` generator (no replay logic re-implemented here — the socket is a
            dumb frame-wrapper, per spec §10). The frame ``seq`` IS the buffer index: the generator
            yields contiguous ``from_seq, from_seq+1, …`` (replay tail then de-duped live tail), so a
            running counter from ``from_seq`` reproduces ``_publish``'s ``len(buffer)-1`` index exactly
            — the identity the whole reconnect splice rests on (§10 "fromSeq seq identity")."""
            canonical = sock["canonical"]
            # Gate on has_run, NOT is_active: a short turn that finished before this peer attached is
            # terminal-but-buffered (within the 180s evict grace) and MUST still replay the whole turn
            # (ADR 0012 / the has_run fix). No run at all → nothing to mirror; tell the client so it can
            # do a normal history load (spec §3.6).
            if not agent_runs.has_run(canonical):
                await send({"t": "ack", "ch": "chat", "cid": cid,
                            "d": {"fromSeq": from_seq, "headSeq": -1, "hasRun": False}})
                return
            head = agent_runs.head_seq(canonical)
            # Clamp an over-shot cursor to the buffer so a live event with a real seq < from_seq is not
            # skipped by the de-dup (spec §3.1 "clamped to the buffer if it over-shot").
            start = max(0, from_seq)
            if start > head + 1:
                start = head + 1
            # `runId` (#1087): name the run this subscribe attaches to, so the client can later
            # recognize a ring-replayed `run-started` edge for the SAME run as stale (reconcile-by-id).
            await send({"t": "ack", "ch": "chat", "cid": cid,
                        "d": {"fromSeq": start, "headSeq": head, "hasRun": True,
                              "runId": agent_runs.run_id(canonical)}})
            seq = start
            try:
                async for raw in agent_runs.subscribe(canonical, from_seq=start):
                    await send({"t": "event", "ch": "chat", "seq": seq, "d": _sse_to_payload(raw)})
                    seq += 1
            except (asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                return
            except Exception:
                logger.debug("[ws] chat channel error for %s", canonical, exc_info=True)

        async def _run_state_channel(ch: str) -> None:
            """§4 — bridge ``session_events`` (game-updated / run-started / message-added) to ``state``/
            ``hud`` EDGE PINGS keyed by ``beatSeq``. Payload is ids + beatSeq only — NEVER a state body
            (Vault Wall trivially intact); the client re-reads its own Vault-free projection on the
            edge, exactly as the deleted 20/25s poll did, now edge-triggered."""
            canonical = sock["canonical"]
            try:
                async for raw in session_events.subscribe(canonical):
                    reason = _sse_event_name(raw)
                    # `layout-changed` rides the SAME per-session bus (§5) but is NOT a game-state edge —
                    # the `layout` channel owns it. Skip it here so a window move never triggers a spurious
                    # HUD/status re-read.
                    if reason in (None, "connected", "keepalive", "layout-changed"):
                        continue
                    st = await _engine_state(user)
                    bs = _beat_seq_of(st)
                    if bs is not None:
                        sock["beatSeq"] = bs
                    d: dict[str, Any] = {"beatSeq": sock["beatSeq"], "reason": reason}
                    if reason == "run-started":
                        # #1087 reconcile-by-id: stamp the CURRENT run's identity on the edge (the
                        # publish sites stay payload-unchanged — the run registry is the identity
                        # source). A ring-REPLAYED edge for a finished-but-buffered run resolves to
                        # that same run's id, which is exactly what lets the client skip it; an
                        # evicted run resolves to None and the client falls back to its boolean guard.
                        rid = agent_runs.run_id(canonical)
                        if rid is not None:
                            d["runId"] = rid
                    await send({"t": ch, "ch": ch, "d": d})
            except (asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                return
            except Exception:
                logger.debug("[ws] %s channel error for %s", ch, canonical, exc_info=True)

        async def _run_layout_channel(cid: str) -> None:
            """§5 — the per-device layout leg. Subscribe the SAME per-session ``session_events`` bus and
            forward ONLY ``layout-changed`` events (published by ``_handle_layout`` and the HTTP PATCH
            ``/layout`` route) as ``layout`` frames carrying the store's CANONICAL descriptor
            (``windowId`` / ``state`` / ``deviceId`` / ``origin``). Per ADR 0017 the CLIENT does the
            per-device filtering (apply only its own ``deviceId``) and drops its own ``origin`` echo —
            the server fans out to every tab on the session, exactly as the ``orwell:layout-changed`` SSE
            does today, so WS and fallback tabs stay in lockstep. Vault-free: geometry carries no secret."""
            canonical = sock["canonical"]
            await send({"t": "ack", "ch": "layout", "cid": cid, "d": {"subscribed": True}})
            try:
                async for raw in session_events.subscribe(canonical):
                    if _sse_event_name(raw) != "layout-changed":
                        continue
                    data = _sse_event_data(raw)
                    if not isinstance(data, dict):
                        continue
                    # Drop the bus's own bookkeeping keys (`session`, and the F3 `busSeq` version
                    # stamp); forward the layout descriptor only.
                    descriptor = {k: v for k, v in data.items() if k not in ("session", "busSeq")}
                    await send({"t": "layout", "ch": "layout", "d": descriptor})
            except (asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                return
            except Exception:
                logger.debug("[ws] layout channel error for %s", canonical, exc_info=True)

        def _spawn_channel(key: str, coro) -> None:
            old = channel_tasks.pop(key, None)
            if old is not None and not old.done():
                old.cancel()
            channel_tasks[key] = asyncio.create_task(coro)

        # ── frame handlers ──────────────────────────────────────────────────────────────────────────

        async def _handle_hello(frame: dict) -> bool:
            """hello/bind: resolve + liveness-validate the canonical id, owner-guarded, BEFORE any
            channel is subscribable. Returns False to close the socket (a non-owned refusal)."""
            cid = frame.get("cid")
            d = frame.get("d") or {}
            per_tab = (d.get("perTabId") or "").strip()
            if not per_tab:
                await send({"t": "error", "cid": cid, "d": {"code": "bad-request"}})
                return True
            # Owner guard FIRST (cross-user isolation): a socket may only ever name a session its user
            # owns. A non-owned hello/bind → error{forbidden} + close (mirrors _verify_session_owner
            # raising); the cid echoes the refused request so the client rejects the right promise.
            if not _ws_owns(user, per_tab):
                await send({"t": "error", "cid": cid, "d": {"code": "forbidden"}})
                return False
            state = await _engine_state(user)
            started = bool(state.get("started"))  # SERVER-derived; a forged framed/gameActive is ignored
            canonical, adopted, live = _resolve_canonical(user, per_tab, started)
            # The adopted id must ALSO be owned by this user (it can only ever be the user's own bound
            # game session, but assert it structurally).
            if not _ws_owns(user, canonical):
                await send({"t": "error", "cid": cid, "d": {"code": "forbidden"}})
                return False
            sock["canonical"] = canonical
            sock["live"] = live
            sock["beatSeq"] = _beat_seq_of(state)
            await send({"t": "ack", "cid": cid, "d": {
                "canonicalId": canonical, "adopted": adopted,
                "beatSeq": sock["beatSeq"], "live": live,
            }})
            return True

        async def _handle_subscribe(frame: dict) -> None:
            cid = frame.get("cid")
            ch = frame.get("ch")
            d = frame.get("d") or {}
            if sock["canonical"] is None:
                # No subscribe before a successful ack (spec §2.4) — enforced server-side.
                await send({"t": "error", "ch": ch, "cid": cid, "d": {"code": "not-bound"}})
                return
            if not _ws_owns(user, sock["canonical"]):
                await send({"t": "error", "ch": ch, "cid": cid, "d": {"code": "forbidden"}})
                return
            if ch == "chat":
                from_seq = d.get("fromSeq", 0)
                if not isinstance(from_seq, int) or isinstance(from_seq, bool) or from_seq < 0:
                    await send({"t": "error", "ch": ch, "cid": cid, "d": {"code": "bad-cursor"}})
                    return
                _spawn_channel("chat", _run_chat_channel(cid, from_seq))
            elif ch in ("state", "hud"):
                # #1087 idempotent same-socket re-arm: a subscribe for an edge channel that is ALREADY
                # running for the SAME canonical id is a NO-OP (edge subscribes have no success ack, so
                # this is protocol-identical). Respawning would tear the live bridge down and run a fresh
                # `session_events.subscribe()`, which replays the per-session event ring (≤8 events,
                # 180s) back at a window that already consumed it — the server half of the
                # rebind→ring-replay churn loop. The replay durability (ADR 0012 §3.4b) is preserved
                # where it matters: a genuinely new subscriber (fresh window, reconnect after a drop) is
                # a NEW socket with a fresh channel_tasks map, and a canonical CHANGE (adoption /
                # season-reset rebind) respawns to re-point the bridge.
                existing = channel_tasks.get(ch)
                if (existing is not None and not existing.done()
                        and channel_canonicals.get(ch) == sock["canonical"]):
                    return
                channel_canonicals[ch] = sock["canonical"]
                _spawn_channel(ch, _run_state_channel(ch))
            elif ch == "layout":
                # §5 — per-device layout leg: subscribe the session bus and forward `layout-changed`
                # descriptors to THIS tab (the client applies only its own deviceId + drops its origin
                # echo). The sibling `patch_layout(user, deviceId, …)` per-device re-key is now MERGED.
                _spawn_channel("layout", _run_layout_channel(cid))
            else:
                await send({"t": "error", "ch": ch, "cid": cid, "d": {"code": "unknown-channel"}})

        async def _cas_stale_beat(cid: str, expected: Any) -> Optional[dict]:
            """Pre-flight compare-and-swap (§3.5): refuse an up-frame whose ``expectedBeatSeq`` no longer
            matches the engine's current ``beatSeq`` BEFORE any mutation. Returns the fresh state dict
            when the frame may proceed, or None after sending an ``error{stale-beat}``. An engine that
            advertises no ``beatSeq`` yet (pre-0065) simply skips the CAS."""
            state = await _engine_state(user)
            cur = _beat_seq_of(state)
            if cur is not None:
                sock["beatSeq"] = cur
            if (expected is not None and cur is not None
                    and isinstance(expected, int) and not isinstance(expected, bool)
                    and expected != cur):
                await send({"t": "error", "ch": "chat", "cid": cid,
                            "d": {"code": "stale-beat", "beatSeq": cur}})
                return None
            return state

        async def _handle_turn(frame: dict) -> None:
            cid = frame.get("cid")
            d = frame.get("d") or {}
            if sock["canonical"] is None:
                await send({"t": "error", "ch": "chat", "cid": cid, "d": {"code": "not-bound"}})
                return
            if not _ws_owns(user, sock["canonical"]):
                await send({"t": "error", "ch": "chat", "cid": cid, "d": {"code": "forbidden"}})
                return
            if await _cas_stale_beat(cid, d.get("expectedBeatSeq")) is None:
                return  # stale-beat error already sent, no write
            if _turn_stream_factory is None:
                await send({"t": "error", "ch": "chat", "cid": cid, "d": {"code": "turn-relay-unwired"}})
                return
            try:
                producer = _turn_stream_factory(d, sock["canonical"], user)
                # queue-don't-cancel for GAME turns (ADR 0012 / 0064-C) — two windows serialize behind
                # one canonical run; the result fans out as chat ``event`` frames (not inline on cid).
                agent_runs.start(sock["canonical"], producer, queue=True)
                session_events.publish(sock["canonical"], "run-started")
                await send({"t": "ack", "ch": "chat", "cid": cid, "d": {"accepted": True}})
            except Exception as e:
                logger.warning("[ws] turn relay failed: %s", e)
                await send({"t": "error", "ch": "chat", "cid": cid, "d": {"code": "turn-failed"}})

        async def _handle_decision(frame: dict) -> None:
            cid = frame.get("cid")
            d = frame.get("d") or {}
            if sock["canonical"] is None:
                await send({"t": "error", "ch": "chat", "cid": cid, "d": {"code": "not-bound"}})
                return
            if not _ws_owns(user, sock["canonical"]):
                await send({"t": "error", "ch": "chat", "cid": cid, "d": {"code": "forbidden"}})
                return
            from src import orwell_engine
            # CON-4 / F5 / DB1/DB2: import shared helpers from orwell_routes so the WS runs
            # the EXACT same seams the HTTP handler runs (fix #1866).
            from routes.orwell_routes import (
                _post_decision_tail,
                _recent_decision_failure,
                _clear_decision_failure,
                _remember_decision_failure,
            )
            expected = d.get("expectedBeatSeq")
            idem = d.get("idempotencyKey")
            decision = {k: v for k, v in d.items()
                        if k not in ("expectedBeatSeq", "idempotencyKey") and v is not None}
            # C20 confirm-path legality gate (ADR 0003 §4): an unknown/unsanctioned kind is refused
            # BEFORE any engine call — prose can never bind through this surface.
            if decision.get("kind") not in _DECISION_KINDS:
                await send({"t": "error", "ch": "chat", "cid": cid, "d": {"code": "unknown-kind"}})
                return
            # DB1/DB2 (#1025): if this EXACT decision just failed (within the debounce window),
            # replay the cached refusal WITHOUT re-hitting the engine or re-logging.
            _dup = _recent_decision_failure(user, decision)
            if _dup is not None:
                await send({"t": "error", "ch": "chat", "cid": cid,
                            "d": {"code": "debounced", "status": _dup["status"], "error": _dup["error"]}})
                return
            try:
                res = await orwell_engine.submit_decision(
                    decision,
                    expected_beat_seq=expected if isinstance(expected, int) and not isinstance(expected, bool) else None,
                    idempotency_key=idem if isinstance(idem, str) and idem.strip() else None,
                    user=user,
                )
                bs = _beat_seq_of(res if isinstance(res, dict) else {})
                if bs is not None:
                    sock["beatSeq"] = bs
                # ── Shared post-submit tail (fix #1866) — runs the EXACT same seams the HTTP
                # orwell_decision handler runs (F14 post-goodbye advance, pending cache,
                # publish, DB2 clear).
                await _post_decision_tail(decision, res, user, decision.get("kind"), idem)
                await send({"t": "ack", "ch": "chat", "cid": cid, "d": {"accepted": True}})
                # Fan a state edge so every window re-reads the moved board (§4).
                await send({"t": "state", "ch": "state", "d": {"beatSeq": sock["beatSeq"], "reason": "decision"}})
                session_events.publish(sock["canonical"], "game-updated")
            except orwell_engine.EngineToolError as e:
                if _is_stale_beat(e):
                    # CON-4: stale-beat CAS refusal — a concurrent window already moved the
                    # board. Reconcile silently (like the HTTP handler does) and return
                    # current state via a state edge, NOT an error frame.
                    try:
                        from routes.chat_helpers import _handle_stale_beat
                        await _handle_stale_beat(user, e)
                        _cur = await orwell_engine.get_game_state(user=user)
                        orwell_engine.remember_pending(_cur, user=user)
                        session_events.publish(sock["canonical"], "game-updated")
                        _bs = _cur.get("beatSeq") or _beat_seq_of(_cur)
                        if _bs is not None:
                            sock["beatSeq"] = _bs
                        await send({"t": "state", "ch": "state", "d": {"beatSeq": sock["beatSeq"], "reason": "decision-reconciled"}})
                        return
                    except Exception:
                        pass  # reconcile failed — fall through to error frame below
                    await send({"t": "error", "ch": "chat", "cid": cid,
                                "d": {"code": "stale-beat", "beatSeq": getattr(e, "beat_seq", None)}})
                elif getattr(e, "no_game", False):
                    await send({"t": "error", "ch": "chat", "cid": cid, "d": {"code": "no-game"}})
                else:
                    # DB1/DB2: the engine answered with a structured error — debounce an
                    # identical repeat so a buggy client can't storm the log ring.
                    _status = e.status if isinstance(getattr(e, "status", None), int) and e.status else None
                    _remember_decision_failure(user, decision, _status or 502, str(e))
                    await send({"t": "error", "ch": "chat", "cid": cid,
                                "d": {"code": "engine-error", "status": getattr(e, "status", None)}})
            except Exception as e:
                logger.warning("[ws] decision relay failed: %s", e)
                await send({"t": "error", "ch": "chat", "cid": cid, "d": {"code": "decision-failed"}})

        async def _handle_layout(frame: dict) -> None:
            """§5 — a window moved/resized/docked. Persist the change PER DEVICE
            (``patch_layout(user, deviceId, …, origin=…)`` — LWW per field, bounded, geometry clamped)
            and fan the store's CANONICAL descriptor out over the per-session bus so the SAME device's
            OTHER tabs mirror it (a receiver applies only its own ``deviceId`` and drops its own
            ``origin`` echo). Owner-guarded (cross-user isolation). Publishing the CANONICAL descriptor
            — never the raw client values — is the exact bug the HTTP route fixed: ``patch_layout``
            trims/normalizes ``windowId``/``deviceId`` before keying the write, so fanning out the raw
            value would make same-device peers (holding the canonical token) reject their own update.
            A layout up-frame is fire-and-forget (no ``cid``/ack); an unusable payload is ignored."""
            if sock["canonical"] is None or not _ws_owns(user, sock["canonical"]):
                return
            d = frame.get("d") or {}
            window_id = d.get("windowId")
            state = d.get("state")
            device_id = d.get("deviceId") or None
            origin = d.get("origin") or ""
            try:
                from src import orwell_layout
                result = orwell_layout.patch_layout(
                    user, device_id, {"windowId": window_id, "state": state}, origin=origin,
                )
            except Exception:
                logger.debug("[ws] layout patch failed", exc_info=True)
                return
            if not result:
                return  # window id / payload unusable, or a per-device/window bound hit — nothing stored
            descriptor = {
                "windowId": result.get("windowId", window_id),
                "state": result.get("state"),
                "origin": result.get("origin", origin),
                "deviceId": result.get("deviceId", "") or "",
            }
            # Fan out over the socket's canonical session bus: every tab (WS layout channel + fallback
            # SSE) on this session receives it; the client scopes the apply to the originating device
            # and self-suppresses by origin. Publishing the store's CANONICAL descriptor, never raw
            # client values (mirrors the HTTP PATCH /layout fix).
            session_events.publish(sock["canonical"], "layout-changed", descriptor)

        # ── receive loop ──────────────────────────────────────────────────────────────────────────
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    frame = json.loads(raw)
                except Exception:
                    await send({"t": "error", "d": {"code": "bad-frame"}})  # unsolicited, no cid (§1.2)
                    continue
                if not isinstance(frame, dict):
                    await send({"t": "error", "d": {"code": "bad-frame"}})
                    continue
                t = frame.get("t")
                if t in ("hello", "bind"):
                    keep = await _handle_hello(frame)
                    if not keep:
                        break
                elif t == "subscribe":
                    await _handle_subscribe(frame)
                elif t == "turn":
                    await _handle_turn(frame)
                elif t == "decision":
                    await _handle_decision(frame)
                elif t == "layout":
                    await _handle_layout(frame)
                elif t == "ping":
                    await send({"t": "pong"})
                elif t == "pong":
                    pass  # liveness ack — nothing to do
                else:
                    await send({"t": "error", "cid": frame.get("cid"), "d": {"code": "unknown-frame"}})
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.debug("[ws] session loop ended", exc_info=True)
        finally:
            # Tear down the socket's own background tasks. Cancel then AWAIT both the heartbeat AND the
            # channel tasks so each is finalized here rather than left pending — a cancelled-but-
            # unawaited task can survive to a per-test `_run` loop's close and surface as an unraisable
            # "Event loop is closed" (a real fe-unit teardown flake). Awaiting the channel tasks also
            # lets each one's `session_events.subscribe()` `finally` (subscriber discard, ring-evict
            # arm) run IN-LOOP instead of racing the close (greptile P1 on #1338). `cancel()` is
            # guarded because a task can outlive its loop (cross-loop cancel raises RuntimeError), and
            # awaiting a just-cancelled task is instant (every channel/heartbeat coroutine swallows
            # CancelledError and returns), so this never delays a live disconnect.
            #
            # Order is load-bearing: cancel everything, drain the heartbeat, close the socket, THEN
            # finalize the channel tasks. Closing before the channel-drain keeps `websocket.close()`'s
            # observable side effect from being pushed behind an extra scheduling hop.
            with contextlib.suppress(RuntimeError):
                hb_task.cancel()
            for task in channel_tasks.values():
                if not task.done():
                    with contextlib.suppress(RuntimeError):
                        task.cancel()
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError, Exception):
                await hb_task
            try:
                await websocket.close()
            except Exception:
                pass
            channels = list(channel_tasks.values())
            if channels:
                with contextlib.suppress(RuntimeError):
                    await asyncio.gather(*channels, return_exceptions=True)


def setup_ws_routes() -> APIRouter:
    """The WS router — binds the module-level ``ws_session`` handler to ``/api/ws/session``."""
    router = APIRouter()
    router.add_api_websocket_route("/api/ws/session", ws_session)
    return router


# ── payload helpers ────────────────────────────────────────────────────────────────────────────────

def _sse_to_payload(raw: str) -> dict:
    """Parse one ``agent_runs`` SSE event string into the ``event.d`` body (spec §3.2). The bodies are
    the EXISTING ``chat_stream`` event payloads, unchanged — ``{delta, thinking}`` (the reasoning split
    rides INSIDE as the ``thinking`` flag, §3.4), ``{type:"message_saved", …}``, and ``data:[DONE]`` →
    ``{done:true}``. An ``event: error`` line is tagged ``{event:"error", …}``. Vault-free: the same
    bytes the SSE surface carries today."""
    event_name: Optional[str] = None
    data_str: Optional[str] = None
    for line in raw.splitlines():
        if line.startswith("event:"):
            event_name = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data_str = line[len("data:"):].strip()
    if data_str is None:
        return {"raw": raw}
    if data_str == "[DONE]":
        return {"done": True}
    try:
        payload = json.loads(data_str)
    except Exception:
        return {"text": data_str}
    if not isinstance(payload, dict):
        return {"value": payload}
    if event_name == "error":
        payload = {**payload, "event": "error"}
    return payload


def _sse_event_name(raw: str) -> Optional[str]:
    """The ``event:`` name of a ``session_events`` SSE string (``run-started`` / ``message-added`` /
    ``game-updated`` / ``layout-changed`` / ``connected``), or ``"keepalive"`` for the comment line,
    else None."""
    if raw.startswith(":"):
        return "keepalive"
    for line in raw.splitlines():
        if line.startswith("event:"):
            return line[len("event:"):].strip()
    return None


def _sse_event_data(raw: str) -> Optional[dict]:
    """The parsed ``data:`` JSON body of a ``session_events`` SSE string (``session_events._fmt``
    always emits a JSON object), or None if absent/unparseable. Used by the ``layout`` channel to
    recover the canonical layout descriptor a ``layout-changed`` event carries (§5)."""
    for line in raw.splitlines():
        if line.startswith("data:"):
            try:
                payload = json.loads(line[len("data:"):].strip())
            except Exception:
                return None
            return payload if isinstance(payload, dict) else None
    return None


def _is_stale_beat(exc: Any) -> bool:
    """Is ``exc`` the engine's 409 ``stale-beat`` CAS refusal? Prefer the stable machine ``code`` the
    thin client surfaces; fall back to ``chat_helpers._is_stale_beat_error`` (which also handles the
    older message-marker) so the socket and the HTTP decision route agree byte-for-byte."""
    if getattr(exc, "code", None) == "stale-beat":
        return True
    try:
        from routes.chat_helpers import _is_stale_beat_error
        return bool(_is_stale_beat_error(exc))
    except Exception:
        return False
