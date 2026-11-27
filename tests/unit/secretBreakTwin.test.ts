import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";
import type { EntityId } from "../../src/domain/ids";
import type { KnowledgeService } from "../../src/ports/KnowledgeService";

/**
 * A secret break's line is public words composed from the held fact. Two records with the same words about the same houseguest used to break twice; when the player missed one of them, the hidden line was a verbatim
 * twin of a shown line and the vault-leak checkpoint refused every later turn of the game. Roles only.
 */
describe("the same words about the same houseguest come out once", () => {
  it("two records with identical words stage one break between them, over many nights", () => {
    const g = playedGame({ seed: 3 });
    for (let i = 0; i < 6; i++) g.turn();
    const x = g.s as unknown as { house: { npcs: { id: EntityId; name?: string }[] }; live: { secretBreakDay?: number; dayNumber?: number; secretBreaks?: string[] }; awakeNow: () => null; secretBreakTick(k: KnowledgeService): void };
    const subject = x.house.npcs[0]!.id;
    const words = "there is something this houseguest is not telling anyone";
    const knowledge = {
      knownTo: (h: EntityId) => (h === subject ? [] : ["twin-a", "twin-b"].map((factId) => ({ id: factId, factId, subject, content: words, confidence: 0.9 }))),
      seedBelief: () => undefined,
    } as unknown as KnowledgeService;
    x.awakeNow = () => null;
    const count = (): number => g.sb.engine.events.queryAll().filter((e) => e.type === "secret-break" && e.content.endsWith(words)).length;
    const start = x.live.dayNumber ?? 1;
    for (let night = 0; night < 60; night++) { x.live.dayNumber = start + night; x.live.secretBreakDay = undefined; x.secretBreakTick(knowledge); }
    expect(count(), "it did come out").toBe(1);
    expect(x.live.secretBreaks).toEqual(expect.arrayContaining(["twin-a", "twin-b"]));
  });
});
