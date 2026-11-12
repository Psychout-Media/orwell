# 0021 — Game session & save lifecycle (per-user sandboxes)

> **Status:** Built (see the [README status index](./README.md#index)). **How a game maps to users now that Orwell *is* the game (the fold, #60).**
> **One active game per physical-world user**, each in its **own isolated sandbox**; **unlimited
> concurrent games across different users**; the chat is each user's **window** into *their* game.
> Introduces **cross-user (multi-tenant) isolation** as a first-class guarantee — a new axis
> alongside the Vault Wall.
> **Executable spec:** [`0021-game-session-and-save-lifecycle.feature`](./0021-game-session-and-save-lifecycle.feature)
> **Also proven by:** `tests/unit/registry.test.ts`

## 1. Summary

Each **authenticated user** has at most **one active Big Brother game**, held in that user's own
**sandbox** (isolated state namespace — its `GameState`, Vault, knowledge, souls). Many users play
at once, each in a separate sandbox; **no user can ever reach another user's game**. The user's
chat is the window into *their* sandbox. Starting a new game replaces the user's current one (their
own data only); their game **persists and resumes** when they return (ties to 0007).

This formalizes `CLAUDE.md`'s "each running game is its own isolated sandbox (own state
namespace/instance)" and binds it to the **physical-world user** as the sandbox key.

## 2. Scope

**In:** the per-user sandbox model (one active game per user; unlimited users concurrently);
**cross-user isolation** (the new guarantee); how the engine keys sandboxes by user identity; how
that identity reaches the engine; new-game (replace the user's own game); save/resume.

**Out:** the persistence *mechanics* (serialization, the `SaveStore` — **0007**); the chat UI that
renders the window (**0020**); within-game secrecy (the **Vault Wall, 0001** — still holds inside
each sandbox); multiple save *slots per user* (deliberately **not** this model — one active game
per user).

## 3. The model

- **Sandbox per user.** The engine holds an isolated `GameSession` (sandbox) **keyed by the
  authenticated user identity**. Created on the user's first game; everything in it — game state,
  Vault, events, knowledge, souls, portraits — is private to that user.
- **One active game per user.** A user has at most one active game. Starting a new game **replaces**
  (or archives — §8) *their* current game; it never touches anyone else's.
- **Unlimited concurrent users.** N users each run their own game simultaneously, fully isolated.
- **The chat is the window.** The user's chat session(s) view and drive *their* sandbox; the
  per-moment narration (0018) and decisions (0019) operate on that user's game.
- **Persist & resume.** A user's game survives across reconnects/restarts and resumes where they
  left off (in-memory per-user today; SQLite-per-sandbox later, **0007**). The **consequence &
  memory loop** (act → hidden impact → persist → recall, **0023**) runs **per sandbox** — each
  user's accumulated history and the house's memory of *them* is theirs alone.

## 4. Cross-user isolation (the new guarantee)

A second isolation axis, orthogonal to the Vault Wall:

- **Vault Wall (0001):** *within* one game, secret state never reaches that game's player/admin.
- **Cross-user isolation (this feature):** *across* games, **no tool call made on behalf of user A
  may return any of user B's state** — visible projection, Vault, knowledge, narration context,
  portraits, or status. Even non-secret, player-visible data is private to its user's sandbox.

So a leak here is two failures: another player's *secrets* (Vault) **and** their *game at all*.

## 5. Identity flow (how the sandbox is selected)

The **front-end is the trusted auth tier** (it authenticates the physical-world user — accounts,
sessions). On each engine call it **asserts the authenticated user identity**; the engine resolves
that to `sandboxFor(user)` and routes the call there. The engine binds **loopback-only** (deploy
0010), so it trusts the front-end's asserted identity — the front-end never lets one account act as
another. (A signed/shared-secret hardening is a later option, §8.)

## 6. Contracts (stack-agnostic)

```
GameSessionRegistry (engine):
    sandboxFor(user) -> GameSession      # the user's isolated sandbox; created on first use.
                                         # One active game per user; unlimited users; each fully isolated.

# The MCP layer resolves `user` from the identity the front-end asserts (trusted loopback tier)
# and routes EVERY tool call to sandboxFor(user). All existing player/admin tools (createCharacter,
# getGameState, getMomentPrompt, runCompetition, pendingDecision/executeDecision, gameStatus,
# portraitDescriptorFor, inspectNonVaultState…) operate within that user's sandbox only.

GameSession (per user — as 0015/0018/0019/0020):
    createCharacter(req) -> GameStateView   # starts/REPLACES this user's active game
    getGameState() / getMomentPrompt() / runCompetition() / ...   # this user's game only
```

**Invariants:** sandboxes are keyed by user; **no** call on behalf of user A returns user B's data
(cross-user sentinel-clean); a user has **one** active game (a new game replaces their own);
unlimited users run concurrently without interference; a user's game **resumes** across reconnects;
the Vault Wall still holds inside every sandbox.

## 7. Test strategy

- **Cross-user isolation (sentinel across users):** seed user A's game with unique sentinels (house
  names, state). Across seeded calls **on behalf of user B**, assert **no** A-sentinel ever appears
  in any of B's tool outputs — and vice-versa. (Mirrors the 0001 Vault canary, on the user axis.)
- **One active game per user:** user A starts a new game ⇒ A's prior game is replaced; user B's game
  is untouched.
- **Concurrency:** N users each `createCharacter`; assert N disjoint houses/states, no interference.
- **Resume:** repeated calls for the same user return the same ongoing game; a simulated
  reconnect resumes it (and, once 0007 lands, survives a restart).
- **Vault Wall intact per sandbox:** the 0001 sentinel guarantees still hold within each user's game.

## 8. Open decisions (flagged; drafted to your answer)

- **New game = replace vs archive.** Default: **replace** the user's current game (start fresh).
  Optional archival of the prior game is deferred to **0007** (could keep a per-user history).
- **Identity hardening.** Default: trust the front-end's asserted user over loopback. A signed
  token / shared secret between front-end and engine is a later option if the engine is ever
  exposed beyond loopback.
- **Admin across users.** God Mode (0016) stays **per-sandbox**; **no** cross-user browsing — one
  user's game is never visible to another, admin included (consistent with "spoilers ruin the
  game"). A separate operator/metrics view (counts only, no game content) could come later.

## 9. Definition of Done

- [ ] All scenarios pass, name-agnostic, seed-reproducible.
- [ ] The engine keys an isolated sandbox per authenticated user; created on first use.
- [ ] **Cross-user isolation proven:** no call for one user returns another user's data
      (cross-user sentinel test), across many seeds.
- [ ] One active game per user (new game replaces the user's own; others untouched).
- [ ] Unlimited users run concurrently, isolated; a user's game resumes across reconnects.
- [ ] The Vault Wall (0001) still holds inside every sandbox.

## 10. Dependencies

**0001** (Vault Wall — within each sandbox), **0007** (persistence/resume + optional archival),
**0009** (the tools now carry the user context), **0015** (OOBE starts the user's game), **0016**
(God Mode per-sandbox), **0018/0019/0020** (narration/agent/UX operate within the user's sandbox),
and the **front-end auth tier** (asserts the user identity). Realizes `CLAUDE.md`'s sandbox model.

## 11. Traceability

This session's calibration (one active game per physical-world user; sandbox per user; unlimited
concurrent games across users; the chat as the window); `CLAUDE.md` ("each running game is its own
isolated sandbox (own state namespace/instance)"; three channels); the fold (#60) that put the
game in the main chat; `docs/features/0007-persistence-non-degradation.md` (the save that persists).

## 12. Amendment (B57 / audit H4) — save/load semantics & account deletion

- **Save/load respects the 0007 ratchet.** Any load/resume path on a sandbox (admin- or
  lifecycle-driven) may **not silently regress persisted detail**; **restore-to-checkpoint** is
  the sanctioned rollback (explicit, recorded, history-preserving). A new game replacing the
  user's current one (§3) is the deliberate exception — a fresh save lineage, not a regression
  of the old one.
- **Account deletion ⇒ sandbox deletion.** Deleting a user's account implies deleting that
  user's **sandbox data** (saves, events, souls, portraits under their key) — per-user data has
  no owner once the account is gone (cross-user isolation's complement; ties to 0029).
  **As built (Ryne, BDD card 34, 2026-11-11, accepted as-is; noted 2026-11-12, ORW-286 item 8):** account deletion is a **rename of the user's save folder**, not a purge of the sandbox data. If real deletion (a purge) is wanted, that is a future card and needs Ryne's say-so.
