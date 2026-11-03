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
export type ParserKind = 'strict' | 'loose' | 'inverted';

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
  { envKey: 'ORWELL_CAMPAIGNS',              key: 'campaigns',              parser: 'strict' },
  { envKey: 'ORWELL_TRAJECTORIES',           key: 'trajectories',           parser: 'strict' },
  { envKey: 'ORWELL_TRIGGERS',               key: 'triggers',               parser: 'strict' },
  { envKey: 'ORWELL_SECRET_PACING',          key: 'secretPacing',           parser: 'strict' },
  { envKey: 'ORWELL_JURY_HOUSE',             key: 'juryHouse',              parser: 'strict' },
  { envKey: 'ORWELL_SEEDED_TIE_SURFACING',   key: 'seededTieSurfacing',    parser: 'loose' },
  { envKey: 'ORWELL_MYTH_MAKING',            key: 'mythMaking',             parser: 'strict' },
  { envKey: 'ORWELL_SHOWRUNNER',             key: 'showrunner',             parser: 'strict' },
  { envKey: 'ORWELL_COMP_INTENT',            key: 'compIntent',             parser: 'strict' },
  { envKey: 'ORWELL_VOTE_DEDUCTION',         key: 'voteDeduction',          parser: 'strict' },
  { envKey: 'ORWELL_TIME_OF_DAY',            key: 'timeOfDay',              parser: 'loose' },
  { envKey: 'ORWELL_DEAL_DEPTH',             key: 'dealDepth',              parser: 'strict' },
  { envKey: 'ORWELL_NPC_MEMORY',             key: 'npcMemory',              parser: 'strict' },
  { envKey: 'ORWELL_STRATEGIC_CADENCE',      key: 'strategicCadence',       parser: 'strict' },
  { envKey: 'ORWELL_SCHEME_TARGETS',         key: 'schemeTargets',          parser: 'strict' },
  { envKey: 'ORWELL_CONFESSIONAL_DEPTH',     key: 'confessionalDepth',      parser: 'strict' },
  { envKey: 'ORWELL_NPC_DEAL_OFFERS',        key: 'npcDealOffers',          parser: 'strict' },
  { envKey: 'ORWELL_SOUL_DEPTH',             key: 'soulDepth',              parser: 'strict' },
  { envKey: 'ORWELL_COMP_MECHANICS_PLUS',    key: 'compMechanicsPlus',      parser: 'strict' },
  { envKey: 'ORWELL_COMP_MIXED',             key: 'compMixed',              parser: 'strict' },
  { envKey: 'ORWELL_GOSSIP_DRIFT',           key: 'gossipDrift',            parser: 'strict' },
  { envKey: 'ORWELL_SECRET_BARTER',          key: 'secretBarter',           parser: 'strict' },
  { envKey: 'ORWELL_TIME_PER_CONVERSATION',  key: 'timePerConversation',    parser: 'inverted' },
  { envKey: 'ORWELL_SOCIAL_FATIGUE',         key: 'socialFatigue',          parser: 'inverted' },
  { envKey: 'ORWELL_MULTI_NIGHT_FATIGUE',    key: 'multiNightFatigue',      parser: 'strict' },
  { envKey: 'ORWELL_PLAYER_DOSSIER', key: 'playerDossier', parser: 'strict' },
  { envKey: 'ORWELL_TRAITORS_FURY', key: 'traitorsFury', parser: 'strict' },
  { envKey: 'ORWELL_PRODUCER_READ', key: 'producerRead', parser: 'strict' },
  { envKey: 'ORWELL_DEAL_WITNESSES', key: 'dealsWitnesses', parser: 'strict' },
  { envKey: 'ORWELL_BOOTH_RECEIPTS', key: 'boothReceipts', parser: 'strict' },
];

/** The parsers, keyed by kind, to avoid re-creating closures on every call. */
function strict(v: string | undefined): boolean  { return v === '1'; }
function loose(v: string | undefined): boolean   { return v === '1' || v === 'true' || v === 'on'; }
// ON unless explicitly '0' — exactly the engine's own read (`!== "0"`), so unset reports ON like the engine runs.
function inverted(v: string | undefined): boolean { return v !== '0'; }

const PARSERS: Record<ParserKind, (v: string | undefined) => boolean> = {
  strict,
  loose,
  inverted,
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
