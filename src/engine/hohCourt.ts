import type { EntityId } from "../domain/ids";
import { clamp01 } from "../domain/num";

/**
 * Feature 0173 (Theme 3 slice 11) - status, informal leaders, the HOH court, power vacuums. PURE and ENGINE-ONLY (Vault class): a hidden pecking order derived from wins, allies and respect; it is NEVER
 * shown as a rank, a number, a roster or a leader marker, and no surface carries it. The player reads it only from who spends time with whom. Total and deterministic: no rng, no I/O, ids sorted.
 *
 * `HOH_COURT` holds every tunable (the B59 rule: no inline number at a call site). Pull weights are deliberately small: the A10 want-driven movement flag once failed the jury reach at a weight
 * past about 1.5, so the court only RAISES a chance a little and never replaces a goal step.
 */
export const HOH_COURT = {
  /** The share of the pecking-order score each term carries (they sum to 1 with the hub bonus below). */
  winWeight: 0.34,
  allyWeight: 0.3,
  respectWeight: 0.26,
  hubBonus: 0.1,
  /** Score cut-offs for the coarse tiers 1..4 (tier 0 is below the first). */
  tierCuts: [0.18, 0.36, 0.54, 0.72] as readonly number[],
  /** The lowest score an informal leader holds; the most lieutenants one keeps; the mutual tie that makes a houseguest a follower; the fewest followers that make a leader. */
  leaderMinScore: 0.5,
  lieutenantMax: 3,
  followerMinTie: 0.3,
  leaderMinFollowers: 2,
  /** A sitting leader is held until a challenger leads them by this much (the house does not flip on a tiny gap). */
  challengeMargin: 0.06,
  /** The chance a power vacuum splits the leader's group, when two or more lieutenants survive. */
  splitChance: 0.5,
  /** Per-hour chance (added after goal steps, before ordinary life) that a houseguest seeks the HOH out; the ones in danger far more. */
  courtBase: 0.07,
  courtDanger: 0.3,
  /** The HOH's own threat read of a houseguest that puts them in danger (besides being on the block). */
  dangerThreat: 0.55,
  /** ORW-577: the least a get-them-out goal's commitment must be before the goal itself seeds a campaign / a drive, and a win-power goal before it keeps a houseguest competing. */
  goalMin: 0.5,
  /** The history ring: the most entries kept (the record only grows until this, then the oldest roll off; the count is kept). */
  historyMax: 200,
  /**
   * ORW-694 / B1-9 (Ryne 2026-11-26: "standing in the house should matter ... it would also create like a bigger target as a leader ... We can play with that a bit."). FIRST-PASS weights, to be
   * tuned: a leader's / lieutenant's pitch to the HOH carries this much more (a multiplier inside the bounded `LOBBY.maxTilt`), and the house's informal leader carries this much extra
   * nomination pull (threat is 0..1). Read only in played games with the court on (the status exists nowhere else).
   */
  standing: { pitchWeight: { leader: 1.25, lieutenant: 1.1 }, leaderTargetPush: 0.08 },
} as const;

export type StatusEventKind = "rose" | "challenged" | "vacuum" | "split";
export interface StatusEvent { day: number; kind: StatusEventKind; who: EntityId; over?: EntityId; lieutenants?: EntityId[] }

/** What is saved (engine-only, Vault class). Coarse tiers, never a score. `count` only grows (non-degradation), even when the ring rolls its oldest entries off. */
export interface StatusRecord {
  day: number;
  tiers: Record<EntityId, number>;
  leader?: EntityId;
  lieutenants: EntityId[];
  vacuumSince?: number;
  count: number;
  history: StatusEvent[];
}

export interface StatusInput {
  members: readonly EntityId[];
  /** HOH reigns + veto wins (the game resume). */
  wins: (id: EntityId) => number;
  /** Undirected 0..1 mutual tie (the bond reader's own). */
  tie: (a: EntityId, b: EntityId) => number;
  /** The mean regard others hold for this houseguest, 0..1 (read from the bond reader). */
  respect: (id: EntityId) => number;
  hubs: ReadonlySet<EntityId>;
  prevLeader?: EntityId;
}
export interface StatusRead { score: ReadonlyMap<EntityId, number>; tiers: Record<EntityId, number>; leader?: EntityId; lieutenants: EntityId[] }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function tierOf(score: number): number {
  let t = 0;
  for (const cut of HOH_COURT.tierCuts) if (score >= cut) t++;
  return t;
}

export function deriveStatus(inp: StatusInput): StatusRead {
  const members = [...new Set(inp.members)].sort(cmp);
  const C = HOH_COURT;
  const maxWins = Math.max(1, ...members.map((m) => inp.wins(m)));
  const score = new Map<EntityId, number>();
  for (const m of members) {
    const ties = members.filter((o) => o !== m).map((o) => clamp01(inp.tie(m, o))).sort((a, b) => b - a);
    const allies = ties.length ? (ties[0]! + (ties[1] ?? ties[0]!)) / 2 : 0;
    score.set(m, clamp01(C.winWeight * clamp01(inp.wins(m) / maxWins) + C.allyWeight * allies + C.respectWeight * clamp01(inp.respect(m)) + (inp.hubs.has(m) ? C.hubBonus : 0)));
  }
  const tiers: Record<EntityId, number> = {};
  for (const m of members) tiers[m] = tierOf(score.get(m)!);
  const ranked = [...members].sort((a, b) => score.get(b)! - score.get(a)! || cmp(a, b));
  const followersOf = (l: EntityId): EntityId[] => members
    .filter((o) => o !== l && score.get(o)! < score.get(l)! && inp.tie(l, o) >= C.followerMinTie)
    .sort((a, b) => inp.tie(l, b) - inp.tie(l, a) || cmp(a, b));
  const qualifies = (l: EntityId): boolean => score.get(l)! >= C.leaderMinScore && followersOf(l).length >= C.leaderMinFollowers;
  let leader: EntityId | undefined;
  const top = ranked[0];
  if (inp.prevLeader && members.includes(inp.prevLeader) && qualifies(inp.prevLeader) && (!top || score.get(top)! - score.get(inp.prevLeader)! <= C.challengeMargin)) leader = inp.prevLeader;
  else if (top && qualifies(top)) leader = top;
  else leader = ranked.find(qualifies);
  return { score, tiers, ...(leader ? { leader } : {}), lieutenants: leader ? followersOf(leader).slice(0, C.lieutenantMax) : [] };
}

export const emptyStatus = (): StatusRecord => ({ day: 0, tiers: {}, lieutenants: [], count: 0, history: [] });

export interface StatusStep { record: StatusRecord; /** The lieutenants who contest a vacuum this step (empty otherwise). */ claimants: EntityId[]; vacuumOpened: boolean }

/**
 * Fold today's read into the record (PURE; monotonic: the history only grows, `count` never falls). A leader who has left the house opens a vacuum, naming the lieutenants that survive; when a leader qualifies
 * again the vacuum closes; a different leader without an exit is a challenge.
 */
export function advanceStatus(prev: StatusRecord | undefined, read: StatusRead, day: number, living: ReadonlySet<EntityId>): StatusStep {
  const p = prev ?? emptyStatus();
  const hist: StatusEvent[] = [];
  let vacuumSince = p.vacuumSince;
  let claimants: EntityId[] = [];
  let vacuumOpened = false;
  if (p.leader && !living.has(p.leader)) {
    claimants = p.lieutenants.filter((l) => living.has(l));
    hist.push({ day, kind: "vacuum", who: p.leader, lieutenants: claimants });
    vacuumSince = day; vacuumOpened = true;
  }
  const had = p.leader && living.has(p.leader) ? p.leader : undefined;
  if (read.leader && read.leader !== had) {
    hist.push(had ? { day, kind: "challenged", who: read.leader, over: had } : { day, kind: "rose", who: read.leader });
    if (!had && vacuumSince !== undefined && !vacuumOpened) vacuumSince = undefined;
  }
  const history = [...p.history, ...hist].slice(-HOH_COURT.historyMax);
  const record: StatusRecord = {
    day, tiers: read.tiers, lieutenants: read.lieutenants, count: p.count + hist.length, history,
    ...(read.leader ? { leader: read.leader } : {}),
    ...(vacuumSince !== undefined && !read.leader ? { vacuumSince } : {}),
  };
  return { record, claimants, vacuumOpened };
}

/** A power vacuum's hidden fall-out: with two or more surviving lieutenants, a seeded roll may split the group, and the lieutenant who held less leaves. `roll` is a keyed draw in [0,1). */
export function vacuumSplit(claimants: readonly EntityId[], score: ReadonlyMap<EntityId, number>, roll: number): EntityId | undefined {
  if (claimants.length < 2 || roll >= HOH_COURT.splitChance) return undefined;
  const ranked = [...claimants].sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0) || cmp(a, b));
  return ranked[0];
}

/** The per-hour chance that `owner` seeks the HOH out: the ones in danger far more. Zero for the HOH themself. */
export function courtPull(inDanger: boolean): number { return inDanger ? HOH_COURT.courtDanger : HOH_COURT.courtBase; }

/**
 * ORW-577 (Fable T1-9/10): the third-person goal actions finally move someone. When a houseguest campaigns against, wedges, lobbies for or counts votes about a named third person with a listener, the LISTENER's
 * read of that third person takes a bounded step (engine keys, never shown). The step is scaled by how persuasive the speaker is against how easily swayed the listener is, within `swayMin..swayMax`.
 */
export const THIRD_PERSON: Readonly<Record<string, { affinity: number; threat: number }>> = {
  "campaign-against": { affinity: -0.03, threat: 0.0175 }, // the threat part is halved: a campaign already reaches its listeners through `campaignTiltFor` (the Auditor's review of #2972), so the read moves only half as much here
  "drive-a-wedge": { affinity: -0.03, threat: 0.02 },
  "lobby-for": { affinity: 0.03, threat: -0.02 },
  "count-votes": { affinity: -0.01, threat: 0.02 },
};
export const THIRD_PERSON_SWAY = { min: 0.5, max: 1.5 } as const;
export function thirdPersonImpact(kind: string, persuasiveness: number, susceptibility: number): { affinity: number; threat: number } | undefined {
  const base = THIRD_PERSON[kind];
  if (!base) return undefined;
  const sway = Math.max(THIRD_PERSON_SWAY.min, Math.min(THIRD_PERSON_SWAY.max, 0.5 + clamp01(persuasiveness) * 0.5 + clamp01(susceptibility) * 0.5));
  return { affinity: base.affinity * sway, threat: base.threat * sway };
}

/**
 * ORW-610 (owner ruling 2026-11-17): the engine never acts for the player. The player's OWN recorded talk to the sitting HOH this week (pleading for safety, campaigning, naming someone) counts as a pitch
 * on the same terms as an NPC's. Until ORW-609 lands a recorded scene kind and actor, a talk counts when the scene's kind is one of the persuasion-like engine keys (or it named a third person). A fight (conflict) with the HOH is NOT a plea for safety.
 * ORW-609 replaces `isPitchLikeTalk` with its recorded scene kind. Pure.
 */
export const PLAYER_PITCH = { talkKinds: ["strategy", "alliance"] as readonly string[], perTalk: 0.5 } as const;
export interface PlayerPitchRecord { week: number; hoh: EntityId; talks: number; named?: EntityId }
export const isPitchLikeTalk = (kind: string | undefined, named: EntityId | undefined): boolean => named !== undefined || (kind !== undefined && PLAYER_PITCH.talkKinds.includes(kind));
export function foldPlayerTalk(prev: PlayerPitchRecord | undefined, week: number, hoh: EntityId, named: EntityId | undefined): PlayerPitchRecord {
  const same = prev && prev.week === week && prev.hoh === hoh;
  return { week, hoh, talks: (same ? prev.talks : 0) + 1, ...(named !== undefined ? { named } : same && prev.named !== undefined ? { named: prev.named } : {}) };
}
/** The pitch the player's own talk makes to `holder` this week, or none. A named third person makes it an information pitch against them; otherwise a plea for safety. */
export function playerPitchFrom(rec: PlayerPitchRecord | undefined, week: number, holder: EntityId): { kind: "safety" | "info"; strength: number; targets?: EntityId } | undefined {
  if (!rec || rec.week !== week || rec.hoh !== holder) return undefined;
  const strength = clamp01(rec.talks * PLAYER_PITCH.perTalk);
  return rec.named !== undefined ? { kind: "info", strength, targets: rec.named } : { kind: "safety", strength };
}
