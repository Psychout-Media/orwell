# 0049 — House presence & lingering play (rooms, occupancy, overhearing)

> **Status:** **Built** (queue **B64**, green 2026-06-10 — spec drafted the same day per the v1-transcript
> audit ruling). ADR 0003 promises **lingering is play** (§7) and **people must make sense** (§8), and the
> v1 transcripts show the game's best beat — an NPC quoting the player's own private phrase back at him,
> because he was close enough to hear it — is **illegal** under today's strict witness sets: nothing models
> *where anyone is*, so nothing can generate an overhear. 0049 adds a **light** spatial ground truth: rooms +
> adjacency in the pure core, one-room-per-houseguest seeded occupancy, a Vault-free `whereabouts()` read,
> co-presence as a witness pathway, adjacency as a **bidirectional, low-confidence overhear pathway**, and
> the guarantee that milling around **never advances the week**.
> **Executable spec:** [`0049-house-presence-and-lingering.feature`](./0049-house-presence-and-lingering.feature)
> **Superseded detail (0077 Phase 2):** `whereabouts()` now lists the occupants of rooms within **sightline** (eyeshot, `HOUSE_SIGHTLINE`), not raw adjacency, and closed-door rooms are opaque to the live ambient read (`present`/`nearby`; the player only ever sees a closed room's occupants through the separate `tracked` field — earned doorway sightings, never the live map); wherever this note says "adjacent" for what the player can *see*, read "within sightline". Adjacency still governs movement and the overhear roll.
> **Turned-in houseguests (ADR 0006):** with the day clock on, a houseguest who has turned in for the night neither witnesses nor overhears a player scene, even if presence still seats them in the room or next door (the awake set, the same filter `whereabouts` and the off-screen society apply); clock off ⇒ unchanged. Gated by the "turned in neither witnesses nor overhears" scenario and its clock-off control.
> **Provenance:** `docs/audits/2026-06-10-v1-transcript-meta-feedback-audit.md` §3.7, §4.4, §5.6 · ADR 0003 §4/§7/§8.

## 1. Summary

This is *facts the narrator queries*, not a simulation the player operates. The house gets canonical rooms
and a static adjacency map; every active houseguest is in exactly one room per tick; clustering is seeded and
driven by the relationship/agenda layer (allies drift together, schemers seek empty rooms). The player can
mill around, learn who's present and who's nearby, and talk to anyone — while the NPCs keep playing *their*
game — and none of that progresses the week. Presence grounds information flow both ways: being in the room
makes you a witness; being in the **next** room can make you an **overhearer** — a partial, traceable,
lower-confidence pathway (0002) that works for NPCs overhearing the player exactly as for the player
overhearing NPCs. Eavesdropping becomes real, recorded information-gathering instead of narrative vibes.

## 2. What exists today (the gap this closes)

- **No spatial model.** Events have witness sets (0002) but nothing grounds *who could have been a witness*;
  scenes happen "somewhere." The §8 coherence invariant (one place at a time) is unenforceable.
- **Overhearing is plumbed but never generated.** `KnowledgeService` accepts `overheard:<eventId>` pathways
  and `momentPrompts` tells the model overhearing exists — but no live mechanism ever creates one, in either
  direction. The v1 audit's flagship beat cannot legally occur.
- **Lingering is aspirational.** ADR 0003 §7 says milling is play and nothing force-marches the week, but
  there is no structural guarantee that N social turns leave week/phase/ceremony untouched, and the watcher
  has no notion of "milling counts as activity."
- **No player presence read.** "Who's here? Who's nearby?" has no Vault-free engine answer.

## 3. Scope

**In:** (1) **Rooms + adjacency** — the canonical BB house spaces (kitchen, living room, backyard, bedrooms,
HOH room, diary room…) + a static adjacency map, in the **pure domain core**. (2) **Occupancy** — every
active houseguest in exactly **one** room per tick; movement only between adjacent rooms; seeded clustering
driven by the relationship/agenda layer; deterministic by seed; evicted houseguests are **nowhere**. (3) A
Vault-free **`whereabouts()`** player read: who is in the player's room + who is in **adjacent** rooms —
facts a houseguest could see/hear, never motives or hidden state. (4) **Co-presence grounds 0002** — same
room ⇒ witness pathway; adjacent room ⇒ a temperature-gated chance of an **`overheard:` pathway, in both
directions** (NPC↔player and NPC↔NPC), recorded, traceable, lower-confidence. (5) **Lingering never advances
the week** — mill/move/talk turns are zero-beat; only the explicit decision seam (`advanceGame` /
`submitDecision`) progresses phase; the daily-event invariant is satisfied by the day's *scheduled* beat.

**Out:** a navigable map UI or click-to-move (C28 renders presence as an **ambient** strip — ADR 0003 §4,
augment never replace); pathfinding or room-by-room travel time; per-room props/furniture simulation; any
change to how scheduled ceremonies resolve (0008/0011/0034 unchanged); gossip *retelling* drift (B27b — a
separate, complementary pathway type).

## 4. Design

- **Pure-core house model.** `Room` ids + a static adjacency map live in the domain core (no I/O), beside
  eligibility. Adjacency is data, not behavior; the same map every season (the house doesn't remodel).
- **Seeded occupancy ticks.** The off-screen tick (0035/0038) assigns each active houseguest a room:
  relationship-weighted clustering (high-affinity pairs co-locate; scheming pairs prefer low-occupancy
  rooms), HOH gravitates to the HOH room, all through the seeded `RandomnessSource` — same seed, same
  trajectories. One room per houseguest per tick is an **invariant**, not a tendency.
- **Witness sets get ground truth.** A conversation/scene event's witness set is its room's occupants. This
  makes 0002's "player-witnessed = not secret" and B65's "no co-presence fact for a scene in another room"
  *derivable* instead of asserted.
- **Overhearing, both directions.** When a scene resolves, each occupant of an **adjacent** room rolls a
  temperature-gated chance to gain an `overheard:<eventId>` pathway: a real, recorded propagation event
  (0002) with reduced confidence (they heard *something*, maybe partial). An NPC overhearing the player's
  conversation feeds that NPC's knowledge/soul (and can resurface later — the v1 "recon mission" beat,
  legally); the player overhearing NPCs surfaces through the normal player-knowledge projection (never raw
  Vault content — the overheard fact is *what was said in the scene*, scoped exactly like being told it).
  The Vault Wall is untouched: surfacing is an explicit, traceable event with a pathway.
- **`whereabouts()`.** A read-only, Vault-free projection: occupants of the player's room + occupants of
  adjacent rooms (names/public presence only). No motives, no hidden state, no relationship numbers, no
  occupancy of non-adjacent rooms (you can't see through walls — and fog of war is gameplay).
- **Zero-beat social turns.** Moving rooms, milling, and conversation are recorded as events but advance no
  phase/week/ceremony. The watcher treats them as activity (no idle fast-forward steamrolls a gathering
  player). Only the 0034 seam progresses the game.

## 5. Contracts (stack-agnostic)

```
domain:  Room (id) · HOUSE_ADJACENCY: ReadonlyMap<Room, readonly Room[]>
state:   occupancy: Map<EntityId, Room>            // every ACTIVE houseguest, exactly one room
tick:    assignRooms(state, relationships, rng) → occupancy   // seeded, clustering-weighted
read:    whereabouts(player) → { room, present: EntityId[], nearby: { room, present: EntityId[] }[] }  // Vault-free
events:  scene.witnesses = occupants(scene.room)
         overhear: for each occupant of adjacent rooms, temperature-gated →
                   KnowledgeService.surface(entity, fact, "overheard:<eventId>", { confidence: reduced })
loop:    mill/move/talk turns ⇒ no change to week | phase | pending ceremony; watcher idle-clock resets
```

## 6. Definition of Done

- One-room-per-active-houseguest and adjacency-only movement hold across a full seeded season (property
  test); evicted houseguests occupy nothing.
- Same seed ⇒ identical occupancy trajectories; different seeds diverge.
- `whereabouts()` is sentinel-clean (0001 canary extended) and contains only co-present/adjacent **public**
  facts — no motives, numbers, hidden state, or non-adjacent rooms.
- Co-presence produces witness events; adjacency produces lower-confidence `overheard:` pathways **in both
  directions** (an NPC gains a pathway to a player conversation; the player gains one to an NPC scene) —
  extends the 0002 test suite; every overhear is traceable to its event.
- An NPC with no presence-derived pathway to a fact still does not know it (0002 unchanged); overhearing is
  temperature-gated, not guaranteed (distribution property test).
- **N consecutive mill/move/talk turns leave week + phase + ceremony unchanged**, and the watcher treats
  milling as activity (no idle fast-forward) — the ADR 0003 §7 structural guarantee (B66 harness).
- The daily-event invariant (0008) still holds — satisfied by scheduled beats, never by a forced march.

## 7. Dependencies & traceability

- **Builds on:** 0002 (pathways/witness sets — extended, not changed) · 0008 (cadence — untouched) · 0035/
  0038 (the off-screen tick hosts occupancy) · 0026/0017 (relationship-weighted clustering) · 0034 (the only
  week-advancing seam).
- **Feeds:** B65 (knowledge-scoped voicing gets real co-presence facts) · B66 (testability harness asserts
  the invariants) · C28 (the front-end presence strip renders `whereabouts()`) · B27b (gossip drift is the
  complementary retold-pathway; overhearing here is direct).
- **Provenance:** ADR 0003 §4/§7/§8 · `docs/audits/2026-06-10-v1-transcript-meta-feedback-audit.md`
  (ruling 1) · queue **B64**.

## 8. Implementer-ready (Definition of Ready)

**Touch points (exact):**
- `src/domain/` — new `house.ts`: `Room` + `HOUSE_ADJACENCY` (pure, data-only) + an occupancy-invariant
  helper (one room each, adjacent moves only).
- `src/engine/offscreen.ts` / `src/engine/simulation.ts` — the tick assigns rooms (seeded,
  relationship-weighted); scenes pick up their room's occupants as witnesses; adjacency rolls overhears via
  the existing `KnowledgeService.surface` with `overheard:<eventId>` pathways (both directions).
- `src/ports/GameSession.ts` + `src/adapters/engine/GameSessionAdapter.ts` — `whereabouts()` projection
  (mirror the existing Vault-free read-tool pattern); mount on the player channel in the MCP tool registry.
- *(Removed: the former `src/composition/gameWatcher.ts` "idle clock" touch point; that file no longer exists. Milling/social turns are ordinary activity for the orchestrator spine.)*
- `src/engine/momentPrompts.ts` — the lever manifest gains `whereabouts` (the model already knows
  `surfaceInformationTo`/overhearing exists; now it has the ground truth to use it honestly).
- Extend the **0001** sentinel canary to `whereabouts()`; extend 0002's pathway tests for generated
  overhears; add the §6 property tests (`tests/unit/presence.test.ts`) via `tests/support/sandbox.ts`.

**Build order / deps:** all dependencies are built (0002/0008/0026/0034/0035/0038). **Test targets:**
`tests/unit/presence.test.ts` + `docs/features/0049-*.feature` → `cucumber.cjs` when green.
**Open decisions:** none — room list is the canonical BB set (data, trivially tunable); overhear probability
is a constant in the temperature/relationship constants pattern (tunable module, like 0028).
