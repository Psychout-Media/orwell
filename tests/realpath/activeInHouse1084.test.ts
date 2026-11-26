import { describe, it, expect } from "vitest";
import { auditSeason } from "../support/activeInHouseAudit";
import { playUntil } from "./playedSeason";
import { playSeason } from "../support/whatFired/player";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-1084 / ORW-1085 / ORW-1086 (audit A7). REAL PATH: whole seasons are played through the player's levers (the scripted talking player), and the engine's own recorded events are READ.
 * One status gate, "active in the house" (src/engine/inHouse.ts): a juror, a pre-jury evictee and an evicted or finished-season player neither act nor witness in the house.
 * Seed 10 (the card's seed): before the gate a pre-jury evictee kept turning up as the one who acted or a witness in deals and betrayals, and an evicted juror in a reason said aloud.
 * Heavy lane (tests/realpath): each season plays a few minutes, so run it on a runner. Roles only.
 */
describe("a houseguest who has left the house acts and witnesses nowhere in it", () => {
  it.each([10, 1])("seed %i: no pre-jury evictee, no juror with an active houseguest, no evicted player in a house scene (finale night and the broadcast record excepted)", async (seed) => {
    const row = await auditSeason(seed);
    expect(row.finished, "the season was played to its crown").toBe(true);
    const detail = row.hits.slice(0, 6).map((h) => `${h.kind} ${h.type} ${h.id} ${h.content}`);
    expect({ preJury: row.preJuryEvictee, jurorWithActive: row.jurorWithActive, outPlayer: row.outPlayer, detail }).toEqual({ preJury: 0, jurorWithActive: 0, outPlayer: 0, detail: [] });
  }, 900_000);

  it("an evicted player's house levers are refused with the reason and record nothing; the jury house and the reads stay open", async () => {
    const out = (s: { sess: { live?: { evictionOrder?: string[] } } }): boolean => !!s.sess.live?.evictionOrder?.includes(PLAYER);
    const at = await playUntil(10, (s) => out(s), { user: "a7-lever-10" });
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

  it("a player in a finished season: the same levers refuse with season-over", async () => {
    let msgs: string[] = [];
    await playSeason({
      seed: 10, user: "a7-over-10", survive: false, maxMessages: 4000,
      after: async ({ call }) => {
        for (const [tool, args] of [["makeDeal", { with: "npc:4", kind: "safety", terms: "safe" }], ["formAlliance", { members: ["npc:4"], name: "The Reunion" }], ["recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, "npc:4"], content: "hello", kind: "bonding" }]] as Array<[string, Record<string, unknown>]>) {
          try { await call(tool, args); msgs.push("ACCEPTED"); } catch (e) { msgs.push(String((e as Error).message)); }
        }
      },
    });
    expect(msgs).toHaveLength(3);
    for (const m of msgs) expect(m).toMatch(/season-over/);
  }, 900_000);
});
