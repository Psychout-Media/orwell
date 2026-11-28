"""No composer puppeteering: auto-continue / recovery / choice-card / hidden-cue sends must go through
the HEADLESS `handleChatSubmit(null, text, opts)` path — never by writing the user-visible composer
(`el('message').value = …`) and synthesizing a `.send-btn` click.

ROOT CAUSE this pins: the old `_tryAutoRecover` (and a family of ~13 sibling sites) did
`msgInput.value = '<prompt>'; document.querySelector('.send-btn').click()`. The deferred click often
landed while the button was still in Stop mode (the `isStreaming` reset is gated behind
`if (!_isBgFinally)`), so it toggled Stop instead of Send — stranding the prompt text in the composer
and making the player's message appear to vanish. The fix factors a headless override into
`handleChatSubmit` so every programmatic send is a direct call with no DOM round-trip and no race.

Source-pinned (the live behaviour is exercised by the FE suite + browser_smoke).
"""
import re
from pathlib import Path

FE = Path(__file__).resolve().parents[1]
JS = FE / "static" / "js"
ROUTES = FE / "routes"


def _read(p):
    return p.read_text(encoding="utf-8")


def test_handle_chat_submit_has_headless_override():
    src = _read(JS / "chat.js")
    assert re.search(r"export async function handleChatSubmit\(e,\s*overrideMsg\s*=\s*null,\s*overrideOpts\s*=\s*null\)", src), \
        "handleChatSubmit must accept the headless (overrideMsg, overrideOpts) override"
    # The override must be wired: a guarded preventDefault, an _headless flag, and an override-aware msg read.
    assert "if (e && e.preventDefault)" in src, "preventDefault must be guarded for a headless (no-event) call"
    assert "const _headless = overrideMsg != null;" in src
    assert "const msg = _headless ? overrideMsg : el('message').value;" in src


def test_no_send_button_puppeteering_anywhere_in_chat_js():
    src = _read(JS / "chat.js")
    # The anti-pattern: synthesizing a send by clicking the send button.
    for pat in (r"sb\.click\(\)", r"submitBtn\.click\(\)", r"send-btn'\)\.click", r'send-btn"\)\.click'):
        assert not re.search(pat, src), f"chat.js still synthesizes a send-button click ({pat})"
    # And the headless path is actually used (the conversion happened).
    assert "handleChatSubmit(null," in src, "the converted call sites must use the headless handleChatSubmit"


def test_try_auto_recover_no_longer_writes_the_composer():
    src = _read(JS / "chat.js")
    # _renderStreamDropRetry is defined immediately after _tryAutoRecover — use it as the body boundary.
    m = re.search(r"function _tryAutoRecover\(.*?function _renderStreamDropRetry\(", src, re.DOTALL)
    assert m, "could not locate _tryAutoRecover (followed by _renderStreamDropRetry)"
    body = re.sub(r"//.*", "", m.group(0))  # strip line comments (which legitimately mention the old anti-pattern)
    assert ".value =" not in body, "_tryAutoRecover must not write the composer"
    assert ".click()" not in body, "_tryAutoRecover must not synthesize a click"
    # B — a produced-nothing drop surfaces a visible Retry affordance instead of auto-resending.
    assert "_renderStreamDropRetry" in src, "the visible stream-drop Retry affordance must exist"


def test_chat_renderer_continue_uses_headless_send():
    src = _read(JS / "chatRenderer.js")
    assert "window.chatModule.handleChatSubmit" in src, "chatRenderer must call the headless handleChatSubmit"
    for pat in (r"send-btn'\)\.click", r'send-btn"\)\.click', r"sb\.click\(\)"):
        assert not re.search(pat, src), f"chatRenderer.js still synthesizes a send-button click ({pat})"


def test_slash_setup_runs_the_command_directly():
    # The /setup welcome trigger runs the slash command directly — no composer write + synthetic submit.
    src = _read(JS / "slashCommands.js")
    assert "handleSlashCommand('/setup')" in src, "the /setup trigger must call the slash runner directly"


def test_send_hidden_cue_is_headless():
    src = _read(JS / "chat.js")
    m = re.search(r"export function sendHiddenCue\(text\)\s*\{(?:.*\n)*?^  \}", src, re.MULTILINE)
    assert m, "could not locate sendHiddenCue"
    body = m.group(0)
    assert "handleChatSubmit(null, text" in body, "sendHiddenCue must use the headless send"
    assert "box.value = text" not in body, "sendHiddenCue must not puppeteer the composer"


def test_safe_stream_emits_a_typed_terminal_on_failure():
    # C — the server generator never closes the body silently: any exception / silent exit becomes a
    # typed event:error + [DONE], so the client never sees a bare transport drop (its hijack trigger).
    # ORW-1143: the wrapper moved out of the route into src/orwell_stream_failure.py (`guard_stream`); the route's `_safe_stream` delegates to it.
    route = _read(ROUTES / "chat_routes.py")
    assert "_sf.guard_stream(stream_with_save" in route, "_safe_stream must delegate to guard_stream"
    body = _read(ROUTES.parent / "src" / "orwell_stream_failure.py")
    assert '"terminal": True' in body, "guard_stream must emit a typed terminal error chunk on failure"
    assert "ended without a reply" in body, "guard_stream must terminate a silent/empty exit"
    assert 'yield "data: [DONE]\\n\\n"' in body, "guard_stream must close with [DONE]"
