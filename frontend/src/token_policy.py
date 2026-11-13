"""Token policy resolver (ADR 0010 / feature 0069, slice B).

The single place that maps a *call class* to its LLM spend posture — reasoning
budget, output cap, caching, and context budget. This replaces the scattered
``max_tokens`` constants at the call sites and is the seam through which a
``reasoning`` budget is finally sent per class (the dominant, currently-unmanaged
cost lever on a reasoning model).

Owner-ratified reasoning efforts (2026-06-21, ADR 0010 *Owner rulings* #1):
narration = **medium**, utility-extraction = off/minimal, casting = **medium**,
background-authoring = **low**. BOTH the per-class reasoning budget AND the
per-class ``max_tokens`` output cap are **admin-editable at runtime** — the
resolver reads overrides from a settings dict the caller passes in
(``reasoning_budget`` and ``max_tokens_budget``, each a ``{call_class: value}``
map). This module stays **pure**: it imports nothing (in particular nothing from
``settings.py``); the constants here are only the *defaults* the settings override.

Contract (ADR 0010 §5):
    resolve_token_policy(call_class, settings) ->
        {"reasoning": <dict|None>, "max_tokens": int|None,
         "caching": bool, "context_budget": int|None}

``max_tokens`` is ``None`` for a class whose default is "use the model-aware cap" (narration,
casting) when there is NO in-band admin override — the call site substitutes a model-sized
default (full reasoning+answer headroom). An explicit, in-band ``max_tokens_budget`` override
yields a positive int and always wins.

``reasoning`` is the OpenRouter form ``{"effort": "low"|"medium"|"high"}`` or
``None`` when the effort is ``"off"`` (the field is omitted from the payload).
Pure and side-effect-free.

Model-aware sizing (ADR 0010 follow-on #2) lives in this same pure module:
``resolve_output_cap(model)`` (the folded #481 4096→8192 stopgap, now a family-sized
computed default) and ``resolve_reasoning_max_tokens(output_cap)`` (the reasoning
sub-budget, hard-bounded so it can never starve the visible reply — the F-S4-D
mechanism). The call site (``llm_core``) knows the concrete model, so it passes the
resolved cap in; the numbers themselves are owned here, never at the call site.
"""

from __future__ import annotations

# The four call classes the whole FE LLM boundary is partitioned into.
CALL_CLASSES = ("narration", "utility-extraction", "casting", "background-authoring")

# OpenRouter reasoning form is {"effort": "low"|"medium"|"high"} or omitted.
_DEFAULT_EFFORT = {
    "narration": "medium",
    "utility-extraction": "off",  # off (not low): pure extraction/classification (moves/deals/scene);
                                  # the prompts forbid thinking and the 2026-06-21 I/O trace showed it wasted.
    "casting": "medium",
    "background-authoring": "low",
}
# The per-class default output cap. ``None`` means "use the caller's model-aware default" — the
# resolver leaves ``max_tokens`` as ``None`` so the call site (which knows the concrete model)
# substitutes ``llm_core._model_max_output_tokens(model)`` (a generous, model-sized cap). A flat
# constant here re-introduced the #835 truncation vector for reasoning models (deepseek-v4-pro
# counts reasoning+visible against ``max_tokens``, so a flat 4096 truncated narration mid-reply —
# the #620 NARR-5 warning). ``narration``/``casting`` therefore default to ``None`` (full model
# headroom for reasoning + answer); the short, non-reasoning utility/background classes keep their
# tight literal caps. An EXPLICIT, in-band admin override (``max_tokens_budget[class]``) still wins
# for ANY class — that is the point of ADR 0010 #1 — and the resolved value is recorded in the
# ledger's ``appliedMaxTokens``.
_DEFAULT_MAX_TOKENS = {
    "narration": None,  # ⇒ model-aware default at the call site (full reasoning+answer headroom)
    "utility-extraction": 1500,
    "casting": None,    # ⇒ model-aware default (same reasoning-truncation applies; turns are short)
    # #1002: a full authored JSON profile (name + 2-3 sentence bio + vocation + 7 physical facets +
    # 2-3 secrets + 2 goals + weakness) is several hundred output tokens of strict JSON; on a REASONING
    # utility model (deepseek-v4-pro) reasoning tokens count against this same cap, so a tight 1200
    # cap risked the reasoning eating the budget and leaving an empty/truncated visible body (the exact
    # silent no-op #1002 chased). Raised to a comfortable floor so a reasoning model can both think a
    # little (effort stays "low" for this structured task) AND emit the whole JSON object.
    "background-authoring": 3000,
}
# "off" -> reasoning omitted (None). The full set of admin-acceptable values.
_VALID_EFFORTS = ("off", "low", "medium", "high")

# Admin-acceptable bounds for a per-class ``max_tokens`` override. An override outside this
# inclusive band (or a non-int / non-positive value) is rejected and the class default stands —
# a fat-fingered 0 / negative / 10_000_000 can never become the live output cap.
_MIN_MAX_TOKENS = 256
_MAX_MAX_TOKENS = 200_000

# ── 0116 cast-genesis sketch sizing + the length-retry ceiling (the 2026-07-13 prod fix) ──────
# The full-cast genesis SKETCH is ONE completion carrying the ENTIRE 15-NPC skeleton JSON
# (names + identities + biographies + stats + 3-6 hidden elements each + ties ≈ 12-20K chars),
# while the ``background-authoring`` class cap (3000) is sized for ONE NPC's profile JSON. Live
# prod: the sketch ended ``finish_reason=length`` at out=3000/cap=3000 — truncated JSON →
# unparseable → ``no-usable-proposal`` → committed 0 → the strict pre-finalize gate refused
# casting. The sketch call therefore carries its own FLOOR: the resolved per-class cap (admin
# override included) is raised to at least this many output tokens for the FULL-CAST call only.
# An admin ``max_tokens_budget`` override LARGER than the floor still wins (max, not replace);
# the per-NPC deep-authoring calls keep the untouched class cap (they finish well under it, and
# they are pinned at cap 3000 in the committed golden fixture — raising the CLASS default would
# stale it; the sketch call is not in the fixture).
#
# The floor MUST clear the whole-cast skeleton size with headroom. A 15-NPC skeleton (names +
# identities + biographies + 3-6 hidden elements each + banded stats + ties) measures ~4400 output
# tokens (RC3: the live 3000 cap ended finish_reason=length mid-JSON). The floor is set well above
# that so the sketch completes in ONE pass, and a length-retry (doubled cap) is the belt.
GENESIS_SKELETON_TOKEN_ESTIMATE = 4400
GENESIS_SKETCH_MIN_OUTPUT_TOKENS = 8192

# Structural guard: the sketch floor must always clear the skeleton estimate with headroom (RC3 —
# the whole starvation bug was a floor below the skeleton size). A regression that lowers the floor
# under the estimate trips this at import time, never silently at runtime.
assert GENESIS_SKETCH_MIN_OUTPUT_TOKENS >= GENESIS_SKELETON_TOKEN_ESTIMATE, (
    "the cast-genesis sketch output floor must clear the 15-NPC skeleton estimate")

# When any JSON-authoring completion ends ``finish_reason=length`` (the model was CUT OFF by the
# output cap, so the body is chopped mid-JSON and unparseable), the call is re-issued EXACTLY ONCE
# at double its cap — never above this ceiling, and never more than one retry per call.
LENGTH_RETRY_MAX_TOKENS = 16000

# The class whose defaults stand in for an unknown call class (never crash).
_FALLBACK_CLASS = "narration"


def valid_efforts() -> tuple[str, ...]:
    """The admin-acceptable reasoning-effort values (for the settings UI/tests)."""
    return _VALID_EFFORTS


def max_tokens_bounds() -> tuple[int, int]:
    """The admin-acceptable ``max_tokens`` override band (inclusive) — for the settings UI/tests."""
    return (_MIN_MAX_TOKENS, _MAX_MAX_TOKENS)


def _valid_max_tokens(v) -> bool:
    """True iff ``v`` is an in-band positive integer admissible as a ``max_tokens`` override.
    ``bool`` is rejected (a stray ``True``/``False`` is never a token count)."""
    if isinstance(v, bool) or not isinstance(v, int):
        return False
    return _MIN_MAX_TOKENS <= v <= _MAX_MAX_TOKENS


def _effort_to_reasoning(effort: str) -> dict | None:
    """Map a (validated) effort to the OpenRouter ``reasoning`` map, or None for ``off``."""
    if effort == "off":
        return None
    return {"effort": effort}


def resolve_token_policy(call_class: str, settings: dict | None = None) -> dict:
    """Resolve the token policy for ``call_class``.

    Returns ``{"reasoning": <dict|None>, "max_tokens": int, "caching": bool,
    "context_budget": int|None}``:

    - ``reasoning``: ``{"effort": "low"|"medium"|"high"}`` per the effort, or
      ``None`` when the effort is ``"off"`` (the field is omitted from the payload).
      No class is ever default-by-omission — every class names an explicit posture.
    - ``max_tokens``: the per-class output cap — admin-editable at runtime (see below). It is
      ``None`` when the class default is "use the caller's model-aware cap" (narration, casting)
      and there is no in-band override — the call site fills in a model-sized default so a
      reasoning model has room to think AND answer (the alternative, a flat literal, truncated
      reasoning-model narration mid-reply — #835/#620 NARR-5). An in-band override is a positive int.
    - ``caching``: ``True`` for all classes (provider-automatic; the live model caches).
    - ``context_budget``: ``None`` — computed elsewhere by ``context_budget.py``;
      a reserved hook so the contract is stable.

    Admin overrides (both per-class, both defensively read, both wins-over-default):
    - ``settings["reasoning_budget"][call_class]`` — one of ``valid_efforts()``.
    - ``settings["max_tokens_budget"][call_class]`` — an in-band positive int
      (``max_tokens_bounds()``); out-of-band / non-int / non-positive ⇒ class default
      (which, for narration/casting, is ``None`` ⇒ the call site's model-aware cap).

    An unknown/garbage override falls back to the class default; an unknown
    ``call_class`` falls back to the ``"narration"`` defaults. Defensive: ``settings``
    may be ``None``, may lack either key, or may not be a dict — this never raises.

    Pure and side-effect-free.
    """
    # An unknown call class falls back to the narration defaults (never crash).
    resolved_class = call_class if call_class in _DEFAULT_EFFORT else _FALLBACK_CLASS

    effort = _DEFAULT_EFFORT[resolved_class]
    max_tokens = _DEFAULT_MAX_TOKENS[resolved_class]

    # Admin overrides, defensively read. Any malformed shape -> keep the default.
    if isinstance(settings, dict):
        overrides = settings.get("reasoning_budget")
        if isinstance(overrides, dict):
            candidate = overrides.get(call_class)
            if candidate in _VALID_EFFORTS:
                effort = candidate
        mt_overrides = settings.get("max_tokens_budget")
        if isinstance(mt_overrides, dict):
            mt_candidate = mt_overrides.get(call_class)
            if _valid_max_tokens(mt_candidate):
                max_tokens = mt_candidate

    return {
        "reasoning": _effort_to_reasoning(effort),
        "max_tokens": max_tokens,
        "caching": True,
        "context_budget": None,
    }


# ---------------------------------------------------------------------------
# Model-aware OUTPUT cap + reasoning-budget sizing (ADR 0010 follow-on #2).
#
# Two joined jobs, both folded HERE out of scattered ``llm_core`` literals so the
# resolver is the single source of the numbers (a *computed policy*, never a magic
# literal at the call site):
#
#   1. ``resolve_output_cap(model)`` — the model-aware DEFAULT output ceiling. The
#      Anthropic builder REQUIRES an explicit ``max_tokens`` and 400s if it exceeds
#      the family hard cap; the OpenAI/OpenRouter path uses it as the model-sized
#      default when no explicit cap is set. This is PR #481's 4096→8192 stopgap
#      folded into a family table with a conservative 8192 floor for anything
#      unrecognized (so an unknown model is never sent a value that 400s).
#
#   2. ``resolve_reasoning_max_tokens(output_cap)`` — the reasoning SUB-budget, sized
#      as a fraction of the resolved model's output cap and hard-bounded so a fixed
#      share of that budget is ALWAYS reserved for the visible reply. A reasoning
#      model bills its hidden chain-of-thought against the SAME output budget as the
#      answer, so an unbounded think starves the reply mid-sentence (the F-S4-D
#      truncation, #835/#620 NARR-5). Bounding reasoning below the reply reserve is
#      the structural cure — the reply is guaranteed room by construction, not by
#      luck or by a bigger flat cap.
#
# No number computed here EVER reaches the player (mandate #3; ADR 0010 Principle 6):
# these only shape the provider request. Pure integer arithmetic — this module still
# imports nothing.
# ---------------------------------------------------------------------------

# The conservative floor supported by every modern Claude model (the folded #481 stopgap).
_DEFAULT_OUTPUT_CAP = 8192
# (substring, cap) — checked in order; the FIRST hit wins, so the most-specific/limited
# qualifier must come first (Haiku-3/3.5 caps at 8192 even though "claude-…-4-…" patterns
# are 32K+). Generous-but-safe per-family reasoning+answer headroom, all under each hard cap.
_OUTPUT_CAP_BY_FAMILY = (
    ("haiku-3", 8192),       # Haiku 3 / 3.5 — 8192 hard cap
    ("claude-3-5", 8192),    # other Claude-3.5 snapshots — 8192
    ("opus-4", 32768),       # Opus 4.x — supports up to 128K; 32K is a safe, generous floor
    ("sonnet-4", 32768),     # Sonnet 4.x — up to 64K; 32K floor
    ("haiku-4", 16384),      # Haiku 4.x — up to 64K; 16K floor (Haiku answers are shorter)
)

# Reasoning-budget sizing knobs. The reasoning sub-budget is a fraction of the output cap,
# clamped to [floor, ceil], then hard-bounded so at least ``_REPLY_RESERVE_FRACTION`` of the
# output cap always survives for the visible reply. Retune here without touching a call site.
#   reasoning = min( clamp(FRACTION × cap, FLOOR, CEIL),  cap − ceil(RESERVE_FRACTION × cap) )
# so the reply keeps ≥ RESERVE_FRACTION of the cap always, and ≥ (1 − FRACTION) of it whenever
# the fraction (not the floor) binds — i.e. ≥ half in the common case.
_REASONING_OUTPUT_FRACTION = 0.5   # nominally, up to half the output budget may go to thinking
_REASONING_FLOOR = 1024            # even a tiny model keeps *some* room to think…
_REASONING_CEIL = 32000            # …but never budget an unbounded think (also stays under caps)
_REPLY_RESERVE_FRACTION = 0.4      # ≥40% of the output cap is ALWAYS reserved for the reply


def resolve_output_cap(model: str) -> int:
    """The model-aware DEFAULT output ceiling for ``model`` (ADR 0010 follow-on #2).

    Used as the ``max_tokens`` default when the caller set no explicit cap: the Anthropic
    builder requires an explicit value (and 400s above the family hard cap), while the
    OpenAI/OpenRouter path applies it only when > 0. Sized per model family so a reasoning
    model has room to think AND answer; unknown models fall back to the conservative 8192
    floor (the folded #481 stopgap — no hardcoded literal at the call site anymore).
    Pure and side-effect-free."""
    m = (model or "").lower()
    for needle, cap in _OUTPUT_CAP_BY_FAMILY:
        if needle in m:
            return cap
    return _DEFAULT_OUTPUT_CAP


def resolve_reasoning_max_tokens(output_cap: int) -> int:
    """The model-aware reasoning SUB-budget, sized so it can NEVER starve the visible reply.

    Given the effective output cap (``resolve_output_cap(model)`` when no explicit cap is set,
    else the explicit per-request/admin cap), return a reasoning token budget that is a fraction
    of that cap, clamped to [``_REASONING_FLOOR``, ``_REASONING_CEIL``], then hard-bounded so at
    least ``_REPLY_RESERVE_FRACTION`` of the output cap is left for the answer. This is the F-S4-D
    guarantee expressed as a number: reasoning + reply share one budget on a reasoning model, so
    bounding reasoning below the reply's reserved headroom keeps the answer from being truncated
    mid-sentence (#835/#620). The reply always keeps ≥ ``_REPLY_RESERVE_FRACTION`` of the cap;
    with the 0.5 fraction and 0.4 reserve it keeps ≥ half whenever the fraction binds.

    Defensive: a non-positive/garbage ``output_cap`` falls back to the conservative default cap so
    the caller always gets a sane, positive budget. Pure and side-effect-free."""
    if not isinstance(output_cap, int) or isinstance(output_cap, bool) or output_cap <= 0:
        output_cap = _DEFAULT_OUTPUT_CAP
    # Headroom the reply keeps no matter what: ceil(output_cap × reserve_fraction) via integer math
    # (-(-a // 1) == ceil(a)), so even a small cap reserves a whole token for the reply.
    reserve = int(-(-(output_cap * _REPLY_RESERVE_FRACTION) // 1))
    budget = int(output_cap * _REASONING_OUTPUT_FRACTION)
    # Clamp to the sane thinking band…
    budget = min(max(budget, _REASONING_FLOOR), _REASONING_CEIL)
    # …then never cross into the reply's reserved headroom (this bound WINS — the reply is sacred).
    budget = min(budget, output_cap - reserve)
    return max(budget, 1)  # always a positive budget
