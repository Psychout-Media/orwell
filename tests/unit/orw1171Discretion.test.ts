import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { slipOdds, discretionCall, tieScenes } from "../../src/engine/discretion";

/** ORW-1171: a houseguest does not air a private alliance or deal in front of people who are not in on it. The ENGINE decides (open / defer / slip); the narrator's per-turn facts say who is in on what. */
type Priv = {
  live: { playedGame?: boolean; discretionSlips?: Array<{ tie: string; by: string; learnedBy: string[]; day: number; beat: number }> };
  presence: Map<string, string>;
  alliances: { add(n: string, f: string, m: string[], b: number): { id: string; knownTo: string[] }; byId(id: string): { knownTo: string[] } | undefined };
  house: { npcs: Array<{ id: string; name: string }> };
  gameSeed?: number;
  npcKnowledge?: { known(id: string): unknown[]; learn?: unknown };
};
const priv = (s: GameSessionAdapter) => s as unknown as Priv;
let n = 0;
function played(seed = 7): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`orw1171-${n++}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  priv(s).live.playedGame = true;
  (s as unknown as { gatherForCeremony: () => boolean; houseEventInSession: () => undefined }).gatherForCeremony = () => false;
  (s as unknown as { houseEventInSession: () => undefined }).houseEventInSession = () => undefined; // the scene is the test's own: nobody is herded to a ceremony
  return s;
}
const facts = (s: GameSessionAdapter): string => (s.getMomentPrompt({}) as { systemPrompt: string }).systemPrompt.split("\n").filter((l) => l.includes("WHO IS IN ON WHAT") || l.startsWith("    · ") && /in on it|Houseguests in earshot/.test(l)).join("\n");
/** Put the player and the given NPCs (by index) alone in one room. */
function room(s: GameSessionAdapter, idx: number[]): string[] {
  const ids = priv(s).house.npcs.map((x) => x.id);
  for (const id of ids) priv(s).presence.set(id, "bedroom-a");
  priv(s).presence.set("player", "bedroom-b");
  const here = idx.map((i) => ids[i]!);
  for (const id of here) priv(s).presence.set(id, "bedroom-b");
  return here;
}

describe("ORW-1171: the pure discretion rule", () => {
  it("open with nobody outside; defer by default; slip only under the odds", () => {
    const t = { leakiness: 0.1, volatility: 0.1 };
    expect(discretionCall(t, 0, 0)).toBe("open");
    expect(discretionCall(t, 2, 0.99)).toBe("defer");
    expect(discretionCall(t, 2, 0.0001)).toBe("slip");
  });
  it("a leakier or hotter houseguest slips more, and it stays rare and bounded", () => {
    expect(slipOdds({ leakiness: 0.9, volatility: 0.9 })).toBeGreaterThan(slipOdds({ leakiness: 0.1, volatility: 0.1 }));
    expect(slipOdds({ leakiness: 5, volatility: 5 })).toBeLessThanOrEqual(0.2);
    expect(slipOdds({ leakiness: 0.1, volatility: 0.1 })).toBeLessThan(0.05);
  });
  it("marks who in earshot is not in on a tie", () => {
    const sc = tieScenes(["a", "b", "c"], "player", [{ id: "t", kind: "alliance", label: "x", insiders: ["a", "player"] }]);
    expect(sc).toHaveLength(1);
    expect(sc[0]!.speakers).toEqual(["a"]);
    expect(sc[0]!.outsiders).toEqual(["b", "c"]);
  });
});

describe("ORW-1171: the narrator's facts through the session", () => {
  it("with non-members in earshot, the facts name who is in on the alliance and who is not, and the call is DEFER", () => {
    const s = played();
    const [a, b, c] = room(s, [0, 1, 2]) as [string, string, string];
    const al = priv(s).alliances.add("Orchard", a, ["player", a, b], 1);
    void al;
    // a leakiness of nothing: force the roll to miss by seeding a game whose roll is above the odds
    const out = facts(s);
    const name = (id: string) => priv(s).house.npcs.find((x) => x.id === id)!.name;
    expect(out).toContain('the alliance "Orchard"');
    expect(out).toContain(`NOT in on it, and in earshot: ${name(c)}`);
    expect(out).toMatch(/in on it here: [^.]*P/);
    expect(out).toMatch(/DEFER|THE ENGINE MARKED A SLIP/);
  });
  it("everyone in earshot in on it: open, may be raised", () => {
    const s = played();
    const [a, b] = room(s, [0, 1]) as [string, string];
    priv(s).alliances.add("Orchard", a, ["player", a, b], 1);
    const out = facts(s);
    expect(out).toContain("everyone in earshot is in on it");
    expect(out).not.toMatch(/DEFER:|MARKED A SLIP/);
  });
  it("two or more houseguests in earshot: a pitch made aloud is deferred, never answered in the open", () => {
    const s = played();
    room(s, [0, 1]);
    expect(facts(s)).toMatch(/pitches an alliance or a deal[^\n]*defer the real answer or ask to talk alone/);
  });
  it("one houseguest alone with the player: no discretion block at all", () => {
    const s = played();
    room(s, [0]);
    expect(facts(s)).toBe("");
  });
});

describe("ORW-1171: a seeded slip is an engine event that gives non-members the knowledge", () => {
  it("across seeds some (rare) slips happen; each records who learned it, the alliance becomes known to them, and the beat repeats the same call", () => {
    let slips = 0, total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = played(seed);
      const [a, b, c] = room(s, [0, 1, 2]) as [string, string, string];
      const al = priv(s).alliances.add("Orchard", a, ["player", a, b], 1);
      total++;
      const first = facts(s);
      const rec = priv(s).live.discretionSlips ?? [];
      if (/MARKED A SLIP/.test(first)) {
        slips++;
        expect(rec).toHaveLength(1);
        expect(rec[0]!.learnedBy).toContain(c);
        expect(priv(s).alliances.byId(al.id)!.knownTo).toContain(c); // the outsider genuinely learns it
        expect(facts(s)).toMatch(/MARKED A SLIP/); // a rebuilt prompt in the same beat: same call, no second record
        expect(priv(s).live.discretionSlips).toHaveLength(1);
      } else {
        expect(rec).toHaveLength(0);
        expect(first).toMatch(/DEFER/);
        expect(priv(s).alliances.byId(al.id)!.knownTo).not.toContain(c);
      }
    }
    expect(slips).toBeGreaterThan(0);
    expect(slips).toBeLessThan(total / 2);
  });
});

describe("ORW-1171: a standing deal the player is in", () => {
  it("is deferred in front of a houseguest who is not in on it, and the learn sink is only called on a slip", () => {
    const s = played();
    const [a, , c] = room(s, [0, 1, 2]) as [string, string, string];
    const learned: Array<[string, string]> = [];
    priv(s).npcKnowledge = { ...priv(s).npcKnowledge!, learn: (id: string, f: { content: string }) => learned.push([id, f.content]) } as never;
    (s as unknown as { deals: { make(p: [string, string], k: string, t: string): unknown } }).deals.make(["player", a], "safety", "keep each other safe this week");
    const out = facts(s);
    const name = (id: string) => priv(s).house.npcs.find((x) => x.id === id)!.name;
    expect(out).toContain("the safety deal");
    expect(out).toContain(name(c));
    if (/MARKED A SLIP/.test(out)) expect(learned.some(([id]) => id === c)).toBe(true);
    else { expect(out).toMatch(/DEFER:/); expect(learned).toHaveLength(0); }
  });
});
