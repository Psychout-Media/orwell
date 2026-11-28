import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { COMING_CLEAN } from "../../src/engine/comingClean";
import { caughtLieTrustDrop, CAUGHT_LIE } from "../../src/engine/caughtLies";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { type Stop, firstStop, wfScan, withinEarshot } from "./playedSeason";

/**
 * 0203 coming clean, the PLAYER's side (ORW-808), in a PLAYED season. Seed 3, the scripted talking player, stopped at the first quiet moment after the premiere with two houseguests
 * in the room. Everything the player does goes through the scene tool, as the narrator records it: the player tells a houseguest a claim the engine judges FALSE from its own
 * records ("one houseguest has a final two with another" where no such deal exists: `recordInteraction` with `statement`), then
 *  - owns it (`statement: { to, retracts: true }`): the listener's trust drops by the confession cost, smaller than a caught lie, the belief is taken back, no lied-to-me; or
 *  - tells an ally the truth about it (`statement: { to: ally, tellsAbout: listener }`): the ally now holds "the player lied to the listener", and the listener still believes it.
 * The confession's cost is measured against the same season played identically with the same scene minus the confession (the scene's own fold cancels out). Roles only.
 */
const roster = (s: Stop): string[] => { const occ = (s.sess.sendTimeOccupancy() ?? s.sess.presence) as Map<string, string>; const here = occ.get(PLAYER); const hear = withinEarshot(s); return [...occ].filter(([id, r]) => r === here && id !== PLAYER && hear.has(id)).map(([id]) => id); };
const quiet = (s: Stop): boolean => { const g = s.sess.getGameState(); return g.phase !== "premiere" && !g.pending && !s.sess.live?.ceremony && roster(s).length >= 2; };
type Claim = { id: string; speaker: string; listener: string; isTrue: boolean };
const beliefs = (s: Stop, h: string): BeliefClaim[] => (s.sess.live.beliefs?.[h] ?? []) as BeliefClaim[];
const planted = (s: Stop, h: string, claimId: string) => beliefs(s, h).find((b) => b.id.endsWith(`|${claimId}`) || (b as { alsoClaims?: string[] }).alsoClaims?.includes(claimId));

/** Play to the moment, then the player tells the first houseguest in the room a false claim about two others. Returns the listener, an ally (also in the room) and the claim to the listener. */
async function lieTold(): Promise<{ at: Stop; a: string; ally: string; lie: Claim }> {
  const at = await firstStop(quiet, wfScan(3));
  const [a, ally] = roster(at);
  const pair = (at.sess.livingIds() as string[]).filter((x) => x !== PLAYER && x !== a && x !== ally);
  const finalTwo = (x: string, y: string) => (at.sess.deals.all as Array<{ kind: string; status: string; parties: string[] }>).some((d) => d.kind === "final-two" && d.status === "open" && d.parties.includes(x) && d.parties.includes(y));
  const [x, y] = pair.flatMap((p, i) => pair.slice(i + 1).map((q) => [p, q] as const)).find(([p, q]) => !finalTwo(p, q))!;
  await at.call("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, a!], content: "a quiet word about who is close to whom", kind: "conversation", statement: { to: a, about: x, kind: "final-two-with", object: y } });
  const lie = ((at.sess.live.claims?.items ?? []) as Claim[]).find((c) => c.speaker === PLAYER && c.listener === a)!;
  expect(lie, "the player's claim is on the record").toBeDefined();
  expect(lie.isTrue, "the engine judged it false from its own records").toBe(false);
  expect(planted(at, a!, lie.id), "the listener believes it").toBeDefined();
  return { at, a: a!, ally: ally!, lie };
}

describe("0203 coming clean, the player's side, in a played season", () => {
  it("the player owns their lie in their own words: the listener's trust drops by the confession cost (less than a caught lie), the belief is taken back, no lied-to-me, and it happens once", async () => {
    const scene = (to: string, owns: boolean) => ({ initiator: PLAYER, witnessSet: [PLAYER, to], content: "about what I said earlier", kind: "conversation", ...(owns ? { statement: { to, retracts: true } } : {}) });
    const owned = await lieTold();
    await owned.at.call("recordInteraction", scene(owned.a, true));
    const control = await lieTold(); // the same season, played identically: the same scene without the confession
    await control.at.call("recordInteraction", scene(control.a, false));
    const cost = control.at.sess.rel.edge(control.a, PLAYER).trust - owned.at.sess.rel.edge(owned.a, PLAYER).trust;
    expect(cost).toBeCloseTo(COMING_CLEAN.confessShare * caughtLieTrustDrop(1), 9);
    expect(cost).toBeLessThan(caughtLieTrustDrop(CAUGHT_LIE.contradiction));
    expect(planted(owned.at, owned.a, owned.lie.id)?.refuted, "the belief is taken back").toBe(true);
    expect(beliefs(owned.at, owned.a).some((b) => b.kind === "lied-to-me" && b.subject === PLAYER), "no lied-to-me").toBe(false);
    expect((owned.at.sess.live.cleanActs ?? []).filter((x: { kind: string; by: string; to: string }) => x.kind === "confess" && x.by === PLAYER && x.to === owned.a)).toHaveLength(1);
    const trust = owned.at.sess.rel.edge(owned.a, PLAYER).trust;
    await owned.at.call("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, owned.a], content: "about what I said earlier, again", kind: "conversation", statement: { to: owned.a, retracts: true } });
    expect((owned.at.sess.live.cleanActs ?? []).filter((x: { kind: string; by: string; to: string }) => x.kind === "confess" && x.by === PLAYER && x.to === owned.a), "once").toHaveLength(1);
    expect(owned.at.sess.rel.edge(owned.a, PLAYER).trust, "a second confession costs nothing more than the scene").toBeGreaterThan(trust - COMING_CLEAN.confessShare * caughtLieTrustDrop(1) + 1e-9);
  }, 300_000);

  it("the player loops an ally in on the lie told to someone else: the ally holds 'the player lied to them', and the one lied to still believes it", async () => {
    const { at, a, ally, lie } = await lieTold();
    await at.call("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, ally], content: "something you should know about what I told them", kind: "conversation", statement: { to: ally, tellsAbout: a } });
    const held = beliefs(at, ally).find((b) => b.kind === "heard-rumor" && b.nature === "lying" && b.subject === PLAYER && b.object === a);
    expect(held, "the ally holds that the player lied to the listener").toBeDefined();
    expect(held!.source).toBe(PLAYER);
    expect(planted(at, a, lie.id)?.refuted, "the listener is not told: they still believe it").toBeFalsy();
    expect((at.sess.live.cleanActs ?? []).some((x: { kind: string; by: string; to: string; toldTo?: string }) => x.kind === "loop-in" && x.by === PLAYER && x.to === ally && x.toldTo === a)).toBe(true);
  }, 300_000);
});
