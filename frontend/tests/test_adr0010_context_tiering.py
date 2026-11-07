"""ADR 0010 / feature 0069 Slice D — non-degrading context tiering.

Roles-only, names-free. Proves ``escalate_budget`` is an opt-in, non-degrading
backup: default-off is a byte-identical no-op, and when enabled it grows the lean
budget UP toward the model window (capped at ~0.85x) BEFORE lossy compaction —
never down, never past the ceiling. Also re-asserts ``compute_input_token_budget``
is unchanged (the byte-identity guarantee for existing callers).
"""

import math

import pytest

from src.context_budget import (
    DEFAULT_HARD_MAX,
    DEFAULT_TIER_CEILING,
    compute_input_token_budget,
    escalate_budget,
)


# --- 1. enabled=False is a pure no-op (the byte-identity guarantee) -----------

@pytest.mark.parametrize(
    "lean,needed,window",
    [
        (6000, 6000, 0),
        (48000, 120000, 1_000_000),   # would escalate if enabled — must not
        (6000, 1, 128000),
        (48000, 0, 200000),
        (1, 999_999, 1_000_000),
        (48000, 48000, 128000),
    ],
)
def test_disabled_is_exact_no_op(lean, needed, window):
    # Default (enabled defaults to False) and explicit enabled=False both return lean.
    assert escalate_budget(lean, needed, window) == lean
    assert escalate_budget(lean, needed, window, enabled=False) == lean


# --- 2. enabled=True, needed > lean, large window -> escalate toward window ----

def test_enabled_escalates_toward_large_window():
    lean, needed, window, ceiling = 48000, 120000, 1_000_000, 0.85
    cap = int(window * ceiling)  # 850000
    out = escalate_budget(lean, needed, window, enabled=True, ceiling=ceiling)
    assert out > lean                       # grew past the lean floor
    assert out <= cap                       # never past the ceiling
    assert out == min(needed, cap)          # exactly the grown-but-needed amount
    assert out == 120000                    # needed < cap here, so == needed


def test_enabled_clamps_to_ceiling_when_needed_exceeds_window():
    # Need more than even 0.85x of the window -> held at the ceiling, never above.
    lean, needed, window, ceiling = 48000, 5_000_000, 1_000_000, 0.85
    cap = int(window * ceiling)  # 850000
    out = escalate_budget(lean, needed, window, enabled=True, ceiling=ceiling)
    assert out == cap
    assert out <= cap


def test_default_ceiling_is_used_when_unspecified():
    lean, needed, window = 48000, 5_000_000, 1_000_000
    out = escalate_budget(lean, needed, window, enabled=True)
    assert out == int(window * DEFAULT_TIER_CEILING)


# --- 3. enabled=True but needed <= lean -> don't grow -------------------------

@pytest.mark.parametrize("needed", [0, 1, 47999, 48000])
def test_enabled_does_not_grow_when_not_needed(needed):
    lean, window = 48000, 1_000_000
    assert escalate_budget(lean, needed, window, enabled=True) == lean


# --- 4. invariants: floor, ceiling, unknown window, garbage ceiling ----------

@pytest.mark.parametrize(
    "lean,needed,window,enabled,ceiling",
    [
        (48000, 120000, 1_000_000, True, 0.85),
        (48000, 120000, 1_000_000, False, 0.85),
        (6000, 1_000_000, 128000, True, 0.5),
        (48000, 0, 0, True, 0.85),
        (48000, 60000, 50000, True, 0.85),  # tiny window: cap < lean -> floor holds
    ],
)
def test_never_below_lean_and_never_above_ceiling(lean, needed, window, enabled, ceiling):
    out = escalate_budget(lean, needed, window, enabled=enabled, ceiling=ceiling)
    assert out >= lean                                  # never degrade below lean
    if enabled and window > 0:
        cap = int(window * _clamp_ceiling(ceiling))
        assert out <= max(lean, cap) and out <= max(lean, cap)
        assert out <= cap or out == lean                # ceiling-bounded (or floored)


def test_tiny_window_floors_at_lean():
    # cap (= window*ceiling) is below the lean floor -> return lean, never less.
    out = escalate_budget(48000, 60000, 50000, enabled=True, ceiling=0.85)
    assert out == 48000


def test_unknown_or_zero_window_is_no_op():
    assert escalate_budget(48000, 120000, 0, enabled=True) == 48000
    assert escalate_budget(6000, 999_999, 0, enabled=True, ceiling=0.85) == 6000


@pytest.mark.parametrize(
    "bad_ceiling",
    [0, -1, -0.5, float("nan"), float("inf"), float("-inf"), "garbage", None],
)
def test_garbage_ceiling_is_clamped_without_raising(bad_ceiling):
    # Falls back to DEFAULT_TIER_CEILING for non-finite/<=0/garbage; never raises.
    out = escalate_budget(48000, 5_000_000, 1_000_000, enabled=True, ceiling=bad_ceiling)
    assert out == int(1_000_000 * DEFAULT_TIER_CEILING)


def test_ceiling_above_one_is_capped_at_one():
    # ceiling > 1 -> 1.0 (never request more than the whole window).
    out = escalate_budget(48000, 5_000_000, 1_000_000, enabled=True, ceiling=2.0)
    assert out == 1_000_000


def test_garbage_int_args_do_not_raise():
    # Defensive int coercion — bad scalars degrade to a sane no-op-ish result.
    assert escalate_budget("x", "y", "z", enabled=True) == 0
    assert escalate_budget(None, None, None, enabled=True) == 0


# --- 5. compute_input_token_budget is UNCHANGED (byte-identity for callers) ---

def test_explicit_override_is_honoured():
    # An explicit, genuinely-changed budget is returned exactly (clamped to window).
    assert compute_input_token_budget(20000, 128000, explicit=True) == 20000
    assert compute_input_token_budget(500000, 128000, explicit=True) == 128000


def test_default_sentinel_scales_to_window_capped_at_hard_max():
    # The persisted-default / unset case scales to the window, capped at 48000.
    # ORW-219: the cap is model-aware, so use a sub-500K window here to pin the 48K cap.
    assert compute_input_token_budget(6000, 400_000, explicit=False) == DEFAULT_HARD_MAX
    assert DEFAULT_HARD_MAX == 48_000
    # A persisted default reported as "explicit" is still treated as non-explicit.
    assert compute_input_token_budget(6000, 400_000, explicit=True) == DEFAULT_HARD_MAX


def test_unknown_window_falls_back_to_configured_or_default():
    assert compute_input_token_budget(6000, 0, explicit=False) == 6000
    assert compute_input_token_budget(12345, 0, explicit=True) == 12345


def _clamp_ceiling(c):
    """Mirror of the module's ceiling clamp, for invariant assertions only."""
    try:
        c = float(c)
    except (TypeError, ValueError):
        return DEFAULT_TIER_CEILING
    if not math.isfinite(c) or c <= 0:
        return DEFAULT_TIER_CEILING
    return min(c, 1.0)
