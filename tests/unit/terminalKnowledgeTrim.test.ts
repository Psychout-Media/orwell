import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { renderGameContext, renderHardConstraints, terminalKnowledgeItems, dedupeKeepNewest, TERMINAL_KNOWLEDGE_NEWEST } from "../../src/engine/momentPrompts";
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
  it("drops exact repeats (newest kept, order kept) and truncated overhear snatches, keeps real overheard lines", () => {
    const out = terminalKnowledgeItems(["fact one", MUFFLED("Person cooked "), "fact two", "fact one", MUFFLED("Person cooked "), "(overheard) a full clear line"]);
    expect(out).toEqual({ shown: ["fact two", "fact one", "(overheard) a full clear line"], older: 0 });
  });

  it("lists only the newest few and counts the older ones the full list still holds", () => {
    const items = Array.from({ length: 9 }, (_, k) => `fact ${k + 1}`);
    const out = terminalKnowledgeItems(items);
    expect(TERMINAL_KNOWLEDGE_NEWEST).toBe(5);
    expect(out.shown).toEqual(["fact 5", "fact 6", "fact 7", "fact 8", "fact 9"]);
    expect(out.older).toBe(4);
  });

  it("the shown items are always a subset of what the full list holds (nothing voiced beyond the ceiling by construction)", () => {
    const items = ["a", MUFFLED("x"), "b", "a", "c", "d", "e", "f", "g", "h"];
    const full = new Set(items.map((i) => i));
    for (const t of terminalKnowledgeItems(items).shown) expect(full.has(t)).toBe(true);
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

  it("a houseguest with more than the newest few gets only those in the terminal block, with a note, while GAME CONTEXT lists all", () => {
    const many = { id: "npc:1", name: "Houseguest A", knows: Array.from({ length: 8 }, (_, k) => `fact ${k + 1}`) };
    const hc = renderHardConstraints(pk([many]))!;
    expect(hc).toContain("knows: fact 4; fact 5; fact 6; fact 7; fact 8 (+3 older in GAME CONTEXT above)");
    expect(hc).not.toContain("fact 3");
    const ctx = renderGameContext(pk([many]));
    for (let k = 1; k <= 8; k++) expect(ctx).toContain(`fact ${k}`);
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

  it("dedupeKeepNewest keeps the newest copy and the order", () => {
    expect(dedupeKeepNewest(["a", "b", "a", "c", "b"])).toEqual(["a", "c", "b"]);
  });

  it("a block with nothing to trim is byte-identical to the old rendering", () => {
    const hc = renderHardConstraints(pk([{ id: "npc:1", name: "Houseguest A", knows: ["a", "b"], suspects: ["c"] }]))!;
    expect(hc).toContain("    · Houseguest A — knows: a; b; suspects (a hunch): c");
  });
});
