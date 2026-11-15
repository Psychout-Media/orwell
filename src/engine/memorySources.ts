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
  | "assuranceVoteFor" | "assuranceProtects" | "pitchTiltFor" | "vetoMemoryFor" | "dealNomPushFor" | "juryMemoryFor" | "tieNomPushFor" | "tieVotePushFor" | "hcMemoryFor" | "hcStrategyFor" | "endgameMemoryFor" | "approachMemoryFor" | "moodTiltFor" | "drivePushFor" | "moodVetoFor" | "moodApproachFor";

export type StrategicDecision = "evictionVote" | "hohNominations" | "replacementNominee" | "vetoSave" | "houseguestsChoice" | "juryVote" | "approaches" | "final3Eviction" | "secretVetoReplacement";

export const DECISION_SOURCES: Readonly<Record<StrategicDecision, readonly MemoryProvider[]>> = {
  // `voteChoice` (liveSeason.ts): the NPC eviction vote - reads the most.
  evictionVote: ["dealsOf", "tieVotePushFor", "campaignTiltFor", "memoryTiltFor", "beliefTiltFor", "assuranceVoteFor", "moodTiltFor"],
  // The NPC HOH's `nominationPlan(...)` call in `advanceBeat` case "nominations".
  hohNominations: ["campaignPushFor", "tieNomPushFor", "memoryTiltFor", "beliefTiltFor", "assuranceProtects", "pitchTiltFor", "dealNomPushFor", "moodTiltFor", "drivePushFor"],
  // The NPC HOH's replacement pick (`replacementPick(...)`).
  replacementNominee: ["campaignPushFor", "memoryTiltFor", "beliefTiltFor", "moodTiltFor", "drivePushFor"],
  // The NPC veto holder's save (`chooseVetoSave(...)`): campaign bias + (B7 M1, ORWELL_VETO_MEMORY) one combined memory/belief/deal bias.
  vetoSave: ["campaignPushFor", "vetoMemoryFor", "moodVetoFor", "drivePushFor"],
  // The NPC Houseguest's-Choice holder's sixth-player pick (`resolveVetoDraw` -> `chooseStrongestBond`): strongest bond + (B7 M4b, ORWELL_HC_MEMORY) the same combined memory/belief/deal read.
  houseguestsChoice: ["hcMemoryFor", "hcStrategyFor"],
  // Each juror's finale vote (`precomputeVotes`): relationship + manner + game respect + (B26, ORWELL_JURY_MEMORY) the juror's memory of the finalist.
  juryVote: ["juryMemoryFor"],
  // Who approaches the player (`rankApproaches` in conversation.ts, called by the adapter's `socialInitiatives`): edges + (B7 M1b, ORWELL_APPROACH_MEMORY) one memory/owed bias passed as the `memoryBias` hook,
  // NOT a SeasonCtx provider - held by tests/unit/approachMemory.test.ts instead of the liveSeason scan.
  // ORW-87: the NPC final HOH's Final-3 eviction (threat + memory) and the secret-veto replacement (nomination score + memory) read the ledger via `endgameMemoryFor` (ORWELL_ENDGAME_MEMORY, played games only).
  final3Eviction: ["endgameMemoryFor"],
  secretVetoReplacement: ["endgameMemoryFor"],
  approaches: ["approachMemoryFor", "moodApproachFor"],
};

/** Providers deliberately read by NO strategic decision yet (a write-only / not-yet-wired source). Empty today; an entry needs a reason. */
export const UNREAD_PROVIDERS_ALLOWED: Readonly<Partial<Record<MemoryProvider, string>>> = {};

/**
 * B52 / AMEND 3b - the SAME gate extended to the decisions that are not a `ctx.<provider>` read in the pure loop (their reads are other named calls, or live in the adapter): the HOH tie-break,
 * the jury vote, the Final-3 eviction, the secret-veto replacement, NPC deal consent, and where an NPC chooses to go. Each lists the memory-like TOKENS its source actually reads today
 * (`tests/unit/memoryDecisionMatrixAll.test.ts` holds the code to it, both ways). `voteChoice` means "delegates to the eviction vote, so it reads every evictionVote provider".
 * `OTHER_DECISION_GAPS` is the honest list of what each one does NOT yet read, as input to a deliberate wiring decision (never to be wired silently).
 */
export type OtherDecision = "tieBreak" | "jury" | "dealConsent" | "movement";

export const OTHER_DECISION_READS: Readonly<Record<OtherDecision, readonly string[]>> = {
  tieBreak: ["voteChoice"],
  jury: ["edgeAsJuryRel", "gameRespectTerm", "appealPerf", "jurorProfile"], // A62: the recorded manner (and a juror's possibly mistaken blame) now arrives inside edgeAsJuryRel, no separate mannerFor read
  dealConsent: ["memoryGrudge", "memoryFavor", "targetsMeTilt", "moodDealFor"],
  movement: ["bondStrength", "applyWantToPulls"],
};

export const OTHER_DECISION_GAPS: Readonly<Record<OtherDecision, string>> = {
  tieBreak: "none - it is the eviction vote, so it inherits every evictionVote provider",
  jury: "reads the edge, the recorded manner (the grudge book), the game-respect resume, the juror profile and the Q&A appeal; not the NPC memory ledger, beliefs, mood or tells (the jury has its own grievance model)",
  dealConsent: "edges + grudge/favor + the targets-me belief + (B31) mood; not an NPC's own drive or an open campaign against the proposer",
  movement: "edges (bond/threat) + the want; not memory, belief, mood or the NPC's drive",
};
