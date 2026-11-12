# src/llm_core.py
import httpx
import asyncio
import os
import time
import json
import logging
import hashlib
import threading
import re
from fastapi import HTTPException
from typing import Optional, Dict, List, Tuple
from src.model_context import get_context_length, DEFAULT_CONTEXT
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


# ── Canonical text→image model classification (single source of truth) ──────────
# A text→image model resolves fine through the normal endpoint plumbing but CANNOT
# serve chat completions — POSTing it to a chat endpoint returns an empty/garbage
# reply or 400s. Several chat-model selection points (the default-chat resolver, the
# empty-session recovery, _first_chat_model) used to carry their own incomplete
# non-chat lists that only knew the legacy families ("dall-e", "stable-diffusion"),
# so a modern image model like "google/gemini-3.1-flash-image" or "gpt-image-1" slipped
# through and got bound as the chat/narrator model. This is the ONE place that knows
# the image families; every chat selector consults it (and src.orwell_portraits
# re-exports it as `_is_image_model`, the prior home, so its tests stay pinned here).
_IMAGE_MODEL_FAMILIES = (
    "gpt-image", "dall-e", "dalle",
    "flux", "stable-diffusion", "sdxl", "sd3", "sd-", "playground-v",
    "imagen", "ideogram", "recraft", "kolors", "kandinsky", "pixart",
    "firefly", "titan-image", "aura-flow", "hidream", "seedream",
    "qwen-image", "wan2", "janus", "omnigen", "cogview", "chroma",
    "lumina", "nano-banana", "photon", "phoenix", "luma-photon",
)
# Markers of a VISION (image-understanding) model — these ARE chat-capable and must
# NOT be misclassified as image generators just because "image" appears in the id.
_VISION_MARKERS = ("vision", "-vl", "understand", "caption", "ocr", "embed", "rerank")


def is_image_model(model_id: Optional[str]) -> bool:
    """True for a text→image (generation) model; False for chat/vision/embedding models.

    Recognizes the known image families plus any id carrying "image"/"text-to-image"/"t2i"
    (e.g. "google/gemini-3.1-flash-image"), while excluding vision/understanding models
    that legitimately do chat. Keep in sync with the front-end `_isImageModel` in settings.js.
    """
    lower = str(model_id or "").lower()
    if any(kw in lower for kw in _IMAGE_MODEL_FAMILIES):
        return True
    if "image" in lower or "text-to-image" in lower or "t2i" in lower:
        return not any(m in lower for m in _VISION_MARKERS)
    return False


def _exc_fail_class(exc: BaseException) -> str:
    """S6a: classify an LLM-call exception into the llmIo triage taxonomy (timeout|4xx|5xx|error).

    A read/connect timeout (or an asyncio.wait_for cancellation) is ``timeout``; an ``HTTPException``
    carries its status → 4xx/5xx; anything else is a generic ``error``. Keeps the failClass truthful
    even when the impl has wrapped a socket timeout in a 502."""
    try:
        if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)):
            return "timeout"
        # HTTP status is the AUTHORITATIVE signal — classify it BEFORE a timeout WORD in the message,
        # so a `HTTPException(504, "Gateway Timeout")` (the impl wraps upstream statuses this way) reads
        # as its 5xx class, not the blunt "timeout" (Greptile P1). Only a genuine transport/read-timeout
        # word with NO HTTP status falls through to "timeout".
        status = getattr(exc, "status_code", None)
        if status is None:
            status = getattr(exc, "status", None)
        try:
            s = int(status)
            if 400 <= s < 500:
                return "4xx"
            if 500 <= s < 600:
                return "5xx"
        except (TypeError, ValueError):
            pass
        low = f"{type(exc).__name__}: {exc}".lower()
        if any(m in low for m in ("timeout", "timed out", "read timed out", "deadline")):
            return "timeout"
    except Exception:
        pass
    return "error"


class LLMConfig:
    """Configuration constants for LLM operations."""
    DEFAULT_TIMEOUT = 30
    DEFAULT_TEMPERATURE = 1.0
    DEFAULT_MAX_TOKENS = 0
    MAX_RETRIES = 3
    RETRY_DELAY = 0.5
    STREAM_TIMEOUT = 300


# Cache for LLM responses
def _get_cache_key(url: str, model: str, messages: List[Dict], 
                   temperature: float, max_tokens: int) -> str:
    """Generate cache key for LLM requests."""
    hashable_messages = []
    for msg in messages:
        sorted_items = tuple(sorted(msg.items()))
        hashable_messages.append(sorted_items)
    
    content = json.dumps({
        'url': url,
        'model': model, 
        'messages': hashable_messages,
        'temp': temperature,
        'max_tokens': max_tokens
    }, sort_keys=True)
    return hashlib.sha256(content.encode()).hexdigest()

_response_cache = {}

# Dead-host cooldown: maps host (scheme://host:port) -> unix ts when cooldown expires.
# When a connect to a host fails, we mark it dead for DEAD_HOST_COOLDOWN seconds so
# subsequent calls fail instantly instead of waiting on the connect timeout. Keeps
# one unreachable upstream from jamming chat across the rest of the app.
#
# But a SINGLE transient blip (local model briefly busy, a momentary
# Tailscale hiccup) used to trip a full 60s lockout — the user saw a
# 503 and thought the model died when it was fine a second later. So:
#   - require FAIL_THRESHOLD consecutive failures before cooling
#   - shorter cooldown so recovery is quick
#   - any success resets the failure counter immediately
#
# N-5 (2026-11-03 playtest): with the box idle, 3 real connect timeouts tripped the old
# threshold-2 / 20s lockout and turned into ~25 INSTANT 503s (one per pipeline beat) = blank turns.
# So the trip is now data-driven and gentler:
#   - HOST_FAIL_THRESHOLD consecutive failures (5) inside HOST_FAIL_WINDOW (stale counts decay),
#   - a short cool-off (8s), and
#   - a cooled host is PROBED: one trial call is let through every HOST_PROBE_INTERVAL (2s) instead of
#     failing every call for the whole window. A success clears the host; a failure re-cools it.
DEAD_HOST_COOLDOWN = 8.0
HOST_FAIL_THRESHOLD = 5
_HOST_FAIL_THRESHOLD = HOST_FAIL_THRESHOLD  # legacy alias
HOST_FAIL_WINDOW = 30.0
HOST_PROBE_INTERVAL = 2.0
# Bounded connect-class retry for the narration stream (pre-byte failures only).
STREAM_CONNECT_RETRIES = 2
STREAM_CONNECT_RETRY_BUDGET = 12.0
STREAM_CONNECT_BACKOFF = 0.3
_dead_hosts: Dict[str, float] = {}
_host_fails: Dict[str, int] = {}
_host_last_fail: Dict[str, float] = {}
_host_probe_at: Dict[str, float] = {}
# Guards the two maps above. The synchronous llm_call() runs inside FastAPI's
# threadpool (sync routes such as /sessions/auto-sort) while llm_call_async()
# runs on the event loop, so these maps are mutated from multiple OS threads.
# Without the lock the get()+1+set on _host_fails is a read-modify-write that
# loses failure counts under concurrent connect errors (issue #659).
_host_health_lock = threading.Lock()
_model_activity: Dict[str, float] = {}

_HARMONY_MARKER_RE = re.compile(
    r"<\|channel\|>(analysis|final)"
    r"|<\|start\|>(?:assistant|system|user|tool)?"
    r"|<\|message\|>"
    r"|<\|end\|>"
    r"|<\|return\|>"
    r"|<\|call\|>"
)
_HARMONY_MARKERS = (
    "<|channel|>analysis",
    "<|channel|>final",
    "<|start|>assistant",
    "<|start|>system",
    "<|start|>user",
    "<|start|>tool",
    "<|start|>",
    "<|message|>",
    "<|end|>",
    "<|return|>",
    "<|call|>",
)
_HARMONY_MAX_MARKER_LEN = max(len(marker) for marker in _HARMONY_MARKERS)


def _harmony_suffix_hold_len(text: str) -> int:
    """Return how many trailing chars could be the start of a harmony marker."""
    limit = min(len(text), _HARMONY_MAX_MARKER_LEN - 1)
    for n in range(limit, 0, -1):
        suffix = text[-n:]
        if any(marker.startswith(suffix) for marker in _HARMONY_MARKERS):
            return n
    return 0


class _HarmonyStreamRouter:
    """Route OpenAI harmony analysis/final channels without leaking markers."""

    def __init__(self) -> None:
        self._buf = ""
        self._seen_harmony = False
        self._channel: Optional[str] = None
        self._in_message = False

    def feed(self, text: str) -> List[Tuple[str, bool]]:
        if not text:
            return []
        self._buf += text
        return self._drain(final=False)

    def flush(self) -> List[Tuple[str, bool]]:
        return self._drain(final=True)

    def _append_text(self, out: List[Tuple[str, bool]], text: str) -> None:
        if not text:
            return
        if not self._seen_harmony:
            out.append((text, False))
            return
        if self._in_message:
            out.append((text, self._channel == "analysis"))

    def _handle_marker(self, match: re.Match[str]) -> None:
        marker = match.group(0)
        self._seen_harmony = True
        if marker.startswith("<|channel|>"):
            self._channel = match.group(1)
            self._in_message = False
        elif marker == "<|message|>":
            self._in_message = True
        else:
            self._in_message = False
            if marker in {"<|end|>", "<|return|>", "<|call|>"}:
                self._channel = None

    def _drain(self, *, final: bool) -> List[Tuple[str, bool]]:
        out: List[Tuple[str, bool]] = []
        while True:
            match = _HARMONY_MARKER_RE.search(self._buf)
            if not match:
                break
            self._append_text(out, self._buf[:match.start()])
            self._handle_marker(match)
            self._buf = self._buf[match.end():]

        hold = 0 if final else _harmony_suffix_hold_len(self._buf)
        emit = self._buf if hold == 0 else self._buf[:-hold]
        self._buf = "" if hold == 0 else self._buf[-hold:]
        self._append_text(out, emit)
        return out


def _stream_delta_event(text: str, *, thinking: bool = False) -> str:
    payload = {"delta": text}
    if thinking:
        payload["thinking"] = True
    return f"data: {json.dumps(payload)}\n\n"

def _model_activity_key(url: str, model: str) -> str:
    return f"{(url or '').strip()}|{(model or '').strip()}"

def _same_model_identity(left: str, right: str) -> bool:
    return (left or "").strip().lower() == (right or "").strip().lower()

def note_model_activity(url: str, model: str):
    """Record that a real upstream request used this endpoint/model."""
    if not url or not model:
        return
    _model_activity[_model_activity_key(url, model)] = time.time()

def seconds_since_model_activity(url: str, model: str) -> Optional[float]:
    """Seconds since the endpoint/model was last used in this process."""
    ts = _model_activity.get(_model_activity_key(url, model))
    if not ts:
        return None
    return max(0.0, time.time() - ts)

def _host_key(url: str) -> str:
    from urllib.parse import urlsplit
    s = urlsplit(url)
    return f"{s.scheme}://{s.netloc}" if s.scheme and s.netloc else url

_LOG_REDACT_RES = (
    re.compile(r"(?i)authorization\s*[:=]\s*(?:bearer\s+)?[^\s,;\"']+"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{6,}"),
    re.compile(r"(?i)(api[_-]?key|x-api-key)(\"?\s*[:=]\s*\"?)[^\s,;\"']+"),
)


def _redact_for_log(text, limit: int = 300) -> str:
    """Whitespace-collapse, strip keys/Authorization text, cap length (log-safe)."""
    t = " ".join(str(text or "").split())
    t = _LOG_REDACT_RES[0].sub("Authorization: [redacted]", t)
    t = _LOG_REDACT_RES[1].sub("Bearer [redacted]", t)
    t = _LOG_REDACT_RES[2].sub("sk-[redacted]", t)
    t = _LOG_REDACT_RES[3].sub(lambda m: m.group(1) + m.group(2) + "[redacted]", t)
    return t[:limit]


def _log_stream_failure(what, target_url, model, started, body=None) -> None:
    """One WARNING per provider-stream failure so a player-visible interlude is attributable.
    Host only (never the URL/query), never headers/payload/keys."""
    try:
        elapsed = time.monotonic() - started
        msg = (f"[orwell] provider stream failed: {what} host={_host_key(target_url)} "
               f"model={model} elapsed={elapsed:.1f}s")
        if body is not None:
            msg += f" body={_redact_for_log(body)!r}"
        logger.warning(msg)
    except Exception:
        pass


def _is_host_dead(url: str) -> bool:
    key = _host_key(url)
    with _host_health_lock:
        exp = _dead_hosts.get(key)
        if exp is None:
            return False
        now = time.time()
        if now >= exp:
            _dead_hosts.pop(key, None)
            _host_probe_at.pop(key, None)
            return False
        if now >= _host_probe_at.get(key, 0.0):
            # Trial call: let ONE caller through per probe interval so recovery is noticed fast.
            _host_probe_at[key] = now + HOST_PROBE_INTERVAL
            return False
        return True

def _mark_host_dead(url: str) -> bool:
    """Record a connect failure. Only actually cools the host after
    _HOST_FAIL_THRESHOLD consecutive failures. Returns True if the host
    is now cooled (so callers can log accurately), False if it's still
    within its allowed-failure grace."""
    key = _host_key(url)
    with _host_health_lock:
        now = time.time()
        if now - _host_last_fail.get(key, now) > HOST_FAIL_WINDOW:
            _host_fails.pop(key, None)  # stale failures do not count as "consecutive"
        _host_last_fail[key] = now
        n = _host_fails.get(key, 0) + 1
        _host_fails[key] = n
        if n >= HOST_FAIL_THRESHOLD:
            _dead_hosts[key] = now + DEAD_HOST_COOLDOWN
            _host_probe_at[key] = now + HOST_PROBE_INTERVAL
            return True
        return False

def _is_host_cooled_now(url: str) -> bool:
    """Non-consuming peek: is the host currently in an unexpired cooldown? (Unlike `_is_host_dead`, never
    reserves the probe slot.)"""
    key = _host_key(url)
    with _host_health_lock:
        exp = _dead_hosts.get(key)
        return exp is not None and time.time() < exp


def _clear_host_dead(url: str) -> None:
    key = _host_key(url)
    with _host_health_lock:
        _dead_hosts.pop(key, None)
        _host_fails.pop(key, None)
        _host_last_fail.pop(key, None)
        _host_probe_at.pop(key, None)


# Shared async HTTP client. Reusing one client keeps connections warm:
# repeat calls to api.anthropic.com / api.openai.com / openrouter skip the
# 100-500ms TCP+TLS handshake. Lazy init so we bind to the running event loop.
_http_client: Optional[httpx.AsyncClient] = None
_http_limits = httpx.Limits(max_connections=100, max_keepalive_connections=30, keepalive_expiry=30.0)

# N-5: an httpx.AsyncClient's pool is bound to the event loop that opened its sockets. This app runs
# many fail-soft background tasks via ``asyncio.run`` in worker threads (cast authoring, portraits,
# prewarm, ...). Sharing ONE client across those short-lived loops parks keep-alive sockets whose
# loop is gone (CLOSE-WAIT) and hands them to the main loop -> stalled/failed connects. So: one
# client per running loop (weak-keyed so a dead loop's client is collected).
import weakref
_loop_clients: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_loop_clients_lock = threading.Lock()


def _running_loop_or_none():
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def _get_http_client() -> httpx.AsyncClient:
    """Return the AsyncClient for the CURRENT event loop. Per-request timeout is passed at call time."""
    global _http_client
    loop = _running_loop_or_none()
    from src.tls_overrides import llm_verify

    def _build():
        return httpx.AsyncClient(limits=_http_limits, http2=False, verify=llm_verify())

    if loop is None:
        if _http_client is None or _http_client.is_closed:
            _http_client = _build()
        return _http_client
    with _loop_clients_lock:
        c = _loop_clients.get(loop)
        if c is None or c.is_closed:
            # Drop any entry whose loop is already closed (a dead loop's client can never be reused).
            for _l in [l for l in list(_loop_clients.keys()) if getattr(l, "is_closed", lambda: False)()]:
                _loop_clients.pop(_l, None)
            c = _build()
            _loop_clients[loop] = c
        return c


async def aclose_loop_clients() -> None:
    """Close + drop the HTTP client(s) bound to the CURRENT running loop (llm_core's and the engine's).
    Call at the end of a short-lived ``asyncio.run`` so its keep-alive sockets are released with the loop."""
    loop = _running_loop_or_none()
    if loop is not None:
        with _loop_clients_lock:
            c = _loop_clients.pop(loop, None)
        if c is not None and not c.is_closed:
            try:
                await c.aclose()
            except Exception:  # failsoft-ok: best-effort cleanup
                pass
    try:
        from src import orwell_engine as _oe
        await _oe.aclose_loop_client()
    except Exception:  # failsoft-ok: best-effort cleanup
        pass


def run_isolated(coro):
    """``asyncio.run`` for the fail-soft background jobs: runs ``coro`` on a fresh loop and closes that
    loop's HTTP clients before the loop goes away (N-5), so short-lived loops never strand sockets."""
    async def _wrapped():
        try:
            return await coro
        finally:
            await aclose_loop_clients()
    return asyncio.run(_wrapped())

def _get_cached_response(cache_key: str) -> Optional[str]:
    """Get cached response if it exists."""
    return _response_cache.get(cache_key)

def _set_cached_response(cache_key: str, response: str) -> None:
    """Store response in cache."""
    if len(_response_cache) > 128:
        keys_to_remove = list(_response_cache.keys())[:64]
        for key in keys_to_remove:
            # pop(), not del: another thread (sync llm_call runs in FastAPI's
            # threadpool) may have already evicted the same snapshotted key,
            # and del would raise KeyError mid-eviction (issue #659).
            _response_cache.pop(key, None)
    _response_cache[cache_key] = response

# ── Anthropic native API adapter ──

ANTHROPIC_MODELS = [
    "claude-opus-4-20250514", "claude-opus-4",
    "claude-sonnet-4-20250514", "claude-sonnet-4", "claude-sonnet-4-5-20250929", "claude-sonnet-4-5",
    "claude-haiku-4-20250514", "claude-haiku-4", "claude-haiku-3-5-20241022", "claude-haiku-3-5",
]


def _is_ollama_native_url(url: str) -> bool:
    """Return True for native Ollama API URLs, including Ollama Cloud."""
    try:
        parsed = urlparse(url or "")
    except Exception:
        return False
    host = parsed.hostname or ""
    path = (parsed.path or "").rstrip("/")
    if _host_match(url, "ollama.com"):
        return True
    if path.startswith("/v1"):
        return False
    local_ollama_host = host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"} or parsed.port == 11434
    return local_ollama_host and (path == "" or path == "/api" or path.startswith("/api/"))


def _ollama_api_root(url: str) -> str:
    """Return a native Ollama API root such as https://ollama.com/api."""
    url = (url or "").strip().rstrip("/")
    parsed = urlparse(url)
    path = (parsed.path or "").rstrip("/")
    if path.endswith("/api/chat"):
        return url[: -len("/chat")]
    if path.endswith("/api/tags"):
        return url[: -len("/tags")]
    if path.endswith("/api/generate"):
        return url[: -len("/generate")]
    if path.endswith("/api"):
        return url
    if path == "":
        return url + "/api"
    if _host_match(url, "ollama.com"):
        root = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else "https://ollama.com"
        return root.rstrip("/") + "/api"
    return url


def _normalize_ollama_url(url: str) -> str:
    """Ensure a native Ollama URL points at /api/chat."""
    base = _ollama_api_root(url)
    return base.rstrip("/") + "/chat"


def _ollama_normalize_tool_messages(messages: List[Dict]) -> List[Dict]:
    """Adapt Orwell' canonical OpenAI-style messages to native Ollama /api/chat.

    Orwell carries assistant tool calls in the OpenAI shape, where
    `function.arguments` is a JSON *string*. Native Ollama expects it to be a
    JSON *object*; given the string it fails the whole request with HTTP 400
    "Value looks like object, but can't find closing '}' symbol", which aborts
    every follow-up (tool-result) round. Parse the arguments back into an object
    here, on a shallow copy, leaving non-tool messages untouched. The opaque
    Gemini `extra_content` (thought_signature) is dropped — it is meaningless to
    Ollama and only matters when the conversation is replayed to Gemini.
    """
    out: List[Dict] = []
    for m in messages or []:
        tcs = m.get("tool_calls") if isinstance(m, dict) else None
        if not tcs:
            out.append(m)
            continue
        new_calls = []
        for tc in tcs:
            fn = tc.get("function") or {}
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args) if args.strip() else {}
                except (json.JSONDecodeError, TypeError):
                    args = {}
            call: Dict = {"function": {"name": fn.get("name", ""), "arguments": args or {}}}
            if tc.get("id"):
                call["id"] = tc["id"]
            new_calls.append(call)
        nm = dict(m)
        nm["tool_calls"] = new_calls
        out.append(nm)
    return out


def _build_ollama_payload(
    model: str,
    messages: List[Dict],
    temperature: float,
    max_tokens: int,
    stream: bool = False,
    tools: Optional[List[Dict]] = None,
    num_ctx: Optional[int] = None,
) -> Dict:
    """Build the JSON payload for Ollama's /api/chat endpoint.

    ``num_ctx`` sets the input context window. Ollama defaults to 2048
    when the option is omitted, so a model with a larger advertised
    window is silently truncated there, and a model with a smaller one
    gets an oversized window it can't service. Pass the discovered
    context length through ``num_ctx``; this builder only emits it when
    the value is trusted (not the ``DEFAULT_CONTEXT`` fallback), so we
    don't guess for unknown models but do tell Ollama the real window
    when we know it — even if it's smaller than 2048.
    """
    payload: Dict = {
        "model": model,
        "messages": _ollama_normalize_tool_messages(messages),
        "stream": stream,
    }
    options: Dict = {}
    if temperature is not None:
        options["temperature"] = temperature
    if max_tokens and max_tokens > 0:
        options["num_predict"] = max_tokens
    if num_ctx is not None and num_ctx > 0 and num_ctx != DEFAULT_CONTEXT:
        options["num_ctx"] = num_ctx
    if options:
        payload["options"] = options
    if tools:
        payload["tools"] = tools
    return payload


def _parse_ollama_response(data: dict) -> str:
    message = data.get("message") or {}
    return message.get("content") or data.get("response") or ""


def _openai_message_text(msg: dict) -> str:
    """Pull the usable text out of an OpenAI-compatible chat `message`.

    Reasoning models (DeepSeek-R1 / -V*, Qwen3, Nemotron, …) frequently return an
    EMPTY ``content`` and put their tokens in a reasoning field — and providers do
    NOT agree on its name: vLLM/NIM emit ``reasoning``, DeepSeek's own API emits
    ``reasoning_content``, some Ollama-compatible builds emit ``thinking``. The
    non-streaming helper used to read only ``content or reasoning_content``, so a
    provider that uses ``reasoning`` (or ``thinking``) returned ``""`` — which broke
    the game's auto-record extraction (``auto-record: no parseable JSON (len=0)``):
    the constrained JSON the model produced lived in a field we never read, so the
    consequence loop never fired. Read every variant so the answer is recoverable
    regardless of provider. (Mirrors the streaming path's reasoning-field handling.)
    """
    if not isinstance(msg, dict):
        return ""
    return (
        msg.get("content")
        or msg.get("reasoning_content")
        or msg.get("reasoning")
        or msg.get("thinking")
        or ""
    )


def _host_match(url: str, *domains: str) -> bool:
    """Return True if url's hostname equals any of `domains` or is a subdomain of one.

    Used by helpers that want "is this Anthropic?" / "is this OpenRouter?"
    style checks. Prefer this over substring matching on the URL: the
    substring form gives wrong answers for unrelated paths or query strings
    that happen to contain the domain text.
    """
    if not url:
        return False
    try:
        # rstrip(".") so a fully-qualified host with a trailing dot
        # ("api.anthropic.com.") still matches "anthropic.com".
        host = (urlparse(url).hostname or "").lower().rstrip(".")
    except Exception:
        return False
    if not host:
        return False
    return any(host == d or host.endswith("." + d) for d in domains)


def _detect_provider(url: str) -> str:
    """Detect the API provider from a configured endpoint URL.

    Matches on hostname (exact or subdomain) rather than substring, so a URL
    that merely contains a provider's domain in its path or query — or a
    look-alike host such as ``anthropic.com.example`` — is not misclassified.
    Unknown hosts fall back to the OpenAI-compatible default, which the
    majority of providers implement.
    """
    if _is_ollama_native_url(url):
        return "ollama"
    if _host_match(url, "anthropic.com"):
        return "anthropic"
    if _host_match(url, "opencode.ai/zen/go"):
        return "opencode-go"
    if _host_match(url, "opencode.ai/zen"):
        return "opencode-zen"
    if _host_match(url, "openrouter.ai"):
        return "openrouter"
    if _host_match(url, "groq.com"):
        return "groq"
    from src.copilot import is_copilot_base
    if is_copilot_base(url):
        return "copilot"
    return "openai"


def _provider_headers(provider: str, headers: Optional[Dict] = None) -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    if isinstance(headers, dict):
        h.update(headers)
    if provider == "openrouter":
        h.setdefault("HTTP-Referer", "https://github.com/Psychout-Media/orwell")
        h.setdefault("X-OpenRouter-Title", "Orwell")
    if provider == "copilot":
        # Ensure the Copilot-required headers are present even when the caller
        # didn't pass pre-built headers (e.g. model listing). build_headers()
        # already injects these for the live chat path; setdefault keeps any
        # request-specific values (x-initiator/vision) the caller set.
        from src.copilot import copilot_headers
        for k, v in copilot_headers(None).items():
            h.setdefault(k, v)
    return h


def _provider_label(url: str) -> str:
    """Human-friendly provider name for error messages."""
    if not url:
        return "provider"
    if _host_match(url, "anthropic.com"): return "Anthropic"
    if _host_match(url, "ollama.com"): return "Ollama Cloud"
    if _host_match(url, "x.ai"): return "xAI"
    if _host_match(url, "openai.com"): return "OpenAI"
    if _host_match(url, "openrouter.ai"): return "OpenRouter"
    if _host_match(url, "opencode.ai/zen/go"): return "OpenCode Go"
    if _host_match(url, "opencode.ai/zen"): return "OpenCode Zen"
    if _host_match(url, "groq.com"): return "Groq"
    from src.copilot import is_copilot_base
    if is_copilot_base(url): return "GitHub Copilot"
    if _host_match(url, "mistral.ai"): return "Mistral"
    if _host_match(url, "deepseek.com"): return "DeepSeek"
    if _host_match(url, "googleapis.com"): return "Google"
    if _host_match(url, "together.xyz", "together.ai"): return "Together"
    if _host_match(url, "fireworks.ai"): return "Fireworks"
    if _is_ollama_native_url(url): return "Ollama"
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return "provider"
    if host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}:
        return "local endpoint"
    return host or "provider"


def _format_upstream_error(status: int, body: bytes | str, url: str) -> str:
    """Turn an upstream HTTP error into a user-readable sentence.

    Auth failures (401/403) become 'xAI rejected the API key' etc., so the UI
    stops showing raw JSON like '{"error":{"message":"User not found."}}'.
    """
    if isinstance(body, bytes):
        try:
            body = body.decode("utf-8", errors="replace")
        except Exception:
            body = str(body)
    provider = _provider_label(url)
    # Try to pull a message out of the body
    detail = ""
    try:
        j = json.loads(body) if body else {}
        if isinstance(j, dict):
            err = j.get("error") or j
            if isinstance(err, dict):
                detail = (err.get("message") or err.get("detail") or "").strip()
            elif isinstance(err, str):
                detail = err.strip()
    except Exception:
        detail = (body or "").strip()[:240]

    if status in (401, 403):
        msg = f"{provider} rejected the API key"
        if status == 403:
            msg = f"{provider} denied access (403)"
        if detail:
            msg += f" — {detail}"
        msg += ". Check Model Endpoints → {} and re-paste the key.".format(provider)
        return msg
    if status == 404:
        return f"{provider} returned 404 — check the base URL and model name." + (f" ({detail})" if detail else "")
    if status == 429:
        return f"{provider} rate-limited the request (429)." + (f" {detail}" if detail else "")
    if status >= 500:
        return f"{provider} is having an outage (HTTP {status})." + (f" {detail}" if detail else "")
    return f"{provider} returned HTTP {status}" + (f": {detail}" if detail else "")

# Models that require max_completion_tokens instead of max_tokens
_MAX_COMPLETION_TOKENS_MODELS = {"o1", "o3", "o4", "gpt-4.5", "gpt-5"}

def _uses_max_completion_tokens(model: str) -> bool:
    """Check if a model requires max_completion_tokens instead of max_tokens."""
    if not model:
        return False
    m = model.lower()
    return any(m.startswith(p) or f"/{p}" in m for p in _MAX_COMPLETION_TOKENS_MODELS)


# ADR 0010 follow-on #2: the model-aware default OUTPUT ceiling — previously a family table + a
# hardcoded 8192 stopgap RIGHT HERE — now lives in the token-policy RESOLVER
# (`src/token_policy.resolve_output_cap`), so the number is a computed policy owned in one place, not
# a literal at the call site. This thin wrapper is kept ONLY because agent_loop.py and the Anthropic
# builder call `_model_max_output_tokens(model)` by name (and tests pin that exact call site); it
# delegates to the resolver. The Anthropic builder REQUIRES an explicit max_tokens (400s if too high),
# and the OpenAI/OpenRouter path applies it only when > 0 — both consume this via the wrapper.
def _model_max_output_tokens(model: str) -> int:
    """The model-aware DEFAULT output cap used when the caller set no explicit ``max_tokens`` —
    delegated to ``token_policy.resolve_output_cap`` (which owns the per-family table + the
    conservative 8192 floor for unrecognized models). Kept as a named wrapper so the existing
    call sites/imports (agent_loop, the Anthropic builder) stay stable."""
    from src.token_policy import resolve_output_cap
    return resolve_output_cap(model)

# OpenAI reasoning models (o1, o3, o4, gpt-5 families) only accept the default
# temperature. Sending any explicit value — even 0.0 — returns HTTP 400
# ("Only the default (1) value is supported"). That otherwise breaks chat when a
# preset sets a non-default temperature, and makes endpoint probing report a
# perfectly good model as failing. For these models we omit the field and let
# the API use its required default. (gpt-4.5 is intentionally excluded — it is
# not a reasoning model and accepts temperature normally.)
_FIXED_TEMPERATURE_MODELS = ("o1", "o3", "o4", "gpt-5")

def _restricts_temperature(model: str) -> bool:
    """Check if a model rejects any non-default temperature."""
    if not model:
        return False
    m = model.lower()
    return any(m.startswith(p) or f"/{p}" in m for p in _FIXED_TEMPERATURE_MODELS)

# Models that support structured thinking — may output </think> without opening tag
_THINKING_MODEL_PATTERNS = ("qwen3", "qwq", "deepseek-r1", "deepseek-reasoner", "minimax", "m2-reap", "gemma")

# BL-017: the live ADR-0016 reasoning families that `_THINKING_MODEL_PATTERNS` does NOT already cover.
# Used ONLY to decide whether to SEND the reasoning-OFF disable (`reasoning:{"enabled":false}`) for a
# reasoning model behind a NON-openrouter, generic OpenAI-compatible host — kept SEPARATE from
# `_THINKING_MODEL_PATTERNS` on purpose so the streaming `<think>`-tag handling (which keys on that
# list) is untouched. The live openrouter path already sends the disable unconditionally
# (`provider == "openrouter"`), so this only helps non-openrouter deployments and is golden-neutral.
_REASONING_OFF_EXTRA_PATTERNS = ("deepseek-v", "glm", "thinkingmachines", "inkling")


def _reasoning_disable_reaches_provider(provider: str, model: str) -> bool:
    """True when a ``reasoning:{"enabled":false}`` disable is a valid/honored field to send for this
    (provider, model). OpenRouter accepts the unified param for any model (harmless if ignored). For a
    generic OpenAI-compatible provider we only send it for a known reasoning model — the documented
    ones (`_supports_thinking`) plus the live ADR-0016 families — so a plain chat model stays
    byte-identical and never 400s on an unknown field."""
    if provider == "openrouter":
        return True
    if _supports_thinking(model):
        return True
    m = (model or "").lower()
    return any(p in m for p in _REASONING_OFF_EXTRA_PATTERNS)

def _supports_thinking(model: str) -> bool:
    """Check if model supports structured thinking output."""
    if not model:
        return False
    m = model.lower()
    return any(p in m for p in _THINKING_MODEL_PATTERNS)


# OpenRouter documents a 1024-token MINIMUM for Anthropic `reasoning.max_tokens`; a request that
# sends a smaller value for an Anthropic model is REJECTED rather than clamped. Our reply-reserving
# sub-budget (`token_policy.resolve_reasoning_max_tokens`) can dip below this when an admin sets a
# tight per-class output cap (e.g. cap 256 → 153), so the emission site must not send a sub-floor
# value to an Anthropic model. (Non-Anthropic reasoners have no documented floor and keep the exact
# value, which is what protects their reply from the reasoning chain — #835.)
_OPENROUTER_ANTHROPIC_REASONING_MIN = 1024


def _is_anthropic_model(model: str) -> bool:
    """True for an Anthropic (Claude) model — direct (``claude-…``) or via an OpenRouter
    ``anthropic/…`` slug. Used only to honor OpenRouter's Anthropic `reasoning.max_tokens` floor."""
    if not model:
        return False
    m = model.lower()
    return "claude" in m or m.startswith("anthropic/")



# DeepSeek's own API returns token counts but no dollar cost. Estimate it (labelled `cost_estimated`) from the
# published per-1M-token prices (api-docs.deepseek.com pricing page, read 2026-11-03). Off-peak rates; peak
# (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri) is exactly 2x. Unknown models price at None (no estimate).
_DEEPSEEK_PRICES_OFFPEAK = {   # model -> (cache-hit in, cache-miss in, out) USD per 1M tokens
    "deepseek-flash": (0.003, 0.15, 0.6),
    "deepseek-v4-flash": (0.003, 0.15, 0.6),
    "deepseek-chat": (0.003, 0.15, 0.6),
    "deepseek-v4-pro": (0.022, 0.66, 1.98),
}


def _deepseek_peak_now(now=None) -> bool:
    import datetime as _dt
    n = now or _dt.datetime.now(_dt.timezone.utc)
    if n.weekday() >= 5:
        return False
    return (1 <= n.hour < 4) or (6 <= n.hour < 10)


def _deepseek_cost_estimate(model: str, prompt_tokens: int, cached_tokens: int, output_tokens: int,
                            now=None) -> Optional[float]:
    """Estimated USD cost of one DeepSeek call, or None for an unpriced model. Reasoning tokens are already
    inside `output_tokens` (DeepSeek bills them as output)."""
    price = _DEEPSEEK_PRICES_OFFPEAK.get((model or "").lower())
    if not price:
        return None
    hit = max(0, min(int(cached_tokens or 0), int(prompt_tokens or 0)))
    miss = max(0, int(prompt_tokens or 0) - hit)
    mult = 2.0 if _deepseek_peak_now(now) else 1.0
    return round(mult * (hit * price[0] + miss * price[1] + int(output_tokens or 0) * price[2]) / 1_000_000, 8)


def _apply_deepseek_thinking_off(payload: Dict, url: str, model: str) -> None:
    """DeepSeek's OWN API (api.deepseek.com) defaults thinking ON, and with ``tools`` on the wire a
    thinking turn 400s unless ``reasoning_content`` is echoed back on every later request. The agent
    loop is a tool loop, so on that host we always send ``{"thinking": {"type": "disabled"}}`` and drop
    the OpenRouter-style ``reasoning`` fields (DeepSeek uses ``thinking``/``reasoning_effort``, not the
    unified map). The legacy ``deepseek-reasoner`` is thinking-only, so it is left untouched. Host-gated
    so every other provider (incl. DeepSeek served via OpenRouter) stays byte-identical."""
    if not _host_match(url, "deepseek.com"):
        return
    if "reasoner" in (model or "").lower():
        return
    payload.pop("reasoning", None)
    payload.pop("reasoning_effort", None)
    payload["thinking"] = {"type": "disabled"}


def _apply_reasoning_budget(payload: Dict, provider: str, model: str, policy: Optional[Dict],
                            requested_max_tokens: Optional[int] = None) -> None:
    """ADR 0010 slice B: inject the per-call-class reasoning budget into an OpenAI-compatible payload,
    PROVIDER-AWARE so it fires for the live model and never breaks a non-reasoning one (NOT gated on
    `_supports_thinking`, whose pattern list predates DeepSeek-V4 and would silently no-op the live
    narration model):
      • OpenAI o-series  → `reasoning_effort` (effort-only; o-series reasoning is intrinsic);
      • OpenRouter       → the unified `reasoning` map (applied to reasoners like DeepSeek-V*/o-series,
                           ignored for the rest — safe to always send), carrying BOTH the ratified
                           `effort` AND a model-aware `max_tokens` sub-budget (see below);
      • other direct providers → only when the model is a known thinking model (else omit, so a plain
                           chat model is byte-identical and never 400s on an unknown field);
                           effort-only there (the `max_tokens` sub-budget is an OpenRouter unified param).
    EXPLICIT OFF is a genuine disable, not an omission: when a call class resolves to effort
    "off" the policy carries ``reasoning is None``. OMITTING the field would let a reasoning model
    (DeepSeek-V*/o-series) fall back to its provider DEFAULT (often ON) — so "off" would silently
    NOT be a cost floor. Instead we actively send ``reasoning: {"enabled": false}`` to OpenRouter
    (the unified form documented as "whether reasoning is enabled"; verified upstream via
    ``debug.echo_upstream_body`` — ADR 0010). OpenAI o-series reasoning is intrinsic and cannot be
    disabled, so we leave it untouched there.

    ADR 0010 follow-on #2 (the F-S4-D mechanism): on OpenRouter the `reasoning` map also carries a
    MODEL-AWARE `max_tokens` sub-budget so thinking can NEVER starve the visible reply. A reasoning
    model bills its hidden chain-of-thought against the SAME output budget as the answer, so we cap
    the think at a fraction of the *effective* output ceiling — the explicit per-request/admin cap
    when set (``requested_max_tokens``), else the model-aware default (``_model_max_output_tokens``),
    whichever is TIGHTER — with ``token_policy.resolve_reasoning_max_tokens`` reserving reply headroom.
    `effort` stays the primary control (for providers that only honor effort); `max_tokens` is the
    hard reply-protecting bound. The player never sees any of these numbers (mandate #3).

    No-op without a policy (no call class ⇒ byte-identical). Shared by the streaming and
    non-streaming builders."""
    if not (policy and isinstance(policy, dict)) or "reasoning" not in policy:
        return
    reasoning = policy.get("reasoning")
    # Explicit OFF: a call class was resolved but chose no reasoning. Actively disable it for a
    # reasoning model rather than omitting (which leaves the provider default ON).
    if reasoning is None:
        if provider == "openai" and _uses_max_completion_tokens(model):
            return  # o-series reasoning is intrinsic — cannot be turned off; leave the default
        # BL-017: send the strongest reasoning-OFF signal wherever it is a valid field. On OpenRouter
        # this is unconditional (the live path); for a generic OpenAI-compatible host it fires for a
        # known reasoning model incl. the live ADR-0016 families (glm / deepseek-v / thinkingmachines)
        # that the older `_supports_thinking` list missed — so a reasoning model there no longer bursts
        # its default (billing output as reasoning) when a call class asked for OFF.
        if _reasoning_disable_reaches_provider(provider, model):
            payload["reasoning"] = {"enabled": False}
        return
    eff = reasoning.get("effort") if isinstance(reasoning, dict) else None
    if not eff:
        return
    if provider == "openai" and _uses_max_completion_tokens(model):
        payload["reasoning_effort"] = eff
    elif provider == "openrouter" or _supports_thinking(model):
        reasoning_map = {"effort": eff}
        if provider == "openrouter":
            # Bound reasoning below the reply's reserved headroom, sized off the tighter of the
            # explicit per-request cap and the model-aware default (the resolver owns the formula).
            from src.token_policy import resolve_reasoning_max_tokens
            model_cap = _model_max_output_tokens(model)
            if (isinstance(requested_max_tokens, int) and not isinstance(requested_max_tokens, bool)
                    and requested_max_tokens > 0):
                basis = min(requested_max_tokens, model_cap)
            else:
                basis = model_cap
            reasoning_max = resolve_reasoning_max_tokens(basis)
            # Only attach the explicit sub-budget when it is provider-VALID. A tight admin cap can
            # drive it below OpenRouter's 1024-token Anthropic floor (cap 256 → 153), which Anthropic
            # REJECTS — so for a Claude model below the floor we omit `max_tokens` and let `effort`
            # (plus the tight cap itself) bound the think. A non-Anthropic reasoner has no such floor
            # and keeps the exact value, which is what protects its reply from the reasoning chain
            # (#835). At the usual (untightened) caps the sub-budget is far above the floor, so this
            # guard is a no-op on the common path.
            #
            # OpenRouter's unified `reasoning` accepts EITHER `effort` OR `max_tokens`, NEVER BOTH —
            # sending both returns HTTP 400 "Only one of reasoning.effort and reasoning.max_tokens can
            # be specified" (observed on z-ai/glm-5.2 via Novita), which empties the whole response and
            # stalls the game (no reply, no reasoning). So when we have a provider-valid `max_tokens`,
            # send it ALONE and DROP `effort`: `max_tokens` is the precise reply-protecting bound
            # (#1420-#2 F-S4-D), sized off the tighter per-call-class cap so it still scales by class
            # (narration's big cap → big think; utility's small cap → small) AND can never starve the
            # visible reply. Fall back to `effort` alone only where a valid `max_tokens` can't be sent
            # (the Anthropic sub-1024-floor case, #1481). NOTE: every automated gate stubs the LLM, so
            # this provider contract is only exercised on a real key (the 0108 golden RECORD caught it).
            if reasoning_max >= _OPENROUTER_ANTHROPIC_REASONING_MIN or not _is_anthropic_model(model):
                reasoning_map = {"max_tokens": reasoning_max}
        payload["reasoning"] = reasoning_map

def _convert_openai_content_to_anthropic(content):
    """Convert OpenAI multimodal content blocks to Anthropic format.

    Converts image_url blocks (data URI) → Anthropic image blocks.
    Passes text blocks through unchanged.
    """
    if not isinstance(content, list):
        return content
    converted = []
    for block in content:
        if not isinstance(block, dict):
            converted.append(block)
            continue
        if block.get("type") == "image_url":
            url = (block.get("image_url") or {}).get("url", "")
            # Parse data URI: data:image/<fmt>;base64,<data>
            if url.startswith("data:"):
                try:
                    header, b64_data = url.split(",", 1)
                    media_type = header.split(";")[0].replace("data:", "")
                except (ValueError, IndexError):
                    continue
                converted.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": b64_data,
                    },
                })
            else:
                # External URL — use Anthropic's URL source
                converted.append({
                    "type": "image",
                    "source": {"type": "url", "url": url},
                })
        elif block.get("type") == "text":
            converted.append(block)
        else:
            converted.append(block)
    return converted


def _build_anthropic_payload(model, messages, temperature, max_tokens, stream=False, tools=None):
    """Convert OpenAI-style messages to Anthropic format."""
    system_parts = []
    chat_messages = []
    for m in messages:
        if m.get("role") == "system":
            system_parts.append(m.get("content") or "")
        elif m.get("role") == "tool":
            # Convert OpenAI tool result to Anthropic format
            chat_messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id", ""),
                    "content": m.get("content", ""),
                }],
            })
        elif m.get("role") == "assistant" and isinstance(m.get("tool_calls"), list):
            # Convert OpenAI assistant tool_calls to Anthropic format
            content = []
            if m.get("content"):
                content.append({"type": "text", "text": m["content"]})
            for tc in m["tool_calls"]:
                fn = tc.get("function") or {}
                args_str = fn.get("arguments") or "{}"
                try:
                    args = json.loads(args_str) if isinstance(args_str, str) else args_str
                except (json.JSONDecodeError, TypeError):
                    args = {}
                content.append({
                    "type": "tool_use",
                    "id": tc.get("id", ""),
                    "name": fn.get("name", ""),
                    "input": args,
                })
            chat_messages.append({"role": "assistant", "content": content})
        else:
            # Convert multimodal content (image_url → image) for Anthropic
            content = _convert_openai_content_to_anthropic(m["content"])
            chat_messages.append({"role": m["role"], "content": content})
    # Anthropic only accepts temperature in [0.0, 1.0] and 400s on anything above
    # 1.0. Clamp here (in the Anthropic builder only) so presets/sliders that use
    # the wider OpenAI 0.0-2.0 range — e.g. the shipped "Nietzsche" preset at 1.2
    # — don't hard-break every Claude request. OpenAI's own path is left untouched.
    if temperature is not None:
        temperature = max(0.0, min(temperature, 1.0))
    # F-S4-D: Anthropic REQUIRES an explicit max_tokens, so an unset cap (0) must fall back to a literal.
    # The old 4096 floor truncated reasoning/long narration mid-reply (a reasoning model burns the budget
    # thinking, then has little left for the answer). ADR 0010 #2: the fallback is now MODEL-AWARE
    # (`_model_max_output_tokens`) instead of a single hardcoded 8192 — a reasoning model gets a generous
    # per-family floor (Opus/Sonnet 4.x ≫ Haiku 3.5) that still stays under each model's hard cap (no 400
    # risk). A configured preset/per-class cap still wins; the `finish:length` → Continue affordance covers
    # whatever still overflows.
    _anthropic_default_max_tokens = max_tokens if max_tokens and max_tokens > 0 else _model_max_output_tokens(model)
    payload = {
        "model": model,
        "messages": chat_messages,
        "max_tokens": _anthropic_default_max_tokens,
        "temperature": temperature,
    }
    if system_parts:
        system_text = "\n\n".join(system_parts)
        # Send `system` as a structured text block so we can attach a prompt-cache
        # breakpoint. The agent loop re-sends this same large prefix every round;
        # caching it makes Anthropic re-read it from cache (~90% cheaper, lower TTFB)
        # instead of re-billing it. Skip caching tiny one-off prompts, where the
        # cache-WRITE premium wouldn't pay back (no reuse). Presence of `tools`
        # means an agentic/multi-round call, where the prefix is always reused.
        system_block = {"type": "text", "text": system_text}
        if tools or len(system_text) > 4000:
            system_block["cache_control"] = {"type": "ephemeral"}
        payload["system"] = [system_block]
    if stream:
        payload["stream"] = True
    # Convert OpenAI-format tools to Anthropic format
    if tools:
        anthropic_tools = []
        for t in tools:
            if t.get("type") == "function":
                fn = t["function"]
                anthropic_tools.append({
                    "name": fn["name"],
                    "description": fn.get("description", ""),
                    "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
                })
        if anthropic_tools:
            # Cache the tool schemas too — they're stable for the whole agent run.
            # The breakpoint caches all tool defs preceding it in the request.
            anthropic_tools[-1]["cache_control"] = {"type": "ephemeral"}
            payload["tools"] = anthropic_tools
    return payload

def _build_anthropic_headers(headers):
    """Convert Bearer auth to x-api-key for Anthropic."""
    h = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
    if headers:
        for k, v in headers.items():
            if k.lower() == "authorization" and isinstance(v, str) and v.startswith("Bearer "):
                h["x-api-key"] = v[7:]
            else:
                h[k] = v
    return h

def _parse_anthropic_response(data: dict) -> str:
    """Extract text from an Anthropic response.

    The Messages API `content` is an array that can hold more than one text
    block (e.g. text split around a tool_use block, or citation-segmented
    text). Concatenate them all instead of returning only the first, which
    silently dropped the rest of the reply.
    """
    return "".join(
        block.get("text", "")
        for block in data.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    )


def _as_content_blocks(content) -> List[Dict]:
    """Coerce a message `content` into a list of content blocks.

    A list (multimodal: text + image parts) passes through; a non-empty string
    becomes a single text block; None/empty yields no blocks. Used when merging
    consecutive user messages so multimodal content isn't str()-ed away.
    """
    if isinstance(content, list):
        return content
    if content:
        return [{"type": "text", "text": str(content)}]
    return []


def _is_blank_content(content) -> bool:
    """True when a message body carries NO usable content: None, an empty or
    whitespace-only string, or an empty content-block list.

    A non-empty multimodal list (e.g. an image part) is NOT blank, so image-only
    user turns are preserved. Used to drop dead-weight empty messages before a
    provider request (see _sanitize_llm_messages)."""
    if content is None:
        return True
    if isinstance(content, str):
        return not content.strip()
    if isinstance(content, list):
        return len(content) == 0
    return False


def _sanitize_llm_messages(messages: List[Dict]) -> List[Dict]:
    """Strip Orwell-only metadata before sending messages to providers.

    Per the OpenAI chat format: user/system messages must have content; a tool
    message needs content + tool_call_id; an assistant message may carry content,
    tool_calls, or both. The old guard required content on every message, which
    dropped a valid assistant message that has only tool_calls — e.g. the
    follow-up message _append_tool_results builds for a no-prose native tool call
    (content=None, since Gemini/Ollama reject tool_calls alongside ""). Dropping
    it leaves the tool result dangling and breaks the next round.

    The mirror gap is BLANK content: a user/system/assistant message whose content
    is "" / whitespace / None with no tool_calls is dead weight — OpenRouter and
    DeepSeek confuse it (or 400 on it). It arises when a reasoning model routes its
    whole turn to the reasoning channel (visible content empty) and that empty turn
    gets PERSISTED, then replayed to the provider as `{"role":"assistant","content":""}`
    on every later turn. Drop those here — the one chokepoint every provider request
    funnels through — so no empty message can reach a provider regardless of source.
    Tool results are exempt (an empty result is a valid answer to a tool_call, and
    dropping it would orphan the assistant tool_calls before the adjacency repair).
    """
    allowed = {"role", "content", "name", "tool_call_id", "tool_calls", "function_call"}
    cleaned = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        item = {k: v for k, v in msg.items() if k in allowed and v is not None}
        role = item.get("role")
        if not role:
            continue
        if role == "assistant":
            # Re-add an explicit content=None when the message is tool-calls-only
            # (the None was stripped above) so the provider gets the spec-correct
            # `content: null`, not an omitted key.
            if "content" not in item and item.get("tool_calls"):
                item["content"] = None
            # Keep an assistant turn only if it carries tool calls OR real prose.
            # A blank-content assistant with no tool_calls is the empty-message leak.
            if item.get("tool_calls") or not _is_blank_content(item.get("content")):
                cleaned.append(item)
        elif role == "tool":
            if "content" in item and "tool_call_id" in item:
                cleaned.append(item)
        elif not _is_blank_content(item.get("content")):
            cleaned.append(item)

    # Repair tool-call adjacency before sending to any OpenAI-compatible
    # provider. Trimming/compaction/retries can leave `role:"tool"` messages
    # without their immediately-preceding assistant `tool_calls` parent, which
    # DeepSeek rejects with:
    # "Messages with role 'tool' must be a response to a preceding message with
    # 'tool_calls'". Also strip unanswered assistant tool_calls; some providers
    # reject those as incomplete conversations.
    repaired: List[Dict] = []
    i = 0
    while i < len(cleaned):
        msg = cleaned[i]
        role = msg.get("role")

        if role == "tool":
            # Orphan tool result. There is no valid assistant tool_calls parent
            # immediately before this batch, so it cannot be sent.
            logger.debug("Dropping orphan tool message before provider request")
            i += 1
            continue

        tool_calls = msg.get("tool_calls") if role == "assistant" else None
        if not tool_calls:
            repaired.append(msg)
            i += 1
            continue

        call_ids = [
            str(tc.get("id"))
            for tc in tool_calls
            if isinstance(tc, dict) and tc.get("id")
        ]
        expected = set(call_ids)
        answered_ids = []
        tool_batch = []
        j = i + 1
        while j < len(cleaned) and cleaned[j].get("role") == "tool":
            tid = str(cleaned[j].get("tool_call_id") or "")
            if tid in expected and tid not in answered_ids:
                answered_ids.append(tid)
                tool_batch.append(cleaned[j])
            else:
                logger.debug("Dropping unmatched/duplicate tool message before provider request")
            j += 1

        if not tool_batch:
            plain = {k: v for k, v in msg.items() if k != "tool_calls"}
            if (plain.get("content") or "").strip():
                repaired.append(plain)
            else:
                logger.debug("Dropping unanswered assistant tool_calls before provider request")
            i = j
            continue

        answered = set(answered_ids)
        pruned_calls = [
            tc for tc in tool_calls
            if isinstance(tc, dict) and str(tc.get("id")) in answered
        ]
        fixed = dict(msg)
        fixed["tool_calls"] = pruned_calls
        if "content" not in fixed:
            fixed["content"] = None
        repaired.append(fixed)
        repaired.extend(tool_batch)
        if len(pruned_calls) != len(tool_calls):
            logger.debug("Pruned unanswered assistant tool_calls before provider request")
        i = j

    # Merge consecutive user messages to satisfy strict role alternation
    # requirements after invalid tool-call fragments have been removed.
    merged: List[Dict] = []
    for item in repaired:
        if not merged:
            merged.append(item)
            continue

        last = merged[-1]
        if last.get("role") == "user" and item.get("role") == "user":
            last_copy = dict(last)
            lc = last_copy.get("content")
            ic = item.get("content")
            if isinstance(lc, list) or isinstance(ic, list):
                # Preserve multimodal content blocks (e.g. an image part) by
                # concatenating the block lists. str()-ing a list turned an
                # image message into its Python repr and dropped the image.
                merged_blocks = _as_content_blocks(lc) + _as_content_blocks(ic)
                if merged_blocks:
                    last_copy["content"] = merged_blocks
                else:
                    last_copy.pop("content", None)
            else:
                last_str = str(lc) if lc is not None else ""
                item_str = str(ic) if ic is not None else ""
                new_content = "\n\n".join(part for part in (last_str, item_str) if part)
                if new_content:
                    last_copy["content"] = new_content
                else:
                    last_copy.pop("content", None)
            merged[-1] = last_copy
        else:
            merged.append(item)

    return merged

def _normalize_anthropic_url(url: str) -> str:
    """Ensure Anthropic URL points to /v1/messages."""
    url = url.rstrip("/")
    if url.endswith("/v1/messages"):
        return url
    if url.endswith("/v1"):
        return url + "/messages"
    return url + "/v1/messages"


def _ensure_openai_chat_path(url: str) -> str:
    """Ensure an OpenAI-compatible chat POST targets /chat/completions, not a bare API base.

    A session/endpoint URL is sometimes stored as the raw provider base (e.g.
    ``https://openrouter.ai/api/v1``) rather than the resolved chat URL. POSTing the base
    returns the provider's HTML landing page with HTTP 200 — an unparseable ~150KB body that
    surfaces as an empty completion (no content, no usage), i.e. a vanished turn. The
    ``resolve_endpoint`` path already appends the path via ``build_chat_url``; this is the
    defensive counterpart for callers that pass a bare base (the live agent loop uses the
    session's stored ``endpoint_url``).

    Idempotent and conservative: a URL already ending in a known completion path is returned
    unchanged, and only a bare ``…/v1`` / ``…/api/v1`` / ``…/api`` base gets ``/chat/completions``
    appended — a non-standard custom path (copilot/opencode/etc.) is left untouched."""
    u = (url or "").rstrip("/")
    if not u:
        return url
    if u.endswith(("/chat/completions", "/completions", "/responses", "/v1/messages")):
        return u
    if u.endswith("/v1") or u.endswith("/api/v1") or u.endswith("/api"):
        return u + "/chat/completions"
    # DeepSeek's own API is served from the bare host root (``https://api.deepseek.com``, no /v1), so a
    # stored raw base (a recovered model-less session, the slash-command setup URL) has no path suffix
    # to key on — recognise the root host explicitly (PO ruling 2026-11-02).
    if _host_match(u, "deepseek.com") and not (urlparse(u).path or "").strip("/"):
        return u + "/chat/completions"
    return url


def _model_list_base(url: str) -> str:
    """Normalize model/chat URLs to the configured endpoint base."""
    base = (url or "").strip().rstrip("/")
    for suffix in ("/models", "/chat/completions", "/completions", "/v1/messages"):
        if base.endswith(suffix):
            base = base[: -len(suffix)].rstrip("/")
    for suffix in ("/chat", "/tags", "/generate"):
        if base.endswith("/api" + suffix):
            base = base[: -len(suffix)].rstrip("/")
    return base


def _parse_model_cache(raw) -> List[str]:
    if not raw:
        return []
    try:
        models = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return []
    if not isinstance(models, list):
        return []
    out = []
    seen = set()
    for item in models:
        mid = str(item or "").strip()
        if not mid or mid in seen:
            continue
        out.append(mid)
        seen.add(mid)
    return out


def _configured_cached_model_ids(endpoint_url: str) -> List[str]:
    """Return cached models for a configured endpoint matching endpoint_url."""
    target = _model_list_base(endpoint_url)
    if not target:
        return []
    try:
        from src.database import SessionLocal, ModelEndpoint
    except Exception:
        return []
    db = SessionLocal()
    try:
        rows = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True).all()
        for ep in rows:
            if _model_list_base(getattr(ep, "base_url", "")) != target:
                continue
            models = _parse_model_cache(getattr(ep, "cached_models", None) or getattr(ep, "models", None))
            if not models:
                continue
            hidden = set(_parse_model_cache(getattr(ep, "hidden_models", None)))
            return [m for m in models if m not in hidden]
    except Exception:
        return []
    finally:
        try:
            db.close()
        except Exception:
            pass
    return []


def list_model_ids(base_chat_url: str, timeout: int = LLMConfig.DEFAULT_TIMEOUT, headers: Optional[Dict] = None) -> List[str]:
    """List available model IDs from an endpoint."""
    cached = _configured_cached_model_ids(base_chat_url)
    if cached:
        return cached
    provider = _detect_provider(base_chat_url)
    if provider == "anthropic":
        return list(ANTHROPIC_MODELS)
    try:
        h = {}
        if headers:
            h.update(headers)
        if provider == "ollama":
            models_url = _ollama_api_root(base_chat_url) + "/tags"
        else:
            models_url = base_chat_url.replace("/chat/completions", "/models")
        r = httpx.get(models_url, headers=h, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        model_ids = [m.get("id") for m in (data.get("data") or []) if m.get("id")]
        if not model_ids:
            model_ids = [
                m.get("name") or m.get("model")
                for m in (data.get("models") or [])
                if m.get("name") or m.get("model")
            ]
        return model_ids
    except Exception:
        try:
            if ":11434" in base_chat_url or "ollama" in base_chat_url.lower():
                root = base_chat_url.replace("/v1/chat/completions", "").replace("/chat/completions", "").rstrip("/")
                r = httpx.get(root + "/api/tags", timeout=timeout)
                r.raise_for_status()
                return [m.get("name") or m.get("model") for m in (r.json().get("models") or []) if m.get("name") or m.get("model")]
        except Exception:
            pass
        return []

def normalize_model_id(endpoint_url: str, requested: str, timeout: int = LLMConfig.DEFAULT_TIMEOUT) -> Optional[str]:
    """Normalize a model ID to match available models."""
    avail = list_model_ids(endpoint_url, timeout)
    if not avail:
        return None
    if requested in avail:
        return requested
    import os as _os
    req_base = _os.path.basename(requested.rstrip("/"))
    for a in avail:
        if _os.path.basename(a.rstrip("/")) == req_base:
            return a
    return None

def _enforce_text_route(url, model, headers):
    """ORW-287: the game build sends no TEXT call to OpenRouter (see src/text_routing.py). Raises TextRoutingRefused."""
    from src.text_routing import enforce_text_destination
    return enforce_text_destination(url, model, headers if isinstance(headers, dict) else None)


def llm_call(url: str, model: str, messages: List[Dict], temperature: float = LLMConfig.DEFAULT_TEMPERATURE,
             max_tokens: int = LLMConfig.DEFAULT_MAX_TOKENS, headers: Optional[Dict] = None, 
             timeout: int = LLMConfig.DEFAULT_TIMEOUT, prompt_type: Optional[str] = None) -> str:
    """Synchronous LLM call with optional prompt type enhancement."""
    url, model, headers = _enforce_text_route(url, model, headers)
    h = _provider_headers(_detect_provider(url))
    # Tolerate headers that arrive as a JSON string (some sessions stored them
    # double-encoded) — otherwise h.update() throws "dictionary update sequence
    # element #0 has length 1; 2 is required".
    if isinstance(headers, str):
        try:
            headers = json.loads(headers)
        except Exception:
            headers = None
    if isinstance(headers, dict):
        h.update(headers)

    messages_copy = _sanitize_llm_messages(messages)

    # Consolidate multiple system messages into one at the start.
    sys_parts = []
    non_sys = []
    for m in messages_copy:
        if m.get("role") == "system":
            sys_parts.append(m.get('content') or '')
        else:
            non_sys.append(m)
    if sys_parts:
        messages_copy = [{"role": "system", "content": "\n\n".join(sys_parts)}] + non_sys
    else:
        messages_copy = non_sys

    provider = _detect_provider(url)
    cache_key = _get_cache_key(url, model, messages_copy, temperature, max_tokens)
    cached_response = _get_cached_response(cache_key)
    if cached_response:
        logger.debug(f"Returning cached response for key: {cache_key}")
        return cached_response

    if provider == "anthropic":
        target_url = _normalize_anthropic_url(url)
        h = _build_anthropic_headers(headers)
        payload = _build_anthropic_payload(model, messages_copy, temperature, max_tokens)
    elif provider == "ollama":
        target_url = _normalize_ollama_url(url)
        payload = _build_ollama_payload(
            model, messages_copy, temperature, max_tokens,
            stream=False, num_ctx=get_context_length(url, model),
        )
    else:
        target_url = _ensure_openai_chat_path(url)
        if provider == "copilot":
            from src.copilot import apply_request_headers
            apply_request_headers(h, messages_copy)
        payload = {
            "model": model,
            "messages": messages_copy,
            "temperature": temperature,
        }
        if _restricts_temperature(model):
            payload.pop("temperature", None)
        if max_tokens and max_tokens > 0:
            tok_key = "max_completion_tokens" if _uses_max_completion_tokens(model) else "max_tokens"
            payload[tok_key] = max_tokens
        # DeepSeek's own API defaults thinking ON — keep the sync path off too (host-gated no-op elsewhere).
        _apply_deepseek_thinking_off(payload, url, model)
    try:
        note_model_activity(target_url, model)
        r = httpx.post(target_url, headers=h, json=payload, timeout=timeout)
    except Exception as e:
        raise HTTPException(502, f"POST {target_url} failed: {e}")
    if not r.is_success:
        raise HTTPException(502, f"Upstream {target_url} -> {r.status_code}: {r.text}")
    data = r.json()
    try:
        if provider == "anthropic":
            response = _parse_anthropic_response(data)
        elif provider == "ollama":
            response = _parse_ollama_response(data)
        else:
            msg = data["choices"][0]["message"]
            response = _openai_message_text(msg)
        _set_cached_response(cache_key, response)
        return response
    except Exception:
        raise HTTPException(502, f"Unexpected schema from {target_url}: {str(data)[:400]}")


def _dedupe_candidates(candidates):
    """Filter malformed entries and drop a later repeat of an already-seen
    ``(url, model)`` route, preserving order (first occurrence wins).

    The chain is the primary target followed by the configured fallbacks, so a
    fallback that repeats the session's current model — a common misconfiguration,
    since callers prepend the live ``(url, model)`` to ``default_model_fallbacks``
    — would otherwise make the chain re-attempt the very route that just failed:
    a wasted round-trip plus a spurious ``fallback`` notice for a switch that did
    not happen. Headers are not part of the key; the first tuple (with its
    headers) is the one kept.
    """
    seen = set()
    out = []
    for c in candidates or []:
        if not c or not c[0] or not c[1]:
            continue
        key = (c[0], c[1])
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def llm_call_with_fallback(candidates, messages, **kwargs) -> str:
    """Sync `llm_call` with an ordered fallback chain.

    `candidates` is a list of (url, model, headers). The first one that returns
    without an exception wins. Connection / 5xx-style failures fall through to
    the next candidate. The dead-host cooldown inside `llm_call` makes repeat
    attempts at an offline primary effectively free.
    """
    cands = _dedupe_candidates(candidates)
    if not cands:
        raise HTTPException(503, "No model endpoint configured")
    last_err = None
    for i, (url, model, headers) in enumerate(cands):
        try:
            return llm_call(url, model, messages, headers=headers, **kwargs)
        except Exception as e:
            last_err = e
            tag = "primary" if i == 0 else "candidate"
            logger.warning(f"[fallback] {tag} {model} failed ({type(e).__name__}); trying next")
            continue
    raise last_err if last_err else HTTPException(503, "All fallback candidates failed")


async def llm_call_async_with_fallback(candidates, messages, **kwargs) -> str:
    """Async variant of `llm_call_with_fallback` — same semantics."""
    cands = _dedupe_candidates(candidates)
    if not cands:
        raise HTTPException(503, "No model endpoint configured")
    last_err = None
    for i, (url, model, headers) in enumerate(cands):
        try:
            return await llm_call_async(url, model, messages, headers=headers, **kwargs)
        except Exception as e:
            last_err = e
            tag = "primary" if i == 0 else "candidate"
            logger.warning(f"[fallback] {tag} {model} failed ({type(e).__name__}); trying next")
            continue
    raise last_err if last_err else HTTPException(503, "All fallback candidates failed")


async def llm_call_async(
    url: str,
    model: str,
    messages: List[Dict],
    temperature: float = LLMConfig.DEFAULT_TEMPERATURE,
    max_tokens: int = LLMConfig.DEFAULT_MAX_TOKENS,
    headers: Optional[Dict] = None,
    timeout: int = LLMConfig.STREAM_TIMEOUT,
    max_retries: int = LLMConfig.MAX_RETRIES,
    prompt_type: Optional[str] = None,
    call_class: Optional[str] = None,
    user: Optional[str] = None,
    session: Optional[str] = None,
) -> str:
    """The public non-streaming chokepoint over the traced utility call."""
    return await _llm_call_async_traced(
        url, model, messages, temperature=temperature, max_tokens=max_tokens,
        headers=headers, timeout=timeout, max_retries=max_retries,
        prompt_type=prompt_type, call_class=call_class, user=user, session=session)


async def _bounded_impl_call(*args, timeout: int, **impl_kwargs) -> str:
    """N4 (2026-07-16 live-playthrough forensics) — wrap ``_llm_call_async_impl`` in a genuine
    WALL-CLOCK ceiling of ``timeout`` seconds, enforced over the WHOLE call (every retry attempt
    the impl's internal loop makes, plus any inter-attempt delay), not just the per-attempt httpx
    ``read`` timeout the impl already sets. Two things defeated that per-attempt timeout in prod:
    (1) it resets on ANY received byte, so an upstream that trickles keep-alive padding while a
    completion is still generating never trips it, and (2) even when it DOES fire, the impl's own
    retry loop (``max_retries``, default 3) multiplies it — a background memory-extraction call
    was observed running 780,485ms (13 minutes) against a nominal ``timeout=300``. ``timeout``
    here is whatever the caller resolved (an explicit override, or ``llm_call_async``'s default);
    this makes that number a REAL ceiling instead of a soft, multipliable hint.

    Falsy ``timeout`` (0/None) is treated as "no ceiling" (unchanged legacy behavior) — no known
    caller passes that, but a literal 0 must never become an instant-expiry `wait_for(timeout=0)`.

    On expiry raises ``asyncio.TimeoutError`` (never returns a silent success) — the ONE type
    ``_exc_fail_class`` already recognizes as ``"timeout"`` (the rc6 #1663 failure-class
    contract), so both ``_llm_call_async_traced`` branches log ``ok:false`` /
    ``failClass:"timeout"`` for free, and every fail-soft background caller (memory extraction,
    the `_auto_*` belts, etc.) sees a genuine exception instead of an artificially-long "success".
    """
    coro = _llm_call_async_impl(*args, timeout=timeout, **impl_kwargs)
    if not timeout:
        return await coro
    try:
        return await asyncio.wait_for(coro, timeout=float(timeout))
    except asyncio.TimeoutError:
        raise asyncio.TimeoutError(
            f"LLM call exceeded its {timeout}s wall-clock ceiling (all attempts/retries included)"
        ) from None


async def _llm_call_async_traced(
    url: str,
    model: str,
    messages: List[Dict],
    temperature: float = LLMConfig.DEFAULT_TEMPERATURE,
    max_tokens: int = LLMConfig.DEFAULT_MAX_TOKENS,
    headers: Optional[Dict] = None,
    timeout: int = LLMConfig.STREAM_TIMEOUT,
    max_retries: int = LLMConfig.MAX_RETRIES,
    prompt_type: Optional[str] = None,
    call_class: Optional[str] = None,
    user: Optional[str] = None,
    session: Optional[str] = None,
) -> str:
    """Tracing wrapper over the non-streaming utility call (src/llm_trace.py) — records
    the full request + response (or error) for the /admin/status LLM I/O trace, then
    returns the impl's result unchanged. Best-effort; disabled ⇒ near-zero passthrough.

    ADR 0010: pass ``call_class`` (e.g. "utility-extraction" / "background-authoring") to apply that
    class's per-class reasoning budget (admin-overridable) AND, with ``user``, record one Vault-free
    token/cost entry per call to the meter — so utility/background spend shows up alongside narration.
    Both are fail-open and default-off (no call_class ⇒ byte-identical to before)."""
    from src import llm_trace
    # ADR 0010: resolve the per-class reasoning budget (fail-open; absent ⇒ no reasoning override).
    policy = None
    if call_class:
        try:
            from src.token_policy import resolve_token_policy
            from src.settings import get_setting as _gs
            policy = resolve_token_policy(call_class, {"reasoning_budget": _gs("reasoning_budget", {})})
        except Exception:
            policy = None
    # Only allocate a usage sink when we will actually meter (call_class + user) — otherwise the impl
    # stays byte-identical (no usage-accounting request, no capture).
    # ORW-292: ALSO allocate it when the I/O trace is on, so a traced non-stream call's record carries the
    # provider's usage even when it is not metered (no user). The ledger write stays call_class + user gated.
    _usage: Optional[Dict] = {} if ((call_class and user) or llm_trace.enabled()) else None
    # The meta sink carries the terminal finish_reason (ADR 0010 #3 ledger field). Defined here so the
    # meter can read it regardless of whether the I/O trace is enabled; populated by both impl calls.
    _meta: Dict = {}

    def _meter():
        # ADR 0010: one Vault-free token/cost entry for a metered utility call, keyed by the canonical
        # game session so it aggregates with the game's narration turns. Fail-open; player never sees it.
        if not (call_class and user and _usage):
            return
        try:
            from src import orwell_token_ledger as _tl
            _sess = session
            if not _sess:
                try:
                    from src import orwell_game_session as _gs2
                    _sess = _gs2.get_game_session(user)
                except Exception:
                    _sess = None
            _tl.record_turn(
                user, session=_sess or user, turn_id=None, call_class=call_class,
                input_tokens=_usage.get("input_tokens", 0), cached_tokens=_usage.get("cached_tokens", 0),
                reasoning_tokens=_usage.get("reasoning_tokens", 0), output_tokens=_usage.get("output_tokens", 0),
                # ADR 0010 #3: the cap sent on the wire for this utility call + its terminal stop reason.
                applied_max_tokens=max_tokens, finish_reason=_meta.get("finish_reason"),
                cost=float(_usage.get("cost") or 0), provider=_usage.get("provider"),
            )
        except Exception:
            pass

    # 0112: the Vault-free observability metadata for the OpenRouter request (None ⇒ no key ⇒
    # byte-identical when observability is disabled — the default). Built once, threaded to the impl.
    _obs_md = llm_trace.maybe_request_metadata(session=session, call_class=call_class)

    async def _emit_obs(status: str, latency_ms: int, text: str = "") -> None:
        # 0112: the single emit point for the non-streaming path. Fail-soft / default-off inside.
        try:
            await llm_trace.emit_trace(
                user=user, session=session, call_class=call_class, model=model,
                usage=_usage, applied_max_tokens=max_tokens,
                finish_reason=_meta.get("finish_reason"), tool_call_seen=False,
                latency_ms=latency_ms, status=status, completion=text)
        except Exception:
            pass

    started = time.time()
    if not llm_trace.enabled():
        text = await _bounded_impl_call(
            url, model, messages, temperature=temperature, max_tokens=max_tokens,
            headers=headers, timeout=timeout, max_retries=max_retries, prompt_type=prompt_type,
            policy=policy, usage_sink=_usage, meta_sink=_meta, obs_metadata=_obs_md)
        _meter()
        await _emit_obs("ok", int((time.time() - started) * 1000), text)
        return text
    try:
        text = await _bounded_impl_call(
            url, model, messages, temperature=temperature, max_tokens=max_tokens,
            headers=headers, timeout=timeout, max_retries=max_retries, prompt_type=prompt_type,
            policy=policy, usage_sink=_usage, meta_sink=_meta, obs_metadata=_obs_md)
        llm_trace.record_llm_call(
            kind="call", model=model, messages=messages, temperature=temperature,
            max_tokens=max_tokens, ok=True, duration_ms=int((time.time() - started) * 1000),
            call_class=call_class, user=user,
            response={"text": text, "reasoning": _meta.get("reasoning") or "",
                      "finishReason": _meta.get("finish_reason"), "usage": _usage or None})
        _meter()
        await _emit_obs("ok", int((time.time() - started) * 1000), text)
        return text
    except Exception as e:
        llm_trace.record_llm_call(
            kind="call", model=model, messages=messages, temperature=temperature,
            max_tokens=max_tokens, ok=False, duration_ms=int((time.time() - started) * 1000),
            call_class=call_class, user=user,
            # S6a: hand the trace the true failure class from the exception shape (timeout vs a
            # 4xx/5xx HTTPException) so llmIo triage isn't a bare "FAILED".
            fail_class=_exc_fail_class(e),
            # The terminal stop reason still rides on a FAILED call when the impl saw one
            # (e.g. the empty-stop guard below raised after parsing finish_reason=stop).
            response={"error": {"type": type(e).__name__, "message": str(e)[:500]},
                      "finishReason": _meta.get("finish_reason")})
        await _emit_obs("error", int((time.time() - started) * 1000))
        raise


async def _llm_call_async_impl(
    url: str,
    model: str,
    messages: List[Dict],
    temperature: float = LLMConfig.DEFAULT_TEMPERATURE,
    max_tokens: int = LLMConfig.DEFAULT_MAX_TOKENS,
    headers: Optional[Dict] = None,
    timeout: int = LLMConfig.STREAM_TIMEOUT,
    max_retries: int = LLMConfig.MAX_RETRIES,
    prompt_type: Optional[str] = None,
    policy: Optional[Dict] = None,
    usage_sink: Optional[Dict] = None,
    meta_sink: Optional[Dict] = None,
    obs_metadata: Optional[Dict] = None,
) -> str:
    """Asynchronous LLM call using httpx with connection pooling, timeout, retry logic, and performance logging.

    ``meta_sink`` (optional): when provided, the parsed response's ``reasoning`` and terminal
    ``finish_reason`` are written into it so the caller can record them in the I/O trace (G2 —
    "preserve ALL I/O"). Untouched when absent ⇒ byte-identical.

    ``obs_metadata`` (optional, feature 0112): a Vault-free correlation object attached as the
    OpenRouter/OpenAI ``metadata`` field so OpenRouter Broadcast forwards correlatable traces.
    ``None`` (observability disabled — the default) ⇒ the key is never added ⇒ byte-identical."""
    url, model, headers = _enforce_text_route(url, model, headers)  # ORW-287
    provider = _detect_provider(url)
    messages_copy = _sanitize_llm_messages(messages)

    # Consolidate multiple system messages into one at the start.
    sys_parts = []
    non_sys = []
    for m in messages_copy:
        if m.get("role") == "system":
            sys_parts.append(m.get('content') or '')
        else:
            non_sys.append(m)
    if sys_parts:
        messages_copy = [{"role": "system", "content": "\n\n".join(sys_parts)}] + non_sys
    else:
        messages_copy = non_sys

    cache_key = _get_cache_key(url, model, messages_copy, temperature, max_tokens)
    cached_response = _get_cached_response(cache_key)
    if cached_response:
        logger.debug(f"Returning cached response for key: {cache_key}")
        return cached_response

    if provider == "anthropic":
        target_url = _normalize_anthropic_url(url)
        h = _build_anthropic_headers(headers)
        payload = _build_anthropic_payload(model, messages_copy, temperature, max_tokens)
    elif provider == "ollama":
        target_url = _normalize_ollama_url(url)
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        payload = _build_ollama_payload(
            model, messages_copy, temperature, max_tokens,
            stream=False, num_ctx=get_context_length(url, model),
        )
    else:
        target_url = _ensure_openai_chat_path(url)
        h = _provider_headers(provider, headers)
        if provider == "copilot":
            from src.copilot import apply_request_headers
            apply_request_headers(h, messages_copy)
        payload = {
            "model": model,
            "messages": messages_copy,
            "temperature": temperature,
        }
        if _restricts_temperature(model):
            payload.pop("temperature", None)
        # ADR 0010: per-class reasoning budget on the non-streaming path too (utility-extraction /
        # background-authoring), + OpenRouter usage accounting so `cost` is returned — but ONLY when a
        # usage_sink is present (we're metering), so a non-metered call stays byte-identical.
        _apply_reasoning_budget(payload, provider, model, policy, requested_max_tokens=max_tokens)
        _apply_deepseek_thinking_off(payload, url, model)
        if provider == "openrouter" and usage_sink is not None:
            payload["usage"] = {"include": True}
        # 0112: attach the Vault-free correlation metadata (only when observability is enabled;
        # None ⇒ the key is never added ⇒ byte-identical). OpenRouter forwards it via Broadcast.
        if obs_metadata:
            payload["metadata"] = obs_metadata
        if max_tokens and max_tokens > 0:
            tok_key = "max_completion_tokens" if _uses_max_completion_tokens(model) else "max_tokens"
            payload[tok_key] = max_tokens

    if _is_host_dead(target_url):
        raise HTTPException(503, f"Upstream {_host_key(target_url)} marked unreachable (cooldown active)")

    call_timeout = httpx.Timeout(connect=3.0, read=float(timeout), write=10.0, pool=5.0)
    attempt = 0
    while attempt < max_retries:
        attempt += 1
        start = time.time()
        try:
            note_model_activity(target_url, model)
            client = _get_http_client()
            r = await client.post(target_url, headers=h, json=payload, timeout=call_timeout)
            duration = time.time() - start
            if not r.is_success:
                friendly = _format_upstream_error(r.status_code, r.text, target_url)
                logger.warning(
                    f"LLM async call to {target_url} failed in {duration:.2f}s "
                    f"(attempt {attempt}): HTTP {r.status_code} {friendly}"
                )
                if r.status_code in (429, 502, 503, 504) and attempt < max_retries:
                    await asyncio.sleep(LLMConfig.RETRY_DELAY)
                    continue
                raise HTTPException(r.status_code, friendly)
            # Loud, always-on upstream diagnostic: a 200 with an EMPTY body is the live
            # symptom (the memory-extraction path returned empty for every model). The status
            # line alone can't distinguish a real completion from a 200-empty-at-the-edge.
            _body_len = len(r.text or "")
            logger.info(
                f"LLM async call to {target_url} succeeded in {duration:.2f}s (attempt {attempt}); "
                f"model={model} status={r.status_code} body_len={_body_len}"
            )
            if _body_len == 0:
                logger.warning(
                    f"upstream 200 but EMPTY body (non-stream) target_url={target_url} "
                    f"model={model} status={r.status_code} — JSON parse will fail; likely a "
                    f"200-empty-at-the-edge, not a real completion"
                )
            _clear_host_dead(target_url)
            try:
                data = r.json()
            except Exception as _je:
                # A 200 with an empty/non-JSON body lands here (the live "Expecting value: line 1
                # column 1" symptom). Make it loud + typed so the next reproduction is conclusive,
                # rather than a swallowed parse error indistinguishable from a real failure.
                logger.warning(
                    f"upstream 200 but UNPARSEABLE/EMPTY body (non-stream) target_url={target_url} "
                    f"model={model} status={r.status_code} body_len={len(r.text or '')} parse_error={_je}"
                )
                raise HTTPException(502, f"Upstream {target_url} returned a 200 with no JSON body (empty completion)")
            # ADR 0010: surface the usage envelope for the meter (the caller records it). Non-streaming
            # OpenAI-compatible providers return it inline; only attach when present.
            if usage_sink is not None and isinstance(data, dict):
                _u = data.get("usage") or {}
                if _u:
                    _ptd = _u.get("prompt_tokens_details") or {}
                    _ctd = _u.get("completion_tokens_details") or {}
                    _cached = _ptd.get("cached_tokens")
                    if _cached is None:
                        _cached = _u.get("prompt_cache_hit_tokens")  # DeepSeek's own field
                    _cost = _u.get("cost")
                    _estimated = False
                    if _cost is None and _host_match(url, "deepseek.com"):
                        _cost = _deepseek_cost_estimate(model, _u.get("prompt_tokens", 0), _cached or 0,
                                                        _u.get("completion_tokens", 0))
                        _estimated = _cost is not None
                    usage_sink.update({
                        "input_tokens": _u.get("prompt_tokens", 0),
                        "output_tokens": _u.get("completion_tokens", 0),
                        "cached_tokens": _cached or 0,
                        "reasoning_tokens": _ctd.get("reasoning_tokens", 0) or 0,
                        "cost": _cost,
                        "provider": provider,
                    })
                    if _estimated:
                        usage_sink["cost_estimated"] = True
            _finish_local: Optional[str] = None
            _saw_tool_calls = False
            try:
                if provider == "anthropic":
                    response = _parse_anthropic_response(data)
                elif provider == "ollama":
                    response = _parse_ollama_response(data)
                else:
                    msg = data["choices"][0]["message"]
                    response = _openai_message_text(msg)
                    if isinstance(msg, dict) and msg.get("tool_calls"):
                        _saw_tool_calls = True
                    _fr0 = (data.get("choices") or [{}])[0].get("finish_reason")
                    if _fr0:
                        _finish_local = str(_fr0)
                    if meta_sink is not None and isinstance(msg, dict):
                        _rsn = msg.get("reasoning_content") or msg.get("reasoning") or ""
                        if _rsn:
                            meta_sink["reasoning"] = _rsn
                        if _fr0:
                            meta_sink["finish_reason"] = _fr0
            except Exception:
                raise HTTPException(502, f"Unexpected schema from {target_url}: {str(data)[:400]}")
            # ── EMPTY "stop" COMPLETION GUARD (2026-07-13 prod debug-bundle audit) ──────────
            # The STREAM path has surfaced empty completions as typed `empty_completion` errors
            # since fix D / #1453 — but this non-stream `call` path silently returned "" on a
            # well-formed 200 whose message body was empty with finish_reason=stop (two such
            # records sat in the live bundle's llmIo ring as ok=True utility calls that folded
            # nothing). An empty non-length completion is NOT a success: log loud and count it
            # as a FAILED attempt (retry like a 5xx; typed 502 when retries are exhausted).
            # Deliberately excluded: a message carrying tool_calls (an empty text body is
            # legitimate there) and finish_reason=length (the cap-cutoff case keeps its ""
            # return so the existing cap-retry / parse-failure floors behave exactly as today).
            if (not (response or "").strip() and not _saw_tool_calls
                    and _finish_local != "length"):
                logger.warning(
                    f"upstream 200 but EMPTY completion (non-stream) target_url={target_url} "
                    f"model={model} finish_reason={_finish_local or 'unknown'} "
                    f"attempt={attempt}/{max_retries} — an empty 'stop' completion is a failed "
                    f"attempt, never a silent success (empty_completion)"
                )
                if attempt < max_retries:
                    await asyncio.sleep(LLMConfig.RETRY_DELAY)
                    continue
                raise HTTPException(
                    502,
                    f"{model} returned an empty completion "
                    f"(finish_reason={_finish_local or 'stop'}) — empty_completion",
                )
            _set_cached_response(cache_key, response)
            return response
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            _cooled = _mark_host_dead(target_url)
            duration = time.time() - start
            _tail = f" — host cooled for {DEAD_HOST_COOLDOWN:.0f}s" if _cooled else " — transient, will retry"
            logger.warning(f"LLM async connect to {target_url} failed after {duration:.2f}s: {e}{_tail}")
            if _cooled or attempt >= max_retries:
                raise HTTPException(503, f"Cannot reach {_host_key(target_url)}: {e}")
            await asyncio.sleep(_connect_backoff(attempt))
        except (httpx.RequestError, httpx.HTTPStatusError) as e:
            duration = time.time() - start
            logger.warning(f"LLM async call attempt {attempt} failed after {duration:.2f}s: {e}")
            if attempt >= max_retries:
                raise HTTPException(502, f"POST {target_url} failed after {max_retries} attempts: {e}")
            await asyncio.sleep(LLMConfig.RETRY_DELAY)

async def stream_llm(url: str, model: str, messages: List[Dict], temperature: float = LLMConfig.DEFAULT_TEMPERATURE,
                     max_tokens: int = LLMConfig.DEFAULT_MAX_TOKENS, headers: Optional[Dict] = None,
                     timeout: int = LLMConfig.STREAM_TIMEOUT, prompt_type: Optional[str] = None,
                     tools: Optional[List[Dict]] = None, policy: Optional[Dict] = None,
                     session_id: Optional[str] = None, pin_provider: bool = False,
                     provider_opts: Optional[Dict] = None,
                     response_format: Optional[Dict] = None,
                     tool_choice: Optional[object] = None,
                     metadata: Optional[Dict] = None,
                     _retry_in_flight: bool = False):
    """Stream LLM responses with improved error handling.

    ``_retry_in_flight`` (private, N-5): set by ``_stream_with_connect_retry`` on attempts 2+ of ONE request, so
    a cooldown that attempt 1 itself tripped does not swallow that request's own remaining retries. Separate
    callers never set it and still fast-fail on a cooled host.

    ``response_format`` (optional): an OpenAI/OpenRouter-style structured-output request
    (e.g. ``{"type": "json_object"}``) threaded onto the OpenAI-style chat payload so a
    model that honours it returns strict JSON (used by the cast-authoring path, #1002). It is
    sent only on the OpenAI-compatible branch (not anthropic/ollama); a provider that ignores
    it is harmless, and absent ⇒ byte-identical to before.

    ``tool_choice`` (optional, issue #1154 / ADR 0016 §D): an OpenAI/OpenRouter-style
    tool-choice directive sent ALONGSIDE ``tools`` to FORCE a tool call at the closed-set
    beats where a missed engine call is catastrophic (e.g. ``"required"`` or a named
    ``{"type": "function", "function": {"name": ...}}`` choice). The agent loop computes it
    only at those beats; spontaneous interleaved calling stays primary everywhere else.
    Sent ONLY on the OpenAI-compatible branch and ONLY when ``tools`` are also present
    (a tool_choice with no tools is a 400 on most providers). **Default ``None`` ⇒ the field
    is never added ⇒ byte-identical to before** — the safety contract. Reasoning lives on its
    own payload channel (``reasoning``/``reasoning_effort``), so this never perturbs it.

    Yields SSE chunks:
      - data: {"delta": "text"}           — text content
      - data: {"type": "tool_calls", ...}  — accumulated native tool calls (before DONE)
      - event: error                       — errors
      - data: [DONE]                       — end of stream
    """
    try:
        url, model, headers = _enforce_text_route(url, model, headers)  # ORW-287
    except Exception as _refused:  # TextRoutingRefused: surface as the outage UX, never a silent OpenRouter text call
        yield f'event: error\ndata: {json.dumps({"error": "text-provider-refused", "status": 503, "text": str(_refused), "error_type": "text-routing"})}\n\n'
        yield "data: [DONE]\n\n"
        return
    provider = _detect_provider(url)
    messages_copy = _sanitize_llm_messages(messages)

    # Consolidate multiple system messages into one at the start.
    # Some models (e.g. Qwen3.5) reject system messages that aren't first.
    sys_parts = []
    non_sys = []
    for m in messages_copy:
        if m.get("role") == "system":
            sys_parts.append(m.get('content') or '')
        else:
            non_sys.append(m)
    if sys_parts:
        messages_copy = [{"role": "system", "content": "\n\n".join(sys_parts)}] + non_sys
    else:
        messages_copy = non_sys

    if provider == "anthropic":
        target_url = _normalize_anthropic_url(url)
        h = _build_anthropic_headers(headers)
        payload = _build_anthropic_payload(model, messages_copy, temperature, max_tokens, stream=True, tools=tools)
    elif provider == "ollama":
        target_url = _normalize_ollama_url(url)
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        payload = _build_ollama_payload(
            model, messages_copy, temperature, max_tokens,
            stream=True, tools=tools, num_ctx=get_context_length(url, model),
        )
    else:
        target_url = _ensure_openai_chat_path(url)
        payload = {
            "model": model,
            "messages": messages_copy,
            "temperature": temperature,
            "stream": True,
        }
        if _restricts_temperature(model):
            payload.pop("temperature", None)
        # ADR 0010 slice B: send the per-call-class reasoning budget (provider-aware; see helper).
        _apply_reasoning_budget(payload, provider, model, policy, requested_max_tokens=max_tokens)
        _apply_deepseek_thinking_off(payload, url, model)
        if provider not in {"openrouter", "groq"}:
            payload["stream_options"] = {"include_usage": True}
        elif provider == "openrouter":
            # ADR 0010 (the meter): OpenRouter returns the usage envelope — incl. the authoritative
            # per-request `cost` plus cached/reasoning details — in the trailing SSE chunk when usage
            # accounting is requested. `stream_options.include_usage` is a no-op on OpenRouter, so ask
            # via OpenRouter's own flag; the streaming parse above reads it back.
            payload["usage"] = {"include": True}
            # ADR 0010 slice C: per-session stickiness keeps OpenRouter routing to the same
            # (cache-warm) provider across a game; above the high-token threshold the caller asks to
            # PIN (no fallback) so a large, expensive-to-recompute prompt never cold-cache-misses on a
            # fallback. Small calls leave fallbacks on for availability.
            if session_id:
                payload["user"] = session_id
            # ADR 0010 slice C: an admin-supplied OpenRouter `provider` routing object (order/sort/only/
            # ignore/max_price/zdr/data_collection/quantizations/…) is the BASE; the high-token pin
            # overlays allow_fallbacks=false so a large prompt stays on the cache-warm provider. Either
            # alone, or merged. A non-dict provider_opts is ignored.
            _prov = dict(provider_opts) if isinstance(provider_opts, dict) else {}
            if pin_provider:
                _prov["allow_fallbacks"] = False
            if _prov:
                payload["provider"] = _prov
        # 0112: attach the Vault-free correlation metadata (only when observability is enabled;
        # None ⇒ the key is never added ⇒ byte-identical). OpenRouter forwards it via Broadcast.
        if metadata:
            payload["metadata"] = metadata
        if max_tokens and max_tokens > 0:
            tok_key = "max_completion_tokens" if _uses_max_completion_tokens(model) else "max_tokens"
            payload[tok_key] = max_tokens
        # #1002: structured-output request (e.g. {"type": "json_object"}) so a model that honours it
        # returns strict JSON for the cast-authoring path. A provider that ignores it is harmless.
        if response_format:
            payload["response_format"] = response_format
        if tools:
            payload["tools"] = tools
            # #1154 / ADR 0016 §D — FORCE the tool call at a catastrophic-miss beat. Only meaningful
            # when tools are also on the wire (a tool_choice with no tools 400s on most providers), so
            # it is nested under `if tools`. Default None ⇒ never added ⇒ byte-identical (the safety
            # contract; asserted in test_tool_choice_force.py). GLM-4.7 honors it (its tool-calling
            # rides interleaved thinking); DeepSeek-V4 rejected `required` in always-thinking mode, so
            # the agent loop only sends it under the GLM-class provider it's verified against.
            if tool_choice is not None:
                payload["tool_choice"] = tool_choice
        h = _provider_headers(provider, headers)
        if provider == "copilot":
            from src.copilot import apply_request_headers
            apply_request_headers(h, messages_copy)

    # Short connect timeout: a reachable peer answers SYN in <100ms even on
    # Tailscale. 3s is plenty; 30s let one dead upstream wedge the UI.
    stream_timeout = httpx.Timeout(connect=3.0, read=float(timeout), write=30.0, pool=5.0)

    if not _retry_in_flight and _is_host_dead(target_url):
        yield f'event: error\ndata: {json.dumps({"error": f"Upstream {_host_key(target_url)} unreachable (cooldown active)", "status": 503})}\n\n'
        return
    note_model_activity(target_url, model)
    _stream_t0 = time.monotonic()

    # ── Native Ollama streaming ──
    if provider == "ollama":
        _ollama_tool_calls: List[Dict] = []
        _harmony_router = _HarmonyStreamRouter()
        try:
            client = _get_http_client()
            async with client.stream('POST', target_url, json=payload, headers=h, timeout=stream_timeout) as r:
                _clear_host_dead(target_url)
                if r.status_code != 200:
                    raw = (await r.aread()).decode(errors="replace")
                    _log_stream_failure(f"status={r.status_code}", target_url, model, _stream_t0, raw)
                    friendly = _format_upstream_error(r.status_code, raw, target_url)
                    yield f'event: error\ndata: {json.dumps({"status": r.status_code, "text": friendly, "raw": raw[:500]})}\n\n'
                    return
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    try:
                        j = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    message = j.get("message") or {}
                    thinking = message.get("thinking") or ""
                    if thinking:
                        yield _stream_delta_event(thinking, thinking=True)
                    content = message.get("content") or ""
                    if content:
                        for part, is_thinking in _harmony_router.feed(content):
                            yield _stream_delta_event(part, thinking=is_thinking)
                    for tc in message.get("tool_calls") or []:
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            _ollama_tool_calls.append({
                                "id": tc.get("id") or f"call_{len(_ollama_tool_calls)}",
                                "name": fn.get("name") or "",
                                "arguments": json.dumps(fn.get("arguments") or {}),
                            })
                    if j.get("done"):
                        for part, is_thinking in _harmony_router.flush():
                            yield _stream_delta_event(part, thinking=is_thinking)
                        if _ollama_tool_calls:
                            yield f'data: {json.dumps({"type": "tool_calls", "calls": _ollama_tool_calls})}\n\n'
                        if j.get("prompt_eval_count") is not None or j.get("eval_count") is not None:
                            yield f'data: {json.dumps({"type": "usage", "data": {"input_tokens": j.get("prompt_eval_count", 0), "output_tokens": j.get("eval_count", 0)}})}\n\n'
                        yield "data: [DONE]\n\n"
                        return
                for part, is_thinking in _harmony_router.flush():
                    yield _stream_delta_event(part, thinking=is_thinking)
                yield "data: [DONE]\n\n"
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            _cooled = _mark_host_dead(target_url)
            _tail = f" — host cooled for {DEAD_HOST_COOLDOWN:.0f}s" if _cooled else " — transient, will retry"
            logger.warning(f"Ollama stream connect to {target_url} failed: {e}{_tail}")
            yield f'event: error\ndata: {json.dumps({"error": f"Cannot reach {_host_key(target_url)}", "status": 503, "error_type": "connect"})}\n\n'
        except httpx.ReadTimeout:
            _log_stream_failure("read-timeout", target_url, model, _stream_t0)
            yield f'event: error\ndata: {json.dumps({"error": "Read timeout", "status": 504})}\n\n'
        except httpx.NetworkError:
            _log_stream_failure("network-error", target_url, model, _stream_t0)
            yield f'event: error\ndata: {json.dumps({"error": "Network error", "status": 502})}\n\n'
        except Exception as e:
            logger.error(f"Ollama stream error: {e}")
            yield f'event: error\ndata: {json.dumps({"error": str(e), "status": 502})}\n\n'
        return

    # ── Anthropic streaming ──
    if provider == "anthropic":
        _anth_input_tokens = 0
        _anth_output_tokens = 0
        # Track tool_use blocks: {index: {id, name, arguments_json}}
        _anth_tool_blocks: Dict[int, Dict] = {}
        _anth_block_idx = -1
        _anth_block_type = ""
        try:
            client = _get_http_client()
            async with client.stream('POST', target_url, json=payload, headers=h, timeout=stream_timeout) as r:
                _clear_host_dead(target_url)
                if r.status_code != 200:
                    raw = (await r.aread()).decode(errors="replace")
                    _log_stream_failure(f"status={r.status_code}", target_url, model, _stream_t0, raw)
                    friendly = _format_upstream_error(r.status_code, raw, target_url)
                    yield f'event: error\ndata: {json.dumps({"status": r.status_code, "text": friendly, "raw": raw[:500]})}\n\n'
                    return
                async for line in r.aiter_lines():
                    # SSE allows "data:value" with no space after the colon
                    # (the space is optional per the spec). Some gateways and
                    # local servers omit it; gating on "data: " dropped their
                    # entire stream.
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or not data.startswith("{"):
                        continue
                    try:
                        j = json.loads(data)
                        evt = j.get("type", "")
                        if evt == "content_block_start":
                            _anth_block_idx = j.get("index", _anth_block_idx + 1)
                            cb = j.get("content_block") or {}
                            _anth_block_type = cb.get("type", "text")
                            if _anth_block_type == "tool_use":
                                _anth_tool_blocks[_anth_block_idx] = {
                                    "id": cb.get("id") or f"call_{_anth_block_idx}",
                                    "name": cb.get("name") or "",
                                    "arguments": "",
                                }
                        elif evt == "content_block_delta":
                            delta = j.get("delta") or {}
                            delta_type = delta.get("type", "")
                            if delta_type == "text_delta":
                                text = delta.get("text") or ""
                                if text:
                                    yield f'data: {json.dumps({"delta": text})}\n\n'
                            elif delta_type == "input_json_delta":
                                # Accumulate tool arguments JSON
                                idx = j.get("index", _anth_block_idx)
                                if idx in _anth_tool_blocks:
                                    partial = delta.get("partial_json") or ""
                                    _anth_tool_blocks[idx]["arguments"] += partial
                                    # Stream tool arg deltas for doc tools
                                    if partial and _anth_tool_blocks[idx].get("name") in ("create_document", "update_document", "edit_document"):
                                        yield f'data: {json.dumps({"type": "tool_call_delta", "index": idx, "name": _anth_tool_blocks[idx]["name"], "arg_delta": partial})}\n\n'
                        elif evt == "message_start":
                            _u = j.get("message", {}).get("usage", {})
                            _anth_input_tokens = _u.get("input_tokens", 0)
                            # Surface prompt-cache effectiveness: cache_read > 0 means the
                            # stable system+tools prefix was served from cache this round.
                            _c_read = _u.get("cache_read_input_tokens", 0)
                            _c_write = _u.get("cache_creation_input_tokens", 0)
                            if _c_read or _c_write:
                                logger.info(
                                    "[anthropic-cache] read=%s write=%s fresh_input=%s",
                                    _c_read, _c_write, _anth_input_tokens,
                                )
                        elif evt == "message_delta":
                            _anth_output_tokens = j.get("usage", {}).get("output_tokens", 0)
                        elif evt == "message_stop":
                            # Emit accumulated tool calls in OpenAI-compatible format
                            if _anth_tool_blocks:
                                calls = []
                                for idx in sorted(_anth_tool_blocks):
                                    tb = _anth_tool_blocks[idx]
                                    calls.append({
                                        "id": tb["id"],
                                        "name": tb["name"],
                                        "arguments": tb["arguments"],
                                    })
                                yield f'data: {json.dumps({"type": "tool_calls", "calls": calls})}\n\n'
                            if _anth_input_tokens or _anth_output_tokens:
                                yield f'data: {json.dumps({"type": "usage", "data": {"input_tokens": _anth_input_tokens, "output_tokens": _anth_output_tokens}})}\n\n'
                            yield "data: [DONE]\n\n"
                            return
                        elif evt == "error":
                            err_msg = j.get("error", {}).get("message", "Unknown error")
                            yield f'event: error\ndata: {json.dumps({"error": err_msg, "status": 400})}\n\n'
                            return
                    except json.JSONDecodeError:
                        continue
                yield "data: [DONE]\n\n"
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            _cooled = _mark_host_dead(target_url)
            _tail = f" — host cooled for {DEAD_HOST_COOLDOWN:.0f}s" if _cooled else " — transient, will retry"
            logger.warning(f"Anthropic stream connect to {target_url} failed: {e}{_tail}")
            yield f'event: error\ndata: {json.dumps({"error": f"Cannot reach {_host_key(target_url)}", "status": 503, "error_type": "connect"})}\n\n'
        except httpx.ReadTimeout:
            _log_stream_failure("read-timeout", target_url, model, _stream_t0)
            yield f'event: error\ndata: {json.dumps({"error": "Read timeout", "status": 504})}\n\n'
        except httpx.NetworkError:
            _log_stream_failure("network-error", target_url, model, _stream_t0)
            yield f'event: error\ndata: {json.dumps({"error": "Network error", "status": 502})}\n\n'
        except Exception as e:
            logger.error(f"Anthropic stream error: {e}")
            yield f'event: error\ndata: {json.dumps({"error": str(e), "status": 502})}\n\n'
        return

    # ── OpenAI-compatible streaming ──
    # Accumulate native tool_calls across streaming chunks
    _tc_acc: Dict[int, Dict] = {}  # index -> {id, name, arguments}
    _tc_last_idx = [-1]  # most-recently-touched slot, for providers that omit `index`
    # For thinking models: prepend <think> to first content delta so frontend
    # can detect thinking-in-progress (some models output </think> but no <think>)
    _thinking_model = _supports_thinking(model)
    _first_content_sent = False
    _in_think_tag = False        # True while consuming <think>…</think> content
    _think_open_stripped = False  # opening <think> tag already removed
    _harmony_router = _HarmonyStreamRouter()
    _harmony_active = False       # sticky: gpt-oss harmony <|channel|> stream detected
    _actual_model = ""
    _actual_model_announced = False
    # F-S4-D: the terminal finish_reason of the stream. "length" ⇒ the model was CUT OFF by the output
    # token cap (a truncated reply), as opposed to "stop" (natural end) / "tool_calls" (stopped to act).
    # Captured across chunks (the final delta carries it) and emitted as a `finish` event at [DONE] so the
    # agent loop can surface a Continue affordance instead of the reply silently stopping mid-sentence.
    _finish_reason = None
    # Loud upstream-completion diagnostic counters (the missing counterpart to the non-stream
    # "succeeded" line). The current logs can't tell a 200-empty-at-the-edge from a real empty
    # completion — these make it conclusive. Vault-free: lengths/counts/finish_reason only.
    _diag = {
        "content_chars": 0,   # total content/reasoning chars streamed
        "reply_chars": 0,     # BUG 2: REPLY (visible content) chars only — disambiguates content_chars
        "reasoning_chars": 0, # BUG 2: REASONING (thinking) chars only (never in the player bubble)
        "tool_call_seen": False,
        "usage_seen": False,
        "output_tokens": None,
        "status": None,
    }

    def _log_stream_completion():
        """ONE always-fires line at stream end (the streaming counterpart to the non-stream
        'succeeded' log). Loud WARNINGs for the live symptoms: 200-but-empty, no usage chunk."""
        logger.info(
            f"LLM stream to {target_url} ended; model={model} status={_diag['status']} "
            f"content_chars={_diag['content_chars']} "
            f"reply_chars={_diag['reply_chars']} reasoning_chars={_diag['reasoning_chars']} "
            f"tool_call_seen={_diag['tool_call_seen']} "
            f"finish_reason={_finish_reason} usage_seen={_diag['usage_seen']} "
            f"output_tokens={_diag['output_tokens']}"
        )
        if _diag["status"] == 200 and _diag["content_chars"] == 0 and not _diag["tool_call_seen"]:
            logger.warning(
                f"upstream 200 but EMPTY completion (stream) target_url={target_url} model={model} "
                f"— no content and no tool/native call; likely a 200-empty-at-the-edge, not a real turn"
            )
        if not _diag["usage_seen"]:
            logger.warning(
                f"upstream stream produced NO usage chunk target_url={target_url} model={model} "
                f"— token accounting unavailable (the ledger will record in=0/out=0)"
            )

    def _emit_tool_calls():
        """Build the tool_calls event string if any were accumulated."""
        if not _tc_acc:
            return None
        calls = [_tc_acc[i] for i in sorted(_tc_acc)]
        return f'data: {json.dumps({"type": "tool_calls", "calls": calls})}\n\n'

    def _format_routed_content(parts: List[Tuple[str, bool]]) -> List[str]:
        nonlocal _first_content_sent
        events = []
        for part, is_thinking in parts:
            _diag["content_chars"] += len(part or "")
            if is_thinking:
                events.append(_stream_delta_event(part, thinking=True))
                continue
            # Some thinking backends start normal content with a stray closing
            # tag. Repair only that shape; do not wrap every first token for
            # model families like MiniMax, which often stream ordinary answers.
            if _thinking_model and not _first_content_sent and part.lstrip().lower().startswith("</think"):
                part = "<think>" + part
            _first_content_sent = True
            events.append(_stream_delta_event(part))
        return events

    try:
        client = _get_http_client()
        async with client.stream('POST', target_url, json=payload, headers=h, timeout=stream_timeout) as r:
            _clear_host_dead(target_url)
            _diag["status"] = r.status_code
            if r.status_code != 200:
                raw = (await r.aread()).decode(errors="replace")
                _log_stream_failure(f"status={r.status_code}", target_url, model, _stream_t0, raw)
                friendly = _format_upstream_error(r.status_code, raw, target_url)
                yield f'event: error\ndata: {json.dumps({"status": r.status_code, "text": friendly, "raw": raw[:500]})}\n\n'
                return

            async for line in r.aiter_lines():
                if not line:
                    continue

                # SSE allows "data:value" with no space after the colon; gating
                # on "data: " silently dropped content + usage from providers
                # that omit it.
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if data == "[DONE]":
                        for event in _format_routed_content(_harmony_router.flush()):
                            yield event
                        tc_event = _emit_tool_calls()
                        if tc_event:
                            yield tc_event
                        # F-S4-D: surface a terminal `length` finish (the reply was cut off by the token cap)
                        # so the agent loop can offer a Continue affordance. Only "length" matters to the UI;
                        # "stop"/"tool_calls" are normal ends. Emitted before [DONE] so it rides the same turn.
                        if _finish_reason:
                            yield f'data: {json.dumps({"type": "finish", "reason": _finish_reason})}\n\n'
                        _log_stream_completion()
                        yield "data: [DONE]\n\n"
                        return

                    try:
                        if data.strip():
                            if data.startswith("{"):
                                j = json.loads(data)
                                # F-S4-D: capture the terminal finish_reason wherever it appears (the final
                                # delta carries it, sometimes alongside the usage chunk). "length" = truncated.
                                _fr_choices = j.get("choices") or []
                                if _fr_choices and isinstance(_fr_choices[0], dict):
                                    _fr = _fr_choices[0].get("finish_reason")
                                    if _fr:
                                        _finish_reason = _fr
                                # Mid-stream provider error (OpenRouter/OpenAI-compat): once the first token
                                # is sent the HTTP status is already 200, so a later failure arrives IN-BAND
                                # — a top-level `error` object and/or a choice finishing with reason "error".
                                # The loop used to ignore it and close with a silent [DONE], so the partial
                                # reply ended with no signal and the FE later hid it (the "generates then
                                # disappears" bug). Surface it as an `event: error` carrying the typed
                                # `error_type`; flush buffered content first so nothing already produced is
                                # lost. After real output the fallback wrapper passes this through WITHOUT a
                                # retry (a mid-stream error can't fail over — headers are committed).
                                _mid_err = j.get("error") if isinstance(j.get("error"), dict) else None
                                if _mid_err or _finish_reason == "error":
                                    for _ev in _format_routed_content(_harmony_router.flush()):
                                        yield _ev
                                    _meta = (_mid_err or {}).get("metadata") or {}
                                    _err_payload = {
                                        "error": (_mid_err or {}).get("message") or "Provider error mid-stream",
                                        "status": (_mid_err or {}).get("code") or 502,
                                        "error_type": _meta.get("error_type") or "provider_unavailable",
                                        "mid_stream": True,
                                    }
                                    if _meta.get("provider_code"):
                                        _err_payload["provider_code"] = _meta.get("provider_code")
                                    yield f'event: error\ndata: {json.dumps(_err_payload)}\n\n'
                                    yield "data: [DONE]\n\n"
                                    return
                                chunk_model = j.get("model")
                                if isinstance(chunk_model, str) and chunk_model.strip():
                                    _actual_model = chunk_model.strip()
                                    if (
                                        not _actual_model_announced
                                        and not _same_model_identity(_actual_model, model)
                                    ):
                                        _actual_model_announced = True
                                        yield f'data: {json.dumps({"type": "model_actual", "requested_model": model, "model": _actual_model})}\n\n'
                                # Usage chunk (from stream_options)
                                _choices = j.get("choices") or []
                                _delta0 = _choices[0].get("delta") if (_choices and _choices[0] is not None) else None
                                # Capture usage whenever the chunk carries it and
                                # the delta has no actual output. Some gateways /
                                # local servers attach usage to the FINAL delta,
                                # which also carries role/finish_reason (so it is
                                # not exactly None/{}/{"content": None}); gating on
                                # those exact shapes discarded their token counts.
                                _delta_has_output = isinstance(_delta0, dict) and (
                                    _delta0.get("content")
                                    or _delta0.get("reasoning_content")
                                    or _delta0.get("reasoning")
                                    or _delta0.get("thinking")
                                    or _delta0.get("tool_calls")
                                )
                                # DeepSeek (and other gateways) put usage on the FINAL chunk, which ALSO carries the last
                                # delta text + finish_reason, and send `"usage": null` on every earlier chunk. The old
                                # gate (`"usage" in j and not _delta_has_output`) therefore emitted 0/0 for each early chunk
                                # and dropped the real counts — the token meter missed DeepSeek spend (A-3). Only a
                                # NON-EMPTY usage object counts, and it is captured even when the chunk carries output
                                # (the delta is then processed normally below).
                                _usage_obj = j.get("usage") if isinstance(j.get("usage"), dict) else None
                                _has_usage = bool(_usage_obj)
                                _usage_rides_output = _has_usage and bool(_delta_has_output)
                                if _has_usage:
                                    u = _usage_obj
                                    _usage_data = {"input_tokens": u.get("prompt_tokens", 0), "output_tokens": u.get("completion_tokens", 0)}
                                    _diag["usage_seen"] = True
                                    _diag["output_tokens"] = _usage_data["output_tokens"]
                                    # ADR 0010 (the token-economy meter): surface the rest of the
                                    # envelope OpenRouter/OpenAI already return — cached-prompt tokens,
                                    # reasoning tokens (the dominant cost on a thinking model), and the
                                    # authoritative per-request cost. Only attach when present so non-
                                    # reporting providers (and the byte-identical paths) are unchanged.
                                    _ptd = u.get("prompt_tokens_details") or {}
                                    _ctd = u.get("completion_tokens_details") or {}
                                    if _ptd.get("cached_tokens") is not None:
                                        _usage_data["cached_tokens"] = _ptd.get("cached_tokens")
                                    elif u.get("prompt_cache_hit_tokens") is not None:  # DeepSeek's own field
                                        _usage_data["cached_tokens"] = u.get("prompt_cache_hit_tokens")
                                    if _ctd.get("reasoning_tokens") is not None:
                                        _usage_data["reasoning_tokens"] = _ctd.get("reasoning_tokens")
                                    if u.get("cost") is not None:
                                        _usage_data["cost"] = u.get("cost")
                                    if u.get("cost_details") is not None:
                                        _usage_data["cost_details"] = u.get("cost_details")
                                    if u.get("cost") is None and _host_match(url, "deepseek.com"):
                                        _est = _deepseek_cost_estimate(
                                            _actual_model or model, u.get("prompt_tokens", 0),
                                            _usage_data.get("cached_tokens", 0), u.get("completion_tokens", 0))
                                        if _est is not None:
                                            _usage_data["cost"] = _est
                                            _usage_data["cost_estimated"] = True
                                    if provider:
                                        _usage_data["provider"] = provider
                                    # llama.cpp puts a `timings` block alongside `usage` with the
                                    # TRUE generation speed (predicted_per_second) — pure decode,
                                    # excluding prefill/network. Pass it through so the UI shows the
                                    # real gen t/s instead of recomputing tokens/wall-clock (which
                                    # includes prefill and reads ~20-40% low). Prefill speed too.
                                    _tm = j.get("timings")
                                    if isinstance(_tm, dict):
                                        if _tm.get("predicted_per_second"):
                                            _usage_data["gen_tps"] = round(_tm["predicted_per_second"], 2)
                                        if _tm.get("prompt_per_second"):
                                            _usage_data["prefill_tps"] = round(_tm["prompt_per_second"], 2)
                                    if _actual_model:
                                        _usage_data["model"] = _actual_model
                                        if not _same_model_identity(_actual_model, model):
                                            _usage_data["requested_model"] = model
                                    yield f'data: {json.dumps({"type": "usage", "data": _usage_data})}\n\n'
                                if (not _has_usage or _usage_rides_output) and "choices" in j:
                                    _c0 = (j["choices"] or [None])[0]
                                    if _c0 is None:
                                        continue
                                    delta = _c0.get("delta") or {}
                                    if isinstance(delta, dict):
                                        # Text content
                                        # Reasoning tokens (VLLM --reasoning-parser, e.g. Qwen3/DeepSeek-R1, Nemotron). vLLM 0.20.2 / NIM emit the field as `reasoning`; older builds use `reasoning_content`. Some OpenAI-compatible Ollama builds use `thinking`.
                                        reasoning = delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking") or ""
                                        if reasoning:
                                            _diag["content_chars"] += len(reasoning)
                                            _diag["reasoning_chars"] += len(reasoning)
                                            yield _stream_delta_event(reasoning, thinking=True)
                                        content = delta.get("content") or ""
                                        if content:
                                            _diag["content_chars"] += len(content)
                                            _diag["reply_chars"] += len(content)
                                            stripped = content.lstrip()
                                            # gpt-oss harmony format (<|channel|>analysis/final): route via the harmony
                                            # stream router. Sticky once the first marker appears — distinct from the
                                            # <think> path below (handled in the else, preserving #2588 behaviour).
                                            if _harmony_active or "<|" in content:
                                                _harmony_active = True
                                                for event in _format_routed_content(_harmony_router.feed(content)):
                                                    yield event
                                            else:
                                                # Auto-detect <think>…</think> in content stream.
                                                # Covers Qwen3-derived models (Qwopus, QwQ forks) whose
                                                # names don't match _THINKING_MODEL_PATTERNS but still
                                                # emit literal <think> markup via llama.cpp --jinja.
                                                if not _first_content_sent and not _thinking_model and not _in_think_tag and stripped.lower().startswith("<think"):
                                                    _thinking_model = True
                                                    _in_think_tag = True
                                                if _in_think_tag:
                                                    close_idx = content.lower().find("</think>")
                                                    if close_idx != -1:
                                                        # Split: up-to-</think> → thinking, remainder → content
                                                        think_part = content[:close_idx]
                                                        if not _think_open_stripped:
                                                            # Strip the opening <think[...] > from the first chunk.
                                                            # Use a dedicated flag — _first_content_sent stays False
                                                            # throughout the think block, so it must not be reused.
                                                            tag_end = think_part.lower().find(">")
                                                            if tag_end != -1:
                                                                think_part = think_part[tag_end + 1:]
                                                            _think_open_stripped = True
                                                        regular_part = content[close_idx + len("</think>"):]
                                                        _in_think_tag = False
                                                        if think_part:
                                                            yield f'data: {json.dumps({"delta": think_part, "thinking": True})}\n\n'
                                                        if regular_part:
                                                            _first_content_sent = True
                                                            yield f'data: {json.dumps({"delta": regular_part})}\n\n'
                                                    else:
                                                        # Still inside <think>: route to thinking channel
                                                        if not _think_open_stripped:
                                                            # Strip the opening <think[...] > tag (first chunk only)
                                                            tag_end = stripped.lower().find(">")
                                                            if tag_end != -1:
                                                                content = stripped[tag_end + 1:]
                                                            _think_open_stripped = True
                                                        if content:
                                                            yield f'data: {json.dumps({"delta": content, "thinking": True})}\n\n'
                                                else:
                                                    # Some thinking backends start normal content with a
                                                    # stray closing tag. Repair only that shape; do not
                                                    # wrap every first token for model families like
                                                    # MiniMax, which often stream ordinary answers.
                                                    if _thinking_model and not _first_content_sent and stripped.lower().startswith("</think"):
                                                        content = "<think>" + content
                                                    _first_content_sent = True
                                                    yield f'data: {json.dumps({"delta": content})}\n\n'
                                        # Native tool calls — accumulate across chunks
                                        for tc in delta.get("tool_calls") or []:
                                            if tc is None:
                                                continue
                                            func = tc.get("function") or {}
                                            raw_idx = tc.get("index")
                                            if raw_idx is None:
                                                # Gemini's OpenAI-compat layer omits `index` on
                                                # parallel tool calls (every delta arrives as
                                                # index=None) and sends each call complete in one
                                                # delta. Without this, all parallel calls collide
                                                # into slot 0 — later calls overwrite the first's
                                                # name and CORRUPT its arguments by concatenation,
                                                # so only one malformed call survives and the
                                                # follow-up round 400s. A function name marks the
                                                # start of a new call → allocate a fresh slot;
                                                # an arg-only continuation attaches to the last.
                                                if func.get("name") or _tc_last_idx[0] < 0:
                                                    # Next free slot ABOVE any existing key (not
                                                    # len()), so a provider mixing integer indices
                                                    # with index=None can never collide.
                                                    idx = max(_tc_acc, default=-1) + 1
                                                else:
                                                    idx = _tc_last_idx[0]
                                            else:
                                                idx = raw_idx
                                            _tc_last_idx[0] = idx
                                            if idx not in _tc_acc:
                                                _tc_acc[idx] = {"id": "", "name": "", "arguments": ""}
                                            if tc.get("id"):
                                                _tc_acc[idx]["id"] = tc["id"]
                                            # Gemini 3 returns an opaque thought_signature in
                                            # extra_content on the function-call delta. It MUST be
                                            # echoed back on the assistant tool_call next round or the
                                            # follow-up request 400s ("Function call is missing a
                                            # thought_signature"). Preserve it verbatim; other
                                            # providers never send it, so this is a no-op for them.
                                            if tc.get("extra_content"):
                                                _tc_acc[idx]["extra_content"] = tc["extra_content"]
                                            if func.get("name"):
                                                _tc_acc[idx]["name"] = func["name"]
                                                _diag["tool_call_seen"] = True
                                            if "arguments" in func:
                                                # Guard against a null arguments delta: `func` can be
                                                # {"arguments": None} (JSON null), and a raw `+= None`
                                                # raises TypeError that the broad except swallows,
                                                # silently dropping the rest of the chunk. Matches the
                                                # Anthropic accumulator (`partial = ... or ""`) above.
                                                _tc_acc[idx]["arguments"] += func["arguments"] or ""
                                                # Stream tool arg deltas for doc tools
                                                if func["arguments"] and _tc_acc[idx].get("name") in ("create_document", "update_document", "edit_document"):
                                                    yield f'data: {json.dumps({"type": "tool_call_delta", "index": idx, "name": _tc_acc[idx]["name"], "arg_delta": func["arguments"]})}\n\n'
                                elif "text" in j:
                                    if j["text"]:
                                        for event in _format_routed_content(_harmony_router.feed(j["text"])):
                                            yield event
                            else:
                                if data.strip():
                                    for event in _format_routed_content(_harmony_router.feed(data)):
                                        yield event
                    except Exception as e:
                        logger.error(f"Error parsing stream data: {e}")
                        continue

            # End of stream (no explicit [DONE] received)
            for event in _format_routed_content(_harmony_router.flush()):
                yield event
            tc_event = _emit_tool_calls()
            if tc_event:
                yield tc_event
            _log_stream_completion()
            # A57c: the connection closed with NO [DONE] and NO finish_reason, after real output and with no tool call in flight: the upstream DROPPED mid-sentence. Reporting that as a complete turn
            # persisted the half sentence as the narrator's whole message and hid the failure from the player. Surface it exactly like an in-band provider error (typed, mid-stream) so the turn is an
            # honest interruption (the client's error notice + retry), never a saved "complete" reply. A stream that ends with a finish_reason, or after a tool call, is unchanged.
            if _finish_reason is None and not tc_event and (_diag["content_chars"] > 0 or _diag["reasoning_chars"] > 0):
                logger.warning(
                    f"LLM stream to {target_url} ended with NO [DONE] and NO finish_reason after {_diag['content_chars']} content chars — upstream dropped mid-stream; surfacing as an interruption")
                yield f'event: error\ndata: {json.dumps({"error": "The connection to the narrator dropped mid-reply", "status": 502, "error_type": "stream_dropped", "mid_stream": True})}\n\n'
            yield "data: [DONE]\n\n"

    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        _cooled = _mark_host_dead(target_url)
        _tail = f" — host cooled for {DEAD_HOST_COOLDOWN:.0f}s" if _cooled else " — transient, will retry"
        logger.warning(f"Stream connect to {target_url} failed: {e}{_tail}")
        yield f'event: error\ndata: {json.dumps({"error": f"Cannot reach {_host_key(target_url)}", "status": 503, "error_type": "connect"})}\n\n'
    except httpx.ReadTimeout:
        _log_stream_failure("read-timeout", target_url, model, _stream_t0)
        yield f'event: error\ndata: {json.dumps({"error": "Read timeout", "status": 504})}\n\n'
    except httpx.NetworkError:
        _log_stream_failure("network-error", target_url, model, _stream_t0)
        yield f'event: error\ndata: {json.dumps({"error": "Network error", "status": 502})}\n\n'
    except Exception as e:
        logger.error(f"Stream error: {e}")
        yield f'event: error\ndata: {json.dumps({"error": str(e), "status": 502})}\n\n'


def _summarize_stream_error(err_chunk: Optional[str]) -> str:
    """Pull a short human reason out of an `event: error` SSE chunk for the
    fallback notice. Returns a generic message if it can't be parsed."""
    if not err_chunk:
        return "primary model failed"
    try:
        for line in err_chunk.split("\n"):
            if line.startswith("data: "):
                j = json.loads(line[6:])
                txt = j.get("text") or j.get("error") or ""
                status = j.get("status")
                msg = (f"HTTP {status}: " if status else "") + str(txt)
                return msg[:200].strip() or "primary model failed"
    except Exception:
        pass
    return "primary model failed"


async def stream_llm_with_fallback(candidates, messages, **kwargs):
    """The public streaming chokepoint over the traced fallback chain."""
    async for chunk in _stream_llm_with_fallback_traced(candidates, messages, **kwargs):
        yield chunk


async def _stream_llm_with_fallback_traced(candidates, messages, **kwargs):
    """Tracing wrapper over the fallback chain (src/llm_trace.py).

    Captures the full request (system prompt + messages + tool schemas + sampling
    params) and the reconstructed response (text + reasoning + tool calls + usage,
    or the error) for the /admin/status LLM I/O trace, then forwards the streamed
    bytes UNCHANGED. The trace is best-effort and never alters the stream; when the
    trace is disabled this is a near-zero passthrough."""
    from src import llm_trace
    _obs_session = kwargs.get("session_id")
    # 0112: attach the Vault-free correlation metadata to the OpenRouter request (only when
    # observability is enabled; None ⇒ the key is never threaded ⇒ byte-identical). Independent of
    # the I/O-trace gate below, so tagging works even with the I/O trace off.
    _obs_md = llm_trace.maybe_request_metadata(session=_obs_session)
    if _obs_md is not None and "metadata" not in kwargs:
        kwargs = dict(kwargs)
        kwargs["metadata"] = _obs_md
    cands = _dedupe_candidates(candidates)
    requested = cands[0][1] if cands else "(none)"

    async def _emit_obs_stream(resp: dict, latency_ms: int) -> None:
        # 0112: the single emit point for the streaming (narration/agent) path. Fail-soft inside.
        try:
            await llm_trace.emit_trace(
                session=_obs_session, model=resp.get("answeredBy") or requested,
                usage=resp.get("usage"), applied_max_tokens=kwargs.get("max_tokens"),
                finish_reason=resp.get("finishReason"),
                tool_call_seen=bool(resp.get("toolCalls")),
                latency_ms=latency_ms,
                status="error" if resp.get("error") is not None else "ok",
                completion=resp.get("text") or "")
        except Exception:
            pass

    if not llm_trace.enabled():
        acc0 = llm_trace.StreamAccumulator()
        started0 = time.time()
        try:
            async for chunk in _stream_llm_with_fallback_impl(candidates, messages, **kwargs):
                acc0.observe(chunk)
                yield chunk
        finally:
            await _emit_obs_stream(acc0.response(), int((time.time() - started0) * 1000))
        return
    acc = llm_trace.StreamAccumulator()
    started = time.time()
    try:
        async for chunk in _stream_llm_with_fallback_impl(candidates, messages, **kwargs):
            acc.observe(chunk)
            yield chunk
    finally:
        resp = acc.response()
        llm_trace.record_llm_call(
            kind="stream", model=resp.get("answeredBy") or requested, requested_model=requested,
            messages=messages, tools=kwargs.get("tools"),
            temperature=kwargs.get("temperature"), max_tokens=kwargs.get("max_tokens"),
            response=resp, ok=resp.get("error") is None,
            duration_ms=int((time.time() - started) * 1000),
        )
        await _emit_obs_stream(resp, int((time.time() - started) * 1000))


def _connect_backoff(attempt: int) -> float:
    """Short jittered backoff for connect-class retries (attempt is 1-based)."""
    import random
    return STREAM_CONNECT_BACKOFF * attempt * (0.5 + random.random())


def _is_connect_error_chunk(chunk: str) -> bool:
    if not chunk.startswith("event: error"):
        return False
    try:
        return json.loads(chunk.split("data: ", 1)[1]).get("error_type") == "connect"
    except Exception:
        return False


async def _stream_with_connect_retry(url, model, messages, headers, kwargs):
    """N-5: ``stream_llm`` plus a BOUNDED retry of a connect-class failure that happens BEFORE any byte
    is yielded (connect timeout / refused). Never retries once anything has streamed (would
    double-narrate); the fallback chain above still applies if every attempt fails."""
    started = time.monotonic()
    attempt = 0
    # A call made while the host was ALREADY cooled is the periodic probe: a SINGLE attempt, no retries (a probe to a
    # genuinely dead host must not stall ~10s). A request that trips the cooldown itself mid-way keeps its retries.
    max_retries = 0 if _is_host_cooled_now(url) else STREAM_CONNECT_RETRIES
    while True:
        attempt += 1
        yielded = False
        retry = False
        _kw = dict(kwargs)
        if attempt > 1:
            _kw["_retry_in_flight"] = True  # this request's own retry: the cooldown it tripped must not cut it short
        async for chunk in stream_llm(url, model, messages, headers=headers, **_kw):
            if (not yielded and _is_connect_error_chunk(chunk)
                    and attempt <= max_retries
                    and (time.monotonic() - started) + _connect_backoff(attempt) < STREAM_CONNECT_RETRY_BUDGET):
                retry = True
                break
            yielded = True
            yield chunk
        if not retry:
            return
        logger.warning(f"[stream] connect-class failure to {_host_key(url)}; retry {attempt}/{max_retries}")
        await asyncio.sleep(_connect_backoff(attempt))


async def _stream_llm_with_fallback_impl(candidates, messages, **kwargs):
    """Wrap stream_llm with an ordered fallback chain.

    `candidates` is a list of (url, model, headers). Each is tried in order,
    but only retried on a *pre-content* failure — i.e. an ``event: error``
    that arrives before any assistant text / tool-call data has been yielded.
    Once a candidate has emitted real output we never switch (that would
    duplicate streamed tokens); a later error from that candidate passes
    through unchanged. The dead-host cooldown in stream_llm makes repeat
    attempts at an offline primary effectively instant.

    Yields the same SSE chunk protocol as stream_llm.
    """
    cands = _dedupe_candidates(candidates)
    if not cands:
        yield f'event: error\ndata: {json.dumps({"error": "No model endpoint configured", "status": 503})}\n\n'
        return

    primary_model = cands[0][1]
    last_error = None
    for i, (url, model, headers) in enumerate(cands):
        is_last = (i == len(cands) - 1)
        emitted = False
        retried = False
        saw_error = False
        saw_done = False
        # The live symptom is a 200 that streams ONLY a usage chunk (output_tokens=0) + [DONE]:
        # zero content, zero tool calls. That metadata-only chunk must NOT count as "real output"
        # or the turn renders blank. Track real content/tool output separately and, if the usage
        # chunk arrives, whether it reported zero output tokens, so a 0-token completion fails over.
        saw_real_output = False
        saw_zero_token_usage = False
        async for chunk in _stream_with_connect_retry(url, model, messages, headers, kwargs):
            if chunk.startswith("event: error"):
                if not saw_real_output and not is_last:
                    # Pre-content failure with fallbacks left — swallow and
                    # move to the next candidate.
                    last_error = chunk
                    retried = True
                    if i == 0:
                        logger.warning(f"[fallback] primary {model} failed before output; trying fallback")
                    else:
                        logger.warning(f"[fallback] candidate {model} failed; trying next")
                    break
                saw_error = True
                yield chunk
                continue
            # HOLD the terminal until we know the candidate produced output (D): an empty-but-[DONE]
            # stream must be able to fail over (or surface a clean error) rather than terminate the wire
            # as a silent success — the blank-bubble bug, and a flaky primary that never tries the fallback.
            if chunk == "data: [DONE]\n\n":
                saw_done = True
                continue
            # Any data chunk other than the terminal [DONE] means real output.
            if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
                try:
                    event_data = json.loads(chunk[6:])
                except Exception:
                    event_data = {}
                _etype = event_data.get("type")
                if _etype == "model_actual":
                    yield chunk
                    continue
                # Metadata-only chunk types carry NO assistant output — they must not mark the
                # turn as "real output" (a usage chunk with out=0 is exactly the live blank-turn
                # bug). Note a zero-output-token usage chunk so it can drive the fail-over below.
                _is_metadata = _etype in ("usage", "finish", "fallback", "tool_call_delta", "model_actual")
                if _etype == "usage":
                    _ot = (event_data.get("data") or {}).get("output_tokens")
                    if _ot == 0:
                        saw_zero_token_usage = True
                # Real assistant output: a content/reasoning delta or accumulated tool calls.
                _is_real = (not _is_metadata) and (
                    bool(event_data.get("delta")) or _etype == "tool_calls"
                )
                # First real output from a NON-primary candidate: tell the client
                # the selected model failed and another answered. Without this the
                # fallback is invisible — a misconfigured provider looks like it
                # works because the reply is shown under the originally selected
                # model's name (e.g. a Bedrock/Claude endpoint that 400s every
                # request but appears fine because another model silently answered).
                if _is_real and not emitted and i > 0:
                    yield ('data: ' + json.dumps({
                        "type": "fallback",
                        "selected_model": primary_model,
                        "answered_by": model,
                        "reason": _summarize_stream_error(last_error),
                    }) + '\n\n')
                if _is_real:
                    emitted = True
                    saw_real_output = True
            yield chunk
        if retried:
            continue  # a real pre-content error with fallbacks left — try the next candidate
        # EMPTY/ZERO-TOKEN COMPLETION (live symptom): zero real output but the stream emitted a
        # usage chunk reporting output_tokens==0. That is NOT a real reply — treat it as empty so
        # it fails over / surfaces, never a blank turn (the metadata-only chunk used to look "real").
        if not saw_real_output and saw_zero_token_usage and not saw_error:
            if not is_last:
                last_error = ('event: error\ndata: '
                              + json.dumps({"error": f"{model} returned an empty completion (0 output tokens)",
                                            "status": 502, "error_type": "empty_completion"}) + '\n\n')
                logger.warning(f"[fallback] candidate {model} returned 0 output tokens; trying next")
                continue
            yield ('event: error\ndata: '
                   + json.dumps({"error": "The model returned an empty completion.", "status": 502,
                                 "error_type": "empty_completion"}) + '\n\n')
            yield "data: [DONE]\n\n"
            return
        if saw_real_output or saw_error:
            yield "data: [DONE]\n\n"  # a real reply OR a surfaced error — pass/ensure the held terminal
            return
        # EMPTY COMPLETION (D): the stream ended cleanly with zero content and no error. Fail over if any
        # candidate is left; else surface a typed empty-completion error so the client never renders a
        # blank assistant turn.
        if not is_last:
            last_error = ('event: error\ndata: '
                          + json.dumps({"error": f"{model} returned an empty completion", "status": 502,
                                        "error_type": "empty_completion"}) + '\n\n')
            logger.warning(f"[fallback] candidate {model} returned an empty completion; trying next")
            continue
        yield ('event: error\ndata: '
               + json.dumps({"error": "The model returned an empty completion.", "status": 502,
                             "error_type": "empty_completion"}) + '\n\n')
        yield "data: [DONE]\n\n"
        return
    # Every candidate failed pre-content — surface the last error and terminate.
    if last_error:
        yield last_error
        yield "data: [DONE]\n\n"
