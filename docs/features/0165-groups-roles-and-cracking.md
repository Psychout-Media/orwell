# 0165 - Groups: roles, nesting, spies and cracking (Theme 3 slice 6) - DRAFT, not built

Executable spec (drafted only): `0165-groups-roles-and-cracking.feature`. Not in `cucumber.cjs`; no step definitions. Awaiting the owner's approval of the Theme 3 plan.

## What it adds
Roles in an alliance (leader, strategist, shield, swing vote, glue, comp threat); inner circles (nested groups); shadow and counter-alliances; spies; a majority that privately plans the cut order; purpose shifts (survival, power, endgame); cracking when interests split.

## Reuses (verified to exist)
- `src/engine/alliances.ts` (`AllianceStore`, 0107; the append-only history from 0161 already exists, so "alliance history is kept" in the plan is DONE - do not rebuild it), `src/engine/blocs.ts` (emergent blocs, 0043).
- `src/engine/houseLife.ts` (+ `houseLifeConstants.ts`) for NPC-to-NPC off-screen scenes where spying and counter-formation happen; `src/engine/gossip.ts` / the claims core (0149) so a spy's report is a told claim, not a teleport.
- `src/engine/campaigns.ts` for each member's goal; `credibility.ts` so a caught spy loses their word.
- Depends on the social core (Core 1): roles read the bond kinds and the house graph. 0156 house meetings (Q5) is the venue where a cracked alliance can be confronted.

## Data shape (engine-only)
Extend the alliance record, never replace it: `roles: Map<member, Role>`, `parent?: allianceId` (nesting), `shadowOf?: allianceId`, `spy?: { member, reportsTo }`, `purpose: survival|power|endgame`, `cutOrder` per member (private). Splits write a history entry (0161 kinds extended), never a delete. Own seeded side stream.

## Open owner questions
- Does a spy always report, or can a spy "turn" and become loyal (a bond-driven flip)? Plan implies reports; a flip is a plausible extension.
- Role names are plain words in the plan; confirm they stay engine labels voiced only through what NPCs say, never a roster.
