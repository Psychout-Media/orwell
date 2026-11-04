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
  | "assuranceVoteFor" | "assuranceProtects" | "pitchTiltFor";

export type StrategicDecision = "evictionVote" | "hohNominations" | "replacementNominee" | "vetoSave";

export const DECISION_SOURCES: Readonly<Record<StrategicDecision, readonly MemoryProvider[]>> = {
  // `voteChoice` (liveSeason.ts): the NPC eviction vote - reads the most.
  evictionVote: ["dealsOf", "campaignTiltFor", "memoryTiltFor", "beliefTiltFor", "assuranceVoteFor"],
  // The NPC HOH's `nominationPlan(...)` call in `advanceBeat` case "nominations".
  hohNominations: ["campaignPushFor", "memoryTiltFor", "beliefTiltFor", "assuranceProtects", "pitchTiltFor"],
  // The NPC HOH's replacement pick (`replacementPick(...)`).
  replacementNominee: ["campaignPushFor", "memoryTiltFor", "beliefTiltFor"],
  // The NPC veto holder's save (`chooseVetoSave(...)`): campaign bias only - a KNOWN GAP (approved tie-in #1: the veto should read memory, deals and beliefs too).
  vetoSave: ["campaignPushFor"],
};

/** Providers deliberately read by NO strategic decision yet (a write-only / not-yet-wired source). Empty today; an entry needs a reason. */
export const UNREAD_PROVIDERS_ALLOWED: Readonly<Partial<Record<MemoryProvider, string>>> = {};
