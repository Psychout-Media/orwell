import { describe, it, expect } from "vitest";
import { renderHardConstraints, renderGameContext } from "../../src/engine/momentPrompts";

// ORW-718: the player is never gendered by the narrator or a houseguest unless the player stated it.
const live = (gp?: string) =>
  ({
    started: true,
    player: { id: "player", name: "The Player", ...(gp ? { genderPresentation: gp } : {}) },
    whereabouts: { present: [{ id: "npc:1", name: "Robin" }] },
    house: [{ id: "npc:1", name: "Robin", genderPresentation: "man" }],
    presentKnowledge: [],
  }) as any;

describe("ORW-718 player gender rule", () => {
  it("terminal block: a stated gender is a lock; none stated is a no-assumption rule", () => {
    expect(renderHardConstraints(live("woman"))!).toContain("PRONOUN LOCK: the player uses she/her.");
    const none = renderHardConstraints(live())!;
    expect(none).toContain("The player's gender is unstated");
    expect(none).not.toContain("the player uses");
  });

  it("casting prompt: carries the rule, and the on-file gender when there is one", () => {
    const base = { started: false, player: null, house: [] } as any;
    const unstated = renderGameContext({ ...base, casting: { known: { playerName: "x" }, next: "n", ready: true, finalizable: false } });
    expect(unstated).toContain("The player's gender is unstated");
    const stated = renderGameContext({ ...base, casting: { known: { playerName: "x", genderPresentation: "nonbinary" }, next: "n", ready: true, finalizable: false } });
    expect(stated).toContain("PRONOUN LOCK: the player uses they/them.");
    expect(stated).not.toContain("is unstated");
  });
});
