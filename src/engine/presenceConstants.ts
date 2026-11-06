/**
 * Presence & overhearing tunables (feature 0049) — the single home for every number the
 * presence layer uses, in the 0026/0028 constants-module pattern (no magic numbers inline;
 * a future God-Mode knob).
 */
export interface PresenceConstants {
  /**
   * Chance a resolved scene is overheard AT ALL (one roll per scene, one ear when it opens).
   * Deliberately low: an overhear is a rare, special beat — and every success is a recorded
   * propagation event, so volume also costs persistence (the per-commit snapshot scales with
   * the event store).
   */
  overhearProb: number;
  /** Chance a houseguest moves rooms on a tick at all (otherwise they stay put). */
  moveProb: number;
  /**
   * Chance an NPC who is CURRENTLY IN THE PLAYER'S ROOM moves on a tick (feature 0076). Far lower
   * than `moveProb`: present company is mid-scene with the player, so they STAY by default — the
   * old `moveProb` (tuned for a tick = a chunk of house-time) churned ~60% of the room out from under
   * a live conversation every turn (the pop-in/pop-out immersion bug). They keep full agency to leave
   * — when this low roll fires they DO get up and go, and the affinity-weighted destination reads as a
   * motivated exit (toward a stronger bond) — but the scene no longer reshuffles every message.
   *
   * CRITICAL (calibration): this lever is applied ONLY to the personality-WEIGHTED, player-facing pass
   * (the dedicated movement stream, isolated from calibration). It must NEVER touch the un-weighted BASE
   * assignment the off-screen society pairs on — that still draws `moveProb` from the SHARED stream with
   * a byte-identical draw count, or the seeded juryReach spine re-phases (the L21/L24 lesson). So this is
   * NOT a retune of `moveProb` (which is load-bearing for the base); it is a separate, weighted-only floor.
   */
  companionMoveProb: number;
  /** Weight of affinity toward already-placed occupants when choosing a room. */
  affinityPull: number;
  /** How strongly the HOH gravitates to the HOH room. */
  hohRoomPull: number;
  /** Confidence carried by an overheard fact (a witness's is full/unset; this is partial). */
  overhearConfidence: number;
  /** Fraction of a scene's content an overhearer catches (NEVER 1 — through a wall, not a transcript). */
  overhearFraction: number;
  /**
   * Closed-door MUFFLE (0077 Phase 2): the multiplier on the per-scene overhear gate when the scene
   * happens behind a PRIVATE (closed) door — harder to hear into than an open-core room. Strictly
   * OPT-IN: only the player channel passes it (its own isolated `commands:` rng stream); the
   * off-screen society/orchestrator spine passes nothing, so the calibration draws are byte-identical.
   */
  doorMuffle: number;
  /**
   * SEATED sub-zone DRIFT (issue #792 — zones seated into `assignRooms`, not computed on-read): the
   * per-tick chance a houseguest who is HOLDING their zoned room shifts to a DIFFERENT sub-zone (corner
   * to corner), so a long stay reads as organic ambling instead of a fixed deterministic corner. Modest
   * — most ticks they stay put in their corner. Drawn ONLY on the dedicated movement stream (the seated
   * `zonesOut` opt-in), NEVER the shared/base calibration spine ⇒ zone seating is calibration-neutral.
   */
  zoneDriftProb: number;
  /**
   * SEATED sub-zone CLUSTER pull (issue #792): the weight a candidate zone gains for each already-seated
   * zone-mate the mover has affinity toward — so two specific bonded houseguests can end up sharing a
   * corner (affinity clustering, the zone-scoped sibling of the room-level `affinityPull`). `0` ⇒ no
   * clustering (zones seed/drift on bare seeded variance). Read-side weighting only — draws no extra rng.
   */
  zoneClusterPull: number;
}

export const PRESENCE: PresenceConstants = {
  overhearProb: 0.1,
  moveProb: 0.6,
  companionMoveProb: 0.12,
  affinityPull: 0.8,
  hohRoomPull: 0.5,
  overhearConfidence: 0.4,
  overhearFraction: 0.6,
  doorMuffle: 0.4,
  zoneDriftProb: 0.25,
  zoneClusterPull: 1.0,
};

/**
 * The PRIVACY / tracked-occupancy tunables (0077 Phase 2 — "who is behind a closed door" as
 * KNOWLEDGE, not a free ambient read). Pure read-side numbers — they never touch any rng stream, so
 * they cannot perturb calibration. All are God-Mode-knobbable later (the 0026/0028 constants pattern).
 */
export interface PrivacyConstants {
  /**
   * STALE-belief horizon (open question #2): how many presence ticks a tracked sighting stays on the
   * board before it decays out entirely. A belief older than this is dropped (you've lost the thread).
   * A still-fresh belief whose subject has since moved is reported as STALE, not dropped — the player
   * believes it until a new pathway corrects it.
   */
  trackedHorizonTicks: number;
  /**
   * STALE flag age: ticks before a still-live belief reads as `stale` ("you saw them go in a while
   * ago"). Derived from AGE alone — NEVER from the secret live position (that would leak that they
   * left). Below the horizon, so a belief flags stale before it finally decays out.
   */
  staleAfterTicks: number;
  /**
   * CONSPICUOUSNESS threshold (open question #3): a private room held by EXACTLY this many tracked
   * high-tenure houseguests trips the "holed up together" read. Exactly two, per the owner's framing
   * ("two alone too long implies gameplay").
   */
  conspicuousPairSize: number;
  /** Minimum ticks a sighting must have aged before it reads as conspicuous (both subjects "a while" in). */
  conspicuousMinTenureTicks: number;
  /** Confidence carried by a tracked sighting (a watched movement — solid, but not a witnessed scene). */
  trackedConfidence: number;
  /**
   * The per-tick chance the HOUSE whispers about a conspicuous closed-door pairing (the 0077 NPC-side
   * increment): when two NPCs are holed up together, an onlooker occasionally starts a Vault-free
   * position rumor that diffuses NPC-to-NPC. Rare — a rumor rises only sometimes, and only when a pairing
   * already exists. Runs on a DEDICATED rng (never the society/vote spine), so this number is texture,
   * never calibration.
   */
  whisperProb: number;
}

export const PRIVACY: PrivacyConstants = {
  trackedHorizonTicks: 6,
  staleAfterTicks: 3,
  conspicuousPairSize: 2,
  conspicuousMinTenureTicks: 2,
  trackedConfidence: 0.7,
  whisperProb: 0.35,
};

/**
 * NPC-personality movement weighting (residual of ledger L21/L24) — house movement bent by WHO a
 * houseguest is, so the floor plan feels personality-driven: a social butterfly roams and seeks
 * company; a low-social introvert clusters or holds a room; a volatile, rattled soul can't sit still.
 *
 * Every term is a BOUNDED nudge layered on the base 0049 assignment (stay-or-adjacent, affinity-
 * clustered, the one-room invariant) — it bends the per-NPC move rate and the affinity-seek pull,
 * never the hard floor-plan rules. The sibling-constants pattern (decisionConstants/relationship-
 * Constants): no magic number is hard-coded at a call site.
 *
 * CRITICAL (the L21/L24 root-cause + the two-reverted-attempts lesson). The personality-WEIGHTED,
 * player-facing positions are drawn from a DEDICATED movement RNG stream — `presenceTick` forks its own
 * per-tick stream off the GAME seed — so these constants NEVER touch the orchestrator's shared per-user
 * stream that drives the off-screen society + relationship folds + votes. But the CALIBRATION-NEUTRAL
 * BASE assignment the society pairs on still draws from that SHARED stream, un-weighted, with the SAME
 * draw count as the pre-feature build — so the seeded `juryReach` calibration spine is byte-identical.
 * Both prior attempts broke that spine by changing the shared-stream consumption: the first ADDED
 * weighting rolls to it; the second stopped drawing from it ENTIRELY (the un-weighted assignment used
 * to BE part of the spine). The fix keeps the base on the shared stream and the weighting on its own.
 * (Guards: `tests/property/movementStreamIsolation` + the shared-draw-count test in
 * `tests/unit/presence.test.ts` + the permanent `tests/property/juryReach` gate.) The weighting reads
 * the static CHARACTER `stats.social` and the dynamic SOUL volatility; no number ever crosses the Vault
 * Wall (presence reads stay Vault-free).
 */
export interface MovementPersonality {
  /**
   * The center of the social-aptitude scale (`stats.social` is ~0.4–0.85, centered near here).
   * Aptitude is read as a SIGNED deviation from this center: above ⇒ more roaming/seeking, below ⇒ less.
   */
  socialCenter: number;
  /**
   * How hard social aptitude bends the per-tick MOVE probability. A high-social houseguest's base
   * `moveProb` rises (they roam); a low-social one's falls (they hold a room). The result is clamped
   * into [moveProbFloor, moveProbCeil] so it stays a probability and nobody ever fully freezes/teleports.
   */
  moveAptitudeWeight: number;
  /**
   * How hard social aptitude bends the AFFINITY PULL toward occupied rooms — high-social houseguests
   * seek company more strongly (cluster toward where their bonds are), low-social ones less so.
   */
  seekAptitudeWeight: number;
  /**
   * How much a houseguest's SOUL volatility (current emotional turbulence) adds to their move rate —
   * a rattled, churning soul can't sit still. `0.5` (a settled soul) is the no-op center.
   */
  volatilityWeight: number;
  /** The hard floor/ceiling the personality-adjusted move probability is clamped into. */
  moveProbFloor: number;
  moveProbCeil: number;
  /** The hard floor the personality-adjusted affinity pull is clamped to (never negative — no repulsion). */
  seekPullFloor: number;
}

export const MOVEMENT_PERSONALITY: MovementPersonality = {
  socialCenter: 0.55,
  moveAptitudeWeight: 0.6,
  seekAptitudeWeight: 1.2,
  volatilityWeight: 0.3,
  moveProbFloor: 0.05,
  moveProbCeil: 0.95,
  seekPullFloor: 0,
};

/**
 * INTENTIONAL MOVEMENT (feature 0078) — NPCs move toward what their MOTIVATION wants, exactly as the
 * player does, so co-presence is EARNED, not arbitrary drift. The owner's headline ask: "NPCs should
 * act just as intentional as the player would be in terms of location selection."
 *
 * Where MOVEMENT_PERSONALITY bends HOW MUCH a houseguest roams (a trait), INTENT bends WHERE they go
 * (a goal): toward the room of whoever their relationship read points at — an ally to bond with, a
 * rival/target to work, a deal/bloc partner to honor — and (softly) AWAY from a pure threat they want
 * distance from. The pull is read off the relationship model (the caller supplies the per-candidate
 * "how much does THIS houseguest want to be in a room with THAT one, and with what valence" signal),
 * so when two end up together it is usually because ONE of them went looking for the other.
 *
 * CRITICAL — the calibration story is DIFFERENT from MOVEMENT_PERSONALITY's. Personality weighting had
 * to be calibration-NEUTRAL (cosmetic), so it rode a dedicated stream off the base. INTENT is
 * DELIBERATELY calibration-LOAD-BEARING: it changes who clusters → who the off-screen society pairs →
 * the relationship folds that feed votes. By owner ruling (0078) location is MEANT to affect play, so
 * intent ships WITH a calibration pass (juryReach + the gradient re-verified). It therefore applies to
 * the calibration-bearing BASE occupancy (drawn from the shared stream), and — like the personality
 * weighting — it only RE-WEIGHTS the existing stay-gate threshold and the per-candidate destination
 * weights; it DRAWS NO rng of its own (one stay-gate draw + at most one destination draw, exactly as
 * before), so the per-NPC shared-stream draw COUNT is unchanged (the spine re-phases only by which
 * ROOM intent steers toward, which is precisely the change the calibration pass re-tunes for). All
 * numbers here are God-Mode-knobbable later (the 0026/0028 sibling-constants pattern); no number ever
 * crosses the Vault Wall — intent reads the same Vault-free relationship edges presence already uses.
 *
 * `moveIntentStrength` is the headline tuning lever the 0078 calibration pass turns: start MODEST so
 * the house doesn't collapse into one room, raise it for more agenda-driven clustering. The whole
 * intent contribution scales by it, so `0` ⇒ intent is inert ⇒ byte-identical to the pre-0078 base.
 */
export interface MovementIntentConstants {
  /**
   * The master gain on the WHOLE intent contribution (open question #1 — "move-intent strength"). It
   * multiplies every per-candidate intent bonus AND the pursuit move-gate nudge, so it is the single
   * knob the calibration pass turns. `0` ⇒ intent fully inert (the base is byte-identical to pre-0078).
   * Modest by default so motivation BENDS room choice without the house all collapsing into one room.
   */
  moveIntentStrength: number;
  /**
   * How much an UNSATISFIED pursuit (the houseguest's motive target is NOT in their current room)
   * raises their per-tick MOVE probability — they get up and go looking. Scaled by `moveIntentStrength`
   * and clamped into the SAME [moveProbFloor, moveProbCeil] the personality move-rate uses, so nobody
   * teleports every tick. A SATISFIED pursuit (target already here) leaves the rate untouched (they
   * have no reason to leave on intent's account — stickiness is 0076's job, not intent's).
   */
  pursuitMoveBias: number;
  /**
   * The hard cap on the per-candidate intent BONUS weight added to a destination room, as a multiple of
   * the room's base affinity-cluster weight — so intent can strongly favor a room without ever zeroing
   * the seeded variance the calibration spine rests on (a clear motive STEERS the roll; it never
   * forces it). The away-from-threat penalty is symmetric (a multiplicative discount toward this cap).
   */
  maxRoomBonus: number;
  /**
   * The minimum CHARGE (how far the strongest relationship signal — bond or threat — sits above its
   * neutral baseline) before a houseguest's read of another bends their movement at all. Below it the
   * tie is too lukewarm to be an agenda, and seeded drift rules (the house isn't ALL pursuit). Keeps
   * the motive set small — a typical NPC chases the one or two houseguests their game centers on.
   */
  minCharge: number;
  /**
   * AVOIDANCE gate (the read side): a pull flips from drawn-toward to "keep distance" only when the
   * THREAT charge is at least this multiple of the BOND charge — a danger that clearly dominates any
   * warmth. Below it, a charged threat still pulls you TOWARD them (you corner a rival you can work).
   */
  avoidThreatDominance: number;
  /**
   * AVOIDANCE gate (the read side, second condition): even a threat-dominant read stays drawn-toward
   * (you go WORK them) while there is at least this much bond charge to leverage. Avoidance is reserved
   * for a pure danger you have nothing to gain from — only then do you keep your distance.
   */
  workableBondFloor: number;
}

export const MOVEMENT_INTENT: MovementIntentConstants = {
  moveIntentStrength: 0.15,
  pursuitMoveBias: 0.18,
  maxRoomBonus: 2.0,
  minCharge: 0.08,
  avoidThreatDominance: 1.5,
  workableBondFloor: 0.1,
};

/**
 * ORW-212 / ORW-210 (Ryne, playtest: "they are all moving too fast, constantly moving" and "NPCs gravitate to wherever the player is"; "Yes, all of it") - the CALM, non-magnetic movement of the
 * PLAYER-FACING (weighted) view. ASSUMED starting points pending Ryne's read; every number is here and only the weighted pass reads them (the calibration-neutral base is untouched).
 *  - moveScale: multiplies an ordinary NPC's per-tick move chance (0.6 base -> ~0.35).
 *  - maxMoverShare: at most this share of the active houseguests relocate in ONE tick (the house drifts gradually instead of reshuffling together); the order that decides who is blocked rotates each tick.
 *  - holdTicks: how many presence ticks the player's live conversation partners are held in the room after a recorded scene with them (others in the room are NOT held).
 *  - playerPullsDestinations: false => the player does not count in the affinity pull that picks an NPC's destination (NPCs move for their own reasons).
 */
export const CALM_PRESENCE = { moveScale: 0.58, maxMoverShare: 0.2, holdTicks: 2, playerPullsDestinations: false } as const;
