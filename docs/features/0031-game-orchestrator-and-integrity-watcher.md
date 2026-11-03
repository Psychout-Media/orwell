# 0031 — Game orchestrator & integrity checkpoint (per-sandbox)

> **Status:** Built (see the [README status index](./README.md#index)). A **per-sandbox game orchestrator**: a **turn-driven**
> deterministic spine — one `advance()` path that runs the off-screen NPC tick, applies the next
> scheduled meaningful day, folds consequences, persists, and runs an **integrity checkpoint** — plus
> a Vault-free **God Mode health surface**. The house lives **only on the player's play-clock**: every
> committed player turn fires **one bounded off-screen tick**. **There is no wall-clock watcher and no
> real-world clock** (real-time purge 2026-07-10, PO ruling) — nothing advances a game while the player
> is away. Implements the **`Clock` port** as a pure monotonic **`LogicalClock`** (a play-clock, never
> wall time). Answers the question *"is there an orchestrator that tracks each game and verifies
> integrity?"*
> **Executable spec:** [`0031-game-orchestrator-and-integrity-watcher.feature`](./0031-game-orchestrator-and-integrity-watcher.feature)
> **Also proven by:** `tests/unit/orchestrator.test.ts`

## 1. Summary

Without this layer the engine is **pull-only**: a game advances solely when the front-end/agent calls a
tool, the **off-screen NPC simulation never ticks on the live path** (so the house is inert between
turns — a direct miss against the off-screen-life mandate), and **no process verifies integrity at
runtime** (non-degradation, Vault Wall, and isolation are proven only in tests). This feature adds the
missing **orchestration + verification** layer as a single, deterministic, turn-driven spine:

- **Turn-driven spine (deterministic).** Every advance flows through **one** `Orchestrator.advance()`:
  off-screen tick → next scheduled meaningful day → consequence fold → persist → **integrity
  checkpoint** (fail-closed). Seeded, pure-logic, unit-testable.
- **The house lives on the player's play-clock.** Every committed player turn fires **one bounded
  off-screen tick** (`maybeTurnDrivenTick`), so the house schemes and drifts turn-to-turn — but
  **only while the player is actually playing**. There is **no background loop**: nothing runs the
  house on real time. (Ruling 2026-06-10 + real-time purge 2026-07-10: NPCs can't leave the house but
  the player can, so a background advance during an absence would be a structural unfairness the game
  must never have — in **no** version can the house run in real time.)

## 2. What exists today (the gap this closes)

| Capability | Where | Wired to the LIVE runtime? |
|---|---|---|
| Season orchestration (HOH→…→jury) | `season.ts` `playSeason` | ✅ live (`GameSessionAdapter` / `liveSeason.ts`) |
| Day scheduler / daily-event (0008) | `schedule.ts` `scheduleWeek` | ✅ live (folded into the advance) |
| Off-screen NPC life / gossip (0003) | `offscreen.ts`, `gossip.ts` | ✅ live (the per-turn off-screen tick) |
| Non-degradation check (0007) | `saveState.ts` `isSuperset`, `countsNonDecreasing` | ✅ the checkpoint runs it every commit |
| Vault-Wall / isolation sentinels (0001/0021) | sentinel canaries, dependency-cruiser | ✅ build/test gate + live checkpoint |
| `Clock` port | `src/ports/Clock.ts` (`LogicalClock` / `FakeClock`) | ✅ a pure play-clock (never wall time) |
| Runtime orchestrator / health surface | `src/composition/{orchestrator,runtime}.ts` | ✅ the per-sandbox commit spine |

**This feature wired the existing pure logic into a live, verified, turn-driven loop.**

## 3. Scope

**In:** the per-sandbox `Orchestrator` (`advance()` spine); the **integrity checkpoint** (fail-closed,
runs on every commit); the **`Clock` port** + the monotonic `LogicalClock` runtime adapter and a
**fake-clock** test adapter; the **turn-driven off-screen tick** (one bounded tick per committed turn,
seeded); a Vault-free **God Mode health surface** (0016); wiring the off-screen sim (0003) into the
live advance.

**Out:** a background/wall-clock watcher and any real-world clock (**deliberately removed** — real-time
purge 2026-07-10; the house lives only on the play-clock); the off-screen simulation *content* itself
(0003 — reused, not rebuilt); the relationship/consequence math (0023/0026 — folded, not redefined);
the durable store (0030 — the checkpoint runs against its snapshots); any player-facing surfacing of
integrity/health (it's **admin/God-Mode only**, Vault-walled).

## 4. Design

### 4.1 Turn-driven spine — `Orchestrator.advance(sandbox, trigger)`
The **single** code path that moves a game. `trigger` ∈ `{ "player-turn", "offscreen-tick", "audit" }`.
1. **Off-screen tick** — run the 0003 sim for this sandbox (NPC-to-NPC scenes the player doesn't
   witness, gossip diffusion, relationship drift) via the seeded `RandomnessSource`.
2. **Schedule** — advance to the next **meaningful day/phase** (0008/0011); guarantee ≥1 meaningful event.
3. **Consequence fold** — apply hidden impact to soul/relationships (0023) for the new events.
4. **Persist** — save the snapshot (0030).
5. **Integrity checkpoint** (§4.3) — verify, **fail-closed**.

Pure-logic and **seed-deterministic**: identical seed + identical trigger sequence ⇒ identical state.

### 4.2 The house lives on the player's play-clock (no watcher, no real-world clock)
On every **committed player turn** (`commitPlayerTurn`), in pure turn-driven mode the orchestrator
fires **one bounded off-screen tick** (`maybeTurnDrivenTick` → `advance(sandbox, "offscreen-tick")`):
- **Bounded to the turn boundary.** A beat commit (the live loop genuinely moved) always earns its
  tick; the auxiliary tool calls of the *same* turn share one (a debounce), so a multi-tool turn runs
  **one** tick, never a flood. One tick per turn ⇒ the house never fast-forwards a season.
- **No background loop.** Nothing runs the house on real time. A game the player has left simply sits
  still — the house **does not exist while the player is away**. The `Clock` is a pure monotonic
  **`LogicalClock`** (`now()` increments only when the game reads it, i.e. on the player's own turns),
  so nothing in the game is tied to `Date.now()` and off-screen event ids / confessional seeds are now
  **run-to-run reproducible**.
- **Isolation.** Every advance stays inside one sandbox; it never carries state across users (0021),
  and never reaches the Vault from any outward read.

### 4.3 Integrity checkpoint (fail-closed)
Verifies the LIVE state against the prior persisted baseline; **on failure it refuses to commit the
advance and records a fault — never persists a degraded/leaky state** (mandate #4):
- **Non-degradation** (0007): `isSuperset` + `countsNonDecreasing` vs the last snapshot.
- **Daily-event** (0008): the advance produced ≥1 meaningful event (a *supplementary* turn-driven tick
  is exempt — the daily-event invariant belongs to the live loop's own beats).
- **Eligibility legality** (0005): the week's ceremony state is legal.
- **Vault Wall** (0001): the player **and** admin projections are **sentinel-clean**.
- **Cross-user isolation** (0021): this sandbox's outputs carry no other sandbox's sentinels.

A refused commit **fails the request** (a typed error the HTTP boundary maps to 4xx/5xx) — never a
200-then-rollback whose view narrates a beat that officially never happened.

### 4.4 God Mode health surface (0016, Vault-free)
A read-only admin tool `sandboxHealth()` → **metadata only**, never game content or Vault:
`{ user, started, week, phase, lastAdvanceAt, lastTrigger, eventCount, lastIntegrity: "ok"|"fault",
faults: [{ when, kind }], circuitOpen }`. Sentinel-clean; dependency-cruiser stays green (no Vault import).

## 5. Contracts (stack-agnostic)

```
Clock (port):        now(): number                                 // LogicalClock (prod) / FakeClock (tests)
Orchestrator:
    advance(sandbox, trigger): { events: number, integrity: "ok"|"fault", faults?: Fault[] }
    checkpoint(sandbox): Fault[]                                    // verify only (fail-closed)
    commitPlayerTurn(user): void                                   // the real spine: checkpoint + one bounded tick
    sandboxHealth(user?): HealthRecord | HealthRecord[]            // Vault-free, sentinel-clean
Runtime (composeRuntime):
    { registry, orchestrator, clock, knownUser, resumeSaved }     // NO watcher / start / stop — purely turn-driven
```

## 6. Definition of Done

- [x] **One `advance()` spine:** a player-triggered advance runs the off-screen tick, schedules ≥1
      meaningful event (0008), folds consequences (0023), persists (0030), and passes the checkpoint.
- [x] **The house lives between turns:** a committed player turn fires **one bounded off-screen tick**;
      on the next turn the player meets new consequences but **no numbers** (0001).
- [x] **The house never runs on real time:** with no committed turn, nothing advances — the house does
      not exist while the player is away (there is no wall-clock watcher and no real-world clock).
- [x] **Integrity is fail-closed:** an advance that would degrade detail (drop events/memory/edges) or
      leak a sentinel is **refused**, the prior save is intact, and a **fault** is recorded.
- [x] **Off-screen life is deterministic & logic-free:** same seed + same committed turns ⇒ identical
      state; a game with no committed turn never self-advances.
- [x] **Isolation:** the house living across many sandboxes never leaks one user's content into
      another (cross-user sentinel, 0021).
- [x] **God Mode health is Vault-free:** `sandboxHealth()` returns metadata only, is sentinel-clean
      on player **and** admin canaries, and `npm run test:arch` stays green (no Vault import).
- [x] Name-agnostic tests (roles only); `npm test` green.

## 7. Dependencies & traceability

Wires together **0003** (off-screen sim), **0007** (non-degradation primitives), **0008** (schedule),
**0011** (season loop), **0023** (consequence fold) + **0030** (durable snapshots the checkpoint
compares against), under **0001** (Vault sentinel) and **0021** (per-user isolation), surfaced via
**0016** (God Mode). Implements the **`Clock`** port named in `CLAUDE.md`'s architecture, as the pure
monotonic `LogicalClock`. **Feature 0035 (a running wall-clock watcher) was removed** in the real-time
purge (2026-07-10) — the house now lives only on the player's play-clock, so there is no separate
"running watcher" feature.

## 8. Shipped defaults & clarifications

- **There is no wall-clock watcher and no real-world clock (real-time purge 2026-07-10, PO ruling).**
  Production runs **pure turn-driven**: the house does NOT advance while the player is away (NPCs can't
  leave the house, the player can — a background advance during an absence would be a structural
  disadvantage). The orchestrator fires **one bounded off-screen tick per player turn**
  (`maybeTurnDrivenTick`), so the house lives turn-to-turn on the player's own play-clock. The old
  opt-in `GameWatcher`/`SystemClock`/`ORWELL_WATCHER_*` surface was **deleted, not disabled** — in no
  version can the house run in real time. So "advance" in normal play is **always
  player-turn-triggered**, never clock-triggered.
- **Advance vs. in-game time (the two tracks).** An "advance" is one *committed player turn* (snapshot →
  work → verify → keep-or-revert). It is **not** 1:1 with a ceremony **beat**: ceremony beats
  (HOH → noms → veto → veto-ceremony → eviction) are the **sparse plot milestones** (~one per in-game
  day) and only progress on the turn that performs the ceremony action; **most turns are lingering /
  conversation** that advance the **in-game time-of-day** (0066, via `advanceClockPerConversation`) and
  run the off-screen life **without** moving the ceremony beat. Time-of-day (0066) is the finer-grained
  *pacing of a day* that fills the space between the sparse beats; as the in-game night gets late the
  awake set shrinks (0049) and the day ends by running out of *people*, not a timer. The orchestrator's
  turn commit is the seam that carries the 0066 clock forward — they are the same heartbeat, and the
  **in-game clock is the only clock** (there is no rival wall clock).
- **Health record.** The live `HealthRecord` also carries a `circuitOpen` flag (a resilience
  circuit-breaker: repeated off-screen-tick faults open the circuit so a wedged sandbox stops being
  hammered; any clean advance closes it) beyond the §4.4 metadata list — still Vault-free metadata only.
