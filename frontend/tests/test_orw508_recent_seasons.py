"""ORW-508: the per-user recent-seasons ledger and its wiring into the engine calls."""

import asyncio
import importlib

ledger = importlib.import_module("src.orwell_recent_seasons")


def _facts(i):
    return {"names": [f"Ann{i} Lee"], "hometowns": [f"Town{i}, OH"], "vocations": [f"job{i}"], "marks": ["freckles"]}


def test_window_dedupe_and_bounds(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "l.json")
    assert ledger.avoid_for("u") == {}
    for i in range(ledger.WINDOW + 3):
        ledger.record_season("u", _facts(i))
    seasons = ledger.seasons_for("u")
    assert len(seasons) == ledger.WINDOW
    avoid = ledger.avoid_for("u")
    assert "Town0, OH" not in avoid["hometowns"] and "Town8, OH" in avoid["hometowns"]
    assert avoid["marks"] == ["freckles"]            # the same mark in every season is listed once
    ledger.record_season("u", {"names": ["  A\x00 B ", "a b", 5, "x" * 500]})
    assert ledger.seasons_for("u")[-1]["names"] == ["A B", "x" * 120]
    assert ledger.avoid_for("someone-else") == {}      # per user


def test_corrupt_file_reads_empty_and_record_never_raises(tmp_path, monkeypatch):
    p = tmp_path / "l.json"
    p.write_text("{not json")
    monkeypatch.setattr(ledger, "LEDGER_PATH", p)
    assert ledger.avoid_for("u") == {}
    ledger.record_season("u", _facts(1))
    assert ledger.seasons_for("u")


def test_facts_of_house_keep_only_public_facts():
    f = ledger.facts_of_house([
        {"name": "A B", "hometown": "X, OH", "vocation": "barista", "physicalCharacteristics": {"distinguishingMark": "none notable"}},
        {"name": "C D", "hometown": "Y, TX", "vocation": "welder", "physicalCharacteristics": {"distinguishingMark": "wire-rimmed glasses"}, "secrets": ["no"]},
    ])
    assert f == {"names": ["A B", "C D"], "hometowns": ["X, OH", "Y, TX"], "vocations": ["barista", "welder"], "marks": ["wire-rimmed glasses"]}
    assert "secrets" not in str(f)
    assert ledger.facts_of_house(None) == {"names": [], "hometowns": [], "vocations": [], "marks": []}


def test_engine_calls_carry_avoid_unless_seeded_and_the_started_cast_is_recorded(tmp_path, monkeypatch):
    orwell_engine = importlib.import_module("src.orwell_engine")
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "l.json")
    ledger.record_season("u", _facts(1))
    calls = []

    async def fake_call(tool, args, user=None):
        calls.append((tool, dict(args)))
        return {"started": True, "house": [{"name": "Z Q", "hometown": "Q, ME", "vocation": "baker"}]} if tool == "createCharacter" else {"warmed": True}

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    asyncio.run(orwell_engine.pre_seed_cast(user="u"))
    asyncio.run(orwell_engine.pre_seed_next_season(user="u"))
    asyncio.run(orwell_engine.pre_seed_cast(seed=5, user="u"))                       # a seeded call stays deterministic
    assert calls[0][1]["avoid"]["hometowns"] == ["Town1, OH"]
    assert calls[1][1]["avoid"]["vocations"] == ["job1"]
    assert "avoid" not in calls[2][1]
    asyncio.run(orwell_engine.create_character("P", user="u"))
    assert calls[3][1]["avoid"]["names"] == ["Ann1 Lee"]
    assert ledger.seasons_for("u")[-1]["hometowns"] == ["Q, ME"]                     # the shipped cast is remembered
    n = len(ledger.seasons_for("u"))
    asyncio.run(orwell_engine.create_character("P", seed=9, user="u"))               # a seeded start is not
    assert len(ledger.seasons_for("u")) == n
    # ORW-921: a seeded start tells the engine to carry nothing of the dead season across a restart; an unseeded (a player's own) start never does
    assert calls[-1][1]["isolateSeason"] is True
    assert "isolateSeason" not in calls[3][1]


def test_the_default_store_is_redirected_per_test():
    """The autouse fixture in conftest points the ledger at a per-test temp file, never the real data dir."""
    assert "orwell_recent_seasons.json" in str(ledger.LEDGER_PATH)
    assert "pytest" in str(ledger.LEDGER_PATH)
