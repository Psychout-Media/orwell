"""ORW-147 (11-06 live playtest): the live narrator `deepseek/deepseek-v4.1-flash` was budgeted as a
128K-context model (the DEFAULT_CONTEXT fallback) because no KNOWN_CONTEXT_WINDOWS key is a substring of
"deepseek-v4.1-flash". DeepSeek V4 models are ~1M-token models (OpenRouter lists 1,048,576), and the
owner's direction (Kevin, 11-06) is to use that window fully. A wrong window also mis-states
context_percent and would trigger history compaction at ~109K instead of near 1M.
"""
import pytest

from src import model_context as mc


@pytest.mark.parametrize("model", [
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4.1-flash-1017",
    "deepseek/deepseek-v4-flash",
    "deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "deepseek-flash",
])
def test_deepseek_v4_family_resolves_to_the_1m_window(model):
    assert mc._lookup_known(model) == 1000000


def test_older_deepseek_models_keep_their_own_windows():
    assert mc._lookup_known("deepseek-chat") == 64000
    assert mc._lookup_known("deepseek/deepseek-r1") == 64000
