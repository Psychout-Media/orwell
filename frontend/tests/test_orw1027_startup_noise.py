"""ORW-1027: known-benign startup lines no longer log at WARNING, so a WARNING in a clean start is real.

Source-level checks (no app import): the demoted call sites and their levels.
"""
import os

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _src(rel):
    return open(os.path.join(FE, rel), encoding="utf-8").read()


def test_python_magic_fallback_is_info_and_noted_once_per_process():
    s = _src("src/upload_handler.py")
    i = s.index("python-magic not available")
    assert "logger.info(" in s[i - 80:i] and "logger.warning(\"python-magic" not in s
    assert "_MAGIC_FALLBACK_NOTED" in s


def test_rag_absence_is_debug_with_one_summary_line():
    s = _src("app.py")
    i = s.index("Vector document RAG not available at startup")
    assert "logger.debug(" in s[i - 160:i]
    assert "Startup summary: vector document RAG off and python-magic fallback are expected here" in s


def test_the_cancel_scope_close_quirk_is_debug_and_other_close_failures_still_warn():
    s = _src("src/mcp_manager.py")
    j = s.index('if "cancel scope" in str(e):')
    block = s[j:j + 700]
    assert "logger.debug(" in block and 'logger.warning(f"Error closing MCP server' in block


def test_tool_rag_lines_are_debug():
    s = _src("src/agent_loop.py")
    assert 'logger.debug(f"[tool-rag] Keyword fallback selected' in s
    i = s.index("game-build wall: dropped non-keep tools")
    assert "logger.debug(" in s[i - 200:i]
