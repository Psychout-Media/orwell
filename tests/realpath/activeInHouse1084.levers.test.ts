import { describe, it, expect } from "vitest";
import { playUntil } from "./playedSeason";
import { firstSeedWhere } from "../support/firstSeedWhere";
import { PLAYER } from "../../src/domain/ids";

// ORW-1084: the levers half (see ./activeInHouseSeason.ts; its own file since ORW-410).
describe("a houseguest who has left the house acts and witnesses nowhere in it", () => {
  it("an evicted player's house levers are refused with the reason and record nothing; the jury house and the reads stay open", async () => {
    const out = (s: { sess: { live?: { evictionOrder?: string[] } } }): boolean => !!s.sess.live?.evictionOrder?.includes(PLAYER);
    // ORW-1079: a scan (the first season that evicts the player), not a fixed seed: the vote leans move which seasons do; 1, 10 and 11 are seeds that have.
    const at = (await firstSeedWhere((seed, sandbox) => playUntil(seed, (s) => out(s), { user: sandbox }), { from: 1, to: 20, hint: [1, 10, 11], sandbox: (sd) => `a7-lever-${sd}`, what: "a season that evicts the player" })).at;
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
