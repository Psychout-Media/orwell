import { plantedBy } from "../../src/engine/beliefStore";
import { PLAYER } from "../../src/domain/ids";
import type { Stop } from "./playedSeason";

/**
 * ORW-810: reading the vote talk of a PLAYED season (ORW-594 / ORW-613). After each eviction the voters may tell someone how they voted ("I voted to keep them"); the engine plants a
 * belief in the listener, may credit the speaker for keeping someone the listener liked, and checks every such claim against the PUBLIC count (who left, how many votes read evict,
 * who voted). This module only READS the live session after each message: a `Talk` is one eviction's vote talk as it landed, with the edges as they stood one message before.
 * Roles only.
 */
export interface Claim { id: string; kind: string; speaker: string; listener: string; subject: string; object?: string; week: number; isTrue?: boolean }
export interface Belief { id: string; kind: string; subject: string; refuted?: boolean; impact?: { trust?: number; affinity?: number }; alsoClaims?: string[] }
export interface Talk {
  msg: number;
  /** The keep claims told at this vote talk (all listeners). */
  told: Claim[];
  /** The public count of the eviction they are about. */
  tally: { evictee: string; evictVotes: number; voters: string[]; keepVotes: number };
  /** listener -> speaker trust one message BEFORE the talk (the credit and any catch land in the talk's own message). */
  trustBefore: (listener: string, speaker: string) => number;
}

export const beliefOf = (s: Stop, holder: string, claimId: string): Belief | undefined =>
  ((s.sess.live?.beliefs?.[holder] ?? []) as Belief[]).find((b) => plantedBy(b, claimId));

/** Returns a per-message watcher: call it from `playUntil`'s stop; it hands each new vote talk to `onTalk` (which returns true to stop the season). */
export function watchVoteTalk(onTalk: (s: Stop, talk: Talk) => boolean): (s: Stop) => boolean {
  const seen = new Set<string>();
  let trust = new Map<string, number>();
  return (s) => {
    const live = s.sess.live;
    if (!live) return false;
    const items = (live.claims?.items ?? []) as Claim[];
    const fresh = items.filter((c) => !seen.has(c.id) && c.kind === "voted-to-keep");
    const rec = live.voteRecord?.[live.voteRecord.length - 1] as { evictee: string; voteOf: Record<string, string> } | undefined;
    let stop = false;
    // A vote talk is the batch the eviction's voters tell at once (two or more keep claims, or one told to the player); a single keep claim told later in the week is house talk.
    if (rec && (fresh.length >= 2 || fresh.some((c) => c.listener === PLAYER))) {
      const voters = Object.keys(rec.voteOf);
      const evictVotes = Object.values(rec.voteOf).filter((t) => t === rec.evictee).length;
      const before = trust;
      stop = onTalk(s, { msg: s.msg, told: fresh, tally: { evictee: rec.evictee, evictVotes, voters, keepVotes: voters.length - evictVotes }, trustBefore: (l, sp) => before.get(`${l}|${sp}`) ?? NaN });
    }
    for (const c of items) seen.add(c.id);
    trust = new Map();
    const ids: string[] = s.sess.livingIds();
    for (const a of ids) for (const b of ids) if (a !== b) trust.set(`${a}|${b}`, s.sess.rel.edge(a, b).trust);
    return stop;
  };
}

/** The listeners whose believed keep claims outnumber the count's keep votes (CATCH BY COUNTING): each with the distinct claimants and the ones now caught (their planted belief refuted). */
export function overclaims(s: Stop, talk: Talk): Array<{ listener: string; claimants: string[]; caught: string[]; excess: number }> {
  const items = (s.sess.live?.claims?.items ?? []) as Claim[];
  const week = talk.told[0]!.week;
  const byListener = new Map<string, Claim[]>();
  for (const c of items) {
    if (c.kind !== "voted-to-keep" || c.week !== week || c.object !== talk.tally.evictee || c.listener === PLAYER || !talk.tally.voters.includes(c.subject)) continue;
    if (!beliefOf(s, c.listener, c.id)) continue; // never believed: the count does not weigh it
    (byListener.get(c.listener) ?? byListener.set(c.listener, []).get(c.listener)!).push(c);
  }
  const out: Array<{ listener: string; claimants: string[]; caught: string[]; excess: number }> = [];
  for (const [listener, cs] of byListener) {
    const claimants = [...new Set(cs.map((c) => c.subject))];
    const excess = claimants.length - talk.tally.keepVotes;
    if (excess <= 0) continue;
    const caught = [...new Set(cs.filter((c) => beliefOf(s, listener, c.id)?.refuted).map((c) => c.subject))];
    out.push({ listener, claimants, caught, excess });
  }
  return out;
}
