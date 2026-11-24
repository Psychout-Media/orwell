import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { canBeDrawnTo, chemistryKey } from "../../src/engine/attraction";
import { receptivenessToPlayer, ANSWER_BAR } from "../../src/engine/playerShowmance";
import { bondKey, emptyBond } from "../../src/engine/bondRecord";

/**
 * ORW-900: how a houseguest takes a romantic gesture from the player now. The pure rule is three-way and engine-only; the adapter read the narrator is handed
 * (`receptivenessOf`) is two words, "welcoming" or "reserved", so a houseguest who cannot be drawn to the player and one with no chemistry read the SAME from outside
 * (the reply never discloses orientation or chemistry). Unit lane: the season state is set by hand to reach each case. Roles only.
 */
type Rig = {
  live: { playedGame?: boolean; chemistry?: Record<string, number>; bonds?: Record<string, ReturnType<typeof emptyBond>> };
  attractionIdentityOf(id: string): { orientation: string; gender: string } | undefined;
  receptivenessOf(id: string): "welcoming" | "reserved" | null;
  house: { npcs: Array<{ id: string }> };
};
function rig(user: string, genderPresentation?: string) {
  const s = new GameSessionRegistry().sandboxFor(user).session;
  s.createCharacter({ playerName: "The Player", seed: 5, ...(genderPresentation ? { genderPresentation } : {}) } as never);
  const r = s as unknown as Rig;
  r.live.playedGame = true;
  r.live.chemistry ??= {};
  r.live.bonds ??= {};
  return r;
}
const drawnIds = (r: Rig, pg: string) => r.house.npcs.map((n) => n.id).filter((id) => { const a = r.attractionIdentityOf(id); return !!a && !!a.gender && canBeDrawnTo(a.orientation as never, a.gender as never, pg as never); });
const answering = (r: Rig, id: string) => { r.live.bonds![bondKey(id, PLAYER)] = { ...emptyBond(), warmth: 0.8, romance: 6 }; };

describe("ORW-900: receptiveness to the player's gesture", () => {
  it("the pure rule: not drawn or no chemistry is not-that-way; drawn with chemistry is welcoming once they answer in kind (and not cold), unsure before", () => {
    expect(receptivenessToPlayer({ drawn: false, chemistry: 0.9, answered: 1 })).toBe("not-that-way");
    expect(receptivenessToPlayer({ drawn: true, chemistry: 0, answered: 1 })).toBe("not-that-way");
    expect(receptivenessToPlayer({ drawn: true, chemistry: 0.5, answered: ANSWER_BAR - 0.01 })).toBe("unsure");
    expect(receptivenessToPlayer({ drawn: true, chemistry: 0.5, answered: ANSWER_BAR })).toBe("welcoming");
    expect(receptivenessToPlayer({ drawn: true, chemistry: 0.5, answered: 1, coldNow: true })).toBe("unsure");
  });

  it("the read the narrator gets: a houseguest who cannot be drawn and one with no chemistry hand the SAME word, even both answering in kind", () => {
    const r = rig("rcp-same", "woman");
    const drawn = drawnIds(r, "woman");
    const notDrawn = r.house.npcs.map((n) => n.id).filter((id) => !drawn.includes(id));
    expect(drawn.length > 0 && notDrawn.length > 0, "positive control: the cast has both").toBe(true);
    const [cannot, noChem] = [notDrawn[0]!, drawn[0]!];
    r.live.chemistry![chemistryKey(cannot, PLAYER)] = 0.9; // even with a ceiling on record (the engine never seeds one; the read must not trust it)
    delete r.live.chemistry![chemistryKey(noChem, PLAYER)];
    answering(r, cannot); answering(r, noChem);
    expect(r.receptivenessOf(cannot)).toBe("reserved");
    expect(r.receptivenessOf(noChem)).toBe("reserved");
    expect(JSON.stringify(r.receptivenessOf(cannot))).toBe(JSON.stringify(r.receptivenessOf(noChem)));
  });

  it("welcoming only when drawn, with chemistry, and answering in kind; reserved before they answer", () => {
    const r = rig("rcp-welcome", "man");
    const id = drawnIds(r, "man")[0]!;
    r.live.chemistry![chemistryKey(id, PLAYER)] = 0.7;
    expect(r.receptivenessOf(id)).toBe("reserved");
    answering(r, id);
    expect(r.receptivenessOf(id)).toBe("welcoming");
  });

  it("the player's gender unsaid: nobody is welcoming, whatever the record holds", () => {
    const r = rig("rcp-unsaid");
    for (const n of r.house.npcs) { r.live.chemistry![chemistryKey(n.id, PLAYER)] = 0.9; answering(r, n.id); }
    for (const n of r.house.npcs) expect(r.receptivenessOf(n.id)).toBe("reserved");
  });

  it("null outside a played game, for the player, and for someone not in the house; no number ever crosses", () => {
    const r = rig("rcp-null", "nonbinary");
    expect(r.receptivenessOf(PLAYER)).toBeNull();
    expect(r.receptivenessOf("npc:nobody")).toBeNull();
    r.live.playedGame = false;
    expect(r.receptivenessOf(r.house.npcs[0]!.id)).toBeNull();
    r.live.playedGame = true;
    for (const n of r.house.npcs) expect(["welcoming", "reserved"]).toContain(r.receptivenessOf(n.id));
  });
});
