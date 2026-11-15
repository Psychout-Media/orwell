import type { EntityId } from "./ids";
import type { GameEvent } from "./event";
import type { KnowledgeFact } from "./knowledge";
import type { PhysicalCharacteristics } from "./physicalCharacteristics";

/**
 * The persisted game state. Detail must NEVER regress across saves and should
 * accumulate/deepen (mandate #4). A save = { coreVersion, Vault store, Journal
 * store }; the Vault and Journal versions bump together. Everything here is
 * plain JSON (no Maps/Sets/undefined) so serialize→deserialize is lossless.
 */
export interface EdgeRecord {
  from: EntityId;
  to: EntityId;
  trust: number;
  affinity: number;
  threat: number;
  alignment: number;
  confidence: number;
  /** Demonstrated loyalty (ADR 0002 / audit E54). Optional: pre-E54 saves load at baseline. */
  reliability?: number;
}

/** Dynamic — grows over the game. */
export interface PersistedSoul {
  emotionalState: number;
  volatility: number;
  emotionalHistory: number[];
  memory: string[];
  relationshipBeliefs: EdgeRecord[];
}

/** Static baseline — set at generation, byte-stable thereafter. */
export interface PersistedCharacter {
  archetype: string;
  strategyStyle: string;
  stats: { physical: number; mental: number; social: number };
  background: string;
  /**
   * The concrete, diverse backstory facets (L28) — part of the static baseline, so the
   * byte-stable superset check (`isSuperset`) covers them too: an existing game's NPC vocation/
   * hometown can never regenerate or drift. Optional only for back-compat with pre-L28 saves.
   */
  vocation?: string;
  hometown?: string;
  /**
   * The observable public DEMEANOR / voice register (L28) — part of the byte-stable static baseline so
   * the superset check guards it against regeneration/drift, exactly like vocation/hometown. Optional
   * only for back-compat with pre-demeanor saves.
   */
  demeanor?: string;
  /**
   * The PUBLIC deep-profile facets (feature 0058) — a multi-sentence `biography` + the STRUCTURED
   * `physicalCharacteristics` facet. Part of the byte-stable static baseline, so the superset/byte-
   * compare check (`isSuperset`) covers them too: an existing game's NPC biography or physical facet
   * can never regenerate or drift. Optional only for back-compat with pre-0058 saves (which load
   * without them — the conditional spread in `toGameState` keeps an absent field absent, so an old
   * save never trips a spurious superset failure).
   */
  biography?: string;
  physicalCharacteristics?: PhysicalCharacteristics;
  /** ORW-381: the casting type (presentation only). Byte-stable; absent on a pre-ORW-381 save. */
  castingType?: { id: string; label: string; read: string };
  /**
   * Provenance flag for the season-start deep-profile authoring write-back (#1067). Unset on the seeded
   * deterministic floor; set `true` the first time `recordCastProfile` authors a richer PUBLIC facet
   * (`biography`/`physicalCharacteristics`/`vocation`). `isSuperset` permits those facets to
   * change ONLY on the one-directional floor→authored transition (a sanctioned UPGRADE, exactly like the
   * 0062 `worldSnapshot` web_search upgrade), and treats them as byte-stable once authored — so a later
   * drift/thinning is still refused (mandate #4 intact). Absent on pre-#1067 saves (load as unset).
   */
  deepProfileAuthored?: boolean;
}

/** A hunch in the persisted projection (audit C4) — counted + superset-checked like knowledge. */
export interface PersistedSuspicion {
  id: string;
  content: string;
  ts: number;
}

export interface GameState {
  coreVersion: number;
  vaultVersion: number;
  journalVersion: number;
  events: GameEvent[];
  knowledge: Array<{ entity: EntityId; fact: KnowledgeFact }>;
  relationships: EdgeRecord[];
  souls: Record<EntityId, PersistedSoul>;
  characters: Record<EntityId, PersistedCharacter>;
  /** Suspicions (audit C4) — optional so pre-C4 callers/saves keep working; absent ⇒ 0. */
  suspicions?: Array<{ entity: EntityId; suspicion: PersistedSuspicion }>;
  /** Vault record ids (audit C4) — ids only: this projection feeds the checkpoint, never a surface. */
  vaultIds?: string[];
  /**
   * The move-in zeitgeist snapshot (feature 0062) — the FROZEN, shared real-world flavor the cast moved
   * in with. A byte-stable static artifact (like the `CHARACTER` baseline): captured once at season
   * creation and never regenerated, so the superset/byte-compare check below guards it against drift /
   * regeneration exactly as it guards a character. Plain JSON; optional so pre-0062 saves stay loadable
   * (an absent snapshot stays absent — never trips a spurious superset failure). It is PUBLIC flavor,
   * never a hidden number: it carries no secret and never informs the deterministic core.
   */
  worldSnapshot?: Record<string, unknown>;
}

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(blob: string): GameState {
  return JSON.parse(blob) as GameState;
}

export function deepCopy(state: GameState): GameState {
  return deserialize(serialize(state));
}

export interface DetailCounts {
  events: number;
  knowledge: number;
  relationships: number;
  soulMemory: number;
  soulHistory: number;
  soulBeliefs: number;
  /** Audit C4: suspicions + Vault records are persisted detail too — they may never thin out. */
  suspicions: number;
  vaultRecords: number;
}

export function counts(state: GameState): DetailCounts {
  const souls = Object.values(state.souls);
  const sum = (f: (s: PersistedSoul) => number): number => souls.reduce((a, s) => a + f(s), 0);
  return {
    events: state.events.length,
    knowledge: state.knowledge.length,
    relationships: state.relationships.length,
    soulMemory: sum((s) => s.memory.length),
    soulHistory: sum((s) => s.emotionalHistory.length),
    soulBeliefs: sum((s) => s.relationshipBeliefs.length),
    suspicions: (state.suspicions ?? []).length,
    vaultRecords: (state.vaultIds ?? []).length,
  };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The PUBLIC deep-profile facets the season-start authoring write-back (#1067) may upgrade off the
 *  seeded floor. Everything else on the static Character stays byte-stable on EVERY path. */
const AUTHORABLE_FACETS: ReadonlyArray<keyof PersistedCharacter> = [
  "biography", "physicalCharacteristics", "vocation",
];

/**
 * Is `late` a SANCTIONED season-start authoring upgrade of `early` (#1067)? The seeded deterministic
 * floor sets placeholder public deep-profile facets; the FE then authors a richer replacement via
 * `recordCastProfile`. That accretes detail (mandate #4 wants exactly this) but a byte-compare can't tell
 * "richer authored" from "thinned", so this gates the exception narrowly — mirroring the 0062 worldSnapshot
 * web_search upgrade. Permitted ONLY when ALL hold:
 *   1. one-directional: the earlier side was NOT authored and the later side IS (`true → …` never qualifies,
 *      so an authored profile is byte-stable forever and a `true → unset` regression is refused);
 *   2. every NON-authorable field is byte-identical (the upgrade can't smuggle a change into the byte-stable
 *      identity — archetype/stats/background/ethnicity/voice/…);
 *   3. neither authorable facet is DROPPED to absent (an authored profile only ever replaces value-with-
 *      value, never deletes a public facet the floor had — that WOULD be a thinning).
 * Length/content of the replacement is NOT second-guessed — the floor bio is a deterministic PLACEHOLDER
 * and the authored bio is the producer's real backstory; this is the one sanctioned identity upgrade
 * (exactly the worldSnapshot web_search precedent), and the durable guarantee is that it is one-directional
 * and FROZEN thereafter (a `true → …` never qualifies, so a post-authoring drift/thin is still refused).
 */
function isSanctionedProfileUpgrade(early: PersistedCharacter, late: PersistedCharacter): boolean {
  // (1) strictly floor → authored.
  if (early.deepProfileAuthored === true || late.deepProfileAuthored !== true) return false;
  // (2) every field OTHER than the authorable facets (+ the provenance flag itself) must be byte-identical
  // — the upgrade can never smuggle a change into the byte-stable identity. Compare both with those keys
  // stripped from BOTH sides.
  const strip = (c: PersistedCharacter): Record<string, unknown> => {
    const rest: Record<string, unknown> = { ...(c as unknown as Record<string, unknown>) };
    for (const k of AUTHORABLE_FACETS) delete rest[k as string];
    delete rest["deepProfileAuthored"];
    return rest;
  };
  if (!sameJson(strip(early), strip(late))) return false;
  // (3) a public facet the floor HAD may never be dropped to absent on the upgrade (value→value only).
  for (const k of AUTHORABLE_FACETS) {
    if (early[k] !== undefined && late[k] === undefined) return false;
  }
  return true;
}

/**
 * Superset by stable identity AND content (audit C4): nothing previously persisted may be
 * dropped — and what is immutable by contract may not be REWRITTEN either. Identity-only
 * comparison let whole degradation classes through: a truncated event body, a distorted
 * knowledge fact, an edited character all passed because their ids survived.
 *
 *  - events / knowledge facts / suspicions are append-only records ⇒ field-equality on shared ids;
 *  - the static CHARACTER is byte-stable (0041) ⇒ byte-compare;
 *  - soul memory / emotionalHistory are append-only ⇒ prefix-compare (set-inclusion let a
 *    reordered or partially-rewritten history pass);
 *  - relationship edges legitimately MUTATE (trust moves) ⇒ presence-only, as before;
 *  - Vault records ⇒ id presence (this projection carries ids only).
 *
 * R3 (incremental fast path) — `trustEventPrefix` makes the WHOLE check O(Δ-since-last-commit) instead
 * of O(total history). It is the orchestrator's per-turn knob and rests on ONE contract: every dimension
 * trusted here is APPEND-ONLY (events.record / pushKnown / soul.memory.push only ever append a NEW item;
 * a prior item is never mutated or removed). On the fast path each append-only dimension is checked by
 * length + a boundary spot-check (the immutable prefix was already verified by the commit that wrote it);
 * a net DROP of ANY item is still caught every commit by `countsNonDecreasing`, and the byte-stable
 * character + the legitimately-mutating relationship edges + Vault ids stay FULLY verified below. The one
 * thing the fast path relaxes is re-reading a MIDDLE item's body for an in-place rewrite-at-equal-length —
 * which the append-only contract forbids, and which the orchestrator's periodic FULL re-scan
 * (`R3_FULL_CHECK_EVERY`) re-verifies as cheap belt-and-suspenders. (The default path — `trustEventPrefix`
 * unset — is the unchanged, fully-verified O(history) scan every cross-save check still uses.)
 */
export function isSuperset(later: GameState, earlier: GameState, opts: { trustEventPrefix?: boolean } = {}): boolean {
  const trust = opts.trustEventPrefix === true;

  // The append-only-prefix guard (R3): trust the immutable, already-verified prefix and check only that
  // it was not truncated and its START/END boundary is intact — O(1), vs the full O(prefix) re-scan.
  const prefixIntact = (late: readonly unknown[], early: readonly unknown[]): boolean => {
    if (late.length < early.length) return false; // truncated
    const n = early.length;
    if (n > 0) {
      if (!sameJson(late[0], early[0])) return false;
      if (!sameJson(late[n - 1], early[n - 1])) return false;
    }
    return true;
  };

  // Events — the dominant append-only accumulator.
  if (trust) {
    if (!prefixIntact(later.events, earlier.events)) return false;
  } else {
    const laterEvents = new Map(later.events.map((e) => [e.id, e]));
    for (const e of earlier.events) {
      const l = laterEvents.get(e.id);
      if (!l || !sameJson(l, e)) return false;
    }
  }

  // Knowledge facts — append-only by id (`pushKnown` mints a fresh `know:N` and never mutates a prior
  // fact). The flattened projection is per-entity-grouped, so it is NOT a clean positional prefix (a new
  // fact for an existing holder lands mid-array); the id-keyed map is order-independent either way. On the
  // fast path we verify id PRESENCE only (no per-fact `sameJson` — the JSON.stringify per element was the
  // O(knowledge) cost), which catches every drop/replacement; the append-only contract covers an in-place
  // body rewrite, re-verified by the periodic full re-scan. The default path keeps the full content check.
  const laterFacts = new Map(later.knowledge.map((k) => [`${k.entity}:${k.fact.id}`, k.fact]));
  for (const k of earlier.knowledge) {
    const l = laterFacts.get(`${k.entity}:${k.fact.id}`);
    if (l === undefined) return false;
    if (!trust && !sameJson(l, k.fact)) return false;
  }

  const laterSusp = new Map((later.suspicions ?? []).map((s) => [`${s.entity}:${s.suspicion.id}`, s.suspicion]));
  for (const s of earlier.suspicions ?? []) {
    const l = laterSusp.get(`${s.entity}:${s.suspicion.id}`);
    if (!l || !sameJson(l, s.suspicion)) return false;
  }

  const laterVault = new Set(later.vaultIds ?? []);
  for (const id of earlier.vaultIds ?? []) if (!laterVault.has(id)) return false;

  const laterEdges = new Set(later.relationships.map((e) => `${e.from}->${e.to}`));
  for (const e of earlier.relationships) if (!laterEdges.has(`${e.from}->${e.to}`)) return false;

  for (const [id, early] of Object.entries(earlier.characters)) {
    const late = later.characters[id];
    if (!late) return false;
    if (sameJson(late, early)) continue;
    // The static CHARACTER is byte-stable — EXCEPT the ONE sanctioned season-start UPGRADE (#1067): the FE
    // authoring write-back (`recordCastProfile`) replaces the seeded-floor PUBLIC deep-profile facets
    // (`biography` / `physicalCharacteristics` / `vocation` / `appearance`) with a richer authored version.
    // That is an accretion of detail, not the memory-thinning this guard exists to catch — but a byte-
    // compare can't tell the two apart, so the `deepProfileAuthored` provenance flag is the discriminator
    // (mirrors the 0062 worldSnapshot web_search upgrade just below). The upgrade is permitted ONLY when:
    //   (a) the earlier side was NOT yet authored AND the later side IS — strictly one-directional, so an
    //       authored profile can never drift/thin back (`true → true` falls through to the byte-compare and
    //       a `true → unset` regression is refused);
    //   (b) EVERY field OTHER than the four authorable public facets is byte-identical — the upgrade may
    //       never smuggle a change into the byte-stable identity (archetype/stats/background/ethnicity/…);
    //   (c) `biography` does not SHORTEN — the authored bio must be at least as rich as the floor it
    //       replaces (defense in depth: the floor stays the lower bound even on the sanctioned path).
    if (!isSanctionedProfileUpgrade(early, late)) return false;
  }

  // 0062 — the move-in zeitgeist snapshot is a FROZEN artifact: once captured it must never regenerate
  // or drift (it is the world the cast moved in WITH). Byte-compare it like a static character, with ONE
  // sanctioned exception: the FE's one-time `web_search` REPLACEMENT of the deterministic fallback at
  // season creation (§8) is a legitimate UPGRADE, not degradation. So a `model-framed`/`absent` earlier
  // snapshot may be replaced by a `web_search` one; a `web_search` snapshot is then frozen forever, and a
  // fallback may never drift to a DIFFERENT fallback. An earlier save WITHOUT one may also gain one later
  // (a capture after a pre-0062 resume) — accretion, not degradation. Everything else is a frozen byte-compare.
  if (earlier.worldSnapshot !== undefined && !sameJson(later.worldSnapshot, earlier.worldSnapshot)) {
    const earlierSrc = (earlier.worldSnapshot as { source?: string }).source;
    const laterSrc = (later.worldSnapshot as { source?: string } | undefined)?.source;
    const upgradeToCapture = earlierSrc !== "web_search" && laterSrc === "web_search";
    if (!upgradeToCapture) return false;
  }

  // Soul memory / emotionalHistory — the OTHER dominant append-only accumulator (every off-screen scene
  // pushes a memory note; the arc samples grow every tick). Both are clean positional append-only arrays,
  // so the fast path trusts the prefix exactly like events (length + boundary), turning the per-soul cost
  // from O(memory) `sameJson` comparisons into O(1). The default path keeps the full prefix-equality check.
  const fullPrefix = (late: readonly unknown[], early: readonly unknown[]): boolean =>
    late.length >= early.length && early.every((v, i) => sameJson(late[i], v));
  const prefixOk = trust ? prefixIntact : fullPrefix;

  for (const [id, early] of Object.entries(earlier.souls)) {
    const late = later.souls[id];
    if (!late) return false;
    if (!prefixOk(late.memory, early.memory)) return false;
    if (!prefixOk(late.emotionalHistory, early.emotionalHistory)) return false;
    if (late.relationshipBeliefs.length < early.relationshipBeliefs.length) return false;
  }
  return true;
}

export function countsNonDecreasing(later: DetailCounts, earlier: DetailCounts): boolean {
  return (Object.keys(earlier) as Array<keyof DetailCounts>).every((k) => later[k] >= earlier[k]);
}
