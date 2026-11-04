# 0045 — Endgame structure (Final 5 → Final 2)

> **Status:** Built (see the [README status index](./README.md#index); was queue **B43**). The **late game was mathematically broken.** Two
> bugs make the endgame illegal/ill-defined: (1) **0005 demands a veto field of exactly six** — impossible at
> Final 5 / Final 4; (2) **Final 3 is not modeled** — at 3 active the loop runs a full nomination/veto week
> that ends with `evictionVoters = ∅`, a permanent **0–0 "tie"** silently resolved by `npcChoice(hoh)`
> (`liveSeason.ts`). This feature amends 0005 with **field-size degradation** and adds the **F3 branch** (a
> final-HOH competition + a personal eviction through a new pending decision), so a seeded season reaches
> Final 2 with **every** late-week ceremony legal.
> **Executable spec:** [`0045-endgame-structure.feature`](./0045-endgame-structure.feature)
> **Amendment note (0128 / #2045):** Final 3's single final-HOH competition is replaced by the **three-part Final HOH** (0128; default ON via #2066). The Final-3 scenarios in the `.feature` are restated when that lands; until then they describe the final-HOH *eviction* (unchanged), not the comp shape. BDD audit AMEND-0045: S1 now asserts the veto winner is never the replacement nominee, S6 uses a real registry snapshot/restore.

## 1. Summary

The weekly loop (0011/0034) is correct for a full house but never had its **endgame** pinned. From Final 5
inward the field shrinks below the six the veto rules assume, and at Final 3 the classic format **drops
nominations/veto entirely**: the last HOH competition winner **personally evicts** one of the other two,
sending the third to Final 2. Today neither is handled — late weeks are illegal under 0005's fixed
predicates, and F3 degenerates into an empty-electorate tie the engine resolves invisibly (an
anti-sycophancy + correctness hole). 0045 makes the endgame legal, modeled, and player-agentic.

## 2. What exists today (the gap this closes)

- **Veto field is fixed at six.** `domain/eligibility.ts` `vetoParticipants` assumes a 6-player draw (HOH +
  2 noms + 3 chip-draws). At F5 that's only 5 available; at F4, 4 — the predicate can't be satisfied.
- **No Final 3.** `liveSeason.ts` runs the standard nomination → veto → eviction week at 3 active; the
  eviction electorate (`evictionVoters` = everyone but HOH + the two noms) is **empty**, yielding a 0–0 tally
  silently broken by `npcChoice(s.hoh!)` — using the player→NPC threat edges the player has never seen.
- **No final-HOH eviction.** There is no decision kind for "the final HOH evicts one of two" — so the player,
  as final HOH, gets **no agency** over who they sit beside.

## 3. Scope

**In:** amend **0005** eligibility with **field-size degradation** (veto field = `min(6, remaining
eligible)`; at **F4** the **one houseguest who is neither HOH nor a final nominee is the sole eviction vote** — usually the veto holder, but if the HOH or a nominee won the veto, it's whoever is left); add the **F3 branch** to `liveSeason`
(skip nominations/veto; run a **final-HOH competition**; the winner **personally evicts** via a new
`final-eviction` `submitDecision` kind — **pending** if the player is final HOH, **relationship-driven**
(`npcChoice`) if an NPC, with eviction **manner** recorded for the jury); preserve the **0034 pending-decision
seam** (no binding choice parsed from prose). Persisted (0030), seed-deterministic.

**Out:** the full-house loop (0011/0034 — unchanged); the finale itself (0037 — F2 → jury vote, already
built); the player-evicted path (**0046**); the eviction-night staging (**0047**). The tie-break for a
*full-house* player-HOH vote is a **sibling** (queue B44) — 0045 only covers the structural F5→F2 legality.

## 4. Design

- **Field-size degradation (0005).** `vetoParticipants` (and the chip draw incl. "Houseguest's Choice")
  compute the field as `min(6, eligible.length)`; below six, **everyone eligible plays** (no chip draw
  needed). At **F4**, the eviction electorate is the **one houseguest who is neither HOH nor a final nominee** — normally the veto holder (HOH + 2 noms are excluded;
  one remains) — they cast the sole vote; no tie possible. The invariants (outgoing-HOH can't play next HOH;
  veto winner can't be the replacement; HOH breaks ties) hold **under** the smaller field.
- **The F3 branch (`liveSeason`).** At `active.length === 3`: **skip** nominations + veto; run a
  **final-HOH competition** (a `CompetitionType`, engine-resolved, 0006/0028); the winner is the **final
  HOH** and **personally evicts** one of the other two → the survivor and the final HOH are the **Final 2**;
  the evictee becomes the last juror.
- **The `final-eviction` decision (0034 seam).** A new `PendingDecisionView`/`SubmitDecisionReq` kind
  `"final-eviction"`: `options` = the two evictable houseguests, `pick` = 1. **Pending** when the player is
  final HOH (binding, validated); **auto** (`npcChoice`, threat-driven) when an NPC is. Eviction **manner**
  recorded (jury, 0014/0037).
- **Vault Wall / anti-sycophancy.** NPC final-HOH eviction is engine-decided from hidden edges; the player's
  is their own validated choice. No numbers cross the wall; eligibility never overridden by temperature.

## 5. Contracts (stack-agnostic)

```
eligibility (0005): vetoField = min(6, eligible); below 6 → all eligible play (no chip draw)
                    F4 eviction electorate = { the one non-HOH, non-nominee } (sole vote; no tie)
F3 branch (liveSeason): skip noms/veto → final-HOH competition → final HOH evicts one of two → Final 2
decision: kind "final-eviction" { options: [two ids], pick: 1 }   // pending if player-HOH; npcChoice if NPC
manner recorded on the eviction (0014/0037); persisted (0030); seed-deterministic
```

## 6. Definition of Done

- [ ] **Every late-week ceremony is legal:** a seeded season runs F5 → F4 → F3 → F2 with all 0005 predicates
      satisfied under the degraded field (no "exactly six" failure; no empty electorate).
- [ ] **F3 is modeled:** at 3 active the loop runs a final-HOH competition and a personal eviction — **no
      0–0 tie** path remains.
- [ ] **Player agency:** the player as final HOH (or F4 sole voter) receives a **binding `final-eviction`**
      decision over the legal two; an illegal pick is refused; an NPC final HOH evicts relationship-driven.
- [ ] **Invariance + Vault Wall:** eligibility holds under temperature; manner is recorded; no number on any
      player surface; restart mid-pending resumes (0030).
- [ ] 0011/0034/0037 scenarios stay green; name-agnostic; `0045` added to `cucumber.cjs`; `npm test` green.

## 7. Dependencies & traceability

Amends **0005** (eligibility) and extends **0011/0034** (the live loop + decision seam) into the endgame,
feeding **0014/0037** (manner → jury), persisted by **0030**, under **0001** (Vault Wall). Precedes
**0046** (player-evicted path) and **0047** (eviction-night staging); the player-HOH *full-house* tie-break
is the sibling B44.

## 8. Implementer-ready (Definition of Ready)

**Touch points (exact):**
- `src/domain/eligibility.ts` — `vetoParticipants` (degrade to `min(6, eligible)`) + `evictionVoters` (F4 →
  the one non-HOH, non-nominee houseguest); keep the existing invariant helpers.
- `src/engine/liveSeason.ts` — the eviction/electorate path (the empty-`evictionVoters` 0–0 site ~L224–228)
  and the F3 branch at `active.length === 3` (final-HOH comp + `final-eviction`); the HOH-draw site (~L354).
- `src/ports/GameSession.ts` — add `"final-eviction"` to `PendingDecisionView.kind` + `SubmitDecisionReq.kind`;
  `GameSessionAdapter` dispatch + `liveSeason.applyDecision` validation.
- Eviction **manner** reuses `jury.ts` `EvictionManner`/`mannerToward` (built).

**Build order / deps:** none blocking — 0005/0011/0034/0037 are all built; this amends + extends them.
**Test targets:** `tests/unit/endgame.test.ts` + `docs/features/0045-*.feature` → `cucumber.cjs`. Assert §6.
**No open decisions.** F3 = final-HOH-personally-evicts (canon). Field degrades to `min(6, remaining)`.
