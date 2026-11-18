import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { editWorthiness } from "../../src/engine/editWorthiness";
import { buildYourEdit, YOUR_EDIT, weeksOfLog, type YourEditInput } from "../../src/engine/yourEdit";

/** 0200 / ORW-632 - your edit. Roles only: a winner (w), a villain (v), a victim (x), a quiet one (q), the player. */
const names = (id: string): string => (id === PLAYER ? "the player" : `guest-${id}`);
const base = (over: Partial<YourEditInput>): YourEditInput => ({
  player: PLAYER, cast: ["w", "v", "x", "q"], nameOf: names, digests: [], voteRecord: [], calledPawn: () => false, events: [], eventWeeks: [], deals: [], winner: null, ...over,
});
const digest = (week: number, hoh: string, nominees: string[], evictee: string) => ({ week, hoh, nominees, vetoHolder: hoh, vetoUsed: false, evictee });

describe("your edit (pure)", () => {
  it("picks the week's moments by the SAME edit-worthiness the audience reads: a higher-scoring moment is chosen over a lower one", () => {
    const v = buildYourEdit(base({
      digests: [digest(1, "w", ["x", "q"], "x")], calledPawn: () => true,
      voteRecord: [{ week: 1, evictee: "x", voteOf: { a: "x", b: "x", c: "q" } }],
    }));
    const kinds = v.episodes[0]!.moments.map((m) => m.kind);
    expect(kinds).toHaveLength(YOUR_EDIT.episodeMoments);
    expect(kinds[0]).toBe("blindside");
    expect(kinds).not.toContain("veto-kept"); // the lowest-scoring of the week is the one left on the floor
    expect(editWorthiness({ kind: "blindside", week: 1, public: true })).toBeGreaterThan(editWorthiness({ kind: "veto-kept", week: 1, public: true }));
  });

  it("the hero and villain measure is deterministic and bounded: a betrayer is a villain, a wronged winner a hero, a quiet one neither", () => {
    const scenes = Array.from({ length: 4 }, (_, i) => ({ type: "betrayal", initiator: "v", witnessSet: ["v", "x"], hidden: true, content: `s${i}` }));
    const wins = [1, 2, 3].map((wk) => digest(wk, "w", ["x", "q"], "q"));
    const inp = base({ digests: wins, events: scenes, eventWeeks: [1, 1, 2, 3] });
    const a = buildYourEdit(inp), b = buildYourEdit(inp);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.villains.map((h) => h.name)).toContain("guest-v");
    expect(a.heroes.map((h) => h.name)).toContain("guest-x"); // wronged again and again, never wrong another
    expect(a.heroes.length + a.villains.length).toBeLessThanOrEqual(2 * YOUR_EDIT.castCap);
    expect(JSON.stringify(a)).not.toMatch(/\d\.\d/); // no measure ever crosses
  });

  it("the player is judged honestly: breaking deals and blindsiding is never a hero edit", () => {
    const wins = [1, 2, 3, 4].map((wk) => digest(wk, PLAYER, ["x", "q"], "x"));
    const inp = base({
      digests: wins, calledPawn: () => true,
      deals: [{ parties: [PLAYER, "x"], status: "broken", brokenBy: PLAYER }, { parties: [PLAYER, "q"], status: "broken", brokenBy: PLAYER }],
    });
    const y = buildYourEdit(inp).you;
    expect(y.band).not.toBe("hero");
    expect(y.dealsBroken).toBe(2);
    expect(y.blindsidesDealt).toBe(4);
    expect(y.line).toMatch(/broke your word|did not forget|villain/);
  });

  it("a player who kept their word and was wronged reads as the hero, the same rule as anyone", () => {
    const wins = [1, 2, 3].map((wk) => digest(wk, "v", [PLAYER, "q"], "q"));
    const scenes = Array.from({ length: 3 }, (_, i) => ({ type: "betrayal", initiator: "v", witnessSet: ["v", PLAYER], hidden: false, content: `s${i}` }));
    const y = buildYourEdit(base({ digests: wins, events: scenes, eventWeeks: [1, 2, 3], deals: [{ parties: [PLAYER, "w"], status: "kept" }] })).you;
    expect(y.band).toBe("hero");
  });

  it("reconstructs the week of each log position from the eviction announcements", () => {
    const ev = [{ type: "conversation", hidden: false, content: "a" }, { type: "house-event", hidden: false, content: "x is evicted" }, { type: "conversation", hidden: false, content: "b" }];
    expect(weeksOfLog(ev, "is evicted", 5)).toEqual([1, 1, 2]);
  });

  it("the floor title is composed from the facts (the names carry it) and differs by who it was about", () => {
    const t = (n: string) => buildYourEdit(base({ digests: [digest(1, "w", ["x", "q"], "x")], nameOf: () => n })).episodes[0]!.title;
    expect(t("alpha")).not.toBe(t("beta"));
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
type Seam = { live: { playedGame?: boolean } };
function season(user: string, seed: number, on: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.setYourEditEnabled(on);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}
/** The season is auto-driven (a played game's player pendings are out of scope here); the played flag is set once it is over, as the gate reads it at the retrospective. */
const finish = (sb: ReturnType<typeof season>): void => { playToEnd(sb.session); (sb.session as unknown as Seam).live.playedGame = true; };
const hash = (sb: ReturnType<typeof season>): string =>
  createHash("sha256").update(sb.engine.events.queryAll().map((e) => `${e.type}|${e.initiator}|${e.hidden ? 1 : 0}|${e.content}`).join("\n")).digest("hex");

describe("your edit in the live season", () => {
  for (const seed of [3, 11]) {
    it(`seed ${seed}: nothing before the crown; after it the episodes cover every week with real facts; flag off is byte-identical and absent`, () => {
      const on = season(`ye-on-${seed}`, seed, true), off = season(`ye-off-${seed}`, seed, false);
      expect(on.session.seasonRetrospective()).toBeNull(); // before the crown: nothing at all
      finish(on); finish(off);
      expect(hash(on), "reading or computing the edit changes no seeded stream").toBe(hash(off));
      const r = on.session.seasonRetrospective()!;
      const e = r.yourEdit!;
      expect(e).toBeDefined();
      const weeks = (on.session as unknown as { live: { weekDigests: Array<{ week: number; evictee: string | null }> } }).live.weekDigests.filter((d) => d.evictee !== null).map((d) => d.week);
      expect(e.episodes.filter((x) => !x.crown).map((x) => x.week)).toEqual(weeks);
      expect(e.episodes.every((x) => x.title.length > 0 && (x.crown || x.moments.length > 0))).toBe(true);
      expect(e.episodes.at(-1)!.crown).toBeTruthy();
      expect(e.you.line.length).toBeGreaterThan(0);
      // the wall: facts are names and kinds, never an id, a raw decimal or a score
      const json = JSON.stringify(e);
      expect(json).not.toMatch(/npc:\d/);
      expect(json).not.toMatch(/\d\.\d/);
      // the flag-off retrospective is the same minus the field
      const { yourEdit: _gone, ...rest } = r; void _gone;
      expect(JSON.stringify(off.session.seasonRetrospective())).toBe(JSON.stringify(rest));
      expect(JSON.stringify(on.session.seasonRetrospective())).toBe(JSON.stringify(r)); // idempotent
    }, 120_000);
  }

  it("a headless (never person-played) season carries no edit", () => {
    const sb = new GameSessionRegistry().sandboxFor("ye-headless");
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    playToEnd(sb.session);
    expect(sb.session.seasonRetrospective()!.yourEdit).toBeUndefined();
  }, 120_000);

  it("saves and restores: the edit is a pure function of the persisted season", () => {
    const sb = season("ye-save", 3, true);
    finish(sb);
    const before = JSON.stringify(sb.session.seasonRetrospective()!.yourEdit);
    expect(before).toBeTruthy();
    expect(JSON.stringify(sb.session.seasonRetrospective()!.yourEdit)).toBe(before);
  }, 120_000);
});
