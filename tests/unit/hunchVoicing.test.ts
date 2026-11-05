import { describe, it, expect } from "vitest";
import { renderGameContext } from "../../src/engine/momentPrompts";

/**
 * A94 (PO ruling, card 26 / 0105): an NPC voiced as "keeping a close eye on" a rival is FINE as information, but it is a POSSIBILITY ("not my target yet, but could be"), never a confirmation. So when a
 * present houseguest carries a `suspects` hunch, the narrator prompt must say to voice it as a possibility - no plan, number, decision or campaign word - and say nothing of the kind when no hunch is present
 * (byte-identical). Roles only.
 */
const view = (suspects: string[]) => ({
  started: true, week: 2, phase: "nominations", player: { id: "player", name: "The Player" },
  whereabouts: { present: [{ id: "npc:1", name: "Robin" }], companions: [], nearby: [], room: "kitchen" }, house: [{ id: "npc:1", name: "Robin" }],
  presentKnowledge: [{ id: "npc:1", name: "Robin", knows: [], suspects }],
}) as never;

describe("a hunch is voiced as a possibility", () => {
  it("with a hunch present, the prompt tells the narrator to voice it as 'not my target yet, but could be' and never as a plan or a confirmation", () => {
    const ctx = renderGameContext(view(["has been keeping a close eye on the rival"]));
    expect(ctx).toContain("has been keeping a close eye on the rival");
    expect(ctx).toMatch(/not my target yet, but could be/i);
    expect(ctx).toMatch(/possibility/i);
    expect(ctx).toMatch(/never (?:a|as a) confirmation|not a confirmation/i);
    expect(ctx).toMatch(/no plan|never .*plan/i);
  });
  it("with no hunch the instruction is absent (byte-identical block)", () => {
    const ctx = renderGameContext(view([]));
    expect(ctx).not.toMatch(/not my target yet/i);
  });
  it("the hunch line itself still carries no digit or motive word (the existing 0105 wall)", () => {
    const ctx = renderGameContext(view(["has been keeping a close eye on the rival"]));
    const line = ctx.split("\n").find((l) => l.includes("suspects (a hunch"))!;
    expect(line).not.toMatch(/\d|campaign|plan to|going to evict|target them/i);
  });
});
