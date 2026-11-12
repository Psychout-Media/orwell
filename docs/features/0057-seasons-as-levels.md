# 0057 — Seasons as levels: the finale, the next-season invite & progression

> **Status:** SPEC + **chunks 1–4 built** (FE, 2026-06-18). New work per CLAUDE.md ("new work
> starts as a new spec/queue item"). Builds on **0056** (keep/recreate character continuity),
> **0048** (post-season retrospective/reunion), **0049** (lingering play), **0029** (the account
> tier), and the FE **agent-loop engagement nudges** (`_player_turn_is_lull` /
> `_ADVANCE_STALL_LEVEL`).
>
> **Built:**
> - **Chunk 1** (foundation) — the per-user FE season store (`frontend/src/orwell_seasons.py`),
>   `GET /api/orwell/season`, `POST /api/orwell/next-season` (finished-season-gated; increments)
>   and `POST /api/orwell/reset-progress` (no increment), both through the one sanctioned reset.
>   Gate: `frontend/tests/test_0057_seasons.py`.
> - **Chunk 2** (the two HUD indicators) — `frontend/static/js/orwellSeasonProgress.js`: the ≤5px
>   bottom-of-viewport accent **season progress bar** (cadence-driven 0→100%, FE-computed from the
>   Vault-free `/status` + `/state`, monotone within a season, forced full at `post-season`,
>   reset per new season, reduced-motion-aware) + the quiet **"Season N" chip** (shown ≥ 2).
> - **Chunk 3** (the finale "New season" surface) — `frontend/static/js/orwellNewSeason.js`: the
>   PERSISTENT post-season panel (composed on the OrwellWindow kit; gated on `moment ===
>   "post-season"`), keep/recreate → `/next-season`, the per-season portrait via the shared G26/G27
>   studio, a gentle in-reunion nudge. Plus the settings **red-zone reset-progress** control. This
>   **subsumes the 0056 FE keep/recreate UX.**
> - **Chunk 4** (the producers re-approach) — the post-season-only agent-loop nudge
>   (`frontend/src/agent_loop.py`): engagement-driven (off-finale post-escape turns, never a
>   wall-clock timer), escalating, capped, persisted per user; it has the GM re-invite OUT OF
>   FICTION and points the player at the sanctioned "New season" button.
> - Gates: `frontend/tests/test_0057_ui.py`, `frontend/tests/test_0057_reapproach.py`.
>
> **Browser validation (landed):** `frontend/scripts/browser_smoke.py` (the "0057 — SEASONS-AS-LEVELS render" block) asserts the season-progress bar, the "Season N" chip and the post-season "New season" panel in a real browser (this note previously said it was owed; corrected 2026-11-12, ORW-286 item 8).

## Concept — a completed season is a "level"

Each **season** is a level. Finishing a season — **no matter how it ends** (you win, you lose at
the Final 2, you're evicted pre-jury, you sit on the jury) — and then starting the **next** season
**increments the user's season number**. Season number is **per-username meta-progression**: it
counts levels *cleared*, survives the engine sandbox reset between seasons, and **cannot be
skipped** — the next season is the only forward step.

Two distinct "start over" actions, with different meaning:

| Action | When | Engine | Season number |
|---|---|---|---|
| **Next season** | only once the current season has **ended** | sanctioned reset → new season (keep/recreate per 0056) | **+1** (you cleared the level) |
| **Reset progress** (settings "red zone") | any time **during** a season | sanctioned reset → fresh season **1-of-this-level** | **unchanged** (restart the current level) |

Both route through the **one sanctioned restart door** (`registry.resetUser` → engine `forgetUser`
+ save rotation — D1/R1). The *only* difference is whether the FE increments the per-user counter.
You can reset your progress toward the current level, but you can never jump ahead.

**Access:** open to **every logged-in user** for their **own** game (currently; a future config may
restrict the next-season action to admins). Cross-user isolation (0021) is unchanged — a user only
ever acts on their own season.

## The finale → next-season flow (the experience)

When a season ends, the player lands in the **post-season reunion** (0048) — a **"sandbox lobby" /
purgatory** they may inhabit **indefinitely** (0049): mingle, open the Producer's Vault, ask about
any moment, or just mess around with the model. From here:

1. **A persistent "New season" surface appears in the UI** the moment the engine has determined the
   season is over, and **stays put for the whole post-season** — it persists until the player
   actually starts the next season. It offers **keep** the houseguest or **recreate** (per 0056) and
   the per-season **portrait** (keep / upload / regenerate).
2. **If the player escapes the reunion into free chat** (wanders off, talks to the model about
   anything), they keep **decent autonomy to mess around** — the game does not force-march them.
   Then, **relatively quickly**, the **producers re-approach out-of-fiction** ("the real world")
   and naturally invite them back for the next season — an **engagement-driven** beat (a couple of
   off-finale turns), mirroring the existing stall-nudge, never a hard turn count.
3. **If the player does NOT escape** (stays in the reunion), the **UI gently nudges** them toward
   the "New season" button so the path forward is never hidden.

## The two HUD indicators (quiet, no clutter)

### A. The season progress bar (within-season cadence)
A **really thin** (**≤ 5px**), **text-less** bar pinned to the **very bottom of the viewport, below
the chat composer**, full-bleed across the viewport width, painted in the **theme accent color**. It
fills **left → right** to show how far through the CURRENT season the player is:

- **~0% when they enter the house**, **100% when the finale completes.**
- It advances **only on the predictable, cadenced game moves** — **weeks and evictions/eliminations,
  ceremonies** — the things that happen on a cadence. **Lingering in a room or socializing does NOT
  move it** (that is play between the beats, not progress through the season).
- It **resets to 0** for the new season the moment the player starts it / presses "New season".

Computed FE-side from the engine's **Vault-free** state (week / phase / houseguest statuses) — a
monotone function of evictions-so-far + the within-week ceremony phase, forced to 100% on the
terminal `finished` state. Carries no secret. Honors `prefers-reduced-motion`.

### B. The season-number chip (which level)
Once a user is **past season 1**, a **quiet, unobtrusive** "Season N" chip shows **which season
they're in** (a small corner / header element). Season 1 shows nothing. Reads the per-user season
number; never shows Vault data.

## Architecture & ownership

- **Season number lives in the FE per-user store** (the account tier, 0029), NOT the engine. The
  engine stays **season-scoped** (one sandbox = one season; it has no notion of "level N"). This
  keeps the Vault/engine clean and puts meta-progression where the *username* lives. The number
  survives the engine `forgetUser` reset by construction (it's not in the rotated save).
- **The next-season + reset-progress endpoints are player-reachable** (own game only), each requiring
  an **explicit confirm**, each routing through the engine's one sanctioned reset. This extends the
  E70 ruling (which admin-gated the *debug* `/new-game` bypass): a **keep** restart reuses a real,
  fully-interviewed character and a **recreate** drops into the real casting interview (0050), so
  neither produces the "soul-shallow character one curl away" E70 guarded against.
- **The reset-progress action does not increment**; the next-season action does. The increment is a
  pure FE bookkeeping step around the same reset call.

## Implementation chunks (queue)

1. ✅ **Season-number foundation** — the per-user FE season store (get / increment /
   reset-to-1), a player-reachable **next-season** endpoint (gated on a finished season; increments)
   and a **reset-progress** endpoint (any time; no increment), both through the engine's one
   sanctioned reset, + `GET /api/orwell/season`. FE pytest (`test_0057_seasons.py`).
2. ✅ **The two HUD indicators** — the **season progress bar** (4px ≤ 5px, bottom-of-viewport,
   accent, cadence-driven 0→100%, resets per season; FE-computed from Vault-free state) + the quiet
   **"Season N" chip** (shown ≥ 2). `orwellSeasonProgress.js`; source/route-gated by
   `test_0057_ui.py`; live browser-smoke validation landed (`browser_smoke.py`, "0057 — SEASONS-AS-LEVELS render").
3. ✅ **The finale "New season" surface** — the persistent post-season panel/button with
   keep/recreate (0056) + the portrait keep/upload/regenerate toggle (shared G26/G27 studio), wired
   to the next-season endpoint; the in-reunion UI nudge. Plus the settings **red-zone**
   reset-progress control. `orwellNewSeason.js` + the account-panel card; `test_0057_ui.py`.
4. ✅ **The producers re-approach** — the engagement-driven, post-season-only agent-loop nudge that
   has the GM re-invite to the next season after the player escapes the reunion (mirrors the
   stall-nudge: escalating, capped, persisted per user). `agent_loop.py`; `test_0057_reapproach.py`.

## Open assumptions (flagged for review)

- **Season number = FE-owned, per-username.** (Resolved above; the engine stays season-scoped.)
- **Re-approach trigger = engagement-driven** (a couple of post-escape, off-finale player turns),
  tunable, mirroring the stall-nudge — not a wall-clock timer (the game clock is the play-clock,
  per the 2026-06-10 ruling). *(Built: `_player_escaped_reunion` counts off-finale turns;
  `_POSTSEASON_OFFTOPIC_TURNS_BEFORE_REAPPROACH` is the threshold.)*
- **"Finished" = the engine's terminal season state.** *(Built: the FE reads the Vault-free
  `getGameState().moment === "post-season"` — the same terminal gate `seasonRetrospective` uses;
  `view()` does not surface a top-level `finished`, so `moment` is the FE's post-season signal,
  while the `/recap` projection still carries `finished` for the retrospective.)*
