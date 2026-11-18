# 0210 - Production as a character (Theme C, ORW-666)

Card: ORW-666 (Ryne approved all three, 2026-11-18: "I think those are all great ideas!"). Executable spec: `0210-production-as-a-character.feature` (spec-only until the build). Foundation: `src/engine/production.ts` + `tests/unit/production.test.ts` (built, BDD Auditor). The slices: Overseers A and B, through the Coordinator.

## What exists today (build on it)
- **0130 exit interviews:** an `exit-interview` eviction stage; the player's pending (their posture and words); the NPC stance; carried into the retrospective. C1 extends it; it does not add a second interview.
- **The producer persona** (`producerPersona.ts`): seeded, off-camera, the casting voice. **0115** is the player's strategic Diary Room; **0040/0122** are NPC confessionals (Vault-only content). C2 and C3 build on these.
- **The narrator** is already "the host" in prompt terms (`momentPrompts.ts`); C1 gives the host a seeded persona of its own, like the producer's.

## C1: the host on eviction night
**Built (ORW-667, Overseer A; flag `ORWELL_HOST`, default ON): `src/engine/productionHost.ts`, a `host` block on the eviction view (`HostView`), rendered into the eviction moment by `renderHostBlock` (`momentPrompts.ts`). The host's manner is three leanings (warmth, edge, pace) from keyed hashes of the game seed, handed to the narrator as composed words; the facts are the public board, the count's shape once committed, the player's own public seat and public-record exit-interview questions. Executable: `0210-host-on-eviction-night.feature`. A blindside is not raised: it needs what the evictee expected, which is not public. Seam for C2/C3: `hostRegister(seed, owner)`.**
- **Host persona:** seeded like `producerPersona` (a real name from the corpus, a register), off-camera to the house except on eviction night; never a houseguest. Persisted per season.
- **Questions:** at the exit-interview stage, gather candidate `HostFact`s for the evictee from the event store: the ceremonies, public scenes, and the evictee's own recorded acts. Rank them by drama (edit worthiness, 0200). `hostQuestions` keeps the evictee's own choices first, at most 3, and never a hidden fact (`hostMayAsk`). The narrator voices the questions from the facts (no question list).
- **The player as evictee:** the 0130 pending carries the host's question facts; the player answers in their own words.
- **The wall:** a boundary test proves no hidden event id reaches the question set (pre-crown).

## C2: called to the Diary Room
- When an NPC confessional fires (0040/0122), record a VISIBLE "called away" event. Its witnesses are those present in or adjacent to the living room (the diary room opens off it). It holds `diaryCallSeen` (who, day, long, `comesBack` from the mood before and after) and no content field, by construction. The confessional itself stays Vault-only.
- **Both ways:** the player's own Diary Room sessions (0115) record the same visible call. NPCs present register it, and it can feed suspicion (`houseSuspicion`) as any observed act does.
- The time away moves the in-game clock as the Diary Room does today; no new clock rule.

## C3: a producer who pushes back
- In the player's Diary Room (0115), the producer may raise up to 2 `pushbacks(said, did)`: a promise from the player's own claims log (assurances #2150, deals and safety promises; ids) followed by the player's own act against the same person (nomination, vote, replacement, broken deal).
- They're voiced by the producer persona as a question ("walk me through that"), from the facts. Everything is the player's own knowledge layer (Diary Room content is the player's), so the wall holds by construction.
- The player's answer is DR content (0115): it informs the player's edit (0200) and the retrospective, never NPC behaviour.

## Flags and measures
- **Flags:** `ORWELL_HOST` (C1), `ORWELL_DIARY_CALLS` (C2), `ORWELL_PRODUCER_PUSHBACK` (C3), each default ON.
- **Measure:** C1 and C3 are narration inputs (no outcome change). C2 adds an observed act, which moves suspicion: run the mix and the stacking report if `houseSuspicion` reads it.

## The rules
- The player in both directions: the player is called, seen and interviewed like anyone.
- No short lists: no question or line lists; the narrator voices everything from facts.
- The wall: host questions skip hidden facts; Diary Room calls carry no content; pushbacks use only the player's own record.
- Never shown as numbers.
