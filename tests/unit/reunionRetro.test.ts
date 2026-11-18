import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { buildReunion, buildYourStories, type StoryGuest } from "../../src/engine/reunionRetro";
import { REUNION } from "../../src/engine/reunion";

/** 0211 / ORW-649 + ORW-648 - the reunion and the story of you and them. Roles only. */
const names = (id: string): string => (id === PLAYER ? "the player" : `guest-${id}`);

describe("the reunion (pure)", () => {
  const input = (finished: boolean) => ({
    finished, nameOf: names,
    grudges: [{ holder: "a", at: PLAYER, size: 0.6, kind: "blindsided" }, { holder: "b", at: "c", size: 0.1, kind: "lied-to" }, { holder: "c", at: "d", size: 0.5, kind: "deal-broken" }],
    claims: [
      { id: "claim:1", speaker: PLAYER, listener: "a", isTrue: false, caught: false, week: 2, said: "that x was going after y" },
      { id: "claim:2", speaker: "b", listener: "c", isTrue: false, caught: true, week: 3, said: "that z" },
      { id: "claim:3", speaker: "b", listener: PLAYER, isTrue: true, caught: false, week: 3, said: "that w" },
    ],
    groups: [{ id: "g1", members: ["b", "c"], hiddenFrom: [PLAYER], weeks: 4, name: "the pair", fromWeek: 2 }, { id: "g2", members: ["a", "d"], hiddenFrom: [], weeks: 9, fromWeek: 1 }],
  });
  it("is nothing before the crown", () => { expect(buildReunion(input(false))).toBeUndefined(); });
  it("after the crown airs the grudges, the uncaught lies and the hidden alliances, the player in either seat, bounded", () => {
    const r = buildReunion(input(true))!;
    const kinds = r.threads.map((t) => t.kind);
    expect(kinds).toEqual(["confrontation", "confrontation", "lie", "alliance"]);
    expect(r.threads.filter((t) => t.kind === "confrontation").length).toBeLessThanOrEqual(REUNION.maxConfrontations);
    const first = r.threads[0]!;
    expect(first.kind === "confrontation" && first.youAreIn).toBe(true);
    const lie = r.threads.find((t) => t.kind === "lie")!;
    expect(lie.kind === "lie" && lie.youAre).toBe("speaker"); // the player's own lie comes out too
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/\d\.\d|claim:|"size"|"id"/);
  });
  it("is deterministic", () => { expect(JSON.stringify(buildReunion(input(true)))).toBe(JSON.stringify(buildReunion(input(true)))); });
});

describe("the story of you and them (pure)", () => {
  const pts = (...w: number[]) => w.map((x, i) => ({ week: i + 1, trust: x / 2, affinity: x / 2 }));
  const guests: StoryGuest[] = [
    { id: "b", points: pts(0.1, 0.1, 0.9), scenes: [{ week: 3, kind: "conversation" }, { week: 1, kind: "alliance" }], evictedWeek: 5, votedFor: PLAYER },
    { id: "a", points: pts(0.5, 0.5), scenes: [], finalist: true },
  ];
  it("is nothing before the crown", () => { expect(buildYourStories({ finished: false, nameOf: names, winner: PLAYER, guests })).toBeUndefined(); });
  it("follows how the view really moved, with the turning week joined to that week's scenes and the ending", () => {
    const v = buildYourStories({ finished: true, nameOf: names, winner: PLAYER, guests })!;
    expect(v.stories.map((s) => s.name)).toEqual(["guest-a", "guest-b"]); // deterministic name order
    const b = v.stories[1]!;
    expect(b.shape).toBe("warmed");
    expect(b.met).toEqual({ week: 1, kind: "alliance" });
    expect(b.turns[0]).toEqual({ week: 3, direction: "warmer", scenes: ["conversation"] });
    expect(b.ended).toEqual({ how: "evicted", week: 5, juror: { votedFor: "you" } });
    expect(v.stories[0]!.shape).toBe("steady");
    expect(v.stories[0]!.ended.how).toBe("runner-up");
    expect(JSON.stringify(v)).not.toMatch(/\d\.\d|"trust"|"affinity"/);
  });
  it("a turned view is named turned, and the turns are bounded", () => {
    const v = buildYourStories({ finished: true, nameOf: names, winner: null, guests: [{ id: "t", points: pts(-0.6, 0.4, -0.5, 0.5, -0.4, 0.6, 0.8), scenes: [] }] })!;
    expect(v.stories[0]!.shape).toBe("turned");
    expect(v.stories[0]!.turns.length).toBeLessThanOrEqual(REUNION.maxTurningPoints);
  });
});

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}
function playToEnd(s: GameSessionAdapter): void {
  for (let i = 0; i < 4000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending);
    if (v.finished) return;
  }
  throw new Error("the season did not finish");
}
type Seam = { live: { playedGame?: boolean; viewOfPlayer?: Record<string, unknown[]> }; yourStoryTick(): void };
function season(user: string, seed: number, on: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.setReunionEnabled(on); sb.session.setYourStoryEnabled(on);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}
const finish = (sb: ReturnType<typeof season>): void => { playToEnd(sb.session); (sb.session as unknown as Seam).live.playedGame = true; };
const hash = (sb: ReturnType<typeof season>): string =>
  createHash("sha256").update(sb.engine.events.queryAll().map((e) => `${e.type}|${e.initiator}|${e.hidden ? 1 : 0}|${e.content}`).join("\n")).digest("hex");

describe("the reunion and the stories in the live season", () => {
  for (const seed of [3, 11]) {
    it(`seed ${seed}: nothing before the crown; after it a story for each houseguest; reading changes no seeded stream; flag off is absent`, () => {
      const on = season(`ru-on-${seed}`, seed, true), off = season(`ru-off-${seed}`, seed, false);
      expect(on.session.seasonRetrospective()).toBeNull();
      expect(JSON.stringify(on.session.getGameState())).not.toMatch(/yourStories|reunion|viewOfPlayer/);
      finish(on); finish(off);
      expect(hash(on)).toBe(hash(off));
      const r = on.session.seasonRetrospective()!;
      expect(r.yourStories!.stories.length).toBeGreaterThan(5);
      expect(r.yourStories!.stories.every((s) => s.line.length > 0)).toBe(true);
      const json = JSON.stringify({ a: r.reunion, b: r.yourStories });
      expect(json).not.toMatch(/npc:\d/);
      expect(json).not.toMatch(/\d\.\d/);
      expect(JSON.stringify(on.session.seasonRetrospective())).toBe(JSON.stringify(r));
      const o = off.session.seasonRetrospective()!;
      expect(o.reunion).toBeUndefined();
      expect(o.yourStories).toBeUndefined();
    }, 120_000);
  }

  it("a headless (never person-played) season carries neither", () => {
    const sb = new GameSessionRegistry().sandboxFor("ru-headless");
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    playToEnd(sb.session);
    const r = sb.session.seasonRetrospective()!;
    expect(r.reunion).toBeUndefined();
    expect(r.yourStories).toBeUndefined();
    expect((sb.session as unknown as Seam).live.viewOfPlayer).toBeUndefined(); // and no sample was ever taken
  }, 120_000);

  it("the weekly sample: one per houseguest per week (the week's latest), created only for a played game, never an edge", () => {
    const sb = new GameSessionRegistry().sandboxFor("ru-tick");
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    const g = sb.session as unknown as Seam;
    g.yourStoryTick();
    expect(g.live.viewOfPlayer).toBeUndefined(); // not a played game yet
    g.live.playedGame = true;
    g.yourStoryTick(); g.yourStoryTick();
    const rows = Object.values(g.live.viewOfPlayer!);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.length === 1)).toBe(true);
  });
});
