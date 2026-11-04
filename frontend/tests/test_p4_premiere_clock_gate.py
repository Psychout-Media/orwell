"""P4 item 1 (rehearsal #3 finding): the premiere -> first-HOH advance was NOT clock-gated — the silent stall belt started the first HOH competition at message 3-4
of the premiere, the thinnest social window of the week. Production owns the schedule: the first HOH must wait like every other event. The engine's clock does not
run during the premiere, so the FE counts premiere messages against the SAME one-morning pace the engine uses (MESSAGES_PER_MORNING); until then the advance
belts treat the premiere as 'production hasn't called the house in' (production_is_holding). Roles only."""
import importlib
import re
from pathlib import Path

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")

ROOT = Path(__file__).resolve().parent.parent.parent


def _engine_messages_per_morning() -> int:
    src = (ROOT / "src" / "engine" / "sleepConstants.ts").read_text()
    per = float(re.search(r"MINUTES_PER_MESSAGE\s*=\s*([0-9.]+)", src).group(1)) / 60
    wake = float(re.search(r"wakeHour:\s*([0-9.]+)", src).group(1))
    aft = float(re.search(r"afternoon:\s*([0-9.]+)", src).group(1))
    return round((aft - wake) / per)


def test_the_fe_premiere_window_is_the_engines_one_morning_pace():
    assert ch._PREMIERE_SOCIAL_MESSAGES == _engine_messages_per_morning(), "tune the pace in ONE place (engine MINUTES_PER_MESSAGE) and mirror it here"
    assert 40 <= ch._PREMIERE_SOCIAL_MESSAGES <= 56  # ~48 messages x 5 min = the 4h morning (PO 2026-11-04)


def test_the_premiere_is_held_until_a_morning_of_messages_has_passed():
    u = "u-prem1"
    ch.clear_social_runway(u)
    gs = {"started": True, "phase": "premiere", "week": 1}
    for k in range(1, ch._PREMIERE_SOCIAL_MESSAGES):
        ch.note_premiere_turn(u, gs)
        assert ch.production_is_holding(u) is True, f"message {k}: the first HOH must not start yet"
    ch.note_premiere_turn(u, gs)            # the morning's worth has passed
    assert ch.production_is_holding(u) is False, "after a morning of messages the belts may bring the first HOH in"


def test_a_ready_player_cannot_shorten_it_and_leaving_the_premiere_clears_it():
    u = "u-prem2"
    ch.clear_social_runway(u)
    ch.note_premiere_turn(u, {"started": True, "phase": "premiere", "week": 1})
    assert ch.production_is_holding(u) is True      # (readiness is not an input at all)
    ch.note_premiere_turn(u, {"started": True, "phase": "hoh-competition", "week": 1})
    assert ch.production_is_holding(u) is False


def test_not_a_premiere_never_holds():
    u = "u-prem3"
    ch.clear_social_runway(u)
    ch.note_premiere_turn(u, {"started": True, "phase": "nominations", "week": 3})
    assert ch.production_is_holding(u) is False
    ch.note_premiere_turn(u, None)
    assert ch.production_is_holding(u) is False
