"""ORW-183 (slice 1): the "rich run" stream-event list lives in ONE place in chat.js; both background-stream readers use it. The set equals the two lists it replaced. No model."""
import re
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1] / "static" / "js" / "chat.js").read_text()
OLD = {"tool_start", "tool_output", "tool_progress", "agent_step", "web_sources", "rag_sources", "research_progress", "research_sources", "research_findings", "research_done"}


def test_one_definition_with_exactly_the_old_members():
    m = re.search(r"const _RICH_RUN_EVENT_TYPES = new Set\(\[(.*?)\]\);", SRC, re.S)
    assert m, "the shared set is missing"
    assert set(re.findall(r"'([a-z_]+)'", m.group(1))) == OLD


def test_both_readers_use_it_and_no_private_copy_remains():
    assert SRC.count("_RICH_RUN_EVENT_TYPES.has(json.type)") == 2
    assert "|tool_start|" not in SRC and "(tool_start|tool_output" not in SRC
    assert "json.type === 'web_sources' || json.type === 'rag_sources' ||\n                     json.type === 'research_progress'" not in SRC
