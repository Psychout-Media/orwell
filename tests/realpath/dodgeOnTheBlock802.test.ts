import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { dodgeStakes } from "../../src/engine/dodging";
import { severityOf } from "../../src/engine/leverage";
import { type Stop, firstStops, wfScan } from "./playedSeason";

/**
 * ORW-802 (leftover of ORW-798): the on-the-block term of a dodged question's stakes, in a PLAYED season. The season is played by the scripted talking player on the production runtime up to nominations;
 * then the player walks to a nominee with moveTo and presses them with confide, through the player channel (nothing is set by hand). Each recorded dodge by a nominee carries stakes that include the block's 0.25;
 * the same kind of secret held by a houseguest who is not nominated carries less. Roles only.
 */
type Held = { kind: string };
type Sess = {
  live: { nominees?: EntityId[] };
  livingIds(): EntityId[];
  presence: Map<EntityId, string>;
  dodgeLog: Array<{ npc: EntityId; stakes?: number }>;
  house: { npcs: Array<{ id: EntityId; character: { hiddenElements?: Held[] } }> };
};
const heldKind = (s: Sess, id: EntityId): string | undefined => s.house.npcs.find((n) => n.id === id)?.character.hiddenElements?.find((e) => e.kind !== "trigger")?.kind;
const nominatedWithSecret = (st: Stop): boolean => {
  const s = st.sess as Sess;
  const noms = s.live.nominees ?? [];
  return noms.length > 0 && noms.some((id) => id !== PLAYER && s.presence.get(id) !== undefined && heldKind(s, id) !== undefined);
};

describe("a nominee's dodge is staked by the block as well as by what they hold (played season)", () => {
  it("every recorded dodge by a nominee carries the block's term; a houseguest off the block does not", async () => {
    const stops = await firstStops(4, nominatedWithSecret, wfScan([1, 2, 3, 4], "nominations set, a nominee holding a secret"), { maxMessages: 900 });
    let onBlock = 0, offBlock = 0;
    for (const at of stops) {
      const s = at.sess as Sess;
      const noms = new Set(s.live.nominees ?? []);
      const before = s.dodgeLog.length;
      for (const id of s.livingIds().filter((i) => i !== PLAYER)) {
        const room = s.presence.get(id);
        if (room) await at.call("moveTo", { room });
        await at.call("confide", { npcId: id });
      }
      for (const d of s.dodgeLog.slice(before)) {
        const k = heldKind(s, d.npc);
        const isNom = noms.has(d.npc);
        expect(d.stakes, "the dodge carries its stakes").toBeDefined();
        expect(d.stakes).toBeCloseTo(dodgeStakes(severityOf(k as never), isNom), 10);
        if (isNom) onBlock++; else offBlock++;
      }
    }
    expect(onBlock, "positive control: a nominee was pressed and dodged").toBeGreaterThan(0);
    expect(offBlock, "positive control: a houseguest off the block dodged too").toBeGreaterThan(0);
  }, 900_000);
});
