/**
 * B7 / #2017 M0 - the DECISION x MEMORY-SOURCE table: the ONE place that says which memory-like provider each strategic decision reads. Data only (no behaviour), so it can later back a unified
 * `MemoryView.read(holder, subject, decision)`; today it is the contract that `tests/unit/memoryDecisionMatrix.test.ts` holds the live code to. A decision that starts reading a provider
 * not listed here (or stops reading a listed one) fails that gate until this table is updated - which is the point (Ryne: "all the memory places should be considered in strategic decisions").
 *
 * Providers are the `SeasonCtx` members the pure loop calls (`ctx.<name>`): the memory ledger (`memoryTiltFor`), the belief store (`beliefTiltFor`), campaigns/drives (`campaignTiltFor` /
 * `campaignPushFor`), open deals (`dealsOf`), casual assurances (`assuranceVoteFor` / `assuranceProtects`) and lobbying pitches (`pitchTiltFor`). Edges (trust/threat/bond) are always read and
 * are not listed.
 */
export type MemoryProvider =
  | "memoryTiltFor" | "beliefTiltFor" | "campaignTiltFor" | "campaignPushFor" | "dealsOf"
  | "assuranceVoteFor" | "assuranceProtects" | "pitchTiltFor" | "vetoMemoryFor" | "dealNomPushFor" | "juryMemoryFor" | "hcMemoryFor" | "approachMemoryFor";

export type StrategicDecision = "evictionVote" | "hohNominations" | "replacementNominee" | "vetoSave" | "houseguestsChoice" | "juryVote" | "approaches";

export const DECISION_SOURCES: Readonly<Record<StrategicDecision, readonly MemoryProvider[]>> = {
  // `voteChoice` (liveSeason.ts): the NPC eviction vote - reads the most.
  evictionVote: ["dealsOf", "campaignTiltFor", "memoryTiltFor", "beliefTiltFor", "assuranceVoteFor"],
  // The NPC HOH's `nominationPlan(...)` call in `advanceBeat` case "nominations".
  hohNominations: ["campaignPushFor", "memoryTiltFor", "beliefTiltFor", "assuranceProtects", "pitchTiltFor", "dealNomPushFor"],
  // The NPC HOH's replacement pick (`replacementPick(...)`).
  replacementNominee: ["campaignPushFor", "memoryTiltFor", "beliefTiltFor"],
  // The NPC veto holder's save (`chooseVetoSave(...)`): campaign bias + (B7 M1, ORWELL_VETO_MEMORY) one combined memory/belief/deal bias.
  vetoSave: ["campaignPushFor", "vetoMemoryFor"],
  // The NPC Houseguest's-Choice holder's sixth-player pick (`resolveVetoDraw` -> `chooseStrongestBond`): strongest bond + (B7 M4b, ORWELL_HC_MEMORY) the same combined memory/belief/deal read.
  houseguestsChoice: ["hcMemoryFor"],
  // Each juror's finale vote (`precomputeVotes`): relationship + manner + game respect + (B26, ORWELL_JURY_MEMORY) the juror's memory of the finalist.
  juryVote: ["juryMemoryFor"],
  // Who approaches the player (`rankApproaches` in conversation.ts, called by the adapter's `socialInitiatives`): edges + (B7 M1b, ORWELL_APPROACH_MEMORY) one memory/owed bias passed as the `memoryBias` hook,
  // NOT a SeasonCtx provider - held by tests/unit/approachMemory.test.ts instead of the liveSeason scan.
  approaches: ["approachMemoryFor"],
};

/** Providers deliberately read by NO strategic decision yet (a write-only / not-yet-wired source). Empty today; an entry needs a reason. */
export const UNREAD_PROVIDERS_ALLOWED: Readonly<Partial<Record<MemoryProvider, string>>> = {};
