import os
import logging
import sqlite3
from datetime import datetime, timezone
from sqlalchemy import event, create_engine, Column, String, Text, Boolean, DateTime, Integer, ForeignKey, JSON, Index, func, text
from sqlalchemy.engine import Engine
from sqlalchemy.types import TypeDecorator
from sqlalchemy.ext.declarative import declarative_base, declared_attr
from sqlalchemy.orm import relationship, sessionmaker, backref

logger = logging.getLogger(__name__)

# Create base class for declarative models
Base = declarative_base()


def utcnow_naive() -> datetime:
    """Return naive UTC for existing DateTime columns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class TimestampMixin:
    """Mixin that adds timestamp fields to models"""
    @declared_attr
    def created_at(cls):
        return Column(DateTime, default=utcnow_naive, nullable=False)
    
    @declared_attr
    def updated_at(cls):
        return Column(DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False)

# Get database URL from environment, default to SQLite
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/app.db")

# Create engine
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
)

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# Listening on the Engine class ensures this listener fires for all Engine
# instances created within the process, not just the primary application engine.
# The isinstance(sqlite3.Connection) check ensures that this PRAGMA foreign_keys=ON
# configuration remains a no-op when using non-SQLite database backends.
@event.listens_for(Engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    if isinstance(dbapi_connection, sqlite3.Connection):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        # ORW-174: busy_timeout first (a locked write waits instead of failing at once). WAL + synchronous=NORMAL for FILE databases only: readers stop blocking the writer and each commit stops paying a
        # full fsync - the per-message persist and the HUD's session reads share this file. An in-memory database cannot be WAL (and a failed switch must never stop a connection from opening).
        cursor.execute("PRAGMA busy_timeout=5000")
        try:
            cursor.execute("PRAGMA database_list")
            main_file = next((row[2] for row in cursor.fetchall() if row[1] == "main"), "")
            if main_file:
                cursor.execute("PRAGMA journal_mode=WAL")
                cursor.execute("PRAGMA synchronous=NORMAL")
        except sqlite3.Error as e:  # failsoft-ok: WAL is a speed-up; a filesystem that refuses it (some network mounts) keeps the default journal and the app runs unchanged
            logger.warning("[db] could not enable WAL (%s); keeping the default journal mode", e)
        cursor.close()


class EncryptedText(TypeDecorator):
    """Text column transparently encrypted at rest via src.secret_storage.

    Writes are Fernet-encrypted (`enc:` prefix); reads decrypt back to
    plaintext, so all consumers use the column normally. Legacy plaintext
    rows pass through unchanged until their next write (a startup migration
    encrypts them). Protects the SQLite file at rest (stolen backup / leaked
    image), not a live process that can read the key.
    """
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        from src.secret_storage import encrypt
        return encrypt(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        from src.secret_storage import decrypt
        return decrypt(value)


class TolerantBoolean(TypeDecorator):
    """Boolean that tolerates legacy TEXT-affinity columns (ORW-209).

    A column that a legacy migration created as TEXT stores ``'0'``/``'1'``
    strings. SQLAlchemy's stock ``Boolean`` result processor treats any
    non-integer-zero value as True, so ``'0'`` read as True through the ORM
    while SQL filters (``is_enabled = 1``) treated it as disabled, and an ORM
    "enable" of such a row was a silent no-op (True -> True, nothing written).
    Reads parse the common textual spellings; writes stay ordinary booleans.
    """
    impl = Boolean
    cache_ok = True

    _FALSE = frozenset({"0", "false", "f", "no", "n", "off", "", "none", "null"})

    def _parse(self, value):
        if value is None:
            return None
        if isinstance(value, (bytes, bytearray)):
            value = value.decode("utf-8", "ignore")
        if isinstance(value, str):
            return value.strip().lower() not in self._FALSE
        return bool(value)

    def process_result_value(self, value, dialect):
        return self._parse(value)

    def result_processor(self, dialect, coltype):
        # Bypass the impl Boolean processor: it runs first in a TypeDecorator
        # chain and would already have turned the string "0" into True.
        return self._parse


class Session(TimestampMixin, Base):
    """
    SQLAlchemy model for Session table.
    Represents a chat session with its configuration and metadata.
    """
    __tablename__ = "sessions"
    
    # Primary key
    id = Column(String, primary_key=True, index=True)
    
    # Session metadata
    name = Column(String, nullable=False)
    endpoint_url = Column(String, nullable=False)
    model = Column(String, nullable=False)
    owner = Column(String, nullable=True, index=True)  # username; null = legacy/shared
    
    # Configuration flags
    rag = Column(TolerantBoolean, default=False)
    archived = Column(TolerantBoolean, default=False)

    # Organization
    folder = Column(String, nullable=True, default=None)
    
    # Headers stored as JSON
    headers = Column(JSON, default=dict)
    
    # Timestamps are provided by TimestampMixin
    last_accessed = Column(DateTime, default=func.now(), onupdate=func.now())
    # Timestamp of the last actual MESSAGE in this session. Set explicitly
    # only when a message is persisted (NOT onupdate) — so it's a clean
    # "last conversation" signal, immune to renames / model swaps / merely
    # opening the chat (all of which bump updated_at and last_accessed).
    # The "Last active" sort uses this.
    last_message_at = Column(DateTime, nullable=True, default=None)
    
    
    # Indexes - optimized composites
    __table_args__ = (
        Index('ix_sessions_active', 'archived', 'last_accessed'),
        Index('ix_sessions_search', 'name', 'archived'),
    )
    
    # Properties
    is_important = Column(TolerantBoolean, default=False)
    message_count = Column(Integer, default=0)
    total_input_tokens = Column(Integer, default=0)
    total_output_tokens = Column(Integer, default=0)
    mode = Column(String, nullable=True)  # 'agent', 'chat', or 'research'
    crew_member_id = Column(String, nullable=True)  # links to crew_members.id

    # Relationship to chat messages
    # ORW-197: explicit order. Without it SQLite serves the rows in whatever index order it picks (the UNIQUE
    # (session_id, client_msg_id) index puts every assistant row first), so a hydrated history was scrambled.
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan",
                            order_by="[ChatMessage.seq, ChatMessage.timestamp]")
    
    @property
    def is_active(self):
        """Check if session is active (not archived)"""
        return not self.archived
    
    def to_dict(self):
        """Convert session to dictionary for JSON serialization"""
        return {
            'id': self.id,
            'name': self.name,
            'model': self.model,
            'endpoint_url': self.endpoint_url,
            'rag': self.rag,
            'archived': self.archived,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            'last_accessed': self.last_accessed.isoformat() if self.last_accessed else None,
            'last_message_at': self.last_message_at.isoformat() if self.last_message_at else None,
            'message_count': self.message_count,
            'is_important': self.is_important,
            'folder': self.folder,
            'total_input_tokens': self.total_input_tokens or 0,
            'total_output_tokens': self.total_output_tokens or 0,
            'crew_member_id': self.crew_member_id,
        }

class ChatMessage(Base):
    """
    SQLAlchemy model for ChatMessage table.
    Represents individual chat messages within a session.
    """
    __tablename__ = "chat_messages"
    
    # Primary key - using String to support UUIDs
    id = Column(String, primary_key=True, index=True)
    
    # Foreign key to Session
    session_id = Column(String, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # Message content
    role = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    meta_data = Column("metadata", Text, nullable=True)  # JSON string for metrics etc.

    # Timestamp
    timestamp = Column(DateTime, default=utcnow_naive)

    # ADR 0008: a monotonic per-session sequence — the AUTHORITATIVE total order the chat
    # conversation renders from across tabs/devices. `timestamp` (utcnow, non-unique) ties under
    # concurrent writes and reorders; `seq` is assigned under the per-session write lock so every
    # render path can order by it deterministically. Nullable for back-compat (legacy rows are
    # backfilled from timestamp order by _migrate_add_chat_message_seq_column; new rows always get one).
    seq = Column(Integer, nullable=True)

    # #1785: client-provided optimistic id for idempotent dedup / outbox confirm
    client_msg_id = Column(String, nullable=True)

    # Relationship to Session
    session = relationship("Session", back_populates="messages")

    # Indexes - optimized composite
    __table_args__ = (
        Index('ix_messages_session_time', 'session_id', 'timestamp'),  # Composite for efficient message retrieval
        # #1785: unique on (session_id, client_msg_id) for idempotent replay
        Index('ix_messages_session_client_msg_id', 'session_id', 'client_msg_id', unique=True),
        # ADR 0008: the authoritative order is (session_id, seq); UNIQUE backstops the assignment
        # against a race (a second writer that computed the same MAX(seq)+1 fails and retries).
        Index('ix_messages_session_seq', 'session_id', 'seq', unique=True),
    )

class Document(TimestampMixin, Base):
    """Living document that the AI can create and edit in-place."""
    __tablename__ = "documents"

    id              = Column(String, primary_key=True, index=True)
    session_id      = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True, index=True)
    title           = Column(String, nullable=False, default="Untitled")
    language        = Column(String, nullable=True)          # "python", "markdown", "text", etc.
    current_content = Column(Text, nullable=False, default="")
    version_count   = Column(Integer, default=1)
    is_active       = Column(TolerantBoolean, default=True)
    # Soft-archive: hidden from the Library's Documents list/search/Tidy until
    # restored. Distinct from is_active (which tracks "open in a session").
    archived        = Column(TolerantBoolean, default=False)
    # Owner of this document. Documents used to derive ownership from their
    # linked chat session, but a session can be deleted (session_id → NULL via
    # SET NULL), orphaning the doc and making it vanish from the owner's
    # Library + search. Owning the row directly is robust against that.
    owner           = Column(String, nullable=True, index=True)
    tidy_verdict    = Column(String, nullable=True)        # "keep", "junk", or None (not yet reviewed)
    # Provenance: if this document was created by opening an email attachment,
    # these point back to the source email so the "Sign and reply" flow can
    # thread a response on the original conversation.
    source_email_uid         = Column(String, nullable=True)
    source_email_folder      = Column(String, nullable=True)
    source_email_account_id  = Column(String, nullable=True)
    source_email_message_id  = Column(String, nullable=True, index=True)

    session  = relationship("Session", backref=backref("documents", cascade="save-update, merge"))
    versions = relationship("DocumentVersion", back_populates="document",
                           cascade="all, delete-orphan", order_by="DocumentVersion.version_number")


class DocumentVersion(Base):
    """Immutable snapshot of a document at a point in time."""
    __tablename__ = "document_versions"

    id             = Column(String, primary_key=True, index=True)
    document_id    = Column(String, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True)
    version_number = Column(Integer, nullable=False)
    content        = Column(Text, nullable=False)
    summary        = Column(String, nullable=True)     # Edit description
    source         = Column(String, default="ai")      # "ai" or "user"
    created_at     = Column(DateTime, default=utcnow_naive)

    document = relationship("Document", back_populates="versions")


class GalleryAlbum(TimestampMixin, Base):
    """A photo album/folder."""
    __tablename__ = "gallery_albums"

    id          = Column(String, primary_key=True, index=True)
    name        = Column(String, nullable=False)
    description = Column(Text, default="")
    cover_id    = Column(String, nullable=True)  # GalleryImage.id for cover photo
    owner       = Column(String, nullable=True, index=True)

    images = relationship("GalleryImage", back_populates="album")


class GalleryImage(TimestampMixin, Base):
    """Stores metadata for photos and AI-generated images."""
    __tablename__ = "gallery_images"

    id         = Column(String, primary_key=True, index=True)
    filename   = Column(String, nullable=False, unique=True)
    prompt     = Column(Text, nullable=False, default="")
    model      = Column(String, nullable=True)
    size       = Column(String, nullable=True)
    quality    = Column(String, nullable=True)
    tags       = Column(String, nullable=True, default="")
    ai_tags    = Column(Text, nullable=True, default="")       # AI-generated tags (comma-separated)
    session_id = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True, index=True)
    album_id   = Column(String, ForeignKey("gallery_albums.id", ondelete="SET NULL"), nullable=True, index=True)
    owner      = Column(String, nullable=True, index=True)
    is_active  = Column(TolerantBoolean, default=True)
    favorite   = Column(TolerantBoolean, default=False)

    # File integrity
    file_hash  = Column(String(64), nullable=True, index=True)  # SHA-256

    # EXIF / photo metadata
    taken_at       = Column(DateTime, nullable=True, index=True)  # EXIF DateTimeOriginal
    camera_make    = Column(String, nullable=True)
    camera_model   = Column(String, nullable=True)
    gps_lat        = Column(String, nullable=True)  # stored as string for precision
    gps_lng        = Column(String, nullable=True)
    width          = Column(Integer, nullable=True)
    height         = Column(Integer, nullable=True)
    file_size      = Column(Integer, nullable=True)  # bytes

    session = relationship("Session", backref=backref("gallery_images"))
    album   = relationship("GalleryAlbum", back_populates="images")

    __table_args__ = (
        Index('ix_gallery_images_tags', 'tags'),
        Index('ix_gallery_images_model', 'model'),
        Index('ix_gallery_images_active', 'is_active', 'created_at'),
    )


class EmailAccount(TimestampMixin, Base):
    """A configured IMAP/SMTP account. Supports multiple accounts per user —
    exactly one row per owner has is_default=True.

    Security note: imap_password / smtp_password are stored Fernet-encrypted
    via src/secret_storage.py. The key lives at data/.app_key (mode 0o600,
    gitignored). Anyone with read access to that file can decrypt every
    row, so the threat model is "stolen SQLite backup" rather than
    "process compromise". On first start any legacy plaintext rows are
    migrated automatically (see _migrate_encrypt_email_passwords).
    """
    __tablename__ = "email_accounts"

    id             = Column(String, primary_key=True, index=True)
    owner          = Column(String, nullable=True, index=True)
    name           = Column(String, nullable=False)  # Display name: "Work", "Personal", etc.
    is_default     = Column(TolerantBoolean, default=False, nullable=False)
    enabled        = Column(TolerantBoolean, default=True, nullable=False)

    # IMAP (receiving)
    imap_host      = Column(String, default="")
    imap_port      = Column(Integer, default=993)
    imap_user      = Column(String, default="")
    imap_password  = Column(String, default="")
    imap_starttls  = Column(TolerantBoolean, default=True)

    # SMTP (sending)
    smtp_host      = Column(String, default="")
    smtp_port      = Column(Integer, default=465)
    smtp_security  = Column(String, default="ssl")  # ssl | starttls | none
    smtp_user      = Column(String, default="")
    smtp_password  = Column(String, default="")

    from_address   = Column(String, default="")

    __table_args__ = (
        Index('ix_email_accounts_owner_default', 'owner', 'is_default'),
    )


class ModelEndpoint(TimestampMixin, Base):
    """Admin-configured model endpoints. Models are auto-discovered via /v1/models."""
    __tablename__ = "model_endpoints"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)          # Display label, e.g. "Local vLLM", "OpenRouter"
    base_url = Column(String, nullable=False)      # Base URL, e.g. "http://localhost:8002/v1"
    api_key = Column(EncryptedText, nullable=True)  # Optional provider API key, encrypted at rest
    is_enabled = Column(TolerantBoolean, default=True)
    hidden_models = Column(Text, nullable=True)    # JSON list of model IDs that failed probing
    cached_models = Column(Text, nullable=True)    # JSON list of last-known model IDs (avoids probe on list)
    pinned_models = Column(Text, nullable=True)    # JSON list of admin-pinned model IDs (manual, may not appear in /v1/models)
    model_type = Column(String, nullable=True, default="llm")  # "llm" or "image"
    # auto = classify by URL; local = self-hosted server; api/proxy = external
    # OpenAI-compatible API even when reachable through a private/tailnet IP.
    endpoint_kind = Column(String, nullable=True, default="auto")
    # auto = background refresh with TTL/backoff; manual/disabled = cached-first
    # only unless an explicit endpoint probe is requested.
    model_refresh_mode = Column(String, nullable=True, default="auto")
    model_refresh_interval = Column(Integer, nullable=True, default=None)
    model_refresh_timeout = Column(Integer, nullable=True, default=None)
    # Whether models on this endpoint accept OpenAI-style function
    # schemas + emit `tool_calls`. Auto-detected at Cookbook auto-
    # register time from `--enable-auto-tool-choice` in the serve cmd;
    # can be toggled per-endpoint in the UI. NULL = unknown, falls
    # back to the model-name keyword heuristic in agent_loop.py.
    supports_tools = Column(TolerantBoolean, nullable=True, default=None)
    # Per-user ownership. NULL = legacy/shared (visible to every user) — this
    # is the historical default. When non-null, the model picker only shows
    # the endpoint to that user (admins always see everything).
    owner = Column(String, nullable=True, index=True)

class McpServer(TimestampMixin, Base):
    """Admin-configured MCP (Model Context Protocol) tool servers."""
    __tablename__ = "mcp_servers"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    transport = Column(String, nullable=False, default="stdio")  # "stdio" or "sse"
    command = Column(String, nullable=True)      # For stdio: executable path
    args = Column(Text, nullable=True)           # JSON array of command args
    env = Column(Text, nullable=True)            # JSON object of env vars
    url = Column(String, nullable=True)          # For SSE: server URL
    is_enabled = Column(TolerantBoolean, default=True)
    oauth_config = Column(Text, nullable=True)   # JSON: provider, keys_file, token_file, scopes
    disabled_tools = Column(Text, nullable=True)  # JSON array of tool names to hide from LLM
    oauth_tokens = Column(EncryptedText, nullable=True)  # JSON {tokens, client_info} for generic MCP OAuth, encrypted at rest


class Comparison(TimestampMixin, Base):
    """Stores A/B model comparison results."""
    __tablename__ = "comparisons"

    id = Column(String, primary_key=True, index=True)
    session_id = Column(String, nullable=True)     # Parent session context (optional)
    owner = Column(String, nullable=True, index=True)  # username
    prompt = Column(Text, nullable=False)
    model_a = Column(String, nullable=False)
    model_b = Column(String, nullable=False)
    endpoint_a = Column(String, nullable=False)
    endpoint_b = Column(String, nullable=False)
    response_a = Column(Text, nullable=True)
    response_b = Column(Text, nullable=True)
    metrics_a = Column(Text, nullable=True)         # JSON string
    metrics_b = Column(Text, nullable=True)         # JSON string
    winner = Column(String, nullable=True)           # "a", "b", "tie", or null
    is_blind = Column(TolerantBoolean, default=True)
    blind_mapping = Column(Text, nullable=True)      # JSON: {"left": "a"/"b", "right": "a"/"b"}
    voted_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index('ix_comparisons_voted_at', 'voted_at'),
    )


class Signature(TimestampMixin, Base):
    """User-saved visual signatures (image stamps).

    Reusable across PDF form filling, email composition, and document editing.
    `data_png` is a base64-encoded PNG (no `data:` prefix). The SVG vector
    column is reserved for future smooth vector storage. Both are stored
    Fernet-encrypted at rest (see EncryptedText / src.secret_storage); a
    handwritten signature is sensitive, so it must never sit plaintext in the
    DB file. Existing rows are migrated automatically on startup.
    """
    __tablename__ = "signatures"

    id = Column(String, primary_key=True, index=True)
    owner = Column(String, nullable=True, index=True)
    name = Column(String, nullable=False, default="Signature")
    data_png = Column(EncryptedText, nullable=False)   # base64 PNG, encrypted at rest
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    svg = Column(EncryptedText, nullable=True)         # vector signature, encrypted at rest


class ApiToken(TimestampMixin, Base):
    """API tokens for external integrations (n8n, Make, etc.)."""
    __tablename__ = "api_tokens"

    id = Column(String, primary_key=True, index=True)
    owner = Column(String, nullable=True, index=True)
    name = Column(String, nullable=False)
    token_hash = Column(String, nullable=False)
    token_prefix = Column(String, nullable=False)  # first 8 chars for display
    scopes = Column(String, nullable=False, default="chat")
    is_active = Column(TolerantBoolean, default=True)
    last_used_at = Column(DateTime, nullable=True)


class Webhook(TimestampMixin, Base):
    """Outgoing webhooks fired on events."""
    __tablename__ = "webhooks"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    url = Column(String, nullable=False)
    secret = Column(String, nullable=True)  # HMAC-SHA256 signing secret
    events = Column(String, nullable=False)  # comma-separated event types
    is_active = Column(TolerantBoolean, default=True)
    last_triggered_at = Column(DateTime, nullable=True)
    last_status_code = Column(Integer, nullable=True)
    last_error = Column(String, nullable=True)


class UserTool(TimestampMixin, Base):
    """User-created sandboxed mini-apps/tools."""
    __tablename__ = "user_tools"

    id            = Column(String, primary_key=True, index=True)
    name          = Column(String, nullable=False)
    description   = Column(Text, nullable=True)
    icon          = Column(String, nullable=True, default="")
    html_content  = Column(Text, nullable=False)
    scope         = Column(String, nullable=False, default="global")  # "global" or session_id
    session_id    = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True)
    owner         = Column(String, nullable=True, index=True)      # username
    is_pinned     = Column(TolerantBoolean, default=False)
    is_active     = Column(TolerantBoolean, default=True)
    version       = Column(Integer, default=1)
    author        = Column(String, nullable=True, default="ai")

    session = relationship("Session", backref=backref("user_tools", cascade="all, delete-orphan"))

    __table_args__ = (
        Index('ix_user_tools_scope', 'scope'),
        Index('ix_user_tools_active', 'is_active'),
    )


class UserToolData(Base):
    """Key-value storage for user tool persistent data."""
    __tablename__ = "user_tool_data"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    tool_id    = Column(String, ForeignKey("user_tools.id", ondelete="CASCADE"), nullable=False)
    key        = Column(String, nullable=False)
    value      = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utcnow_naive)
    updated_at = Column(DateTime, default=utcnow_naive, onupdate=utcnow_naive)

    tool = relationship("UserTool", backref=backref("data_entries", cascade="all, delete-orphan"))

    __table_args__ = (
        Index('ix_user_tool_data_tool_key', 'tool_id', 'key', unique=True),
    )


class CrewMember(TimestampMixin, Base):
    """A custom AI persona ('crew member') with its own personality, model, tools, and memory scope."""
    __tablename__ = "crew_members"

    id            = Column(String, primary_key=True, index=True)
    owner         = Column(String, nullable=True, index=True)
    name          = Column(String, nullable=False)
    avatar        = Column(String, nullable=True)
    user_name     = Column(String, nullable=True)          # what they call the user
    personality   = Column(Text, nullable=True)             # system prompt
    model         = Column(String, nullable=True)
    endpoint_url  = Column(String, nullable=True)
    greeting      = Column(Text, nullable=True)
    enabled_tools = Column(Text, nullable=True)             # JSON array or "all"
    session_id    = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True)
    is_active     = Column(TolerantBoolean, default=True)
    sort_order    = Column(Integer, default=0)
    is_default_assistant = Column(TolerantBoolean, default=False)   # singleton per-owner "personal assistant"
    timezone      = Column(String, nullable=True)           # IANA tz name (e.g. "America/New_York") for scheduled check-ins

    session = relationship("Session", foreign_keys=[session_id],
                           backref=backref("crew_member", uselist=False))


class ScheduledTask(TimestampMixin, Base):
    """A recurring or one-off task — LLM-powered or direct action, time or event triggered."""
    __tablename__ = "scheduled_tasks"

    id             = Column(String, primary_key=True, index=True)
    owner          = Column(String, nullable=True, index=True)
    name           = Column(String, nullable=False, default="Untitled Task")
    prompt         = Column(Text, nullable=True)              # LLM prompt (for task_type="llm")
    task_type      = Column(String, default="llm")            # "llm" | "action"
    action         = Column(String, nullable=True)            # builtin action name (for task_type="action")
    schedule       = Column(String, nullable=True)            # "once", "daily", "weekly", "monthly"
    scheduled_time = Column(String, nullable=True)            # "HH:MM" (24h, stored UTC)
    scheduled_day  = Column(Integer, nullable=True)           # day-of-week 0=Mon for weekly, day-of-month for monthly
    scheduled_date = Column(DateTime, nullable=True)          # exact datetime for "once"
    trigger_type   = Column(String, default="schedule")       # "schedule" | "event"
    trigger_event  = Column(String, nullable=True)            # e.g. "session_created", "message_sent"
    trigger_count  = Column(Integer, nullable=True)           # fire every N events
    trigger_counter = Column(Integer, default=0)              # current count toward trigger_count
    next_run       = Column(DateTime, nullable=True, index=True)
    last_run       = Column(DateTime, nullable=True)
    status         = Column(String, default="active")         # "active", "paused", "completed"
    output_target  = Column(String, default="session")        # "session" (extensible later)
    session_id     = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True)
    model          = Column(String, nullable=True)
    endpoint_url   = Column(String, nullable=True)
    run_count      = Column(Integer, default=0)

    cron_expression = Column(String, nullable=True)           # cron string e.g. "*/5 * * * *"
    then_task_id   = Column(String, ForeignKey("scheduled_tasks.id", ondelete="SET NULL"), nullable=True)
    webhook_token  = Column(String, nullable=True, unique=True)
    crew_member_id = Column(String, nullable=True)     # optional link to crew_members.id
    # character_id historically referenced an agent_characters table that was
    # never actually created. Keep the column for schema compatibility but
    # drop the ForeignKey so SQLAlchemy table sort doesn't fail on flush.
    character_id   = Column(String, nullable=True)
    max_steps      = Column(Integer, nullable=True)       # max agent loop iterations (null=unlimited)
    email_results  = Column(TolerantBoolean, default=True)        # email results to character.email_to
    notifications_enabled = Column(TolerantBoolean, default=True) # per-task on/off for completion notifications

    session = relationship("Session", backref=backref("scheduled_tasks", cascade="save-update, merge"))
    then_task = relationship("ScheduledTask", remote_side=[id], foreign_keys=[then_task_id])

    __table_args__ = (
        Index('ix_scheduled_tasks_due', 'status', 'next_run'),
        Index('ix_scheduled_tasks_event', 'trigger_type', 'trigger_event', 'status'),
    )


class EditorDraft(TimestampMixin, Base):
    """Persisted in-progress gallery-editor session — layered project state
    that the user can close and reopen later. Stores the full layer payload
    as JSON (with base64-encoded PNG dataURLs per layer) plus a small
    thumbnail for the landing-screen list.
    """
    __tablename__ = "editor_drafts"

    id              = Column(String, primary_key=True, index=True)
    owner           = Column(String, nullable=True, index=True)
    name            = Column(String, nullable=False, default="Untitled")
    # If the draft was opened FROM a gallery photo, point back at it so we
    # can show "Resuming edit of <photo>" and so reopening that photo picks
    # up the same draft rather than starting fresh.
    source_image_id = Column(String, nullable=True, index=True)
    width           = Column(Integer, nullable=True)
    height          = Column(Integer, nullable=True)
    # Full draft body — layer pixels (base64 PNG dataURLs), offsets,
    # opacities, visibility, active id, next id, etc. Kept as TEXT/JSON so
    # we don't have to re-shape the model every time the editor adds a
    # new piece of state.
    payload         = Column(Text, nullable=False, default="")
    # Tiny preview (data URL, ~128px wide) for the landing list. Stored
    # inline so the list endpoint can return everything in one shot.
    thumbnail       = Column(Text, nullable=True)
    is_active       = Column(TolerantBoolean, default=True)

    __table_args__ = (
        Index('ix_editor_drafts_owner_updated', 'owner', 'is_active', 'updated_at'),
    )


class TaskRun(Base):
    """Record of a single execution of a ScheduledTask."""
    __tablename__ = "task_runs"

    id          = Column(String, primary_key=True, index=True)
    task_id     = Column(String, ForeignKey("scheduled_tasks.id", ondelete="CASCADE"), nullable=False)
    started_at  = Column(DateTime, nullable=False, default=utcnow_naive)
    finished_at = Column(DateTime, nullable=True)
    status      = Column(String, default="running")  # "running", "success", "error"
    result      = Column(Text, nullable=True)
    error       = Column(Text, nullable=True)
    tokens_used = Column(Integer, nullable=True)
    steps       = Column(Text, nullable=True)             # JSON log of agent tool calls
    model       = Column(String, nullable=True)           # model that actually ran (resolved at execution)

    task = relationship("ScheduledTask", backref=backref("runs", cascade="all, delete-orphan",
                        order_by="TaskRun.started_at.desc()"))

    __table_args__ = (
        Index('ix_task_runs_task', 'task_id', 'started_at'),
    )


class Memory(Base):
    """
    SQLAlchemy model for Memory table.
    Represents persistent memory entries with metadata.
    """
    __tablename__ = "memories"
    
    # Primary key
    id = Column(String, primary_key=True, index=True)
    
    # Memory content
    text = Column(Text, nullable=False)
    
    # Categorization
    category = Column(String, default='fact')
    source = Column(String, default='user')

    # Owner (username)
    owner = Column(String, nullable=True, index=True)

    # Reference to session (nullable)
    session_id = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True, index=True)

    # Timestamp as Unix timestamp
    timestamp = Column(Integer, default=lambda: int(utcnow_naive().timestamp()))

    # Relationship to Session
    session = relationship("Session", backref="memories")

    # Indexes - optimized composites
    __table_args__ = (
        Index('ix_memories_lookup', 'category', 'timestamp'),  # Composite for category-based queries
        Index('ix_memories_session', 'session_id', 'timestamp'),  # Composite for session-based queries
    )

def _migrate_add_last_message_at_column():
    """Add last_message_at to sessions + backfill from the latest message
    timestamp per session (fallback to last_accessed / created_at when a
    session has no messages). Idempotent: column-add is guarded, and the
    backfill only touches rows where last_message_at is still NULL so it
    won't clobber live values on later restarts."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in cursor.fetchall()]
        if "last_message_at" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN last_message_at DATETIME")
        # Backfill any NULL rows: newest message timestamp, else last_accessed,
        # else created_at. Only fills NULLs so it's safe on every startup.
        conn.execute(
            """
            UPDATE sessions
               SET last_message_at = COALESCE(
                   (SELECT MAX(timestamp) FROM chat_messages
                     WHERE chat_messages.session_id = sessions.id),
                   last_accessed,
                   created_at
               )
             WHERE last_message_at IS NULL
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS ix_sessions_last_message_at "
            "ON sessions(archived, last_message_at)"
        )
        conn.commit()
        conn.close()
        logging.getLogger(__name__).info("Migrated: added + backfilled 'last_message_at' on sessions")
    except Exception as e:
        logging.getLogger(__name__).warning(f"last_message_at migration failed: {e}")

def _migrate_add_chat_message_seq_column():
    """ADR 0008: add a monotonic per-session `seq` to chat_messages + backfill existing rows
    from their timestamp order, then enforce UNIQUE(session_id, seq).

    Idempotent: the column-add is guarded; the backfill only touches rows where `seq` is still
    NULL (so it never re-numbers a live conversation on a later restart); the unique index is
    `IF NOT EXISTS`. The backfill assigns a dense 0-based sequence per session by (timestamp, rowid)
    — rowid breaks the non-unique-timestamp ties that caused the cross-tab reorder, so the result is
    a clean total order with no unique-index collision."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(chat_messages)")
        columns = [row[1] for row in cursor.fetchall()]
        if "seq" not in columns:
            conn.execute("ALTER TABLE chat_messages ADD COLUMN seq INTEGER")
        # Backfill any NULL seq: a dense per-session 0-based order by (timestamp, rowid).
        conn.execute(
            """
            WITH ordered AS (
                SELECT id,
                       ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp, rowid) - 1 AS rn
                  FROM chat_messages
            )
            UPDATE chat_messages
               SET seq = (SELECT rn FROM ordered WHERE ordered.id = chat_messages.id)
             WHERE seq IS NULL
            """
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_messages_session_seq "
            "ON chat_messages(session_id, seq)"
        )
        conn.commit()
        conn.close()
        logging.getLogger(__name__).info("Migrated: added + backfilled 'seq' on chat_messages (ADR 0008)")
    except Exception as e:
        logging.getLogger(__name__).warning(f"chat_messages.seq migration failed: {e}")


def _migrate_add_chat_message_client_msg_id_column():
    """#1785: add client_msg_id to chat_messages + backfill from metadata + defensive de-dup + unique index.

    TRUE no-op after first run: checks for the unique index upfront and returns immediately if it
    already exists, so the backfill + de-dup + index phases never re-run on a subsequent restart.
    The column-add is guarded; the backfill only touches NULL rows; the unique index is created with
    `IF NOT EXISTS`. Pre-index de-dup nulls out conflicting non-null duplicates within a session so
    the index creation cannot fail on pre-existing duplicates from concurrent client_msg_id generation.

    Connection-safe: `finally` guarantees `conn.close()` even on exception, preventing "database is
    locked" connection leaks.
    """
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        # ★ BUG 1 fix: if the unique index already exists, this migration has already run —
        # return immediately to avoid re-backfilling/re-deduping (which would re-populate rows
        # nulled by a previous run and violate the existing index).
        existing_idx = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name='ix_messages_session_client_msg_id'"
        ).fetchone()
        if existing_idx:
            return

        cursor = conn.execute("PRAGMA table_info(chat_messages)")
        columns = [row[1] for row in cursor.fetchall()]
        if "client_msg_id" not in columns:
            conn.execute("ALTER TABLE chat_messages ADD COLUMN client_msg_id TEXT")
        # Backfill from existing JSON metadata blob.
        conn.execute(
            """
            UPDATE chat_messages
               SET client_msg_id = json_extract(metadata, '$.client_msg_id')
             WHERE client_msg_id IS NULL
               AND json_extract(metadata, '$.client_msg_id') IS NOT NULL
            """
        )
        # ★ Defensive de-dup: null out all but one conflicting client_msg_id per session.
        # Do NOT delete rows — only clear the client_msg_id from duplicates so the unique index
        # creation doesn't fail. SQLite treats NULL as distinct per row, so legacy/system rows
        # without a client_msg_id never collide with the index.
        import logging as _log
        dup_rows = conn.execute(
            """
            SELECT COUNT(*) - COUNT(DISTINCT client_msg_id) AS dups
              FROM chat_messages
             WHERE client_msg_id IS NOT NULL
            """
        ).fetchone()[0]
        if dup_rows:
            _log.getLogger(__name__).warning(
                f"chat_messages.client_msg_id: {dup_rows} duplicate(s) found — nulling all but one per (session, client_msg_id)"
            )
        conn.execute(
            """
            UPDATE chat_messages
               SET client_msg_id = NULL
             WHERE rowid NOT IN (
                 SELECT MIN(rowid)
                   FROM chat_messages
                  WHERE client_msg_id IS NOT NULL
                  GROUP BY session_id, client_msg_id
             )
               AND client_msg_id IS NOT NULL
            """
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_messages_session_client_msg_id "
            "ON chat_messages(session_id, client_msg_id)"
        )
        conn.commit()
    except Exception as e:
        logging.getLogger(__name__).warning(f"chat_messages.client_msg_id migration failed: {e}")
        raise
    finally:
        # ★ BUG 2 fix: always close the connection so a write lock is never stranded.
        if conn:
            try:
                conn.close()
            except Exception:
                pass
        logging.getLogger(__name__).info("Migrated: added + backfilled 'client_msg_id' on chat_messages (#1785)")


def _migrate_add_document_archived_column():
    """Add `archived` to documents (soft-archive flag). Guarded + idempotent."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(documents)")
        columns = [row[1] for row in cursor.fetchall()]
        if "archived" not in columns:
            conn.execute("ALTER TABLE documents ADD COLUMN archived BOOLEAN DEFAULT 0")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'archived' to documents")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"documents.archived migration failed: {e}")


def _migrate_add_owner_column():
    """Add owner column to sessions table if it doesn't exist."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in cursor.fetchall()]
        if "owner" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN owner TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_sessions_owner ON sessions(owner)")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'owner' column to sessions")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"Migration check failed: {e}")

def _migrate_model_endpoints():
    """Recreate model_endpoints table if schema changed (url->base_url)."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "base_url" not in columns:
            conn.execute("DROP TABLE IF EXISTS model_endpoints")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: dropped old model_endpoints table (schema change)")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"model_endpoints migration check failed: {e}")

def _migrate_add_hidden_models_column():
    """Add hidden_models column to model_endpoints if it doesn't exist."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "hidden_models" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN hidden_models TEXT")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'hidden_models' column to model_endpoints")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"hidden_models migration failed: {e}")

def _migrate_add_model_endpoint_owner_column():
    """Add owner column to model_endpoints if it doesn't exist.

    Without this column, the per-user model picker query
    `(owner == user) | (owner IS NULL)` fails with `OperationalError:
    no such column: model_endpoints.owner`, leaving non-admin users
    with an empty picker even when `allowed_models` is unrestricted.
    Backfills NULL for existing rows (treated as shared by the filter).
    """
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "owner" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN owner VARCHAR")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_model_endpoints_owner ON model_endpoints(owner)")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'owner' column + index to model_endpoints")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"model_endpoints.owner migration failed: {e}")


def _migrate_add_model_type_column():
    """Add model_type column to model_endpoints if it doesn't exist."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "model_type" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN model_type TEXT DEFAULT 'llm'")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'model_type' column to model_endpoints")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"model_type migration failed: {e}")

def _migrate_add_model_endpoint_refresh_columns():
    """Add endpoint classification / refresh policy columns if missing."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "endpoint_kind" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN endpoint_kind TEXT DEFAULT 'auto'")
        if columns and "model_refresh_mode" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN model_refresh_mode TEXT DEFAULT 'auto'")
        if columns and "model_refresh_interval" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN model_refresh_interval INTEGER")
        if columns and "model_refresh_timeout" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN model_refresh_timeout INTEGER")
        conn.commit()
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"model_endpoints refresh-policy migration failed: {e}")

def _migrate_add_task_run_model_column():
    """Add model column to task_runs if it doesn't exist (records which model ran)."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(task_runs)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "model" not in columns:
            conn.execute("ALTER TABLE task_runs ADD COLUMN model TEXT")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'model' column to task_runs")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"task_runs model migration failed: {e}")

def _migrate_add_supports_tools_column():
    """Add supports_tools column to model_endpoints if it doesn't exist."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "supports_tools" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN supports_tools BOOLEAN")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'supports_tools' column to model_endpoints")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"supports_tools migration failed: {e}")


def _migrate_add_cached_models_column():
    """Add cached_models column to model_endpoints if it doesn't exist."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "cached_models" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN cached_models TEXT")
            conn.commit()
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"cached_models migration failed: {e}")

def _migrate_add_pinned_models_column():
    """Add pinned_models column to model_endpoints if it doesn't exist."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "pinned_models" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN pinned_models TEXT")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'pinned_models' column to model_endpoints")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"pinned_models migration failed: {e}")

def _migrate_add_notes_sort_order():
    """Add sort_order, image_url, repeat columns to notes if they don't exist."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(notes)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "sort_order" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN sort_order INTEGER DEFAULT 0")
        if columns and "image_url" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN image_url TEXT")
        if columns and "repeat" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN repeat TEXT DEFAULT 'none'")
        if columns and "ai_classification" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN ai_classification TEXT")
        if columns and "ai_content_hash" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN ai_content_hash TEXT")
        if columns and "agent_session_id" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN agent_session_id TEXT")
        conn.commit()
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"notes migration failed: {e}")

def _migrate_add_mode_column():
    """Add mode column to sessions table if it doesn't exist."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in cursor.fetchall()]
        if "mode" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN mode TEXT")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'mode' column to sessions")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"Migration check for mode failed: {e}")

def _migrate_add_folder_column():
    """Add folder column to sessions table if it doesn't exist."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in cursor.fetchall()]
        if "folder" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN folder TEXT")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'folder' column to sessions")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"Migration check for folder failed: {e}")

def _migrate_add_token_columns():
    """Add cumulative token tracking columns to sessions table."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in cursor.fetchall()]
        if "total_input_tokens" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN total_input_tokens INTEGER DEFAULT 0")
            conn.execute("ALTER TABLE sessions ADD COLUMN total_output_tokens INTEGER DEFAULT 0")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added token tracking columns to sessions")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"Migration check for token columns failed: {e}")

def _migrate_add_owner_to_table(table_name: str, index_name: str):
    """Generic helper: add owner TEXT column + index to a table if missing."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute(f"PRAGMA table_info({table_name})")
        columns = [row[1] for row in cursor.fetchall()]
        if "owner" not in columns:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN owner TEXT")
            conn.execute(f"CREATE INDEX IF NOT EXISTS {index_name} ON {table_name}(owner)")
            conn.commit()
            logging.getLogger(__name__).info(f"Migrated: added 'owner' column to {table_name}")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"Migration owner column for {table_name} failed: {e}")

def _migrate_add_multiuser_owner_columns():
    """Add owner column to memories, gallery_images, user_tools, comparisons."""
    _migrate_add_owner_to_table("memories", "ix_memories_owner")
    _migrate_add_owner_to_table("gallery_images", "ix_gallery_images_owner")
    _migrate_add_owner_to_table("user_tools", "ix_user_tools_owner")
    _migrate_add_owner_to_table("comparisons", "ix_comparisons_owner")
    _migrate_add_owner_to_table("api_tokens", "ix_api_tokens_owner")
    # documents derived ownership from their session join until this column
    # existed; the legacy-owner sweep (below) backfills it on the next boot.
    _migrate_add_owner_to_table("documents", "ix_documents_owner")


def _migrate_add_api_token_scopes_column():
    """Add API token scopes for existing installs.

    Existing tokens get the current only-supported scope (`chat`) so they keep
    working after the schema migration, but route checks no longer treat tokens
    as an unscoped bearer credential.
    """
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        columns = [row[1] for row in conn.execute("PRAGMA table_info(api_tokens)").fetchall()]
        if columns and "scopes" not in columns:
            conn.execute("ALTER TABLE api_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'chat'")
            conn.execute("UPDATE api_tokens SET scopes = 'chat' WHERE scopes IS NULL OR scopes = ''")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added scopes column to api_tokens")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"api_tokens.scopes migration failed: {e}")

def _migrate_assign_legacy_owner():
    """Assign all null-owner data to the first (admin) user.

    Runs at boot AND periodically (sweep_null_owners) so that data created
    while auth is disabled / middleware is bypassed via localhost doesn't
    sit in the DB as world-visible. Previously only swept 5 tables; the
    actual set of owner-bearing tables is much larger.
    """
    import sqlite3
    import json as _json

    # Find admin user from auth.json. The auth schema uses `is_admin: True`,
    # not `role: "admin"` — old code looked for the wrong field and silently
    # fell through to "first user" every time.
    auth_path = os.path.join(os.path.dirname(DATABASE_URL.replace("sqlite:///", "")), "auth.json")
    if not os.path.isabs(auth_path):
        auth_path = os.path.join("data", "auth.json")
    admin_user = None
    try:
        with open(auth_path, "r", encoding="utf-8") as f:
            auth_data = _json.load(f)
        users = auth_data.get("users", {})
        if users:
            for uname, udata in users.items():
                if udata.get("is_admin") is True:
                    admin_user = uname
                    break
            if not admin_user:
                admin_user = next(iter(users))
    except Exception:
        pass

    if not admin_user:
        return

    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return

    logger = logging.getLogger(__name__)
    try:
        conn = sqlite3.connect(db_path)
        # Every table with an `owner` column. New tables added later will be
        # picked up automatically because we only UPDATE when the column
        # exists; the explicit list documents intent.
        tables = [
            "sessions", "memories", "gallery_images", "user_tools",
            "comparisons", "documents", "signatures", "notes",
            "calendars", "calendar_events", "integrations",
            "scheduled_tasks", "task_runs", "crew_members",
            "gallery_albums", "gallery_people", "user_tool_data",
            "api_tokens", "webhooks",
        ]
        for table in tables:
            try:
                cursor = conn.execute(f"PRAGMA table_info({table})")
                columns = [row[1] for row in cursor.fetchall()]
                if "owner" in columns:
                    res = conn.execute(f"UPDATE {table} SET owner = ? WHERE owner IS NULL", (admin_user,))
                    if res.rowcount > 0:
                        logger.info(f"Assigned {res.rowcount} legacy rows in {table} to '{admin_user}'")
            except Exception as e:
                logger.warning(f"Legacy owner assignment for {table} failed: {e}")
        conn.commit()
        conn.close()
    except Exception as e:
        logger.warning(f"Legacy owner migration failed: {e}")

    # Also migrate memory.json
    mem_path = os.path.join("data", "memory.json")
    try:
        if os.path.exists(mem_path):
            with open(mem_path, "r", encoding="utf-8") as f:
                memories = _json.load(f)
            changed = False
            for m in memories:
                if not m.get("owner"):
                    m["owner"] = admin_user
                    changed = True
            if changed:
                with open(mem_path, "w", encoding="utf-8") as f:
                    _json.dump(memories, f, ensure_ascii=False, indent=2)
                logger.info(f"Assigned {sum(1 for _ in memories)} legacy memories in memory.json to '{admin_user}'")
    except Exception as e:
        logger.warning(f"memory.json legacy migration failed: {e}")

    # Also migrate user_prefs.json to per-user format
    prefs_path = os.path.join("data", "user_prefs.json")
    try:
        if os.path.exists(prefs_path):
            with open(prefs_path, "r", encoding="utf-8") as f:
                prefs = _json.load(f)
            if "_users" not in prefs and prefs:
                # Flat format → nest under admin user
                new_prefs = {"_users": {admin_user: prefs}}
                with open(prefs_path, "w", encoding="utf-8") as f:
                    _json.dump(new_prefs, f, indent=2)
                logger.info(f"Migrated user_prefs.json to per-user format under '{admin_user}'")
    except Exception as e:
        logger.warning(f"user_prefs.json migration failed: {e}")


def _migrate_backfill_document_owner_from_session():
    """Backfill documents.owner from the owner of the linked chat session.

    Must run AFTER the owner column is added and BEFORE the blanket
    legacy-owner sweep, so session-linked docs get their *true* owner
    while only genuinely orphaned (sessionless) docs fall through to the
    admin assignment. Idempotent — only touches NULL-owner rows."""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(documents)"))]
            if "owner" not in cols:
                return
            res = conn.execute(text(
                "UPDATE documents SET owner = ("
                "  SELECT s.owner FROM sessions s WHERE s.id = documents.session_id"
                ") WHERE owner IS NULL AND session_id IS NOT NULL "
                "AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = documents.session_id "
                "            AND s.owner IS NOT NULL)"
            ))
            conn.commit()
            if res.rowcount:
                logging.getLogger(__name__).info(
                    f"Backfilled owner on {res.rowcount} session-linked documents")
    except Exception as e:
        logging.getLogger(__name__).warning(f"document owner backfill: {e}")


def _migrate_add_tidy_verdict():
    """Add tidy_verdict column to documents table if missing."""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(documents)"))]
            if "tidy_verdict" not in cols:
                conn.execute(text("ALTER TABLE documents ADD COLUMN tidy_verdict VARCHAR"))
                conn.commit()
                logging.getLogger(__name__).info("Added tidy_verdict column to documents")
    except Exception as e:
        logging.getLogger(__name__).warning(f"tidy_verdict migration: {e}")


def _migrate_add_doc_source_email_cols():
    """Add source-email provenance columns to documents (for the Sign-and-Reply flow)."""
    cols_to_add = {
        "source_email_uid":        "VARCHAR",
        "source_email_folder":     "VARCHAR",
        "source_email_account_id": "VARCHAR",
        "source_email_message_id": "VARCHAR",
    }
    try:
        with engine.connect() as conn:
            existing = {r[1] for r in conn.execute(text("PRAGMA table_info(documents)"))}
            for col, spec in cols_to_add.items():
                if col not in existing:
                    conn.execute(text(f"ALTER TABLE documents ADD COLUMN {col} {spec}"))
                    logging.getLogger(__name__).info(f"Added {col} column to documents")
            # Index for lookup-by-message-id (the "find existing draft" path)
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_documents_source_email_message_id "
                "ON documents (source_email_message_id)"
            ))
            conn.commit()
    except Exception as e:
        logging.getLogger(__name__).warning(f"doc source-email migration: {e}")

def _migrate_add_task_automation_columns():
    """Add automation columns to scheduled_tasks table if missing."""
    new_cols = {
        "task_type": "VARCHAR DEFAULT 'llm'",
        "action": "VARCHAR",
        "trigger_type": "VARCHAR DEFAULT 'schedule'",
        "trigger_event": "VARCHAR",
        "trigger_count": "INTEGER",
        "trigger_counter": "INTEGER DEFAULT 0",
    }
    try:
        with engine.connect() as conn:
            cols_info = list(conn.execute(text("PRAGMA table_info(scheduled_tasks)")))
            col_names = [r[1] for r in cols_info]
            for col_name, col_def in new_cols.items():
                if col_name not in col_names:
                    conn.execute(text(f"ALTER TABLE scheduled_tasks ADD COLUMN {col_name} {col_def}"))

            # Check if prompt/schedule/scheduled_time are still NOT NULL — need table rebuild
            notnull_map = {r[1]: r[3] for r in cols_info}
            needs_rebuild = (
                notnull_map.get("prompt", 0) == 1 or
                notnull_map.get("schedule", 0) == 1 or
                notnull_map.get("scheduled_time", 0) == 1
            )
            if needs_rebuild:
                logging.getLogger(__name__).info("Rebuilding scheduled_tasks to make prompt/schedule/scheduled_time nullable")
                conn.execute(text("ALTER TABLE scheduled_tasks RENAME TO _old_scheduled_tasks"))
                conn.execute(text("""
                    CREATE TABLE scheduled_tasks (
                        id VARCHAR PRIMARY KEY,
                        owner VARCHAR,
                        name VARCHAR NOT NULL,
                        prompt TEXT,
                        schedule VARCHAR,
                        scheduled_time VARCHAR,
                        scheduled_day INTEGER,
                        scheduled_date DATETIME,
                        next_run DATETIME,
                        last_run DATETIME,
                        status VARCHAR,
                        output_target VARCHAR,
                        session_id VARCHAR,
                        model VARCHAR,
                        endpoint_url VARCHAR,
                        run_count INTEGER,
                        created_at DATETIME NOT NULL,
                        updated_at DATETIME NOT NULL,
                        task_type VARCHAR DEFAULT 'llm',
                        action VARCHAR,
                        trigger_type VARCHAR DEFAULT 'schedule',
                        trigger_event VARCHAR,
                        trigger_count INTEGER,
                        trigger_counter INTEGER DEFAULT 0
                    )
                """))
                conn.execute(text("""
                    INSERT INTO scheduled_tasks
                    SELECT id, owner, name, prompt, schedule, scheduled_time,
                           scheduled_day, scheduled_date, next_run, last_run,
                           status, output_target, session_id, model, endpoint_url,
                           run_count, created_at, updated_at,
                           task_type, action, trigger_type, trigger_event,
                           trigger_count, trigger_counter
                    FROM _old_scheduled_tasks
                """))
                conn.execute(text("DROP TABLE _old_scheduled_tasks"))

            conn.commit()
            logging.getLogger(__name__).info("Task automation columns migration complete")
    except Exception as e:
        logging.getLogger(__name__).warning(f"task automation migration: {e}")

def _migrate_add_oauth_config():
    """Add oauth_config column to mcp_servers table if missing."""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(mcp_servers)"))]
            if "oauth_config" not in cols:
                conn.execute(text("ALTER TABLE mcp_servers ADD COLUMN oauth_config TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added oauth_config column to mcp_servers")
    except Exception as e:
        logging.getLogger(__name__).warning(f"oauth_config migration: {e}")

def _migrate_add_disabled_tools():
    """Add disabled_tools column to mcp_servers table if missing."""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(mcp_servers)"))]
            if "disabled_tools" not in cols:
                conn.execute(text("ALTER TABLE mcp_servers ADD COLUMN disabled_tools TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added disabled_tools column to mcp_servers")
    except Exception as e:
        logging.getLogger(__name__).warning(f"disabled_tools migration: {e}")

def _migrate_add_mcp_oauth_tokens_column():
    """Add oauth_tokens column to mcp_servers table if missing.

    The model declares this column as EncryptedText, but the SQL type is plain
    TEXT on purpose: EncryptedText is a SQLAlchemy TypeDecorator that encrypts at
    the Python layer and stores the ciphertext as TEXT, so the DB column type is
    TEXT. This matches the existing encrypted columns (see _migrate_encrypt_*)."""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(mcp_servers)"))]
            if "oauth_tokens" not in cols:
                conn.execute(text("ALTER TABLE mcp_servers ADD COLUMN oauth_tokens TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added oauth_tokens column to mcp_servers")
    except Exception as e:
        logging.getLogger(__name__).warning(f"oauth_tokens migration: {e}")

def _migrate_add_task_v2_columns():
    """Add cron_expression, then_task_id, webhook_token to scheduled_tasks."""
    new_cols = {
        "cron_expression": "VARCHAR",
        "then_task_id": "VARCHAR",
        "webhook_token": "VARCHAR",
    }
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(scheduled_tasks)"))]
            for col_name, col_def in new_cols.items():
                if col_name not in cols:
                    conn.execute(text(f"ALTER TABLE scheduled_tasks ADD COLUMN {col_name} {col_def}"))
            if "webhook_token" not in cols:
                conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_scheduled_tasks_webhook ON scheduled_tasks(webhook_token)"))
            conn.commit()
            logging.getLogger(__name__).info("Task v2 columns migration complete")
    except Exception as e:
        logging.getLogger(__name__).warning(f"task v2 migration: {e}")

def _migrate_drop_ping_notes_tasks():
    """One-time cleanup: ping_notes and ping_events used to be seeded as
    user-facing tasks. They're now pure background scanners inside the
    scheduler (no LLM, don't belong in the Tasks UI). Remove existing rows
    + their runs for both. (tidy_sessions/documents/research stay as tasks.)"""
    targets = ("ping_notes", "ping_events")
    try:
        with engine.connect() as conn:
            for action in targets:
                conn.execute(text(
                    "DELETE FROM task_runs WHERE task_id IN "
                    "(SELECT id FROM scheduled_tasks WHERE action=:a)"
                ), {"a": action})
                r = conn.execute(text("DELETE FROM scheduled_tasks WHERE action=:a"), {"a": action})
                if r.rowcount:
                    logging.getLogger(__name__).info(f"Dropped {r.rowcount} {action} task row(s)")
            conn.commit()
    except Exception as e:
        logging.getLogger(__name__).debug(f"drop_ping_notes_tasks: {e}")


def _migrate_add_notifications_enabled():
    """Per-task notification on/off toggle (default ON)."""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(scheduled_tasks)"))]
            if "notifications_enabled" not in cols:
                conn.execute(text("ALTER TABLE scheduled_tasks ADD COLUMN notifications_enabled BOOLEAN DEFAULT 1"))
                conn.commit()
                logging.getLogger(__name__).info("Added notifications_enabled column to scheduled_tasks")
    except Exception as e:
        logging.getLogger(__name__).warning(f"notifications_enabled migration: {e}")


def _migrate_add_crew_member_id():
    """Add crew_member_id column to sessions and scheduled_tasks tables if missing."""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(sessions)"))]
            if "crew_member_id" not in cols:
                conn.execute(text("ALTER TABLE sessions ADD COLUMN crew_member_id TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added crew_member_id column to sessions")
            cols2 = [r[1] for r in conn.execute(text("PRAGMA table_info(scheduled_tasks)"))]
            if "crew_member_id" not in cols2:
                conn.execute(text("ALTER TABLE scheduled_tasks ADD COLUMN crew_member_id TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added crew_member_id column to scheduled_tasks")
    except Exception as e:
        logging.getLogger(__name__).warning(f"crew_member_id migration: {e}")

def _migrate_add_assistant_columns():
    """Add is_default_assistant + timezone columns to crew_members for the personal-assistant feature."""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(crew_members)"))]
            if "is_default_assistant" not in cols:
                conn.execute(text("ALTER TABLE crew_members ADD COLUMN is_default_assistant BOOLEAN DEFAULT 0"))
                conn.commit()
                logging.getLogger(__name__).info("Added is_default_assistant column to crew_members")
            if "timezone" not in cols:
                conn.execute(text("ALTER TABLE crew_members ADD COLUMN timezone TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added timezone column to crew_members")
    except Exception as e:
        logging.getLogger(__name__).warning(f"assistant columns migration: {e}")





class Note(TimestampMixin, Base):
    """A Google Keep-style note or checklist."""
    __tablename__ = "notes"

    id         = Column(String, primary_key=True, index=True)
    owner      = Column(String, nullable=True, index=True)
    title      = Column(String, default="")
    content    = Column(Text, nullable=True)
    items      = Column(Text, nullable=True)       # JSON string of [{text, done}]
    note_type  = Column(String, default="note")     # "note" or "checklist"
    color      = Column(String, nullable=True)
    label      = Column(String, nullable=True)
    pinned     = Column(TolerantBoolean, default=False)
    archived   = Column(TolerantBoolean, default=False)
    due_date   = Column(String, nullable=True)
    source     = Column(String, default="user")     # "user" or "agent"
    session_id = Column(String, nullable=True)
    sort_order = Column(Integer, default=0)
    image_url  = Column(String, nullable=True)      # uploaded image URL (relative path)
    repeat     = Column(String, default="none")     # none, daily, weekly, monthly, yearly
    # Auto-AI fields — populated by /api/notes/{id}/classify. The classification
    # JSON shape is { kind, solvable, confidence, task_prompt, tools, items?: [...] }.
    # Content hash gates re-classification (avoid LLM spend on every save).
    ai_classification = Column(Text, nullable=True)
    ai_content_hash   = Column(String, nullable=True)
    # Chat session spawned by the note's "Agent" button (solve-this-todo).
    # The note shows a clickable tag that opens this session for review.
    agent_session_id  = Column(String, nullable=True)


class CalendarCal(TimestampMixin, Base):
    """A calendar (e.g. 'Personal', 'TimeTree')."""
    __tablename__ = "calendars"

    id    = Column(String, primary_key=True, index=True)
    owner = Column(String, nullable=True, index=True)
    name  = Column(String, nullable=False)
    color = Column(String, default="#5b8abf")
    source = Column(String, default="local")  # "local" or "caldav"
    # UUID of the CalDAV account in user prefs that owns this calendar.
    # NULL for local calendars and for CalDAV calendars created before
    # multi-account support was added (treated as "use any configured account").
    account_id = Column(String, nullable=True, index=True)

    events = relationship("CalendarEvent", back_populates="calendar", cascade="all, delete-orphan")


class CalendarEvent(TimestampMixin, Base):
    """A calendar event."""
    __tablename__ = "calendar_events"

    uid         = Column(String, primary_key=True, index=True)
    calendar_id = Column(String, ForeignKey("calendars.id"), nullable=False, index=True)
    summary     = Column(String, nullable=False, default="")
    description = Column(Text, default="")
    location    = Column(String, default="")
    dtstart     = Column(DateTime, nullable=False, index=True)
    dtend       = Column(DateTime, nullable=False)
    all_day     = Column(TolerantBoolean, default=False)
    # True when dtstart/dtend are stored as UTC instants (set on import paths
    # that preserve the source TZID). False = legacy naive-local. Drives the
    # `Z`-suffix on serialization so the frontend interprets correctly.
    is_utc      = Column(TolerantBoolean, default=False, nullable=False)
    rrule       = Column(String, default="")
    color       = Column(String, nullable=True)  # per-event color override
    status      = Column(String, default="confirmed")  # confirmed, cancelled
    importance  = Column(String, default="normal")    # low | normal | high | critical
    event_type  = Column(String, nullable=True)        # work | personal | health | travel | meal | social | admin | other
    last_pinged = Column(DateTime, nullable=True)      # last time the assistant pinged about this event
    # "caldav" = pulled from a CalDAV server (so the sync may prune it when it
    # vanishes upstream). NULL/local = created locally (agent, email triage, or
    # a UI event whose write-back failed) and must NOT be pruned by the sync.
    origin      = Column(String, nullable=True, index=True)

    calendar = relationship("CalendarCal", back_populates="events")


class Integration(TimestampMixin, Base):
    """An external service connection (email, RSS, webhook, etc.)."""
    __tablename__ = "integrations"

    id     = Column(String, primary_key=True, index=True)
    owner  = Column(String, nullable=True, index=True)
    name   = Column(String, nullable=False)
    type   = Column(String, nullable=False)  # "email", "rss", "webhook"
    config = Column(JSON, nullable=True)     # type-specific config
    enabled = Column(TolerantBoolean, default=True)





def _migrate_seed_email_account():
    """If email_accounts is empty and settings.json has legacy flat imap_host/smtp_host
    keys, create a single default account from them so nothing breaks for users who
    upgraded. Safe to run repeatedly — it short-circuits once any row exists."""
    try:
        with engine.connect() as conn:
            tables = [r[0] for r in conn.execute(text(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='email_accounts'"
            ))]
            if "email_accounts" not in tables:
                return
            existing = conn.execute(text("SELECT COUNT(*) FROM email_accounts")).scalar() or 0
            if existing > 0:
                return

        import json as _json
        import uuid as _uuid
        from pathlib import Path
        settings_file = Path("data/settings.json")
        if not settings_file.exists():
            return
        try:
            s = _json.loads(settings_file.read_text(encoding="utf-8"))
        except Exception:
            return

        imap_host = (s.get("imap_host") or "").strip()
        smtp_host = (s.get("smtp_host") or "").strip()
        if not imap_host and not smtp_host:
            return  # nothing to migrate

        now = utcnow_naive()
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO email_accounts
                  (id, owner, name, is_default, enabled,
                   imap_host, imap_port, imap_user, imap_password, imap_starttls,
                   smtp_host, smtp_port, smtp_user, smtp_password,
                   from_address, created_at, updated_at)
                VALUES
                  (:id, :owner, :name, :is_default, :enabled,
                   :imap_host, :imap_port, :imap_user, :imap_password, :imap_starttls,
                   :smtp_host, :smtp_port, :smtp_user, :smtp_password,
                   :from_address, :created_at, :updated_at)
            """), {
                "id": _uuid.uuid4().hex,
                "owner": None,
                "name": "Default",
                "is_default": True,
                "enabled": True,
                "imap_host": imap_host,
                "imap_port": int(s.get("imap_port") or 993),
                "imap_user": s.get("imap_user") or "",
                "imap_password": s.get("imap_password") or "",
                "imap_starttls": bool(s.get("imap_starttls", True)),
                "smtp_host": smtp_host,
                "smtp_port": int(s.get("smtp_port") or 465),
                "smtp_user": s.get("smtp_user") or "",
                "smtp_password": s.get("smtp_password") or "",
                "from_address": s.get("email_from") or "",
                "created_at": now,
                "updated_at": now,
            })
            logging.getLogger(__name__).info("Seeded email_accounts 'Default' from settings.json")
    except Exception as e:
        logging.getLogger(__name__).warning(f"seed email account migration: {e}")


# ── Boot resilience (P1) ──────────────────────────────────────────────────────
# A root-run reset can leave data/app.db root-owned / unreadable, the file can be
# truncated/corrupt, or the data dir can be missing/inaccessible. init_db() runs at
# IMPORT time (the bottom of this module), which app.py imports — so an UNCAUGHT
# failure here used to abort the whole process, and /admin/status (the operator's
# recovery surface) could not even be reached. The owner's ruling: "the status page
# needs to be hardened. it should never refuse to connect." So init_db() now NEVER
# raises: it records the failure in DB_INIT_ERROR and lets the app boot DEGRADED so
# the status page + its recovery actions (Update / Reset / Update+Reset) stay
# reachable and the operator can always act. A still-broken DB makes individual
# DB-touching routes fail per-call (best-effort, as they already guard), not the
# whole server.
DB_INIT_ERROR: dict | None = None


def db_init_error() -> dict | None:
    """The recorded init_db() failure, or None when the DB initialized cleanly.

    Read by the admin health/debug surfaces so a degraded boot is VISIBLE to the
    operator (a clear diagnostic) instead of silently swallowed."""
    return DB_INIT_ERROR


# WARNING: Foreign-key enforcement is enabled globally for all SQLite connections.
# Any future migrations or schema changes that temporarily violate foreign-key
# constraints will fail. To perform such operations, foreign_keys must be
# temporarily disabled around the migration workflow.
def _init_db_inner():
    """The real schema-create + migration sequence. May raise — the public
    ``init_db()`` wrapper catches it so an import-time failure can never crash boot."""
    _migrate_model_endpoints()
    Base.metadata.create_all(bind=engine)
    _migrate_add_hidden_models_column()
    _migrate_add_cached_models_column()
    _migrate_add_pinned_models_column()
    _migrate_add_notes_sort_order()
    _migrate_add_model_type_column()
    _migrate_add_model_endpoint_refresh_columns()
    _migrate_add_model_endpoint_owner_column()
    _migrate_add_supports_tools_column()
    _migrate_add_task_run_model_column()
    _migrate_add_owner_column()
    _migrate_add_document_archived_column()
    _migrate_add_last_message_at_column()
    _migrate_add_chat_message_seq_column()  # ADR 0008: authoritative per-session chat order
    _migrate_add_chat_message_client_msg_id_column()  # #1785: idempotent replay dedup column
    _migrate_add_folder_column()
    _migrate_add_token_columns()
    _migrate_add_mode_column()
    _migrate_add_multiuser_owner_columns()
    _migrate_add_api_token_scopes_column()
    _migrate_backfill_document_owner_from_session()
    _migrate_assign_legacy_owner()
    _migrate_add_tidy_verdict()
    _migrate_add_doc_source_email_cols()
    _migrate_add_oauth_config()
    _migrate_add_task_automation_columns()
    _migrate_add_disabled_tools()
    _migrate_add_mcp_oauth_tokens_column()
    _migrate_add_task_v2_columns()
    _migrate_add_notifications_enabled()
    _migrate_drop_ping_notes_tasks()
    _migrate_add_crew_member_id()
    _migrate_add_assistant_columns()
    _migrate_add_email_smtp_security()
    _migrate_seed_email_account()
    _migrate_add_calendar_metadata()
    _migrate_add_calendar_is_utc()
    _migrate_add_calendar_origin()
    _migrate_add_calendar_account_id()
    _migrate_chat_messages_fts()
    _migrate_encrypt_email_passwords()
    _migrate_encrypt_signatures()
    _migrate_encrypt_endpoint_keys()
    _migrate_backfill_task_folders()
    _migrate_strip_session_auth_headers()


def init_db():
    """Initialize the database — create tables + run migrations — but NEVER raise.

    P1 boot resilience: this is called at import time (bottom of the module), so an
    uncaught failure (root-owned/corrupt/unreadable app.db, a missing data dir, a
    failed migration) would abort the whole front-end process and make /admin/status
    unreachable exactly when the operator needs it to recover. Instead we degrade:
    record the failure in DB_INIT_ERROR (visible to the admin health surfaces) and
    let the app boot. Individual DB-touching routes already guard their own queries,
    so a still-broken store fails per-call, not process-wide.

    Best-effort self-heal first: ensure the data directory exists, so the single most
    common breakage (the dir was wiped by a reset and never recreated) is fixed before
    create_all even runs."""
    global DB_INIT_ERROR
    # Best-effort: make sure the SQLite parent dir exists before create_all tries to
    # open the file. A missing dir is the cheapest, most common failure to self-heal.
    try:
        if DATABASE_URL.startswith("sqlite"):
            db_path = DATABASE_URL.replace("sqlite:///", "")
            if db_path and db_path != ":memory:":
                parent = os.path.dirname(os.path.abspath(db_path))
                if parent:
                    os.makedirs(parent, exist_ok=True)
    except Exception:
        pass
    try:
        _init_db_inner()
        DB_INIT_ERROR = None
    except BaseException as e:
        # Record a clear, secret-free diagnostic and keep serving. We intentionally
        # catch BaseException so even an odd low-level error (e.g. a permission/OS
        # error surfacing oddly) can't take the process down at import time. The DB URL
        # is scrubbed of any embedded credentials (postgres://user:pass@host) before it
        # is recorded — the admin health surfaces read this dict.
        import re as _re
        safe_url = _re.sub(r"//[^/@\s]+:[^/@\s]+@", "//***@", DATABASE_URL)
        DB_INIT_ERROR = {
            "error": f"{type(e).__name__}: {e}",
            "databaseUrl": safe_url,
            "at": utcnow_naive().isoformat(),
        }
        try:
            logging.getLogger(__name__).error(
                "DATABASE INIT FAILED — booting DEGRADED so /admin/status stays reachable. "
                "Recover via the status page (Reset / Update). Cause: %s: %s",
                type(e).__name__, e,
            )
        except Exception:
            pass


def _migrate_strip_session_auth_headers():
    """ORW-199/200: provider credentials were persisted on session rows. The endpoint record is
    now the source of truth (resolved at call time), so strip Authorization / x-api-key from
    existing session rows whose URL resolves to a keyed endpoint. Idempotent; rows with no
    resolvable endpoint are never touched. Fail-soft."""
    try:
        from src.endpoint_resolver import migrate_strip_session_auth_headers
        n = migrate_strip_session_auth_headers()
        if n:
            logging.getLogger(__name__).info(
                "Migrated: stripped stored auth headers from %d session row(s)", n)
    except Exception as e:
        logging.getLogger(__name__).warning(f"session auth-header strip migration failed: {e}")


def _migrate_backfill_task_folders():
    """Backfill folder='Tasks' on pre-existing task/research sessions.

    Sessions created by the task scheduler (LLM tasks, action tasks, research
    runs) now set folder='Tasks' at creation time.  This migration tags any
    older sessions that predate that assignment.  Idempotent — only touches
    rows where folder is NULL or empty and the title matches known prefixes.
    """
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(sessions)"))]
            if "folder" not in cols:
                return
            res = conn.execute(text(
                "UPDATE sessions SET folder = 'Tasks' "
                "WHERE (folder IS NULL OR folder = '') "
                "AND (name LIKE '[Task] %' OR name LIKE '[Research] %')"
            ))
            conn.commit()
            if res.rowcount:
                logging.getLogger(__name__).info(
                    f"Backfilled folder='Tasks' on {res.rowcount} task/research sessions")
    except Exception as e:
        logging.getLogger(__name__).warning(f"task folder backfill: {e}")


def _migrate_chat_messages_fts():
    """Create and backfill the session transcript FTS index for SQLite."""
    if not DATABASE_URL.startswith("sqlite"):
        return

    db_path = DATABASE_URL.replace("sqlite:///", "")
    if db_path == ":memory:":
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        try:
            conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS temp._orwell_fts5_probe USING fts5(content)")
            conn.execute("DROP TABLE IF EXISTS temp._orwell_fts5_probe")
        except Exception as e:
            logging.getLogger(__name__).warning(f"chat_messages FTS migration skipped; FTS5 unavailable: {e}")
            return

        conn.executescript(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
                content,
                message_id UNINDEXED,
                session_id UNINDEXED,
                role UNINDEXED
            );

            CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai
            AFTER INSERT ON chat_messages BEGIN
                INSERT INTO chat_messages_fts(content, message_id, session_id, role)
                VALUES (COALESCE(new.content, ''), new.id, new.session_id, new.role);
            END;

            CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad
            AFTER DELETE ON chat_messages BEGIN
                DELETE FROM chat_messages_fts WHERE message_id = old.id;
            END;

            -- ORW-174: the delete below scans the whole index (message_id is UNINDEXED), and this trigger used to fire for EVERY update of a message row (mark_message_phase touches one each game turn). It now
            -- fires only when an indexed value actually changed. Dropped first so an existing database picks up the narrower definition (IF NOT EXISTS would keep the old one).
            DROP TRIGGER IF EXISTS chat_messages_fts_au;
            CREATE TRIGGER chat_messages_fts_au
            AFTER UPDATE OF content, session_id, role ON chat_messages
            WHEN old.content IS NOT new.content OR old.session_id IS NOT new.session_id OR old.role IS NOT new.role
            BEGIN
                DELETE FROM chat_messages_fts WHERE message_id = old.id;
                INSERT INTO chat_messages_fts(content, message_id, session_id, role)
                VALUES (COALESCE(new.content, ''), new.id, new.session_id, new.role);
            END;
            """
        )
        # ORW-170: the backfill below probes the FTS table once PER MESSAGE with message_id UNINDEXED (a full index scan each), i.e. O(messages x index rows) on EVERY boot. The triggers keep the two in
        # step, so in the normal case the row counts already match and there is nothing to backfill: compare the counts (one scan each) and only run the backfill when the index is short.
        n_msgs = conn.execute("SELECT count(*) FROM chat_messages").fetchone()[0]
        n_fts = conn.execute("SELECT count(*) FROM chat_messages_fts").fetchone()[0]
        if n_fts < n_msgs:
            conn.execute(
                """
                INSERT INTO chat_messages_fts(content, message_id, session_id, role)
                SELECT COALESCE(cm.content, ''), cm.id, cm.session_id, cm.role
                FROM chat_messages cm
                WHERE NOT EXISTS (
                    SELECT 1 FROM chat_messages_fts fts
                    WHERE fts.message_id = cm.id
                )
                """
            )
        conn.commit()
    except Exception as e:
        logging.getLogger(__name__).warning(f"chat_messages FTS migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _migrate_add_email_smtp_security():
    """Add explicit SMTP security mode for Proton Bridge/custom local SMTP."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(email_accounts)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "smtp_security" not in columns:
            conn.execute("ALTER TABLE email_accounts ADD COLUMN smtp_security TEXT DEFAULT 'ssl'")
            conn.execute(
                "UPDATE email_accounts SET smtp_security = CASE "
                "WHEN COALESCE(smtp_port, 465) = 587 THEN 'starttls' "
                "WHEN COALESCE(smtp_port, 465) = 465 THEN 'ssl' "
                "ELSE 'ssl' END "
                "WHERE smtp_security IS NULL OR smtp_security = ''"
            )
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added smtp_security column to email_accounts")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"smtp_security migration skipped: {e}")


def _migrate_encrypt_endpoint_keys():
    """Encrypt any plaintext provider API keys in model_endpoints. Idempotent;
    raw SQL so the EncryptedText decorator isn't applied twice."""
    try:
        from src.secret_storage import encrypt, is_encrypted
    except Exception as e:
        logger.warning(f"secret_storage import failed; skipping endpoint-key migration: {e}")
        return
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("SELECT id, api_key FROM model_endpoints")).fetchall()
            migrated = 0
            for rid, key in rows:
                if key and not is_encrypted(key):
                    conn.execute(text("UPDATE model_endpoints SET api_key = :k WHERE id = :id"),
                                 {"k": encrypt(key), "id": rid})
                    migrated += 1
            if migrated:
                conn.commit()
                logger.info(f"Encrypted plaintext API key on {migrated} endpoint row(s)")
    except Exception as e:
        logger.warning(f"Endpoint-key encryption migration skipped: {e}")


def _migrate_encrypt_signatures():
    """Encrypt any plaintext signature images still in the signatures table.
    Idempotent — rows already prefixed with `enc:` are skipped. Uses raw SQL
    so the EncryptedText type decorator isn't applied twice."""
    try:
        from src.secret_storage import encrypt, is_encrypted
    except Exception as e:
        logger.warning(f"secret_storage import failed; skipping signature migration: {e}")
        return
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT id, data_png, svg FROM signatures"
            )).fetchall()
            migrated = 0
            for rid, data_png, svg in rows:
                updates = {}
                if data_png and not is_encrypted(data_png):
                    updates["data_png"] = encrypt(data_png)
                if svg and not is_encrypted(svg):
                    updates["svg"] = encrypt(svg)
                if updates:
                    sets = ", ".join(f"{k} = :{k}" for k in updates)
                    conn.execute(text(f"UPDATE signatures SET {sets} WHERE id = :id"), {**updates, "id": rid})
                    migrated += 1
            if migrated:
                conn.commit()
                logger.info(f"Encrypted plaintext signature(s) on {migrated} row(s)")
    except Exception as e:
        logger.warning(f"Signature encryption migration skipped: {e}")


def _migrate_encrypt_email_passwords():
    """Encrypt any plaintext IMAP/SMTP passwords still in the email_accounts
    table. Idempotent — rows already prefixed with `enc:` are skipped.
    Safe to run on every startup."""
    try:
        from src.secret_storage import encrypt, is_encrypted
    except Exception as e:
        logger.warning(f"secret_storage import failed; skipping password migration: {e}")
        return
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT id, imap_password, smtp_password FROM email_accounts"
            )).fetchall()
            migrated = 0
            for row in rows:
                rid, imap_pw, smtp_pw = row
                updates = {}
                if imap_pw and not is_encrypted(imap_pw):
                    updates["imap_password"] = encrypt(imap_pw)
                if smtp_pw and not is_encrypted(smtp_pw):
                    updates["smtp_password"] = encrypt(smtp_pw)
                if updates:
                    sets = ", ".join(f"{k} = :{k}" for k in updates)
                    params = {**updates, "id": rid}
                    conn.execute(text(f"UPDATE email_accounts SET {sets} WHERE id = :id"), params)
                    migrated += 1
            if migrated:
                conn.commit()
                logger.info(f"Encrypted plaintext passwords on {migrated} email account row(s)")
    except Exception as e:
        logger.warning(f"Password migration failed (will retry next start): {e}")


def _migrate_add_calendar_is_utc():
    """Add is_utc column to calendar_events so imported events can preserve
    their original UTC timestamps (Z-suffix on the wire) without touching
    legacy naive-local rows."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(calendar_events)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "is_utc" not in columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN is_utc BOOLEAN DEFAULT 0 NOT NULL")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'is_utc' column to calendar_events")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"is_utc migration failed: {e}")


def _migrate_add_calendar_origin():
    """Add `origin` to calendar_events so the CalDAV sync can tell server-pulled
    rows (prunable when they vanish upstream) from locally-created ones (agent /
    email triage / failed write-back), which must never be pruned. Idempotent."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(calendar_events)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "origin" not in columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN origin TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_calendar_events_origin ON calendar_events(origin)")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'origin' column to calendar_events")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"calendar_events.origin migration failed: {e}")


def _migrate_add_calendar_account_id():
    """Add `account_id` to calendars so each CalDAV-backed calendar knows which
    credential set (from caldav_accounts in user prefs) owns it. Idempotent."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(calendars)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "account_id" not in columns:
            conn.execute("ALTER TABLE calendars ADD COLUMN account_id TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_calendars_account_id ON calendars(account_id)")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'account_id' column to calendars")
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"calendars.account_id migration failed: {e}")


def _migrate_add_calendar_metadata():
    """Add importance/event_type/last_pinged columns to calendar_events table."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(calendar_events)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "importance" not in columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN importance TEXT DEFAULT 'normal'")
        if columns and "event_type" not in columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN event_type TEXT")
        if columns and "last_pinged" not in columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN last_pinged DATETIME")
        conn.commit()
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"calendar_events migration failed: {e}")

def get_db():
    """
    Dependency to get a database session.
    Used in FastAPI routes to inject database sessions.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

from contextlib import contextmanager
from typing import Generator

@contextmanager
def get_db_session() -> Generator:
    """Context manager for database sessions"""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

def bulk_insert_messages(session_id: str, messages: list):
    """Efficiently insert multiple messages"""
    with get_db_session() as db:
        db.bulk_insert_mappings(
            ChatMessage,
            [
                {
                    'session_id': session_id,
                    'role': msg['role'],
                    'content': msg['content'],
                    'timestamp': utcnow_naive()
                }
                for msg in messages
            ]
        )

def cleanup_old_sessions(days: int = 30):
    """Remove sessions older than specified days"""
    from datetime import timedelta
    
    with get_db_session() as db:
        cutoff_date = utcnow_naive() - timedelta(days=days)
        
        deleted_count = db.query(Session).filter(
            Session.archived == True,
            Session.last_accessed < cutoff_date,
            Session.is_important == False
        ).delete()
        
        return deleted_count

def get_session_stats():
    """Get database statistics"""
    with get_db_session() as db:
        stats = {
            'total_sessions': db.query(Session).count(),
            'active_sessions': db.query(Session).filter(Session.archived == False).count(),
            'archived_sessions': db.query(Session).filter(Session.archived == True).count(),
            'total_messages': db.query(ChatMessage).count(),
            'total_memories': db.query(Memory).count()
        }
        return stats

def get_detailed_stats():
    """Get comprehensive database statistics including file size"""
    stats = get_session_stats()  # Use existing function
    
    # Add database file size
    db_size_mb = 0.0
    if "sqlite" in DATABASE_URL:
        db_path = DATABASE_URL.replace("sqlite:///", "")
        if not os.path.isabs(db_path):
            db_path = os.path.abspath(db_path)
        
        if os.path.exists(db_path):
            db_size = os.path.getsize(db_path)
            db_size_mb = round(db_size / (1024 * 1024), 2)
    
    stats['database_size_mb'] = db_size_mb
    return stats

def update_session_last_accessed(session_id: str):
    """Update the last_accessed timestamp for a session"""
    with get_db_session() as db:
        db_session = db.query(Session).filter(Session.id == session_id).first()
        if db_session:
            db_session.last_accessed = utcnow_naive()
            db.commit()
            return True
    return False

def get_session_mode(session_id: str):
    """Return a session's persisted `mode`, or None if unset/unknown.

    Best-effort: never raises (returns None on any DB error) so callers on hot
    request paths needn't guard it. Routed through get_db_session() so the
    connection is always returned to the pool."""
    try:
        with get_db_session() as db:
            return db.query(Session.mode).filter(Session.id == session_id).scalar()
    except Exception:
        logger.warning("Failed to read mode for session %s", session_id)
        return None

def set_session_mode(session_id: str, mode: str) -> bool:
    """Persist a session's `mode`. Best-effort: never raises, returns success.

    Routed through get_db_session() so a failure mid-write (e.g. a SQLite
    'database is locked' under concurrent streams) still returns the connection
    to the pool instead of leaking it — repeated leaks would exhaust it."""
    try:
        with get_db_session() as db:
            db.query(Session).filter(Session.id == session_id).update({"mode": mode})
        return True
    except Exception:
        logger.warning("Failed to persist mode %r for session %s", mode, session_id)
        return False

def get_session_by_id(session_id: str):
    """Get a session by ID"""
    with get_db_session() as db:
        return db.query(Session).filter(Session.id == session_id).first()

def get_upcoming_events(owner, horizon_days: int = 60, limit: int = 40):
    """Upcoming, non-cancelled events as {uid, title, start} dicts, soonest first.

    owner=None means NO owner scoping (single-user / legacy). Multi-user callers
    MUST pass the owning username — otherwise they read every tenant's events.
    The autonomous email->calendar pass relies on this to avoid disclosing (and
    acting on) other users' calendars."""
    from datetime import timedelta
    now = utcnow_naive()
    with get_db_session() as db:
        q = db.query(CalendarEvent).join(CalendarCal).filter(
            CalendarEvent.dtstart >= now,
            CalendarEvent.dtstart <= now + timedelta(days=horizon_days),
            CalendarEvent.status != "cancelled",
        )
        if owner is not None:
            q = q.filter(CalendarCal.owner == owner)
        return [
            {
                "uid": e.uid,
                "title": e.summary or "",
                "start": e.dtstart.isoformat() if e.dtstart else "",
            }
            for e in q.order_by(CalendarEvent.dtstart).limit(limit).all()
        ]

def archive_session(session_id: str):
    """Archive a session"""
    with get_db_session() as db:
        session = db.query(Session).filter(Session.id == session_id).first()
        if session:
            session.archived = True
            db.commit()
            return True
    return False

# Initialize the database by creating all tables


init_db()
