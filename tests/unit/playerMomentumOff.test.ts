import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * Player momentum is OFF (Ryne 2026-11-15: "Turn off momentum for now... it's clearly not ready"; #2634 reverted). A player-witnessed scene must NOT build any
 * NPC->PLAYER arc, in a played game or a headless one, so every NPC->player trajectory stays steady and nothing "->player" is persisted. Roles only.
 */
type G = { trajectoryOf(a: string, b: string): { phase: string; momentum: number }; livingIds(): string[]; live: { playedGame?: boolean }; snapshot(): unknown };

function played(): { sb: ReturnType<GameSessionRegistry["sandboxFor"]>; g: G; npc: string } {
  const sb = new GameSessionRegistry().sandboxFor(`mom-off-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  g.live.playedGame = true;
  return { sb, g, npc: g.livingIds().find((i) => i !== PLAYER)! };
}

describe("player momentum is off", () => {
  for (const direction of ["cooler", "warmer"] as const) {
    it(`a long run of ${direction} player scenes builds no NPC->player arc`, () => {
      const { sb, g, npc } = played();
      for (let i = 0; i < 12; i++) {
        sb.commands.recordInteraction({
          initiator: PLAYER, witnessSet: [PLAYER, npc], toward: [npc], content: `scene ${i}`,
          consequence: { edges: [{ toward: npc, direction }] },
        });
      }
      const arc = g.trajectoryOf(npc, PLAYER);
      expect(arc.phase).toBe("steady");
      expect(arc.momentum).toBe(0);
      expect(JSON.stringify(g.snapshot())).not.toContain(`${npc}->${PLAYER}`);
    });
  }

  it("an NPC-initiated scene the player witnesses builds none either", () => {
    const { sb, g, npc } = played();
    for (let i = 0; i < 6; i++) {
      sb.commands.recordInteraction({
        initiator: npc, witnessSet: [PLAYER, npc], toward: [PLAYER], content: `scene ${i}`, consequence: { edges: [{ toward: npc, direction: "cooler" }] },
      });
    }
    expect(g.trajectoryOf(npc, PLAYER).phase).toBe("steady");
  });
});
