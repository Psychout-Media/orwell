/**
 * Feature 0104 — season-over-season NOTORIETY: a reputation that precedes the returning player into a
 * NEW cast. PURE engine module (no I/O, NO Vault handle by construction): it is handed already-read
 * OPEN-SET facts (placement, the vote/eviction record, the relationship trajectory at each eviction,
 * comp wins, jury respect — all facts the player witnessed or was told, all the 0048 retrospective
 * already unseals) and returns a small, bounded `NotorietySummary` + a bounded, seeded day-one bias.
 *
 * The bright line (read first): what crosses the season door is a BOUNDED SUMMARY, never raw Vault
 * state — no soul, no hidden edge, no other houseguest's secret, no off-screen scene (mandate #2). The
 * finished season's Vault stays sealed on disk; the summary is computed ALONGSIDE it, never FROM it.
 * And the engine still owns every outcome magnitude (mandate #3): notoriety nudges the DIRECTION of the
 * new cast's NPC→player day-one reads — inside the existing move-in scatter envelope — and NOTHING else.
 *
 * Determinism (mandate #4): `notorietyBias` runs on the EXISTING day-one seeded rng (same seed + same
 * notoriety ⇒ same biased edges), and with no summary / `weight = 0` every bias is exactly 0 ⇒
 * `seedFirstImpressions` is byte-identical and the calibration spine is unmoved.
 */
import type { Archetype } from "./characterFactory";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { NOTORIETY } from "./notorietyConstants";
import { clamp } from "../domain/num";

const signed = (x: number): number => clamp(x, -1, 1);

/**
 * The four bounded, signed reputation facets in [-1,1] — derived from the OPEN-SET record, never a
 * Vault read. These are the dials the next cast's day-one read consults.
 */
export interface ReputationFacets {
  /** kept-deal / had-their-back record  → warmer day-one reads. */
  loyalty: number;
  /** blindside / betrayal record         → warier, higher-threat reads. */
  treachery: number;
  /** comp dominance / deep run           → higher-threat, respect. */
  competitor: number;
  /** jury respect / bonds at eviction    → warmer, "heard you're good with people". */
  social: number;
}

/**
 * The bounded, fixed-shape object that crosses the season door (R1). Small and capped — a REPUTATION,
 * not a transcript. Persisted at the user-account level (the same physical user across all their
 * seasons), monotonic in `seasonsPlayed`. Every field is OPEN-SET.
 */
export interface NotorietySummary {
  /** Monotonic — deepens, never thins (non-degradation, mandate #4). */
  seasonsPlayed: number;
  /** The most recent season's placement: 1 = winner, 2 = runner-up, … (open-set fact). */
  lastPlacement: number;
  /** The best (lowest) placement across all of THIS user's prior seasons. */
  bestPlacement: number;
  /** The four bounded reputation facets the next cast's day-one read consults. */
  reputation: ReputationFacets;
  /**
   * A few SHORT, Vault-FREE legend clauses — the open-set "what they heard," for the narrator to voice
   * as a returning-cast callback (ADR 0003: facts to voice, never a script; never a verbatim secret).
   */
  legendBeats: string[];
}

/**
 * The OPEN-SET outcome record handed to `deriveNotoriety`. Every field is a fact the player witnessed
 * or was told (the 0048 retrospective already unseals all of it). NO Vault record, soul, or hidden edge
 * is in this shape by construction — the caller (the registry, at the season-end terminal) builds it
 * from the live season's PUBLIC ceremony record, never from the Vault.
 */
export interface OpenSetSeasonOutcome {
  /** The player's final placement (1 = winner, 2 = runner-up, …). */
  placement: number;
  /** The size of the cast that played this season (to normalize placement to [0,1]). */
  castSize: number;
  /** Comp wins (HOH reigns + veto wins) the player earned — a public-facts tally (the `resume`). */
  playerCompWins: number;
  /**
   * How each evictee read the manner of the PLAYER's role in their eviction (the open-set
   * `mannerByEvictee[evictee][PLAYER]` reads, which the player witnessed / the retrospective unseals):
   * a blindside/betrayal the player was responsible for, or a respectful cut. These are the loyalty /
   * treachery raw material — open-set, never the hidden edge numbers.
   */
  playerEvictionRoles: Array<{ blindsided?: boolean; betrayed?: boolean; respected?: boolean }>;
  /** Whether the player reached the jury (a respected deep run — open-set). */
  reachedJury: boolean;
  /** Whether the player reached the Final 2. */
  reachedFinalTwo: boolean;
  /** Of the jury votes cast at the finale, the share the player won (0..1) — open-set ceremony fact. */
  juryVoteShare: number;
}

/** Count the truthy reads of a manner field across the player's recorded eviction roles. */
function countRoles(roles: OpenSetSeasonOutcome["playerEvictionRoles"], key: "blindsided" | "betrayed" | "respected"): number {
  let n = 0;
  for (const r of roles) if (r[key]) n++;
  return n;
}

/**
 * Build the bounded reputation facets from the OPEN-SET outcome (R1). Placement is normalized to [0,1]
 * (1 = winner); deals/betrayals/comp wins/jury respect each fold in with their `notorietyConstants`
 * weight; the result is clamped to [-1,1]. NO Vault read — the input is open-set by construction.
 */
function deriveReputation(o: OpenSetSeasonOutcome): ReputationFacets {
  const { derive } = NOTORIETY;
  // Placement → respect: a deep run (low placement number) reads as "knows how to play".
  const place01 = o.castSize > 1 ? clamp((o.castSize - o.placement) / (o.castSize - 1), 0, 1) : 0;
  const respected = countRoles(o.playerEvictionRoles, "respected");
  const blindsided = countRoles(o.playerEvictionRoles, "blindsided");
  const betrayed = countRoles(o.playerEvictionRoles, "betrayed");
  const juryRespect = (o.reachedFinalTwo ? o.juryVoteShare : o.reachedJury ? 0.4 : 0);

  const competitor = signed(
    place01 * derive.placementRespect + o.playerCompWins * derive.compWin + juryRespect * derive.juryRespect * 0.4,
  );
  const treachery = signed((blindsided + betrayed) * derive.treacheryBeat);
  const loyalty = signed(respected * derive.loyaltyBeat - (blindsided + betrayed) * derive.treacheryBeat * 0.5);
  const social = signed(juryRespect * derive.juryRespect + respected * derive.loyaltyBeat * 0.5);
  return { loyalty, treachery, competitor, social };
}

/**
 * A few SHORT, Vault-free `legendBeats` glosses — the open-set "what they heard," authored from the
 * outcome (same register as 0101's player-subject rumor gloss; never a real secret). Capped.
 */
function deriveLegendBeats(o: OpenSetSeasonOutcome, rep: ReputationFacets): string[] {
  // Season-agnostic glosses (the narrator improvises around them as texture, never an asserted fact —
  // ADR 0003): kept phrased so a multi-season returner is never mis-stated as "their first season".
  const beats: string[] = [];
  if (o.placement === 1) beats.push("has won a season of this game");
  else if (o.reachedFinalTwo) beats.push("made it all the way to the Final 2 of a past season");
  else if (o.reachedJury) beats.push("made the jury in a past season");
  if (rep.treachery > 0.4) beats.push("has a reputation for blindsiding their own allies");
  if (rep.loyalty > 0.4) beats.push("is known as someone who keeps their word");
  if (rep.competitor > 0.4) beats.push("is supposed to be a real competition threat");
  if (rep.social > 0.4) beats.push("is said to be dangerously good with people");
  return beats.slice(0, NOTORIETY.maxLegendBeats);
}

/**
 * Derive a bounded, fixed-shape `NotorietySummary` from a finished season's OPEN-SET outcome record
 * (R1). PURE — no Vault handle, no I/O. `seasonsPlayed` starts at 1 (this is the first recorded
 * season); `accumulateNotoriety` deepens it across seasons.
 */
export function deriveNotoriety(o: OpenSetSeasonOutcome): NotorietySummary {
  const reputation = deriveReputation(o);
  return {
    seasonsPlayed: 1,
    lastPlacement: o.placement,
    bestPlacement: o.placement,
    reputation,
    legendBeats: deriveLegendBeats(o, reputation),
  };
}

/**
 * MONOTONIC merge (non-degradation, mandate #4): `seasonsPlayed` only ever RISES, `bestPlacement` keeps
 * the better (lower) of the two, and each reputation facet keeps the larger MAGNITUDE earned (a later,
 * worse season never thins the carried notoriety below what was earned). `lastPlacement` tracks the
 * fresh season (it is a "most recent", not a "best"). `legendBeats` accumulate (deduped, capped).
 */
export function accumulateNotoriety(prior: NotorietySummary | null, fresh: NotorietySummary): NotorietySummary {
  if (!prior) return fresh;
  const keepMag = (a: number, b: number): number => (Math.abs(a) >= Math.abs(b) ? a : b);
  const beats = [...prior.legendBeats];
  for (const b of fresh.legendBeats) if (!beats.includes(b)) beats.push(b);
  return {
    seasonsPlayed: prior.seasonsPlayed + 1,
    lastPlacement: fresh.lastPlacement,
    bestPlacement: Math.min(prior.bestPlacement, fresh.bestPlacement),
    reputation: {
      loyalty: keepMag(prior.reputation.loyalty, fresh.reputation.loyalty),
      treachery: keepMag(prior.reputation.treachery, fresh.reputation.treachery),
      competitor: keepMag(prior.reputation.competitor, fresh.reputation.competitor),
      social: keepMag(prior.reputation.social, fresh.reputation.social),
    },
    legendBeats: beats.slice(0, NOTORIETY.maxLegendBeats),
  };
}

/**
 * The SIGNED day-one lean a houseguest reads off the player's notoriety, per relationship signal. It
 * combines the reputation facets the way `dayOnePerception` already leans the move-in edge:
 *   • trust    ← loyalty up, treachery down
 *   • affinity ← loyalty + social up, treachery down
 *   • threat   ← treachery + competitor up
 * Returned in [-1,1]; the caller scales it by `NOTORIETY.weight` (and per-NPC recognition) inside the
 * existing `MOVE_IN.spread` envelope. This is the ONLY player-coupled input — a bounded direction.
 */
function leanFor(rep: ReputationFacets, signal: "trust" | "affinity" | "threat"): number {
  switch (signal) {
    case "trust":    return signed(rep.loyalty - rep.treachery * 0.7);
    case "affinity": return signed(rep.loyalty * 0.6 + rep.social * 0.6 - rep.treachery * 0.5);
    case "threat":   return signed(rep.treachery * 0.8 + rep.competitor * 0.6);
  }
}

/**
 * How much a given archetype CARES about the player's notoriety on this signal — a bounded shading in
 * `[1 - shadeSpread, 1 + shadeSpread]` (never flips the sign, never escapes the weight bound). A
 * paranoid/strategic archetype reads a known threat MORE on `threat`/`trust`; a bond-seeking archetype
 * reads loyalty/social warmth MORE on `affinity`. Deterministic (no rng) — a pure archetype lens.
 */
function archetypeShade(archetype: Archetype, signal: "trust" | "affinity" | "threat"): number {
  const s = NOTORIETY.shadeSpread;
  // A small per-archetype emphasis in [-1,1] per signal; scaled by shadeSpread around 1.
  const wary: Archetype[] = ["mastermind", "villain", "analyst", "wildcard", "hothead"];
  const bond: Archetype[] = ["social-butterfly", "loyalist", "peacemaker", "underdog", "flirt"];
  let emph = 0;
  if (signal === "threat" || signal === "trust") emph += wary.includes(archetype) ? 1 : bond.includes(archetype) ? -0.4 : 0;
  if (signal === "affinity") emph += bond.includes(archetype) ? 1 : wary.includes(archetype) ? -0.4 : 0;
  return 1 + s * clamp(emph, -1, 1);
}

/**
 * The recognition + distortion an NPC applies to the reputation, drawn on the EXISTING day-one seeded
 * rng (R2 refinement). Each NPC's recognition sits in `[recognitionFloor, 1]` (not everyone "heard
 * about" the player equally); a minority hold a DISTORTED version (the 0094 idea) — weaker and possibly
 * sign-flipped. Returns a multiplier in roughly `[-distortionScale, 1]`. Pure given the rng.
 */
export function recognitionFor(rng: RandomnessSource): number {
  const base = NOTORIETY.recognitionFloor + (1 - NOTORIETY.recognitionFloor) * rng.next();
  if (rng.next() < NOTORIETY.distortionProb) {
    const flip = rng.next() < 0.5 ? -1 : 1; // a misremembered reputation may invert
    return base * NOTORIETY.distortionScale * flip;
  }
  return base;
}

/**
 * The bounded, seeded, archetype-shaded, recognition-modulated day-one BIAS one houseguest reads off
 * the player's notoriety on a given relationship signal. The single direction term `seedFirstImpressions`
 * adds beside the `dayOnePerception` lean — multiplied by `MOVE_IN.spread` at the call site so it rides
 * INSIDE the existing scatter envelope. With no summary / `weight = 0` ⇒ returns 0 (byte-identical).
 *
 *   bias = weight · lean(reputation, signal) · archetypeShade(archetype, signal) · recognition
 *
 * `recognition` is ONE per-NPC awareness level (drawn ONCE per houseguest via `recognitionFor`, off the
 * existing day-one stream), applied across all three signals so the NPC's read is internally consistent
 * (a high-recognition NPC reads the WHOLE reputation, a distorted one garbles all of it the same way).
 */
export function notorietyBias(
  summary: NotorietySummary | null,
  archetype: Archetype,
  signal: "trust" | "affinity" | "threat",
  recognition: number,
): number {
  if (!summary || NOTORIETY.weight === 0) return 0;
  const lean = leanFor(summary.reputation, signal);
  const bias = NOTORIETY.weight * lean * archetypeShade(archetype, signal) * recognition;
  // Normalize a signed zero (e.g. weight·negativeLean·0) to +0 so the day-one fold is byte-IDENTICAL
  // to the no-bias path at the zero edge (anti-sycophancy / non-degradation — never a -0 perturbation).
  return bias === 0 ? 0 : bias;
}
