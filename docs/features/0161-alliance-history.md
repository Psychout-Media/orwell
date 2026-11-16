# 0161 - Alliance history (ORW-544)

Executable spec: `0161-alliance-history.feature`. Unit: `tests/unit/allianceHistory.test.ts`.

## What it fixes

The live alliance list (`AllianceStore`, 0107) dropped a row when an alliance faded (ORW-353), fell under two members (betrayal) or lost members to evictions. That broke the
non-degradation rule (mandate #4), and `load()` resumed ids after the highest LIVE id, so a dissolved top-numbered alliance let its id be handed out again. And NPC alliances
forming or fading recorded no event at all.

## Design

- **History** (`AllianceHistoryEntry`, `src/engine/alliances.ts`): an append-only list on the store. Kinds: `formed`, `joined`, `left`, `betrayed`, `faded`, `dissolved`. Each entry has a strictly
  increasing `seq`, the alliance id and name, the beat and day, the roster (before a leave / end, after a form / join), who and why, and whether the player knew of the alliance.
  Only `eventId` is ever filled in later, once. The live `alliances` list is unchanged, so houses mix, deals and bloc cement read exactly what they read before.
- **Saved** as `allianceHistory` on the session snapshot (engine-only), restored by `load()`. `sessionCoreIsSuperset` refuses a save that drops an entry by `seq`.
- **Ids** resume after the highest id in the live list OR the history, so an id is never reused.
- **Events** (`GameSessionAdapter.flushAllianceEvents`): `alliance-formed`, `alliance-faded`, `alliance-dissolved`, recorded once each through the existing event recorder. Witness set = the
  alliance's members, plus the player only if they were a member or had been told (pitched). The recorder hides any event the player is not in, so an unknown pact stays Vault content.
  A betrayal already records its own event at its own site, and the player founding an alliance already records theirs, so those are marked, not doubled. Joins and leaves are history only.
- **Vault Wall**: no player or admin view reads the history or the hidden events. The post-season retrospective (0048) and the rumor-mill retrospective (0157) may read it later; this slice adds no reader.
- No flag: nothing changes unless an alliance exists, and alliances still form only where they did.
