import type { GameHouse } from "./characterFactory";
import type { DeepProfile, StoryThread } from "./deepProfile";
import type { ShowrunnerNote } from "./showrunner";
import type { CastingIntake } from "./castingIntake";
import type { GameEvent } from "../domain/event";
import type { EntityId } from "../domain/ids";
import type { LiveSeasonState } from "./liveSeason";
import type { Deal } from "../domain/deal";
import type { Campaign, Drive } from "./campaigns";
import type { Trajectory, FoldSignal } from "./trajectory";
import type { Alliance } from "./alliances";
import type { KnowledgeSnapshot } from "../domain/knowledge";
import type { EdgeRecord, GameState, PersistedCharacter, PersistedSoul } from "../domain/saveState";
import type { Room, Zone } from "../domain/house";
import type { HiddenRecord } from "../ports/VaultStore";
import type { AdvanceView } from "../ports/GameSession";
import type { PersistedCanon } from "../domain/canon";
import { canonSupersetProblems, restoreCanon } from "./canonLedger";

/**
 * The current durable-snapshot schema version (B40/audit C4). Bump when the shape changes; a save
 * carrying a HIGHER (unknown) version is rejected rather than silently mis-restored. A save with NO
 * version is a legacy (pre-B40) save and is migrated forward (it simply lacks the knowledge layer).
 */
export const SNAPSHOT_VERSION = 1;

/** A snapshot is loadable iff it is the current version or a versionless legacy save (migrate-forward). */
export function snapshotCompatible(snap: { snapshotVersion?: number }): boolean {
  return snap.snapshotVersion === undefined || snap.snapshotVersion === SNAPSHOT_VERSION;
}

/**
 * The durable per-user game snapshot (feature 0030) — what makes the LIVE game
 * survive an engine restart. It bundles the session core the `GameSessionAdapter`
 * owns (house + week/phase/ceremony) with the engine detail that must not degrade
 * (events + relationship beliefs, 0007/0023). Everything here is plain JSON, so a
 * disk round-trip through `FileSaveStore` is lossless.
 *
 * ENGINE-ONLY: it carries the house's souls + the hidden relationship layer, so no
 * outward module may import it (enforced by dependency-cruiser, like the Vault).
 */
export interface CeremonyState {
  hoh?: EntityId;
  nominees: EntityId[];
  vetoHolder?: EntityId;
  vetoUsed: boolean;
}

/**
 * A single persisted TRACKED-OCCUPANCY belief (0077 Phase 2): the player saw the subject (the map key)
 * head into `room` (+ `zone` flavor) at presence-tick `tick`; `pathway` + `confidence` make it a real
 * 0002 acquired-knowledge fact. Vault-free — position only, never the off-screen scene's content.
 */
export interface TrackedSighting {
  room: Room;
  zone?: Zone;
  tick: number;
  pathway: string;
  confidence: number;
}

/** The live-session core the `GameSessionAdapter` snapshots/restores. */
export interface SessionCore {
  started: boolean;
  /**
   * The monotonic per-sandbox beat counter (feature 0065 Part A) — increments by one on every
   * committed state mutation; stable on a no-op. Persisted here so the compare-and-swap stale-write
   * token is RESTART-SAFE and co-versioned with the save (0007/0030): after a resume the counter
   * resumes at the saved value, so a queued/in-flight write computed against the pre-restart board is
   * still correctly refused. NOT secret (a counter carries no Vault content), and it lives on the
   * 0007 GameState projection only as a scalar (never a `counts()` dimension), so it cannot trip a
   * non-degradation false positive. Absent on a pre-0065 save ⇒ 0 (a resumed game continues from 0;
   * the next commit bumps it — benign, since the FE's last-seen token resets across a restart too).
   */
  beatSeq?: number;
  /**
   * PERSIST-9 — the at-most-once idempotency cache (0065 Part B), persisted as insertion-ordered
   * `[key, AdvanceView]` pairs so at-most-once survives a restart AND the routine LRU sandbox-unload/
   * resume cycle (which both run `restore()`). Before this, `restore()` CLEARED the cache, so a retry
   * whose `expectedBeatSeq` had legitimately advanced past the lost-response commit would MISS the cache
   * and re-apply the mutation (a vote cast twice, a nomination confirmed twice). Bounded (already LRU-
   * trimmed to `IDEMPOTENCY_CACHE_MAX`) and plain JSON (an `AdvanceView`), so the snapshot cost is small
   * and precedented by the other small bookkeeping maps here. NOT secret (a replay of a player-witnessed
   * progression view — no Vault content) and NOT a `counts()` dimension (it legitimately shrinks via LRU
   * eviction, so it must never enter the non-degradation superset check). Absent ⇒ empty (byte-identical
   * to a pre-fix load).
   */
  idempotency?: Array<[string, AdvanceView]>;
  /**
   * T0-3 (issue #1778) — the STABLE announcement-id counter (`GameSessionAdapter.announcementSeq`),
   * persisted so a `BeatAnnouncementView.id` is never reused even across a restart (the FE dedups a
   * chyron by this id — F4: it must render exactly once). NOT a `counts()` dimension: it is a monotonic
   * counter with no "content" to thin, the same class as `beatSeq` above, not a non-degradation surface.
   * The announcement log/ring itself is deliberately NOT persisted (process-local convenience only —
   * see `GameSessionAdapter.announcementLog`'s own comment). Absent ⇒ 0 (byte-shaped as a pre-T0-3 save).
   */
  announcementSeq?: number;
  week: number;
  phase: string;
  ceremony: CeremonyState;
  house: GameHouse | null;
  /** The incremental weekly-loop state (0011), so progression survives a restart (0030). */
  live?: LiveSeasonState | null;
  /** Tracked promises the player is party to (0039), so deals survive a restart (0030). */
  deals?: Deal[];
  /** Named alliances (feature 0107) — explicit multi-party pacts, persisted so they survive a restart
   *  (0030) and accumulate. ENGINE-ONLY (the cement/favor magnitudes never cross). Absent ⇒ none. */
  alliances?: Alliance[];
  /**
   * Live NPC CAMPAIGNS (feature 0085) — persistent, adaptive strategic agendas, so a multi-week
   * campaign and its accumulated history survive a restart (0030) and ACCUMULATE, never thin
   * (non-degradation #4). ENGINE-ONLY hidden strategy (it carries targets/plans/progress + the
   * per-perspective `knownTo` set), so it never crosses the wall — the snapshot already doesn't.
   * Absent on pre-0085 saves and whenever no campaign is running. (Phase A: the field + plumbing;
   * Phase B populates it from the live off-screen tick.)
   */
  campaigns?: Campaign[];
  /** The DEDICATED campaign-rng tick counter (0085 B2) — persisted so the campaign trajectory stays
   * reproducible across a restart; absent ⇒ 0. Never a calibration-spine input (its own forked stream). */
  campaignTickCount?: number;
  /**
   * Phase 2 of "the player can play offense" (0085 follow-on) — the player's OWN dedicated
   * campaign-move-rng draw counter, persisted so the player's own campaign stays reproducible across a
   * restart; absent ⇒ 0. Never a calibration-spine input (its own forked stream, mirroring
   * `campaignTickCount`'s isolation). Monotonic (++ only) — tracked in `SessionCoreCounts` below.
   */
  playerCampaignMoveCount?: number;
  /**
   * Phase 2 — the BEAT the player's own campaign last earned progress (the per-beat throttle), so a
   * restart mid-beat doesn't grant an extra progress-earning pitch; absent ⇒ null (no pitch yet). Current
   * state, not a monotonic count (mirrors `campaigns`/`drives`'s own exclusion from the checkpoint).
   */
  playerCampaignProgressBeat?: number | null;
  /** The DEDICATED jury-house-rng tick counter (0100) — persisted so the isolated grudge stream stays
   * reproducible across a restart; absent ⇒ 0. Never a calibration-spine input (its own forked stream).
   * The accumulated grudge itself rides on `live.juryGrudge` (engine-only; restored with the live state). */
  juryHouseTickCount?: number;
  /** 0100 limbo (owner ruling 2026-11-02, #1922): how many NPC evictions the jury house has already
   *  processed — one short stretch per arrival. Separate from `juryHouseTickCount` (the rng counter) so
   *  arrivals past the ninth juror still count, and so a pre-limbo save (counter only) resumes cleanly.
   *  Absent ⇒ derived on restore (see `GameSessionAdapter.juryHouseTick`). Monotonic. */
  juryHouseArrivals?: number;
  /**
   * Feature 0101 — NPC myth-making. `legendTickCount` is the DEDICATED legend-rng tick counter (forked
   * off the game seed, never the shared society/competition/vote stream — see
   * `GameSessionAdapter.legendTick`), persisted so the isolated stream stays reproducible across a
   * restart. `legendCount` is the per-season HARD CAP on legends minted (monotonic, ++ only — tracked
   * in `SessionCoreCounts` below, sibling of `surfacedThreadCount`). `legendLastActTick` is the
   * watermark (the highest consumed notable-act's `GameEvent.ts`) so a used act is never re-picked into
   * a second legend. All three absent ⇒ 0 (byte-shaped as a pre-0101 save / the layer off).
   */
  legendTickCount?: number;
  legendCount?: number;
  legendLastActTick?: number;
  /**
   * Feature 0122 — the last in-game day the daily confessional sweep closed (`GameSessionAdapter.
   * lastConfessionalSweepDay`), persisted so a mid-season reload doesn't re-sweep an already-closed day and,
   * on the standalone (non-registry) restart path where the adapter is reused across seasons, a stale value
   * can't suppress the new season's sweep (reset at every season boundary). Absent ⇒ 0.
   */
  lastConfessionalSweepDay?: number;
  /**
   * Feature 0099 (hidden half) — the off-screen NPC↔NPC secret barter. `secretBarterTickCount` is the
   * DEDICATED barter-rng tick counter (forked off the game seed, NEVER the shared society/competition/vote
   * stream — see `GameSessionAdapter.secretBarterTick`), persisted so the isolated stream stays
   * reproducible across a restart. `secretBarterCount` is the monotonic count of secrets spent into the
   * hidden economy this season (++ only — tracked in `SessionCoreCounts` below, sibling of
   * `secretTradeCount` / `legendCount`; the knowledge layer only DEEPENS as secrets change hands, never
   * thins — non-degradation #4). Both absent ⇒ 0 (byte-shaped as a pre-0099-barter save / the layer off).
   */
  secretBarterTickCount?: number;
  secretBarterCount?: number;
  /** Every active houseguest's current DRIVE (0086) — sticky motivation+intensity, so an agenda survives a
   * restart instead of re-rolling. ENGINE-ONLY (hidden strategy). Absent on pre-0086 saves / when the
   * campaign layer is off. */
  drives?: Record<EntityId, Drive>;
  /**
   * Feature 0096 — the emergent NEMESIS bookkeeping: the currently-held nemesis (if any) + each
   * candidate's consecutive-tick sustained-threat streak, so the arc SURVIVES a save/restore and a
   * fresh context window (recalled, never re-guessed) and its history accumulates, never thins
   * (non-degradation #4). ENGINE-ONLY (ONLY the Vault-safe `rivalry` tone hint ever crosses, on
   * `npcVoice`). Absent on a pre-0096 save / whenever the campaign layer is off ⇒ no nemesis,
   * re-derived cleanly on the next `campaignTick` (back-compatible).
   */
  nemesis?: EntityId;
  nemesisStreak?: Record<EntityId, number>;
  /**
   * RELATIONSHIP TRAJECTORIES (feature 0087) — the hidden MOMENTUM per directed pair (`"a->b"` → {phase,
   * momentum}), so a multi-week arc RESUMES mid-curdle across a restart and ACCUMULATES, never thins
   * (non-degradation #4). VAULT-CLASS hidden engine state (it carries no player/admin-visible number): the
   * snapshot itself never crosses the wall. Absent on pre-0087 saves AND whenever the trajectory layer is
   * off ⇒ every pair resumes at `steady`/0 (byte-identical to a pre-feature load).
   */
  trajectories?: Record<string, Trajectory>;
  /**
   * Feature 0088 — per-NPC CURRENT-READ anchor bonds (the NPC→player bond at the start of the
   * current week), so `drift` reads warming/cooling/steady. A derived Vault-only convenience —
   * never a label, never crossed, never an input to any roll. Keyed by NPC id → the (trust+affinity)/2
   * bond at the anchor point. Absent on pre-0088 saves (drift reads "steady").
   */
  readAnchors?: Record<EntityId, number>;
  /**
   * The tiny per-pair ring buffer of recent FOLD signals (0087) the phase is derived from — `"a->b"` → the
   * last `recencyWindow` signed bond/threat deltas (+ betrayal flag). Persisted beside `trajectories` so a
   * restored game derives the SAME phase from the SAME history. ENGINE-ONLY + Vault-free (deltas of a
   * nature's constant shape, never a raw edge number). Absent on pre-0087 saves / when the layer is off.
   */
  trajectoryFolds?: Record<string, FoldSignal[]>;
  /** Who is in which room (0049), so presence survives a restart. Absent pre-0049 (reseeded on tick). */
  presence?: Record<EntityId, Room>;
  /**
   * The CALIBRATION-NEUTRAL base occupancy the off-screen society pairs on (L21/L24). Kept separate from
   * the personality-weighted `presence` (the player's view) so the society's co-presence — and thus the
   * seeded competition/vote outcomes — stays invariant to the movement-personality constants. Absent on
   * pre-L21/L24 saves (the next tick re-seeds it; `societyOccupancy` falls back to `presence` meanwhile).
   */
  presenceBase?: Record<EntityId, Room>;
  /** Room tenure — ticks each houseguest has held their current room (L21/L24). Absent on older saves (reseeded on the next tick). */
  presenceTenure?: Record<EntityId, number>;
  /**
   * The presence-tick COUNTER (L21/L24). Movement randomness rides a DEDICATED stream forked off the
   * game seed + this counter — never the orchestrator's shared per-user stream — so personality-weighted
   * movement can never perturb the competition/vote calibration (the seeded `juryReach` gate). Persisted
   * so the movement trajectory stays reproducible across a restart; absent ⇒ 0 (a resumed game continues
   * the deterministic sequence). The counter advances ONCE per `presenceTick`.
   */
  presenceTickCount?: number;
  /** B28: the monotonic count of tell ONSETS (a new tell kind beginning on any houseguest) - persists even after a tell fades, so the checkpoint can prove the tells layer never loses history. */
  tellOnsetCount?: number;
  /** B29 (ORWELL_TELL_REACTIONS): the observer-reaction state - decaying exploit tilts, the per-pair last-reacted week, monotonic counts by kind. Absent when nothing has reacted (byte-identical). */
  tellReactions?: { exploit: Record<string, number>; reactedWeek: Record<string, number>; counts: Record<string, number>; ticks: number; avoid?: Record<string, number> };
  /**
   * SEATED sub-zones (issue #792 — the PO ruling: sub-zones SEATED into `assignRooms`, not computed
   * on-read). Each houseguest in a zoned big room (backyard/lounge) holds a per-id sub-zone (the
   * player-facing view), so a stay can DRIFT corner-to-corner and bonded houseguests can CLUSTER. Seeded
   * from the deterministic `zoneFor` on a fresh seat, evolved on the DEDICATED movement stream (never the
   * shared spine ⇒ calibration-neutral). Persisted so drift/cluster history survives a restart (0007,
   * only-forward); ABSENT on a pre-feature save ⇒ the next tick seats everyone fresh, no error. Vault-free
   * position projection (never Vault content).
   */
  presenceZone?: Record<EntityId, Zone>;
  /**
   * TRACKED OCCUPANCY (0077 Phase 2): the PLAYER's persisted beliefs about who is behind a closed door —
   * acquired knowledge (a witnessed movement), keyed by subject, carrying a pathway + confidence + the
   * sighting tick. Persisted so the privacy payoff accumulates across a restart (0007); absent on older
   * saves. Vault-free (position, never the scene's content).
   */
  trackedSightings?: Record<EntityId, TrackedSighting>;
  /** The game's seed (B60/audit E12): the per-moment rng keys off it, so two same-named games diverge. */
  seed?: number;
  /**
   * The PRODUCER persona's seed (producer-persona feature). The producer is the OFF-CAMERA casting-interview
   * voice — a seeded, reproducible persona, NOT one of the 16 (no headshot, never in the roster). The
   * interview runs PRE-GAME, so this seed is established (and persisted) lazily before any season seed
   * exists, so the same producer is voiced across turns and a restart; at season start it is set to the
   * season `seed`. Absent on pre-feature saves AND a fresh pre-interview session (re-minted on first need).
   */
  producerSeed?: number;
  /**
   * The AI-authored producer-DEEPENING overlay (increment 3 of #1626): the OPTIONAL, Vault-free overlay
   * (backstory / temperament / disposition / wit / quirk) the FE writes back via `recordProducerProfile`
   * to enrich the seeded off-camera casting producer WITHOUT touching the seeded NAME (the byline stays
   * byte-stable). Open-set public voice PROSE only — no stat/number/hidden field (structural). Persisted
   * so an authored persona survives a restart and only ever deepens (#4). Absent on pre-feature saves /
   * an unauthored session ⇒ the seeded floor producer stands.
   */
  producerProfile?: import("./producerPersona").ProducerProfileOverlay;
  /** A half-done casting interview (0050) — additive/optional, so legacy saves stay version-1 loadable. */
  casting?: CastingIntake;
  /** Per-season photorealistic style anchor (0051): seeded at cast time, stable through the season. Absent on older saves (falls back to a default). */
  portraitStyleAnchor?: string;
  /**
   * The engine-only HIDDEN deep layer (feature 0058): the §3 secrets/goals/weakness/Day-1 perception
   * per NPC and the derived story THREADS (with their live `status`). Persisted here so a thread that
   * has ACTIVATED stays activated across a restart (0030) and the Day-1 perception re-seeds identically.
   * ENGINE-ONLY: the snapshot itself never crosses the wall (it carries the souls + relationships too),
   * so holding hidden profiles here leaks nothing. Absent on pre-0058 saves (re-derived deterministically
   * on restore from the persisted seed + cast — seed-stable & player-independent).
   */
  deepProfiles?: Record<EntityId, DeepProfile>;
  storyThreads?: StoryThread[];
  /**
   * 0065 — a PRE-WARMED but not-yet-finalized cast: the player-INDEPENDENT cast `preSeedCast` generates
   * during the casting interview (before `createCharacter`), possibly already FE-authored deeply. Persisted
   * so a half-warmed cast survives a restart and resumes (0030) rather than re-warming from scratch.
   * ENGINE-ONLY (it carries the hidden deep layer + private orientations). Absent once the season starts
   * (the cast is adopted onto the live house and the holding store is cleared). Absent on all prior saves.
   */
  prewarm?: {
    seed: number;
    npcs: GameHouse["npcs"];
    deepProfiles: Record<EntityId, DeepProfile>;
    storyThreads: StoryThread[];
    privateOrientations: Record<EntityId, import("./diversityConstants").Orientation>;
    groundedSkinTones: Record<EntityId, string>;
    portraitStyleAnchor: string;
    // 0116 — the model-authored genesis layer on the warm: the validated tie graph (adopted at
    // createCharacter, preferred over the floor draw) + the seeded brief + the authored-skeleton provenance.
    // Absent on a non-genesis warm / pre-0116 save (⇒ the deterministic floor cast, byte-neutral).
    genesisTies?: import("./seededRelationships").PreGameTie[];
    seasonBrief?: import("./castGenesis").SeasonBrief;
    genesisAuthored?: boolean;
  };
  /**
   * 0065 (advance-warm) — the durable NEXT-season holding-store mirror: the cast pre-warmed DURING the
   * current season's finale, off a NEW seed, into a per-user buffer that survives the cutover. Persisted
   * on the LIVE sandbox so an advance-warm begun mid-finale survives an engine restart and is still
   * adopted at the confirmed cutover. SAME shape as `prewarm` (it IS a held PrewarmCast). ENGINE-ONLY (it
   * carries the hidden deep layer + private orientations). Absent until an advance-warm runs; cleared once
   * the cutover consumes it. Absent on all prior saves.
   */
  nextSeasonWarm?: {
    seed: number;
    npcs: GameHouse["npcs"];
    deepProfiles: Record<EntityId, DeepProfile>;
    storyThreads: StoryThread[];
    privateOrientations: Record<EntityId, import("./diversityConstants").Orientation>;
    groundedSkinTones: Record<EntityId, string>;
    portraitStyleAnchor: string;
  };
  /**
   * Feature 0060 — the story-thread scheduler's engine-only, HIDDEN bookkeeping: the distinct weeks each
   * houseguest has been nominated (drives the `nominated-twice` trigger) and the count of threads that
   * have ever SURFACED this season (the hard restraint cap, §5). Persisted so both survive a restart
   * (0030) — a thread driven to a status stays at it, and the season cap is never re-opened by a reload.
   * Absent on pre-0060 saves (rebuilt forward from the current ceremony; the cap defaults to 0).
   */
  nominationWeeks?: Record<EntityId, number[]>;
  surfacedThreadCount?: number;
  /**
   * Feature 0091 — the per-season TRIGGER-ERUPTION count (sibling to `surfacedThreadCount`): how many
   * volatile triggers have fired this season. MONOTONIC, persisted so the hard `eruptionCapPerSeason` is
   * never re-opened by a reload (0007/0030) and a few-per-season pacing holds across a restart. ENGINE-ONLY
   * — a count carries no Vault content. Absent on a pre-0091 save / when the trigger layer is off ⇒ 0. (The
   * per-trigger `fired`/`lastFiredWeek` flags themselves ride on the byte-stable `Character.hiddenElements`.)
   */
  eruptionCount?: number;
  /**
   * Feature 0091 — the DEDICATED trigger-rng tick counter: the trigger check forks its rng off the game seed
   * + this counter, never the shared society/vote stream, so even the layer ON can't perturb calibration.
   * Persisted so the dedicated stream stays reproducible across a restart; absent ⇒ 0. Never a calibration
   * input (its own forked stream), never a `counts()` dimension. ENGINE-ONLY.
   */
  triggerTickCount?: number;
  /**
   * Feature 0092 — the secret-pacing drip's engine-only, HIDDEN weekly bookkeeping. `pacingDripWeek` is the
   * week `pacingDripCount` is FOR (a new week resets the count — the cadence is per-WEEK); `pacingDripCount`
   * is how many player-bound drips have fired this week (the hard weekly ceiling); `pacingTickCount` is the
   * DEDICATED rng's tick counter (so the seeded eligibility stream is reproducible across a restart);
   * `pacingLastDrippedWeek` maps a thread id → the last week it edged toward the player (the already-told
   * penalty / no-re-spam state). Persisted so the CADENCE + anti-spam survive a restart and the pace
   * RESUMES, never resets (non-degradation, 0007/0030). Absent on pacing-off / pre-0092 saves ⇒ 0/empty
   * (the season cap `surfacedThreadCount` still binds, so the relaxation is benign and never leaky).
   */
  pacingDripWeek?: number;
  pacingDripCount?: number;
  pacingTickCount?: number;
  pacingLastDrippedWeek?: Record<string, number>;
  /**
   * Feature 0101 (#1401) — the AI SHOWRUNNER's Vault-held "producer notes". `showrunnerNotes` is the
   * APPEND-ONLY production bible: one note per (week, phase) beat, each proposing which simmering hidden
   * story threads the next off-screen tick should EMPHASIZE (a clamped, boost-only multiplier over 0060's
   * seeded surfacing — never an outcome, ADR 0005). ENGINE-ONLY / Vault-held (this whole snapshot is
   * engine-only, like `storyThreads`), so no note ever reaches a player- OR admin-facing projection; it
   * unseals ONLY in the 0048 retrospective (rendered by `buildVaultUnseal`). `showrunnerNoteCount` is the
   * monotonic per-season count (++ only — a `SessionCoreCounts` dimension below, and the array is a
   * `sessionCoreIsSuperset` presence-guarded field), so the bible only ever DEEPENS (non-degradation #4).
   * Both absent on a pre-0101-showrunner save / when the layer is off ⇒ []/0 (byte-identical).
   */
  showrunnerNotes?: ShowrunnerNote[];
  showrunnerNoteCount?: number;
  /**
   * Feature 0101 (#1401) Phase-2 (#1455) — the monotonic per-season count of off-screen ticks on which the
   * OUTCOME-AFFECTING reweight (behind `ORWELL_SHOWRUNNER_REWEIGHT`, default off) actually RE-ORDERED the
   * scheduler (the producer's shortlist jumped a thread ahead of the derive order). A `SessionCoreCounts`
   * dimension (++ only, reset only at a season boundary), so a resumed game keeps the count durable and the
   * ON calibration run can prove the layer is non-vacuous. Absent on a pre-Phase-2 save / when the reweight
   * sub-flag is off ⇒ 0 (byte-identical).
   */
  showrunnerReweightCount?: number;
  /**
   * Feature 0075 — the trust-gated confidence ledger: per-houseguest, the highest TIER they have
   * confided to the player (monotonic for a true secret) + whether that disclosure was truthful (a
   * lie is engine-side only). `confideLieCount` is the per-season lie count (the hard cap). Persisted
   * so a restored game remembers exactly what the player was told, never re-tells a secret at a lower
   * tier, and never re-opens the lie cap. Absent on pre-0075 saves ⇒ empty/zero (non-degradation).
   */
  confideState?: Record<EntityId, { tier: "none" | "tease" | "partial" | "full"; truthful: boolean }>;
  /** 0129 slice 4 — the contents of facts a juror TOLD the player in the jury house via `askJuror` (the informed vote card's only source). Append-only. */
  jurorTold?: string[];
  confideLieCount?: number;
  /** B49 (ORWELL_NO_HARD_CAPS) - per NPC, how many confide lies it has told this season (the repetition roll). Absent flag-off / pre-B49 saves. */
  confideLiesBy?: Record<string, number>;
  /**
   * Features 0093 + 0099 — secrets as power. `secretUsedAs` maps each learned `factId` the player has
   * WIELDED to how (`leverage` | `exposed` | `traded`), so a spent secret can't be re-wielded; the
   * counts are the per-season caps (expose/trade/player-bluff). Persisted so a restored game remembers
   * which secrets are spent and never re-opens a cap. Absent on pre-0093 saves ⇒ empty/zero (non-degradation).
   */
  secretUsedAs?: Record<string, "leverage" | "exposed" | "traded">;
  secretExposeCount?: number;
  secretTradeCount?: number;
  secretPlayerBluffCount?: number;
  /** deception — per NPC who BELIEVED a player bluff, the subject(s) lied about (the passive lie-catch ledger). */
  secretPlayerBluffBelief?: Record<EntityId, EntityId[]>;
  /**
   * The engine-only HIDDEN seeded relationship layer (feature 0059): the sparse pre-game ties +
   * showmances seeded at cast time, Vault-sealed from the player AND the admin. Persisted so a
   * showmance stage never silently resets and the layer survives a restart (0030). ENGINE-ONLY (same
   * reasoning as deepProfiles above). Absent on pre-0059 saves (re-derived from the seed on restore).
   */
  seededRelationships?: import("./seededRelationships").SeededRelationships;
  /**
   * Feature 0116 — the model-authored world-gen artifact (post-createCharacter): the SEEDED season brief the
   * genesis proposal was steered by (recalled, never regenerated — mandate #4) + the authored-skeleton
   * provenance flag. The genesis TIE graph is NOT persisted here — it lives in `seededRelationships` above
   * (folded + sealed at createCharacter). Absent on a floor cast / pre-0116 save (⇒ null/false).
   */
  seasonBrief?: import("./castGenesis").SeasonBrief;
  genesisAuthored?: boolean;
  /**
   * 0059 §5 — the organic tie-surfacing scheduler's hidden bookkeeping (the DEFERRED follow-on, opt-in).
   * `playerTieSurfaceCount` is the per-season count of pre-game ties that have surfaced TO THE PLAYER (the
   * hard cap); `surfacedTieSubjects` are the tie subjects already surfaced (so a tie never re-spends the
   * cap); `tieScheduleTickCount` is the DEDICATED rng's tick counter. Persisted so a discovered tie stays
   * discovered, the cap is never re-opened by a reload, and the stream stays reproducible (non-degradation,
   * 0007/0030). All ENGINE-ONLY (Vault-sealed). Absent on saves with the scheduler off / pre-§5 (⇒ 0/empty).
   */
  playerTieSurfaceCount?: number;
  surfacedTieSubjects?: string[];
  tieScheduleTickCount?: number;
  /**
   * Feature 0095 — the pre-show-TIE REVEAL pathway's own bookkeeping (a SEPARATE counter/cap from §5
   * above — a DIFFERENT pathway, a different rng stream). `tieExposureCount` is the per-season count of
   * ties EVER exposed (promoted past `sealed`, by the overhear pathway OR `accuseTie`) — the hard cap;
   * `tieRevealTickCount` is this pathway's own dedicated rng tick counter. Each tie's own `exposure`
   * state rides on `seededRelationships` above (a field on `PreGameTie`) — monotonic, never regresses.
   * Absent on pre-0095 saves / when the pathway has never fired ⇒ 0 (every tie defaults to `sealed`).
   */
  tieExposureCount?: number;
  tieRevealTickCount?: number;
  /**
   * The engine-only HIDDEN private-orientation map (feature 0063): the orientation of each houseguest who
   * holds it PRIVATELY (closeted / not-yet-out), Vault-sealed from the player AND the admin. Persisted so
   * a closeted orientation never silently resets and survives a restart (0030). ENGINE-ONLY (same
   * reasoning as deepProfiles above). The PUBLIC diversity facets (ethnicity, gender presentation, an out
   * orientation) ride on the byte-stable Character. Absent on pre-0063 saves (re-derived from the seed on
   * restore ONLY for a truly pre-0063 cast; a 0063 cast with an empty map simply had everyone out).
   */
  privateOrientations?: Record<EntityId, import("./diversityConstants").Orientation>;
  /**
   * The move-in zeitgeist snapshot (feature 0062): the ONE frozen, shared real-world flavor the whole
   * cast moved in with. Captured ONCE at season creation, FROZEN byte-stable, and persisted here so it
   * survives a restart (0030) and is recalled — never re-searched — all season (§9). OUTWARD-SAFE by
   * construction: it is public, shared real-world flavor (a THIRD state category — neither Vault-secret
   * nor game truth, §6), so carrying it on this engine-only core leaks nothing and it MAY cross to the
   * player- and off-screen-facing prompts. Absent on pre-0062 saves AND when no snapshot was captured
   * (the §8 fail-soft skip) — an absent snapshot round-trips as absent and changes no outcome.
   */
  worldSnapshot?: import("./zeitgeist").WorldSnapshot;
  /**
   * PREMIERE — the meet-everyone tracker (feature #380 follow-on): the ids of the houseguests the
   * player has been INTRODUCED to so far during the premiere. Persisted so a half-done premiere
   * survives a restart (0030) and resumes where it left off — the producer never re-introduces someone
   * already met, and never loses track of who is still to meet. Public ids (no Vault data). Absent on a
   * pre-feature save AND once the premiere is over (the tracker is cleared when the first HOH begins).
   */
  premiereIntros?: EntityId[];
  /**
   * A1 (ship-blocker, "the phantom-houseguest root") — the DURABLE superset of `premiereIntros`: every
   * houseguest id the player has EVER been introduced to (by name, in narration they witnessed) this
   * season. Unlike `premiereIntros`, this is never cleared once the premiere ends — it is the permanent
   * name-lock signal `recordCastProfile` consults so an async deep-authoring write-back (which can
   * complete well after move-in, even via the later authoring backfill) can never rename a houseguest
   * the player already knows by name. Persisted so the lock survives a restart (0030). Absent on a
   * pre-A1 save ⇒ empty (no false lock on old saves; any houseguest introduced from here on locks going
   * forward exactly as a fresh season does).
   */
  introducedNames?: EntityId[];
  /**
   * #1318 — PREMIERE, the player-formed HOT-READ set: the subset of `premiereIntros` reached through
   * GENUINE engagement (a model-driven introduction the player was part of, or a recorded player↔NPC
   * scene) rather than the FE regex name-belt. ONLY this set unlocks the asymmetric first-power gate, so
   * the first HOH no longer fires the moment two names are name-dropped. Premiere-scoped like
   * `premiereIntros` (cleared once the first HOH begins); persisted so a half-done premiere resumes with
   * its earned power state intact (0030). Absent on a pre-#1318 save ⇒ empty (no earned reads yet, so the
   * gate simply waits for the first genuine one — safe, never a spurious early unlock). Public ids only.
   */
  premiereHotReads?: EntityId[];
  /**
   * 0070 — the additive prose texture layer: model-voiced content indexed by event id. Only
   * applied when the underlying event is already hidden (never creates events, never alters the
   * closed set). Persisted so enriched scenes survive a restart byte-identical (0030). Absent on
   * pre-0070 saves (no texture; the deterministic template content simply stands).
   */
  textureOverrides?: Record<string, string>;
  /**
   * Showrunner memory (K4 §2.5) — the canon ledger: the small details the narration established on screen (a
   * nickname, a habit, a prop), each with where it came from. NEVER thinned: `sessionCoreIsSuperset` refuses a
   * save that drops an entry or rewrites its words. Absent until the first detail is recorded, so a game with no
   * canon saves byte-identically (and every pre-ledger save loads as an empty ledger).
   */
  canon?: PersistedCanon;
  /**
   * Issue #1322 (P2) — the approach-rotation anti-recency cooldown: per-NPC remaining STRETCHES (a
   * distinct week:phase) before they are eligible to lead `socialInitiatives`'s top-3 again, so the
   * same seeded-affinity NPC can't monopolize every approach. Persisted so the rotation survives a
   * restart instead of re-favoring the same top NPC (0030). PLAYER-FACING PROJECTION state only —
   * `rankApproaches` itself is untouched/pure; this is applied at the ONE call site that renders the
   * approach surface (`GameSessionAdapter.socialInitiatives`, via `conversation.ts`'s
   * `applyApproachCooldown`). Current, mutable per-stretch state (like `presence`) — a lapsed
   * cooldown legitimately drops back out of the map, so this is deliberately excluded from the
   * `sessionCoreCounts`/`sessionCoreIsSuperset` non-degradation guards below. Absent on a pre-feature
   * save ⇒ every NPC starts eligible (byte-identical to a pre-feature load).
   */
  approachCooldown?: Record<EntityId, number>;
  /**
   * The stretch key (`week:phase`) the cooldown bookkeeping above was last advanced for
   * (`GameSessionAdapter.syncProjection`) — so a read-only `socialInitiatives()` poll never
   * double-decrements within the same stretch; only an ACTUAL stretch transition rotates it. Absent
   * ⇒ the very next transition is treated as the first (harmless: an empty cooldown map decremented
   * once is still empty).
   */
  approachStretchKey?: string;
  /**
   * Issue #1322 P1 follow-up (Greptile, PR #1335): the top-3 initiators the CURRENT stretch has
   * actually SHOWN the player (`socialInitiatives()`'s own record), plus the stretch key they were
   * shown FOR — persisted so a save+restart BETWEEN a `socialInitiatives()` read and the next
   * committed beat doesn't lose whom to cool down at the coming stretch transition. (Previously
   * this record was process-local only, so a mid-stretch restart cleared it, the transition
   * re-armed nobody, and the just-shown NPCs could lead again immediately — the exact
   * monopolization #1322 fixed, reopened through the restart door.) Same classification as
   * `approachCooldown` above: PLAYER-FACING PROJECTION state only, current/mutable per-stretch
   * (fully replaced on every stretch's first read), so it is deliberately excluded from the
   * `sessionCoreCounts`/`sessionCoreIsSuperset` non-degradation guards. Absent on a pre-feature
   * save OR when the surface was never read this stretch ⇒ nobody re-arms (correct: nothing was
   * shown). Public ids + a week:phase key only — no Vault content.
   */
  approachShown?: { key: string; initiators: EntityId[] };
  /**
   * P0g - the bounded ring (<=256, oldest dropped) of player-message ids `noteMessage` has already billed, so a retry after an engine restart does not bill the clock twice. Opaque client ids only
   * (no Vault content). Absent on a pre-feature save OR before any announcement - byte-identical load (and legacy per-commit billing until the first announcement).
   */
  seenMessageIds?: string[];
  /**
   * B20 - the B10/B11 co-presence TOLD ledger (who already decided to share/slip/hold which fact to which listener), so a restart does not re-decide (and re-roll) a telling the house already saw.
   * Ids + a closed outcome only (no Vault content). Absent on a pre-feature save OR when nothing was ever decided => an empty ledger (byte-identical load). Not a monotonic accumulator: a superseded
   * fact can `reopen` (delete) its entries by design, so it is exempt from the superset/count guards.
   */
  toldLedger?: import("./heldFacts").ToldSnapshot;
}

/** The full durable unit: the session core plus the engine detail (for non-degradation). */
export interface SessionSnapshot extends SessionCore {
  /** Schema version (B40); absent on legacy pre-B40 saves (migrated forward). */
  snapshotVersion?: number;
  events: GameEvent[];
  relationships: EdgeRecord[];
  /** The whole knowledge layer (B40/audit C2): facts + suspicions + counters. Absent on legacy saves. */
  knowledge?: KnowledgeSnapshot;
  /**
   * The Vault's hidden records (B53/audit I7): sealed twists, confessionals, hidden threads — so the
   * producer's secrets survive a restart like everything else (0030). Absent on older saves. The
   * snapshot itself is ENGINE-ONLY (see above), so carrying Vault content here crosses no wall.
   */
  vault?: HiddenRecord[];
}

export function cloneSession<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * R3 — a structural deep clone that is BYTE-IDENTICAL to `cloneSession` (the JSON round-trip) for any
 * JSON-safe value, without paying to serialize+reparse every string char-by-char. It mirrors
 * `JSON.parse(JSON.stringify(x))` semantics exactly for the value types a `SessionCore`/`GameHouse`
 * holds (objects, arrays, string/number/boolean/null): a property whose value is `undefined`, a
 * function, or a symbol is DROPPED (as JSON does); the same in an array position becomes `null`; a
 * non-finite number becomes `null`; a `toJSON()` method (e.g. on a Date) is honored before recursion.
 * Immutable primitives (strings/numbers) are shared, not re-allocated — that is the whole win: the
 * per-turn snapshot export deep-clones each houseguest's ever-growing append-only `soul.memory`, and
 * re-JSON-serializing the full log every turn was the O(events) cost behind the late-season latency
 * (audit R3). Used ONLY where the input is known JSON-safe (the house/live clones); `cloneSession`
 * stays the default elsewhere. Verified equivalent in `tests/unit/incrementalSnapshot.test.ts`.
 */
export function fastClone<T>(value: T): T {
  return cloneJsonLike(value) as T;
}

function cloneJsonLike(v: unknown): unknown {
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "boolean") return v;
  if (t === "number") return Number.isFinite(v as number) ? v : null; // JSON: NaN/±Infinity → null
  if (t !== "object") return undefined; // function/symbol/undefined → caller drops (object/array path)
  // Honor toJSON (Date etc.) exactly like JSON.stringify would, then clone the produced value.
  const obj = v as { toJSON?: (key?: string) => unknown };
  if (typeof obj.toJSON === "function") return cloneJsonLike(obj.toJSON());
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const c = cloneJsonLike(v[i]);
      out[i] = c === undefined ? null : c; // JSON: undefined/function in an array slot → null
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const k in v as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    const c = cloneJsonLike((v as Record<string, unknown>)[k]);
    if (c !== undefined) out[k] = c; // JSON: a property whose value is undefined/function is dropped
  }
  return out;
}

/**
 * Project a durable snapshot into the 0007 `GameState` shape so the existing
 * non-degradation helpers (`counts`/`isSuperset`/`countsNonDecreasing`) apply
 * across a restart. Characters map to the static baseline; souls to the dynamic
 * (deepening) layer; relationships are the hidden beliefs.
 */
/**
 * R3 — memoize the projection by snapshot IDENTITY. The integrity checkpoint (orchestrator) projects
 * the BASELINE and the CANDIDATE every commit, and the candidate of one commit is reused as the exact
 * baseline object of the next (orchestrator keeps it), and again as the supplementary off-screen tick's
 * baseline — so the same snapshot object is projected up to three times. `toGameState` is a PURE
 * function of its input, and snapshots are immutable once exported, so caching by object identity is
 * provably correct and cuts the redundant O(events) re-projection from the per-commit cost. A WeakMap
 * keeps it leak-free: an entry vanishes when the snapshot is collected.
 *
 * CONTRACT: callers MUST treat the result as READ-ONLY (the checkpoint's isSuperset/counts/playerSweep
 * all are). A mutating caller would corrupt a later memo hit — none exists, and none should.
 *
 * (This is the SAFE slice of R3. The remaining win — an incremental, O(Δ) export + isSuperset that
 * never walks the full event set — is a deeper redesign of the integrity spine and stays its own item.)
 */
const _gameStateCache = new WeakMap<SessionSnapshot, GameState>();

export function toGameState(snap: SessionSnapshot): GameState {
  const memo = _gameStateCache.get(snap);
  if (memo) return memo;
  const characters: Record<EntityId, PersistedCharacter> = {};
  const souls: Record<EntityId, PersistedSoul> = {};
  const all = snap.house ? [snap.house.player, ...snap.house.npcs] : [];
  // Group the edges by holder in ONE pass (preserving order) instead of re-`filter`ing the whole edge
  // list per houseguest — the old `snap.relationships.filter(e => e.from === hg.id)` inside the loop was
  // O(houseguests × edges). The grouped arrays are byte-identical to the per-holder filters (same order).
  const beliefsByHolder = new Map<EntityId, EdgeRecord[]>();
  for (const e of snap.relationships) {
    let list = beliefsByHolder.get(e.from);
    if (!list) { list = []; beliefsByHolder.set(e.from, list); }
    list.push(e);
  }
  for (const hg of all) {
    characters[hg.id] = {
      archetype: hg.character.archetype,
      strategyStyle: hg.character.strategyStyle,
      stats: hg.character.stats,
      background: hg.character.background,
      // L28: the diverse backstory facets are part of the byte-stable static baseline — included so
      // the 0031 checkpoint's superset/byte-compare guards them against regeneration/drift. Spread
      // (not nested) so an absent field on a pre-L28 save stays absent (no spurious superset failure).
      ...(hg.character.vocation !== undefined ? { vocation: hg.character.vocation } : {}),
      ...(hg.character.hometown !== undefined ? { hometown: hg.character.hometown } : {}),
      // L28 (voice register): part of the byte-stable baseline the checkpoint guards (conditional
      // spread keeps an absent field absent on a pre-demeanor save — no spurious superset failure).
      ...(hg.character.demeanor !== undefined ? { demeanor: hg.character.demeanor } : {}),
      // 0058: the PUBLIC deep-profile facets are part of the byte-stable static baseline — included so
      // the 0031 checkpoint's superset/byte-compare guards them against regeneration/drift. Spread
      // (not nested) so an absent field on a pre-0058 save stays absent (no spurious superset failure).
      ...(hg.character.biography !== undefined ? { biography: hg.character.biography } : {}),
      ...(hg.character.physicalCharacteristics !== undefined
        ? { physicalCharacteristics: hg.character.physicalCharacteristics } : {}),
      // #1067: the season-start authoring provenance flag — drives the ONE sanctioned floor→authored public-
      // facet upgrade the 0031 checkpoint permits. Spread (not nested) so it stays absent on the seeded floor
      // and on pre-#1067 saves (no spurious change to the byte-compare for an un-authored character).
      ...(hg.character.deepProfileAuthored === true ? { deepProfileAuthored: true } : {}),
    };
    souls[hg.id] = {
      emotionalState: hg.soul.emotionalState,
      volatility: hg.soul.volatility,
      // The live emotional trajectory (0041) — persisted + counted for non-degradation (0007/0030).
      emotionalHistory: [...(hg.soul.emotionalHistory ?? [])],
      memory: [...hg.soul.memory],
      relationshipBeliefs: beliefsByHolder.get(hg.id) ?? [],
    };
  }
  // The knowledge layer is now part of the snapshot (B40), so the non-degradation checkpoint (0031)
  // can see it — a restart that dropped what houseguests told the player would fail isSuperset/counts.
  const knowledge: GameState["knowledge"] = [];
  if (snap.knowledge) {
    for (const [entity, facts] of Object.entries(snap.knowledge.knowledge)) {
      for (const fact of facts) knowledge.push({ entity, fact });
    }
  }
  // Audit C4: suspicions + Vault records are persisted detail the checkpoint must see —
  // previously the projection dropped both, so whole classes of degradation were invisible
  // to the fail-closed 0031 gate. Vault crosses as IDS ONLY: the projection feeds the
  // checkpoint's counting/superset math, never an outward surface.
  const suspicions: NonNullable<GameState["suspicions"]> = [];
  if (snap.knowledge) {
    for (const [entity, list] of Object.entries(snap.knowledge.suspicions)) {
      for (const s of list) suspicions.push({ entity, suspicion: { id: s.id, content: s.content, ts: s.ts } });
    }
  }
  const gs: GameState = {
    coreVersion: 1,
    vaultVersion: 1,
    journalVersion: 1,
    events: snap.events,
    knowledge,
    relationships: snap.relationships,
    souls,
    characters,
    suspicions,
    vaultIds: (snap.vault ?? []).map((r) => r.id),
    // 0062 — the frozen zeitgeist snapshot rides into the 0007 projection so the non-degradation
    // checkpoint (0031) byte-stable-guards it (it must never regenerate or drift). Conditional spread
    // keeps an absent snapshot absent (a pre-0062 / no-provider save never trips a spurious failure).
    ...(snap.worldSnapshot !== undefined
      ? { worldSnapshot: snap.worldSnapshot as unknown as Record<string, unknown> }
      : {}),
  };
  _gameStateCache.set(snap, gs);
  return gs;
}

/**
 * PERSIST-8 — the 0031 checkpoint's `GameState` projection (above) is deliberately engine-agnostic
 * (0007 predates 0058+), so it never carried the newer `SessionCore` dimensions features 0058–0107
 * added. That left a real coverage gap: a regression in any of them was invisible to the fail-closed
 * non-degradation gate. These two functions are the engine-layer companion to `saveState.ts`'s
 * `counts`/`isSuperset` — SAME discipline (append-only ⇒ id/subset presence, monotonic accumulators ⇒
 * non-decreasing counts), applied directly to the `SessionSnapshot` (never routed through `GameState`,
 * so `src/domain` stays engine-type-free).
 *
 * ONLY dimensions with a verified append-only/monotonic contract in `GameSessionAdapter` are covered.
 * Deliberately EXCLUDED (checked against the source, not guessed) because they are legitimately
 * mutable CURRENT state — the mandate's "never thins" promise was never made for them, and guarding
 * them would fault on ordinary play:
 *   - `campaigns` / `drives` — pruned/rebuilt wholesale every `campaignTick` (finished or owner-evicted
 *     campaigns are filtered OUT; `drives` is fully replaced each tick).
 *   - `trajectories` / `trajectoryFolds` — an arc that decays to `steady` is deliberately DELETED
 *     ("dropped … and forgotten", `decayUntouchedTrajectories`); the fold ring buffer is capped to
 *     `recencyWindow` (oldest entries shifted out).
 *   - `alliances` — dissolves (removed from the list) the moment membership drops below two.
 *   - `storyThreads` — an authored profile update REPLACES a source's whole thread set (filter-then-
 *     concat), so thread ids do not persist stably.
 *   - `secretPlayerBluffBelief` — a resolved bluff removes the caught subject from the belief list.
 *   - `presence` / `presenceBase` / `presenceTenure` / `presenceZone` / `trackedSightings` /
 *     `readAnchors` — current-position / per-week snapshot state, overwritten by design every tick/week
 *     (like `ceremony`/`live`, already outside the checkpoint).
 *   - `pacingDripCount` (resets every new week by design; `pacingDripWeek` moves with it).
 *   - `seenMessageIds` (P0g) - a bounded ring: once full it drops the oldest id for each new one (count holds at the cap, content rolls) - not a monotonic accumulator.
 *   - `approachCooldown` / `approachShown` (issue #1322) — the per-NPC remaining-stretches counter
 *     legitimately counts back DOWN to 0 and drops out of the map as the cooldown lapses, and the
 *     shown-initiators record is fully replaced each stretch, by design (like `presence` above) —
 *     neither is a monotonic accumulator.
 * Season boundaries (a brand-new game or the one sanctioned restart door) are exempt structurally: the
 * orchestrator only ever diffs a baseline against a LATER candidate of the SAME season — a season's
 * first commit has no baseline at all (`Orchestrator.commitPlayerTurn`), so a reset-to-empty at season
 * start is never seen as a "later" snapshot thinning an "earlier" one.
 */
export interface SessionCoreCounts {
  campaignTickCount: number;
  playerCampaignMoveCount: number;
  juryHouseTickCount: number;
  juryHouseArrivals: number;
  eruptionCount: number;
  triggerTickCount: number;
  pacingTickCount: number;
  confideLieCount: number;
  secretExposeCount: number;
  secretTradeCount: number;
  secretPlayerBluffCount: number;
  playerTieSurfaceCount: number;
  tieScheduleTickCount: number;
  surfacedThreadCount: number;
  tieExposureCount: number;
  tieRevealTickCount: number;
  legendTickCount: number;
  legendCount: number;
  legendLastActTick: number;
  secretBarterTickCount: number;
  secretBarterCount: number;
  showrunnerNoteCount: number;
  showrunnerReweightCount: number;
  presenceTickCount: number;
  tellOnsetCount: number;
  lastConfessionalSweepDay: number;
}

/** The newer monotonic per-season counters (0059/0060/0075/0085/0091/0092/0093/0099/0100/0101) — each is
 *  verified `++`-only (or, for `legendLastActTick`, non-decreasing) in `GameSessionAdapter`, reset only at
 *  a season boundary (never mid-season). */
export function sessionCoreCounts(snap: SessionSnapshot): SessionCoreCounts {
  return {
    campaignTickCount: snap.campaignTickCount ?? 0,
    playerCampaignMoveCount: snap.playerCampaignMoveCount ?? 0,
    juryHouseTickCount: snap.juryHouseTickCount ?? 0,
    juryHouseArrivals: snap.juryHouseArrivals ?? 0,
    eruptionCount: snap.eruptionCount ?? 0,
    triggerTickCount: snap.triggerTickCount ?? 0,
    pacingTickCount: snap.pacingTickCount ?? 0,
    confideLieCount: snap.confideLieCount ?? 0,
    secretExposeCount: snap.secretExposeCount ?? 0,
    secretTradeCount: snap.secretTradeCount ?? 0,
    secretPlayerBluffCount: snap.secretPlayerBluffCount ?? 0,
    playerTieSurfaceCount: snap.playerTieSurfaceCount ?? 0,
    legendTickCount: snap.legendTickCount ?? 0,
    legendCount: snap.legendCount ?? 0,
    legendLastActTick: snap.legendLastActTick ?? 0,
    secretBarterTickCount: snap.secretBarterTickCount ?? 0,
    secretBarterCount: snap.secretBarterCount ?? 0,
    tieScheduleTickCount: snap.tieScheduleTickCount ?? 0,
    surfacedThreadCount: snap.surfacedThreadCount ?? 0,
    tieExposureCount: snap.tieExposureCount ?? 0,
    tieRevealTickCount: snap.tieRevealTickCount ?? 0,
    showrunnerNoteCount: snap.showrunnerNoteCount ?? 0,
    showrunnerReweightCount: snap.showrunnerReweightCount ?? 0,
    presenceTickCount: snap.presenceTickCount ?? 0,
    tellOnsetCount: snap.tellOnsetCount ?? 0,
    lastConfessionalSweepDay: snap.lastConfessionalSweepDay ?? 0,
  };
}

/** Mirrors `saveState.ts`'s `countsNonDecreasing` for the counters above. */
export function sessionCoreCountsNonDecreasing(later: SessionCoreCounts, earlier: SessionCoreCounts): boolean {
  return (Object.keys(earlier) as Array<keyof SessionCoreCounts>).every((k) => later[k] >= earlier[k]);
}

/**
 * Mirrors `saveState.ts`'s `isSuperset` for the newer append-only `SessionCore` maps/sets — presence
 * (and, where the contract guarantees it, per-key non-regression) only. A field's VALUE may still
 * legitimately mutate in place (a deal's status resolves, a confided tier is caught out as a lie and
 * corrected) — only outright loss of an already-persisted key/entry is flagged, exactly like the
 * relationship-edge / Vault-id presence checks above.
 */
export function sessionCoreIsSuperset(later: SessionSnapshot, earlier: SessionSnapshot): boolean {
  // deals (0039): append-only by id — `DealTracker` only ever `.push()`s; `expireWeekScoped` flips
  // `status` in place and never removes an entry (src/engine/deals.ts).
  const laterDealIds = new Set((later.deals ?? []).map((d) => d.id));
  for (const d of earlier.deals ?? []) if (!laterDealIds.has(d.id)) return false;

  // deepProfiles (0058): the hidden §3 layer never loses a houseguest's entry once generated — an
  // authoring upgrade REPLACES a profile's content in place, never deletes the key.
  const laterProfiles = later.deepProfiles ?? {};
  for (const id of Object.keys(earlier.deepProfiles ?? {})) if (!(id in laterProfiles)) return false;

  // confideState (0075): the trust-gated confidence ledger never forgets a houseguest it has already
  // confided in. The {tier,truthful} VALUE may legitimately change (a caught lie flips to the truth,
  // `GameSessionAdapter.confide`), so only presence is guarded — not tier-rank monotonicity.
  const laterConfide = later.confideState ?? {};
  for (const id of Object.keys(earlier.confideState ?? {})) if (!(id in laterConfide)) return false;

  // jurorTold (0129 slice 4): the contents a juror told the player in the jury house — append-only; a dropped
  // telling would silently erase part of the informed vote card.
  const laterJurorTold = new Set(later.jurorTold ?? []);
  for (const c of earlier.jurorTold ?? []) if (!laterJurorTold.has(c)) return false;

  // secretUsedAs (0093/0099): once a wielded secret is recorded, the record is never lost. Its value can
  // still transition traded→exposed, so only presence is guarded, not value stability.
  const laterUsedAs = later.secretUsedAs ?? {};
  for (const id of Object.keys(earlier.secretUsedAs ?? {})) if (!(id in laterUsedAs)) return false;

  // privateOrientations (0063): a closeted orientation is never silently dropped.
  const laterOrientations = later.privateOrientations ?? {};
  for (const id of Object.keys(earlier.privateOrientations ?? {})) if (!(id in laterOrientations)) return false;

  // textureOverrides (0070): once an off-screen event gets model-voiced prose, it is never un-textured.
  const laterTexture = later.textureOverrides ?? {};
  for (const id of Object.keys(earlier.textureOverrides ?? {})) if (!(id in laterTexture)) return false;

  // nominationWeeks (0060 §3): the distinct weeks a houseguest has been nominated only ever grow
  // (`GameSessionAdapter.recordNominationWeeks`: `??= []` then push-if-absent, never a removal).
  for (const [id, weeks] of Object.entries(earlier.nominationWeeks ?? {})) {
    const laterWeeks = new Set(later.nominationWeeks?.[id] ?? []);
    for (const w of weeks) if (!laterWeeks.has(w)) return false;
  }

  // surfacedTieSubjects (0059 §5): a discovered pre-game tie subject is never un-surfaced (Set, add-only).
  const laterTieSubjects = new Set(later.surfacedTieSubjects ?? []);
  for (const s of earlier.surfacedTieSubjects ?? []) if (!laterTieSubjects.has(s)) return false;

  // 0095 — a pre-show tie's `exposure` (sealed → surfaced-to-house → public) never regresses to a
  // LESS-exposed state across a save/restore. Matched by unordered pair (a/b order is not guaranteed
  // stable across a re-derive on an old save with no `seededRelationships` at all).
  const exposureRank: Record<string, number> = { sealed: 0, "surfaced-to-house": 1, public: 2 };
  const laterTieExposure = new Map<string, number>();
  for (const t of later.seededRelationships?.ties ?? []) {
    laterTieExposure.set([t.a, t.b].sort().join("|"), exposureRank[t.exposure ?? "sealed"]!);
  }
  for (const t of earlier.seededRelationships?.ties ?? []) {
    const key = [t.a, t.b].sort().join("|");
    const laterRank = laterTieExposure.get(key);
    const earlierRank = exposureRank[t.exposure ?? "sealed"]!;
    if (laterRank === undefined || laterRank < earlierRank) return false;
  }

  // pacingLastDrippedWeek (0092): once a thread edges toward the player, the week it did so is recorded
  // and can only move FORWARD (it is always set to the current, monotonically-increasing season week).
  const laterDripped = later.pacingLastDrippedWeek ?? {};
  for (const [id, week] of Object.entries(earlier.pacingLastDrippedWeek ?? {})) {
    const laterWeek = laterDripped[id];
    if (laterWeek === undefined || laterWeek < week) return false;
  }

  // showrunnerNotes (0101/#1401): the Vault-held production bible is APPEND-ONLY by `seq` — a note is
  // never rewritten or dropped once composed, so every earlier note's seq must still be present. The
  // bible only ever DEEPENS over a season (non-degradation #4).
  const laterNoteSeqs = new Set((later.showrunnerNotes ?? []).map((n) => n.seq));
  for (const n of earlier.showrunnerNotes ?? []) if (!laterNoteSeqs.has(n.seq)) return false;

  // canon (K4 §2.5): the ledger is never thinned. No entry disappears, its words, category, scope and provenance
  // never change, its status only moves forward out of `active`, its reference counters never go back, and the
  // id counter never goes back (`canonSupersetProblems`). Both sides are read the way a load reads them.
  if (earlier.canon !== undefined || later.canon !== undefined) {
    if (canonSupersetProblems(restoreCanon(earlier.canon).ledger, restoreCanon(later.canon).ledger).length > 0) return false;
  }

  return true;
}
