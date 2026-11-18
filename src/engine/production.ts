import type { EntityId } from "../domain/ids";

/**
 * THEME C (ORW-666; Ryne approved all three, 2026-11-18: "I think those are all great ideas!") - PRODUCTION AS A CHARACTER. FOUNDATION ONLY: the pure rules
 * the three slices build on. Pure, no I/O, no rng, no Vault handle. Spec 0210; the build goes to A or B.
 *
 *  - C1 the host on eviction night (builds on 0130 exit interviews): the host may ask only about PUBLIC events and the evictee's OWN choices (`hostMayAsk`);
 *    never a hidden fact before the crown. The sharpest questions first (`hostQuestions`).
 *  - C2 called to the Diary Room: the CALL is observable (who, how long, the mood they come back in, as a coarse engine key), the CONTENT is not
 *    (`diaryCallSeen`). Both ways: the player's own calls are seen by the house the same way.
 *  - C3 a producer who pushes back in the player's own Diary Room: only on the player's OWN said-vs-did record (`pushbacks`): a promise the player
 *    made and then acted against. Never anything the player did not do or say, never an NPC's secret.
 */
export const PRODUCTION = {
  /** C1: at most this many host questions per exit interview. */
  maxHostQuestions: 3,
  /** C2: a stay this long or longer reads as "a long time" to those who noticed. */
  longCallMinutes: 20,
  /** C2: a mood change of at least this much (either way) reads on their face coming out. */
  moodShows: 0.12,
  /** C3: at most this many pushbacks in one session (the producer picks the sharpest). */
  maxPushbacks: 2,
} as const;

/** A candidate fact for the host's questions: what happened, who did it, whether it was public, whether it is hidden. Drama ranks it. */
export interface HostFact { id: string; actor: EntityId; public: boolean; hidden: boolean; drama: number; week: number }

/** C1: may the host ask the evictee about this? Never a hidden fact; otherwise a public event or the evictee's own act. */
export const hostMayAsk = (f: HostFact, evictee: EntityId): boolean => !f.hidden && (f.public || f.actor === evictee);

/** C1: the host's questions: allowed facts, the evictee's own choices first, then by drama, then the most recent; capped. */
export function hostQuestions(facts: readonly HostFact[], evictee: EntityId): HostFact[] {
  return facts.filter((f) => hostMayAsk(f, evictee))
    .sort((a, b) => Number(b.actor === evictee) - Number(a.actor === evictee) || b.drama - a.drama || b.week - a.week || a.id.localeCompare(b.id))
    .slice(0, PRODUCTION.maxHostQuestions);
}

/** C2: how someone comes back from the Diary Room, as others can see it (an engine key the narrator voices). */
export type ComesBack = "lighter" | "same" | "heavier";
export function comesBack(moodBefore: number, moodAfter: number): ComesBack {
  const d = moodAfter - moodBefore;
  return d >= PRODUCTION.moodShows ? "lighter" : d <= -PRODUCTION.moodShows ? "heavier" : "same";
}

/** C2: what an onlooker registers about a Diary Room call. No content field exists, by construction. */
export interface DiaryCallSeen { who: EntityId; day: number; long: boolean; comesBack: ComesBack }
export function diaryCallSeen(who: EntityId, day: number, minutes: number, moodBefore: number, moodAfter: number): DiaryCallSeen {
  return { who, day, long: minutes >= PRODUCTION.longCallMinutes, comesBack: comesBack(moodBefore, moodAfter) };
}

/** C3: something the player said (a promise or assurance; claim id from the claims log) and something the player did (a recorded act). */
export interface PlayerSaid { claimId: string; to: EntityId; promise: "safe" | "vote-with" | "not-target" | "deal"; week: number }
export interface PlayerDid { eventId: string; act: "nominated" | "voted-against" | "named-replacement" | "broke-deal"; target: EntityId; week: number }

/** Which acts go against which promise (an act against the person the promise was made to, in or after the week it was made). */
const BREAKS: Readonly<Record<PlayerSaid["promise"], ReadonlySet<PlayerDid["act"]>>> = {
  safe: new Set(["nominated", "voted-against", "named-replacement"]),
  "vote-with": new Set(["voted-against"]),
  "not-target": new Set(["nominated", "named-replacement"]),
  deal: new Set(["broke-deal", "nominated", "voted-against"]),
};

/** C3: the producer's pushbacks: the player's own promises followed by an act against the same person. Newest first, capped. */
export function pushbacks(said: readonly PlayerSaid[], did: readonly PlayerDid[]): Array<{ said: PlayerSaid; did: PlayerDid }> {
  const out: Array<{ said: PlayerSaid; did: PlayerDid }> = [];
  for (const s of said) {
    const d = did.filter((x) => x.target === s.to && x.week >= s.week && BREAKS[s.promise].has(x.act)).sort((a, b) => a.week - b.week || a.eventId.localeCompare(b.eventId))[0];
    if (d) out.push({ said: s, did: d });
  }
  return out.sort((a, b) => b.did.week - a.did.week || a.said.claimId.localeCompare(b.said.claimId)).slice(0, PRODUCTION.maxPushbacks);
}
