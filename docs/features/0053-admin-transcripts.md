# 0053 — Admin transcript retrieval (debug access, quiet)

> **Status:** **Built — FE pytest-validated** (2026-06-11). Front-end (Python) tier, validated
> by frontend pytest (`frontend/tests/test_0053_admin_transcripts.py`) like 0029/0032 —
> **never** added to `cucumber.cjs`. Implementation: `frontend/routes/admin_transcript_routes.py`
> (the two `require_admin`-gated routes), the admin-only "Transcripts" row in
> `frontend/static/index.html` (System panel) + its driver in `frontend/static/js/admin.js`.
> **Executable spec:** [`0053-admin-transcripts.feature`](./0053-admin-transcripts.feature)
> **Provenance:** product-owner **ruling #14** (2026-06-10): *"Admins can retrieve old chat
> transcripts for debugging — quiet, not loudly exposed: an admin-gated API plus a small entry
> in the existing admin section of Settings"* — shape chosen 2026-06-10; the full spec block is
> `docs/audits/2026-06-10-full-product-audit.md` ("Future specs" — 0053).

## 1. Summary

Self-hosted operators need to see what actually happened in a player's session when play goes
wrong — above all **what the GM actually called vs. what it narrated** (the tool-call nodes are
where the debug value lives). 0053 gives the **app administrator** (the 0029 account tier, not
the game's God Mode) read-only retrieval of any user's chat transcripts: an admin-gated API
plus one quiet "Transcripts" row inside the already-admin-only section of Settings. Nothing
appears in the game chrome; players never see the surface exists.

## 2. The ruling, captured exactly

Per ruling #14 and the audit's 0053 block:

- **API** — all behind the existing `require_admin` middleware (same pattern as
  `admin_wipe_routes.py` / `api_token_routes.py`):
  - `GET /api/admin/transcripts` — list sessions **across all users** (session id, owner,
    title, created/updated, message count, game-session marker), with `?user=` / `?since=`
    filters and pagination.
  - `GET /api/admin/transcripts/{session_id}?format=json|md` — the full transcript export:
    messages with roles/timestamps **plus the agent-thread tool-call nodes (names, args,
    outputs)** — what the GM actually called vs. what it narrated.
- **UI** — one quiet "Transcripts" row inside the already-admin-only section of Settings
  (renders only for admins, nothing in the game chrome): session list with owner filter +
  per-session download. **No new nav surface.**
- **Boundaries recorded:**
  - Transcripts contain **only player-visible content**, so there is **no Vault risk by
    construction** — the transcript is the played record the player already saw; nothing in
    it ever came from the Vault (the Vault Wall is enforced upstream, at the tool boundary).
  - They **DO include the player's Diary-Room entries** (player-level OOC) — an **accepted
    operator capability for a self-hosted box**; the admin UI copy must note this.
  - **Retrieval is read-only** — no edit/delete (E93's no-rewriting-the-played-record rule
    applies to admins too).
  - Transcripts **survive the game reset** (by design — `deploy/orwell-game-reset.sh` clears
    engine sandboxes, preserves the front-end store) and **die with the factory reset**.

## 3. Scope

**In:** the two admin API routes; the Settings row (admin-only DOM); `json` and `md` export
formats including tool-call nodes; owner/since filters + pagination; the DR-inclusion notice
in the admin UI copy.

**Out:** any engine (TS) change — this is entirely a front-end store read; any player-facing
surface; any write/edit/delete capability; any cross-tier escalation (an admin reading
transcripts gains **no** God-Mode or Vault access — God Mode remains walled from the Vault,
and this feature touches neither).

## 4. Design notes

- **Quiet by design.** The ruling's word: this is a debugging door, not a feature surface.
  No nav entry, no game-chrome affordance — only the Settings admin section row.
- **Why no Vault risk needs no test gymnastics:** the transcript store is the front-end's
  chat history — a record of what was already rendered to the player. The Vault Wall test
  obligation is satisfied structurally (the FE never holds Vault data to leak); the pytest
  suite still asserts the export carries no engine-internal fields beyond the recorded tool
  nodes.
- **Tool nodes are first-class in the export**, not stripped as "internal": the divergence
  between narration and engine calls is precisely the E22/anti-sycophancy debugging signal.
- **Identity:** routes resolve the acting account via the same effective-user discipline as
  the other admin routes (the E29 lesson — never collapse bearer callers into one identity).

## 5. Test strategy (FE pytest, when built)

- Non-admin `GET /api/admin/transcripts` and `GET /api/admin/transcripts/{id}` ⇒ 403/404
  (whichever the `require_admin` pattern returns — match the existing admin routes).
- Admin list: shape (id, owner, title, created/updated, message count, game marker), the
  `?user=` and `?since=` filters, and pagination.
- Admin export: both formats; the export **includes tool-call nodes** (names, args, outputs)
  and message roles/timestamps; a session containing Diary-Room entries includes them.
- No mutating verb exists on the surface (no PUT/PATCH/DELETE routes).
- The Settings row is absent from a non-admin's DOM; present (admin-only section) for an
  admin; the row's copy notes Diary-Room inclusion.
- Game reset leaves transcripts intact; factory reset removes them (script-level assertion,
  riding the existing reset-script test pattern).

## 6. Definition of Done

Every behavior above proven by frontend pytest; no engine change; no player-visible surface;
read-only verified; the README index row flipped from spec-only to Done.

## 7. As built (2026-06-11)

- **API** — `frontend/routes/admin_transcript_routes.py`, registered in `app.py` right after the
  admin-wipe routes, both behind `require_admin`:
  - `GET /api/admin/transcripts` — lists sessions across all users (`id`, `owner`, `title`,
    `created_at`, `updated_at`, `message_count`, `is_game_session`) with `?user=` / `?since=`
    filters and `?limit=`/`?offset=` pagination (returns `{transcripts, total, limit, offset}`).
  - `GET /api/admin/transcripts/{session_id}?format=json|md` — the full export. Every message
    node carries `role`, `timestamp`, `content`, and (when present) `metadata` + top-level
    `tool_calls` — the agent-thread tool-call nodes ride through verbatim. `role:"tool"` rows and
    native `tool_calls` are the game-session marker.
- **UI** — one admin-only `admin-card` ("Transcripts") in the System panel of Settings
  (`static/index.html`), driven by `initTranscripts()` in `static/js/admin.js`: owner filter +
  per-session JSON/MD download links. No nav surface; hidden for non-admins by the `.admin-only`
  rule in `settings.js`. The copy carries the Diary-Room-inclusion caveat
  (`#adm-transcripts-dr-caveat`).
- **Boundaries** — read-only (no POST/PUT/PATCH/DELETE on the surface); transcripts live in the
  front-end chat store (`sessions`/`chat_messages` in `app.db`), so they survive the game-only
  reset (preserves the FE store) and die with the factory reset (scrubs it) by construction — no
  reset-script change needed.
- **Tests** — `frontend/tests/test_0053_admin_transcripts.py` (12 cases): admin-gating (non-admin
  ⇒ 403, no disclosure) for both list and export; list shape + owner/since filters + pagination;
  export shape in both formats including tool-call AND Diary-Room nodes; read-only (no mutating
  verb, asserted at route + source level); the admin-only Settings row + the DR caveat in the copy.
