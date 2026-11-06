"""ORW-237: the game build never attempts ChromaDB-backed VectorRAG / MemoryVectorStore (they have no role in the game and only logged a DEGRADED warning on every start);
the full workspace (ORWELL_GAME_BUILD=0) still builds them."""
import importlib
import sys
import types


def _spy_modules(monkeypatch):
    calls = {"rag": 0, "mem": 0}

    class _Rag:
        healthy = False
        def __init__(self, *a, **k): calls["rag"] += 1

    class _Mem:
        healthy = False
        def __init__(self, *a, **k): calls["mem"] += 1

    rag_mod = types.ModuleType("src.rag_vector"); rag_mod.VectorRAG = _Rag
    mem_mod = types.ModuleType("src.memory_vector"); mem_mod.MemoryVectorStore = _Mem
    monkeypatch.setitem(sys.modules, "src.rag_vector", rag_mod)
    monkeypatch.setitem(sys.modules, "src.memory_vector", mem_mod)
    return calls


def _fresh_singleton(monkeypatch):
    mod = importlib.import_module("src.rag_singleton")
    monkeypatch.setattr(mod, "rag_instance", None, raising=False)
    monkeypatch.setattr(mod, "_last_attempt", 0.0, raising=False)
    return mod


def test_game_build_does_not_attempt_vector_rag(monkeypatch):
    calls = _spy_modules(monkeypatch)
    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    mod = _fresh_singleton(monkeypatch)
    assert mod.get_rag_manager() is None
    assert calls["rag"] == 0, "the game build must not try to start VectorRAG"


def test_full_workspace_still_attempts_vector_rag(monkeypatch):
    calls = _spy_modules(monkeypatch)
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")
    mod = _fresh_singleton(monkeypatch)
    mod.get_rag_manager()
    assert calls["rag"] == 1, "ORWELL_GAME_BUILD=0 keeps the full workspace behaviour"


def test_game_build_does_not_attempt_memory_vector_store(monkeypatch):
    calls = _spy_modules(monkeypatch)
    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    ai = importlib.import_module("src.app_initializer")
    assert ai._build_memory_vector(object(), None) is None
    assert calls["mem"] == 0


def test_full_workspace_still_attempts_memory_vector_store(monkeypatch):
    calls = _spy_modules(monkeypatch)
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")
    ai = importlib.import_module("src.app_initializer")
    assert ai._build_memory_vector(object(), None) is None  # the spy store is unhealthy => degraded None
    assert calls["mem"] == 1
