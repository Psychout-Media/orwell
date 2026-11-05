import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { DealView } from "../../src/ports/GameSession";

// Roles only. Exercises the LIVE wiring of deals into the session adapter (0039): make → view →
// witnessed-event record → persistence. The kept/broken adjudication math is covered by deals.test.ts.
function newGame(seed = 7) {
  const s = new GameSessionAdapter();
  const events: Array<{ content: string; witnessSet: string[]; type?: string }> = [];
  let persists = 0;
  s.setOnPlayerEvent((content, witnessSet, type) => {
    events.push({ content, witnessSet, type });
    return `evt:${events.length}`;
  });
  s.setOnPersist(() => { persists++; });
  s.createCharacter({ playerName: "The Player", seed });
  s.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
  const npc = s.getGameState().house[0]!.id;
  return { s, events, npc, persists: () => persists };
}

describe("0039 — deals wired into the live session", () => {
  it("makeDeal creates a tracked OPEN deal the player can see (fact + status, no numbers)", () => {
    const { s, npc } = newGame();
    const view = s.makeDeal({ with: npc, kind: "safety", terms: "I won't put you up" }) as DealView | null;
    expect(view).not.toBeNull();
    expect(view!.status).toBe("open");
    expect(view!.kind).toBe("safety");
    expect(view!.parties.map((p) => p.id).sort()).toEqual(["player", npc].sort());

    const deals = s.getGameState().deals ?? [];
    expect(deals).toHaveLength(1);
    expect(deals[0]!.terms).toBe("I won't put you up");
    // Vault Wall: the player-facing deal carries NO opinion numbers.
    const blob = JSON.stringify(deals);
    for (const banned of ["trust", "threat", "affinity", "confidence", "alignment"]) {
      expect(blob.includes(banned)).toBe(false);
    }
  });

  it("records the made deal as a player-WITNESSED event (their knowledge, never the Vault)", () => {
    const { s, events, npc } = newGame();
    s.makeDeal({ with: npc, kind: "final-two", terms: "ride or die" });
    expect(events).toHaveLength(1);
    expect(events[0]!.witnessSet).toContain("player");
    expect(events[0]!.witnessSet).toContain(npc);
  });

  it("rejects an illegal partner (self or a non-houseguest) without throwing", () => {
    const { s } = newGame();
    expect(s.makeDeal({ with: "player", kind: "safety", terms: "" })).toBeNull();
    expect(s.makeDeal({ with: "nobody-here", kind: "safety", terms: "" })).toBeNull();
  });

  it("deals survive a snapshot → restore round-trip (persistence, 0030)", () => {
    const { s, npc } = newGame();
    s.makeDeal({ with: npc, kind: "vote", terms: "I keep you safe" });
    const snap = s.snapshot();
    expect(snap.deals).toHaveLength(1);

    const revived = new GameSessionAdapter();
    revived.restore(snap);
    const deals = revived.getGameState().deals ?? [];
    expect(deals).toHaveLength(1);
    expect(deals[0]!.kind).toBe("vote");
    expect(deals[0]!.status).toBe("open");
  });

  it("making a deal persists (save-on-mutation)", () => {
    const { s, npc, persists } = newGame();
    const before = persists();
    s.makeDeal({ with: npc, kind: "safety", terms: "safe" });
    expect(persists()).toBeGreaterThan(before);
  });
});
