"""Thin async client for the orwell engine's permissioned MCP HTTP API.

The front-end consumes ONLY what these Vault-free player-channel tools return; it
never reaches the engine's Vault (the Vault Wall is enforced structurally on the
engine side, not here). Endpoint comes from ``ORWELL_ENGINE_MCP_URL``.
"""
import asyncio
import logging
import os
import time

import httpx

from src import engine_read_cache

logger = logging.getLogger(__name__)

# ORWELL_* are primary; BBAI_* are kept as silent deprecated fallbacks so a pre-rename .env
# keeps working.
ENGINE_URL = (
    os.environ.get("ORWELL_ENGINE_MCP_URL")
    or os.environ.get("BBAI_ENGINE_MCP_URL")
    or "http://127.0.0.1:8765"
)
_TIMEOUT = float(
    os.environ.get("ORWELL_ENGINE_TIMEOUT")
    or os.environ.get("BBAI_ENGINE_TIMEOUT")
    or "30"
)
# C18/audit F8: the FRAMING reads (game state + the moment prompt) run on EVERY chat turn —
# a hung engine must fail the frame in seconds (the fallback prompt takes over), never stall
# the player's turn for the full default timeout.
_FRAMING_TIMEOUT = float(os.environ.get("ORWELL_ENGINE_FRAMING_TIMEOUT") or "3")

# The HUD POLLERS (the /state read every panel shares, the cast roster) are NOT chat-blocking, so
# they tolerate a busier engine than the tight frame: a portrait/cast-generation run or a heavy
# commit can briefly push a state read past 3s. Give the pollers a wider-but-still-bounded timeout
# so a transient busy queue logs a blip / serves last-good, instead of 502-ing on every poll.
# (Prod bundle 2026-06-22 showed /state ReadTimeouts at the 3s framing bound during a casting-load
# spike — the /state route was using the framing default instead of a poller bound.)
_POLL_TIMEOUT = float(os.environ.get("ORWELL_ENGINE_POLL_TIMEOUT") or "8")


def _engine_token() -> str | None:
    """The shared secret the engine enforces when ORWELL_ENGINE_TOKEN is set (B67/ops A1).
    Read at call time (not import time) so tests and live env changes take effect."""
    return os.environ.get("ORWELL_ENGINE_TOKEN") or os.environ.get("BBAI_ENGINE_TOKEN") or None


def _engine_admin_token() -> str | None:
    """Audit E27: the SEPARATE admin/God-Mode secret. When the engine has ORWELL_ENGINE_ADMIN_TOKEN
    set, /admin/* refuses the player token — admin calls must present this one. Falls back to the
    shared token when no admin secret is configured (single-token back-compat)."""
    return os.environ.get("ORWELL_ENGINE_ADMIN_TOKEN") or _engine_token()


def _user_headers(user: str | None, admin: bool = False) -> dict:
    # The front-end is the trusted auth tier (0021): it ASSERTS the authenticated user, and the
    # engine routes the call into that user's isolated sandbox.
    #
    # B67/ops A2: an ANONYMOUS caller sends NO user header. Single-tenant engines default the
    # missing header to "default" server-side (behavior unchanged); under ORWELL_ENGINE_MULTIUSER
    # the engine refuses it (400) instead of silently collapsing anonymous sessions into one
    # shared sandbox. The authenticated-user path is untouched.
    headers: dict = {}
    if user:
        headers["X-Orwell-User"] = user
    token = _engine_admin_token() if admin else _engine_token()
    if token:
        # B67/ops A1: the engine enforces this token on every tool route; without sending it the
        # documented auth-on config 401'd every call and bricked the game. Admin calls send the
        # E27 admin secret (the engine refuses the player token on /admin/*).
        headers["Authorization"] = f"Bearer {token}"
    return headers


class EngineToolError(RuntimeError):
    """The engine RESPONDED with a structured error — it is reachable and answered. Distinct from a
    transport outage (connection refused / timeout / proxy 5xx), which propagates as httpx's own
    ``RequestError``/``HTTPStatusError`` so callers can tell "the engine said no" apart from "the
    engine is down". ``no_game`` flags the engine's intentional "no active game for this user" reply
    (the knownUser guard) — a NORMAL pre-game state the caller should treat as ``started: False``.
    ``transient`` flags an EMPTY 200 body (no ``result`` and no structured ``error``) — the engine
    answered oddly mid-restart, so the retry loop SHOULD give it another try (Issue 1)."""

    def __init__(self, message: str, status: int | None = None, transient: bool = False,
                 code: str | None = None, beat_seq: int | None = None, board: dict | None = None):
        super().__init__(message)
        self.status = status
        self.no_game = "no active game" in (message or "").lower()
        self.transient = transient
        # 0065 Part A / audit A-S5: the engine's STRUCTURED error fields, when present. A 409
        # `stale-beat` carries `code:"stale-beat"`, the current `beatSeq`, and the Vault-free `board`
        # (HttpMcpServer.send). Surfacing them lets the stale-beat reconcile key off a stable machine
        # code + numeric beatSeq instead of parsing the human-readable message (no wording-drift risk).
        self.code = code
        self.beat_seq = beat_seq
        self.board = board


# --- last-error tracking: VISIBLE error reporting for "engine up but erroring" -----------------
# Every failed engine call records here; the next successful call clears it. /api/orwell/health
# surfaces it (recency-gated), so the front-end banner can report a TECHNICAL problem (a failing
# tool, a corrupt-save 500) even while the engine process itself is reachable — not only a hard
# outage. Process-local on purpose: it describes THIS front-end's view of the engine right now.
_LAST_ERROR: dict | None = None
_LAST_ERROR_TTL_S = 90.0


def _record_error(tool: str, kind: str, message: str) -> None:
    global _LAST_ERROR
    _LAST_ERROR = {"ts": time.time(), "tool": tool, "kind": kind, "error": message}


def _clear_error() -> None:
    global _LAST_ERROR
    _LAST_ERROR = None


def last_engine_error() -> dict | None:
    """The most recent engine problem if it is RECENT and not superseded by a success.
    ``kind`` is ``"unreachable"`` (transport) or ``"tool-error"`` (the engine answered with an
    error). The pre-game "no active game" refusal is a normal state and is never recorded."""
    e = _LAST_ERROR
    if e and (time.time() - e["ts"]) <= _LAST_ERROR_TTL_S:
        return e
    return None


# --- transient-failure retry + a brief "reconnecting" state (Issue 1) ----------------------------
# The engine is occasionally MOMENTARILY unreachable (a gateway 502/503 while it bounces, a refused
# connection mid-restart, a read timeout). Rather than surface that to the player as a hard outage on
# the first miss, a call retries a couple of times with short backoff. While a call is mid-retry the
# front-end is in a "reconnecting" state — the health banner can render a soft "reconnecting…" line
# instead of a red "engine unavailable", and clears it the moment a call succeeds.
_RETRY_ATTEMPTS = 2          # extra attempts after the first (so up to 3 tries total)
_RETRY_BACKOFF_S = 0.25      # base backoff; doubles each attempt (0.25s, 0.5s)
# Gateway/proxy statuses that mean "the engine is momentarily unreachable behind the proxy", NOT a
# real per-tool error (those carry a structured {"error": ...} body and become an EngineToolError).
_TRANSIENT_STATUSES = frozenset({502, 503, 504})
_RECONNECTING_UNTIL = 0.0    # monotonic deadline; while now < this, a call is mid-retry
_RECONNECTING_FOR_S = 8.0    # how long the soft state lingers after the last retry began


def _mark_reconnecting() -> None:
    global _RECONNECTING_UNTIL
    _RECONNECTING_UNTIL = time.monotonic() + _RECONNECTING_FOR_S


def _clear_reconnecting() -> None:
    global _RECONNECTING_UNTIL
    _RECONNECTING_UNTIL = 0.0


def reconnecting() -> bool:
    """True while the client is retrying a momentarily-unreachable engine — a soft, brief state the
    health banner renders as "reconnecting…" instead of a hard outage. A success clears it."""
    return time.monotonic() < _RECONNECTING_UNTIL


def _is_transient(exc: Exception) -> bool:
    """Whether a failed attempt is worth retrying: a transport-level outage (connection refused, DNS,
    read/connect timeout), a gateway 5xx with no structured engine body, or an EMPTY 200 body. A
    structured EngineToolError is the engine ANSWERING (bad args, no active game) — never retried."""
    if isinstance(exc, EngineToolError):
        return bool(getattr(exc, "transient", False))  # only an empty/odd body retries
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in _TRANSIENT_STATUSES
    # httpx.TransportError covers ConnectError / ConnectTimeout / ReadTimeout / RemoteProtocolError…
    return isinstance(exc, (httpx.TransportError, httpx.TimeoutException))


# C18/audit F8: one shared AsyncClient (connection pooling) instead of a new client per call.
# Rebuilt if the constructor identity changes (tests monkeypatch httpx.AsyncClient) or the
# client was closed.
_client = None
_client_factory = None
_client_loop = None  # weakref to the loop `_client` was built on (N-5)
_other_loop_clients = None  # WeakKeyDictionary: loop -> (factory, client), for loops other than `_client_loop`
import threading as _threading
_other_loop_clients_lock = _threading.RLock()  # re-entrant: guards the primary-claim AND the other-loop cache in one critical section


def _shared_client():
    with _other_loop_clients_lock:
        return _shared_client_locked()


def _shared_client_locked():
    """The engine client for the CURRENT event loop (N-5): an httpx pool is bound to the loop that
    opened its sockets, and the FE runs many ``asyncio.run`` background tasks in worker threads —
    sharing one client across those loops strands keep-alive sockets (CLOSE-WAIT) and stalls the
    main loop's calls. The first loop keeps the module-global ``_client`` (tests rely on it); any
    other loop gets its own client."""
    global _client, _client_factory, _client_loop, _other_loop_clients
    import asyncio
    import weakref
    factory = httpx.AsyncClient
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    # A loop that already holds a LIVE client in the per-loop cache keeps it, whatever happens to the module-global primary
    # (its loop closing, another loop claiming it): the primary is only ever the FIRST loop's client, never a reason to
    # hand a loop a DIFFERENT client than the one it already has (that would split its keep-alive sockets across two pools).
    if loop is not None and _other_loop_clients is not None:
        _hit = _other_loop_clients.get(loop)  # (factory, client): an entry built by a DIFFERENT constructor is stale
        if _hit is not None and _hit[0] is factory and not getattr(_hit[1], "is_closed", False):
            return _hit[1]
    bound = _client_loop() if _client_loop is not None else None
    stale_loop = bound is None or (hasattr(bound, "is_closed") and bound.is_closed())
    if _client is None or _client_factory is not factory or getattr(_client, "is_closed", False) \
            or (_client_loop is not None and stale_loop):
        _client = factory(timeout=_TIMEOUT)
        _client_factory = factory
        _client_loop = weakref.ref(loop) if loop is not None else None
        return _client
    if loop is None or _client_loop is None or bound is loop:
        return _client
    with _other_loop_clients_lock:
        if _other_loop_clients is None:
            _other_loop_clients = weakref.WeakKeyDictionary()
        _e = _other_loop_clients.get(loop)
        c = _e[1] if (_e is not None and _e[0] is factory) else None
        if c is None or getattr(c, "is_closed", False):
            for _l in [l for l in list(_other_loop_clients.keys()) if l.is_closed()]:
                _other_loop_clients.pop(_l, None)  # a dead loop's client is never reusable
            c = factory(timeout=_TIMEOUT)
            _other_loop_clients[loop] = (factory, c)
        return c


async def aclose_loop_client() -> None:
    """Close + drop the engine client bound to the CURRENT running loop (end of a short-lived ``asyncio.run``)."""
    import asyncio
    global _client, _client_loop
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    c = None
    with _other_loop_clients_lock:
        if _other_loop_clients is not None:
            _pe = _other_loop_clients.pop(loop, None)
            c = _pe[1] if _pe is not None else None
    if c is None and _client_loop is not None and _client_loop() is loop and _client is not None:
        c, _client, _client_loop = _client, None, None
    if c is not None and not getattr(c, "is_closed", False):
        try:
            await c.aclose()
        except Exception:  # failsoft-ok: best-effort cleanup
            pass


async def _post_tool_once(path: str, name: str, args: dict | None, user: str | None, timeout: float | None) -> dict:
    """ONE attempt at a tool call. Raises :class:`EngineToolError` for a structured engine answer
    (bad args / no active game), or httpx's own transport/HTTPStatus error for a genuine outage —
    exactly the distinctions :func:`_post_tool`'s retry loop and the framing layer rely on. This is
    the inner attempt; it does NOT record the visible health banner (the caller does, on the FINAL
    outcome) so a recovered transient blip never lingers as a recorded error."""
    url = ENGINE_URL.rstrip("/") + path
    client = _shared_client()
    r = await client.post(url, json={"name": name, "args": args or {}},
                          headers=_user_headers(user, admin=path.startswith("/admin")),
                          timeout=timeout if timeout is not None else _TIMEOUT)
    if r.status_code >= 400:
        err = None
        body = None
        try:
            body = r.json()
            err = body.get("error")
        except Exception:
            err, body = None, None
        if err is not None:
            # audit A-S5: carry the engine's STRUCTURED fields (`code`/`beatSeq`/`board`) through so
            # the stale-beat reconcile keys off a stable machine code, not the message prose. Absent
            # fields ⇒ None ⇒ the existing message-marker fallback still applies (byte-identical).
            body = body if isinstance(body, dict) else {}
            _bseq = body.get("beatSeq")
            exc = EngineToolError(
                err, status=r.status_code,
                code=body.get("code"),
                beat_seq=_bseq if (isinstance(_bseq, int) and not isinstance(_bseq, bool)) else None,
                board=body.get("board") if isinstance(body.get("board"), dict) else None,
            )  # engine answered with a reason
            raise exc
        r.raise_for_status()  # no structured body → a transport/proxy failure (engine down)
    data = r.json()
    if "result" not in data:
        # A structured `error` is the engine ANSWERING (never retried); a body with NEITHER `result`
        # nor `error` is an EMPTY/odd reply (engine answered oddly mid-restart) → flag it transient so
        # the retry loop gives it another go.
        empty = "error" not in data
        raise EngineToolError(str(data.get("error", "engine call failed")), transient=empty)
    return data["result"]


async def _post_tool(path: str, name: str, args: dict | None, user: str | None, timeout: float | None = None) -> dict:
    """POST one tool call to the engine; shared by the player and admin channels.

    Raises :class:`EngineToolError` when the engine answers with a structured ``{"error": ...}`` body
    (it is UP — e.g. bad args, or no active game). A genuine outage (no JSON error body, refused
    connection, timeout, gateway 5xx) propagates as httpx's own exception, so the framing layer can
    fail CLOSED on outages while treating "no active game" as an ordinary pre-game state.

    Issue 1 — RESILIENCE: a TRANSIENT outage (connection refused mid-restart, a gateway 502/503/504,
    a read timeout, an empty body) is RETRIED a couple of times with short backoff before it surfaces;
    while retrying, the client is in a brief "reconnecting" state (see :func:`reconnecting`). A
    structured EngineToolError (incl. the benign "no active game") is the engine answering and is
    NEVER retried. Failures are recorded for the visible health banner only on the FINAL outcome; a
    success clears both the recorded error and the reconnecting state.

    Latency guard (C18): a TIGHT-timeout framing call (the chat-blocking get_game_state /
    get_moment_prompt path, ≤ _FRAMING_TIMEOUT) must fail in seconds — so a *timeout* there is NOT
    retried (it would double an already-bounded wait). Fast-failing blips (refused connection, gateway
    5xx, empty body) still retry cheaply; the pollers (wider timeouts) retry every transient kind."""
    tight = timeout is not None and timeout <= _FRAMING_TIMEOUT
    last_exc: Exception | None = None
    for attempt in range(_RETRY_ATTEMPTS + 1):
        try:
            data = await _post_tool_once(path, name, args, user, timeout)
        except Exception as e:
            last_exc = e
            # A read/connect TIMEOUT on a tight framing call already waited its full budget — don't
            # retry it (the framing layer's fallback prompt takes over fast). Other transient kinds
            # (refused, 5xx, empty body) fail fast and are cheap to retry even on the framing path.
            timed_out = isinstance(e, httpx.TimeoutException)
            retryable = _is_transient(e) and not (tight and timed_out)
            if attempt < _RETRY_ATTEMPTS and retryable:
                # Momentary blip — note the soft reconnecting state and back off briefly before retry.
                _mark_reconnecting()
                await asyncio.sleep(_RETRY_BACKOFF_S * (2 ** attempt))
                continue
            # Out of retries (or a non-transient failure): record the banner error and re-raise.
            if isinstance(e, EngineToolError):
                if not e.no_game:  # the pre-game refusal is a normal state, not a problem
                    _record_error(name, "tool-error", f"{e} (HTTP {e.status})" if e.status else str(e))
                raise
            if isinstance(e, httpx.HTTPStatusError):
                _record_error(name, "unreachable", f"engine returned HTTP {e.response.status_code} with no error detail")
                raise
            _record_error(name, "unreachable", f"{type(e).__name__}: {e}")
            raise
        else:
            _clear_error()
            _clear_reconnecting()  # a success ends any reconnecting state
            return data
    # Unreachable (the loop either returns or raises), but keep the type-checker honest.
    raise last_exc if last_exc else EngineToolError("engine call failed")



# N-17: the engine DISCLOSURE levers. When one of these runs in a turn, a houseguest's first-person disclosure that turn is engine-backed (it came from a recorded decision); a confession
# with NO such call is the narrator inventing a secret. Per-user, cleared at each turn's framing (`clear_disclosure_turn`). Fail-soft bookkeeping only - never gates a call.
_DISCLOSURE_TOOLS = frozenset({"confide", "tradeSecret", "exposeSecret", "askJuror", "surfaceInformationTo"})
_DISCLOSURE_TURN: dict = {}


def _disclosure_key(user) -> str:
    return user or "__anon__"


def disclosure_this_turn(user) -> bool:
    """True if an engine disclosure lever ran for `user` since the last `clear_disclosure_turn`."""
    return bool(_DISCLOSURE_TURN.get(_disclosure_key(user)))


def clear_disclosure_turn(user) -> None:
    _DISCLOSURE_TURN.pop(_disclosure_key(user), None)
    _TELLS_TURN.pop(_disclosure_key(user), None)


# A50: the engine's tells per houseguest NAME, captured from this turn's `npcVoice` results (only when the tells layer is on, i.e. the result carries a `tells` key; [] = calm).
# Per-user, cleared each turn with the disclosure bookkeeping. The faithfulness guard reads it; fail-soft bookkeeping only.
_TELLS_TURN: dict = {}


def tells_this_turn(user) -> dict:
    """{houseguest name -> [tell kinds]} for the NPCs voiced this turn with the tells layer on."""
    return dict(_TELLS_TURN.get(_disclosure_key(user)) or {})


def _note_tells(user, res) -> None:
    try:
        if isinstance(res, dict) and isinstance(res.get("tells"), list):
            name = ((res.get("houseguest") or {}).get("name") or "").strip()
            if name:
                kinds = [str(t.get("kind")) for t in res["tells"] if isinstance(t, dict) and t.get("kind")]
                _TELLS_TURN.setdefault(_disclosure_key(user), {})[name] = kinds
    except Exception:
        pass


# N-17 vs 0092: the engine can surface a secret to the player OFF the tool path (a confidant slip / gossip chain, inside the orchestrator tick), so no disclosure LEVER ran this turn yet the
# line the narrator voices is engine-backed. The engine leaves a Vault-free delivery marker on the state read (`surfacedToPlayer: {n, sourceId}` - a counter and a public id, never content);
# a CHANGE in it since the last turn exempts THIS turn only. Unseen user + a marker present ⇒ treated as new (permissive: a true confession is never dropped for want of a baseline).
_DELIVERY_SEEN: dict = {}


def note_engine_delivery(user, game_state) -> bool:
    """Call once per turn after `clear_disclosure_turn` with the turn's state read. True (and marks the turn as engine-backed) iff the delivery marker moved."""
    try:
        marker = game_state.get("surfacedToPlayer") if isinstance(game_state, dict) else None
        key = _disclosure_key(user)
        if not isinstance(marker, dict) or not isinstance(marker.get("n"), int):
            return False
        seen = _DELIVERY_SEEN.get(key, 0)
        _DELIVERY_SEEN[key] = marker["n"]
        if marker["n"] != seen:
            _DISCLOSURE_TURN[key] = True
            return True
    except Exception:
        pass
    return False


# ORW-167: per-user count of non-read engine calls (landed or failed: a write that timed out may still have been applied). Monotonic within the process; compared before and after a turn.
_MUTATION_COUNT: dict = {}


def mutation_count(user: str | None = None) -> int:
    return _MUTATION_COUNT.get(user or "", 0)


async def _call(name: str, args: dict | None = None, user: str | None = None, timeout: float | None = None) -> dict:
    """G1b: every engine call flows through the I/O tap — what was written and
    what came back (or the failure) — feeding the /admin/status viewer.

    Issue #1870: knowledgeScopeManifest and sealedFromHouse carry the player's Vault manifest
    which includes NPC-only secret content (confides, gossip-diffused beliefs, off-screen
    surfacings). The full response MUST NOT be recorded in the god/God-Mode-readable io ring —
    we strip the payload to timing metadata only (the seal prevents the Vault leak through the
    I/O tap described in R-VLT-5: docs/audits/2026-07-22-full-repo-audit-backlog.md).
    """
    import time as _t
    from src import log_rings as _rings
    t0 = _t.monotonic()
    if name not in engine_read_cache.PURE_READS:
        engine_read_cache.invalidate(user)  # ORW-166: a possible mutation starts - nothing cached for this user may be served or joined
    if name in _DISCLOSURE_TOOLS:
        _DISCLOSURE_TURN[_disclosure_key(user)] = True  # N-17: an engine disclosure was attempted this turn (set before the call so a mid-turn stream sees it)
    try:
        try:
            res = await _call_inner(name, args, user=user, timeout=timeout)
        finally:
            if name not in engine_read_cache.PURE_READS:
                # ...and again once it has landed OR FAILED: a write that timed out client-side may still have been applied by the engine
                engine_read_cache.invalidate(user)
                _MUTATION_COUNT[user or ""] = _MUTATION_COUNT.get(user or "", 0) + 1  # ORW-167: lets the agent loop tell "this turn changed the game" at turn end
        if name in ("sealedFromHouse", "knowledgeScopeManifest"):
            _rings.record_io(name, args, True, int((_t.monotonic() - t0) * 1000),
                             {"_stripped": "io-ring-sealed"}, user=user)
        else:
            _rings.record_io(name, args, True, int((_t.monotonic() - t0) * 1000), res, user=user)
        return res
    except Exception as e:
        if name in ("sealedFromHouse", "knowledgeScopeManifest"):
            _rings.record_io(name, args, False, int((_t.monotonic() - t0) * 1000),
                             {"_stripped": "io-ring-sealed"}, user=user)
        else:
            _rings.record_io(name, args, False, int((_t.monotonic() - t0) * 1000),
                             f"{type(e).__name__}: {e}", user=user)
        raise


async def _call_inner(name: str, args: dict | None = None, user: str | None = None, timeout: float | None = None) -> dict:
    """Invoke a player-channel tool over the engine's HTTP MCP transport, for `user`'s sandbox.
    `timeout` overrides the default for latency-sensitive FRAMING calls (C18: a hung engine must
    fail a turn's framing in ~2s, not stall it for the full default)."""
    return await _post_tool("/player/call", name, args, user, timeout=timeout)


async def update_casting(fields: dict | None = None, user: str | None = None) -> dict:
    """Record casting-interview answers as they land (0050) — any subset of fields, any number
    of times pre-game (interviewNotes accumulate). Returns the engine's casting status:
    { known, missing, next, ready } — the ENGINE picks the interview's next step. A call after
    the season starts records nothing and reports done."""
    allowed = {"playerName", "archetype", "strategyStyle", "personaArchetype",
               "personaStrategyStyle", "backstory", "motivation", "privateStrategy",
               "interviewNotes",
               # #1326: the player's optional pronoun/presentation answer — the engine's intake
               # normalizes synonyms (pronouns/gender/…) and validates the value; dropping it
               # here silently severed the schema-advertised field from the engine (PR #1346).
               "genderPresentation",
               # The cast photo is the FIRST casting step (optional/skippable): the FE records
               # how it was handled — "uploaded" (photo finalized) or "skipped". A plain string
               # scalar, so the generic `elif str(value).strip()` branch below carries it through.
               "castPhoto"}
    args: dict = {}
    for key, value in (fields or {}).items():
        if key not in allowed or value is None:
            continue
        if key == "interviewNotes":
            notes = [value] if isinstance(value, str) else list(value)
            notes = [str(n) for n in notes if str(n).strip()]
            if notes:
                args[key] = notes
        elif str(value).strip():
            args[key] = str(value)
    return await _call("updateCasting", args, user=user)


# --- G8: createCharacter-in-flight marker -------------------------------------------------------
# createCharacter is the engine's heaviest call (sandbox mint + 16-cast generation + soul seeding
# through the synchronous embedding bridge, ADR 0004). While it runs, a /health probe can stall or
# time out — which is NOT an outage, just casting being finalized. This module-level marker lets
# /api/orwell/health say so (`busy: "creating"`), and the engine-status banner shows an in-fiction
# holding line instead of the false red "engine unavailable". Process-local on purpose (like
# _LAST_ERROR): it describes THIS front-end's in-flight work.
_CREATING_IN_FLIGHT = 0


def creating_in_flight() -> bool:
    """True while a createCharacter call from this front-end is in flight (G8)."""
    return _CREATING_IN_FLIGHT > 0


async def create_character(player_name: str | None = None, *, archetype=None, strategy_style=None,
                           seed=None, confirm_restart: bool = False, keep_character: bool = False,
                           user: str | None = None,
                           persona_archetype=None, persona_strategy_style=None,
                           backstory=None, motivation=None, private_strategy=None,
                           interview_notes=None, gender_presentation=None) -> dict:
    """Finalize the casting interview (0050) and start a new game in this user's sandbox.
    Returns the Vault-free game state (with the player's casting card).

    The engine finalizes FROM everything `update_casting` recorded; arguments here fill gaps
    or override field-by-field — so `player_name` is optional when the interview already
    recorded one (the engine rejects creation when no name exists anywhere). Over a STARTED
    game the engine no-ops unless `confirm_restart` is set (B36 guard); the /new-game route
    additionally 409s so the UI gets an honest signal instead of a silent no-op.
    """
    args: dict = {}
    if player_name and str(player_name).strip():
        args["playerName"] = str(player_name).strip()
    if archetype:
        args["archetype"] = archetype
    if strategy_style:
        args["strategyStyle"] = strategy_style
    if persona_archetype:
        args["personaArchetype"] = persona_archetype
    if persona_strategy_style:
        args["personaStrategyStyle"] = persona_strategy_style
    if backstory:
        args["backstory"] = backstory
    if motivation:
        args["motivation"] = motivation
    if private_strategy:
        args["privateStrategy"] = private_strategy
    if gender_presentation and str(gender_presentation).strip():
        # #1326: optional by design — forwarded only when the player actually answered; the
        # engine validates/normalizes the value (never force-filled).
        args["genderPresentation"] = str(gender_presentation).strip()
    if interview_notes:
        if isinstance(interview_notes, str):  # a lone note arrives as a bare string sometimes
            interview_notes = [interview_notes]
        args["interviewNotes"] = [str(n) for n in interview_notes if str(n).strip()]
    if seed is not None:
        args["seed"] = seed
    if confirm_restart:
        args["confirmRestart"] = True
    if keep_character:
        # 0056: on a confirmed restart, carry the prior player's CHARACTER into the new season
        # (the engine re-supplies their authored fields; the same houseguest returns to a new cast).
        args["keepCharacter"] = True
    global _CREATING_IN_FLIGHT
    _CREATING_IN_FLIGHT += 1  # G8: /health reports busy="creating" while this runs
    try:
        res = await _call("createCharacter", args, user=user)
    finally:
        _CREATING_IN_FLIGHT -= 1
    # Only a season the engine actually CREATED is a reset — a refusal (`createRefused`: in-progress,
    # casting-incomplete, …) leaves the live season untouched, so its per-season caches must survive.
    # Same success test as agent_loop's finalize check (started AND not refused).
    if isinstance(res, dict) and res.get("started") and not res.get("createRefused"):
        _notify_season_reset(user)
    return res


# ── the pending-decision kinds the FE relays to submitDecision (ONE source of truth) ──────────────
# Mirrors the engine's `PendingDecisionView["kind"]` union (src/ports/GameSession.ts) EXACTLY. Every FE
# seam that validates a decision kind (the REST relay, the WS relay, the model's submitDecision tool +
# its schema enum) reads THIS set — three hand-copied lists drifted apart before (deal-offer and
# secret-veto were rejected everywhere ⇒ the game froze on an answer it could not accept).
# `tests/test_decision_kinds_master.py` pins it to the engine union so it can never drift again.
DECISION_KINDS: frozenset = frozenset({
    "nominations", "veto-decision", "comp-intent", "comp-round", "houseguests-choice",
    "replacement", "eviction-vote", "tie-break", "final-eviction",
    "goodbye-message", "finale-statement", "finale-answer",
    "juror-question", "juror-vote",
    # 0130 — the player-evictee's own exit interview (posture + optional words).
    "exit-interview",
    # 0133 — an early-evicted player's spectator choice (watch | skip) and finale-night interview.
    "spectator-choice", "finale-interview",
    # 0061 — the sanctioned confirmed self-eviction.
    "self-evict",
    # 0025 — the reactive-twist secret veto (the holder's private use/pass).
    "secret-veto",
    # 0123 — the player's in-chat answer to a houseguest's deal offer (vote: accept | decline).
    "deal-offer",
})

# PO RULING 2026-11-03 (Ryne): big irreversible choices must be confirmed on the decision CARD — prose never
# binds them, even a clearly-worded line. The model's `submitDecision` tool may therefore submit ONLY these
# low-stakes / in-chat kinds (an allow-list, so a NEW decision kind is card-only by default — fail closed):
#   comp-intent / comp-round — the player's competition approach (the engine owns the outcome);
#   deal-offer               — the in-chat accept/decline of an NPC's open offer (a light social choice).
# Every other kind (nominations, veto-decision, secret-veto, eviction-vote, tie-break, final-eviction,
# goodbye-message, finale-*, juror-*, exit-interview, replacement, houseguests-choice, self-evict) is bound
# ONLY by the player's own confirm on its card (POST /api/orwell/decision or the WS relay — unchanged).
# `tests/test_a6_model_submit_gate.py` pins this set and its parity with the card's HIGH_STAKES_KINDS.
MODEL_SUBMITTABLE_KINDS: frozenset = frozenset({"comp-intent", "comp-round", "deal-offer"})
CARD_ONLY_KINDS: frozenset = DECISION_KINDS - MODEL_SUBMITTABLE_KINDS


# ── season-reset listeners ──────────────────────────────────────────────────────────────────────
# Every season start (first game, confirmed restart, next season) goes through createCharacter, and
# a God-Mode sandbox reset wipes the season too. FE modules that keep PER-SEASON state keyed only by
# user (e.g. the knowledge wall's last-good sealed manifest) register a clearer here, so a previous
# season's state can never bleed into the next one. Listeners are fail-soft and never raise.
_SEASON_RESET_LISTENERS: list = []


def on_season_reset(fn) -> None:
    """Register ``fn(user)`` to run after a season is created or reset for ``user``."""
    if fn not in _SEASON_RESET_LISTENERS:
        _SEASON_RESET_LISTENERS.append(fn)


def _notify_season_reset(user: str | None) -> None:
    for fn in list(_SEASON_RESET_LISTENERS):
        try:
            fn(user)
        except Exception:
            # Fail-soft (a listener must never break createCharacter), but never silent.
            logger.warning("[orwell] season-reset listener %r failed for user=%s", fn, user, exc_info=True)


async def pre_seed_cast(seed: int | None = None, user: str | None = None) -> dict:
    """Feature 0065: pre-warm the player-INDEPENDENT cast off the season seed BEFORE the casting
    interview ends, so the FE can deeply author it (``record_cast_profile``) and the portrait prompts
    read the FINISHED store. Returns ``{ warmed, seed, house, portraitPrompts, alreadyWarmed?, refused? }``
    — the Vault-free roster + cast portrait prompts. Mints + persists the season seed (which
    ``createCharacter`` then adopts). Idempotent; a no-op refusal once a season is running."""
    args: dict = {}
    if seed is not None:
        args["seed"] = seed
    return await _call("preSeedCast", args, user=user)


async def pre_seed_next_season(seed: int | None = None, profile: dict | None = None,
                               user: str | None = None) -> dict:
    """Feature 0065 (advance-warm): pre-warm the NEXT season's cast DURING the current season's finale,
    off a NEW seed, into a per-user HOLDING STORE that survives the cutover rotation. Unlike
    ``pre_seed_cast`` (which is REFUSED while a season runs), this generates the next cast WITHOUT
    touching the active season; the confirmed next-season cutover ADOPTS it. Optionally deep-authors ONE
    held houseguest (``profile`` = the same shape ``record_cast_profile`` takes) — the write-back lands on
    the HOLDING store, never the live cast. Returns ``{ warmed, seed, house, portraitPrompts, authored?,
    alreadyWarmed?, refused? }`` — the Vault-free roster + cast portrait prompts. Idempotent; durable."""
    args: dict = {}
    if seed is not None:
        args["seed"] = seed
    if profile is not None:
        args["profile"] = profile
    return await _call("preSeedNextSeason", args, user=user)


async def record_cast_profile(profile: dict, user: str | None = None) -> dict:
    """Feature 0058 / L28b: write an LLM-AUTHORED houseguest profile BACK to the engine, which
    becomes the airtight source of truth. ``profile`` carries ``houseguestId`` plus any of the
    PUBLIC fields (``biography``, ``vocation``, ``physicalCharacteristics``, ``voice`` — the 0084
    idiolect fingerprint, folded whole-or-nothing) and HIDDEN fields
    (``secrets``, ``trueGoals``, ``weakness``, ``dayOnePerception``). The engine validates
    (non-player-mirroring), keeps ``vocation`` in lockstep with the biography and re-grounds the
    hidden stakes off it (#849), splits across the Vault Wall, re-derives threads, and re-seals —
    returning field NAMES only (never a hidden value). Vault-free response by construction."""
    return await _call("recordCastProfile", profile, user=user)


async def record_cast_identity(facets: dict, user: str | None = None) -> dict:
    """Issue #544 (the AI half of the 0063 diversity floor): write the LLM-PROPOSED whole-cast
    DESCRIPTIVE identity facets BACK to the engine. ``facets`` is ``{ <houseguestId>: { ethnicity?,
    genderPresentation?, orientation?, out?, age? } }`` — descriptive identity ONLY, never a hidden
    game weight. The engine validates + REPAIRS the proposal against the U.S.-population proportional
    targets (so a lazy/biased/monochrome proposal can never skew the cast), re-grounds skin tone from
    the final heritage, folds the PUBLIC facets onto the byte-stable cast, and re-seals each PRIVATE
    orientation into the Vault. Returns ``{ accepted, applied, reason? }`` — counts only, Vault-free.
    Lands on the pre-warmed cast pre-game (or the live house). Idempotent; with no proposal the
    deterministic floor stands."""
    return await _call("recordCastIdentity", {"facets": facets}, user=user)


async def record_cast_genesis(proposal: dict, user: str | None = None) -> dict:
    """Feature 0116 (phase 2): write the LLM-PROPOSED whole-cast SKELETON BACK to the engine, which
    validates it against the envelope it owns and commits it onto the pre-warmed cast. ``proposal`` is
    ``{ "npcs": [ { id?, name?, identity?, archetype?, vocation?, hometown?, demeanor?, background?,
    biography?, presentation?, appearance?, age?, stats?, hiddenElements? } ], "ties"?: [ { a, b, nature?,
    backstory? } ] }`` — descriptive identity + BANDED stats + the pre-show tie graph, NEVER a hidden game
    weight. The ENGINE clamps every stat total into its band (no model number escapes), enforces the
    cast-wide variance floor, validates names (uniqueness / plausibility / the legacy deny-list /
    player-collision), closes the hidden-element kinds + C9-gates them, sanity-checks the tie graph, strips
    any hidden weight, folds the committed skeleton onto the byte-stable warmed cast, and seals the hidden
    half into the Vault. Returns ``{ accepted, committed, violations, varianceOk, reason? }`` — structured
    Vault-free violations only, never a hidden value. A PRE-GAME operation (``preSeedCast`` must have run;
    refused once a season is running). Idempotent; with no proposal the deterministic floor stands."""
    return await _call("recordCastGenesis", proposal, user=user)


async def record_world_snapshot(snapshot: dict, user: str | None = None) -> dict:
    """Feature 0062: write a REAL captured move-in zeitgeist BACK to the engine, which persists it
    as the single FROZEN artifact and RECALLS it (never re-searches) all season. ``snapshot`` carries
    an optional ``capturedFor`` / ``capturedAt`` plus any subset of the PUBLIC ``slices``
    (``screen``, ``music``, ``sports``, ``news``, ``internet``, ``mood``) — the shared real-world
    flavor the whole cast moved in WITH. The FE owns the concrete web-search capture (like the 0051
    image port); empty slices keep the fallback's value (non-degradation). Returns
    ``{ accepted, source }``. Public flavor only — no Vault, no game input."""
    return await _call("recordWorldSnapshot", snapshot, user=user)


async def world_snapshot_view(user: str | None = None) -> dict | None:
    """Feature 0062 (BE-103 close-out, the G5 gap): read the Vault-free projection of the FROZEN
    move-in zeitgeist ``record_world_snapshot`` captured — ``{ capturedFor, source, slices,
    offscreenPrompt }``. ``offscreenPrompt`` is the engine's already-rendered, already-Vault-free
    off-screen-channel block, consumed by ``orwell_offscreen_texture`` so NPC-to-NPC scenes are
    colored by the SAME shared world the player's own moments are (spec §5). Returns ``None`` pre-game
    or when no snapshot was ever captured (the §8 fail-soft skip) — public flavor only, never a game
    input (§6)."""
    result = await _call("worldSnapshotView", {}, user=user)
    return result if isinstance(result, dict) else None


async def record_producer_profile(overlay: dict, user: str | None = None) -> dict:
    """Issue #1626 (increment 3): write an LLM-AUTHORED, richer OFF-CAMERA PRODUCER persona BACK to the
    engine, which folds it onto the seeded producer as the source of truth. ``overlay`` carries any
    subset of the OPEN-SET public-voice fields — ``archetype`` (core temperament / register),
    ``demeanor``, ``disposition``, ``wit``, ``quirk``, ``backstory`` — all optional prose strings. The
    engine validates (open-set voice PROSE only; strips any stat/soul/number vocabulary), ACCUMULATES
    onto the seeded floor (a field the model omits keeps its seeded value; a later authoring never
    loses a facet), and NEVER changes the seeded NAME — the byline stays byte-stable, so a ``name`` in
    the payload is ignored. Returns ``{ accepted, fields, reason? }`` — the accepted field NAMES only,
    Vault-free by construction. Mirror of the 0058 ``record_cast_profile`` handshake, scaled to the
    single producer."""
    return await _call("recordProducerProfile", overlay, user=user)


async def get_offscreen_scene_skeletons(user: str | None = None) -> list:
    """Feature 0070: read the Vault-free SKELETONS of off-screen scenes recorded this tick — public
    participant ids + nature + the current template/voiced prose only (no hidden attributes, no
    relationship numbers). The FE driver (``orwell_offscreen_texture``) voices each and writes prose
    back via :func:`record_offscreen_scene_texture`. Returns ``[]`` on any non-list reply."""
    result = await _call("getOffscreenSceneSkeletons", {}, user=user)
    return result if isinstance(result, list) else []


async def record_offscreen_scene_texture(event_id: str, content: str, user: str | None = None) -> dict:
    """Feature 0070: write model-voiced prose BACK onto an already-recorded, already-HIDDEN off-screen
    event (the FE-driven write-back keeps the ENGINE the source of truth). CONTENT ONLY — the engine
    refuses any field that would pierce the closed set (witness set, hidden flag, relationship
    numbers). Returns ``{ ok: bool }``."""
    return await _call("recordOffscreenSceneTexture",
                       {"eventId": event_id, "content": content}, user=user)


async def competition_staging_view(user: str | None = None) -> dict | None:
    """Feature #1400 READ: the Vault-free 'what to hand the model' projection for the currently-staging
    competition — ``{comp, type, week, format, participants, winner, dropOrder, library}``. The engine
    hands the ALREADY-FIXED winner + drop order (the model dresses a decided result, it can never touch
    it), so the FE can author a theme + per-round fiction MATCHED to it. ``None`` unless generative
    competitions are enabled on the engine AND a comp has resolved its roll. Vault-free (names + the
    public drop ORDER, never a score/number)."""
    result = await _call("competitionStagingView", {}, user=user)
    return result if isinstance(result, dict) else None


async def record_competition_fiction(fiction: dict, user: str | None = None) -> dict:
    """Feature #1400 WRITE-BACK: write the model-authored competition fiction BACK to the engine. The
    engine VALIDATES (hard) that every elimination in ``fiction['eliminations']`` maps to the fixed drop
    order EXACTLY; on any mismatch it is REJECTED and the deterministic 0042 library floor stands (the
    model can never rename who goes or in what order). ``fiction`` carries ``{comp, week, theme, premise,
    winReads?, eliminations: [{id, fiction}]}``. Presentation-only — never perturbs a seeded roll.
    Returns ``{ accepted: bool, reason?: str }``."""
    return await _call("recordCompetitionFiction", fiction, user=user)


async def get_game_state(user: str | None = None, timeout: float | None = None) -> dict:
    """Current Vault-free game state for this user: phase, the player's card, the house roster.

    The engine refuses a no-game user with a 404 "no active game" (it won't mint a sandbox just to
    answer a probe). That is NOT an outage — it is the ordinary pre-game state, so map it to
    ``{"started": False}``. A genuine engine outage still raises, so callers fail closed only then."""
    try:
        return await _call("getGameState", {}, user=user, timeout=timeout if timeout is not None else _FRAMING_TIMEOUT)
    except EngineToolError as e:
        if e.no_game:
            return {"started": False}
        raise


async def get_moment_prompt(moment: str | None = None, user: str | None = None, timeout: float | None = None,
                            brief: dict | None = None) -> dict:
    """The managed system prompt to inject for this user's current (or given) moment.

    ``brief`` (Showrunner memory, ORWELL_SHOW_BRIEF): when given, the engine also returns ``showBrief`` — the
    terminal Show Brief for this turn. Omitted (the default) ⇒ the call and its response are byte-identical."""
    args: dict = {}
    if moment:
        args["moment"] = moment
    if brief is not None:
        args["brief"] = brief
    return await _call("getMomentPrompt", args, user=user, timeout=timeout if timeout is not None else _FRAMING_TIMEOUT)


async def recall_scene_memories(with_ids: list | None = None, cue: str | None = None,
                                user: str | None = None, timeout: float | None = None) -> dict:
    """Feature #1394 — the Vault-free WITNESSED past moments involving the houseguest(s) the player is
    in a scene with ({with_ids}), ranked against the scene cue ({cue}), for the narrator to reference
    ('you told me on day 3 you'd never write my name down'). The engine reads ONLY the player's visible
    projection — witnessed/journal-visible events, NEVER the Vault. Returns { moments: [...] } — [] when
    there is no relevant history (recall absence is not a failure). Framing-timeout by default, like
    get_moment_prompt (it rides the same per-turn framing budget)."""
    args: dict = {}
    if with_ids:
        args["withIds"] = list(with_ids)
    if cue:
        args["cue"] = cue
    return await _call("recallSceneMemories", args, user=user,
                       timeout=timeout if timeout is not None else _FRAMING_TIMEOUT)


async def run_competition(comp_type: str | None = None, participant_ids: list | None = None, user: str | None = None) -> dict:
    """Ask the engine to resolve a competition over this user's LIVE house. Engine-owned
    stats decide it; we receive only the winner (name) — no stats/scores."""
    args: dict = {}
    if comp_type:
        args["type"] = comp_type
    if participant_ids:
        args["participantIds"] = participant_ids
    return await _call("runCompetition", args, user=user)


async def record_interaction(content: str, with_ids: list | None = None, initiator: str = "player", kind: str | None = None, consequence: dict | None = None, expected_beat_seq: int | None = None, idempotency_key: str | None = None, felt_minutes: int | None = None, assurance: dict | None = None, heard_about_me: dict | None = None, user: str | None = None) -> dict:
    """Record a player-present scene as an engine event (player-witnessed → the player's
    knowledge, never the Vault). An optional `kind` folds the hidden relationship impact (0023);
    an optional Vault-free `consequence` descriptor (ADR 0005) lets the caller PROPOSE which
    houseguests' feelings move, in which direction, with what relative emphasis — the engine still
    owns the magnitude. With neither supplied the request is byte-identical to the kind-only path.

    0065 Part A — an optional `expected_beat_seq` compare-and-swap token is threaded in ONLY when
    provided; if it no longer matches the engine's committed beatSeq the call is refused (409
    `stale-beat`). Absent ⇒ the request is identical to today (the FE owns the per-turn capture/
    attach of the token — sequenced after this engine slice).

    A10 / #591 / R1c — an optional `idempotency_key` (0065 Part B, extended to this port) is threaded
    in ONLY when provided. A fold-bearing scene the FE re-drives after a stale-409 (the #591 retry + the
    CON-11 deferred-fold queue) reuses the SAME key across every attempt, so the engine applies the fold
    AT-MOST-ONCE: under sustained two-window concurrency two turns can drain the same deferred fold and
    re-drive it, and the key is what stops that from double-folding the hidden layer (CAS alone can't —
    both re-drives carry a valid reconciled token). Absent ⇒ byte-identical to the pre-key path."""
    witness = [initiator] + [w for w in (with_ids or []) if w != initiator]
    if "player" not in witness:
        witness.append("player")
    req: dict = {"initiator": initiator, "witnessSet": witness, "content": content}
    if kind:
        req["kind"] = kind
    if consequence:
        req["consequence"] = consequence
    if expected_beat_seq is not None:
        req["expectedBeatSeq"] = expected_beat_seq
    if idempotency_key is not None:
        req["idempotencyKey"] = idempotency_key
    # Phase 2 (duration-based clock): the LLM's proposal for how long this scene FELT, in in-game minutes.
    # The engine clamps it and advances the day clock by that bounded duration (pacing-only; clock-gated).
    # Guard finite + bounded (mirrors the auto-record belt): a NON-FINITE proposal (`float('inf')`/nan,
    # which `json.loads` yields from `1e309`) or an absurd magnitude must fall back to "no duration" —
    # forwarding `inf` would crash the engine JSON encode / clamp, silently dropping the scene fold.
    if isinstance(felt_minutes, (int, float)) and not isinstance(felt_minutes, bool) and 0 < felt_minutes < 1_000_000:
        req["feltMinutes"] = felt_minutes
    # B4 slice 6: a casual assurance the scene carried ({kind: safe|vote|loyal, from?: npc id}). Threaded ONLY when well-formed; the engine ignores it unless ORWELL_ASSURANCES is on
    # (so absent / flag off => byte-identical). Never a number: the engine owns the sincerity.
    if isinstance(assurance, dict) and assurance.get("kind") in ("safe", "vote", "loyal"):
        req["assurance"] = {k: v for k, v in assurance.items() if k in ("kind", "from")}
    # B24 (ORWELL_HEARD_ABOUT_ME): an NPC in the scene TOLD the others something about the player ({nature: targeting|betrayal, from: the teller npc id}). Closed nature only, forwarded ONLY when
    # well-formed; the engine owns how far each listener believes it and ignores it unless the flag is on (absent / flag off => byte-identical). Never free text, never a number.
    if isinstance(heard_about_me, dict) and heard_about_me.get("nature") in ("targeting", "betrayal"):
        req["heardAboutMe"] = {k: v for k, v in heard_about_me.items() if k in ("nature", "from")}
    return await _call("recordInteraction", req, user=user)


async def surface_information(information: str, pathway: str, expected_beat_seq: int | None = None, user: str | None = None) -> dict:
    """Surface a fact into this user's player knowledge via a named in-game pathway
    (e.g. "overheard", "told-by:npc:2"). 0065 Part A — an optional `expected_beat_seq` CAS token is
    threaded in only when provided (absent ⇒ identical request to today)."""
    req: dict = {"entity": "player", "fact": {"content": information}, "pathway": pathway}
    if expected_beat_seq is not None:
        req["expectedBeatSeq"] = expected_beat_seq
    return await _call("surfaceInformationTo", req, user=user)


async def game_status(user: str | None = None) -> dict:
    """Vault-free public ceremony status for the status panel: week/phase/HOH/nominees/veto.

    `veto` carries `{holder, used, players}` — `players` is the drawn six (E35: who plays the
    Power of Veto this week), empty before the chip draw runs, so a narrator names the real field
    instead of inventing who competes.
    """
    return await _call("gameStatus", {}, user=user)


async def get_game_state_polled(user: str | None = None, timeout: float | None = None) -> dict:
    """ORW-166: :func:`get_game_state` for the HUD POLLERS only - a <=400 ms-old, single-flight, per-user, mutation-invalidated copy
    (``engine_read_cache``). The chat framing path keeps calling :func:`get_game_state` directly, so the narrator reads state exactly as fresh as its own turn."""
    return await engine_read_cache.read("getGameState", user, lambda: get_game_state(user=user, timeout=timeout))


async def game_status_polled(user: str | None = None) -> dict:
    """ORW-166: :func:`game_status` for the HUD pollers (same cache contract as :func:`get_game_state_polled`)."""
    return await engine_read_cache.read("gameStatus", user, lambda: game_status(user=user))


async def state_delta(since_beat_seq: int | None = None, user: str | None = None) -> dict:
    """0065 Part E — the beatSeq-keyed DELTA: what changed since the caller's last-seen `beatSeq`.

    Returns ``{ beatSeq, events:[{id,ts,type,content}], changes?:{field:{from,to}}, finishedChanged?,
    winner?, board, fullRefresh }`` — Vault-free by construction (the same closed-set ceremony fields
    the full projection already exposes). ``fullRefresh`` is true when the engine cannot compute an
    incremental delta (no/odd `sinceBeatSeq`, a restart) — the FE then leaves the full context alone.
    The model never sees the token; the FE holds the last-seen `beatSeq` and passes it here."""
    args: dict = {}
    if since_beat_seq is not None:
        args["sinceBeatSeq"] = since_beat_seq
    return await _call("stateDelta", args, user=user)


async def get_visible_state(user: str | None = None) -> dict:
    """The player's own visible projection: witnessed events + things they know for certain."""
    return await _call("getVisibleStateFor", {}, user=user)


async def render_scene(mode: str | None = None, user: str | None = None) -> dict:
    """Ask the engine to narrate the current moment from the VISIBLE projection only
    (`mode="dialogue"` for NPC dialogue, otherwise scene narration). Vault-free."""
    args: dict = {}
    if mode:
        args["mode"] = mode
    return await _call("renderScene", args, user=user)


async def social_read(target: str | None = None, user: str | None = None) -> dict:
    """An honest, Vault-free read of the room (or a single houseguest by id). May hint at
    tension the player could plausibly perceive; never names off-screen events."""
    args: dict = {}
    if target:
        args["target"] = target
    return await _call("socialRead", args, user=user)


async def ask_producers(question: str, user: str | None = None) -> dict:
    """Player-level interrogation of the producers. Answers from visible state only — never
    confirms or denies Vault content (the Vault Wall holds even here)."""
    return await _call("askProducers", {"question": question}, user=user)


async def end_of_session_summary(user: str | None = None) -> dict:
    """Confirm only that an updated save exists for this user (no Vault content)."""
    return await _call("endOfSessionSummary", {}, user=user)


async def advance_game(expected_beat_seq: int | None = None, idempotency_key: str | None = None, user: str | None = None) -> dict:
    """Advance the weekly loop by one beat (HOH→noms→veto→ceremony→eviction→finale).
    NPC beats resolve automatically; returns the beat event, any pending player decision,
    and the public status. Vault-free.

    0065 — both optional sync-spine fields are threaded in ONLY when provided: `expected_beat_seq`
    (Part A compare-and-swap; a stale token ⇒ 409 `stale-beat`) and `idempotency_key` (Part B
    at-most-once; a replayed key returns the original AdvanceView without advancing again). Absent ⇒
    the request is byte-identical to today (the FE owns per-turn token capture + key minting — that
    wiring is sequenced after this engine slice)."""
    args: dict = {}
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    if idempotency_key is not None:
        args["idempotencyKey"] = idempotency_key
    return await _call("advanceGame", args, user=user)


async def submit_decision(decision: dict, expected_beat_seq: int | None = None, idempotency_key: str | None = None, user: str | None = None) -> dict:
    """Resolve the player's pending decision (nominations / use veto / replacement /
    eviction vote) and continue the loop. `decision` is the validated payload.
    For a confirmed self-eviction (0061), `decision` is {"kind": "self-evict", "confirmed": True}.

    0065 — `expected_beat_seq` (Part A CAS) and `idempotency_key` (Part B at-most-once) are merged
    into the decision payload ONLY when provided; absent ⇒ identical to today."""
    payload = dict(decision or {})
    if expected_beat_seq is not None:
        payload["expectedBeatSeq"] = expected_beat_seq
    if idempotency_key is not None:
        payload["idempotencyKey"] = idempotency_key
    return await _call("submitDecision", payload, user=user)


async def request_self_eviction(user: str | None = None) -> dict:
    """Self-eviction step 1 (0061): the player expressed an OOC intent to LEAVE/quit — raise the
    confirmation (names the irreversible stakes) and change NO state. The house never hears it; nothing
    evicts until the player explicitly confirms via submit_decision({"kind":"self-evict","confirmed":True})."""
    return await _call("requestSelfEviction", {}, user=user)


async def raise_spectator_choice(user: str | None = None) -> dict:
    """E-1 (2026-11-04): a WATCHING pre-jury evictee asks to switch to SKIP — re-raise the spectator-choice CARD so they confirm on it (card-only binding intact; skip is
    irreversible: a typed engine refusal in skip mode / with nothing to raise)."""
    return await _call("raiseSpectatorChoice", {}, user=user)


async def cancel_self_eviction(user: str | None = None) -> dict:
    """Self-eviction cancel (0061): the player decided to stay — clear the confirmation; they remain
    ACTIVE and in the house, unchanged."""
    return await _call("cancelSelfEviction", {}, user=user)


async def turn_in(expected_beat_seq: int | None = None, idempotency_key: str | None = None, user: str | None = None) -> dict:
    """ADR 0006 — the player's bedtime lever: the player CHOOSES to turn in for the night. The ENGINE
    ends their night (folding the hidden, bounded rest penalty — never a number crosses the wall),
    rolls the house to the next morning, and returns an AdvanceView that MAY carry a Vault-free
    ``dailyRecap`` (0102) for the day that just closed. A no-op AdvanceView when the in-game clock
    isn't running, the game is over, or the player has left.

    0065 — a mutating PROGRESSION, so it threads the SAME optional sync-spine fields as ``advance_game``:
    ``expected_beat_seq`` (Part A CAS; a stale token ⇒ 409 ``stale-beat``, refused before any mutation)
    and ``idempotency_key`` (Part B at-most-once; a replayed key returns the original view WITHOUT
    re-ending the night — so a retried/duplicate model call can't re-stamp the rest penalty). Both are
    merged in ONLY when provided; absent ⇒ byte-identical to the pre-0065 call (the engine ignores any)."""
    args: dict = {}
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    if idempotency_key is not None:
        args["idempotencyKey"] = idempotency_key
    return await _call("turnIn", args, user=user)


async def hang_out(expected_beat_seq: int | None = None, max_beats: int | None = None, user: str | None = None) -> dict:
    """"Hang out until X" - the player's safe fast-forward. The ENGINE runs up to 8 short (15-30 in-game minute) beats and decides
    the stop reason (``stopReason`` + Vault-free public ``detail``): the scheduled event coming due, the player being pulled,
    an NPC approaching, something observed, or bedtime. ``{"ok": false, "reason": ...}`` (no state change) when the flag/clock
    is off. FE-driven from the player's wait/chill intent - not a model lever."""
    args: dict = {}
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    if max_beats is not None:
        args["maxBeats"] = max_beats
    return await _call("hangOut", args, user=user)


async def player_tagline(user: str | None = None) -> dict:
    """A snarky, state-aware Big Brother one-liner for the homepage hero (0033). Vault-free;
    reflects the player's current public standing. Returns ``{"text": "..."}``."""
    return await _call("playerTagline", {}, user=user)


async def social_initiatives(user: str | None = None) -> dict:
    """Which houseguests want to approach the player now (0036/E60) — names + a coarse motive
    (bond | probe) the GM voices in its own words, so scenes start from either side. Vault-free
    (never a relationship number)."""
    return await _call("socialInitiatives", {}, user=user)


async def make_deal(with_id: str, kind: str, terms: str, leverage: dict | None = None,
                    traded_secret: dict | None = None, expected_beat_seq: int | None = None,
                    idempotency_key: str | None = None, user: str | None = None,
                    term: dict | None = None, direction: str | None = None) -> dict:
    """Record a player<->NPC deal (0039). The engine tracks and adjudicates it. 0065 Part A — an
    optional `expected_beat_seq` CAS token is threaded in only when provided (absent ⇒ identical to
    today).

    0093/0099 — optional `leverage` / `traded_secret` SecretLeverDescriptor dicts
    ({factId?, bluff?, subject?}), threaded in ONLY when provided (absent ⇒ byte-identical to the
    pre-0093/0099 shape). Forwarded OPAQUELY to the engine, which is the single authority on whether
    a held `factId` is legal, whether a bluff lands, and how the pressure/sweetener folds — the FE
    never interprets either field.

    A10 / #591 / R1c — an optional `idempotency_key` (0065 Part B, the fold-lever sibling of
    `record_interaction`'s) threads in ONLY when provided: a deal folds a hidden relationship impact AND
    creates state, so a stale-409 re-drive (the #591 retry + the CON-11 deferred-fold queue) must be
    at-most-once at the ENGINE — a repeat key returns the prior result without re-folding (#1305)."""
    args: dict = {"with": with_id, "kind": kind, "terms": terms}
    if direction in ("offer", "ask"):  # B55: who promises, for the active kinds only; absent => the engine defaults to the player's offer
        args["direction"] = direction
    if leverage is not None:
        args["leverage"] = leverage
    if traded_secret is not None:
        args["tradedSecret"] = traded_secret
    if term is not None:
        args["term"] = term  # 0109 — the engine validates/bounds it
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    if idempotency_key is not None:
        args["idempotencyKey"] = idempotency_key
    return await _call("makeDeal", args, user=user)


async def confide(npc_id: str, expected_beat_seq: int | None = None,
                  idempotency_key: str | None = None, user: str | None = None) -> dict:
    """Feature 0075 — the player presses an ally to confide. The engine is the single authority: it
    decides whether/how much they disclose and whether it's true or a lie, and records the disclosure
    as the player's knowledge via an in-game pathway. 0065 Part A — the optional `expected_beat_seq`
    CAS token threads in only when provided (absent ⇒ identical to today).

    A10 / #591 / R1c — the optional `idempotency_key` (0065 Part B) threads in only when provided: a
    confide folds the bond bump / lie ledger, so a stale-409 re-drive must be at-most-once at the
    ENGINE (#1305 — a repeat key returns the prior result without re-folding)."""
    args: dict = {"npcId": npc_id}
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    if idempotency_key is not None:
        args["idempotencyKey"] = idempotency_key
    return await _call("confide", args, user=user)


async def ask_juror(juror_id: str, expected_beat_seq: int | None = None,
                    idempotency_key: str | None = None, user: str | None = None) -> dict:
    """Feature 0129 slice 3 — the juror-player asks a fellow juror what they know. The engine is the single
    authority (it gates on the juror's bearing, picks one thing the juror legitimately holds, and records the
    telling through the told-by pathway); we only forward {jurorId}. Optional CAS token / at-most-once key
    thread in only when provided (absent ⇒ identical to the plain call)."""
    args: dict = {"jurorId": juror_id}
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    if idempotency_key is not None:
        args["idempotencyKey"] = idempotency_key
    return await _call("askJuror", args, user=user)


async def form_alliance(name: str, members: list, expected_beat_seq: int | None = None, user: str | None = None) -> dict:
    """Feature 0107 Phase A — the player NAMES an alliance with a set of houseguests. The engine is
    the single authority: membership is bond-gated (a proposed member joins only if their mutual bond
    with the player clears the floor; the unbonded decline), so this reports who ACTUALLY joined, not
    who was asked. 0065 Part A — the optional `expected_beat_seq` CAS token threads in only when
    provided (absent ⇒ identical to today)."""
    args: dict = {"name": name, "members": members}
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    return await _call("formAlliance", args, user=user)


async def join_alliance(alliance_id: str, expected_beat_seq: int | None = None, user: str | None = None) -> dict:
    """Feature 0107 Phase B — the player ACCEPTS an NPC's pitch and joins their named alliance. The
    engine is the single authority: only a live pitch (the player is `knownTo` but not yet a member)
    AND a close-enough bond with the founder lets them in — a cold "add me" is refused. 0065 Part A —
    the optional `expected_beat_seq` CAS token threads in only when provided."""
    args: dict = {"allianceId": alliance_id}
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    return await _call("joinAlliance", args, user=user)


async def expose_secret(fact_id: str | None = None, bluff: bool = False, subject: str | None = None,
                        expected_beat_seq: int | None = None, idempotency_key: str | None = None,
                        user: str | None = None) -> dict:
    """Feature 0093 — the player OUTS a secret they LEARNED to the house. The engine is the single
    authority: it validates the player actually holds `fact_id` (I3/Vault Wall — a non-learned fact is
    REJECTED, never invented here), resolves the bounded standing fold + exposer backlash, and records
    the exposure as a witnessed pathway event. A `bluff` (outing a secret the player does NOT hold, with
    `subject` naming who it's about) never reads the Vault — it's a pure gamble the engine adjudicates.
    0065 Part A — the optional `expected_beat_seq` CAS token threads in only when provided.

    A10 / #591 / R1c — the optional `idempotency_key` (0065 Part B) threads in only when provided: an
    exposure folds a house-wide standing hit AND spends the secret (one-shot), so a stale-409 re-drive
    (the #591 retry + the CON-11 deferred-fold queue) must be at-most-once at the ENGINE (#1305 — a
    repeat key returns the prior result without re-folding)."""
    args: dict = {}
    if bluff:
        args["bluff"] = True
        if subject is not None:
            args["subject"] = subject
    elif fact_id is not None:
        args["factId"] = fact_id
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    if idempotency_key is not None:
        args["idempotencyKey"] = idempotency_key
    return await _call("exposeSecret", args, user=user)


async def trade_secret(to_npc_id: str, fact_id: str | None = None, bluff: bool = False,
                       subject: str | None = None, ask_kind: str | None = None,
                       expected_beat_seq: int | None = None, idempotency_key: str | None = None,
                       user: str | None = None) -> dict:
    """Feature 0099 — the player TRADES a secret they LEARNED about a THIRD party to a recipient for a
    one-off concession. The engine is the single authority: it validates the player actually holds
    `fact_id` (I3/Vault Wall — a non-learned fact is REJECTED), values the secret TO THE RECIPIENT, and
    decides whether they bite. A `bluff` (offering a fabricated secret, `subject` naming who it's about)
    never reads the Vault. 0065 Part A — the optional `expected_beat_seq` CAS token threads in only when
    provided.

    A10 / #591 / R1c — the optional `idempotency_key` (0065 Part B) threads in only when provided: a
    struck trade folds the recipient warmth/sour AND burns the one-shot trade cap, so a stale-409
    re-drive (the #591 retry + the CON-11 deferred-fold queue) must be at-most-once at the ENGINE
    (#1305 — a repeat key returns the prior result without re-folding)."""
    args: dict = {"toNpcId": to_npc_id}
    if bluff:
        args["bluff"] = True
        if subject is not None:
            args["subject"] = subject
    elif fact_id is not None:
        args["factId"] = fact_id
    if ask_kind is not None:
        args["askKind"] = ask_kind
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    if idempotency_key is not None:
        args["idempotencyKey"] = idempotency_key
    return await _call("tradeSecret", args, user=user)


async def confront(npc_id: str, fact_id: str, expected_beat_seq: int | None = None,
                   user: str | None = None) -> dict:
    """Feature 0094 — the player CONFRONTS a houseguest over a fact they LEARNED. The engine is the
    single authority: it validates the player actually holds `fact_id` (I3/Vault Wall — a non-learned
    fact is REJECTED), classifies the cited belief, and resolves whether the confrontation lands —
    returning only Vault-free `{landed}` (never why). 0065 Part A — the optional `expected_beat_seq`
    CAS token threads in only when provided."""
    args: dict = {"npcId": npc_id, "factId": fact_id}
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    return await _call("confront", args, user=user)


async def accuse_tie(a_id: str, b_id: str, expected_beat_seq: int | None = None,
                     user: str | None = None) -> dict:
    """Feature 0095 — the player accuses two houseguests of a PRE-SHOW tie. The engine checks whether
    a real connection exists (never invented or confirmed FE-side) and returns only Vault-free
    `{landed}` — a miss is indistinguishable from an ordinary wrong guess. 0065 Part A — the optional
    `expected_beat_seq` CAS token threads in only when provided."""
    args: dict = {"aId": a_id, "bId": b_id}
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    return await _call("accuseTie", args, user=user)


async def season_recap(user: str | None = None) -> dict:
    """The season's public arc from the event record (0048) — Vault-free, any time."""
    return await _call("seasonRecap", {}, user=user)


async def player_receipts(user: str | None = None) -> list:
    """#1800 — candidate contradictions drawn ONLY from the player's own record. Vault-free."""
    return await _call("playerReceipts", {}, user=user)


async def player_dossier(subject_id: str | None = None, user: str | None = None) -> dict:
    """#1793 — the player's own Diary-Room reads grouped per houseguest (optionally one). ``{}`` when
    the dossier is off. Vault-free: the player's words only."""
    args: dict = {"subjectId": subject_id} if subject_id else {}
    return await _call("playerDossier", args, user=user)


async def season_retrospective(user: str | None = None):
    """The post-season Vault unsealing (0048): the FINISHED season's hidden story, or ``None``
    while a season is live (the gate is the engine's terminal state, never a prompt)."""
    return await _call("seasonRetrospective", {}, user=user)


async def daily_recap(user: str | None = None):
    """The most recently CLOSED in-game day's 'day in review' digest (0102) — Vault-free,
    reproducible. Usually delivered inline on ``turnIn``'s result; this re-fetches the same
    day's digest. Returns ``None`` before any day has closed."""
    return await _call("dailyRecap", {}, user=user)


async def world_snapshot_view(user: str | None = None):
    """Feature 0062: the move-in zeitgeist snapshot — Vault-free public flavor
    (screen, music, sports, news, internet, mood) plus an offscreenPrompt meant to
    inform off-screen scene prose. Returns {} when no snapshot has been captured
    (pre-game / early casting)."""
    return await _call("worldSnapshotView", {}, user=user)


async def npc_voice(npc_id: str, user: str | None = None):
    """The knowledge-bounded voicing projection for one active houseguest (B65) — persona,
    room/co-presence, what THEY know/suspect, organic stances. ``None`` for unknown/departed."""
    res = await _call("npcVoice", {"id": npc_id}, user=user)
    _note_tells(user, res)
    return res


async def sealed_from_house(user: str | None = None):
    """A0 knowledge-wall manifest — the player's private disclosures sealed from the house (most
    sharply the Diary-Room entries, `knownTo` empty). Vault-free (the player's OWN knowledge). The
    narration guard reads it to strip any line that puts sealed content in a houseguest's mouth.
    Returns a list of ``{content, knownTo}``; ``[]`` pre-game or when nothing is sealed."""
    return await _call("sealedFromHouse", {}, user=user)


async def knowledge_scope_manifest(user: str | None = None):
    """ADR 0019 Layer 3 knowledge-scope manifest — every distinctive fact held by a BOUNDED subset of
    the house, each with its complete pathway-holder set (houseguest names). Vault-free (the legitimate
    witnessed-or-told layer). The narration guard reads it to drop any line in which a houseguest voices
    a fact no in-game pathway gave them (the room-to-room asymmetry: the player told B, A must not
    recall it). Returns a list of ``{content, knownTo}``; ``[]`` pre-game or when nothing is bounded."""
    return await _call("knowledgeScopeManifest", {}, user=user)


async def whereabouts(user: str | None = None):
    """The Vault-free presence read (0049): the player's room, who is in it, and who is in each
    ADJACENT room — names only, never motives or non-adjacent rooms. ``None`` pre-game."""
    return await _call("whereabouts", {}, user=user)


async def move_to(room: str, expected_beat_seq: int | None = None, user: str | None = None):
    """L21/L24: the player walks to a room they named — the engine moves them (it never auto-relocates
    a person) and returns the resulting whereabouts. No-op for an unknown room / pre-game. 0065 Part A —
    an optional `expected_beat_seq` CAS token is threaded in only when provided (absent ⇒ identical to
    today)."""
    args: dict = {"room": room}
    if expected_beat_seq is not None:
        args["expectedBeatSeq"] = expected_beat_seq
    return await _call("moveTo", args, user=user)


async def move_houseguest(houseguest_id: str, room: str, user: str | None = None):
    """ADR 0009 — RECORD a NARRATED NPC relocation: the engine moves houseguest ``houseguest_id`` into
    ``room`` in the OPEN occupancy (so the board agrees with the prose — no visible historic conflict),
    never the calibration-neutral baseline, and only for a LEGAL move. Returns the HouseguestMoveResult
    ``{status: moved|noop|illegal, whereabouts}``. The FE records this from the narration (the
    ``_auto_move_npc`` belt); the player's own movement stays ``move_to``. Vault-free."""
    return await _call("moveHouseguest", {"id": houseguest_id, "room": room}, user=user)


async def premiere_intros(user: str | None = None):
    """PREMIERE ONLY (#380): the meet-everyone progress — who's met + who's STILL to introduce before
    the first HOH, each with their OBSERVABLE public persona (Vault-free; no soul/number). ``None``
    outside the premiere."""
    return await _call("premiereIntros", {}, user=user)


async def mark_houseguest_met(houseguest_id: str, user: str | None = None, via: str | None = None):
    """PREMIERE ONLY (#380): mark a houseguest as INTRODUCED/met the instant they've introduced their
    public self. Idempotent; the engine tracks who's met so all 15 NPCs are met before the first HOH.
    Returns the updated meet-everyone progress (``None`` outside the premiere).

    #1318 — ``via="belt"`` marks it as the FE regex auto-belt catching a bare name in narration: it fills
    the meet-list (its anti-soft-lock job) but is NOT a genuine player-formed read, so it does NOT unlock
    the asymmetric first-power gate. Omit ``via`` (the default) for a genuine model-driven introduction the
    player was part of — that counts as a hot read. The engine defaults an absent value to ``player``."""
    args: dict = {"id": houseguest_id}
    if via is not None:
        args["via"] = via
    return await _call("markHouseguestMet", args, user=user)


async def finale_view(user: str | None = None):
    """The Vault-free in-progress finale projection (0037 §8.1): finalists, the current stage, and the
    votes revealed SO FAR — or ``None`` when no finale is staging. Never a lean/tally/manner or the
    pre-reveal winner. Used by the finale panel; the chat agent still drives the binding decisions."""
    return await _call("finaleView", {}, user=user)


async def diary_room(entry: str, user: str | None = None) -> dict:
    """Record the player's out-of-character Diary-Room entry (0036). The player's own knowledge,
    with no in-game pathway to any houseguest — never reaches the house."""
    return await _call("diaryRoom", {"entry": entry}, user=user)


async def get_portrait_prompt(houseguest_id: str, user: str | None = None) -> dict:
    """The Vault-free portrait prompt for ONE houseguest (0051) — used to regenerate a missing
    portrait. Returns ``{houseguestId, name, prompt}``; the engine builds it from public
    appearance facets + the per-season photorealistic style anchor (no hidden state crosses)."""
    return await _call("getPortraitPrompt", {"id": houseguest_id}, user=user)


async def note_message(message_id: str, user: str | None = None) -> dict:
    """Announce ONE player message to the engine clock (per-message pacing): the engine steps
    the in-game clock one message-step, idempotent per ``message_id`` (a retry / two-window
    re-drive bills nothing). Returns ``{ accepted }``. Closed-set time only, no Vault."""
    return await _call("noteMessage", {"messageId": str(message_id)}, user=user)


async def record_image_beat(houseguest_id: str, image_ref: str, user: str | None = None) -> dict:
    """Record a shown portrait/image as a player-witnessed beat (0051): recorded-or-it-didn't-
    happen. `imageRef` is the stored filename/URL the player saw. Player knowledge, never the Vault."""
    return await _call("recordImageBeat", {"houseguestId": houseguest_id, "imageRef": image_ref}, user=user)


# --- God Mode / admin channel (0016) --------------------------------------------------
# These cross the engine's ADMIN channel (/admin/call), not the player channel. The
# admin channel is STILL Vault-free by construction (the human can never read the Vault,
# even in God Mode — the spoiler wall). Callers MUST be gated to admins on the front-end
# side (the agent tools below are in _ADMIN_TOOLS); the engine isolates per user (0021).

async def _admin_call(name: str, args: dict | None = None, user: str | None = None) -> dict:
    """Invoke an admin/God-Mode tool over the engine's HTTP MCP transport, for `user`'s sandbox.
    Shares `_post_tool`'s semantics: structured engine errors raise :class:`EngineToolError`, real
    outages propagate as httpx errors, and failures feed the visible health banner."""
    engine_read_cache.invalidate(user)  # ORW-166: an admin tool may mutate (override, reset...): never serve a cached read across it
    try:
        return await _post_tool("/admin/call", name, args, user)
    finally:
        engine_read_cache.invalidate(user)


async def inspect_non_vault_state(user: str | None = None) -> dict:
    """God Mode: inspect non-Vault game state (never the Vault — walled even for admin)."""
    return await _admin_call("inspectNonVaultState", {}, user=user)


async def override_mechanic(mechanic: str, value, user: str | None = None) -> dict:
    """God Mode: override a non-Vault mechanic in the sandbox; returns updated non-Vault state."""
    return await _admin_call("overrideMechanic", {"mechanic": mechanic, "value": value}, user=user)


async def configure_game(settings: dict, user: str | None = None) -> dict:
    """God Mode: set non-Vault tunables (temperature/relationship config, reserve-twist COUNT —
    never twist CONTENT, which stays Vault-sealed)."""
    return await _admin_call("configure", settings or {}, user=user)


async def set_time_of_day(enabled: bool, user: str | None = None) -> dict:
    """ADR 0006: turn the in-game time-of-day clock + nightly sleep economy ON or OFF on the LIVE
    engine at runtime (no restart). The FE settings switch flips this; the engine holds a process-global
    override of the ORWELL_TIME_OF_DAY env default (reset on engine restart — re-applied on FE boot)."""
    return await _admin_call("setTimeOfDay", {"enabled": bool(enabled)}, user=user)


# B2 (G6 gap fix): the "living house" behavioral-fidelity layers (campaigns / trajectories /
# triggers / secretPacing / juryHouse / seededTieSurfacing / mythMaking / showrunner) — every
# field `setBehavioralFlags` accepts. Kept as the single name list so the FE route validates
# against the SAME set the engine's `requireShape` guard enforces (McpServer.ts), never a
# hand-duplicated copy that could drift.
BEHAVIORAL_FLAG_FIELDS = (
    "campaigns", "trajectories", "triggers", "secretPacing",
    "juryHouse", "seededTieSurfacing", "mythMaking", "showrunner",
)


async def get_behavioral_flags(user: str | None = None) -> dict:
    """B2: read the CURRENT resolved on/off state of every behavioral-fidelity flag for THIS
    user's sandbox (env default or a prior `set_behavioral_flags` override) — so an admin dial
    can render truthfully instead of only being able to write blind. Vault-free."""
    return await _admin_call("getBehavioralFlags", {}, user=user)


async def set_behavioral_flags(flags: dict, user: str | None = None) -> dict:
    """B2: turn one or more "living house" behavioral-fidelity layers ON or OFF on the LIVE
    engine at runtime (no restart) — the admin-tool consumer of `setBehavioralFlags`, previously
    unwired (gap-audit G6/#1840). Only recognized boolean fields (`BEHAVIORAL_FLAG_FIELDS`) are
    forwarded; an absent/unrecognized/non-boolean field is dropped rather than sent blind, so a
    malformed caller can never trip the engine's `requireShape` refusal. Resets on engine restart
    (the env default stands again) — there is no persisted re-apply-on-boot for this ops dial."""
    payload = {
        k: bool(v) for k, v in (flags or {}).items()
        if k in BEHAVIORAL_FLAG_FIELDS and isinstance(v, bool)
    }
    return await _admin_call("setBehavioralFlags", payload, user=user)


async def manage_sandbox(op: str | None = None, user: str | None = None) -> dict:
    """God Mode: sandbox lifecycle for THIS user's sandbox only (create | reset | save | load)."""
    args: dict = {}
    if op:
        args["op"] = op
    res = await _admin_call("manageSandbox", args, user=user)
    if op == "reset":
        _notify_season_reset(user)
    return res


# ── the engine PLAY-CLOCK, mirrored for LABELING only (2026-07-13 prod bundle audit) ──────────
# The engine's runtime `Clock` is a pure fixed-epoch `LogicalClock` (real-time purge 2026-07-10):
# it starts at 2026-01-01T00:00:00Z and advances ONE step per committed mutation — it NEVER reads
# wall time. sandboxHealth stamps (`lastAdvanceAt`, `faults[].when`) are therefore PLAY-CLOCK
# values that merely LOOK like epoch-milliseconds; rendering them as a wall-clock date ("Jan
# 2026") is a mislabel (the live bundle audit hit exactly this). These constants mirror
# `src/composition/runtime.ts` (LOGICAL_CLOCK_EPOCH_MS / LOGICAL_CLOCK_STEP_MS) so the FE can
# derive "beat N" for display — labeling only, never fed back to the engine.
PLAY_CLOCK_EPOCH_MS = 1_767_225_600_000
PLAY_CLOCK_STEP_MS = 60_000


def _play_clock_beat(ms) -> int | None:
    """The committed-mutation count ("beat") a raw play-clock stamp encodes, or None.
    Fail-soft: a bool / None / non-numeric / non-finite (``inf``/``nan`` → OverflowError or
    ValueError on ``int()``) stamp returns None rather than raising."""
    if isinstance(ms, bool):
        return None
    try:
        n = int(ms)
    except (TypeError, ValueError, OverflowError):
        return None
    return max(0, (n - PLAY_CLOCK_EPOCH_MS) // PLAY_CLOCK_STEP_MS)


def label_play_clock(health) -> dict:
    """Relabel the PLAY-CLOCK stamps in an engine ``sandboxHealth`` record so no FE surface
    (admin status tool result, health page, debug bundle) renders them as wall time.

    ``lastAdvanceAt`` (a raw LogicalClock ms) is replaced by ``lastAdvancePlayClock`` —
    ``{"beat": N, "playClockMs": <raw>, "label": "play-clock beat N"}`` — and each fault's
    ``when`` becomes ``whenPlayClock`` in the same shape. A ``playClock`` legend rides along
    whenever a stamp was relabeled. Purely presentational and fail-soft: a non-dict / already-
    labeled / stamp-free payload passes through unchanged. FE rendering only — the engine's
    clock and its wire shape are untouched."""
    if not isinstance(health, dict):
        return health
    out = dict(health)
    relabeled = False

    def _labeled(ms) -> dict:
        beat = _play_clock_beat(ms)
        return {"beat": beat, "playClockMs": ms,
                "label": f"play-clock beat {beat}" if beat is not None else "play-clock"}

    if "lastAdvanceAt" in out:
        raw = out.pop("lastAdvanceAt")
        out["lastAdvancePlayClock"] = _labeled(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None
        relabeled = True
    faults = out.get("faults")
    if isinstance(faults, list):
        new_faults = []
        for f in faults:
            # Mirror the top-level branch: for EVERY dict fault carrying a `when` key, always POP
            # the raw wall-clock-looking key and set `whenPlayClock` to the labeled value when
            # numeric, else None. A non-numeric / date-like `when` must NEVER survive (that would
            # defeat the "never render as a date" invariant this feature enforces). Non-dict faults
            # and faults with no `when` pass through unchanged.
            if isinstance(f, dict) and "when" in f:
                f = dict(f)
                raw = f.pop("when")
                f["whenPlayClock"] = (
                    _labeled(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None
                )
                relabeled = True
            new_faults.append(f)
        out["faults"] = new_faults
    if relabeled:
        out["playClock"] = {
            "epochMs": PLAY_CLOCK_EPOCH_MS,
            "stepMs": PLAY_CLOCK_STEP_MS,
            "note": ("fixed-epoch LogicalClock (one beat per committed mutation) — "
                     "NOT wall time; never render as a date"),
        }
    return out


async def sandbox_health(user: str | None = None) -> dict:
    """God Mode: Vault-free sandbox health for THIS user's sandbox (B58) — week/phase, last advance,
    integrity status, recent faults, circuit state. Metadata only, never game content or the Vault.

    2026-07-13: the engine's play-clock stamps are relabeled here (``label_play_clock``) — the ONE
    seam every FE consumer of this read shares (the admin ``sandboxHealth`` tool, the health page,
    the debug bundle) — so a LogicalClock value is never displayed as a wall-clock date."""
    return label_play_clock(await _admin_call("sandboxHealth", {}, user=user))


async def advance_to_finale(user: str | None = None) -> dict:
    """God Mode debug (L38): fast-forward THIS user's live season to a crowned winner — the engine
    drives the deterministic loop, auto-resolving the player's pending decisions with legal defaults,
    so the post-season retrospective (0048) unseals legitimately. Reads NO Vault and reveals nothing
    hidden — returns only the Vault-free summary ``{finished, winnerName, weeks, playerPlacement,
    started}``. The retrospective still opens ONLY post-finale through its own code-gated path; this
    just makes the season FINISH."""
    return await _admin_call("advanceToFinale", {}, user=user)


async def producer_vault(user: str | None = None) -> dict:
    """DEBUG — the owner-ruled OVERRIDE of mandate #2 (admin/God Mode is otherwise walled from the
    Vault). UNSEALS THIS user's LIVE hidden layer (off-screen scheming, NPC confessionals, secret
    threads/ties, the sealed reserve twists, and the real eviction ballots) for operator debugging,
    WITHOUT the post-season gate. Crosses the engine ADMIN channel as the out-of-band ``producerVault``
    capability (not an advertised tool); fired only behind an explicit FE "unseal". Returns the same
    scrubbed, name-resolved view as the post-season retrospective; ``{}``/null when no game exists.

    This DELIBERATELY surfaces Vault content — it is the one sanctioned LIVE reveal. Keep it behind the
    explicit unseal action; never wire it into any always-on/player surface."""
    return await _admin_call("producerVault", {}, user=user)


# 0121 R2 — the engine's boot-time behavioral-flags block (GET /health `flags`), cached from the health
# probe so the tool-schema layer can read a live feature flag (e.g. `dealDepth`) synchronously without its
# own async call. Empty until the first successful probe ⇒ every flag reads its default (False), which keeps
# the flag-gated makeDeal schema at its base kinds — flag-off requests are unchanged (the golden-path fixture this once mentioned was decommissioned 2026-07-21).
_ENGINE_FLAGS: dict = {}


def engine_flag(name: str, default: bool = False) -> bool:
    """A cached engine boot flag from GET /health `flags` (0121 R2). Default (unprobed / unknown) ⇒ False."""
    v = _ENGINE_FLAGS.get(name)
    return bool(v) if isinstance(v, bool) else default


async def _probe_health_once() -> dict:
    """ONE /health probe. ``{"ok": True}`` when the engine answers 200, else ``{"ok": False, "error": …}``.
    Raises on a transport outage so the retry loop can give a momentary blip another try."""
    r = await _shared_client().get(ENGINE_URL.rstrip("/") + "/health", timeout=5.0)
    if r.status_code == 200:
        # Cache the boot-flags block (0121 R2) — best-effort; a malformed body just leaves flags unchanged.
        try:
            flags = (r.json() or {}).get("flags")
            if isinstance(flags, dict):
                _ENGINE_FLAGS.update({k: bool(v) for k, v in flags.items() if isinstance(v, bool)})
        except Exception:
            pass
        return {"ok": True, "engineUrl": ENGINE_URL}
    if r.status_code in _TRANSIENT_STATUSES:
        # A gateway 502/503/504 on /health is a momentary blip — raise so we retry, not surface red.
        r.raise_for_status()
    return {"ok": False, "engineUrl": ENGINE_URL, "error": f"engine returned HTTP {r.status_code}"}


async def engine_health_detail() -> dict:
    """Engine reachability plus a human-readable reason when something is wrong — for VISIBLE
    front-end error reporting. ``{"ok": bool, "engineUrl": str, "error"?: str, "lastError"?: dict}``.
    ``ok`` reflects the engine process answering /health; ``lastError`` additionally reports a RECENT
    failed tool call (a technical problem while the engine is up — e.g. a corrupt-save 500), with
    ``{tool, kind, error, ageSeconds}``. ``reconnecting`` is true while a recent transient outage is
    being retried (the banner renders a soft "reconnecting…" rather than a hard red). Never raises."""
    detail: dict
    last_exc: Exception | None = None
    for attempt in range(_RETRY_ATTEMPTS + 1):
        try:
            detail = await _probe_health_once()
            break
        except Exception as e:  # failsoft-ok: expected-empty (this IS the health reporter — a probe failure is REPORTED as {ok:False,error} to the FE banner, not swallowed)
            last_exc = e
            if attempt < _RETRY_ATTEMPTS and _is_transient(e):
                _mark_reconnecting()
                await asyncio.sleep(_RETRY_BACKOFF_S * (2 ** attempt))
                continue
            # Connection refused / DNS / timeout after retries: the most common real failure
            # (engine not running, or a wrong ORWELL_ENGINE_MCP_URL). Report the concrete reason.
            detail = {"ok": False, "engineUrl": ENGINE_URL, "error": f"{type(e).__name__}: {e}"}
            break
    if detail.get("ok"):
        _clear_reconnecting()  # the engine answered — any reconnecting state is over
    le = last_engine_error()
    if le:
        detail["lastError"] = {
            "tool": le["tool"], "kind": le["kind"], "error": le["error"],
            "ageSeconds": int(time.time() - le["ts"]),
        }
    # A momentary outage being retried: a SOFT state, distinct from a hard red. The banner can show
    # "reconnecting…" and recover quietly when the engine answers again.
    if reconnecting():
        detail["reconnecting"] = True
    # G8: while createCharacter is in flight, a slow/timed-out probe is casting being finalized,
    # not an outage — the banner renders an in-fiction holding line instead of red.
    if creating_in_flight():
        detail["busy"] = "creating"
    return detail


async def engine_health() -> bool:
    """True if the engine HTTP MCP server answers /health."""
    return bool((await engine_health_detail()).get("ok"))


# ── D3/E66: the last-seen pending decision, per user ─────────────────────────
# Every AdvanceView flows through this server (the agent's advanceGame/
# submitDecision tools and the /api/orwell/decision route), so caching the last
# `pending` here lets GET /api/orwell/status re-arm the decision card after a
# reload WITHOUT any poll ever advancing the game (ADR 0003: progressing is an
# explicit act). The cache holds the engine's own Vault-free legal-options view,
# nothing more; it clears whenever an AdvanceView shows no pending.
_LAST_PENDING: dict = {}


def remember_pending(view, user=None) -> None:
    """Record (or clear) the pending decision from any AdvanceView-shaped dict.

    The cache mirrors the engine's `pending` so GET /api/orwell/status can re-arm the
    decision card after a reload WITHOUT a poll ever advancing the game. It is the route's
    OMIT-fallback: the status route trusts a PRESENT `pending` (including null) as engine
    truth and only falls back to this cache when the engine response OMITS the key entirely
    (an older engine). So the three cases are distinct (F5):

      * present & truthy → UPDATE the cache (a real pending decision to re-arm);
      * present & null/None → CLEAR the cache (the engine says "no pending" — the prior
        card is resolved; keeping it would re-surface a stale card on reload);
      * key ABSENT → KEEP the prior cache (an old engine that never exposed `pending` — the
        route's omit-fallback still serves the last-seen card).

    The earlier cut popped on any falsy `view.get("pending")`, which conflated absent with
    null — harmless for the route, but it meant an explicit `pending: null` and a missing key
    were indistinguishable here. The distinction matters for the clear-on-submit safety in the
    decision route (a successful submit returns `pending: null` ⇒ this clears; a result that
    happens to OMIT the key must NOT silently keep a stale card — see clear_pending).

    ONE deliberate exception to "absent ⇒ keep": a LIFECYCLE result (a createCharacter /
    manageSandbox casting card or a refused-restart GameStateView) carries no `pending` field
    by construction, yet the restart-door call sites pass it here SPECIFICALLY to wipe the prior
    season's stale card (D3/E66 restart-door hygiene). Those views are recognizable by their
    lifecycle markers (`started` / `characterType` / `createRefused` / `castingCard`); when we
    see one, an absent `pending` means CLEAR, not keep. A decision/advance/status view that an
    old engine returned without a `pending` key has none of those markers, so its omit-fallback
    still keeps the last-seen card."""
    try:
        if not isinstance(view, dict):
            return
        key = user or ""
        if "pending" not in view:
            # A lifecycle/restart-door view (casting card / refused restart) carries no `pending`
            # but is passed here to CLEAR the prior season's card — honor that intent. Anything
            # else that merely omits `pending` (an old engine's advance/status view) is KEPT so the
            # route's omit-fallback can still re-arm the last-seen card.
            if any(k in view for k in ("started", "characterType", "createRefused", "castingCard")):
                _LAST_PENDING.pop(key, None)
            return
        pending = view.get("pending")
        if pending:
            _LAST_PENDING[key] = pending  # present & truthy: a real card to re-arm
        else:
            _LAST_PENDING.pop(key, None)  # present & null/None: the engine says "no pending"
    except Exception:
        pass


def clear_pending(user=None) -> None:
    """Unconditionally drop the cached pending decision for a user (F5 clear-on-submit safety).

    `remember_pending` now KEEPS the cache when a view OMITS the `pending` key, so a path that
    KNOWS the card is resolved (e.g. a successful decision submit whose result happens not to
    carry `pending`) must clear explicitly rather than rely on the omit-fallback — otherwise a
    stale card could re-arm on the next status reload."""
    _LAST_PENDING.pop(user or "", None)


def last_pending(user=None):
    """The last pending decision this server saw for the user (or None)."""
    return _LAST_PENDING.get(user or "")
