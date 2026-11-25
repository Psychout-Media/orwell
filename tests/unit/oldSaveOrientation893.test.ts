import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-893 roll-out: only newly generated casts change. A save already holds each houseguest's orientation (the out label on the character, the sealed ones in `privateOrientations`) and the seeded layer; loading it
 * must neither re-derive nor "fix" them, even a label the old uniform draw wrote that does not fit the presentation. Real load path: `registry.restore` of a JSON snapshot. Roles only.
 */
describe("an old save keeps the orientations it holds", () => {
  it("a sealed label that does not fit the presentation (old draw) is restored as written, and the seeded layer is not re-seeded", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("old-893");
    sb.session.createCharacter({ playerName: "The Player", seed: 21 });
    const snap = JSON.parse(JSON.stringify(reg.snapshot("old-893"))) as ReturnType<GameSessionRegistry["snapshot"]> & { privateOrientations?: Record<string, string>; seededRelationships?: unknown };
    const man = snap.house!.npcs.find((n) => n.character.genderPresentation === "man" && n.character.outOrientation === undefined)!;
    snap.privateOrientations = { ...(snap.privateOrientations ?? {}), [man.id]: "lesbian" }; // what the old draw could write
    delete snap.seededRelationships; // a save from before the layer was always written: it re-seeds as it always did
    const after = reg.restore("old-893", snap).session.snapshot() as { privateOrientations?: Record<string, string>; house: { npcs: Array<{ id: string; character: { outOrientation?: string } }> } };
    expect(after.privateOrientations?.[man.id]).toBe("lesbian");
    for (const n of snap.house!.npcs) expect(after.house.npcs.find((x) => x.id === n.id)!.character.outOrientation).toBe(n.character.outOrientation);
  });
  it("a save whose seeded layer was empty keeps it empty (nothing is seeded on load)", () => {
    const reg = new GameSessionRegistry();
    let found = false;
    for (let seed = 1; seed <= 60 && !found; seed++) {
      const sb = reg.sandboxFor(`empty-893-${seed}`);
      sb.session.createCharacter({ playerName: "The Player", seed });
      const snap = JSON.parse(JSON.stringify(reg.snapshot(`empty-893-${seed}`))) as { seededRelationships?: { ties: unknown[]; showmances: unknown[] } };
      if (snap.seededRelationships && snap.seededRelationships.ties.length === 0 && snap.seededRelationships.showmances.length === 0) {
        found = true;
        const again = reg.restore(`empty-893-${seed}`, snap as never).session.snapshot() as { seededRelationships?: { ties: unknown[]; showmances: unknown[] } };
        expect(again.seededRelationships).toEqual({ ties: [], showmances: [] });
      }
    }
    expect(found, "a seed whose cast seeded neither a tie nor a showmance").toBe(true);
  }, 120_000);
});
