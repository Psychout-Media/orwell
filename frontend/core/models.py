# core/models.py
"""
Pure data models — no database logic, no side effects.

These are simple datacontainers. All persistence is handled by SessionManager.
"""

from dataclasses import dataclass
from typing import Dict, List, Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .session_manager import SessionManager

# Module-level session manager reference (set at app startup)
_session_manager: Optional["SessionManager"] = None


def set_session_manager(manager: "SessionManager"):
    """Set the global session manager reference."""
    global _session_manager
    _session_manager = manager


# ORW-187 - the persisted transcript keeps the FULL engine result of a few read tools in `tool_events[].engine_result` for ADMIN investigation only. Every non-admin serializer
# (the history routes, `ChatMessage.to_dict`, the SSE `metrics` event, the provider context) goes through `public_metadata`, which keeps ONLY these tool-event fields (a whitelist,
# so a new admin-only field is private by default). The admin transcript export reads the stored metadata directly and is the only reader of `engine_result`.
PUBLIC_TOOL_EVENT_FIELDS = frozenset({
    "round", "tool", "command", "output", "exit_code", "error",
    "image_url", "image_id", "image_prompt", "image_model", "image_size", "image_quality",
    "doc_id", "doc_title", "diff",
})


def public_tool_events(events: Any) -> Any:
    """Whitelist each tool event down to its public fields (non-dict entries pass through unchanged)."""
    if not isinstance(events, list):
        return events
    return [{k: v for k, v in e.items() if k in PUBLIC_TOOL_EVENT_FIELDS} if isinstance(e, dict) else e for e in events]


def public_metadata(metadata: Any) -> Any:
    """A copy of message `metadata` that is safe for a non-admin reader: `tool_events` are whitelisted. The stored metadata is never mutated.
    Also the INBOUND sanitizer: a client-supplied `engine_result` can never be stored (`add_message`)."""
    if not isinstance(metadata, dict) or "tool_events" not in metadata:
        return metadata
    return {**metadata, "tool_events": public_tool_events(metadata.get("tool_events"))}


# Server-owned metadata keys a CLIENT may never write (they feed the admin forensic ledger): dropped from any client-supplied metadata merge.
SERVER_OWNED_METADATA_KEYS = frozenset({"tool_events"})


def client_metadata_update(update: Any) -> dict:
    """The part of a client-supplied metadata UPDATE that may be merged into a stored message: everything except the server-owned keys (`tool_events`, hence `engine_result`).
    A non-dict update merges nothing."""
    if not isinstance(update, dict):
        return {}
    return {k: v for k, v in update.items() if k not in SERVER_OWNED_METADATA_KEYS}


@dataclass
class ChatMessage:
    """A single chat message."""
    role: str
    content: str
    metadata: Optional[Dict[str, Any]] = None
    # #1785: client-provided optimistic id for idempotent dedup / outbox confirm
    client_msg_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for API responses AND the provider context (`Session.get_context_messages`).
        The metadata is the PUBLIC projection: admin-only fields (ORW-187 `engine_result`) never leave through here."""
        result = {"role": self.role, "content": self.content}
        if self.metadata:
            result["metadata"] = public_metadata(self.metadata)
        return result

    def get(self, key: str, default=None):
        """Dict-like access for compatibility."""
        return getattr(self, key, default)


@dataclass
class Session:
    """A chat session — pure data container."""
    id: str
    name: str
    endpoint_url: str
    model: str
    rag: bool = False
    archived: bool = False
    headers: Optional[Dict[str, str]] = None
    history: List[ChatMessage] = None
    owner: Optional[str] = None
    is_important: bool = False
    message_count: int = 0

    def __post_init__(self):
        if self.history is None:
            self.history = []
        if self.headers is None:
            self.headers = {}

    def add_message(self, message: ChatMessage):
        """
        Add a message to this session.

        Delegates to SessionManager for persistence if available,
        otherwise just appends to history.
        """
        # A client RETRY (a dropped stream, then a resend with the SAME clientMsgId) must adopt the line that is already recorded, never append a second copy: the duplicate would show twice in
        # /api/history AND reach the narrator's context as a repeated player line. The persisted row was already adopted by the idempotent-replay branch of the persister.
        existing = self.find_user_by_client_msg_id(message)
        if existing is not None:
            if existing.metadata:
                message.metadata = {**(message.metadata or {}), **{k: v for k, v in existing.metadata.items() if k in ("_db_id", "_seq")}}
            return
        self.history.append(message)
        self.message_count = len(self.history)

        # Delegate to session manager for persistence
        if _session_manager:
            _session_manager._persist_message(self.id, message)

    def find_user_by_client_msg_id(self, message: "ChatMessage") -> "Optional[ChatMessage]":
        """The already-recorded USER line with this message's clientMsgId, or None (a different id, no id, or a non-user role always appends)."""
        cid = message.client_msg_id or (message.metadata or {}).get("client_msg_id")
        if not cid or message.role != "user":
            return None
        for m in reversed(self.history):
            if m.role == "user" and (m.client_msg_id == cid or (m.metadata or {}).get("client_msg_id") == cid):
                return m
        return None

    def get_context_messages(
        self, exclude_phases: Optional[set] = None,
        exclude_pre_game: bool = False,
    ) -> List[Dict[str, Any]]:
        """Get messages in format for LLM API.

        Slash-command / setup replies are persisted to history so they render
        in the transcript, but they are UI chatter (e.g. ``/setup ...`` and its
        status lines) the user never meant as conversation. They carry
        ``metadata.source == "slash"``; exclude them here so they never reach
        the model. Display/history-load paths use the raw ``history`` and are
        unaffected.

        ``exclude_phases`` is the Vault-Wall scope for the in-game narrator
        (casting-leak fix). The pre-game casting interview (0050) is an OOC,
        producer-level channel — like the Diary Room, it has NO in-game pathway
        to any NPC's knowledge. Those turns are persisted with
        ``metadata.phase == "casting"`` (so the player still SEES them in
        scrollback — one continuous conversation), but once a season is live the
        in-game narration context EXCLUDES them so the model cannot leak the
        player's private casting strategy/OOC reads to the houseguests. The model
        cannot leak what it never receives. Pass ``{"casting"}`` on a live-game
        turn; display/history paths use raw ``history`` and are unaffected.

        ``exclude_pre_game`` (#530 — STRUCTURAL casting-leak guard) makes the
        exclusion independent of every casting turn being individually stamped.
        The per-message ``phase == "casting"`` stamp can MISS (the finalize
        boundary computes ``game_active`` once at turn-start; a turn persisted
        without the stamp would otherwise leak). When the season is live, live
        play turns are stamped ``phase == "game"`` — the season-start boundary.
        With ``exclude_pre_game=True`` we drop EVERY turn before the first
        ``"game"``-stamped turn (the boundary, by sequence) that is not itself a
        live turn — so any UNSTAMPED pre-game turn is treated as casting and
        excluded structurally, even if its ``"casting"`` stamp was never written.
        """
        phases = exclude_phases or set()
        # #530: the season-start boundary = the first live ("game") turn. Everything in scroll
        # order before it is pre-game (casting / OOC setup), regardless of whether each turn got
        # its per-message stamp. Index-based so it survives a stamp miss AND a DB reload.
        boundary = -1
        if exclude_pre_game:
            for i, msg in enumerate(self.history):
                if (msg.metadata or {}).get("phase") == "game":
                    boundary = i
                    break
        result: List[Dict[str, Any]] = []
        for i, msg in enumerate(self.history):
            md = msg.metadata or {}
            if md.get("source") == "slash":
                continue
            if phases and md.get("phase") in phases:
                continue
            # Structural pre-game cut: before the live boundary, keep ONLY turns already marked
            # as live ("game"); drop everything else (stamped-casting AND unstamped pre-game).
            if exclude_pre_game and boundary >= 0 and i < boundary and md.get("phase") != "game":
                continue
            result.append(msg.to_dict())
        return result

    def get(self, key: str, default=None):
        """Dict-like access for compatibility."""
        return getattr(self, key, default)
