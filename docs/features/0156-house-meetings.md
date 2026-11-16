# 0156 - House meetings (theme 2, slice 7)

Plan: the vault note "Theme 2 Slice Plan" (slice 7). Builds on 0149 (claims core) and 0151 (the Vault-free narrator seam). Interface changes to `spokenClaims.ts` go through its owner (the BDD Auditor).

## Shapes
- `HouseMeeting` (engine-only, on the live season, append-only, kept whole): `{ id, week, day, caller, accused, claim: { kind, subject, object? }, accuser, answer: "deny" | "admit" | "redirect", redirect?: { to }, attendees: EntityId[], playerPresent: boolean }`. `claim` is one of the claims core's `SPOKEN_CLAIM_KINDS`.
- Narrator view (Vault-free): `houseMeeting?: { caller, accused (names), claim: { kind, subject, object? (names) }, answer, redirectTo? (name) }` only when the player was in the house and awake; never `isTrue`, intent, ids or any listener's outcome.

## Rules
1. **Who may call one is one seam**: `MEETING_RULES.callers` ("player+npc" default; "npc" or "player" are the owner's other answers) read in ONE function `canCallMeeting(who)`.
2. **NPC calls**: an NPC holding a strong grievance belief (about a houseguest, slice 2's `believedGrievance` when it lands, else belief confidence) may call one, at most once per week per house, with a seeded roll on its own side stream (`seed:house-meeting`). The player calls one by saying so (a pure parser, like the bed and who-told-you seams).
3. **The accusation** is a claim from the claims core told by the caller to each present houseguest (`tellClaim`), so every listener holds it as a belief with the caller as source.
4. **The accused answers**: deny / admit / redirect, decided by the engine from the truth of the claim, the accused's candor and cunning, and how the room trusts each side; seeded and deterministic. Admit confirms the belief; deny puts the listener's belief to the trust test below; redirect is the accused telling each listener the accuser is lying (a `lying-about` claim from the accused).
5. **Each listener decides who to believe** from trust in the accuser versus trust in the accused (and the accused's answer): a listener who trusts the accuser more holds the accusation harder; one who trusts the accused more doubts it (`refuteClaim`, the existing belief-reversal rule). The player gets no belief: the read is theirs.
6. **No model cost** beyond the words the player hears. Its own seeded side stream; the house-mix and late-game guards run in the PR. Vote accusations never reveal a ballot (the vote-deduction claims are claims, not ballots).
