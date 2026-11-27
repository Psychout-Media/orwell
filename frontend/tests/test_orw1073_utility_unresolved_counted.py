"""ORW-1073 (audit 11-26 A6): a utility designation that resolves to nothing ran every extraction belt on the narration model with only a WARNING line. It is now a counted
soft failure (`belts:utility-unresolved`, on /admin/status), and the belts still fall back to the narration model. Roles only; no live model."""
import importlib

al = importlib.import_module("src.agent_loop")
log_rings = importlib.import_module("src.log_rings")
resolver = importlib.import_module("src.endpoint_resolver")


def _soft(monkeypatch):
    seen = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **kw: seen.append((cls, kw.get("user"))))
    return seen


def test_an_unresolved_utility_tier_is_a_counted_soft_failure_and_the_belts_still_fall_back(monkeypatch):
    seen = _soft(monkeypatch)
    monkeypatch.setattr(resolver, "resolve_endpoint", lambda tier, owner=None: ("", "", {}))
    out = al._resolve_belt_endpoint("player-1", "http://narrator", "narrator-model", {"h": "1"})
    assert out == ("http://narrator", "narrator-model", {"h": "1"})
    assert seen == [("belts:utility-unresolved", "player-1")]


def test_a_resolver_error_is_counted_the_same_way(monkeypatch):
    seen = _soft(monkeypatch)

    def boom(tier, owner=None):
        raise ValueError("no such endpoint")
    monkeypatch.setattr(resolver, "resolve_endpoint", boom)
    assert al._resolve_belt_endpoint("player-1", "u", "m", {})[1] == "m"
    assert seen == [("belts:utility-unresolved", "player-1")]


def test_a_resolved_utility_tier_records_nothing(monkeypatch):
    seen = _soft(monkeypatch)
    monkeypatch.setattr(resolver, "resolve_endpoint", lambda tier, owner=None: ("http://cheap", "cheap-model", {}))
    assert al._resolve_belt_endpoint("player-1", "u", "m", {})[1] == "cheap-model"
    assert seen == []
