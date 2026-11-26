import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { playUntil, type Stop } from "./playedSeason";

/**
 * ORW-792 (leftover of ORW-777): the orchestrator's vault-leak checkpoint matches by TEXT, so a hidden event whose text is identical to (or contained in) a line the player can see, and which the player does not hold through a told,
 * overheard, gossip or surfaced pathway, refuses every later turn of a live game (ORW-777 reworded two engine lines for exactly this). The checkpoint stays strict. This is the structural early warning: through full played seasons
 * (the real orchestrator committing each turn) it lists every hidden line against the visible lines and fails with BOTH named, so a new twin fails here, pointing at the two engine lines, instead of freezing a live game.
 * Reads only; nothing is set by hand. Roles only.
 */
type Ev = { id: string; hidden: boolean; witnessSet: readonly string[]; content: string };
const CHECK_EVERY = 60;

function twins(s: Stop): string[] {
  const events = s.engine.events.queryAll() as ReadonlyArray<Ev>;
  const seen = events.filter((e) => !e.hidden && e.witnessSet.includes(PLAYER) && e.content.trim().length > 0);
  const hidden = events.filter((e) => e.hidden && e.content.trim().length > 0);
  const facts = s.engine.knowledge.knownTo(PLAYER).filter((f) => /^(told-by:|overheard:|gossip|surfaced)/.test(String(f.pathway))).map((f) => f.content);
  const out: string[] = [];
  for (const h of hidden) {
    if (facts.some((f) => f.includes(h.content))) continue; // sanctioned by a real pathway
    const twin = seen.find((v) => v.content.includes(h.content));
    if (twin) out.push(`hidden ${h.id} is a twin of visible ${twin.id}: ${JSON.stringify(h.content.slice(0, 80))}`);
  }
  return out;
}

describe("the sweep itself catches a twin (so a clean season means something)", () => {
  const stop = (events: Ev[], facts: string[] = []): Stop => ({ engine: { events: { queryAll: () => events }, knowledge: { knownTo: () => facts.map((content) => ({ content, pathway: "told-by:npc:1" })) } } } as unknown as Stop);
  const line = "Role Alpha and Role Bravo are in a tense exchange.";
  const hidden: Ev = { id: "h1", hidden: true, witnessSet: ["npc:1", "npc:2"], content: line };
  const seen: Ev = { id: "v1", hidden: false, witnessSet: [PLAYER], content: line };
  it("names both lines of a hidden/visible twin", () => { expect(twins(stop([hidden, seen]))).toEqual([expect.stringContaining("h1")]); });
  it("does not flag a hidden line the player holds through a real pathway, or one with no visible twin", () => {
    expect(twins(stop([hidden, seen], [line]))).toEqual([]);
    expect(twins(stop([hidden, { ...seen, content: "Something else entirely." }]))).toEqual([]);
  });
});

describe("no hidden engine line is a verbatim twin of a line the player sees (played)", () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`seed ${seed}: every checked commit of the season has no unsanctioned hidden/visible twin`, async () => {
      const found = new Set<string>();
      let checks = 0;
      try {
        await playUntil(seed, (s: Stop) => {
          if (s.msg % CHECK_EVERY === 0) { checks++; for (const t of twins(s)) found.add(t); }
          return false;
        }, { user: `wf-${seed}` });
      } catch { /* the season ran to its end: playUntil reports "never reached the stop" */ }
      expect(checks, "the season was checked along the way").toBeGreaterThan(3);
      expect([...found], "a hidden line has a visible twin: reword one of the two engine lines (ORW-777)").toEqual([]);
    }, 900_000);
  }
});
