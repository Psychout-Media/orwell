import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { type Stop, firstStop, playUntil, wfScan } from "./playedSeason";
import { firstSeedWhere } from "../support/firstSeedWhere";
import { AssuranceLedger } from "../../src/engine/assurances";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-686 (the victim recorded from the real event), in a PLAYED season (ORW-813: before, the deal was made and broken through private seams, the house was seated in the kitchen
 * by hand and the season marked played). Seed 3, the scripted talking player: the player makes deals as they talk, and at the first eviction they vote against the houseguest
 * they hold a deal with (their own choice through the `decide` hook), which breaks it through the real binding-action reconcile. Then, in a room with that houseguest and two
 * others, a houseguest tells the room what they believe about the player (the narrator's `recordInteraction` with `heardAboutMe`). A rumor names WHO WAS BETRAYED only when the
 * betrayal is on the public record; a secret-ballot break, and a rumor with no betrayal behind it, name no victim. The public-break case was not reached in play (the todo). Roles only.
 */
const HINT = 3; // ORW-880: a seed tried early; each test scans from here (wfScan). ORW-999: the bed rush now resolves on player messages, which moved the played trajectories: seed 8 reaches the precondition first, then 5 and 3.
type Deal = { status: string; brokenBy?: string; parties: string[] };
const dealsOf = (s: Stop): Deal[] => s.sess.deals.forParty(PLAYER) as Deal[];
/** Who is in the room with the player, and awake, for a scene recorded now: the engine's own witness roster (the room as it was when the player last spoke). */
const room = (s: Stop): string[] => {
  const occ = (s.sess.sendTimeOccupancy() ?? s.sess.presence) as Map<string, string>; const here = occ.get(PLAYER); const awake = s.sess.awakeNow() as Set<string> | null;
  return [...occ].filter(([id, r]) => r === here && id !== PLAYER && (!awake || awake.has(id))).map(([id]) => id); // awake: a scene's named listeners must be up to hear it
};
const betrayed = (s: Stop): string[] => dealsOf(s).filter((d) => d.status === "broken" && d.brokenBy === PLAYER).map((d) => d.parties.find((p) => p !== PLAYER)!).filter((v) => s.sess.livingIds().includes(v));
const quiet = (s: Stop): boolean => !s.sess.getGameState().pending && !s.sess.live?.ceremony;
/** The player's vote: against a nominee they hold an open deal with (their choice), else the script's own. */
/** The game moves on to its next beat the way the narrator moves it: messages, then advanceGame when the schedule allows, every decision answered. */
async function playOnToTheNextBeat(s: Stop): Promise<void> {
  const seq0 = s.sess.beatSeqNow?.() ?? 0;
  for (let i = 0; i < 400; i++) {
    await s.call("noteMessage", { messageId: `on-${i}` });
    const v = await s.call("advanceGame", {});
    if (v?.pending) { const r = answerPending(v.pending); if (r) await s.call("submitDecision", r as unknown as Record<string, unknown>); }
    if (!v?.held && v?.event) return;
    if (v?.held && /night/.test(s.sess.gameStatus().timeOfDay ?? "")) await s.call("turnIn", {});
    if ((s.sess.beatSeqNow?.() ?? 0) > seq0 + 50) return;
  }
}
const voteAgainstAPartner = (p: { kind: string; options: Array<{ id: string }> }, sess: { deals: { forParty(id: string): Deal[] } }) => {
  if (p.kind !== "eviction-vote") return undefined;
  const partners = new Set(sess.deals.forParty(PLAYER).filter((d) => d.status === "open").flatMap((d) => d.parties));
  const o = p.options.find((x) => partners.has(x.id));
  return o ? { kind: "eviction-vote", vote: o.id } : undefined;
};
const rumorsOf = (s: Stop, holder: string): BeliefClaim[] => ((s.sess.live.beliefs?.[holder] ?? []) as BeliefClaim[]).filter((c) => c.kind === "heard-rumor" && c.nature === "betrayal" && c.origin === "told");
async function tellTheRoom(s: Stop, v: string): Promise<{ o: string; t: string }> {
  const [t, o] = room(s).filter((id) => id !== v);
  await s.call("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, t!, v, o!], content: "one houseguest tells the others what they believe about the player", kind: "gossip", heardAboutMe: { nature: "betrayal", from: t } });
  return { o: o!, t: t! };
}

describe("a betrayal rumor records its victim from the real betrayal event (played)", () => {
  it("a deal the player broke at the secret ballot names no victim: the betrayed never learned who broke it, so the rumor stays victim-less, and the told rumor still costs a bystander a small bounded distrust", async () => {
    // seed 3: at the first eviction the player votes against a houseguest they hold a deal with; the break is a secret ballot (the wronged side never learns it by name)
    // the precondition: the player broke a deal at the secret ballot, a houseguest tells the room what they believe about the player, AND the bystander hears it (ORW-920: whether a told rumor lands is the house's call, so the seed is scanned for it, not assumed)
    const heardTold = (s: Stop, o: string) => rumorsOf(s, o).find((c) => c.subject === PLAYER);
    const found = await firstSeedWhere(async (seed) => {
      const s = await playUntil(seed, (x) => quiet(x) && betrayed(x).some((y) => room(x).includes(y)) && room(x).length >= 3, { user: `wf-${seed}`, decide: voteAgainstAPartner });
      // the only recorded betrayal is the secret-ballot break: a broken casual assurance is a PUBLIC betrayal and does name its victim (a different claim, checked elsewhere)
      if (AssuranceLedger.fromJSON(s.sess.live.assurances ?? []).all.some((a) => a.status === "broken" && a.from === PLAYER)) return undefined;
      const victim = betrayed(s).find((x) => room(s).includes(x))!;
      const { o: bystander } = await tellTheRoom(s, victim);
      return heardTold(s, bystander) ? { s, victim, bystander } : undefined;
    }, wfScan([2, 1, 8, 5, HINT], "a played season where the player breaks a deal at the secret ballot and the bystander hears the told rumor"));
    const at = found.at.s, v = found.at.victim, o = found.at.bystander;
    const deal = dealsOf(at).find((d) => d.status === "broken" && d.brokenBy === PLAYER && d.parties.includes(v)) as Deal & { secretVote?: boolean };
    expect(deal.secretVote, "the break was the player's secret ballot").toBe(true);
    for (const h of [v, o]) for (const c of rumorsOf(at, h)) expect(c.object, "no victim from a ballot the betrayed never saw").toBeUndefined();
    expect(rumorsOf(at, v).length + rumorsOf(at, o).length, "non-vacuous: the rumor landed").toBeGreaterThan(0);
    const toO = () => rumorsOf(at, o).find((c) => c.subject === PLAYER);
    expect(toO(), "the bystander heard it about the player (no mishearing on this seed)").toBeDefined();
    await playOnToTheNextBeat(at); // the week's claims are folded at commit time, before a beat
    const drop = -(toO()!.impact?.trust ?? 0);
    expect(drop, "a bystander distrusts the betrayer").toBeGreaterThan(0);
    expect(drop).toBeLessThan(0.1);
  }, 900_000);

  // ORW-813: not reached in play. A victim is named only for a PUBLIC break (a nomination or a replacement by the player as HOH; a ballot break stays sealed). In 18 played seasons
  // (seeds 1-18, the scripted talking player nominating any houseguest it holds a safety deal with) the player was never HOH before week 8 or their eviction, so no public break happened.
  it.todo("real path: a deal the player broke in public names the betrayed on a later betrayal rumor; the betrayed folds 'targets me', a bystander a bounded distrust; it survives a save - not reached: the player never held HOH in 18 played seasons (ORW-686)");

  it("a rumor with no recorded betrayal behind it stays victim-less", async () => {
    const at = await firstStop((s) => quiet(s) && s.sess.getGameState().phase !== "premiere" && dealsOf(s).every((d) => d.status !== "broken") && room(s).length >= 3, wfScan(HINT));
    const [v] = room(at);
    const { o } = await tellTheRoom(at, v!);
    for (const h of [v!, o]) for (const c of rumorsOf(at, h)) expect(c.object).toBeUndefined();
    expect(rumorsOf(at, v!).length + rumorsOf(at, o).length, "non-vacuous: the rumor landed").toBeGreaterThan(0);
  }, 120_000);
});
