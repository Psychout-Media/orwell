# 0212 - The bloc vote: allies agree a target in a scene and vote it together

> **Status:** **Spec for Ryne, before build** (ORW-972, 2026-11-26; Kevin's decision: design a real bloc vote rather than settle for shielding only). No shipping code is in this PR. Amends 0043 (emergent blocs) and 0107 / 0172 (named alliances, group life) once approved.
> **Executable spec:** [`0212-bloc-vote-pact.feature`](./0212-bloc-vote-pact.feature) (spec-only until slice 1 wires it).

## 1. Problem (measured, on the ORW-972 card)

The 0043 scenario "bloc-mates vote together" measured +2.6 to +3.7 points of vote agreement when written. On main it is -0.030 at 100 seeds. Bisects by two lanes agree on the cause and on what it is not:

- The 200-seed bisect (noise about +/-0.012 on the lift): 2026-11-03 +0.084; just before the default flip +0.069; the default flip (#1996) +0.023; 2026-11-11 +0.002; ORW-19 (#2584, comp-win threat 0.3 to 0.45) -0.020; main -0.020. Threat back at 0.3 on main gives +0.025. So the main driver is ORW-19, the default flip a smaller share.
- The 100-seed bisect: ORW-19 moved the unbonded baseline to about 90% agreement. Everyone reads the same winner as the threat, so bonded or not they vote alike. The lift is a ceiling effect of that consensus. In the same games the old bloc term LOWERS trio agreement (0.835 without it, 0.823 as cast): it pulls members toward a threat-derived shared target, not toward the bloc's own vote, so it only flips a marginal member against the house.
- Shielding holds (about 0 against 31 to 60 bloc-mate nominations over 100 to 200 seeds). Only the vote-together lift is gone.
- ORW-19 cannot be reverted: 0.3 puts solid-play F2 reach at 31.3%, outside Ryne's 12-20% band (PO log, 2026-11-02).
- A bloc-level term (lean toward the nominee the members jointly fear more) was tried: lift -0.049, because the trio is often only two of three after defections.
- Majority-pull prototypes (Auditor sweep, 100 seeds for the lift, 300 per arm for solid play; weight w on the pull toward the members' majority pick, shield unchanged): w=1.0 +0.043; w=0.5 +0.021; w=0.33 +0.016; w=0.2 +0.007; shield only -0.012; main -0.030. Solid wins 18 to 20 per 300 for every variant against 24 on main (about +/-4 run to run), the cost of removing the old shared-target lean. No weight reached both lift of at least +0.015 and main's solid win count. The Auditor's variant byte-for-byte keeps the baseline.

The lesson: a bloc that votes together must carry its own decision (a chosen target), not a nudge computed from the same threat read the whole house already shares.

## 2. The idea in one paragraph

Allies agree a vote target out loud, in a scene. That agreement is a small record, a **bloc pact**: who is in it, the target, the week it covers. At the vote each member's keep or break is decided by their own character and the stakes, using the same machinery as a casual vote promise (0143, ORW-723: a keyed, personality-scaled roll). A kept pact binds the vote like a kept promise does. A broken one is a betrayal the house can learn of. The pact replaces the threat-derived shared-target lean in the vote term; nominations keep the 0043 shield.

## 3. Design

### 3.1 Forming the pact
- Where: an NPC scene or message exchange (house life) among two or more houseguests who are already a detected bloc (0043) or a named alliance (0107) AND whose eviction vote is live this week (nominees set). A pact is proposed by one member (a leader role from 0172 when there is one, else the member with the strongest bond to the others), and each other member accepts or declines on their own read: bond to the proposer, own threat read of the target, loyalty. A decliner is simply not in the pact; the pact may be two of three.
- The target is a nominee on the block, chosen by the proposer's own read plus the group's majority pick (the members' own threat reads, Borda over the nominees). Never a houseguest off the block; the pact binds only the eviction vote.
- Players: when the player is in the scene and says the words, the existing assurance recorder takes it (the model proposes only that a pact was made; the engine decides everything after). The player is never bound by the engine, and the engine never casts the player's vote. An NPC pact aimed at the player is possible when the player is a nominee and the members' own reads name them.
- Stored or derived (ADR 0002): a pact is a ledger row (like an assurance or a deal), not an ally label on a houseguest. Detection stays derived. The row says "these members agreed this target this week" and lapses when the vote resolves. Nothing about who is allied with whom is persisted beyond that row and the 0107/0172 records that already exist. Ryne to confirm (question 1).

### 3.2 Binding by personality and stakes
- Per member, the keep weight reuses ORW-723: loyalty, honesty, the member's bond to the pact's other members, and how threatening the target reads to them, plus a stakes term: how many votes the pact holds against the number needed (a member whose vote decides the eviction is under more pull from the pact and from the target's retaliation), and whether the member is themselves on the block or the HOH's target (self-preservation overrides).
- The verdict is its own keyed roll `${seed}:bloc-pact:${pactId}:${member}`, stable across reads and never the shared rng. A kept pact votes the target out; a broken one votes the other nominee (or the member's own read).
- Legality is a veto: the HOH never votes except on a tie, a nominee has no ballot, and the player's ballot is never bound.
- One-off defection before the vote is allowed: a member whose bond to an outside nominee overtakes their bond to the pact (the 0043 defection margin) may leave the pact quietly; that is a broken pact, not a rewritten one.

### 3.3 Betrayal
- Reuses the 0143 break path unchanged: `deal-broken` memory (severity 0.3), trust drop 0.12 in the breaker toward the pact's other members, the `lied-to-me` claim at 0.8 for the members who learn it, witnesses at half weight. Named-alliance members take the 0107 betrayal multiplier.
- Ballots are sealed (ORW-15): a vote cannot name its caster. When the pact's target survives or goes against the pact's count, each member's fold is divided across the pact members who could have broken it, with no named claim and no witness fold. A break the pact's members can PROVE (the breaker confesses, or they see a public act such as the HOH tie-break) is attributed.
- Cracking (0172) already splits alliances whose members aim their first cut at each other; a broken pact feeds it as one more input, with no new mechanism.

### 3.4 Why it fits the ORW-19 threat model
- ORW-19 made the house's default vote the threat winner. A pact is the case where several voters agree a target that is NOT the consensus winner, or agree the consensus winner together; in the second case it adds nothing (already a ceiling), in the first it is exactly the lift the old claim describes, concentrated on the bloc rather than the whole house.
- The player's F2 reach depends on how the house treats the player when they are a nominee or a bloc's target. Under this design the pact moves a vote only for the members of the pact (typically 2 to 4 of the voters), only when the target differs from what their own read would pick, and only at the keep probability of their own character, so the effect on a solid player is bounded and smaller than a house-wide weight. The measured claim is a gate (section 5), not an assumption.
- It removes the old shared-target lean from the vote term. That lean is what cost solid wins in the prototypes (main 24 against 18 to 20 per 300 in every variant that removed it). Ryne's call on that cost is question 3, because the design reads differently if the old lean stays alongside the pact.

## 4. Player-facing signs (Vault rules, 0001)

- The pact, its roster, its target before the vote, each member's keep weight and every roll are Vault-class: engine-only, never in a view, tool result, narrator prompt or admin projection. A new history kind, history-only (not event-flushed).
- The player learns of a bloc only by observable acts: hearing the proposal when they are in the scene (a normal event the player witnessed, naming nobody who was not there); a member telling them (a told claim, `going-after` or `targets-you`, through the existing 0172 told-claims route, true only when it matches the pact and subject to the speaker's candor); the reveal pattern on eviction night (several votes landing together is visible; who cast which stays sealed); and a break showing as the existing betrayal event when it is public (a tie-break) or as a rumored `lied-to-me` claim in a conversation.
- No roster, no "bloc" screen, no keep-chance number. The Vault canary (0001) gains the pact row and its history kind.
- Anti-sycophancy: the narrator never describes a pact the engine did not record.

## 5. Calibration gates (all on a runner, never this machine)

Each gate blocks the build. Measure against the numbers in section 1, not memory.

1. **Bloc lift.** The 0043 scenario's own logic (blPlayOne, trio with bloc bonds seeded vs unseeded, 10 weeks) at 200 seeds in four runs of 50. Gate: lift at least +0.015 AND its 200-seed noise (about +/-0.012) reported next to it, so the claim is lift minus noise above zero; the pact on, the same seeds with `ORWELL_BLOC_PACT=0` as the control (must still show main's -0.020 so the control is live). Do not move the seed window or loosen `BL_ALIGN_TOLERANCE`.
2. **F2 reach band.** Solid-play F2 reach stays inside 12-20% on the deploy profile (the ORW-19 gate), with passive and reckless unchanged in their own bands (passive F2 about 5-13%, win under 5%; reckless below solid; solid win 6-10%). Report the solid win count next to main's 24 per 300 so the old cost is visible. Measured at 300 seeds per arm, run to run noise about +/-4 wins.
3. **Whole-season mix.** The existing mix guard, `juryReach`, `calibrationGradient`, and the vote-why distribution: pact-bound votes should be a small share (a number is set from the prototype in slice 1; the 0143 precedent decided 0.0% of votes at its old weight, which is the failure to avoid, and the Auditor's 811 of 1734 trio decisions with 72 decided is the number to beat). Shielding must still be 0 against about 30-60 mate nominations.
4. **Byte identity off.** With the flag off every seeded run is byte-identical to main (as 0143 and 0172).
5. **Sealed ballots.** The 0143 sealed-ballot test extends: a break reveals no voter.

If gate 2 fails while gate 1 passes, the lever is the pact's reach (how many pacts form, the stakes term), not ORW-19's threat, and not a change to the F2 band without Ryne.

## 6. Engine changes and slices

All flag-gated (`ORWELL_BLOC_PACT`, default ON only after the gates pass; `=0` is byte-identical), played games only, no shared rng drawn (keyed rolls).

1. **Prototype and sizing.** A calibration report test (`tests/calibration/blocPactReport.test.ts`, gated by an env var) runs the gates 1-3 with a rule-only pact: the members' majority pick, no scene yet, a keep roll from `assurancePull`. Output sizes the lift and the solid-play cost before any wiring. Exit: gate 1 and 2 numbers on the card.
2. **Ledger and vote.** `PactLedger` (id, week, members, target, per-member verdict) beside `AssuranceLedger`; `voteChoice` takes a `blocPactBindsVoteFor` hook right after the assurance seam; the old shared-target lean in `blocTerm` is removed from the vote term only (the nomination shield stays). Tests: legality, keyed stability, byte identity.
3. **Forming in scenes.** The house-life step that proposes and accepts (0172 roles, 0145 agendas, desire clock); the player recorder path (assurance kind `pact`).
4. **Betrayal and learning.** The break fold with sealed-ballot pool split; the told-claims routes; the history kind and Vault canary; the 0043 / 0107 / 0172 amendments and the README index row.

## 7. Open questions for Ryne

1. **Stored row vs 0002.** Is a per-week pact row (members, target, lapses at the vote) acceptable under ADR 0002 alongside the named alliances and assurances already stored? The alternative is to derive the pact from the scene history on every read, which is the slower and fuzzier route.
2. **Is it a promise to each other or a plan the group keeps?** Does breaking the pact cost like a broken vote promise (0.12 trust, the same fold) or more, like betraying a named alliance (0107 multiplier)?
3. **The old shared-target lean.** The prototypes that removed it cost solid wins (24 down to 18-20 per 300). Remove it (the design above), keep it beside the pact, or keep it only when no pact exists?
4. **How big a bloc effect is right?** The card gives +1.6 points (w=0.33) to +4.3 points (w=1.0) of vote agreement. Is +1.5 to 2 points the target, or must it return to the +2.6 to +3.7 the claim was written at?
5. **Which gate yields if the two cannot both hold?** Lift against F2 reach: the Auditor's sweep found no weight with both. Ryne's order, please.
6. **The player in a pact.** The player's word in a scene records a pact; does an NPC pact ever name the player as the target, and does the player see the proposal only when in the room?
7. **Decline and defect.** Can a houseguest decline to join a pact and stay in the alliance, or does declining shrink the alliance's detected bloc?
