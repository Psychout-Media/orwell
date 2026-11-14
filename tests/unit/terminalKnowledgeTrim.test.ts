import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { renderGameContext, renderHardConstraints, terminalKnowledgeItems, dedupeKeepNewest } from "../../src/engine/momentPrompts";
import type { GameStateView, PresentKnowledgeView } from "../../src/ports/GameSession";
import type { EntityId } from "../../src/domain/ids";

/**
 * ORW-349 - the terminal KNOWLEDGE SCOPE in the hard-constraints block restates what GAME CONTEXT already lists in full. Live week: both grew with the houseguests' accumulated knowledge (terminal 1.6k to 7.1k chars by Day 6, about a third of it
 * truncated "(overheard, muffled) <fragment>..." snatches and about 7% exact repeats). The terminal restatement drops those; GAME CONTEXT is untouched, so the ceiling of what an NPC may voice does not change. Roles only.
 */
const MUFFLED = (what: string) => `(overheard, muffled) ${what}…`;
const base = (() => {
  const sb = new GameSessionRegistry().sandboxFor("orw349");
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  const v = sb.session.getGameState();
  const wa = { room: "room", present: [{ id: "npc:1" as EntityId, name: "Houseguest A" }, { id: "npc:2" as EntityId, name: "Houseguest B" }], nearby: [], companions: [] };
  return { ...v, whereabouts: wa } as unknown as GameStateView;
})();
const pk = (e: Array<Partial<PresentKnowledgeView> & { id: string; name: string }>): GameStateView =>
  ({ ...base, presentKnowledge: e.map((x) => ({ knows: [], suspects: [], ...x })) as PresentKnowledgeView[] });

describe("terminalKnowledgeItems", () => {
  it("drops exact repeats (first kept, order kept) and truncated overhear snatches, keeps real overheard lines", () => {
    const out = terminalKnowledgeItems(["fact one", MUFFLED("Person cooked "), "fact two", "fact one", MUFFLED("Person cooked "), "(overheard) a full clear line"]);
    expect(out).toEqual(["fact one", "fact two", "(overheard) a full clear line"]);
  });
});

describe("the terminal block trims; GAME CONTEXT keeps everything", () => {
  const e = { id: "npc:1", name: "Houseguest A", knows: ["fact one", MUFFLED("x did a thing"), "fact one", "fact two"], suspects: ["a hunch", "a hunch"] };

  it("terminal: no repeats, no truncated snatches", () => {
    const hc = renderHardConstraints(pk([e]))!;
    expect(hc).toContain("Houseguest A — knows: fact one; fact two; suspects (a hunch): a hunch");
    expect(hc).not.toContain("muffled");
    expect(hc.match(/fact one/g)!.length).toBe(1);
  });

  it("GAME CONTEXT still lists every item the NPC holds (the ceiling is unchanged)", () => {
    const ctx = renderGameContext(pk([e]));
    expect(ctx).toContain("fact one");
    expect(ctx).toContain("fact two");
    expect(ctx).toContain(MUFFLED("x did a thing"));
  });

  it("an NPC who holds only muffled snatches keeps a line pointing at the full list (an absent line would read as 'knows nothing')", () => {
    const hc = renderHardConstraints(pk([{ id: "npc:2", name: "Houseguest B", knows: [MUFFLED("a"), MUFFLED("b")] }]))!;
    expect(hc).toContain("Houseguest B — knows only muffled snatches (the full list is in GAME CONTEXT above)");
  });

  it("a block with nothing to trim is byte-identical to the old rendering", () => {
    const hc = renderHardConstraints(pk([{ id: "npc:1", name: "Houseguest A", knows: ["a", "b"], suspects: ["c"] }]))!;
    expect(hc).toContain("    · Houseguest A — knows: a; b; suspects (a hunch): c");
  });
});

describe("dedupeKeepNewest (ORW-349: a fact held twice is listed once at the source)", () => {
  it("keeps the newest copy and the order, and loses no distinct fact", () => {
    expect(dedupeKeepNewest(["a", "b", "a", "c", "b"])).toEqual(["a", "c", "b"]);
    expect(dedupeKeepNewest([])).toEqual([]);
    expect(dedupeKeepNewest(["x", "y"])).toEqual(["x", "y"]);
  });
});
