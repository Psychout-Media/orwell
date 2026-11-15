"""ORW-437 (review of #2720): the start-up engine-state prime read with no user, so it failed with
"missing user identity" on every restart and could not warm any per-user cache. It is gone; this pins it."""
import pathlib


def test_lifespan_does_not_prime_engine_state_without_a_user():
    src = (pathlib.Path(__file__).resolve().parent.parent / "app.py").read_text()
    assert "get_game_state_polled(" not in src
    assert "engine-state-prime-failed" not in src
