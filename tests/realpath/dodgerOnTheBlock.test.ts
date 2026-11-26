import { describe, it, expect } from "vitest";
import { playUntil } from "./playedSeason";
import { dodgeStakes } from "../../src/engine/dodging";
import { severityOf } from "../../src/engine/leverage";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-802 (leftover of ORW-798) - the on-the-block term of a dodge's stakes, reached in a played game: the scripted talking player plays until the HOH has named nominees, then presses every other houseguest
 * (moveTo + confide, the real levers). A nominated houseguest who turns the press aside carries higher stakes than the same secret would off the block, and everyone else carries the off-block value.
 * Nothing is set by hand. Roles only.
 */
describe("a dodger on the block reads higher stakes (played)", () => {
  it("every dodge recorded while someone is nominated is staked by their secret and by whether they are on the block", async () => {
    let nominated = 0, offBlock = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      if (nominated >= 2 && offBlock >= 2) break;
      let at;
      try { at = await playUntil(seed, (s) => (s.sess.live?.nominees?.length ?? 0) >= 2 && !s.sess.getGameState().pending, { user: `wf-${seed}`, maxMessages: 1200 }); } catch { continue; }
      const sess = at.sess;
      const block = new Set<string>(sess.live.nominees);
      const rows = () => sess.dodgeLog.length as number;
      const before = rows(); // ORW-892: only the dodges THIS press records (earlier ones, from other weeks' blocks, were staked by the block of their own week)
      for (const id of (sess.livingIds() as string[]).filter((i) => i !== PLAYER)) {
        const room = sess.presence.get(id);
        if (room) await at.call("moveTo", { room });
        await at.call("confide", { npcId: id });
      }
      expect(rows() - before, `seed ${seed}: pressing the house produced dodges`).toBeGreaterThan(0);
      for (const d of (sess.dodgeLog as Array<{ npc: string; stakes?: number; week: number }>).slice(before)) {
        const held = sess.house.npcs.find((n: { id: string }) => n.id === d.npc).character.hiddenElements?.find((e: { kind: string }) => e.kind !== "trigger");
        const on = block.has(d.npc);
        expect(d.stakes).toBeCloseTo(dodgeStakes(severityOf(held?.kind), on), 10);
        if (on) { nominated++; expect(d.stakes!).toBeGreaterThan(dodgeStakes(severityOf(held?.kind), false)); } else offBlock++;
      }
    }
    expect(nominated, "a nominated houseguest dodged a press").toBeGreaterThan(0);
    expect(offBlock, "a houseguest off the block dodged a press").toBeGreaterThan(0);
  }, 900_000);
});
