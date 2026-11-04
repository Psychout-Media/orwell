import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";

/**
 * A11 (finding from #2088): during the GATHERED toast `whereabouts()` shows the whole house in the player's room, but `recordInteraction` without `toward` folded nothing because the
 * phantom-witness check read the underlying wander positions. A chat during the toast must count: the NPC the player talks to witnesses it and the relationship moves. Roles only.
 */
function toast(seed: number, user: string) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.setPremiereEntrancesEnabled(false); // the classic champagne circle (gathered at move-in)
  sb.session.createCharacter({ playerName: "P", seed });
  return { sb, s: sb.session as GameSessionAdapter };
}

describe("a chat during the gathered toast counts", () => {
  it("the NPC the player talks to witnesses the scene (even one the wander map had elsewhere) and the hidden relationship folds", () => {
    // one interaction per fresh game: the consequence fold rate-limits repeated scenes inside one turn, which would mask the witness fix
    let checked = 0, awayCases = 0, moved = 0;
    for (const seed of [3, 5, 7, 9]) {
      for (const idx of [0, 4, 9, 13]) {
        const { sb, s } = toast(seed, `toast${seed}-${idx}`);
        expect((s.snapshot().live as { champagneCircle?: string }).champagneCircle).toBe("gathered");
        const wa = s.whereabouts()!;
        expect(wa.houseEvent?.kind).toBe("champagne-circle");
        const target = wa.present[idx]!.id;
        const base = (s as unknown as { presence: Map<string, string> | null }).presence!;
        if (base.get(target) !== base.get(PLAYER)) awayCases++;
        const before = JSON.stringify(sb.engine.relationships.edge(target, PLAYER));
        const rec = sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, target], content: "I toast with them and tell them I like their energy", kind: "bonding" }) as { eventId: string };
        const ev = sb.engine.events.queryAll().find((e) => e.id === rec.eventId);
        expect(ev?.witnessSet, `the toast partner (${target}) is a witness`).toContain(target);
        if (JSON.stringify(sb.engine.relationships.edge(target, PLAYER)) !== before) moved++;
        checked++;
      }
    }
    expect(checked).toBe(16);
    expect(awayCases, "the sample includes houseguests the wander map had in another room (the bug's case)").toBeGreaterThan(0);
    expect(moved, "the hidden relationship folds for the toast partner").toBe(checked);
  });
  it("outside the toast the base occupancy is returned untouched (no overlay)", () => {
    const { s } = toast(3, "toast-after");
    while ((s.snapshot().live as { champagneCircle?: string }).champagneCircle === "gathered") s.advanceGame();
    expect(s.occupancy()).toBe((s as unknown as { presence: unknown }).presence);
  });
});
