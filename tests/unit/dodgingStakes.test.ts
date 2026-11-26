import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { dodgeStakes } from "../../src/engine/dodging";
import { severityOf } from "../../src/engine/leverage";

/**
 * ORW-798 - the stakes of a dodged question come from what the dodger holds and whether they are on the block, not a literal 0.3.
 * Real path: a played game, the player walks to each houseguest with moveTo and presses with confide; nothing is set by hand. Roles only.
 */
type Held = { kind: string };
type S = {
  livingIds(): EntityId[];
  presence: Map<EntityId, string>;
  dodgeLog: Array<{ npc: EntityId; stakes?: number }>;
  house: { npcs: Array<{ id: EntityId; character: { hiddenElements?: Held[] } }> };
};

describe("dodgeStakes (pure)", () => {
  it("is bounded, rises with severity, and rises when on the block", () => {
    expect(dodgeStakes(0.5, false)).toBeLessThan(dodgeStakes(0.85, false));
    expect(dodgeStakes(0.5, false)).toBeLessThan(dodgeStakes(0.5, true));
    for (const sev of [-1, 0, 0.5, 1, 4]) for (const b of [false, true]) { const v = dodgeStakes(sev, b); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
});

describe("ORW-802: a power holder's dodge carries more stakes (HOH or veto holder: watched more, so a dodge is noticed more; Coordinator default +0.15)", () => {
  it("adds a bounded 0.15 for a power holder and stacks with the block", () => {
    expect(dodgeStakes(0.5, false, true) - dodgeStakes(0.5, false, false)).toBeCloseTo(0.15, 10);
    expect(dodgeStakes(0.5, true, true) - dodgeStakes(0.5, true, false)).toBeCloseTo(0.15, 10);
    for (const sev of [-1, 0, 0.5, 1, 4]) for (const b of [false, true]) for (const p of [false, true]) { const v = dodgeStakes(sev, b, p); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(dodgeStakes(0.5, false), "no third argument: unchanged").toBe(dodgeStakes(0.5, false, false));
  });
});

describe("a pressed houseguest's dodge is staked by what they hold (played game)", () => {
  it("each recorded dodge carries stakes derived from the held secret's kind, and different kinds differ", async () => {
    const seen = new Map<number, number>();
    let rows = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const rt = composeRuntime({ clock: new FakeClock(), seed });
      const user = `d798-${seed}`;
      const mcp = rt.registry.resolver()("player", user);
      await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
      await mcp.callTool("noteMessage", { messageId: "first" });
      const s = rt.registry.sandboxFor(user).session as unknown as S;
      for (const id of s.livingIds().filter((i) => i !== PLAYER)) {
        const room = s.presence.get(id);
        if (room) await mcp.callTool("moveTo", { room });
        await mcp.callTool("confide", { npcId: id });
      }
      for (const d of s.dodgeLog) {
        const npc = s.house.npcs.find((n) => n.id === d.npc)!;
        const held = npc.character.hiddenElements?.find((e) => e.kind !== "trigger");
        rows++;
        expect(d.stakes).toBeDefined();
        expect(d.stakes).toBeCloseTo(dodgeStakes(severityOf(held?.kind as never), false), 10);
        seen.set(d.stakes!, (seen.get(d.stakes!) ?? 0) + 1);
      }
    }
    expect(rows).toBeGreaterThan(3);
    expect(seen.size).toBeGreaterThan(1); // not one literal for every dodger
    expect([...seen.keys()]).not.toEqual([0.3]);
  });
});
