# core/session_manager.py
"""
Session management — all session business logic and DB operations.

This is the single place that handles:
- Loading/saving sessions to database
- Adding messages to sessions
- Session lifecycle (create, archive, delete)
"""

import json
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import Dict, Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from .database import Session as DbSession, ChatMessage as DbChatMessage, Document as DbDocument, SessionLocal, utcnow_naive
from .models import Session, ChatMessage

logger = logging.getLogger(__name__)


def _message_timestamp_iso(value: Optional[datetime]) -> Optional[str]:
    """Return a stable ISO timestamp for chat message metadata."""
    if not value:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def _parse_msg_content(raw):
    """Parse message content from DB — deserialises JSON arrays back to lists
    (multimodal content with image/audio attachments)."""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw.startswith('[{') and '"type"' in raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list) and all(isinstance(p, dict) for p in parsed):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass
    return raw


class SessionManager:
    """
    Manages chat sessions with database persistence.

    Usage:
        manager = SessionManager()
        session = manager.create_session(id, name, url, model)
        manager.add_message(session.id, ChatMessage("user", "hello"))
        session = manager.get_session(session_id)
    """

    def __init__(self, sessions_file: str = None):
        # sessions_file kept for backward compat, not used
        self.sessions: Dict[str, Session] = {}
        # F4 (lost-append race): a per-session async lock. The chat path's load→mutate→persist
        # section is NOT atomic — a concurrent send + a reconcile/poll both call get_session, which
        # can REPLACE self.sessions[session_id] with a freshly-hydrated object mid-request, orphaning
        # an in-flight history.append (the user bubble that "vanishes"). The async chat handler holds
        # `session_lock(id)` across that section so the two coroutines serialize, mirroring the
        # engine's per-user enqueue discipline. Keyed by session id; created lazily; never global.
        self._session_locks: Dict[str, "asyncio.Lock"] = {}
        self.load_sessions()

    def session_lock(self, session_id: str) -> "asyncio.Lock":
        """Return the per-session asyncio.Lock, creating it on first use.

        F4: serialize the chat path's load→mutate→persist critical section against concurrent
        get_session replaces / reconcile writes for the SAME session. Lazily created (idle sessions
        cost nothing); per-id so independent sessions never contend. Lock creation itself is a single
        sync dict op — safe under one event loop (no await before the dict write)."""
        import asyncio
        lock = self._session_locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._session_locks[session_id] = lock
        return lock

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------

    def load_sessions(self):
        """Load recent session METADATA from the database — messages are
        hydrated on demand by `get_session`. Previously this walked every
        message of every session into RAM at boot, which on a long-running
        personal-server box could be tens of thousands of rows held forever
        in `self.sessions`.
        """
        db = SessionLocal()
        try:
            db_sessions = db.query(DbSession).filter(
                DbSession.archived == False,
                DbSession.message_count > 0,
            ).order_by(DbSession.last_accessed.desc()).limit(100).all()

            loaded_count = 0
            for db_session in db_sessions:
                try:
                    session = self._db_to_session_meta(db_session)
                    if session is not None:
                        self.sessions[db_session.id] = session
                        loaded_count += 1
                except Exception as e:
                    logger.error(f"Error loading session {db_session.id}: {e}")
                    continue

            logger.info(f"Loaded {loaded_count} session(s) (metadata only)")

        except Exception as e:
            logger.error(f"Error loading sessions: {e}")
            self.sessions = {}
        finally:
            db.close()

    def _db_to_session_meta(self, db_session: DbSession) -> Optional[Session]:
        """Build a Session with empty history. `get_session` will hydrate
        messages from the DB on first read."""
        headers = db_session.headers
        if isinstance(headers, str):
            try:
                headers = json.loads(headers)
            except json.JSONDecodeError:
                headers = {}
        session = Session(
            id=db_session.id,
            name=db_session.name,
            endpoint_url=db_session.endpoint_url,
            model=db_session.model,
            rag=db_session.rag,
            archived=db_session.archived,
            headers=headers,
            history=[],
            owner=getattr(db_session, "owner", None),
            is_important=getattr(db_session, "is_important", False) or False,
        )
        session.message_count = getattr(db_session, "message_count", 0) or 0
        return session

    def _db_to_session(self, db_session: DbSession, db) -> Optional[Session]:
        """Convert a database session to a Session object."""
        history = []

        # Try relationship first, then direct query
        if db_session.messages:
            for db_msg in db_session.messages:
                meta = json.loads(db_msg.meta_data) if db_msg.meta_data else {}
                if meta is None: meta = {}
                meta['_db_id'] = db_msg.id
                if getattr(db_msg, 'seq', None) is not None: meta['_seq'] = db_msg.seq  # ORW-139: live-appended rows carry _seq; rehydrated rows must too or /api/history loses seq after a restart
                meta.setdefault('timestamp', _message_timestamp_iso(db_msg.timestamp))
                history.append(ChatMessage(
                    role=db_msg.role,
                    content=_parse_msg_content(db_msg.content),
                    metadata=meta,
                ))
        else:
            db_messages = db.query(DbChatMessage).filter(
                DbChatMessage.session_id == db_session.id
            ).order_by(DbChatMessage.seq).all()  # ADR 0008: authoritative order

            for db_msg in db_messages:
                meta = json.loads(db_msg.meta_data) if db_msg.meta_data else {}
                if meta is None: meta = {}
                meta['_db_id'] = db_msg.id
                if getattr(db_msg, 'seq', None) is not None: meta['_seq'] = db_msg.seq  # ORW-139: live-appended rows carry _seq; rehydrated rows must too or /api/history loses seq after a restart
                meta.setdefault('timestamp', _message_timestamp_iso(db_msg.timestamp))
                history.append(ChatMessage(
                    role=db_msg.role,
                    content=_parse_msg_content(db_msg.content),
                    metadata=meta,
                ))

        if not history:
            return None

        # Parse headers
        headers = db_session.headers
        if isinstance(headers, str):
            try:
                headers = json.loads(headers)
            except json.JSONDecodeError:
                headers = {}

        session = Session(
            id=db_session.id,
            name=db_session.name,
            endpoint_url=db_session.endpoint_url,
            model=db_session.model,
            rag=db_session.rag,
            archived=db_session.archived,
            headers=headers,
            history=history,
            owner=getattr(db_session, 'owner', None),
            is_important=getattr(db_session, 'is_important', False) or False,
        )

        session.message_count = getattr(db_session, 'message_count', len(history))
        return session

    # ------------------------------------------------------------------
    # Message operations
    # ------------------------------------------------------------------

    def add_message(self, session_id: str, message: ChatMessage):
        """
        Add a message to a session and persist to database.

        Args:
            session_id: Session ID
            message: ChatMessage to add
        """
        session = self.get_session(session_id)
        if session.find_user_by_client_msg_id(message) is not None:
            return  # a same-clientMsgId retry adopts the recorded line (see Session.add_message)
        session.history.append(message)
        session.message_count = len(session.history)

        # ADR 0012: the `message-added` completion broadcast now fires inside `_persist_message`
        # (the shared persist primitive), so EVERY persist path publishes exactly once — including
        # the streaming save path (ChatSession.add_message → _persist_message) that previously
        # bypassed this method's broadcast (the dead leg). Do not re-publish here.
        self._persist_message(session_id, message)

    def _recreate_db_session_row(self, db, session_id: str, cached: Session) -> DbSession:
        """Re-mint a missing `sessions` row from the cached in-memory `Session`, AND backfill
        any cached transcript that the row's removal cascade-deleted.

        Loss-prevention self-heal: a persist whose parent row was removed out-of-band (the
        empty-session reaper racing a fresh game session, a partial delete) must NOT drop the
        message. The cached `Session` is the source of truth for the row's non-message fields;
        rebuild the row from it so the message has a parent to land on.

        Crucially, deleting the parent `sessions` row cascade-deletes its `chat_messages`
        (FK ON DELETE + the ORM 'all, delete-orphan' relationship), so any ALREADY-persisted
        turns are gone from the DB too — they survive only in `cached.history`. Re-insert each
        cached message that is no longer in the DB, in order, BEFORE the caller appends the new
        one, so a reload shows the FULL transcript (non-degradation), not just the latest turn.

        Adds + flushes in the SAME transaction as the caller (which then commits it with the
        new chat_messages insert), so the row + restored transcript commit atomically. Headers
        are serialised the same way `create_session` stores them."""
        headers = getattr(cached, "headers", None) or {}
        try:
            # ORW-199/200: never persist a provider key an endpoint supplies at call time.
            from src.endpoint_resolver import persistable_session_headers
            headers = persistable_session_headers(
                getattr(cached, "endpoint_url", "") or "", headers, getattr(cached, "owner", None),
            ) or {}
        except Exception:
            pass
        db_session = DbSession(
            id=session_id,
            name=getattr(cached, "name", None) or "Recovered session",
            endpoint_url=getattr(cached, "endpoint_url", "") or "",
            model=getattr(cached, "model", "") or "",
            rag=bool(getattr(cached, "rag", False)),
            archived=bool(getattr(cached, "archived", False)),
            headers=headers,
            owner=getattr(cached, "owner", None),
            is_important=bool(getattr(cached, "is_important", False)),
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        db.add(db_session)
        db.flush()  # materialise the row so the message inserts below have a parent

        # Backfill cached transcript the cascade wiped. Best-effort, in scroll order. Each
        # message keeps its previously-assigned _db_id/_seq when present (so the in-memory
        # objects still match the DB ids after the heal); a missing id/seq is regenerated.
        restored = 0
        _seq_counter = 0
        for hist_msg in list(getattr(cached, "history", None) or []):
            try:
                meta = hist_msg.metadata or {}
                existing_id = meta.get("_db_id")
                # Skip any message already present in the DB (defensive — after a partial
                # delete some rows may survive). Match by id when we have one.
                if existing_id is not None:
                    already = (
                        db.query(func.count(DbChatMessage.id))
                        .filter(DbChatMessage.id == existing_id)
                        .scalar()
                    ) or 0
                    if already:
                        _seq_counter = max(_seq_counter, int(meta.get("_seq", _seq_counter)) + 1)
                        continue
                row_id = existing_id or str(uuid.uuid4())
                seq = meta.get("_seq")
                seq = int(seq) if seq is not None else _seq_counter
                _seq_counter = max(_seq_counter, seq + 1)
                _content = hist_msg.content
                if isinstance(_content, list):
                    _content = json.dumps(_content)
                _meta_json = json.dumps(meta) if meta else None
                db.add(DbChatMessage(
                    id=row_id,
                    session_id=session_id,
                    role=hist_msg.role,
                    content=_content,
                    meta_data=_meta_json,
                    timestamp=datetime.utcnow(),
                    seq=seq,
                ))
                # Keep the in-memory message pinned to the (re)assigned id/seq.
                if hist_msg.metadata is None:
                    hist_msg.metadata = {}
                hist_msg.metadata["_db_id"] = row_id
                hist_msg.metadata["_seq"] = seq
                restored += 1
            except Exception as _e:
                logger.error("Backfill of a cached message for %s skipped: %s", session_id, _e)
        if restored:
            db.flush()
            logger.error(
                "Backfilled %d cached transcript message(s) for %s after row recreation "
                "(cascade-deleted history restored — non-degradation held)",
                restored, session_id,
            )
        return db_session

    def _persist_message(self, session_id: str, message: ChatMessage):
        """Persist a single message to the database."""
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session is None:
                # The parent DbSession row is gone. Message loss is the highest-severity
                # class in this project, so DO NOT silently drop a real player message.
                #
                # Two distinct cases:
                #   (a) CONFIRMED DELETE — no cached in-memory Session either. `delete_session`
                #       pops `self.sessions[session_id]`, so a missing cache AND a missing row
                #       is a genuine tombstone; a late stream/tool callback firing after that
                #       has nothing legitimate to persist. Drop, but LOUDLY (error, with role +
                #       phase) so a real drop is never silent.
                #   (b) RACE / OUT-OF-BAND ROW REMOVAL — the cached `Session` still exists (it
                #       was never deleted through the sanctioned door; the row was removed
                #       out-of-band, e.g. the empty-session reaper racing a fresh game session,
                #       or a partial delete). Here the in-memory session is the source of truth,
                #       so LAZY-RECREATE the DbSession row from it and persist onto it. This
                #       converts the dominant loss path into self-heal.
                cached = self.sessions.get(session_id)
                _phase = None
                try:
                    _phase = (message.metadata or {}).get("phase") if message.metadata else None
                except Exception:
                    _phase = None
                if cached is None:
                    logger.error(
                        "Dropping message for deleted session %s (role=%s, phase=%s) — "
                        "no cached session: confirmed tombstone",
                        session_id, getattr(message, "role", "?"), _phase,
                    )
                    return
                # Self-heal: re-mint the parent row from the cached Session and fall through
                # to the normal persist below (which assigns seq, count, broadcasts).
                try:
                    db_session = self._recreate_db_session_row(db, session_id, cached)
                    logger.error(
                        "Recreated missing DbSession row for %s on persist (role=%s, phase=%s) — "
                        "self-healed an out-of-band row removal instead of dropping the message",
                        session_id, getattr(message, "role", "?"), _phase,
                    )
                except Exception as _recreate_err:
                    logger.error(
                        "Could NOT recreate missing DbSession row for %s; dropping message "
                        "(role=%s, phase=%s): %s",
                        session_id, getattr(message, "role", "?"), _phase, _recreate_err,
                    )
                    db.rollback()
                    return

            msg_id = str(uuid.uuid4())
            msg_time = datetime.utcnow()
            if message.metadata is None:
                message.metadata = {}
            message.metadata.setdefault('timestamp', _message_timestamp_iso(msg_time))
            # Multimodal content (image/audio attachments) is a list — serialize
            # to JSON so the Text column can store it.  On reload, _db_to_session
            # detects the JSON-array prefix and parses it back.
            _content = message.content
            if isinstance(_content, list):
                _content = json.dumps(_content)
            _meta_json = json.dumps(message.metadata) if message.metadata else None
            _now = datetime.now(timezone.utc)

            # ADR 0008: assign the monotonic per-session `seq` (the authoritative chat order).
            # MAX(seq)+1 under the SQLite write lock, with the UNIQUE(session_id, seq) index as the
            # backstop: if a concurrent writer grabbed the same number, the commit raises
            # IntegrityError and we recompute + retry. Bounded retries; never blocks a real persist.
            # A fresh DbChatMessage is built per attempt so a rolled-back row is never re-added.
            assigned_seq = None
            for _attempt in range(6):
                _max_seq = (
                    db.query(func.max(DbChatMessage.seq))
                    .filter(DbChatMessage.session_id == session_id)
                    .scalar()
                )
                next_seq = 0 if _max_seq is None else int(_max_seq) + 1
                # F1 (transcript-truncation fix): `message_count` MUST come from DB truth, never from
                # `len(in_memory_history)`. A session loaded metadata-only (history=[]) — or one whose
                # cache lost an append to a concurrent get_session replace — has an in-memory length that
                # DISAGREES with the persisted `chat_messages` rows; writing that short count here made
                # `load_sessions`' `message_count > 0` gate and the hydrate gate trust a TRUNCATED total
                # (issue #936). Count the rows already persisted for this session (in this same write txn)
                # and add 1 for the row about to commit. (== next_seq+1 for a dense seq, but COUNT(*)+1 is
                # correct even when a legacy log has a sparse seq.) Recomputed each attempt so a lost-seq
                # retry — which may see a newly-committed row from the winner — still writes the true total.
                _existing_rows = (
                    db.query(func.count(DbChatMessage.id))
                    .filter(DbChatMessage.session_id == session_id)
                    .scalar()
                ) or 0
                _mc = int(_existing_rows) + 1
                db_message = DbChatMessage(
                    id=msg_id,
                    session_id=session_id,
                    role=message.role,
                    content=_content,
                    meta_data=_meta_json,
                    timestamp=msg_time,
                    seq=next_seq,
                    client_msg_id=message.client_msg_id,  # #1785: write to the dedicated column
                )
                db.add(db_message)
                # Re-apply the parent-session bookkeeping each attempt (a rollback expires it).
                db_session.message_count = _mc
                db_session.last_accessed = _now
                # Clean "last conversation" timestamp — only bumped here on a real message persist,
                # so it powers an accurate "Last active" sort that ignores renames / model swaps / opens.
                db_session.last_message_at = _now
                try:
                    db.commit()
                    assigned_seq = next_seq
                    break
                except IntegrityError as _ie:
                    _err_msg = str(_ie)
                    # #1785: client_msg_id unique-constraint violation is a LEGITIMATE idempotent
                    # replay (a retried outbox item can race the DB) — adopt the existing row
                    # instead of retrying indefinitely.
                    if message.client_msg_id and 'ix_messages_session_client_msg_id' in _err_msg:
                        db.rollback()
                        _existing = (
                            db.query(DbChatMessage.id, DbChatMessage.seq)
                            .filter(
                                DbChatMessage.session_id == session_id,
                                DbChatMessage.client_msg_id == message.client_msg_id,
                            )
                            .first()
                        )
                        if _existing:
                            logger.info(
                                "Idempotent replay: client_msg_id=%s already exists in session %s — adopting existing row",
                                message.client_msg_id, session_id,
                            )
                            msg_id = _existing.id
                            assigned_seq = _existing.seq
                            message.metadata['_db_id'] = msg_id
                            message.metadata['_seq'] = assigned_seq
                            break
                        # Existing row vanished (rare race with delete) — fall through to retry loop
                        logger.warning(
                            "client_msg_id=%s collision but row NOT found for session %s — retrying",
                            message.client_msg_id, session_id,
                        )
                    # Lost the seq race (another writer committed the same seq) — roll back and retry.
                    db.rollback()

            if assigned_seq is None:
                logger.error("Could not assign chat seq for session %s after retries", session_id)
                return

            # Store DB ID + seq on the in-memory message for edit/delete by ID and for the
            # authoritative-order render paths (ADR 0008).
            message.metadata['_db_id'] = msg_id
            message.metadata['_seq'] = assigned_seq

            # ADR 0008 + ADR 0012: the completion broadcast fires HERE, in the shared persist
            # primitive, so EVERY persist path publishes exactly once — including the streaming save
            # path (ChatSession.add_message → _persist_message), which previously bypassed the
            # broadcast in SessionManager.add_message (the dead leg that left two windows drifting
            # until a late poll/reconcile). The authoritative {id, seq} (+ the optimistic
            # client_msg_id so a sender adopts its own temp bubble) lets every window reconcile by id.
            # Tiny, Vault-free payload (ids/seq/types only — never content). Best-effort: a publish
            # failure must never break a persist; lazy import avoids any import-time cycle.
            try:
                from src import session_events as _se
                _se.publish(session_id, "message-added", {
                    "id": msg_id,
                    "seq": assigned_seq,
                    "role": message.role,
                    "client_msg_id": message.metadata.get("client_msg_id"),
                })
            except Exception:
                pass

            logger.debug(f"Persisted message to session {session_id}")

        except Exception as e:
            logger.error(f"Error persisting message: {e}")
            db.rollback()
        finally:
            db.close()

    def mark_message_phase(self, message: ChatMessage, phase: str) -> None:
        """Durably stamp a chat phase onto an already-persisted message.

        Used by the casting-leak fix (Vault Wall): pre-game / casting-interview
        turns are OOC and must be excluded from the in-game narrator's context.
        The user message is persisted before the turn's game framing is known,
        so this stamps `metadata.phase` on both the in-memory message AND its DB
        row (by `_db_id`) once the framing has been resolved. Idempotent and
        best-effort — a stamp failure must never break the turn.
        """
        try:
            if message is None or not phase:
                return
            if message.metadata is None:
                message.metadata = {}
            if message.metadata.get("phase") == phase:
                return
            message.metadata["phase"] = phase
            db_id = message.metadata.get("_db_id")
            if not db_id:
                return
            db = SessionLocal()
            try:
                row = db.query(DbChatMessage).filter(DbChatMessage.id == db_id).first()
                if row is not None:
                    meta = json.loads(row.meta_data) if row.meta_data else {}
                    if not isinstance(meta, dict):
                        meta = {}
                    meta["phase"] = phase
                    row.meta_data = json.dumps(meta)
                    db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()
        except Exception:
            logger.warning("Failed to stamp message phase=%s", phase, exc_info=True)

    def truncate_messages(self, session_id: str, keep_count: int) -> bool:
        """Truncate session history, keeping only the first `keep_count` messages."""
        session = self.get_session(session_id)

        if keep_count < 0:
            return False

        db = SessionLocal()
        try:
            db_messages = db.query(DbChatMessage).filter(
                DbChatMessage.session_id == session_id
            ).order_by(DbChatMessage.seq).all()  # ADR 0008: authoritative order

            deleted = 0
            for msg in db_messages[keep_count:]:
                db.delete(msg)
                deleted += 1

            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                # keep_count can exceed the real message total (e.g. the AI tool
                # defaults to keep_count=10 on a short session); message_count must
                # track the rows that actually remain, not the requested cap.
                db_session.message_count = min(keep_count, len(db_messages))
                db_session.updated_at = datetime.now(timezone.utc)

            db.commit()

            # Update in-memory
            session.history = session.history[:keep_count]

            logger.info(f"Truncated session {session_id} to {keep_count} messages")
            return True

        except Exception as e:
            logger.error(f"Error truncating session: {e}")
            db.rollback()
            return False
        finally:
            db.close()

    def keep_count_before_message(self, session_id: str, msg_id: str) -> Optional[int]:
        """#1728 (D1) — resolve the `keep_count` (in server `seq` order, ADR 0008's authoritative
        order) that truncates a session down to everything BEFORE the given DB message id —
        deleting that message and everything after it.

        This is the id-keyed "supersede by row" counterpart to the DOM-index-based `keep_count` a
        caller like "Try again" (regenerate) used to compute client-side: the DOM's `.msg` elements
        and the DB's message rows are not guaranteed 1:1 (hidden/system rows persist without ever
        rendering a bubble), so a DOM-index guess can under- or over-count and leave the stale reply
        un-truncated — the exact "two near-identical persisted rows" bug (#1728 T3). Deriving the
        count from the DB's own `seq` order instead makes the truncate exact regardless of what the
        DOM looked like. Returns None when `msg_id` isn't found in this session (the caller should
        refuse to truncate rather than guess a count)."""
        db = SessionLocal()
        try:
            db_messages = db.query(DbChatMessage).filter(
                DbChatMessage.session_id == session_id
            ).order_by(DbChatMessage.seq).all()  # ADR 0008: authoritative order
            for i, msg in enumerate(db_messages):
                if msg.id == msg_id:
                    return i
            return None
        finally:
            db.close()

    def replace_messages(self, session_id: str, messages: list) -> bool:
        """Replace a session's persisted and in-memory history atomically."""
        session = self.get_session(session_id)
        db = SessionLocal()
        try:
            db.query(DbChatMessage).filter(DbChatMessage.session_id == session_id).delete()
            now = datetime.now(timezone.utc)
            for i, message in enumerate(messages):
                msg_id = str(uuid.uuid4())
                db_message = DbChatMessage(
                    id=msg_id,
                    session_id=session_id,
                    role=message.role,
                    # Multimodal content (image/audio attachments) is a list;
                    # serialize to JSON so the Text column round-trips via
                    # _parse_msg_content. Storing the raw list let SQLAlchemy
                    # bind its single-quoted repr, which _parse_msg_content
                    # cannot parse (it looks for double-quoted "type"), so the
                    # attachment was destroyed on reload. Mirrors _persist_message.
                    content=(json.dumps(message.content)
                             if isinstance(message.content, list)
                             else message.content),
                    meta_data=json.dumps(message.metadata) if message.metadata else None,
                    timestamp=now + timedelta(microseconds=i),
                    # ADR 0008: an atomic full replace — the index IS the authoritative seq.
                    seq=i,
                )
                db.add(db_message)
                if message.metadata is None:
                    message.metadata = {}
                message.metadata["_db_id"] = msg_id
                message.metadata["_seq"] = i

            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db_session.message_count = len(messages)
                db_session.updated_at = now
                db_session.last_accessed = now
                db_session.last_message_at = now

            db.commit()
            session.history = list(messages)
            session.message_count = len(messages)
            logger.info("Replaced session %s history with %d messages", session_id, len(messages))
            return True
        except Exception as e:
            logger.error("Error replacing session history: %s", e)
            db.rollback()
            return False
        finally:
            db.close()

    # ------------------------------------------------------------------
    # Session CRUD
    # ------------------------------------------------------------------

    def get_session(self, session_id: str) -> Session:
        """Get a session by ID, loading from DB if needed.

        Sessions seeded by `load_sessions` start with empty history. The
        first read here hydrates them with the message rows.
        """
        if session_id not in self.sessions:
            self._load_session_from_db(session_id)
        else:
            cached = self.sessions[session_id]
            # Lazy hydrate: metadata-only entries get their messages on first read.
            if not cached.history and getattr(cached, "message_count", 0) > 0:
                self._load_session_from_db(session_id)

        # Keep model/endpoint metadata fresh. Endpoint deletion can clear the
        # DB row while a session object is still cached in RAM.
        self.sync_session_metadata(session_id)

        # Update last_accessed
        self._touch_session(session_id)

        return self.sessions[session_id]

    def sync_session_metadata(self, session_id: str) -> bool:
        """Refresh non-message session fields from the DB into the cached object."""
        session = self.sessions.get(session_id)
        if session is None:
            return False
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session is None:
                return False
            headers = db_session.headers
            if isinstance(headers, str):
                try:
                    headers = json.loads(headers)
                except json.JSONDecodeError:
                    headers = {}
            session.name = db_session.name
            # F2 (lost-model fix): only ADOPT a non-empty DB model. A blank DB row must NOT stomp a
            # model just repaired in memory this same request. `_recover_empty_session_model` binds a
            # model onto the cached `sess` (and persists it), but `get_session` calls this sync on the
            # NEXT read BEFORE recovery re-runs — if the DB write lagged or the row is a different
            # identity, an unconditional `model = db_session.model or ""` blanks the live binding and the
            # turn refuses with "No model selected" / re-fires "Recovered empty session model" forever.
            # The DB only ever ADDS a model here; clearing one is a deliberate op (endpoint delete) that
            # goes through `_clear_orphaned_session_endpoint`, not a passive metadata refresh.
            db_model = (db_session.model or "").strip()
            if db_model:
                session.model = db_model
            db_url = (db_session.endpoint_url or "").strip()
            if db_url or not getattr(session, "endpoint_url", ""):
                session.endpoint_url = db_session.endpoint_url or ""
            session.headers = headers or {}
            session.rag = db_session.rag
            session.archived = db_session.archived
            session.owner = getattr(db_session, "owner", None)
            session.is_important = getattr(db_session, "is_important", False) or False
            session.message_count = getattr(db_session, "message_count", session.message_count) or 0
            return True
        except Exception as e:
            logger.error(f"Error syncing session metadata {session_id}: {e}")
            return False
        finally:
            db.close()

    def _load_session_from_db(self, session_id: str):
        """Hydrate a single session (with messages) from the database."""
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session is None:
                raise KeyError(f"Session {session_id} not found")

            session = self._db_to_session(db_session, db)
            if session:
                self.sessions[session_id] = session
            else:
                # No messages — fall back to metadata-only entry so callers
                # don't crash on KeyError for empty sessions.
                meta = self._db_to_session_meta(db_session)
                if meta is None:
                    raise KeyError(f"Session {session_id} could not be loaded")
                self.sessions[session_id] = meta

        except KeyError:
            raise
        except Exception as e:
            logger.error(f"Error loading session {session_id}: {e}")
            raise
        finally:
            db.close()

    def _touch_session(self, session_id: str):
        """Update last_accessed timestamp."""
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db_session.last_accessed = datetime.now(timezone.utc)
                db.commit()
        except Exception as e:
            logger.error(f"Error updating last_accessed: {e}")
            db.rollback()
        finally:
            db.close()

    def create_session(
        self,
        session_id: str,
        name: str,
        endpoint_url: str,
        model: str,
        rag: bool = False,
        owner: str = None
    ) -> Session:
        """Create a new session and save to database."""
        db = SessionLocal()
        try:
            db_session = DbSession(
                id=session_id,
                name=name,
                endpoint_url=endpoint_url,
                model=model,
                rag=rag,
                headers={},
                owner=owner,
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc)
            )
            db.add(db_session)
            db.commit()

            session = Session(
                id=session_id,
                name=name,
                endpoint_url=endpoint_url,
                model=model,
                rag=rag,
                headers={},
                owner=owner,
            )

            self.sessions[session_id] = session
            return session

        except Exception as e:
            db.rollback()
            logger.error(f"Error creating session: {e}")
            raise
        finally:
            db.close()

    def delete_session(self, session_id: str) -> bool:
        """Permanently delete a session and all its messages."""
        db = SessionLocal()
        try:
            # Detach documents so they survive as orphans in the library
            db.query(DbDocument).filter(DbDocument.session_id == session_id).update(
                {DbDocument.session_id: None}, synchronize_session=False
            )

            # Delete messages
            db.query(DbChatMessage).filter(DbChatMessage.session_id == session_id).delete()

            # Delete session
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db.delete(db_session)

            # Drop the in-memory copy even when there is no DB row. A "ghost"
            # session lives only here (never persisted, or its row was removed
            # out-of-band); without this it can never be cleared and keeps
            # 404ing on every operation (issue #1044).
            removed_in_memory = self.sessions.pop(session_id, None) is not None

            if db_session or removed_in_memory:
                # Commit the document-detach / message-delete above (a no-op when
                # the ghost had no rows) together with the session delete.
                db.commit()
                logger.info(f"Deleted session {session_id}")
                return True
            return False

        except Exception as e:
            logger.error(f"Error deleting session: {e}")
            db.rollback()
            return False
        finally:
            db.close()

    # ------------------------------------------------------------------
    # Session updates
    # ------------------------------------------------------------------

    def update_session_name(self, session_id: str, name: str):
        """Update session name."""
        if session_id not in self.sessions:
            return

        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db_session.name = name
                db_session.updated_at = datetime.now(timezone.utc)
                db.commit()
                self.sessions[session_id].name = name
        except Exception as e:
            db.rollback()
            logger.error(f"Error updating session name: {e}")
            raise
        finally:
            db.close()

    def archive_session(self, session_id: str):
        """Archive a session."""
        if session_id not in self.sessions:
            return

        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db_session.archived = True
                db_session.updated_at = datetime.now(timezone.utc)
                db.commit()
                self.sessions[session_id].archived = True
        except Exception as e:
            db.rollback()
            logger.error(f"Error archiving session: {e}")
            raise
        finally:
            db.close()

    def mark_important(self, session_id: str, important: bool = True):
        """Mark session as important."""
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db_session.is_important = important
                db_session.updated_at = datetime.now(timezone.utc)
                db.commit()

                if session_id in self.sessions:
                    self.sessions[session_id].is_important = important
            else:
                raise KeyError(f"Session {session_id} not found")
        except Exception as e:
            db.rollback()
            logger.error(f"Error marking session important: {e}")
            raise
        finally:
            db.close()

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    def get_sessions_for_user(self, username: Optional[str] = None) -> Dict[str, Session]:
        """Return sessions for a specific user (or all if username is None)."""
        if username is None:
            return self.sessions
        return {
            sid: s for sid, s in self.sessions.items()
            if s.owner == username
        }

    def save_sessions(self):
        """No-op for DB compatibility."""

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    # Game-session markers the empty reaper must never delete on a 0-message window.
    # The casting/canonical session is named "Casting interview" and is never renamed
    # server-side (see orwellSeasonProgress.js); game-mode rows carry an 'agent' mode.
    _GAME_SESSION_NAMES = {"casting interview"}
    _GAME_SESSION_MODES = {"agent"}

    def _is_reaper_exempt(self, db_session, fresh_cutoff) -> bool:
        """True if this 0-message session must be spared by the empty-session reaper.

        Two exemptions, either sufficient:
          - GAME SESSION: a casting/canonical game session (name 'Casting interview', or an
            agent-mode game row) legitimately holds 0 messages between minting and the first
            persist. Reaping it races a live casting turn → message loss.
          - FRESHLY CREATED: any row created within `fresh_grace_minutes` — defensive belt for
            a game row whose name/mode isn't set yet at creation time (the per-tab orphan is
            minted name='Casting interview' but a future surface might differ).

        2026-07-16 audit item 2 (ghost-session reaping): the NAME exemption used to be
        unconditional, so a per-tab "Casting interview" row that lost the canonical-bind race
        (#1086/#987 — a fresh surface materializes a cue-send BEFORE the convergence check
        re-points it at the real bound session) lived FOREVER, 0 messages, orphaned. Once a
        canonical game session is bound for this row's owner, any DIFFERENT empty "Casting
        interview" row is a CONFIRMED orphan (the canonical row is, by definition, the one the
        binding points at) and may be reaped; the canonical row itself — or any row while
        nothing is bound yet for this owner, the original race this exemption guards — still
        stays exempt. Best-effort: a lookup hiccup falls back to exempt (never more aggressive
        than before)."""
        try:
            name = (getattr(db_session, "name", "") or "").strip().lower()
            if name in self._GAME_SESSION_NAMES:
                try:
                    from src import orwell_game_session
                    bound = orwell_game_session.get_game_session(getattr(db_session, "owner", None))
                    if bound and bound != getattr(db_session, "id", None):
                        return False  # confirmed orphan — fall through to the normal reap path
                except Exception:
                    pass
                return True
            mode = (getattr(db_session, "mode", "") or "").strip().lower()
            if mode in self._GAME_SESSION_MODES:
                return True
            created = getattr(db_session, "created_at", None)
            if created is not None:
                # created_at is stored naive-UTC (utcnow_naive); compare like-for-like. A tz-aware
                # value (some paths pass datetime.now(timezone.utc)) is normalised to naive UTC.
                if getattr(created, "tzinfo", None) is not None:
                    created = created.astimezone(timezone.utc).replace(tzinfo=None)
                if created >= fresh_cutoff:
                    return True
        except Exception:
            # On any doubt, do NOT exempt — the reaper's job is to clean truly-empty rows;
            # a self-heal recreate (#1) covers a mistaken delete of a live session.
            return False
        return False

    def cleanup_empty_sessions(self, auto_archive_days: int = 30, fresh_grace_minutes: int = 15) -> dict:
        """Clean up empty and old sessions.

        `fresh_grace_minutes` exempts very-recently-created rows from the empty-session
        reaper (see `_is_reaper_exempt`): a casting/canonical game session legitimately
        has 0 messages for a window between minting the row and the first persist, and
        deleting it out from under that persist is a message-loss path. (The #1 self-heal
        recreates the row if it loses the race anyway; this stops the race from happening.)"""
        db = SessionLocal()
        stats = {'deleted_empty': 0, 'archived_old': 0, 'total_checked': 0, 'exempt_empty': 0}

        try:
            all_sessions = db.query(DbSession).all()
            cutoff_date = utcnow_naive() - timedelta(days=auto_archive_days)
            fresh_cutoff = utcnow_naive() - timedelta(minutes=max(0, fresh_grace_minutes))

            for db_session in all_sessions:
                stats['total_checked'] += 1

                # Delete empty sessions — UNLESS exempt (a game session, or freshly created
                # within the grace window, which may legitimately carry 0 messages briefly).
                if db_session.message_count == 0:
                    if self._is_reaper_exempt(db_session, fresh_cutoff):
                        stats['exempt_empty'] += 1
                        continue
                    if db_session.id in self.sessions:
                        del self.sessions[db_session.id]
                    db.delete(db_session)
                    stats['deleted_empty'] += 1

                # Archive old sessions
                elif (not db_session.archived and
                      db_session.last_accessed and
                      db_session.last_accessed < cutoff_date and
                      db_session.message_count > 0 and
                      not getattr(db_session, 'is_important', False)):
                    db_session.archived = True
                    stats['archived_old'] += 1

            db.commit()
            logger.info(f"Cleanup: {stats['deleted_empty']} deleted, {stats['archived_old']} archived")

        except Exception as e:
            logger.error(f"Cleanup error: {e}")
            db.rollback()
            raise
        finally:
            db.close()

        return stats
