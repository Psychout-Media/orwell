"""Platform adapter base class for the multi-platform gateway (feature 0072).

Adapted from hermes-agent gateway/platforms/base.py
(MIT © 2025 Nous Research — see frontend/ACKNOWLEDGMENTS.md).

Each concrete adapter:
  1. Declares a unique ``platform_id`` (e.g. ``"telegram"``)
  2. Implements :meth:`send` to deliver a reply to a platform user
  3. Implements :meth:`parse_inbound` to normalise an inbound webhook payload
     into a ``(platform_identity, text)`` tuple

Adding a platform is a two-file change: a new adapter module + an import that
triggers self-registration.  Core routing never changes.
"""

from abc import ABC, abstractmethod


class PlatformAdapter(ABC):
    """Abstract base for a messaging-platform adapter."""

    #: A unique slug identifying the platform (e.g. ``"telegram"``).
    platform_id: str

    @abstractmethod
    async def send(self, identity: str, text: str) -> None:
        """Deliver *text* to the platform user identified by *identity*.

        *identity* is the fully-qualified platform identity string, e.g.
        ``"telegram:123456"``.  Implementations must be fail-soft: a delivery
        failure must log a warning but must NOT propagate as an exception that
        would break the gateway turn handler.
        """

    def verify_webhook(self, headers) -> bool:
        """Return False to reject an inbound webhook as unauthenticated (SEC-2).

        The webhook trusts the client-supplied platform identity as its credential, so
        without transport auth anyone who can reach the public URL can forge a turn for a
        paired user. This hook lets an adapter verify a platform signature/secret header.

        Default: ``True`` — **opt-in** verification, so an adapter (or deployment) with no
        secret configured behaves exactly as before. A concrete adapter that HAS a secret
        configured compares it (constant-time) against the platform's signature header and
        returns ``False`` on mismatch. *headers* is a case-insensitive mapping
        (e.g. Starlette ``request.headers``).
        """
        return True

    def inbound_dedupe_key(self, raw: dict):
        """Return a platform-unique id for this inbound update, or ``None`` (ORW-265).

        Platforms redeliver an update when the webhook is slow or non-2xx; the route uses this
        key to run each update's turn at most once. Default ``None`` ⇒ no dedupe (unchanged).
        """
        return None

    @abstractmethod
    def parse_inbound(self, raw: dict) -> tuple[str, str]:
        """Parse an inbound webhook payload *raw* into ``(identity, text)``.

        *identity* must be the fully-qualified platform identity string so it
        can be looked up in the pairing store.  *text* is the player's message.

        Raise ``ValueError`` if *raw* does not contain the expected fields —
        the gateway webhook route catches this and returns 400.
        """
