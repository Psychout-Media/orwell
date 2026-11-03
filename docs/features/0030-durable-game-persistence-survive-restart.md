# 0030 — Durable game persistence (survive engine restart)

> **Status:** Built (see the [README status index](./README.md#index)). Wire **durable, per-user persistence into the LIVE game** so a started
> game survives an **engine restart**. Today the live path is in-memory only: a process restart
> wipes every game, so the front-end's onboarding overlay ("Welcome to the house") **re-fires every
> time** and all event/relationship/soul detail is lost. This completes the **persist → recall**
> half of [0023](./0023-consequence-and-memory.md) for the *live* game, reusing the already-built
> [0007](./0007-persistence-non-degradation.md) serialization (`GameState`/`SaveStore`) behind a
> **disk-backed** adapter, and keeps the per-user isolation of [0021](./0021-game-session-and-save-lifecycle.md).
> **Executable spec:** [`0030-durable-game-persistence-survive-restart.feature`](./0030-durable-game-persistence-survive-restart.feature)
> **Also proven by:** `tests/unit/durablePersistence.test.ts`

## 1. Summary

The "Welcome to the house" dialog firing on every load is **not an overlay bug** — the overlay is
correct (it shows onboarding exactly when the engine reports no active game). The bug is **underneath
it**: the live game holds all state in process memory and persists nothing, so any engine restart
(redeploy, file reload, idle-container reclaim) resets the game to `phase: "setup"`, `started: false`,
and onboarding re-mounts. This feature makes the live per-user game **durable**: it is **saved on
every mutation** and **recalled on return**, so a restart resumes the game instead of recreating it.

This is the documented top-priority gap: *"the live game … logs events, changes no opinions, and
persists nothing."* 0023 names the loop; **this** wires the persist/recall ends into the live
`GameSessionRegistry` + `GameSessionAdapter`, with a **real disk-backed** `SaveStore` (the in-memory
one is itself lost on restart).

## 2. Root cause (evidence)

| Where | Today | Consequence |
|---|---|---|
| `src/composition/registry.ts` | `GameSessionRegistry` holds sandboxes in a plain `Map`; `buildUserSandbox()` always starts at `phase: "setup"`, no load. | Restart → empty map → fresh setup game. |
| `src/adapters/engine/GameSessionAdapter.ts` | `house/week/phase/ceremony` are instance fields; `createCharacter`/`runCompetition`/`updateCeremony` mutate memory and **never** call a `SaveStore`. | Nothing is written; nothing to recall. |
| `src/adapters/inmemory/InMemorySaveStore.ts` | The only `SaveStore` impl is **in-memory** (a `Map`). | Even the save store dies with the process. |
| `src/engine/{consequence,gameProgression}.ts` | Use `SaveStore`/`saveState` — but only in the **off-screen sim**, not on the live `createCharacter`/`getGameState` path the front-end calls. | Live play is unpersisted. |

Net: `GET /api/orwell/state` returns `started:false` after any restart → `orwellOnboarding.js`
re-mounts the overlay. Per-user routing/identity is **not** the cause (both `/state` and `/new-game`
are non-exempt and resolve the same authenticated user; in-process per-user persistence already
works) — the cause is the absence of *durable* persistence.

## 3. Scope

**In:** a **disk-backed `SaveStore`** adapter (plain-JSON, behind the existing port); a per-user
**save-on-mutation / load-on-resume** wiring in `GameSessionRegistry` (+ a `snapshot()/restore()` seam
on `GameSessionAdapter` and the engine stores); preservation of the [0007](./0007-persistence-non-degradation.md)
co-versioning + non-degradation guarantees and the [0021](./0021-game-session-and-save-lifecycle.md)
per-user isolation **across restart**; the Vault Wall holding on the reloaded state.

**Out:** the SQLite/Postgres adapters (the disk JSON adapter is the MVP store; the relational ones
slot behind the same port later); the relationship-impact math (0023/0026); the vector recall store
(0024 — it persists via its own `SoulProvider`, co-versioned the same way); any front-end change
(the overlay is already correct — once the engine recalls the game, it stops firing).

## 4. Design

- **Disk-backed `SaveStore`.** A `FileSaveStore` (engine-only adapter) implementing the existing
  `SaveStore` port: `save(state) → SaveRef` writes a per-user JSON snapshot under a data dir
  (`ORWELL_DATA_DIR`, default e.g. `./.orwell-data`); `load(ref)` reads it back. Versions bump
  Vault+Journal **together** (0007). Older snapshots remain loadable (no overwrite of prior
  versions → non-degradation), latest pointer per user.
- **Adapter snapshot seam.** `GameSessionAdapter` gains `snapshot(): GameState` and
  `restore(state)` so the live house (player + NPCs + souls + ceremony + week/phase) round-trips
  through the 0007 `GameState` shape losslessly. The engine stores (`EventStore`, `KnowledgeService`,
  `RelationshipModel`, souls) expose the same export/import they already use in the off-screen sim.
- **Registry wiring (the fix).** `GameSessionRegistry` takes a `SaveStore`. `sandboxFor(user)`:
  if a save exists for `user`, build the sandbox and `restore` it before returning; else fresh.
  Every mutating tool (`createCharacter`, `recordInteraction`, `runCompetition`, ceremony updates,
  any consequence fold) **saves** the user's snapshot after applying. `resetUser` starts a new save
  lineage (does not delete history needed for non-degradation tests).
- **Per-user namespacing.** Saves are keyed by the asserted user (0021). User A's reload can only
  load user A's snapshot; cross-user isolation holds across restart.

## 5. What exists vs the gaps (implementer)

| Capability | State |
|---|---|
| `GameState` serialize/deserialize, `counts`, `isSuperset`, `countsNonDecreasing` (0007) | ✅ exists (`src/domain/saveState.ts`) |
| `SaveStore` port + co-versioned snapshots | ✅ exists (port + `InMemorySaveStore`) |
| Off-screen sim persists via `SaveStore` | ✅ exists (`consequence.ts`, `gameProgression.ts`) |
| **Disk-backed `SaveStore`** (survives process exit) | ⛔ **gap** |
| `GameSessionAdapter.snapshot()/restore()` (live house ↔ `GameState`) | ⛔ **gap** |
| `GameSessionRegistry` **load-on-resume / save-on-mutation** | ⛔ **gap** (Map only, no `SaveStore`) |
| Restart resumes the live game (`getGameState` → `started:true`) | ⛔ **gap** (the welcome-dialog bug) |

## 6. Contracts (stack-agnostic)

```
FileSaveStore implements SaveStore       // engine-only; per-user JSON under ORWELL_DATA_DIR
GameSessionAdapter:
    snapshot(): GameState                // lossless export of the live house + ceremony + week/phase
    restore(state: GameState): void      // rebuild the live house from a snapshot
GameSessionRegistry(saveStore: SaveStore):
    sandboxFor(user): UserSandbox        // loads the user's latest save into the sandbox if present
    // mutating tools save the user's snapshot after applying
```

## 7. Definition of Done

- [ ] A started game **survives a simulated restart**: a fresh `GameSessionRegistry` (new process
      analogue) backed by the same store recalls the user's game — `getGameState()` returns
      `started:true` with the same week/phase/house. (So the onboarding overlay does **not** re-fire.)
- [ ] **Per-user isolation across restart:** after restart, user A's resume never returns user B's
      game; user B with no save still gets onboarding.
- [ ] **Non-degradation across restart** (0007): reload then continue → detail counts are
      non-decreasing and the later state is a **superset** of the earlier; the static character is
      byte-stable while the dynamic soul may deepen.
- [ ] **Vault Wall holds on reloaded state:** the player surface over a resumed game returns **no**
      Vault data (sentinel-free), same as a fresh game.
- [ ] A real **disk-backed** `SaveStore` is used by the live registry; killing and recreating the
      registry/store from disk reproduces the game. Name-agnostic tests (roles only).

## 8. Dependencies & traceability

Builds on **0007** (the `GameState`/`SaveStore` contract + non-degradation), **0021** (per-user
sandboxes — saves are per-user), **0023** (this is its persist→recall half, made durable for the live
game), and **0024** (souls persist via `SoulProvider`, co-versioned). Fixes the user-reported
regression: the "Welcome to the house" overlay (`frontend/static/js/orwellOnboarding.js`) firing on
every load because `GET /api/orwell/state` reported `started:false` after each engine restart.

## 9. Amendments (B57 / audit H4 + H8)

- **Admin save/load vs the ratchet (H4).** Any save/load surface over this store (incl. God
  Mode's `manageSandbox`, 0016) must respect the **0007 monotonic ratchet**: a load may not
  silently regress persisted detail; **restore-to-checkpoint** is the sanctioned rollback.
  **Account deletion implies deleting that user's sandbox data** (0021/0029).
- **The re-entry beat (H8).** A resume must open **in-fiction**: a fresh morning-in-the-house
  scene (the 0018 moment framing picks up where the game stands), **never** an out-of-fiction
  recap dump. The store recalls everything; the *chat* re-enters the fiction — recall is the
  engine's job, not an exposition paragraph (ADR 0003: the conversation is the game).
