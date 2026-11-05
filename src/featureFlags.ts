import { defaultOnFrom } from './domain/flagDefaults';

/**
 * #1843 — Single source of truth for all opt-in behavioral-fidelity and sleep-economy
 * feature flags reported by `/health`'s `bootFlags()` block.
 *
 * Before this file, the flag definitions were duplicated across:
 *   - `src/adapters/mcp/HttpMcpServer.ts` (the inline `bootFlags()` function)
 *   - `tests/integration/httpServer.test.ts` (the hardcoded guard-test array)
 *
 * Now both consume this registry, so adding/removing a flag edits exactly one place.
 */

/**
 * How `process.env` values are coerced to boolean.
 *
 * - `strict` — only `=== '1'` is true; anything else (unset, '0', 'false') is false.
 * - `loose` — `'1'`, `'true'`, `'on'` are all true; used for flags whose runtime getter also
 *   accepts human-readable truth strings (seededTieSurfacing, timeOfDay).
 * - `inverted` — ANY value except `'0'` is true; used for flags that default ON (timePerConversation,
 *   socialFatigue).
 */
export type ParserKind = 'strict' | 'loose' | 'inverted' | 'defaultOn';

/** One entry in the canonical flag registry. */
export interface FeatureFlagDef {
  /**
   * The `process.env` variable name (e.g. `'ORWELL_CAMPAIGNS'`).
   */
  envKey: string;
  /**
   * The camelCase key exported by `bootFlagsFromEnv()` and expected in the `/health` JSON body.
   */
  key: string;
  /**
   * Which parser to apply — see `ParserKind` docs.
   */
  parser: ParserKind;
}

/**
 * All flags in display (and deployment-doc) order.
 *
 * ADDING A NEW FLAG: append it here and it will automatically appear in `/health` and the guard
 * test. DELETING: remove the entry and the contract shrinks cleanly.
 *
 * ⚠  The envKey must match what the engine's adapter actually reads at runtime (case-sensitive).
 *    See `GameSessionAdapter` module consts for the definitive list of env var names.
 */
export const FEATURE_FLAGS: FeatureFlagDef[] = [
  { envKey: 'ORWELL_CAMPAIGNS',              key: 'campaigns',              parser: 'defaultOn' },
  { envKey: 'ORWELL_TRAJECTORIES',           key: 'trajectories',           parser: 'defaultOn' },
  { envKey: 'ORWELL_TRIGGERS',               key: 'triggers',               parser: 'defaultOn' },
  { envKey: 'ORWELL_SECRET_PACING',          key: 'secretPacing',           parser: 'defaultOn' },
  { envKey: 'ORWELL_JURY_HOUSE',             key: 'juryHouse',              parser: 'defaultOn' },
  { envKey: 'ORWELL_SEEDED_TIE_SURFACING',   key: 'seededTieSurfacing',    parser: 'defaultOn' },
  { envKey: 'ORWELL_MYTH_MAKING',            key: 'mythMaking',             parser: 'defaultOn' },
  { envKey: 'ORWELL_SHOWRUNNER',             key: 'showrunner',             parser: 'defaultOn' },
  { envKey: 'ORWELL_COMP_INTENT',            key: 'compIntent',             parser: 'defaultOn' },
  { envKey: 'ORWELL_VOTE_DEDUCTION',         key: 'voteDeduction',          parser: 'defaultOn' },
  { envKey: 'ORWELL_TIME_OF_DAY',            key: 'timeOfDay',              parser: 'defaultOn' },
  { envKey: 'ORWELL_DEAL_DEPTH',             key: 'dealDepth',              parser: 'defaultOn' },
  { envKey: 'ORWELL_NPC_MEMORY',             key: 'npcMemory',              parser: 'defaultOn' },
  { envKey: 'ORWELL_STRATEGIC_CADENCE',      key: 'strategicCadence',       parser: 'defaultOn' },
  { envKey: 'ORWELL_SCHEME_TARGETS',         key: 'schemeTargets',          parser: 'defaultOn' },
  { envKey: 'ORWELL_CONFESSIONAL_DEPTH',     key: 'confessionalDepth',      parser: 'defaultOn' },
  { envKey: 'ORWELL_NPC_DEAL_OFFERS',        key: 'npcDealOffers',          parser: 'defaultOn' },
  { envKey: 'ORWELL_SOUL_DEPTH',             key: 'soulDepth',              parser: 'defaultOn' },
  { envKey: 'ORWELL_COMP_MECHANICS_PLUS',    key: 'compMechanicsPlus',      parser: 'defaultOn' },
  { envKey: 'ORWELL_COMP_MIXED',             key: 'compMixed',              parser: 'defaultOn' },
  { envKey: 'ORWELL_FINAL_HOH_THREE_PART',   key: 'finalHohThreePart',      parser: 'defaultOn' },
  { envKey: 'ORWELL_GOSSIP_DRIFT',           key: 'gossipDrift',            parser: 'defaultOn' },
  { envKey: 'ORWELL_SECRET_BARTER',          key: 'secretBarter',           parser: 'defaultOn' },
  { envKey: 'ORWELL_TIME_PER_CONVERSATION',  key: 'timePerConversation',    parser: 'inverted' },
  { envKey: 'ORWELL_SOCIAL_FATIGUE',         key: 'socialFatigue',          parser: 'inverted' },
  { envKey: 'ORWELL_MULTI_NIGHT_FATIGUE',    key: 'multiNightFatigue',      parser: 'defaultOn' },
  // 0025 reactive twists: default-ON (PO ruling 2026-11-03, "I want to know if this breaks the game"; the FE `secret-veto` card is built, #2015). `=0`/`false`/`off`
  // opts out and `ORWELL_FLAGS_OFF=1` forces it off, like every default-on flag. There is deliberately no God-Mode dial entry: the sealed twist plan is fixed at
  // `createCharacter`, so a mid-season dial would do nothing.
  { envKey: 'ORWELL_REACTIVE_TWISTS',        key: 'reactiveTwists',         parser: 'defaultOn' },
  { envKey: 'ORWELL_PLAYER_DOSSIER', key: 'playerDossier', parser: 'defaultOn' },
  { envKey: 'ORWELL_TRAITORS_FURY', key: 'traitorsFury', parser: 'defaultOn' },
  { envKey: 'ORWELL_PRODUCER_READ', key: 'producerRead', parser: 'defaultOn' },
  { envKey: 'ORWELL_DEAL_WITNESSES', key: 'dealsWitnesses', parser: 'defaultOn' },
  { envKey: 'ORWELL_BOOTH_RECEIPTS', key: 'boothReceipts', parser: 'defaultOn' },
  // #2017 S0a: the NPC belief store. Default-ON (PO ruling 2026-11-04, Ryne: "turn it on"); `=0`/`false`/`off` opts out, `ORWELL_FLAGS_OFF=1` forces off.
  { envKey: 'ORWELL_NPC_BELIEFS', key: 'npcBeliefs', parser: 'defaultOn' },
  // B2 / #2017: read the NPC memory standalone so remembered betrayals/favors visibly sway votes + nominations. Default-ON (PO: "memories should be turned on", 2026-11-04) after the 3-arm PO-band re-measure.
  { envKey: 'ORWELL_NPC_MEMORY_STANDALONE', key: 'npcMemoryStandalone', parser: 'defaultOn' },
  // B2 follow-on: write the memories a season actually produces (remembered nominations, withheld vetoes, kept deals). Default-ON with the standalone read.
  { envKey: 'ORWELL_NPC_MEMORY_WRITERS', key: 'npcMemoryWriters', parser: 'defaultOn' },
  { envKey: 'ORWELL_HANGOUT',               key: 'hangOut',                parser: 'defaultOn' },
  { envKey: 'ORWELL_PREMIERE_ENTRANCES',   key: 'premiereEntrances',      parser: 'defaultOn' },
  // B3 / #2017 (+B3b vote term): the HOH nominates / the house votes from its BELIEF about who is targeting it (needs ORWELL_NPC_BELIEFS). Default-ON with it (PO 2026-11-04).
  { envKey: 'ORWELL_NPC_BELIEF_NOMS', key: 'npcBeliefNoms', parser: 'defaultOn' },
  // B6 / #2017: NPC-to-NPC lobbying of the HOH (a bounded pitch tilt in the nomination score). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_LOBBYING', key: 'lobbying', parser: 'defaultOn' },
  // B4 / #2017: casual assurances ("you're safe with me") recorded on scenes. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_ASSURANCES', key: 'assurances', parser: 'defaultOn' },
  // B7 / #2017 M1: the NPC veto save also reads memory / beliefs / owed deals. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_VETO_MEMORY', key: 'vetoMemory', parser: 'defaultOn' },
  // A49 / #2017 E1a: npcVoice hands the narrator each PRESENT houseguest's observable tells (top 2, words only). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_NPC_TELLS', key: 'npcTells', parser: 'defaultOn' },
  // A54 / #2017 M5: npcVoice hands the narrator what the NPC remembers about the player (top 3 plain facts) + an engine-decided, rate-limited bringUp. OFF unless exactly '1'; never-flipped.
  // B29 / #2017 E3: observers react to a visible tell (comfort / exploit / avoid; needs ORWELL_NPC_TELLS). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_TELL_REACTIONS', key: 'tellReactions', parser: 'defaultOn' },
  // B30 / #2017 E4a: a visibly rattled veto holder rescues the nominee they are close to (needs ORWELL_NPC_TELLS). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MOOD_VETO', key: 'moodVeto', parser: 'defaultOn' },
  // B30 / #2017 E4a: who seeks the player out reads the NPC's visible emotional state (needs ORWELL_NPC_TELLS). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MOOD_APPROACH', key: 'moodApproach', parser: 'defaultOn' },
  // B31 / #2017 E4b: visible mood shifts NPC deal consent (protection accepted more when rattled) and campaign formation (a rattled NPC forms none). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MOOD_DEAL', key: 'moodDeal', parser: 'defaultOn' },
  { envKey: 'ORWELL_MOOD_CAMPAIGN', key: 'moodCampaign', parser: 'defaultOn' },
  // B32 / #2017 E5: chat betrayal/conflict feed the emotional arc and temperament drift gets a negativity bias (clash x1.5, bond x0.75) so hardening is reachable. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_DRIFT_FIX', key: 'driftFix', parser: 'defaultOn' },
  // B51 / AMEND 3b: the HOH's / veto holder's own drive (target adds, build protects) feeds its nomination and veto-save scores. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_DRIVE_DECISIONS', key: 'driveDecisions', parser: 'defaultOn' },
  { envKey: 'ORWELL_NPC_MEMORY_SPEECH', key: 'npcMemorySpeech', parser: 'defaultOn' },
  // B27: the forgiveness trait (a seeded ~1-in-6 grudge-keeper whose real betrayals keep a floor; everyone else's favors fade fast). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_FORGIVENESS', key: 'forgiveness', parser: 'defaultOn' },
  // B22: houseguests who HEARD a promise (a casual assurance) remember its keeping / breaking too, at a lower weight. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MEMORY_PROMISES', key: 'memoryPromises', parser: 'defaultOn' },
  // B7 M4b: an NPC Houseguest's-Choice holder's sixth-player pick reads their memory/beliefs/owed deals beside the bond. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_HC_MEMORY', key: 'hcMemory', parser: 'defaultOn' },
  // B7 M1b: who approaches the player reads the NPC's memory of them (favor/owed promise => seek out; grudge => avoid). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_APPROACH_MEMORY', key: 'approachMemory', parser: 'defaultOn' },
  // B7 / #2017 M3: open protective deals also feed the HOH's nominations. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_DEAL_NOMS', key: 'dealNoms', parser: 'defaultOn' },
  // B7 / #2017 M4: campaign targets also read grudges and beliefs. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_CAMPAIGN_MEMORY', key: 'campaignMemory', parser: 'defaultOn' },
  // B5 / #2017: vote counting - an evict campaign forms only while the actor believes the count is in doubt. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_VOTE_COUNT', key: 'voteCount', parser: 'defaultOn' },
  // A22: NPC approaches during the Day-1 social morning after the toast. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MORNING_APPROACH', key: 'morningApproach', parser: 'defaultOn' },
  // B10 / B11 / #2017: information spreads only by co-presence, by the holder's choice (share / slip / hold) instead of automatic graph diffusion. OFF unless exactly '1'; never-flipped.
  { envKey: 'ORWELL_GOSSIP_COPRESENCE', key: 'gossipCopresence', parser: 'strict' },
  // Anti-sycophancy: the ENGINE decides whether an NPC agrees to a player's proposed deal (from the NPC's own read of the player); a refusal records nothing. Default-ON; `=0` restores today's record-every-deal behaviour.
  { envKey: 'ORWELL_NPC_DEAL_CONSENT', key: 'npcDealConsent', parser: 'defaultOn' },
  // B26: a juror's finale lean also reads their memory of the finalist (a grudge lowers, a favor raises; bounded). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_JURY_MEMORY', key: 'juryMemory', parser: 'defaultOn' },
];

/** The parsers, keyed by kind, to avoid re-creating closures on every call. */
function strict(v: string | undefined): boolean  { return v === '1'; }
function loose(v: string | undefined): boolean   { return v === '1' || v === 'true' || v === 'on'; }
// ON unless explicitly '0' — exactly the engine's own read (`!== "0"`), so unset reports ON like the engine runs.
function inverted(v: string | undefined): boolean { return v !== '0'; }

// The ONE parser (shared with the engine's own flag reads, src/domain/flagDefaults.ts) — /health can never diverge from it.
function defaultOn(v: string | undefined): boolean { return defaultOnFrom(v, process.env.ORWELL_FLAGS_OFF); }

const PARSERS: Record<ParserKind, (v: string | undefined) => boolean> = {
  strict,
  loose,
  inverted,
  defaultOn,
};

/**
 * Reads every known feature flag from `process.env` and returns a flat `Record<string, boolean>`
 * with the camelCase keys as used by `/health`.
 *
 * This is the single function HTTP transports and health endpoints should call; it avoids the
 * duplication risk of each consumer maintaining its own inline `strict`/`loose`/`inverted` closures.
 *
 * NOTE: this reflects the process's BOOT env; the God-Mode `setBehavioralFlags` dial can override
 * a layer per-sandbox at runtime, so this is the deploy default, not necessarily a given live
 * sandbox's current setting.
 */
export function bootFlagsFromEnv(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const { envKey, key, parser } of FEATURE_FLAGS) {
    result[key] = PARSERS[parser](process.env[envKey]);
  }
  return result;
}

/**
 * Returns just the camelCase key names of all registered feature flags — useful in tests to avoid
 * a hardcoded literal array that drifts out of sync with the registry.
 */
export function bootFlagKeys(): string[] {
  return FEATURE_FLAGS.map((f) => f.key);
}
