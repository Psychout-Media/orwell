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
  occupancy of non-adjacent rooms (you can't see through walls — and fog of war is gameplay). The view also carries `counts` (ORW-376, below): `{ room, others, house, voters?, asleep? }`, integer headcounts owned by the engine.
  **Amendment (ORW-376, 2026-11-15):** "no numbers" means no relationship/stat/hidden numbers (durations like `turnsHere` were already allowed); the view also carries `counts` — `room` (the player included, the people in the player's room), `others` (the people in the player's room besides the player), `house` (the engine's LIVING-houseguest total, the player included: not a count of who is visible) and, on an eviction night, `voters` (the engine's eligible eviction-ballot total) — plain headcounts, so the narrator quotes a number instead of counting a list of the OTHER people's names. These integers are the only numbers THIS amendment adds beyond durations (the existing `tracked[].confidence` is a separate, earlier numeric field and is not affected).
  **Amendment (ORW-386, 2026-11-15):** `counts` also carries `asleep` (the number of houseguests the game lists as turned in; absent with the clock off) so the narrator's "N asleep" is the engine's number. And `whereabouts({search:true})` adds `search` - the HOUSE SEARCH, asked for on a turn where the player asks where someone is or searches the house: one entry per living houseguest in the house (the player excluded) giving only a room, whether the player can walk in (`open`, or `closed` for the HOH room while another houseguest holds it), or that they are asleep (in a bedroom, when seated in one), plus the asleep count and each occupied room's roster. A room and an access word, never an activity, a motive or a hidden number (the per-room roster does show who shares each room, which is what walking in would show): the same thing the player would learn by walking the house, with ONE exception the code makes today: the roster (`rooms[].present`) and the per-houseguest entry name who is in a CLOSED room (the HOH holder, or a diary-room occupant) next to its `closed` access word, while walking the house would show only 'door closed' (compare the 0077 closed-door opacity note). Whether that exception is wanted is Ryne's call (ORW-437); this note records what the code does. The default view is unchanged (sightline rooms only).

  **Amendment (ORW-462, 2026-11-15, Kevin's rulings of 11:52 and 15:58 MST): the player is not omniscient, and the game never confirms where someone is if the player does not know.** The ORW-386 exception above (naming the occupants of a closed room) is withdrawn. The house search names a houseguest's room only where the player can SEE it now: their own room and the rooms in sightline (`HOUSE_SIGHTLINE`). Every other awake houseguest is `unseen` (no room: "not in view; behind a door in the house, the player can open doors and look"), a sleeper behind a door is "asleep, in bed" with no room, and `rooms[]` lists only rooms in view. The doors in the house are unlocked except the diary room and the HOH room (while another houseguest holds it); the player finds people by looking in rooms (`moveTo`) or by asking around.
  `whereabouts({search:true, lookingFor:"<name or id>"})` answers for the houseguest the player names ONLY from what the player can see and from the player's own record of what they have seen, never from the live map: in view = there; otherwise a `lead`: the 0077 tracked sighting ("last seen heading into the bedroom A a moment ago / a while ago", recorded when the player watched them go) or the new last-known sighting in view (`lastSeenAt`: room, day, part of day; "last seen in the kitchen around the afternoon", or "on day N"); a lead is never a confirmation. With neither the answer is `unknown` ("nobody here knows where they are: look around the house or ask around"). The diary room and the HOH room are never named unless the player's record names them. A first name shared by two active houseguests names nobody; use the full name. Asking for every name in turn therefore reveals nothing the player did not already know (pinned by a roster-sweep test and a scenario). `lastSeenAt` is written at persist time from who the player could see (played games only, so headless saves stay byte-identical), persisted with the save beside `trackedSightings`, and an older save without it loads with an empty record. A houseguest present who saw someone go saying so in their own voice ("Oh, he went into the diary room") came with the NPC sightings of ORW-475 (asking around, below). Kevin's wish of walking into a room where two houseguests are scheming and being in their way is ORW-818.
  **Amendment (ORW-475, 2026-11-15, Kevin with Ryne: "Yes and they could be wrong but why would they lie idk based on character sheet"): asking around.** Each houseguest keeps their OWN last-known record of who they saw where (`npcSightings`, viewer to subject: room, tick, day, part of day, and `heading` when they watched the subject walk toward that room), written from their own line of sight (their room and the rooms in sightline) like the player's `lastSeenAt`, in played games only; persisted with the save; an older save loads empty. When the player looks for a houseguest the player's own record cannot place, the houseguests the player can see are asked: the one with the freshest sighting speaks (`told`, with `toldBy`), in their own voice, as something said that may be out of date; if nobody has a record the answer is still `unknown` ("nobody here knows"). The player's own record wins when it is as fresh. Whether the speaker tells it straight, dodges (no straight answer, nothing given away) or misleads (names a room they did not see, never the true one) is decided by THAT houseguest's sheet, not by a general rule: `askDisposition` (src/engine/askAround.ts) takes their candor (archetype and strategy style, the same candor the mood-cause telling uses), their affinity for the player and their affinity for the one asked about, and a seeded roll per (houseguest, subject, day, part of day): candid houseguests always tell; a guarded one protects someone they like more than the player (misleads) and is evasive with a player they do not warm to (dodges). Deterministic, draws no rng, headless output unchanged. The narrator is never told an answer is false.
  **Amendment (ORW-473, 2026-11-15, Kevin with Ryne: "That should be dynamic based on character sheets involved"): walking in on a private talk.** When the player walks into a room (`movePlayer`, which `moveTo` and the intent-first move use) where two houseguests are in a private strategy talk (a recent hidden house-life scene in that room: a spoken alliance, attack or gossip action between the two, both still there; played games only), the engine decides each one's reaction from THEIR OWN sheet: `walkInReaction` (src/engine/walkIn.ts) scores four reactions (goes quiet and changes the subject, carries on in guarded terms, makes an excuse and moves the talk, welcomes the player in and pulls them into it) from the houseguest's candor (archetype and strategy style), how they feel about the player and about the other, and how much the talk has to hide (the kind of talk, whether it was truthful, softened by candor), with a seeded jitter that only separates near ties. Deterministic, draws no rng, headless output unchanged. `getGameState().walkedIn` carries who and each reaction as a MANNER to voice, on that message only (it is stamped with the message it happened on, like `playerMove`), never what the talk was about; the front end hands it to the narrator (`_walked_in_directive`) with the rule not to invent the subject. Both houseguests remember it as a fact in their own memory ("the player walked in on my private talk with X"). One scenario per reaction kind.
  **Amendment (ORW-473 follow-up, 2026-11-17): group talks.** The rule is no longer limited to exactly two people. A hidden private talk whose witness set holds three or more (an ordinary gathering, or a late-night trio from 0192) is caught too, under the same guards (played games only, recent in game time, every one of them still in the room and awake, once per talk). Each member reacts from their own sheet (`walkInReaction`, unchanged); toward a group the "feeling about the other" input is their mean affinity to the rest, and the jitter is keyed on the whole company (a pair keeps its exact keys). The view names everyone and carries only manner lines, never the talk's content, kind or a number; every member remembers it ("...walked in on my private talk with X, Y and Z"). A late-night talk (`houseLife.nightOwl`) of any kind (confession, bonding, scheme) counts as a private talk. Flag `ORWELL_WALKIN_GROUPS` (default ON; `=0` restores the pair-only rule, byte-identical). The front end names a group as "A, B and C". Scenarios: group of three, group with one gone.
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

## Amendment 2026-11-18 (ORW-579, Fable T1-12c): an overheard fragment is what could be heard

A hidden off-screen scene's overheard fragment used to be the first 60% of the engine's own line, which carries the engine's label for the scene (a pitch, a frame, a betrayal, an
alliance). Per the owner's "no hints to motive; actions are the evidence", the orchestrator now passes `rollOverhears` a `heard` line built by `overheardLine` (houseLife.ts): a clash and a
plain house-life or romance act are heard as themselves; every other scene is heard only as who was speaking (a leading fragment of the line, cut before the label, so the knowledge service still anchors it on content lineage). No slice of the engine line ever reaches the listener. The player's own
scenes overheard by NPCs (EngineCommandsAdapter) are the player's actual words and keep the partial slice. A pure projection (no rng draw, no outcome moves), so no flag. Gate:
`tests/unit/overheardNoMotive.test.ts` (sentinel plus positive control).
