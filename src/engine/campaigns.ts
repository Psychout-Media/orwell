/**
 * NPC CAMPAIGNS (feature 0085) — strategy executed over TIME, not one-tick impulses. A `Campaign` is a
 * houseguest's (or a bloc's) persistent, hidden, adaptive agenda: a GOAL aimed at a TARGET, pursued
 * across many beats and re-planned as the board shifts, until it resolves at a ceremony.
 *
 * THIS MODULE IS PURE + ENGINE-ONLY (Vault-sealed). It holds hidden strategy and the per-perspective
 * `knownTo` set (the symmetric-perspective spine: a campaign is its owner's private knowledge — every
 * OTHER houseguest AND the player learns of it only through a pathway, never an omniscient read). No
 * outward surface may import it (dependency-cruiser). It draws no I/O; magnitude is seeded.
 *
 * Phase A (this slice) is the model + the PURE logic (`generateInfluence`, `formCampaigns`,
 * `campaignTilt`, `replan`), unit-tested in isolation and NOT yet wired into the live off-screen tick
 * or the seeded decision weights — so it is inert and cannot perturb calibration. Phase B wires
 * execution + the decision tilt (behind the calibration guard); Phase C the player surfacing + scramble.
 */
import type { EntityId } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";

/** What a campaign is FOR. */
export type CampaignGoal = "evict" | "protect" | "build-alliance" | "win-power" | "discredit";
/** The concrete, adaptable steps — each folds through an EXISTING system (relationships/gossip/deals/…). */
export type CampaignMove = "lobby" | "plant" | "deal" | "position" | "throw";
/** A flip vote (day), a week's eviction push, or a season-long crusade. */
export type CampaignHorizon = "day" | "week" | "season";
export type CampaignStatus = "active" | "won" | "lost" | "abandoned";

export interface Campaign {
  id: string;
  /** One schemer, or a bloc acting together (0043). */
  owners: EntityId[];
  goal: CampaignGoal;
  /** Who it's aimed at (the evict/protect/discredit subject). */
  target: EntityId;
  /** The ordered, adaptable steps. */
  plan: CampaignMove[];
  /** How close to the goal (0..1) — VAULT-ONLY, never shown. */
  progress: number;
  horizon: CampaignHorizon;
  status: CampaignStatus;
  startedBeat: number;
  deadlineBeat: number;
  /** The owner's read of its odds (drifts with the board). */
  confidence: number;
  /**
   * Per-perspective knowledge (the symmetric-perspective spine): WHO is aware this campaign exists.
   * At formation this is the owners ONLY — it grows only as a pathway reaches someone (a lobby tells
   * the lobbied; gossip diffuses + drifts). A houseguest NOT in this set cannot voice or act on it,
   * exactly as the player cannot. The engine's omniscient read of ALL campaigns is for the closed-set
   * TALLY only (never a voiced NPC).
   */
  knownTo: EntityId[];
}

export interface CampaignConstants {
  /** The MAX tilt a fully-progressed, perfectly-pitched campaign adds to a seeded decision (Phase B). */
  base: number;
  /** Even no-trust lobbying lands a little (the floor of the trust multiplier). */
  trustFloor: number;
  /** How many campaigns may run at once — scarcity keeps the house legible. */
  maxConcurrent: number;
  /** A threat read at/above this can seed an "evict" campaign against the source. */
  threatThreshold: number;
  /** An affinity read at/above this can seed a "build-alliance" campaign. */
  allyThreshold: number;
  /** Beats in a week (the standard cadence) — sets a week-horizon deadline. */
  weekBeats: number;
  /** Progress accrued per advanced move (jittered) — a few ticks of lobbying build a real push. */
  progressPerMove: number;
  /** The ± jitter fraction on `progressPerMove` (seeded; the dedicated campaign stream). */
  progressJitter: number;
}

export const CAMPAIGN: CampaignConstants = {
  base: 0.25,
  trustFloor: 0.4,
  maxConcurrent: 4,
  threatThreshold: 0.55,
  allyThreshold: 0.6,
  weekBeats: 5,
  progressPerMove: 0.22,
  progressJitter: 0.4,
};

// PERSIST-2/BE-101: guard NaN → 0 — this clamp gates persisted fields (`Campaign.progress`/
// `.confidence`, `Drive.intensity`, `Character.influence`), so a NaN input must never write through.
// Finite inputs clamp exactly as before.
const clamp01 = (x: number): number => (Number.isNaN(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The two static CHARACTER aptitudes campaigns turn on (owner ruling 2026-06-25 — the tilt is a
 * strategy knob made of PEOPLE, not a flat constant): `persuasiveness` (how much this houseguest's
 * lobbying carries) and `susceptibility` (how easily THEY are swayed by others' campaigns —
 * gullibility ↔ conviction). Archetype-correlated, jittered, in [0,1]. Byte-stable like the comp
 * stats + the 0084 voice; minted off a side rng so they never touch the calibration stream.
 */
export interface Influence {
  persuasiveness: number;
  susceptibility: number;
}

const INFLUENCE_BIAS: Record<string, Influence> = {
  "comp-beast": { persuasiveness: 0.45, susceptibility: 0.4 },
  "mastermind": { persuasiveness: 0.82, susceptibility: 0.25 },
  "social-butterfly": { persuasiveness: 0.74, susceptibility: 0.55 },
  "floater": { persuasiveness: 0.4, susceptibility: 0.62 },
  "villain": { persuasiveness: 0.72, susceptibility: 0.3 },
  "underdog": { persuasiveness: 0.4, susceptibility: 0.66 },
  "flirt": { persuasiveness: 0.7, susceptibility: 0.56 },
  "loyalist": { persuasiveness: 0.5, susceptibility: 0.62 },
  "wildcard": { persuasiveness: 0.55, susceptibility: 0.55 },
  "analyst": { persuasiveness: 0.56, susceptibility: 0.28 },
  "hothead": { persuasiveness: 0.46, susceptibility: 0.56 },
  "peacemaker": { persuasiveness: 0.6, susceptibility: 0.64 },
};
const DEFAULT_BIAS: Influence = { persuasiveness: 0.5, susceptibility: 0.5 };
const INFLUENCE_SPREAD = 0.15;

function jitter(rng: RandomnessSource, center: number, spread = INFLUENCE_SPREAD): number {
  return clamp01(center + (rng.next() * 2 - 1) * spread);
}

/** Mint a houseguest's influence aptitudes — archetype-biased, jittered, byte-stable. Two rng draws. */
export function generateInfluence(rng: RandomnessSource, archetype: string): Influence {
  const b = INFLUENCE_BIAS[archetype] ?? DEFAULT_BIAS;
  return { persuasiveness: jitter(rng, b.persuasiveness), susceptibility: jitter(rng, b.susceptibility) };
}

/**
 * The per-listener TILT a campaign move applies (Phase B feeds this into the seeded decision weights).
 * CHARACTER-mediated, not flat: it scales with the owner's `persuasiveness`, the listener's
 * `susceptibility`, the `trust` between them, and the campaign's accumulated `progress`. Bounded to
 * `[0, base]`. Pure — no rng (the seeded roll happens at the decision site).
 */
export function campaignTilt(
  progress: number,
  persuasiveness: number,
  susceptibility: number,
  trust: number,
  c: CampaignConstants = CAMPAIGN,
): number {
  const trustMult = c.trustFloor + (1 - c.trustFloor) * clamp01(trust);
  return c.base * clamp01(progress) * clamp01(persuasiveness) * clamp01(susceptibility) * trustMult;
}

/**
 * #1937 — SINGLE SWITCH POINT: do PLAYER-owned campaigns count in the campaign push on NPC nominations, the
 * replacement, the veto-save read, and the `protect` netting at the vote? OWNER RULING 2026-11-03: YES at every
 * stage — the player's own lobbying sways the NPCs' nominations, replacement and veto save as well as the vote
 * (still bounded by `CAMPAIGN.base`, and the NPCs still decide; 0098 is about mechanics that shift seeded odds
 * directly, not social influence earned through the player's real moves). The eviction-vote `evict` tilt has always
 * counted the player's campaigns (spec 0085). Flip it here and nowhere else.
 */
export const CAMPAIGN_PUSH_INCLUDES_PLAYER_OWNED = true;

export interface CampaignPushDeps {
  /** The houseguest id of the player (their campaigns are gated by `includePlayerOwned`). */
  player: EntityId;
  influenceOf: (id: EntityId) => Influence;
  /** The owner's trust in / by the decider — read only for owner ≠ decider (never a self-edge). */
  trustOf: (owner: EntityId, decider: EntityId) => number;
  includePlayerOwned?: boolean;
}

/**
 * #1937 — the signed, bounded campaign PUSH on `target` that `decider` (a decision-maker: the HOH naming
 * nominees, the veto holder) is AWARE of: an active `evict` campaign adds, a `protect` campaign subtracts, each
 * the same character-mediated `campaignTilt` the vote uses (persuasiveness × susceptibility × trust × progress).
 * The net is clamped to ±`CAMPAIGN.base` so up to `maxConcurrent` campaigns can never swamp the threat read.
 * Skips campaigns the decider owns (their own plan is already in their own strategic read — counting it again
 * would double-count, and would read a self-edge) and, unless the switch is on, the player's. Pure, no rng.
 * Awareness is the symmetric-perspective rule: only a campaign the decider is in `knownTo` of can move them.
 */
export function campaignPushFor(
  campaigns: readonly Campaign[], target: EntityId, decider: EntityId, deps: CampaignPushDeps,
  c: CampaignConstants = CAMPAIGN,
): number {
  let net = 0;
  for (const camp of campaigns) {
    if (camp.status !== "active" || camp.target !== target) continue;
    const sign = camp.goal === "evict" ? 1 : camp.goal === "protect" ? -1 : 0;
    if (sign === 0 || !camp.knownTo.includes(decider)) continue;
    const owner = camp.owners[0]!;
    // A campaign can be a BLOC's (`owners` is a list): the decider being ANY owner means it is their own plan (already in
    // their read), and the player being ANY owner makes it a player-owned campaign for the switch.
    if (camp.owners.includes(decider)) continue;
    if (camp.owners.includes(deps.player) && !(deps.includePlayerOwned ?? CAMPAIGN_PUSH_INCLUDES_PLAYER_OWNED)) continue;
    net += sign * campaignTilt(
      camp.progress, deps.influenceOf(owner).persuasiveness, deps.influenceOf(decider).susceptibility,
      deps.trustOf(owner, decider), c,
    );
  }
  return Math.max(-c.base, Math.min(c.base, net));
}

/** One houseguest's strategic situation, distilled for campaign formation (the adapter maps real state to this). */
export interface CampaignActor {
  id: EntityId;
  /** Their strongest threat reads (who THEY see as dangerous) — directed, from the relationship model. */
  threats: Array<{ toward: EntityId; threat: number }>;
  /** Their strongest bonds (who THEY want to work with). */
  allies: Array<{ toward: EntityId; affinity: number }>;
  /** Their persuasiveness — the persuasive scheme more, and their campaigns are prioritized under the cap. */
  persuasiveness: number;
}

export interface FormCampaignDeps {
  rng: RandomnessSource;
  /** The current beat (sets `startedBeat` + the horizon deadline). */
  beat: number;
  c?: CampaignConstants;
  /**
   * B5 (vote counting, ORWELL_VOTE_COUNT, default OFF): the actor's own read of whether the eviction count is still IN DOUBT. An EVICT campaign forms only when this says yes
   * (a decided count is not worked); absent => always forms (byte-identical). Alliance-building is never gated by it.
   */
  worthWorking?: (actor: EntityId, target: EntityId) => boolean;
  /** B31 (ORWELL_MOOD_CAMPAIGN): false => this actor is too rattled to hold a campaign steady, so none forms. Absent => byte-identical. */
  steady?: (actor: EntityId) => boolean;
}

export const PLAN_FOR: Record<CampaignGoal, CampaignMove[]> = {
  evict: ["lobby", "plant", "lobby"],
  protect: ["deal", "lobby"],
  "build-alliance": ["deal", "position"],
  "win-power": ["position", "lobby"],
  discredit: ["plant", "lobby"],
};

/**
 * Form the house's campaigns for this beat (PURE). Each actor with a strong-enough threat seeds an
 * "evict" campaign against it; failing that, a strong bond seeds a "build-alliance". The most
 * PERSUASIVE schemers are prioritized and the whole set is capped (`maxConcurrent`) — scarcity keeps
 * the house legible. Every campaign starts known to its OWNER ONLY (symmetric perspective). Deterministic.
 */
export function formCampaigns(actors: readonly CampaignActor[], deps: FormCampaignDeps): Campaign[] {
  const c = deps.c ?? CAMPAIGN;
  // Most persuasive first — and stable on ties (by id) so the cap is deterministic.
  const ordered = [...actors].sort((a, b) => b.persuasiveness - a.persuasiveness || (a.id < b.id ? -1 : 1));
  const out: Campaign[] = [];
  for (const a of ordered) {
    if (out.length >= c.maxConcurrent) break;
    if (deps.steady && !deps.steady(a.id)) continue;
    const topThreat = [...a.threats].sort((x, y) => y.threat - x.threat)[0];
    const topAlly = [...a.allies].sort((x, y) => y.affinity - x.affinity)[0];
    let goal: CampaignGoal | null = null;
    let target: EntityId | null = null;
    let strength = 0;
    if (topThreat && topThreat.threat >= c.threatThreshold) {
      goal = "evict"; target = topThreat.toward; strength = topThreat.threat;
      if (deps.worthWorking && !deps.worthWorking(a.id, target)) { goal = null; target = null; } // B5: the count is decided - don't campaign
    } else if (topAlly && topAlly.affinity >= c.allyThreshold) {
      goal = "build-alliance"; target = topAlly.toward; strength = topAlly.affinity;
    }
    if (!goal || !target) continue;
    const horizon: CampaignHorizon = goal === "build-alliance" ? "season" : "week";
    const span = horizon === "season" ? c.weekBeats * 4 : c.weekBeats;
    out.push({
      id: `campaign:${a.id}:${deps.beat}`,
      owners: [a.id],
      goal, target,
      plan: [...PLAN_FOR[goal]],
      progress: 0,
      horizon,
      status: "active",
      startedBeat: deps.beat,
      deadlineBeat: deps.beat + span,
      confidence: clamp01(strength),
      knownTo: [a.id], // owner only — the symmetric-perspective spine
    });
  }
  return out;
}

const clampUp = (x: number): number => (x > 1 ? 1 : x < 0 ? 0 : x);

export interface AdvanceDeps {
  rng: RandomnessSource;
  beat: number;
  /** The owner's allies (highest-affinity first) — a lobby/plant move spreads the belief to one of them. */
  alliesOf: (owner: EntityId) => readonly EntityId[];
  c?: CampaignConstants;
}

/**
 * Advance a campaign ONE move (PURE) — the per-tick execution. It pops the next move, accrues bounded
 * `progress` (the campaign's push grows the more it's worked — the tilt scales with it), and on a
 * lobby/plant move SPREADS the belief along the social graph: the next ally not yet aware is added to
 * `knownTo` (the symmetric-perspective diffusion — a houseguest learns of a campaign only when a move
 * reaches them). The plan rotates so a week-long campaign keeps working. Resolves at its deadline
 * (`won` if it built real momentum, else `lost`). Draws only the supplied (DEDICATED) rng. Never mutates.
 */
export function advanceCampaign(camp: Campaign, deps: AdvanceDeps): Campaign {
  if (camp.status !== "active") return camp;
  const c = deps.c ?? CAMPAIGN;
  if (deps.beat >= camp.deadlineBeat) {
    return { ...camp, status: camp.progress >= 0.5 ? "won" : "lost" };
  }
  const move = camp.plan[0] ?? "lobby";
  const rotated = [...camp.plan.slice(1), move];
  const jitter = 1 + (deps.rng.next() * 2 - 1) * c.progressJitter;
  const progress = clampUp(camp.progress + c.progressPerMove * jitter);
  // A lobby/plant tells one more ally — the belief diffuses along the social graph (knownTo grows).
  let knownTo = camp.knownTo;
  if (move === "lobby" || move === "plant") {
    const next = deps.alliesOf(camp.owners[0]!).find((a) => !knownTo.includes(a));
    if (next !== undefined) knownTo = [...knownTo, next];
  }
  return { ...camp, plan: rotated, progress, knownTo };
}

/** The live board a campaign re-plans against. */
export interface CampaignBoard {
  /** Who is still in the house. */
  active: ReadonlySet<EntityId>;
  /** Whether the campaign's OWNER is themselves endangered (on the block) — triggers a self-protect pivot. */
  ownerEndangered: boolean;
  /** The owner's CURRENT threat reads (to re-target after the old target escapes). */
  threats?: Array<{ toward: EntityId; threat: number }>;
  /**
   * The target is SAFE this week (won/used the veto, off the block) — an evict campaign against them
   * can't land, so it re-aims even though they're still active. (Evicted ⇒ `!active.has(target)` already.)
   */
  targetSafe?: boolean;
}

/**
 * Adapt a campaign to a changed board (PURE) — a campaign is a plan, not a fixed script, and must never
 * silently vanish (ADR 0005). If the owner is endangered it PIVOTS to self-protect. Else if the target is
 * gone (evicted) OR safe (won the veto), an EVICT campaign RE-TARGETS to the next threat, or is abandoned
 * if none remains. Otherwise it is unchanged. Returns a new object (never mutates).
 */
export function replan(campaign: Campaign, board: CampaignBoard, c: CampaignConstants = CAMPAIGN): Campaign {
  if (campaign.status !== "active") return campaign;
  const owner = campaign.owners[0]!;
  if (board.ownerEndangered && campaign.goal !== "protect") {
    return { ...campaign, goal: "protect", target: owner, plan: [...PLAN_FOR.protect] };
  }
  const targetGone = !board.active.has(campaign.target);
  const targetEscaped = campaign.goal === "evict" && board.targetSafe === true;
  if (targetGone || targetEscaped) {
    const next = (board.threats ?? [])
      .filter((t) => t.toward !== campaign.target && board.active.has(t.toward) && t.threat >= c.threatThreshold)
      .sort((x, y) => y.threat - x.threat)[0];
    if (next) return { ...campaign, target: next.toward, plan: [...PLAN_FOR.evict], progress: 0, confidence: clamp01(next.threat) };
    return { ...campaign, status: "abandoned" };
  }
  return campaign;
}

// --- Phase 2 of "the player can play offense" (0085 follow-on): the PLAYER'S OWN campaign -------------
//
// `campaignActors()`/`formCampaigns()` deliberately never include the player (GameSessionAdapter) — the
// engine must never autonomously hand the player a scheme they didn't choose (mandate: "the player
// forms their own reads, human-driven"). Per the spec's own rule ("the player can run their own
// campaign — as player knowledge, never mind control"), a bare declaration of intent moves nothing;
// only the player's ACTUAL RECORDED MOVES do. `advancePlayerCampaign` is that mechanism: it turns one
// successfully-landed third-party pitch (`recordInteraction`'s `aboutEdges`, Phase 1) into a real,
// bounded, persistent `Campaign` the player owns — mirroring `formCampaigns`/`advanceCampaign` exactly
// (same shape, same constants, same `campaignTilt` consumer at the vote) so the player's offense reads
// on equal footing with an NPC's, never a stronger or weaker channel.

/**
 * Fold ONE player-authored campaign move (PURE). `owner` pitched `holder` (a scene witness) against
 * `target` and the pitch actually LANDED (never a backfired one — I2: a social move that failed moves
 * nothing, campaign progress included; the caller only invokes this for a successful fold). Creates the
 * campaign on the first landed pitch (owners=[owner], knownTo=[owner] until a pitch reaches someone),
 * or continues the existing one when it's still active, aimed at the SAME target, and hasn't lapsed past
 * its deadline — a new target, or a lapsed deadline, starts a fresh campaign at zero progress (the
 * player re-aims by choosing who they lobby against, exactly as they would in play; nothing lingers
 * indefinitely). Adds `holder` — the scene's actual listener — to `knownTo` (the pathway: aware ONLY
 * because they were actually pitched, never omnisciently) regardless of `awardProgress`. Progress
 * accrues (bounded `progressPerMove` ± jitter, exactly like an NPC's `advanceCampaign` tick) ONLY when
 * `awardProgress` is true — the caller throttles this to at most once per beat (the SAME cadence an
 * NPC's own campaign advances at), so listing many holders in one scene earns no speed advantage over
 * the off-screen society. Draws exactly one rng value, and only when `awardProgress` — never mutates.
 */
export function advancePlayerCampaign(
  existing: Campaign | undefined,
  owner: EntityId,
  target: EntityId,
  holder: EntityId,
  beat: number,
  rng: RandomnessSource,
  awardProgress: boolean,
  c: CampaignConstants = CAMPAIGN,
): Campaign {
  const reusable = existing && existing.status === "active" && existing.owners[0] === owner
    && existing.target === target && beat < existing.deadlineBeat;
  const base: Campaign = reusable
    ? existing!
    : {
        id: `campaign:${owner}:${beat}`,
        owners: [owner],
        goal: "evict",
        target,
        plan: [...PLAN_FOR.evict],
        progress: 0,
        horizon: "week",
        status: "active",
        startedBeat: beat,
        deadlineBeat: beat + c.weekBeats,
        confidence: 0.5,
        knownTo: [owner],
      };
  const knownTo = base.knownTo.includes(holder) ? base.knownTo : [...base.knownTo, holder];
  if (!awardProgress) return { ...base, knownTo };
  const jitter = 1 + (rng.next() * 2 - 1) * c.progressJitter;
  const progress = clampUp(base.progress + c.progressPerMove * jitter);
  return { ...base, progress, knownTo };
}

// --- 0086: HOUSEGUEST DRIVES (everyone always plays; intensity varies) -------------------------------
//
// A Drive is the substrate the Campaign is the top gear of. Every active houseguest always carries one;
// `formCampaigns` (above) promotes the loudest into campaigns, while the quiet ones add only a small
// OWN-BALLOT lean (ruling #5). Pure + perspective-bound + STICKY (ruling #6). Vault-only.

export type DriveMotivation = "self-preserve" | "target" | "build" | "lay-low" | "win-power";

export interface Drive {
  owner: EntityId;
  motivation: DriveMotivation;
  /** The subject — present for `target` (who to evict) / `build` (with whom). */
  target?: EntityId;
  /** How hard they pursue it THIS week (0..1) — VAULT-ONLY, never shown. */
  intensity: number;
}

export interface DriveConstants {
  /** The small own-ballot vote term a low TARGET drive adds = lowLeanWeight × intensity (≪ campaign base). */
  lowLeanWeight: number;
  /** A sticky target is HELD while its threat read stays at/above (threatThreshold − hysteresis). */
  hysteresis: number;
  /** How much archetype aggression adds to intensity. */
  aggressionWeight: number;
  /** How much a rattled soul (low emotionalState) adds to intensity. */
  emotionalWeight: number;
  /** The self-preserve intensity FLOOR when on the block. */
  nominatedIntensity: number;
  /** The lay-low simmer intensity — the quiet baseline everyone carries. */
  layLowIntensity: number;
  /** B51 (ORWELL_DRIVE_DECISIONS): the HOH/veto-holder score weight of their OWN drive toward a candidate (target adds, build protects) = decisionWeight x intensity. */
  decisionWeight: number;
  /** B51: the weight of the decider's OWN active campaign on a candidate (x (0.5 + progress/2)); replaces the bare drive for that candidate. */
  ownCampaignWeight: number;
}

export const DRIVE: DriveConstants = {
  ownCampaignWeight: 0.2, // a committed plan weighs more than a held motive, still under CAMPAIGN.base (0.25)
  decisionWeight: 0.15, // bounded under CAMPAIGN.base (0.25): a held personal motive, not a campaign
  lowLeanWeight: 0.08, // bounded well under CAMPAIGN.base (0.25) — a quiet grudge, not a campaign
  hysteresis: 0.12,
  aggressionWeight: 0.25,
  emotionalWeight: 0.2,
  nominatedIntensity: 0.85,
  layLowIntensity: 0.3,
};

/** Archetype aggression (0..1) — how hard this archetype pursues at a given board state (ruling: villain ≫ floater). */
export const ARCHETYPE_AGGRESSION: Record<string, number> = {
  "comp-beast": 0.65, "mastermind": 0.8, "social-butterfly": 0.5, "floater": 0.25,
  "villain": 0.85, "underdog": 0.45, "flirt": 0.5, "loyalist": 0.45,
  "wildcard": 0.7, "analyst": 0.6, "hothead": 0.8, "peacemaker": 0.3,
};

export interface DriveContext {
  /** The owner is on the block this week ⇒ self-preserve dominates (a real board change). */
  nominated: boolean;
  /** Archetype aggression 0..1 (from `ARCHETYPE_AGGRESSION`). */
  aggression: number;
  /** The owner's soul emotionalState (0..1, 0.5 = calm) — a rattled soul pushes harder. */
  emotional: number;
}

function driveIntensity(anchor: number, ctx: DriveContext, c: DriveConstants): number {
  const rattled = ctx.emotional < 0.5 ? (0.5 - ctx.emotional) * 2 : 0;
  return clamp01(anchor * 0.6 + ctx.aggression * c.aggressionWeight + rattled * c.emotionalWeight);
}

/**
 * Derive a houseguest's DRIVE for this tick (PURE, perspective-bound, STICKY). Reads ONLY the owner's
 * own threat/ally reads + their board danger — never an omniscient ledger. Sticky (ruling #6): a
 * `target` commitment is HELD across ticks while the target stays a live threat (hysteresis), re-aiming
 * only on a real board change (nominated ⇒ self-preserve; the target drops below the read). Everyone
 * always gets a drive — `lay-low` is the quiet floor. Intensity is bounded; the caller supplies the
 * seeded board reads, so two same-board ticks derive the same drive.
 */
export function deriveDrive(actor: CampaignActor, ctx: DriveContext, prior: Drive | undefined, c: DriveConstants = DRIVE): Drive {
  const make = (motivation: DriveMotivation, target: EntityId | undefined, anchor: number): Drive => {
    let intensity = driveIntensity(anchor, ctx, c);
    if (ctx.nominated && motivation === "self-preserve") intensity = Math.max(intensity, c.nominatedIntensity);
    return { owner: actor.id, motivation, ...(target !== undefined ? { target } : {}), intensity };
  };
  const topThreat = [...actor.threats].sort((a, b) => b.threat - a.threat)[0];
  const topAlly = [...actor.allies].sort((a, b) => b.affinity - a.affinity)[0];
  // A real board change: on the block ⇒ self-preserve.
  if (ctx.nominated) return make("self-preserve", topThreat?.toward, topThreat?.threat ?? 0.6);
  // Sticky: keep a prior target while they remain a live threat (don't re-roll the agenda each tick).
  if (prior && prior.motivation === "target" && prior.target !== undefined) {
    const still = actor.threats.find((t) => t.toward === prior.target);
    if (still && still.threat >= CAMPAIGN.threatThreshold - c.hysteresis) return make("target", prior.target, still.threat);
  }
  if (topThreat && topThreat.threat >= CAMPAIGN.threatThreshold) return make("target", topThreat.toward, topThreat.threat);
  if (topAlly && topAlly.affinity >= CAMPAIGN.allyThreshold) return make("build", topAlly.toward, topAlly.affinity);
  return make("lay-low", undefined, c.layLowIntensity);
}

/**
 * The small OWN-BALLOT lean a low (non-promoted) TARGET drive applies to its OWNER's OWN vote against
 * their target (ruling #5: a quiet grudge moves one vote, never the electorate). Only `target` drives
 * lean — `self-preserve`/`lay-low`/`build`/`win-power` add nothing (ruling #7). Bounded ≪ a campaign tilt.
 */
export function ownBallotLean(drive: Drive, nominee: EntityId, c: DriveConstants = DRIVE): number {
  if (drive.motivation !== "target" || drive.target !== nominee) return 0;
  return c.lowLeanWeight * clamp01(drive.intensity);
}

// --- 0096: EMERGENT NEMESIS (a personal villain to outlast) ----------------------------------------
//
// NOT a new targeting system — the SUSTAINED elevation of an existing high-threat `target` drive (0086,
// above) into a coherent, felt through-line. Reads ONLY the threat-toward-player edge (0002/0026) + the
// sticky `target` drive; mints no new hidden attribute per NPC. Pure + engine-only (Vault-sealed, the
// same wall as the rest of this module — dependency-cruiser proves no outward import). Selection draws
// NO rng of its own — it is a deterministic read of already-seeded threat/drive signals, so it can never
// perturb the campaign rng's draw sequence.

export interface NemesisConstants {
  /** The threat-toward-player floor a candidate must clear — stricter than a plain campaign target, so a
   *  nemesis is rarer than an ordinary evict campaign. */
  threatThreshold: number;
  /** Consecutive ticks a candidate must clear the bar (targeting the player + at/above the threshold)
   *  before they qualify — a one-week spike is not a nemesis; a held, re-committed grudge is. */
  sustainTicks: number;
  /** Margin below `threatThreshold` a HELD nemesis may drift to before lapsing (stickiness, sibling of
   *  `DRIVE.hysteresis`) — keeps the arc from flip-flopping on a single soft tick. */
  hysteresis: number;
  /** How much a challenger's threat-toward-player must clear the incumbent's before taking over the arc
   *  (hand-off hysteresis — a hand-off is a genuine overtake, never a coin flip). */
  handoffMargin: number;
  /** The escalation intensity floor the nemesis's `target` drive is held at — WITHIN the existing [0,1]
   *  intensity band (never past it): the upper of the band, not a new ceiling. */
  escalationIntensity: number;
}

export const NEMESIS: NemesisConstants = {
  threatThreshold: CAMPAIGN.threatThreshold + 0.1,
  sustainTicks: 3,
  hysteresis: 0.12,
  handoffMargin: 0.1,
  escalationIntensity: 0.95,
};

/** One candidate's read for nemesis selection THIS tick — perspective-bound, already-derived signals only. */
export interface NemesisCandidate {
  id: EntityId;
  /** This candidate's OWN threat-toward-player edge (their read of the player, not the player's of them). */
  threatTowardPlayer: number;
  /** Whether their JUST-DERIVED (0086) drive is `target`, aimed at the player, this tick. */
  targetsPlayer: boolean;
}

/** The persisted nemesis bookkeeping: who (if anyone) holds the arc + each candidate's consecutive-tick streak. */
export interface NemesisTrack {
  current: EntityId | undefined;
  streak: Record<EntityId, number>;
}

/** The empty track — no nemesis, no history (a fresh/legacy/disabled session). */
export const NO_NEMESIS: NemesisTrack = { current: undefined, streak: {} };

/**
 * Select (or hold, or hand off) the player's nemesis for this tick — PURE, no rng (a deterministic read
 * of the already-seeded threat + drive signals, so two identical boards derive the same nemesis). At
 * MOST one. A candidate qualifies only after `sustainTicks` CONSECUTIVE ticks clearing `threatThreshold`
 * while their drive targets the player; a held incumbent stays (hysteresis) until their own read
 * genuinely drops below `threatThreshold - hysteresis` or their drive re-aims off the player, or a clear
 * successor overtakes them by `handoffMargin`. No qualifying candidate ⇒ no nemesis — a legitimate,
 * common (not a defect) outcome; a whole season can pass with none.
 */
export function selectNemesis(
  candidates: readonly NemesisCandidate[],
  prior: NemesisTrack,
  c: NemesisConstants = NEMESIS,
): NemesisTrack {
  const streak: Record<EntityId, number> = {};
  for (const cand of candidates) {
    const clearing = cand.targetsPlayer && cand.threatTowardPlayer >= c.threatThreshold;
    streak[cand.id] = clearing ? (prior.streak[cand.id] ?? 0) + 1 : 0;
  }

  const incumbent = prior.current;
  const incumbentCand = incumbent !== undefined ? candidates.find((cand) => cand.id === incumbent) : undefined;
  const incumbentHolds = incumbentCand !== undefined
    && incumbentCand.targetsPlayer
    && incumbentCand.threatTowardPlayer >= c.threatThreshold - c.hysteresis;

  const qualified = candidates.filter((cand) => streak[cand.id]! >= c.sustainTicks);

  if (incumbentHolds && incumbent !== undefined) {
    const challenger = qualified
      .filter((cand) => cand.id !== incumbent)
      .sort((a, b) => b.threatTowardPlayer - a.threatTowardPlayer)[0];
    const current = challenger !== undefined
      && challenger.threatTowardPlayer >= incumbentCand!.threatTowardPlayer + c.handoffMargin
      ? challenger.id
      : incumbent;
    return { current, streak };
  }

  const top = [...qualified].sort((a, b) => b.threatTowardPlayer - a.threatTowardPlayer)[0];
  return { current: top?.id, streak };
}

/**
 * B51: the signed nomination/veto-save push of the decider's OWN plan toward `candidate` (positive = toward evicting, the same sign as `campaignPushFor`). `campaignPushFor` skips campaigns the
 * decider owns (assuming they are in the decider's own read - they are not: `NominationRead` carries no drive or campaign), so this is where the HOH's / veto holder's own plan enters. An own
 * ACTIVE campaign on the candidate wins (evict adds; protect / build-alliance protect), scaled by progress; otherwise a held `target` drive adds and a `build` drive protects. Never both.
 */
export function drivePushFor(
  drive: Drive | undefined, candidate: EntityId, ownCampaign?: { goal: CampaignGoal; progress: number }, c: DriveConstants = DRIVE,
): number {
  const sign = ownCampaign?.goal === "evict" ? 1 : ownCampaign?.goal === "protect" || ownCampaign?.goal === "build-alliance" ? -1 : 0; // win-power / discredit point at no one's seat
  if (ownCampaign && sign) return sign * c.ownCampaignWeight * (0.5 + 0.5 * clamp01(ownCampaign.progress));
  if (!drive || drive.target !== candidate) return 0;
  const w = c.decisionWeight * clamp01(drive.intensity);
  return drive.motivation === "target" ? w : drive.motivation === "build" ? -w : 0;
}
