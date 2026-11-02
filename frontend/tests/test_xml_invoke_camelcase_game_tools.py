"""The XML/DSML invoke parser lowercases tool names (models emit `<invoke name="Bash">`). That used to
drop EVERY camelCase game tool (`seasonRecap`, `playerDossier`, …): the lowercased name missed
TOOL_TAGS and the call vanished silently. function_call_to_tool_block now recovers the registered
spelling case-insensitively (PR #1910 review)."""
import src.agent_tools  # noqa: F401 — load order: agent_tools → tool_parsing (avoids a circular import)
from src.tool_parsing import _XML_INVOKE_RE, _parse_xml_invoke
from src.tool_schemas import function_call_to_tool_block


def _xml(name, params=""):
    m = _XML_INVOKE_RE.search(f'<invoke name="{name}">{params}</invoke>')
    assert m, "fixture must match the invoke regex"
    return _parse_xml_invoke(m)


def test_new_diary_tools_survive_the_xml_path():
    for name in ("playerReceipts", "playerDossier"):
        block = _xml(name)
        assert block is not None, f"{name} was dropped on the XML path"
        assert block.tool_type == name


def test_xml_param_reaches_the_dossier_args():
    block = _xml("playerDossier", '<parameter name="subjectId">npc:3</parameter>')
    assert block is not None and block.tool_type == "playerDossier"
    assert "npc:3" in block.content


def test_existing_camelcase_game_tool_survives_the_xml_path():
    block = _xml("seasonRecap")
    assert block is not None and block.tool_type == "seasonRecap"


def test_native_call_spelling_is_unchanged_and_unknown_still_rejected():
    assert function_call_to_tool_block("playerReceipts", "{}").tool_type == "playerReceipts"
    assert function_call_to_tool_block("definitelynotatool", "{}") is None
