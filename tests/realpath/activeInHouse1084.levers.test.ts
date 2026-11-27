import { describe, it, expect } from "vitest";
import { playUntil, wfScan } from "./playedSeason";
import { firstSeedWhere } from "../support/firstSeedWhere";
import { PLAYER } from "../../src/domain/ids";

// ORW-1084: the levers half (see ./activeInHouseSeason.ts; its own file since ORW-410).
describe("a houseguest who has left the house acts and witnesses nowhere in it", () => {
  it("an evicted player's house levers are refused with the reason and record nothing; the jury house and the reads stay open", async () => {
    const out = (s: { sess: { live?: { evictionOrder?: string[] } } }): boolean => !!s.sess.live?.evictionOrder?.includes(PLAYER);
    // ORW-1104: scanned (bounded), not pinned to seed 10: the first season that votes the player out; a season whose pre-jury evictions pass without them stops early (the old stop was the whole season).
    const early = (s: { sess: { live?: { evictionOrder?: string[]; active?: string[] } } }): boolean => (s.sess.live?.evictionOrder?.length ?? 0) >= 7;
    const { at } = await firstSeedWhere(async (seed) => { const x = await playUntil(seed, (s) => out(s) || early(s), { user: `a7-lever-${seed}` }); return out(x) ? x : undefined; },
      { ...wfScan([1, 10, 11, 2, 3], "a season that votes the player out"), to: 30, wide: { maxSeasons: 30, budgetMs: 1_800_000, reason: "ORW-1104: the house voting the player out is a rare outcome; each season stops once seven houseguests are out without them" } });
    const npcs = (at.sess.house.npcs as Array<{ id: string }>).filter((n) => !at.sess.live.evictionOrder.includes(n.id));
    const target = npcs[0]!.id;
    const before = at.engine.events.queryAll().length;
    const refused = async (tool: string, args: Record<string, unknown>): Promise<string> => {
      try { await at.call(tool, args); } catch (e) { return String((e as Error).message); }
      return "ACCEPTED";
    };
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, target], content: "we talked it over", kind: "bonding" }],
      ["makeDeal", { with: target, kind: "safety", terms: "safe this week" }],
      ["formAlliance", { members: [target], name: "The Couch" }],
      ["tradeSecret", { toNpcId: target, bluff: true, subject: target }],
      ["diaryRoom", { entry: "a thought" }],
      ["moveTo", { room: "kitchen" }],
    ];
    for (const [tool, args] of attempts) expect(await refused(tool, args), tool).toMatch(/evicted/);
    expect(at.engine.events.queryAll().length, "a refused lever records nothing").toBe(before);
    expect(await at.call("getGameState", {}), "reads stay open").toBeTruthy();
  }, 900_000);
});
