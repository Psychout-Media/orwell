"""Adaptive input-token budget for the agent loop (#1170).

The agent soft-trims its input context to ``agent_input_token_budget`` (default
6000). The old computation was ``min(context_length or budget, budget)``, which
made the 6000 default a hard ceiling for *every* model — so a 128K or 1M context
model was silently capped at 6000 input tokens even though it can hold far more.

This derives the effective budget from the model's discovered context window when
the user has NOT set an explicit budget, while still honouring an explicit setting
exactly (clamped to the window). Pure and side-effect free so it is unit-testable.

A subtle but high-impact trap (the live-game memory-loss / NPC-inconsistency bug):
the settings file commonly persists the *whole* merged DEFAULT_SETTINGS to disk
(settings-repair / an admin save), so ``agent_input_token_budget`` is *present* in
the file at its DEFAULT value of 6000. ``is_setting_overridden`` then reports it as
an explicit user choice, and the explicit branch clamped a 128K model back down to
6000 — re-introducing exactly the cap #1170 set out to remove (the model never sees
the conversation, so it re-improvises NPC names/cities turn to turn). So a configured
value equal to the default sentinel is treated as NON-explicit here and scales to the
window like the unset case; only a value the user genuinely changed away from the
default is honoured as explicit.
"""

from typing import Optional

# Cost-bounded ceiling for the *auto-derived* budget. Sized so the narrative
# conversation actually fits (long-context models are no longer capped at 6000)
# while keeping the per-turn prompt — and thus the bill — bounded. A 128K model
# lands here; a 1M model is held to this cap. Tunable via
# ``agent_input_token_hard_max``.
DEFAULT_HARD_MAX = 48_000
# ORW-219: with the cap on AUTO (``agent_input_token_hard_max`` unset / 0) a window this large
# (DeepSeek-class, 1M) gets the designed 0.60 x window instead of the 48K cap. Smaller windows keep 48K.
# Any explicit number the operator sets is honoured as written (48000 included).
LONG_WINDOW_TOKENS = 500_000
DEFAULT_BUDGET = 6000
# Target a sane large fraction of the model window so the full conversation is
# visible to the model (the root cause of NPC re-improvisation was a context the
# model never actually received). 0.6 leaves comfortable response + tool headroom.
DEFAULT_HEADROOM = 0.60


def compute_input_token_budget(
    configured: int,
    context_length: int,
    explicit: bool,
    *,
    default: int = DEFAULT_BUDGET,
    headroom: float = DEFAULT_HEADROOM,
    hard_max: Optional[int] = None,
) -> int:
    """Return the effective soft input-token budget.

    Args:
        configured: the value read from settings (may be the default).
        context_length: the model's discovered context window (0/unknown if none).
        explicit: True if the user explicitly set ``agent_input_token_budget``.

    Rules:
        - An explicit user budget that genuinely differs from the default sentinel
          is honoured exactly, only clamped to the model's window when that window
          is known (never send more than the model holds).
        - A "configured" value equal to the default (or no explicit override) scales
          to ``headroom`` of the context window, capped at ``hard_max`` — so
          long-context models use their capacity instead of being pinned at 6000.
        - When the window is unknown, fall back to the configured/default value
          (preserving the previous behaviour) so small/local models still trim sanely.
    """
    configured = int(configured or 0)
    context_length = int(context_length or 0)

    # A persisted-but-default value is NOT a real user override (the settings file
    # routinely carries the full default set). Only treat it as explicit when the
    # user moved it OFF the default sentinel.
    real_override = explicit and configured > 0 and configured != int(default)

    if real_override:
        return min(configured, context_length) if context_length > 0 else configured

    if context_length > 0:
        scaled = int(context_length * headroom)
        if hard_max is None or int(hard_max) <= 0:
            # AUTO (ORW-219): unset / None / 0. A window of 500K or more gets the full 0.60 x window; anything
            # smaller keeps the 48K cost-sane cap.
            if context_length >= LONG_WINDOW_TOKENS:
                return max(1, scaled)
            return max(1, min(scaled, DEFAULT_HARD_MAX))
        # An explicit number is always honoured, including 48000 on a huge window.
        return max(1, min(scaled, int(hard_max)))

    return configured if configured > 0 else default


# Slice D / ADR 0010 Decision D — the ceiling the lean budget is allowed to
# *escalate* to before lossy compaction kicks in. Owner ruling 2: opt-in, grow
# toward ~0.85× of the model window so a long-context model uses its capacity to
# keep the full conversation (non-degradation, mandate #4) instead of summarizing
# detail away. Tunable; the default stays byte-identical (escalation is off).
DEFAULT_TIER_CEILING = 0.85


def _coerce_int(value: object) -> int:
    """Best-effort int coercion that never raises (garbage/None -> 0)."""
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _coerce_ceiling(ceiling: object, *, fallback: float = DEFAULT_TIER_CEILING) -> float:
    """Clamp the tier ceiling into (0, 1]; non-finite/<=0 -> fallback; >1 -> 1.0."""
    try:
        c = float(ceiling)
    except (TypeError, ValueError):
        return fallback
    # NaN / inf are non-finite (NaN fails every comparison -> caught here).
    if not (c == c) or c in (float("inf"), float("-inf")):
        return fallback
    if c <= 0:
        return fallback
    if c > 1:
        return 1.0
    return c


def escalate_budget(
    lean_budget: int,
    needed_tokens: int,
    context_length: int,
    *,
    enabled: bool = False,
    ceiling: float = DEFAULT_TIER_CEILING,
) -> int:
    """Slice D: the non-degradation backup. Default (``enabled=False``) -> returns
    ``lean_budget`` UNCHANGED (byte-identical to today). When enabled AND the needed
    context exceeds the lean budget AND the model window is large enough to help,
    escalate the budget UP toward the window (to ``int(context_length*ceiling)``), so
    we grow into the big window BEFORE lossy compaction instead of summarizing detail
    away (ADR 0010 Decision D, owner ruling 2).

    Never returns less than ``lean_budget``; never exceeds ``int(context_length*ceiling)``;
    clamps a bad ceiling into (0, 1]; unknown/zero ``context_length`` -> ``lean_budget``
    unchanged. Pure and side-effect-free.
    """
    lean = _coerce_int(lean_budget)
    needed = _coerce_int(needed_tokens)
    window = _coerce_int(context_length)
    c = _coerce_ceiling(ceiling)

    # Opt-out (the default) and the unknown-window case are both exact no-ops: the
    # lean budget stands, so the bill + behaviour are byte-identical to today.
    if not enabled or window <= 0:
        return lean

    # No need to grow if the lean budget already covers the needed context.
    if needed <= lean:
        return lean

    cap = int(window * c)
    # Grow toward the window, but only as far as actually needed, and never below
    # the lean floor (cap could be < lean on a tiny window).
    return max(lean, min(needed, cap))


def resolve_hard_max(raw: object) -> Optional[int]:
    """Setting value -> explicit cap, or None for AUTO (unset, None, 0, negative or unparseable)."""
    try:
        v = int(raw or 0)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def effective_input_budget(context_length: int) -> int:
    """The effective input-token budget for ``context_length``, read from the live settings with the same
    rules the agent loop's trim uses (ORW-219). Lets the compactor trigger relative to the budget the
    trimmer will enforce. Returns 0 when budgeting is disabled (``agent_input_token_budget`` <= 0)."""
    from src.settings import get_setting, is_setting_overridden

    soft = int(get_setting("agent_input_token_budget", DEFAULT_BUDGET) or 0)
    if soft <= 0:
        return 0
    return compute_input_token_budget(soft, context_length, is_setting_overridden("agent_input_token_budget"),
                                      hard_max=resolve_hard_max(get_setting("agent_input_token_hard_max", 0)))
