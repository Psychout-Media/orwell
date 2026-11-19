import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-710 (Vault Wall): a houseguest the player has not met is in the engine's record and NOT in the narrator's roster/prompt or the state read before they walk in; they ARE after their entrance. Roles only; the planted sentinel is the unmet houseguest's own name, read off the engine record. */
let n = 0;
function start(seed: number, on = true) {
  const sb = new GameSessionRegistry().sandboxFor(`mor${n++}`);
  sb.session.setPremiereEntrancesEnabled(true);
  sb.session.setMetOnlyRosterEnabled(on);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb.session as GameSessionAdapter;
}
const record = (s: GameSessionAdapter) => s.snapshot().house!;
const everything = (s: GameSessionAdapter) => JSON.stringify({ state: s.getGameState(), prompt: s.getMomentPrompt({ moment: "premiere" } as never) });
const mentions = (hay: string, name: string) => hay.includes(name);

describe("ORW-710 the narrator roster and the state read carry only houseguests who have walked in", () => {
  it("positive control: every houseguest's name is in the engine record", () => {
    const s = start(11);
    for (const x of record(s).npcs) expect(x.name.length).toBeGreaterThan(2);
    expect(s.getGameState().house.length + (s.getGameState().unarrivedCount ?? 0)).toBe(record(s).npcs.length);
  });

  it("an unmet name is absent from the state and the narrator prompt until their entrance, present after", () => {
    const s = start(11);
    const npcs = record(s).npcs;
    const order = s.snapshot().live!.premiereEntrance!.order;
    let checked = 0;
    for (let step = 0; step < 40 && s.premiereIntros()?.entrance?.stage === "entrances"; step++) {
      const inside = new Set(order.slice(0, s.snapshot().live!.premiereEntrance!.arrived));
      const hay = everything(s);
      for (const x of npcs) {
        if (inside.has(x.id)) expect(mentions(hay, x.name), "met houseguest is visible").toBe(true);
        else { expect(mentions(hay, x.name), "unmet houseguest leaked").toBe(false); checked++; }
      }
      expect(s.getGameState().unarrivedCount ?? 0).toBe(npcs.filter((x) => !inside.has(x.id)).length);
      s.advanceGame();
    }
    expect(checked).toBeGreaterThan(10);
    const after = everything(s);
    for (const x of npcs) expect(mentions(after, x.name)).toBe(true);
    expect(s.getGameState().unarrivedCount).toBeUndefined();
  });

  it("the recap rule rides the entrance beat only while someone is still to arrive", () => {
    const s = start(11);
    expect(s.getMomentPrompt({ moment: "premiere" } as never).systemPrompt).toContain("RECAP RULE");
    for (let i = 0; i < 40 && s.premiereIntros()?.entrance?.stage === "entrances"; i++) s.advanceGame();
    expect(s.getMomentPrompt({ moment: "premiere" } as never).systemPrompt).not.toContain("RECAP RULE");
  });

  it("flag off: the whole cast is in the state read as before", () => {
    const s = start(11, false);
    expect(s.getGameState().house.length).toBe(record(s).npcs.length);
    expect(s.getGameState().unarrivedCount).toBeUndefined();
  });
});
