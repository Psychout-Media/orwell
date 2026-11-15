"""Feature 0081 — the narration-FAITHFULNESS gate (the overseer's second role).

Where feature 0079/0080's runtime overseer watches the engine<->LLM loop for PACING / gap-repair
failures (the model UNDER-calls a tool — it won't ``advanceGame``, it won't ``recordInteraction``),
this role watches FAITHFULNESS — the model MIS-narrates: prose that contradicts the board, drifts a
houseguest's public persona, leaks hidden machinery or a fact the player has no pathway to know, or
drops a beat it should have advanced.

It rides its OWN dial — deliberately independent of :func:`src.overseer.overseer_mode` (owner ruling
O2, 2026-06-24) — so the riskier role (an LLM judging the LLM, and in ``active`` canonicalizing
open-set slips) can roll out on its own clock. Same three states:

  * ``'off'``    — the judge never runs; the deterministic 0065 floor stands (default).
  * ``'shadow'`` — the judge runs on claim-bearing turns and LOGS verdicts; it does NOT correct.
  * ``'active'`` — the judge's verdict drives a clever, diegetic correction (adopt the open set /
                   reframe the closed set), with the deterministic floor underneath. LIVE-only.

The correction split is governed by ADR 0005 and the owner's "keep the wall" ruling (2026-06-24): an
OPEN-set slip (texture the engine never owned) is ADOPTED canonical; a CLOSED-set slip (an actual
outcome) is REFRAMED in-fiction — a consequential outcome is NEVER bent to match the narration. The
judge is Vault-free BY CONSTRUCTION: it compares the narration only against the player's known,
Vault-free projection, so a leak is caught as "an assertion outside what the player legitimately
knows", never by reading the Vault.

This module is the role's home. The **dial** (P1) and the **judge** (P2 — detection + the verdict
contract, with the deterministic stub that keeps seeded lanes byte-identical) live here; the
agent-loop hook, the ``adopt`` / ``reframe`` correction dispatch, and the junctions land in the
following increments. Every public function swallows its own errors and degrades to a safe default —
config must never crash the turn.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Optional, Protocol

logger = logging.getLogger(__name__)


def _record_faith_guard_down(kind: str, diagnosis: str) -> None:
    """#1599 - surface a faithfulness-GUARD failure LOUDLY (WARN + a RED-eligible health event on
    /admin/status), never a silent swallow. The WARN fires FIRST, so even if the health-event write
    fails the diagnosis is never fully invisible. Fail-soft by construction: logging must never hurt a
    turn, so each step is best-effort."""
    warned = False
    try:
        logger.warning("[orwell] %s", diagnosis)
        warned = True
    except Exception:
        # The logger itself is unavailable — nowhere left to write. Terminal, not a swallowed
        # business error (this guards the LOGGING path, per "logging must never hurt the app").
        pass
    try:
        from src import log_rings as _lr
        _lr.record_overseer("anomaly", kind, diagnosis, lever=None, ok=False)
    except Exception as _rec_err:  # failsoft-ok: recorder-self (the RED health-event write itself failed; the WARN above already surfaced the diagnosis — nowhere left to write)
        # The RED health-event write failed — but the WARN above already surfaced the diagnosis, so
        # this is not the silent-fail #1599 bans. Note the telemetry-write failure at debug.
        if warned:
            try:
                logger.debug("[orwell] faith guard-down health-event write failed: %s", _rec_err)
            except Exception:
                pass

# Feature 0081 — the 3-state faithfulness dial, independent of the 0079/0080 overseer_mode():
#   'off'    — the judge never runs.
#   'shadow' — the judge runs on claim-bearing turns and LOGS; it does not correct.
#   'active' — the judge's verdict drives the diegetic correction (adopt/reframe); LIVE-only.
#              **DEFAULT** since the owner ruling 2026-07-13 — the judge ships on, using the CHEAP
#              utility tier by default (see ``_resolve_llm_fn(prefix='faithfulness')``).
FAITHFULNESS_MODES = ("off", "shadow", "active")


def faithfulness_mode() -> str:
    """Resolve the 3-state faithfulness-gate mode (one of :data:`FAITHFULNESS_MODES`).

    Settings-first, fail-soft, and DELIBERATELY independent of :func:`src.overseer.overseer_mode`
    (owner ruling O2 — its own dial, its own clock). Resolution order (the first that yields a value
    wins):
      1. settings ``faithfulness_mode`` — if it is one of :data:`FAITHFULNESS_MODES`;
      2. else the env ``ORWELL_FAITHFULNESS_MODE`` — if it is one of :data:`FAITHFULNESS_MODES``
         (an explicit ``off`` here still disables the judge);
      3. else ``'active'`` — the shipped default (owner ruling 2026-07-13). Only a TRULY-UNSET config
         reaches here; the deterministic 0065 floor is still the fail-soft floor underneath.

    A brand-new role has NO legacy toggle to honor (unlike ``overseer_mode``), so this is the simpler
    sibling. A broken settings read degrades to the env path and NEVER raises into the loop — config
    must never crash the turn.
    """
    # 1) the settings tier (the admin UI control). A broken read drops to the env path.
    try:
        from src.settings import get_setting, is_setting_overridden
        # Only an EXPLICITLY-saved value wins. ``faithfulness_mode`` lives in DEFAULT_SETTINGS purely so
        # the admin /api/auth/settings route (allowlisted to DEFAULT_SETTINGS) can persist it; its DEFAULT
        # value there (now "active", for the Settings UI) must NOT shadow the env/step-3 resolution, so
        # honor it only when the operator ACTUALLY saved a value (the is_setting_overridden gate).
        if is_setting_overridden("faithfulness_mode"):
            mode = get_setting("faithfulness_mode", None)
            if isinstance(mode, str) and mode in FAITHFULNESS_MODES:
                return mode
    except Exception:
        pass
    # 2) the headless env knob.
    env_mode = os.getenv("ORWELL_FAITHFULNESS_MODE")
    if env_mode is not None and env_mode.strip().lower() in FAITHFULNESS_MODES:
        return env_mode.strip().lower()
    # 3) the default — ACTIVE (owner ruling 2026-07-13): the judge ships on. Only a truly-unset config
    #    reaches here; an explicit setting/env value above still wins (including an explicit off).
    return "active"


def faithfulness_enabled() -> bool:
    """DEFAULT ACTIVE since the owner ruling 2026-07-13 (was opt-in/default-off). ``True`` iff the
    faithfulness mode is not ``'off'`` (``'shadow'`` or ``'active'``). Mirrors
    :func:`src.overseer.overseer_enabled` for symmetry, so callers can gate on a single boolean when
    they don't care which non-off state is live (an explicit ``off`` still disables)."""
    return faithfulness_mode() != "off"


def judge_health(owner: Optional[str] = None) -> dict:
    """F10 / BL-019 — a Vault-free health readout for the faithfulness judge, for ``/admin/status``.

    The judge silently no-ops when the mode is ``shadow``/``active`` but no model resolves (the live
    ``_faith_check`` hook just returns on ``_llm is None``) — so an anti-hallucination guard the
    operator ASKED for was DARK with nothing signalling it. This surfaces the state so it can FAIL
    LOUD (a health section + a RED alarm) instead of being an invisible no-op.

    Returns Vault-free config posture only::

      {mode, enabled, dedicatedModel, dedicatedEndpointConfigured, modelResolvable, dark}

    ``modelResolvable`` mirrors the live resolution order (``faithfulness`` → ``utility`` → ``default``
    via ``resolve_endpoint``; the judge can run if ANY yields a usable non-image chat model) using a
    cheap DB resolve — no network, no model call. ``dark`` == ``enabled and not modelResolvable`` is
    THE loud signal. Fail-soft: any error degrades to a safe posture and never raises into the poll."""
    mode = faithfulness_mode()
    enabled = mode != "off"
    out: dict = {"mode": mode, "enabled": enabled}

    ded_model = ded_ep = ""
    try:
        from src.settings import get_setting
        ded_model = (get_setting("faithfulness_model", "") or "").strip()
        ded_ep = (get_setting("faithfulness_endpoint_id", "") or "").strip()
    except Exception:
        pass
    out["dedicatedModel"] = ded_model or None       # PRESENCE/identity only — a model slug, never a secret
    out["dedicatedEndpointConfigured"] = bool(ded_ep)

    model_resolvable = False
    try:
        from src.endpoint_resolver import resolve_endpoint
        url, model, _ = resolve_endpoint("faithfulness", owner=owner)
        if not (url and model):
            url, model, _ = resolve_endpoint("default", owner=owner)
        if url and model:
            try:
                from src.orwell_portraits import _is_image_model
                model_resolvable = not _is_image_model(model)
            except Exception:  # failsoft-ok: expected-empty (can't classify the model ⇒ assume a usable chat model resolved; this is the health READER, the `dark` flag is the loud signal)
                model_resolvable = True
    except Exception:  # failsoft-ok: expected-empty (this IS the health reporter — an unresolvable model reads as modelResolvable=False, which makes an enabled judge report dark + fires the RED faithfulness-judge-dark alarm; nothing is swallowed)
        model_resolvable = False
    out["modelResolvable"] = model_resolvable

    # DARK: the operator enabled the judge (shadow/active) but no model can run it — the guard is
    # silently a no-op. This is the fail-loud flag the health surface + alarm key on.
    out["dark"] = bool(enabled and not model_resolvable)
    return out


# Feature 0081 / owner ruling O1 — the configurable fallback for a CLOSED-set slip with NO plausible
# in-fiction reframe. ALL THREE keep the engine truth UNBENT; they differ only in what the player sees
# next turn:
#   'reground'  — re-inject the board truth as a SILENT next-turn re-ground (default).
#   'log-only'  — record the violation and take no corrective action.
#   'visible'   — steer a brief, in-character course-correction the player can see.
FAITH_UNREFRAMABLE_MODES = ("reground", "log-only", "visible")


def faithfulness_unreframable_mode() -> str:
    """Resolve the un-reframable-fallback mode (one of :data:`FAITH_UNREFRAMABLE_MODES`; owner ruling
    O1). Settings ``faithfulness_unreframable`` wins, env ``ORWELL_FAITHFULNESS_UNREFRAMABLE`` is the
    headless fallback, default ``'reground'``. Fail-soft — a broken read degrades to the default and
    never raises. None of the three ever bends a closed-set outcome; the engine's result always
    stands."""
    try:
        from src.settings import get_setting
        m = get_setting("faithfulness_unreframable", None)
        if isinstance(m, str) and m in FAITH_UNREFRAMABLE_MODES:
            return m
    except Exception:
        pass
    env = os.getenv("ORWELL_FAITHFULNESS_UNREFRAMABLE")
    if env is not None and env.strip().lower() in FAITH_UNREFRAMABLE_MODES:
        return env.strip().lower()
    return "reground"


# ── the faithfulness verdict contract (the *what*) ─────────────────────────────────

# The four ways narration can be UNfaithful — the dimensions the judge evaluates.
#   board    — contradicts a board fact (who is HOH / nominated / veto holder / evicted / the vote).
#   persona  — a houseguest acts against their established PUBLIC persona.
#   leak     — asserts hidden machinery or a fact with no in-fiction pathway to the player.
#   omission — a beat the board says is pending was narrated around but not advanced.
#   time     — (ORW-434) states a part of day, a schedule placement (today/tomorrow), or a sleeping
#              houseguest speaking/acting, that contradicts the projection's `time` block.
FAITH_DIMENSIONS = ("board", "persona", "leak", "omission", "time")

# The ADR-0005 classification of a detected slip. 'open' = texture the engine never owned; 'closed' =
# an actual outcome/state the engine owns; 'none' = no slip. This is THE split the whole role turns
# on: open slips may be adopted as canon, closed slips may only be reframed/re-grounded — never bent.
FAITH_CLASSES = ("open", "closed", "none")

# The correction levers — the *small hands* for this role.
#   none     — the narration is faithful; nothing to do (the healthy turn).
#   adopt    — an OPEN-set slip: canonicalize the narrated detail (wired in P3). ONLY valid for 'open'.
#   reframe  — a CLOSED-set slip with a plausible in-fiction reinterpretation (irony/rumor/misbelief).
#   reground — a CLOSED-set slip with no plausible reframe: re-ground the model next turn (P4).
# THE WALL (mandate #3): no lever changes a closed-set OUTCOME, and 'adopt' is rejected for any
# classification other than 'open' (enforced in ``verdict_from_reply``). The engine's result stands.
FAITH_LEVERS = ("none", "adopt", "reframe", "reground")


def dimensions_for(context: str = "in-game") -> tuple:
    """The dimensions a junction may use. ORW-434: `time` is judged only in-game (the casting interview has no time block, and its
    prompt does not define the dimension), so it is never offered or accepted there."""
    return tuple(d for d in FAITH_DIMENSIONS if d != "time") if context == "casting" else FAITH_DIMENSIONS


@dataclass(frozen=True)
class FaithfulnessVerdict:
    """The judge's conclusion on ONE narration turn: which dimension is unfaithful (if any), the
    ADR-0005 classification, exactly one lever, and a one-line rationale. All fields are Vault-free
    tokens — they hand off straight to the log ring. ``rationale`` is the model's open-set 'why'; it
    never carries a number or a magnitude (the engine owns those)."""

    dimension: str        # one of FAITH_DIMENSIONS, or "none"
    classification: str   # one of FAITH_CLASSES
    lever: str            # one of FAITH_LEVERS
    rationale: str = ""
    confident: bool = True

    @property
    def is_slip(self) -> bool:
        """True iff this verdict names a real slip to act on — a concrete lever AND a concrete
        classification. ``none``/``none`` is the healthy turn (logged by no one)."""
        return self.lever != "none" and self.classification != "none"


# ORW-434: the projection cap is enforced STRUCTURALLY (whole list entries dropped, oldest first) so the
# serialized JSON always parses; a plain string cut used to chop the knowledge list mid-string.
_LIST_PATHS = (("visible", "knowledge"), ("knowledge",), ("visible", "visibleEvents"), ("visibleEvents",),
               ("roster",))


def _dump(projection: Any) -> str:
    return json.dumps(projection, sort_keys=True, default=str)


def _list_at(obj: Any, path: tuple):
    for k in path:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj if isinstance(obj, list) else None


def serialize_projection(projection: Any, cap: int) -> str:
    """Serialize ``projection`` to JSON of at most ``cap`` characters that ALWAYS parses. Over the cap, drop
    whole entries from the FRONT (oldest first) of the knowledge list, then the visible events, then the
    roster; if still over, fall back to the board and time blocks alone, then ``{}``. Never mutates input."""
    try:
        out = _dump(projection)
        if len(out) <= cap or not isinstance(projection, dict):
            return out if len(out) <= cap else "{}"
        work = json.loads(out)                        # a private deep copy: the caller's dict is untouched
        for path in _LIST_PATHS:
            lst = _list_at(work, path)
            if not lst:
                continue
            lo, hi = 0, len(lst)                      # smallest number of oldest entries to drop that fits
            while lo < hi:
                mid = (lo + hi) // 2
                lst2 = lst[mid:]
                parent = work
                for k in path[:-1]:
                    parent = parent[k]
                parent[path[-1]] = lst2
                if len(_dump(work)) <= cap:
                    hi = mid
                else:
                    lo = mid + 1
            parent = work
            for k in path[:-1]:
                parent = parent[k]
            parent[path[-1]] = lst[lo:]
            out = _dump(work)
            if len(out) <= cap:
                return out
        core = {k: work[k] for k in ("board", "time") if k in work}
        out = _dump(core)
        return out if len(out) <= cap else "{}"
    except Exception:
        return "{}"


# ── the sparse trigger (the *when*) ────────────────────────────────────────────────


def should_judge(*, claim_bearing: bool, engaged_scene: bool) -> bool:
    """The cheap precondition for waking the faithfulness judge (parallel to
    :func:`src.overseer.should_assess`): run ONLY on turns where faithfulness is at stake — a turn
    that made a closed-set board claim (the model asserted an outcome) OR an engaged player↔NPC scene
    (where persona / leak / omission slips live). A pure lull with neither trips nothing, so the judge
    stays sparse in time even though its coverage is wide. Fail-soft: a bad input never raises."""
    try:
        return bool(claim_bearing) or bool(engaged_scene)
    except Exception:
        return False


# ── the active-mode dispatch seam (the *act*) — trigger-only, mandate-walled ────────


def dispatch_correction(verdict, actions: dict) -> dict:
    """Feature 0081 ``active``-mode dispatch seam — route a :class:`FaithfulnessVerdict` to the
    caller's correction action for its lever. Mirrors :func:`src.overseer.dispatch_lever`.

    ``actions`` maps ``{lever_name -> zero-arg callable}`` where each callable PERFORMS the diegetic
    correction (``adopt`` → canonicalize the open-set detail via recordInteraction; ``reframe`` /
    ``reground`` → queue the next-turn re-ground) and returns a truthy "applied" signal. This function
    looks up ``verdict.lever`` and INVOKES its callable — nothing else.

    **Trigger-only by construction (mandate #3):** it only *invokes* the caller's callable; it NEVER
    bends an outcome, computes a magnitude, or authors content. THE WALL is upstream —
    :meth:`FaithfulnessJudge.verdict_from_reply` already rejected ``adopt`` for any non-``open`` slip —
    so by the time a verdict reaches here an ``adopt`` lever is guaranteed open-set.

    Returns ``{'lever': str, 'applied': bool, 'reason': str}``. ``'none'`` (and a ``None``/garbage
    verdict, or no action provided for the lever) is a no-op. **Fail-soft:** a raising callable ⇒
    ``applied=False`` (swallowed, never propagated)."""
    lever = getattr(verdict, "lever", None)
    if not isinstance(lever, str) or lever not in FAITH_LEVERS:
        return {"lever": str(lever) if lever is not None else "", "applied": False,
                "reason": "no lever to dispatch"}
    if lever == "none":
        return {"lever": lever, "applied": False, "reason": "none — no correction"}
    action = actions.get(lever) if isinstance(actions, dict) else None
    if action is None:
        # In P3 only 'adopt' is wired; 'reframe'/'reground' land in P4 — until then, no-op (not error).
        return {"lever": lever, "applied": False, "reason": "no action provided for lever"}
    try:
        applied = bool(action())   # TRIGGER-ONLY: invoke the caller's diegetic correction.
        return {"lever": lever, "applied": applied,
                "reason": "applied" if applied else "action declined"}
    except Exception as e:
        return {"lever": lever, "applied": False, "reason": f"{type(e).__name__}: {e}"}


# ── the port + the deterministic stub (the *what*, no model) ───────────────────────


class FaithfulnessJudgePort(Protocol):
    def assess(self, narration: str, projection: Any = None) -> Optional["FaithfulnessVerdict"]: ...


class DeterministicFaithfulnessJudge:
    """The stub adapter — NEVER calls a model and NEVER flags a slip (always ``None``). Seeded /
    no-model lanes wire this, so the faithfulness role is a pure no-op there and the lanes stay
    byte-identical (the live-only carve-out, ruling D4). The deterministic FLOOR for closed-set board
    lies already exists separately as the 0065 pre-emission guard; this judge adds only the LIVE
    semantic layer on top, so with no model there is simply nothing extra to do."""

    def assess(self, narration: str = "", projection: Any = None) -> Optional["FaithfulnessVerdict"]:
        return None


class FaithfulnessJudge:
    """The reasoning tier — an injected ``llm_fn`` judges the narration against the player's Vault-free
    PROJECTION only and proposes one lever. **Vault-free by construction**: the judge holds no Vault
    handle; it can only reason over the narration + the projection the caller passes, so a leak is
    caught as "an assertion beyond what the player legitimately knows", never by reading the Vault.

    **Fail-soft and walled**: any error, unparseable reply, or out-of-contract field routes to the
    ``fallback`` (default :class:`DeterministicFaithfulnessJudge` ⇒ ``None``). A reply can NEVER bend a
    closed-set outcome (no lever does that), and an ``adopt`` proposed for a non-open slip is rejected
    to the floor — the one move the role must never make."""

    _MAX_NARRATION = 4000   # bound the narration we judge (cost + prompt-size guard)
    _MAX_PROJECTION = 6000   # bound the serialized projection

    # The dimension descriptions per JUNCTION context — the four labels (FAITH_DIMENSIONS) are stable,
    # but what each means depends on where the narration happens, so the casting interview isn't judged
    # against an in-game board it has no concept of (P5: the casting / premiere / preview junctions).
    _DIMENSION_HELP = {
        "in-game": (
            "board=contradicts a board fact (HOH/noms/veto/eviction/vote/winner); persona=a houseguest "
            "acts against their established PUBLIC persona; leak=asserts hidden machinery or a fact "
            "with no in-fiction pathway to the player; omission=a pending beat was narrated around but "
            "not advanced; time=the narration states a part of day or a today/tomorrow schedule placement that "
            "contradicts the projection's `time` block (partOfDay, nextEvent), or has a houseguest listed in "
            "`time.asleep` speaking, moving or acting as awake. The `time` block is the state at the END of the "
            "turn, and one narration may cover EARLIER moments of the same turn (an earlier part of the day, a "
            "houseguest speaking just before going to sleep, a day that advanced): flag a time claim only when it "
            "cannot be true at ANY point of the turn. If `time.partOfDayAtStart` is present, the turn crossed a time "
            "change: a part of day between that start and the end is also valid."),
        "casting": (
            "board=contradicts a casting fact the player gave (their name, stated background, strategy "
            "or preferences); persona=the producer breaks the casting-interview producer voice; "
            "leak=reveals hidden casting/seeding machinery or pre-decides the cast; omission=re-asks or "
            "ignores something the player already answered."),
    }

    def __init__(self, llm_fn, fallback: Optional[FaithfulnessJudgePort] = None):
        self._llm_fn = llm_fn
        self._fallback: FaithfulnessJudgePort = fallback or DeterministicFaithfulnessJudge()

    # -- prompt construction (Vault-free: only the caller-supplied narration + projection) --------

    def _prompt(self, narration: str, projection: Any, context: str = "in-game") -> str:
        narr = (narration or "")[: self._MAX_NARRATION]
        proj = serialize_projection(projection, self._MAX_PROJECTION)
        dim_help = self._DIMENSION_HELP.get(context, self._DIMENSION_HELP["in-game"])
        where = ("the CASTING INTERVIEW (before the game starts)" if context == "casting"
                 else "a live Big Brother game")
        return (
            f"You are the NARRATION-FAITHFULNESS judge for {where}. You are given (1) the NARRATION "
            "just shown to the player and (2) the player's Vault-free PROJECTION — what the player "
            "legitimately knows + the relevant engine state. Judge ONLY whether the narration is "
            "faithful to that projection. You never receive hidden/secret state, so treat any "
            "assertion that goes BEYOND the projection as a potential leak, never as fact.\n"
            "Decide three things:\n"
            f"  dimension: one of {list(dimensions_for(context))} or \"none\" — {dim_help}\n"
            f"  classification: one of {list(FAITH_CLASSES)} — open=texture the engine never decided "
            "(a detail/flavor/minor social beat); closed=an actual outcome or state the engine owns.\n"
            f"  lever: one of {list(FAITH_LEVERS)} — none=faithful; adopt=an OPEN-set slip, make the "
            "detail canon (ONLY valid when classification=open); reframe=a CLOSED-set slip you can "
            "reinterpret in-fiction (irony/rumor/misbelief); reground=a CLOSED-set slip with no "
            "plausible reframe.\n"
            "You may NEVER change a closed-set OUTCOME to match the narration — the engine's result "
            "stands; reframe/reground only change how the narration is read next, never the board.\n"
            'Reply with ONE JSON object: {"dimension":"...","classification":"...","lever":"...",'
            '"rationale":"<one line>"}.\n'
            "NARRATION:\n" + narr + "\nPROJECTION:\n" + proj
        )

    def build_prompt(self, narration: str, projection: Any = None, context: str = "in-game") -> str:
        """Public alias of the Vault-free prompt builder, so the live async hook can drive the model
        call itself (await) and reuse the EXACT same prompt as :meth:`assess`. ``context`` selects the
        junction framing (``in-game`` default, or ``casting``)."""
        return self._prompt(narration, projection, context)

    # -- reply parsing (strict: out-of-contract => fallback; the adopt wall) -----------------------

    @staticmethod
    def _extract_json(text) -> Optional[dict]:
        """Parse the first JSON object out of the model reply. ``None`` if there is none / it is not
        an object — which routes the caller to the deterministic fallback."""
        if not isinstance(text, str):
            return None
        try:
            obj = json.loads(text)
            return obj if isinstance(obj, dict) else None
        except Exception:
            pass
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            try:
                obj = json.loads(text[start : end + 1])
                return obj if isinstance(obj, dict) else None
            except Exception:
                return None
        return None

    def verdict_from_reply(
        self, raw, narration: str = "", projection: Any = None, context: str = "in-game"
    ) -> Optional["FaithfulnessVerdict"]:
        """Turn a model reply into a :class:`FaithfulnessVerdict`, STRICTLY. An unparseable reply or
        any out-of-contract token routes to the fallback. THE WALL: an ``adopt`` lever paired with any
        classification other than ``open`` is rejected to the floor — a misnarration may never
        canonicalize a closed-set outcome (mandate #3). Exposed alongside :meth:`build_prompt` so the
        async live hook reuses the identical validation as the sync :meth:`assess` path."""
        try:
            parsed = self._extract_json(raw)
            if not parsed:
                return self._fallback.assess(narration, projection)

            dimension = parsed.get("dimension")
            classification = parsed.get("classification")
            lever = parsed.get("lever")
            rationale = parsed.get("rationale", "")

            # Strict contract: every token must be in-set (dimension may also be the inert "none").
            if dimension != "none" and dimension not in dimensions_for(context):
                return self._fallback.assess(narration, projection)
            if classification not in FAITH_CLASSES:
                return self._fallback.assess(narration, projection)
            if lever not in FAITH_LEVERS:
                return self._fallback.assess(narration, projection)
            if not isinstance(rationale, str):
                rationale = ""

            # THE WALL (mandate #3): 'adopt' is only ever valid for an OPEN-set slip. A reply that
            # proposes adopting a CLOSED-set (or unclassified) slip is rejected — the one thing the
            # role must never do is let a misnarration canonicalize a closed-set outcome.
            if lever == "adopt" and classification != "open" and dimension != "time":
                return self._fallback.assess(narration, projection)

            # ORW-434: a time slip (part of day, schedule placement, a sleeper acting) is an engine-owned
            # CLOSED fact: it is never adopted as canon. A non-clean time verdict uses the SAME lever a board
            # contradiction that needs the narrator re-grounded uses (reground); never a new lever.
            # A self-contradictory reply (lever without a classification, or the reverse) is not a slip - the same both-set
            # rule as every other dimension (`FaithfulnessVerdict.is_slip`).
            if dimension == "time" and lever != "none" and classification != "none":
                classification, lever = "closed", "reground"

            return FaithfulnessVerdict(
                dimension=dimension if dimension in FAITH_DIMENSIONS else "none",
                classification=classification,
                lever=lever,
                rationale=rationale[:400],
            )
        except Exception:
            try:
                return self._fallback.assess(narration, projection)
            except Exception:
                return None

    def assess(self, narration: str, projection: Any = None,
               context: str = "in-game") -> Optional["FaithfulnessVerdict"]:
        """Sync judge: build the Vault-free prompt, call the model, validate. Fail-soft to the
        deterministic floor on any error. The trigger (:func:`should_judge`) is checked by the CALLER
        (the live hook), since its inputs come from the turn, not from the narration alone."""
        try:
            raw = self._llm_fn(self._prompt(narration, projection, context))
            # The resolved completion fn is ASYNC (orwell_cast_authoring._resolve_llm_fn._fn), so the
            # call returns a COROUTINE — passing it straight to verdict_from_reply parses a coroutine
            # as a reply (always None), silently breaking the sync judge. Resolve an awaitable result
            # before validating.
            if inspect.isawaitable(raw):
                try:
                    asyncio.get_running_loop()
                    loop_running = True
                except RuntimeError:
                    loop_running = False
                if loop_running:
                    # assess() is the SYNC entrypoint (live code uses the async _faith_check). Inside a
                    # running loop we cannot block to await — #1599: be LOUD + fall to the floor, never
                    # silently None. Close the orphaned coroutine to avoid a 'never awaited' warning.
                    if hasattr(raw, "close"):
                        try:
                            raw.close()
                        except Exception:
                            pass
                    _record_faith_guard_down(
                        "faith:sync-in-async",
                        "faithfulness sync assess() called inside a running event loop — cannot "
                        "resolve the async judge; use the async _faith_check hook. Guard down for "
                        "this turn.")
                    return self._fallback.assess(narration, projection)
                raw = asyncio.run(raw)
            return self.verdict_from_reply(raw, narration, projection, context)
        except Exception as _err:
            # #1599: a genuine judge-call error is the grounding guard going down — be LOUD, never a
            # silent swallow. Still fail-soft to the deterministic floor for the turn. (A merely
            # unparseable/out-of-contract reply is NOT an error — verdict_from_reply routes that to
            # the floor without raising, so it does not reach here and is not flagged.)
            _record_faith_guard_down(
                "faith:call-failed",
                f"faithfulness judge could not run (guard down): {type(_err).__name__}: {_err}")
            try:
                return self._fallback.assess(narration, projection)
            except Exception:
                return None
