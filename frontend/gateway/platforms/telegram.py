"""Telegram platform adapter for the multi-platform gateway (feature 0072).

Telegram is the first-wave platform adapter.  Uses httpx (already a dep) to
call the Telegram Bot API directly — no python-telegram-bot SDK required
(SDKs are optional extras so the core FE install is unchanged per spec).

The bot token comes from the ``TELEGRAM_BOT_TOKEN`` environment variable.
When the token is absent the adapter still registers but ``send()`` is a no-op
(logs a warning) so the webhook route works without crashing at import time.

Identity format: ``"telegram:<chat_id>"``  (chat_id is the Telegram numeric ID
for the conversation — private chats, groups, and channels all have a chat_id).
"""

from __future__ import annotations

import hmac
import logging
import os
from typing import Optional

import httpx

from .base import PlatformAdapter
from ..platform_registry import platform_registry

logger = logging.getLogger(__name__)

_TELEGRAM_API_BASE = "https://api.telegram.org/bot{token}/sendMessage"

_BOT_TOKEN: Optional[str] = os.environ.get("TELEGRAM_BOT_TOKEN") or None
# SEC-2 (opt-in): the secret you set at setWebhook time. Telegram echoes it back in the
# X-Telegram-Bot-Api-Secret-Token header on every update. When set, we require it to match.
_WEBHOOK_SECRET: Optional[str] = os.environ.get("TELEGRAM_WEBHOOK_SECRET") or None


class TelegramAdapter(PlatformAdapter):
    """Thin adapter for the Telegram Bot API."""

    platform_id = "telegram"

    def verify_webhook(self, headers) -> bool:
        """Opt-in webhook auth (SEC-2): when ``TELEGRAM_WEBHOOK_SECRET`` is set, require
        Telegram's ``X-Telegram-Bot-Api-Secret-Token`` header to match it (constant-time).
        Unset ⇒ ``True`` (behavior unchanged for an unconfigured/local deployment)."""
        secret = _WEBHOOK_SECRET or os.environ.get("TELEGRAM_WEBHOOK_SECRET") or None
        if not secret:
            return True
        sent = ""
        try:
            sent = headers.get("X-Telegram-Bot-Api-Secret-Token") or ""
        except Exception:
            sent = ""
        return hmac.compare_digest(sent, secret)

    async def send(self, identity: str, text: str) -> None:
        """Deliver *text* to the Telegram chat identified by *identity*.

        *identity* must be ``"telegram:<chat_id>"``.  If ``TELEGRAM_BOT_TOKEN``
        is not configured the delivery is skipped with a warning (fail-soft).
        """
        token = _BOT_TOKEN or os.environ.get("TELEGRAM_BOT_TOKEN")
        if not token:
            logger.warning(
                "TELEGRAM_BOT_TOKEN is not set — skipping delivery to %s", identity
            )
            return

        try:
            chat_id = identity.split(":", 1)[1]
        except IndexError:
            logger.warning("TelegramAdapter.send: malformed identity %r", identity)
            return

        url = _TELEGRAM_API_BASE.format(token=token)
        # Telegram's sendMessage API: https://core.telegram.org/bots/api#sendmessage
        # parse_mode=HTML lets us send minimal inline markup without markdown escaping.
        # text is pre-scrubbed so no markdown is expected; plain text is safe either way.
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    url,
                    json={
                        "chat_id": chat_id,
                        "text": text,
                        "parse_mode": "HTML",
                    },
                )
                if resp.status_code != 200:
                    logger.warning(
                        "Telegram sendMessage failed for %s: HTTP %d — %s",
                        identity,
                        resp.status_code,
                        resp.text[:200],
                    )
        except Exception as exc:
            logger.warning("Telegram send error for %s: %s", identity, exc)

    def inbound_dedupe_key(self, raw: dict):
        uid = raw.get("update_id") if isinstance(raw, dict) else None
        return f"telegram:update:{uid}" if isinstance(uid, int) and not isinstance(uid, bool) else None

    def parse_inbound(self, raw: dict) -> tuple[str, str]:
        """Parse a Telegram Update JSON object into ``(identity, text)``.

        Supports ``message`` and ``callback_query`` updates.  The latter lets
        a player reply to inline keyboard prompts (decision cards degraded to
        inline buttons) — the data field carries the player's choice text.
        """
        # Inline keyboard callback (decision-card text degradation)
        if "callback_query" in raw:
            cq = raw["callback_query"]
            chat_id = str(cq["message"]["chat"]["id"])
            text = cq.get("data") or cq.get("message", {}).get("text", "")
            return f"telegram:{chat_id}", text

        # Ordinary text message
        msg = raw.get("message")
        if msg is None:
            raise ValueError("Unsupported Telegram Update type — no 'message' key")
        chat_id = str(msg["chat"]["id"])
        text = msg.get("text", "")
        return f"telegram:{chat_id}", text


# Self-register so importing this module is sufficient to activate the adapter.
platform_registry.register(TelegramAdapter())
