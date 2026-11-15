"""ORW-219: the narrator's system prompt must never be cut and the per-turn HARD CONSTRAINTS /
steer messages must never be dropped when a long game exceeds the input budget. Old turns go
first. The default input cap is also model-aware (1M window -> 0.60 x window). Roles only."""
import logging

from src.context_budget import DEFAULT_BUDGET, DEFAULT_HARD_MAX, compute_input_token_budget
from src.context_compactor import trim_for_context
from src.model_context import estimate_tokens

GM_PROMPT = "GM RULES. " + ("never name the machinery; closed-set board; roster discipline. " * 400)
STEER = "STEER: production has not called the event yet; keep the scene social."
HARD = "HARD CONSTRAINTS: only these people are with the player."


def _game_messages(turns=200):
    msgs = [{"role": "system", "content": GM_PROMPT}, {"role": "system", "content": STEER}]
    for i in range(turns):
        msgs.append({"role": "user", "content": f"player turn {i} " + "talk " * 60})
        msgs.append({"role": "assistant", "content": f"narrator turn {i} " + "scene " * 60})
    msgs.append({"role": "user", "content": "player CURRENT turn"})
    msgs.append({"role": "system", "content": HARD})
    return msgs


def test_game_trim_keeps_full_system_prompt_and_hard_constraints_and_drops_oldest_turns():
    msgs = _game_messages()
    budget = estimate_tokens(msgs) // 2
    out = trim_for_context(msgs, budget, reserve_tokens=0, preserve_system=True)
    contents = [m["content"] for m in out]
    assert GM_PROMPT in contents, "the GM prompt must not be truncated"
    assert STEER in contents and HARD in contents
    assert "[System prompt truncated" not in "".join(contents)
    assert out[-1]["content"] == HARD, "HARD CONSTRAINTS stays the last message"
    assert "player CURRENT turn" in contents
    assert "player turn 0 " + "talk " * 60 not in contents, "oldest turn dropped"
    assert estimate_tokens(out) <= budget
    # the survivors are the NEWEST turns, in order
    turns = [c for c in contents if c.startswith(("player turn", "narrator turn"))]
    assert turns and turns[-1].startswith("narrator turn 199")


def test_old_behaviour_regression_prompt_over_2000_chars_is_not_cut_for_game():
    msgs = _game_messages(turns=60)
    out = trim_for_context(msgs, estimate_tokens(msgs) - 50, reserve_tokens=0, preserve_system=True)
    assert out[0]["content"] == GM_PROMPT and len(out[0]["content"]) > 2000


def test_game_trim_soft_fails_loudly_when_system_alone_exceeds_budget(caplog):
    msgs = _game_messages(turns=3)
    with caplog.at_level(logging.WARNING):
        out = trim_for_context(msgs, 100, reserve_tokens=0, preserve_system=True)
    assert out[0]["content"] == GM_PROMPT
    assert out[-1]["content"] == HARD
    assert any("NOT truncated" in r.getMessage() for r in caplog.records)


def test_non_game_drops_turns_before_truncating_system_prompt():
    msgs = _game_messages(turns=100)
    msgs = [m for m in msgs if m["content"] not in (STEER, HARD)]
    # budget fits the full prompt + recent turns, so no truncation is needed
    budget = estimate_tokens(msgs[:1]) + 2500
    out = trim_for_context(msgs, budget, reserve_tokens=0)
    assert out[0]["content"] == GM_PROMPT
    assert estimate_tokens(out) <= budget


def test_non_game_truncates_system_prompt_only_as_last_resort(caplog):
    msgs = _game_messages(turns=20)
    with caplog.at_level(logging.WARNING):
        out = trim_for_context(msgs, 1500, reserve_tokens=0)
    assert out[0]["content"].endswith("[System prompt truncated for context limits]")
    assert any("last resort" in r.getMessage() for r in caplog.records)


def test_small_window_still_trims_sanely():
    msgs = _game_messages(turns=300)
    budget = compute_input_token_budget(DEFAULT_BUDGET, 128_000, explicit=False)
    assert budget == DEFAULT_HARD_MAX
    out = trim_for_context(msgs, budget, reserve_tokens=1024, preserve_system=True)
    assert estimate_tokens(out) <= budget - 1024
    assert len(out) < len(msgs)


def test_budget_for_1m_model_with_default_settings_is_600k():
    assert compute_input_token_budget(DEFAULT_BUDGET, 1_000_000, explicit=False) == 600_000
    assert compute_input_token_budget(DEFAULT_BUDGET, 1_000_000, explicit=True) == 600_000  # persisted default


def test_budget_for_500k_boundary_and_below():
    assert compute_input_token_budget(DEFAULT_BUDGET, 500_000, explicit=False) == 300_000
    assert compute_input_token_budget(DEFAULT_BUDGET, 499_999, explicit=False) == DEFAULT_HARD_MAX
    assert compute_input_token_budget(DEFAULT_BUDGET, 128_000, explicit=False) == DEFAULT_HARD_MAX


def test_explicit_cap_is_honoured_exactly_including_48000_on_1m():
    assert compute_input_token_budget(DEFAULT_BUDGET, 1_000_000, explicit=False, hard_max=48_000) == 48_000
    assert compute_input_token_budget(DEFAULT_BUDGET, 1_000_000, explicit=False, hard_max=100_000) == 100_000
    assert compute_input_token_budget(DEFAULT_BUDGET, 1_000_000, explicit=False, hard_max=900_000) == 600_000


def test_auto_means_unset_none_zero_or_garbage():
    from src.context_budget import resolve_hard_max
    for raw in (None, 0, "0", "", -5, "abc"):
        assert resolve_hard_max(raw) is None
        assert compute_input_token_budget(DEFAULT_BUDGET, 1_000_000, explicit=False, hard_max=resolve_hard_max(raw)) == 600_000
    assert resolve_hard_max(48000) == 48_000 and resolve_hard_max("65000") == 65_000


def test_repo_default_is_auto():
    from src.settings import DEFAULT_SETTINGS
    assert DEFAULT_SETTINGS["agent_input_token_hard_max"] == 0


def _settings_with(tmp_path, monkeypatch, saved):
    import json
    import src.settings as st
    f = tmp_path / "settings.json"
    f.write_text(json.dumps(saved))
    monkeypatch.setattr(st, "SETTINGS_FILE", str(f))
    monkeypatch.setattr(st, "_settings_cache", None)
    monkeypatch.setattr(st, "_hard_max_migration_logged", False)
    return st, f


def test_legacy_48000_is_migrated_to_auto_once_and_persisted(tmp_path, monkeypatch, caplog):
    import json
    st, f = _settings_with(tmp_path, monkeypatch, {"agent_input_token_hard_max": 48000, "other": 1})
    with caplog.at_level(logging.WARNING):
        assert st.load_settings()["agent_input_token_hard_max"] == 0
    assert json.loads(f.read_text())["agent_input_token_hard_max"] == 0 and json.loads(f.read_text())["other"] == 1
    assert sum("migrated legacy agent_input_token_hard_max" in r.getMessage() for r in caplog.records) == 1
    monkeypatch.setattr(st, "_settings_cache", None)
    caplog.clear()
    st.load_settings()
    assert not caplog.records, "logged once only"
    from src.context_budget import resolve_hard_max
    assert compute_input_token_budget(DEFAULT_BUDGET, 1_000_000, explicit=True, hard_max=resolve_hard_max(st.get_setting("agent_input_token_hard_max"))) == 600_000


def test_other_values_are_not_migrated(tmp_path, monkeypatch):
    for v in (600000, 65000, 0, 48001):
        st, f = _settings_with(tmp_path, monkeypatch, {"agent_input_token_hard_max": v})
        assert st.load_settings()["agent_input_token_hard_max"] == v
