import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * AMEND 0075 item 4 (S13) - confide() REFUSES when the player is not in a scene with that houseguest. Today only the `mayConfide` hint was scene-gated; "never a cold pop-up" rested on the prompt/FE.
 * Engine-enforced: with presence known, a houseguest in a DIFFERENT room than the player discloses nothing (no content, no hint of one, no bond fold). Roles only.
 */
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`confide-cp-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const npc = [...sb.session.livingIds()].find((i) => i !== PLAYER)!;
  return { sb, npc };
}
const seat = (s: unknown, entries: Array<[string, string]>) => { (s as { presence: Map<string, string> }).presence = new Map(entries); };

describe("confide refuses outside a live scene with that houseguest", () => {
  it("a houseguest in a different room than the player discloses nothing", () => {
    const { sb, npc } = started();
    seat(sb.session, [[PLAYER, "kitchen"], [npc, "bedroom"]]);
    const r = sb.session.confide(npc);
    expect(r).toEqual({ disclosed: false, tier: "none", truthful: true });
  });
  it("the refusal is total: no content, and the bond is not folded", () => {
    const { sb, npc } = started();
    seat(sb.session, [[PLAYER, "kitchen"], [npc, "bedroom"]]);
    const before = JSON.stringify(sb.engine.relationships.edge(npc, PLAYER));
    sb.session.confide(npc);
    expect(JSON.stringify(sb.engine.relationships.edge(npc, PLAYER))).toBe(before);
  });
  it("in the same room the normal decision applies (the gate adds no refusal of its own)", () => {
    const { sb, npc } = started();
    seat(sb.session, [[PLAYER, "kitchen"], [npc, "kitchen"]]);
    const r = sb.session.confide(npc);
    expect(r).not.toBeNull();
    expect(typeof r!.disclosed).toBe("boolean");
  });
  it("with no presence tracked at all (bare harness) behaviour is unchanged", () => {
    const { sb, npc } = started();
    (sb.session as unknown as { presence?: unknown }).presence = undefined;
    expect(sb.session.confide(npc)).not.toBeNull();
  });
});

// ORW-38 mutation sweep (#2130): the refusal tests above pass even with the presence gate removed, because a default houseguest does not disclose anyway. This one has a POSITIVE CONTROL:
// the same seeded game, with the bond maxed, DOES disclose in the same room - and is refused from another room.
describe("the presence gate is what refuses (positive control)", () => {
  function game(seed: number, room: string) {
    const sb = new GameSessionRegistry().sandboxFor(`confide-ctl-${seed}`); // the sandbox NAME seeds outcomes: both arms share it
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
    sb.session.advanceGame(); sb.session.advanceGame();
    const house = (sb.session as unknown as { house: { npcs: Array<{ id: string; character: { hiddenElements?: unknown[] } }> } }).house;
    const rel = (sb.session as unknown as { rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } } }).rel;
    return { sb, rel, npcs: house.npcs.filter((n) => (n.character.hiddenElements ?? []).length > 0).map((n) => n.id), room };
  }
  it("a houseguest who discloses in the player's room discloses nothing from another room", () => {
    let controls = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const probe = game(seed, "kitchen");
      for (const id of probe.npcs) {
        const arm = (room: string) => {
          const g = game(seed, room);
          for (const [a, b] of [[id, PLAYER], [PLAYER, id]] as const) { const e = g.rel.edge(a, b); e.trust = 1; e.affinity = 1; e.threat = 0; }
          seat(g.sb.session, [[PLAYER, "kitchen"], [id, room]]);
          return g.sb.session.confide(id);
        };
        const inRoom = arm("kitchen");
        if (!inRoom?.disclosed) continue;
        controls++;
        expect(arm("bedroom")?.disclosed ?? false, `seed ${seed} ${id}: refused from another room`).toBe(false);
      }
    }
    expect(controls, "at least one positive control disclosed in the same room").toBeGreaterThan(0);
  });
});

describe("AMEND 0075 item 3 - a weak-bond press never discloses (seeded negative over 6 seeds x every houseguest with a secret x repeated presses)", () => {
  it("a near-stranger (no trust, no pacts), in a scene with the player, never discloses (the decision is seeded per beat, so repeats in one beat reach the same answer)", () => {
    let pressed = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const sb = new GameSessionRegistry().sandboxFor(`confide-weak-${seed}`);
      sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
      sb.session.advanceGame(); sb.session.advanceGame();
      const house = (sb.session as unknown as { house: { npcs: Array<{ id: string; character: { hiddenElements?: unknown[] } }> } }).house;
      const rel = (sb.session as unknown as { rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } } }).rel;
      for (const npc of house.npcs) {
        if (!(npc.character.hiddenElements ?? []).length) continue;
        // make them a near-stranger toward the player in BOTH directions: floor the warmth, no pact
        for (const [a, b] of [[npc.id, PLAYER], [PLAYER, npc.id]] as const) { const e = rel.edge(a, b); e.trust = 0; e.affinity = 0; e.threat = 0.4; }
        (sb.session as unknown as { presence: Map<string, string> }).presence = new Map([[PLAYER, "kitchen"], [npc.id, "kitchen"]]); // in a scene - only the bond is missing
        for (let week = 0; week < 3; week++) {
          const r = sb.session.confide(npc.id);
          pressed++;
          expect(r?.disclosed ?? false, `seed ${seed} ${npc.id} week ${week}: a weak-bond press must not disclose`).toBe(false);
        }
      }
    }
    expect(pressed).toBeGreaterThan(20); // the test actually pressed many houseguests
  });
});
