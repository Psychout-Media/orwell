# src/endpoint_resolver.py
"""Unified endpoint resolution for all backend services.

Consolidates the 4+ copies of normalize_base / resolve_endpoint logic into one place.
"""

import json
import logging
import socket
import subprocess
from typing import Optional, Tuple, Dict
from urllib.parse import urlparse, urlunparse

from core.database import SessionLocal, ModelEndpoint
from src.llm_core import _detect_provider, _host_match, _ollama_api_root

logger = logging.getLogger(__name__)

# Model-name substrings that are NOT chat/generation models. When an endpoint
# has no explicit model configured we pick the first CHAT model from its list —
# never an embedding/tts/etc. (an OpenAI-style endpoint often lists
# `text-embedding-ada-002` first, which silently broke email-summarize and
# other resolve_endpoint callers with "Cannot reach model").
_NON_CHAT_MODEL = (
    "text-embedding", "embedding", "tts-", "whisper", "dall-e",
    "moderation", "rerank", "reranker", "clip", "stable-diffusion",
)


def _first_chat_model(models) -> Optional[str]:
    """First chat-capable model — never an embedding/tts/etc. AND never a text→image
    model (a chat default of e.g. "google/gemini-3.1-flash-image" can't complete chat,
    it returns an empty/garbage reply). Prefers a clean chat model; if every entry is
    excluded, returns the first non-image one over an image one; only an all-image list
    falls through to models[0]."""
    from src.llm_core import is_image_model
    models = list(models or [])
    for m in models:
        if any(p in str(m).lower() for p in _NON_CHAT_MODEL):
            continue
        if is_image_model(m):
            continue
        return m
    for m in models:
        if not is_image_model(m):
            return m
    return (models[0] if models else None)


def _endpoint_cached_models(ep) -> list:
    """Return cached model ids from the current or legacy endpoint field."""
    raw = getattr(ep, "cached_models", None) or getattr(ep, "models", None)
    if not raw:
        return []
    try:
        models = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return []
    return models if isinstance(models, list) else []


def _endpoint_hidden_models(ep) -> set:
    """Model ids the admin disabled on this endpoint (the UI's hidden list)."""
    raw = getattr(ep, "hidden_models", None)
    if not raw:
        return set()
    try:
        hidden = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return set()
    return set(hidden) if isinstance(hidden, list) else set()


def _endpoint_enabled_models(ep) -> list:
    """Cached models minus the ones disabled on the endpoint, order preserved.

    The auto-pick fallback must never select a model the user disabled — a
    Groq endpoint can list 16 models with only 1 enabled, and picking the
    raw first one resolves to a model that 400s ("requires terms acceptance").
    """
    hidden = _endpoint_hidden_models(ep)
    return [m for m in _endpoint_cached_models(ep) if m not in hidden]


def _model_available(ep, m) -> bool:
    """Is model ``m`` actually SERVED on endpoint ``ep``? A model is unavailable when it is
    explicitly hidden/disabled, OR when the endpoint's CACHED served list is known (non-empty)
    and ``m`` is absent from it (a configured model the provider does not serve → 400s).

    Membership is tested against the full CACHED set (what the provider actually serves), NOT the
    enabled SUBSET: if every cached model is hidden, ``_endpoint_enabled_models`` is empty — which
    must NOT read as "nothing is cached, so everything is available" (that would let a sibling absent
    from a known cache be selected and sent to the provider, re-triggering the exact unsupported-model
    error this fallback exists to avoid). Hidden/disabled is a SEPARATE gate above.

    Conservative on missing data: an endpoint whose models were never cached (empty cache) can't be
    verified, so a configured model is assumed available — never substituted on a hunch. This is the
    predicate the narrator↔utility mutual fallback tests each candidate with.
    """
    if not m:
        return False
    if m in _endpoint_hidden_models(ep):
        return False
    cached = _endpoint_cached_models(ep)
    if cached and m not in cached:
        return False
    return True


# Cache for Tailscale hostname → IP resolution
_tailscale_cache: Dict[str, Optional[str]] = {}


def _resolve_tailscale_host(hostname: str) -> Optional[str]:
    """Try to resolve a hostname via 'tailscale status' if DNS fails."""
    if hostname in _tailscale_cache:
        return _tailscale_cache[hostname]

    # First check if normal DNS works
    try:
        socket.getaddrinfo(hostname, None, socket.AF_INET)
        _tailscale_cache[hostname] = None  # DNS works, no override needed
        return None
    except socket.gaierror:
        pass

    # DNS failed — try tailscale
    try:
        result = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            import json as _json
            data = _json.loads(result.stdout)
            peers = data.get("Peer", {})
            for _id, peer in peers.items():
                peer_name = (peer.get("HostName") or "").lower()
                dns_name = (peer.get("DNSName") or "").split(".")[0].lower()
                if peer_name == hostname.lower() or dns_name == hostname.lower():
                    addrs = peer.get("TailscaleIPs", [])
                    if addrs:
                        ip = addrs[0]
                        logger.info(f"Resolved '{hostname}' via Tailscale → {ip}")
                        _tailscale_cache[hostname] = ip
                        return ip
    except Exception as e:
        logger.debug(f"Tailscale resolution failed for '{hostname}': {e}")

    _tailscale_cache[hostname] = None
    return None


def resolve_url(url: str) -> str:
    """If a URL's hostname can't be resolved via DNS, try Tailscale."""
    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        return url
    ip = _resolve_tailscale_host(hostname)
    if ip:
        # Replace hostname with IP in the URL
        netloc = ip
        if parsed.port:
            netloc = f"{ip}:{parsed.port}"
        return urlunparse(parsed._replace(netloc=netloc))
    return url


def normalize_base(url: str) -> str:
    """Strip known API path suffixes from a base URL."""
    url = (url or "").strip().rstrip("/")
    for suffix in ["/models", "/chat/completions", "/completions", "/v1/messages"]:
        if url.endswith(suffix):
            url = url[: -len(suffix)].rstrip("/")
    for suffix in ["/chat", "/tags", "/generate"]:
        if url.endswith("/api" + suffix):
            url = url[: -len(suffix)].rstrip("/")
    return url


def _anthropic_api_root(base: str) -> str:
    """Return Anthropic's API root, preserving /v1 for OpenAI-compatible APIs elsewhere."""
    base = (base or "").strip().rstrip("/")
    if _host_match(base, "anthropic.com") and base.endswith("/v1"):
        return base[:-3].rstrip("/")
    return base


def is_fal_url(url: str) -> bool:
    """True for a fal.ai endpoint base (the Seedream image provider — issue #1153 / ADR 0016 §C).

    fal is NOT an OpenAI-compatible chat provider: it has no `/chat/completions` and uses a
    ``Authorization: Key <FAL_KEY>`` header (not ``Bearer``). Detection is hostname-based (so a path
    or query that merely contains "fal.run" can't misclassify) and covers the run host + the queue
    host fal also serves from."""
    return _host_match(url, "fal.run", "fal.ai", "queue.fal.run")


def build_chat_url(base: str) -> str:
    """Return the correct chat endpoint URL for a given base."""
    base = resolve_url(base)
    # fal.ai is an IMAGE-only provider with no chat path — return the base unchanged so the
    # portrait pipeline (which detects fal by the URL) appends the model slug itself. Appending
    # `/chat/completions` here would build a non-existent fal URL.
    if is_fal_url(base):
        return base.rstrip("/")
    provider = _detect_provider(base)
    if provider == "anthropic":
        return _anthropic_api_root(base) + "/v1/messages"
    if provider == "ollama":
        return _ollama_api_root(base) + "/chat"
    return base + "/chat/completions"


def build_models_url(base: str) -> str:
    """Return the provider-specific model-list endpoint URL for a base."""
    base = resolve_url(base)
    provider = _detect_provider(base)
    if provider == "anthropic":
        return _anthropic_api_root(base) + "/v1/models"
    if provider == "ollama":
        return _ollama_api_root(base) + "/tags"
    return base + "/models"


def build_headers(api_key: Optional[str], base: str) -> Dict[str, str]:
    """Build auth headers for an endpoint."""
    # fal.ai authenticates with ``Authorization: Key <FAL_KEY>`` (NOT ``Bearer``) — issue #1153.
    # Detected before the OpenAI-compatible default so a fal base never gets a Bearer header.
    if is_fal_url(base):
        return {"Authorization": f"Key {api_key}"} if api_key else {}
    provider = _detect_provider(base)
    headers: Dict[str, str] = {}
    if provider == "anthropic":
        if api_key:
            headers["x-api-key"] = api_key
        headers["anthropic-version"] = "2023-06-01"
        return headers
    if provider == "copilot":
        from src.copilot import copilot_headers
        return copilot_headers(api_key)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if provider == "openrouter":
        headers.setdefault("HTTP-Referer", "https://github.com/Psychout-Media/orwell")
        headers.setdefault("X-OpenRouter-Title", "Orwell")
    return headers


def _owner_scoped(query, owner: Optional[str]):
    """Owner-scope a ModelEndpoint query the way the READ paths do (and the way
    ``ai_interaction._resolve_model`` was already fixed): admins manage the global pool and are
    NOT scoped; everyone else sees their own endpoints PLUS shared/null-owner rows
    (``include_shared=True``). Without the shared/admin allowance, a configured endpoint whose
    owner stamp doesn't match the caller — e.g. an admin-/null-owned provider, or one whose
    owner went STALE when an OOBE reset rebuilt accounts but preserved the endpoint rows —
    resolves to "not found", which bricks every background/utility lane (cast authoring,
    genesis, zeitgeist …) and, under the strict 0116 enrichment policy, refuses game creation.
    NEVER matches another user's owned row (only own + NULL-owner)."""
    if not owner:
        return query
    try:
        from src.auth_helpers import owner_filter, is_admin_user
        if is_admin_user(owner):
            return query
        return owner_filter(query, ModelEndpoint, owner, include_shared=True)
    except Exception:
        return query


def _sole_keyed_chat_endpoint(db, owner: Optional[str]):
    """The single-endpoint auto-default (issue: post-OOBE-reset brick, 2026-07-12).

    When the default-endpoint DESIGNATION (`default_endpoint_id`) is null or dangling, but
    EXACTLY ONE enabled, API-keyed, non-image endpoint is visible to this owner, that endpoint
    is the only thing resolution could ever mean — return it. With zero or 2+ candidates this
    returns None (ambiguous — never guess between providers). Fail-soft: any error reads as
    None and the caller's normal fallback path stands."""
    try:
        q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)  # noqa: E712
        q = _owner_scoped(q, owner)
        candidates = [
            ep for ep in q.all()
            if (getattr(ep, "api_key", None) or "").strip()
            and (getattr(ep, "model_type", None) or "llm") != "image"
        ]
        if len(candidates) == 1:
            return candidates[0]
        return None
    except Exception as e:
        logger.debug(f"single-endpoint auto-default probe failed: {e}")
        return None


def resolve_endpoint(
    setting_prefix: str,
    fallback_url: Optional[str] = None,
    fallback_model: Optional[str] = None,
    fallback_headers: Optional[Dict] = None,
    owner: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str], Optional[Dict]]:
    """Resolve an endpoint/model from settings, with fallback.

    Args:
        setting_prefix: Settings key prefix, e.g. "research", "task", "utility", "default".
                       Reads ``{prefix}_endpoint_id`` and ``{prefix}_model`` from settings.
        fallback_url:    URL to use if settings are empty or endpoint missing.
        fallback_model:  Model to use if settings are empty.
        fallback_headers: Headers to use if using fallback.

    Returns:
        (endpoint_url, model, headers) — resolved or fallback values.

    Resilience (2026-07-12, the post-OOBE-reset brick): when the whole settings chain yields
    no endpoint id (or a dangling one) AND the caller supplied no usable fallback, the
    single-endpoint auto-default fires — if EXACTLY ONE enabled endpoint with an API key
    exists, resolution binds to it (with the stored ``default_model``), so a lost/never-written
    `default_endpoint_id` can never hard-brick game creation. With multiple candidate
    endpoints (or none keyed) nothing changes: the configured behavior is byte-identical.
    """
    try:
        from src.settings import get_user_setting, load_settings
        settings = load_settings()
    except Exception:
        return fallback_url, fallback_model, fallback_headers

    owner_str = owner or ""
    def _stg(key: str) -> str:
        return (get_user_setting(key, owner_str, settings.get(key, "")) or "").strip()

    ep_id = _stg(f"{setting_prefix}_endpoint_id")
    model = _stg(f"{setting_prefix}_model")

    # If the specific endpoint is not configured, but the caller provided a
    # valid fallback (e.g. the active session model), use that immediately.
    # This prevents background tasks from jumping to the global default_model
    # when the user is mid-conversation with a different model.
    if not ep_id and fallback_url and fallback_model:
        return fallback_url, fallback_model, fallback_headers

    # Unset Utility ENDPOINT means "ride the Default Chat endpoint" — but the configured
    # utility MODEL stays authoritative when set (2026-07-13, the arbitrary-default audit):
    # ADR 0016's two-tier pair ships `utility_model` (qwen/qwen3.6-27b) with
    # `utility_endpoint_id` deliberately "" so it binds to the same OpenRouter endpoint as
    # the narrator. The old line overwrote the MODEL with `default_model` too, so the
    # shipped utility tier silently never resolved out of the box (every utility lane ran
    # on the narrator model). Only an EMPTY utility_model now inherits the default model.
    if setting_prefix == "utility" and not ep_id:
        ep_id = _stg("default_endpoint_id")
        if not model:
            model = _stg("default_model")

    # Fall back through the Utility tier for a non-utility prefix (task/research/faithfulness/
    # auto-naming) whose own endpoint isn't configured. The configured UTILITY MODEL stays
    # authoritative (2026-07-13, the arbitrary-default audit — Greptile P1 repro): ADR 0016 ships
    # `utility_model=qwen/qwen3.6-27b` with `utility_endpoint_id` deliberately "" so the utility
    # tier RIDES the Default Chat ENDPOINT. The old inner line overwrote the MODEL with
    # `default_model` too whenever `utility_endpoint_id` was empty, so every utility-tier fallback
    # (extraction belts, faithfulness judge, task/research naming) silently ran the expensive
    # NARRATOR model instead of the cheap qwen tier. Now, when the utility endpoint is unset we
    # borrow the DEFAULT endpoint but KEEP the configured utility_model — only an EMPTY utility_model
    # inherits `default_model`. The `default` prefix keeps its OWN model (already set above): it must
    # never route through the utility model (that would resolve the narrator prefix to qwen).
    if not ep_id and setting_prefix != "utility":
        ep_id = _stg("utility_endpoint_id")
        if setting_prefix != "default":
            model = _stg("utility_model")
        if not ep_id:
            ep_id = _stg("default_endpoint_id")
            if not model:
                model = _stg("default_model")

    db = SessionLocal()
    try:
        ep = None
        auto_bound = False
        if ep_id:
            q = db.query(ModelEndpoint).filter(
                ModelEndpoint.id == ep_id,
                ModelEndpoint.is_enabled == True,
            )
            ep = _owner_scoped(q, owner).first()
        if ep is None and not (fallback_url and fallback_model):
            # The single-endpoint auto-default: the designation is null/dangling but exactly
            # one enabled+keyed endpoint exists — resolution can only mean that one. Logged
            # loudly so the fallback firing is always visible to the operator.
            sole = _sole_keyed_chat_endpoint(db, owner)
            if sole is not None:
                if not model:
                    model = _stg("default_model")
                if model:
                    # The RIGHT model, not A model (owner ruling 2026-07-12): the auto-default
                    # binds ONLY the configured default/chained model identity — it must never
                    # degrade to "first model in the provider list" (the arbitrary-narrator
                    # class). No configured model ⇒ stay unresolved, loudly.
                    ep = sole
                    auto_bound = True
                    logger.warning(
                        "[resolve_endpoint] '%s' endpoint designation is %s — single-endpoint "
                        "auto-default fired: bound to the only keyed enabled endpoint '%s' "
                        "(configured model %r)",
                        setting_prefix, "dangling" if ep_id else "unset",
                        getattr(sole, "name", None) or getattr(sole, "id", "?"), model,
                    )
                else:
                    logger.warning(
                        "[resolve_endpoint] '%s' endpoint designation is %s and no default_model "
                        "is configured — auto-default DECLINED (never binds an arbitrary "
                        "first-listed model); resolution stays unresolved",
                        setting_prefix, "dangling" if ep_id else "unset",
                    )
        if not ep:
            return fallback_url, fallback_model, fallback_headers

        base = normalize_base(ep.base_url)
        chat_url = build_chat_url(base)
        headers = build_headers(ep.api_key, base)

        # F9: remember the model the operator actually CONFIGURED for this prefix so any silent
        # substitution below (hidden-model clear → first-chat-model fallback) is surfaced, never a
        # silent swap. The reported symptom: `utility_model = qwen/qwen3.6-flash` configured, but
        # `thinkingmachines/inkling` served — because the configured model isn't enabled on the
        # OpenRouter endpoint, so the picker fell through to the endpoint's first chat model.
        _configured_model = model

        # Discard a configured model the user has since disabled on the endpoint (e.g. a stale
        # `default_model` left pointing at a now-hidden model, or the reported case: `utility_model =
        # qwen/qwen3.6-flash` configured but disabled on the OpenRouter endpoint). Instead of dropping
        # to an ARBITRARY "first enabled chat model" (thinkingmachines/inkling in the owner's log — a
        # model that could be slow/broken and hangs the casting-finalize burst), apply the
        # narrator↔utility MUTUAL FALLBACK: the two configured models are each other's fallback.
        #
        # Owner ruling 2026-07-21: a utility-class call whose model is unavailable falls back to the
        # configured NARRATOR/default model (known-served), and vice-versa; only when BOTH configured
        # models are unavailable do we reach the documented last resort (the endpoint's first enabled
        # chat model). Never substitute an arbitrary model while a working configured model exists.
        _default_model = _stg("default_model")
        _utility_model = _stg("utility_model")
        if model and not _model_available(ep, model):
            if auto_bound:
                # An auto-bound endpoint whose configured default is not served (hidden/disabled OR
                # absent from the endpoint's served list): staying unresolved (loud) beats silently
                # swapping in an arbitrary first-listed model.
                logger.warning(
                    "[resolve_endpoint] auto-default declined: the configured model %r is "
                    "not served on endpoint '%s'", model, getattr(ep, "name", None) or ep.id)
                return fallback_url, fallback_model, fallback_headers
            # Prefer the SIBLING configured model: if we were about to serve the utility model, fall
            # back to the narrator/default model first (and vice-versa). Dedup + skip the model we
            # already know is unavailable.
            if model == _utility_model:
                _chain = [_default_model, _utility_model]
            else:
                _chain = [_utility_model, _default_model]
            _chosen = ""
            for _cand in _chain:
                if _cand and _cand != model and _model_available(ep, _cand):
                    _chosen = _cand
                    break
            if _chosen:
                logger.warning(
                    "[resolve_endpoint] '%s' configured model %r is not served on endpoint '%s' — "
                    "falling back to the configured %s model %r (narrator↔utility mutual fallback), "
                    "NOT an arbitrary first-enabled model",
                    setting_prefix, model, getattr(ep, "name", None) or ep.id,
                    "narrator/default" if _chosen == _default_model else "utility", _chosen)
                model = _chosen
            else:
                logger.warning(
                    "[resolve_endpoint] '%s' configured model %r is not served on endpoint '%s' and "
                    "neither configured narrator nor utility model is available — substituting the "
                    "endpoint's first enabled chat model (documented last resort)",
                    setting_prefix, model, getattr(ep, "name", None) or ep.id)
                model = ""
        # If no (usable) model specified, pick the first enabled chat model.
        if not model:
            model = _first_chat_model(_endpoint_enabled_models(ep)) or ""
        if not model and not fallback_model:
            logger.warning('[resolve_endpoint] no usable model (all models hidden or list empty)')

        # F9: a SILENT SWAP is when a model was configured for this prefix but a DIFFERENT one is
        # served. Surface it LOUD (an ops-visible WARN on /admin/status logs) so "the configured
        # utility model is served, OR the substitution is visible" — never a silent swap. This is
        # additive telemetry only: it changes no resolution, so the served (url, model) is identical.
        served = model or fallback_model
        if _configured_model and served and served != _configured_model:
            logger.warning(
                "[resolve_endpoint] '%s' model substitution: configured %r is not being served — "
                "serving %r instead (the configured model is not enabled on endpoint '%s')",
                setting_prefix, _configured_model, served,
                getattr(ep, "name", None) or getattr(ep, "id", "?"))

        return chat_url, served, headers
    except Exception as e:
        logger.debug(f"Could not resolve {setting_prefix} endpoint: {e}")
        return fallback_url, fallback_model, fallback_headers
    finally:
        db.close()


def resolve_endpoint_by_id(
    ep_id: str, model: Optional[str] = None, owner: Optional[str] = None
) -> Optional[Tuple[str, str, Dict]]:
    """Resolve a specific endpoint id (+ optional model) to (chat_url, model, headers).

    Returns None if the endpoint doesn't exist or is disabled. Used to turn
    a configured fallback entry ({endpoint_id, model}) into a dispatch target.
    """
    if not ep_id:
        return None
    db = SessionLocal()
    try:
        q = db.query(ModelEndpoint).filter(
            ModelEndpoint.id == ep_id,
            ModelEndpoint.is_enabled == True,
        )
        # Admin-exempt + own-or-shared scoping (see _owner_scoped): a shared/null-owner or
        # stale-owner endpoint row must stay resolvable by its configured fallback entries.
        ep = _owner_scoped(q, owner).first()
        if not ep:
            return None
        base = normalize_base(ep.base_url)
        chat_url = build_chat_url(base)
        headers = build_headers(ep.api_key, base)
        m = (model or "").strip()
        # Drop a model the user disabled on the endpoint, then pick the first
        # enabled chat model rather than a hidden one.
        if m and m in _endpoint_hidden_models(ep):
            m = ""
        if not m:
            m = _first_chat_model(_endpoint_enabled_models(ep)) or ""
        if not m:
            return None
        return chat_url, m, headers
    except Exception as e:
        logger.debug(f"Could not resolve endpoint {ep_id}: {e}")
        return None
    finally:
        db.close()


def resolve_chat_fallback_candidates(owner: Optional[str] = None) -> list:
    """Build the configured default-chat fallback chain as a list of
    (chat_url, model, headers) tuples, skipping any that can't resolve.

    The primary model is NOT included — callers prepend their session's
    current (url, model, headers) so per-session model overrides are honored.
    """
    return _resolve_fallback_candidates("default_model_fallbacks", owner=owner)


def resolve_utility_fallback_candidates(owner: Optional[str] = None) -> list:
    """Configured fallback chain for the Utility model (`utility_model_fallbacks`)."""
    try:
        from src.settings import get_user_setting, load_settings
        settings = load_settings()
        utility_ep = (get_user_setting("utility_endpoint_id", owner or "", settings.get("utility_endpoint_id", "")) or "").strip()
        if not utility_ep:
            return _resolve_fallback_candidates("default_model_fallbacks", owner=owner)
    except Exception:
        pass
    return _resolve_fallback_candidates("utility_model_fallbacks", owner=owner)


def resolve_vision_fallback_candidates(owner: Optional[str] = None) -> list:
    """Configured fallback chain for the Vision model (`vision_model_fallbacks`)."""
    return _resolve_fallback_candidates("vision_model_fallbacks", owner=owner)


def _resolve_fallback_candidates(setting_key: str, owner: Optional[str] = None) -> list:
    out = []
    try:
        from src.settings import get_user_setting, load_settings
        settings = load_settings()
        chain = get_user_setting(setting_key, owner or "", settings.get(setting_key) or []) or []
    except Exception:
        return out
    for entry in chain:
        if not isinstance(entry, dict):
            continue
        resolved = resolve_endpoint_by_id(entry.get("endpoint_id", ""), entry.get("model", ""), owner=owner)
        if resolved:
            out.append(resolved)
    return out
