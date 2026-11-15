import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// ORW-438: the engine records whether the stored biography is genesis's nameless first draft, so the player-facing card
// can hide it by provenance. The flag is set at the genesis commit and cleared when the writer's biography lands.

describe("ORW-438 biographyDraft provenance", () => {
  const start = () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 7 });
    const npc = (s as unknown as { house: { npcs: { id: string; character: { biography?: string; biographyDraft?: boolean } }[] } }).house.npcs[0]!;
    return { s, npc };
  };

  it("a card the writer has not rewritten carries the flag on the public card; the writer's biography clears it", () => {
    const { s, npc } = start();
    npc.character.biography = "Runs compliance for a regional credit union.";
    npc.character.biographyDraft = true;
    const card = (s as unknown as { castCard: (n: unknown) => { biographyDraft?: boolean } }).castCard(npc);
    expect(card.biographyDraft).toBe(true);
    const res = s.recordCastProfile({ houseguestId: npc.id, biography: "Nia grew up in Converse and later moved to Waco, where the whole family still lives. She sings alto in a church choir." });
    expect(res.accepted).toBe(true);
    expect(npc.character.biographyDraft).toBeUndefined();
    expect((s as unknown as { castCard: (n: unknown) => { biographyDraft?: boolean } }).castCard(npc).biographyDraft).toBeUndefined();
  });

  it("a card with no marker (an older save) never carries the flag", () => {
    const { s, npc } = start();
    expect((s as unknown as { castCard: (n: unknown) => { biographyDraft?: boolean } }).castCard(npc).biographyDraft).toBeUndefined();
  });
});
