import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-691 B1-5 (0200): YOUR EDIT weighted house-meeting, scheme and replacement but never emitted them. The season is played by the live loop (the veto, the replacement and the scene log are the real writers, nothing is injected); like the sibling reunion tests the season is run to the crown and only then handed to "a person played it" (the retrospective gate). Roles only. */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: true, save: p.options[0]!.id });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}
function season(seed: number, on: boolean) {
  const s = new GameSessionRegistry().sandboxFor(`orw691-edit-${seed}-${on}`).session as unknown as GameSessionAdapter;
  s.setEditMomentsEnabled(on);
  s.createCharacter({ playerName: "The Player", seed });
  for (let i = 0; i < 4000; i++) { const v = s.advanceGame(); if (v.pending) resolve(s, v.pending); if (v.finished) break; }
  (s as unknown as { live: { playedGame?: boolean } }).live.playedGame = true;
  return s.seasonRetrospective()!.yourEdit!;
}
const kinds = (v: ReturnType<typeof season>): Set<string> => new Set(v.episodes.flatMap((e) => e.moments.map((m) => m.kind)));
describe("ORW-691 B1-5: the edit builds on replacements (and schemes, meetings)", () => {
  for (const seed of [3, 11]) it(`seed ${seed}`, () => {
    const on = season(seed, true), off = season(seed, false);
    const k = kinds(on);
    expect(k.has("replacement")).toBe(true);
    for (const x of ["replacement", "scheme", "house-meeting"]) expect(kinds(off).has(x)).toBe(false);
    expect(JSON.stringify(on)).not.toMatch(/\d\.\d|npc:\d/);
  }, 120_000);
});

describe("ORW-691 B1-5: the cut reads a house meeting (pure; the meeting itself is written only in a person-played game)", () => {
  it("a meeting is a moment for the caller and the accused, and absent without the option", async () => {
    const { buildYourEdit } = await import("../../src/engine/yourEdit");
    const base = { player: "p", cast: ["a", "b"], nameOf: (x: string) => `guest-${x}`, digests: [{ week: 1, hoh: "a", nominees: [], vetoHolder: null, vetoUsed: false, evictee: "b" }], voteRecord: [], calledPawn: () => false, events: [], eventWeeks: [], deals: [], winner: null };
    const withMeeting = buildYourEdit({ ...base, more: { meetings: [{ week: 1, caller: "a", accused: "b", attendees: 6 }] } });
    expect(withMeeting.episodes[0]!.moments.map((m) => m.kind)).toContain("house-meeting");
    expect(buildYourEdit(base).episodes[0]!.moments.map((m) => m.kind)).not.toContain("house-meeting");
  });
});

describe("ORW-1098: an episode keeps at most one moment of each kind, so a week of blow-ups still shows the week's other story beats", () => {
  it("three blow-ups outscore the comp win, the block and the vote, yet the episode shows the blow-up, the comp win and the vote; with the fuller cut off the old top three stand", async () => {
    const { buildYourEdit } = await import("../../src/engine/yourEdit");
    const blow = (i: number) => ({ type: "conflict", initiator: i % 2 ? "a" : "b", witnessSet: ["a", "b", "c", "d", "e", "f", "g", "h"], hidden: false, content: `s${i}` });
    const base = { player: "p", cast: ["a", "b", "c"], nameOf: (x: string) => `guest-${x}`, digests: [{ week: 1, hoh: "a", nominees: ["b", "c"], vetoHolder: "a", vetoUsed: false, evictee: "b" }], voteRecord: [], calledPawn: () => false, events: [blow(0), blow(1), blow(2)], eventWeeks: [1, 1, 1], deals: [], winner: null };
    const on = buildYourEdit({ ...base, more: { meetings: [] } }).episodes[0]!.moments.map((m) => m.kind);
    expect(on).toHaveLength(3);
    expect(new Set(on).size).toBe(3);
    expect(on).toContain("blowup");
    expect(on).toContain("comp-win");
    expect(buildYourEdit(base).episodes[0]!.moments.map((m) => m.kind)).toEqual(["blowup", "blowup", "blowup"]);
  });
});
