import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildShowBrief, cleanLastShown, estimateBriefTokens, parseSeenState } from "../../src/engine/showBrief";
import type { GameStateView, HouseguestCard, ShowBriefReq, WhereaboutsView } from "../../src/ports/GameSession";

/**
 * The Show Brief v1 skeleton (Showrunner memory Part A; K6 §3): fixed section order, golden-pinned text, Vault-free by
 * construction, built only from the player-visible view plus the FE's re-validated echoes. Roles only: every
 * houseguest here is "NPC A".."NPC O"; the player is "The Player".
 */

const GOLDEN_DIR = join("tests", "fixtures", "showBrief");
const UPDATE = process.env.UPDATE_SHOW_BRIEF_GOLDEN === "1";
function golden(name: string, text: string): void {
  const file = join(GOLDEN_DIR, `${name}.txt`);
  if (UPDATE) {
    if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, text);
  }
  expect(text, `golden ${file} (set UPDATE_SHOW_BRIEF_GOLDEN=1 to regenerate deliberately)`).toBe(readFileSync(file, "utf8"));
}

const LETTERS = "ABCDEFGHIJKLMNO";
const id = (i: number) => `npc:${i + 1}`;
const nm = (i: number) => `NPC ${LETTERS[i]}`;
const ref = (i: number) => ({ id: id(i), name: nm(i) });
const house = (over: Record<number, Partial<HouseguestCard>> = {}): HouseguestCard[] =>
  Array.from({ length: 15 }, (_, i) => ({ id: id(i), name: nm(i), status: "active", ...over[i] }) as HouseguestCard);

function view(wa: Partial<WhereaboutsView> & { room: string }, extra: Partial<GameStateView> = {}): GameStateView {
  return {
    started: true,
    beatSeq: 312,
    player: { id: "player", name: "The Player" },
    house: house(),
    clockLabel: "10:25am, Day 1",
    whereabouts: { present: [], nearby: [], turnsHere: 0, companions: [], tracked: [], ...wa },
    ...extra,
  } as unknown as GameStateView;
}

/** The player in the living room with A (3 turns) and B (just arrived); the open core in view; F tracked behind a door. */
const livingRoom = (): GameStateView => view({
  room: "living-room",
  turnsHere: 2,
  present: [ref(1), ref(0)],
  companions: [{ ...ref(0), turnsHere: 3 }, { ...ref(1), turnsHere: 0 }],
  nearby: [
    { room: "kitchen", present: [ref(2), ref(3)] },
    { room: "dining-room", present: [] },
    { room: "backyard", present: [ref(4)] },
    { room: "hallway", present: [] },
  ],
  tracked: [{ ...ref(5), room: "bathroom", sinceTurns: 5, stale: true, pathway: "witnessed", confidence: 0.5 }],
});

describe("buildShowBrief: golden text (fixed order, engine truth, explicit absences)", () => {
  it("the first brief of a conversation: NOW with HERE, in view, NOT HERE, not in view; CHANGED unknown; this room", () => {
    const b = buildShowBrief(livingRoom(), {
      askedAbout: [id(5), id(6), id(0), "player", "npc:99"],
      lastShown: '@[NPC A] — "Say one more word." ((that was a joke)) NPC B laughs and heads for the door.',
    })!;
    golden("first-brief", b.text);
    expect(b.sections.map((s) => s.id)).toEqual(["header", "now", "changed", "established"]);
  });

  it("changed since the last brief: arrivals, departures, moves within view, in and out of view, the clock", () => {
    const first = buildShowBrief(livingRoom())!;
    const later = view({
      room: "living-room",
      turnsHere: 3,
      present: [ref(1), ref(7)],                              // A left, H walked in
      companions: [{ ...ref(1), turnsHere: 1 }, { ...ref(7), turnsHere: 0 }],
      nearby: [
        { room: "kitchen", present: [ref(0), ref(2)] },       // A is now in the kitchen; D left the kitchen
        { room: "dining-room", present: [ref(4), ref(8)] },   // E moved from the yard; I is newly in view
        { room: "backyard", present: [] },
        { room: "hallway", present: [] },
      ],
    }, { clockLabel: "10:30am, Day 1", beatSeq: 318 });
    const b = buildShowBrief(later, { seen: first.seen })!;
    golden("changed-since-last-turn", b.text);
  });

  it("the player moved into a closed room: nothing in view, everyone else out of view", () => {
    const first = buildShowBrief(livingRoom())!;
    const b = buildShowBrief(view({ room: "bedroom-a", turnsHere: 0 }), { seen: first.seen })!;
    golden("moved-into-closed-room", b.text);
  });

  it("a whole-house event: gathered, no tenure, no side rooms", () => {
    const all = Array.from({ length: 15 }, (_, i) => ref(i));
    const b = buildShowBrief(view({
      room: "living-room", turnsHere: 4, present: all, companions: all.map((r) => ({ ...r, turnsHere: 0 })),
      houseEvent: { kind: "nominations" },
    }))!;
    golden("whole-house-event", b.text);
  });

  it("late night: who turned in, an evicted houseguest asked about, a stale-free sighting", () => {
    const v = view({
      room: "kitchen", turnsHere: 1, present: [ref(0)], companions: [{ ...ref(0), turnsHere: 6 }],
      nearby: [{ room: "living-room", present: [] }, { room: "dining-room", present: [] }, { room: "backyard", present: [] }],
      tracked: [{ ...ref(2), room: "lounge", sinceTurns: 0, stale: false, pathway: "witnessed", confidence: 0.9 }],
    }, { house: house({ 9: { status: "evicted" } }), asleep: [ref(3), ref(4)], clockLabel: "1:10am, Day 2" });
    const b = buildShowBrief(v, { askedAbout: [id(3), id(9), id(2)] })!;
    golden("late-night", b.text);
  });

  it("the diary room: its own fixtures, nothing loose", () => {
    const b = buildShowBrief(view({ room: "diary-room", turnsHere: 0 }), { lastShown: "((ooc only))" })!;
    golden("diary-room", b.text);
  });
});

describe("buildShowBrief: invariants", () => {
  it("is deterministic and orders people by id, whatever order the view lists them in", () => {
    const a = buildShowBrief(livingRoom())!.text;
    const shuffled = livingRoom();
    (shuffled.whereabouts as WhereaboutsView).present.reverse();
    (shuffled.whereabouts as WhereaboutsView).nearby.reverse();
    expect(buildShowBrief(shuffled)!.text).toBe(a);
    expect(buildShowBrief(livingRoom())!.text).toBe(a);
  });

  it("returns nothing when there is nothing to brief", () => {
    expect(buildShowBrief({ ...livingRoom(), started: false })).toBeUndefined();
    expect(buildShowBrief({ ...livingRoom(), player: null })).toBeUndefined();
    expect(buildShowBrief({ ...livingRoom(), whereabouts: null })).toBeUndefined();
    expect(buildShowBrief(view({ room: "cellar" }))).toBeUndefined();
  });

  it("returns the seen state to echo next turn: player-visible ids only, sorted", () => {
    const b = buildShowBrief(livingRoom())!;
    expect(b.seen).toEqual({
      v: 1, beatSeq: 312, clock: "10:25am, Day 1", room: "living-room", here: ["npc:1", "npc:2"],
      inView: [
        { room: "kitchen", ids: ["npc:3", "npc:4"] }, { room: "dining-room", ids: [] },
        { room: "backyard", ids: ["npc:5"] }, { room: "hallway", ids: [] },
      ],
    });
    expect(JSON.stringify(b.seen)).not.toContain("npc:6"); // a tracked sighting is not "seen" state
  });

  it("a malformed echo is ignored (treated as the first brief), never trusted", () => {
    const known = new Set(house().map((h) => h.id));
    const good = buildShowBrief(livingRoom())!.seen;
    expect(parseSeenState(good, known)).toEqual(good);
    for (const bad of [null, 3, "x", { ...good, v: 2 }, { ...good, room: "cellar" }, { ...good, here: ["npc:99"] },
      { ...good, here: "npc:1" }, { ...good, inView: [{ room: "attic", ids: [] }] }, { ...good, inView: [{ room: "kitchen", ids: ["x"] }] },
      { ...good, inView: "kitchen" }, { ...good, beatSeq: "1" }]) {
      expect(parseSeenState(bad, known), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parseSeenState({ ...good, clock: "x".repeat(41) }, known)?.clock).toBeUndefined();
    const b = buildShowBrief(livingRoom(), { seen: { ...good, here: ["npc:99"] } as never })!;
    expect(b.text).toContain("Unknown: this is the first brief of this conversation.");
  });

  it("names come from the engine roster only: echoed ids that are not houseguests are dropped", () => {
    const b = buildShowBrief(livingRoom(), { askedAbout: ["npc:99", "player", 7 as never] })!;
    expect(b.text).not.toMatch(/npc:\d|someone/);
  });

  it("the quoted tail drops out-of-character asides, is one line, and is capped", () => {
    expect(cleanLastShown("Before ((an aside)) after.\nNext line.")).toBe("Before after. Next line.");
    expect(cleanLastShown("((only an aside))")).toBeUndefined();
    expect(cleanLastShown(42)).toBeUndefined();
    expect(cleanLastShown("x".repeat(500))!.length).toBe(320);
  });

  it("stays small: a full house is well under 1K tokens", () => {
    const all = Array.from({ length: 15 }, (_, i) => ref(i));
    const busy = view({
      room: "kitchen", turnsHere: 2, present: all.slice(0, 5), companions: all.slice(0, 5).map((r) => ({ ...r, turnsHere: 2 })),
      nearby: [{ room: "living-room", present: all.slice(5, 10) }, { room: "dining-room", present: all.slice(10, 13) }, { room: "backyard", present: [] }],
    });
    const b = buildShowBrief(busy, { askedAbout: [id(13), id(14)], lastShown: "word ".repeat(80) })!;
    expect(b.tokens).toBe(estimateBriefTokens(b.text));
    expect(b.tokens).toBeLessThan(1000);
    expect(b.sections.reduce((n, s) => n + s.tokens, 0)).toBeGreaterThanOrEqual(b.tokens - 4);
  });

  it("caps a long name list with a count", () => {
    const all = Array.from({ length: 15 }, (_, i) => ref(i));
    const b = buildShowBrief(view({ room: "lounge" }, { house: house() }), { seen: { v: 1, beatSeq: 1, room: "lounge", here: all.map((r) => r.id), inView: [] } })!;
    expect(b.text).toMatch(/- No longer with you: NPC A \(out of view\), .* and 7 more\./);
    const changeLine = b.text.split("\n").find((l) => l.startsWith("- No longer with you"))!;
    expect(changeLine).toMatch(/and \d+ more\.$/);
    // A STANDING line is never truncated: every houseguest out of view is named.
    const outOfView = b.text.split("\n").find((l) => l.startsWith("Not in view"))!;
    expect(outOfView).not.toMatch(/more\.$/);
  });

  it("says plainly when nothing visible changed", () => {
    const first = buildShowBrief(livingRoom())!;
    expect(buildShowBrief(livingRoom(), { seen: first.seen })!.text).toContain("Nothing you could see has changed.");
  });
});

describe("ORW-311: the house-is-quieting-down cue (public turned-in count only)", () => {
  const asleepN = (n: number) => Array.from({ length: n }, (_, i) => ref(i));
  const at = (n: number, extra: Partial<GameStateView> = {}, wa: Partial<WhereaboutsView> = {}) =>
    buildShowBrief(view({ room: "bedroom-a", ...wa }, { asleep: asleepN(n), clockLabel: "1:10am, Day 2", ...extra }), {})!.text;

  it("says so once two thirds of the house has turned in, with the count, and only that the player can go to bed when ready (never a fast-forward)", () => {
    const t = at(10);
    expect(t).toContain("The house is quieting down: 10 of 15 houseguests have turned in.");
    expect(t).toContain("You can go to bed whenever you are ready.");
    expect(t).not.toMatch(/hang out|until morning|fast-forward/i); // Ryne 2026-11-12: bed is the player's choice every night; no skip to morning
  });
  it("is silent below the threshold and for an empty or absent turned-in list", () => {
    expect(at(9)).not.toContain("quieting down");
    expect(at(0)).not.toContain("quieting down");
    expect(buildShowBrief(view({ room: "bedroom-a" }), {})!.text).not.toContain("quieting down");
  });
  it("adds 'nothing more is scheduled tonight' only when the engine's next event is far off", () => {
    expect(at(12, { daySchedule: { next: "hoh-competition", phase: "afternoon", due: false, minutesUntil: 600 } } as Partial<GameStateView>)).toContain("Nothing more is scheduled tonight.");
    expect(at(12, { daySchedule: { next: "nominations", phase: "evening", due: false, minutesUntil: 30 } } as Partial<GameStateView>)).not.toContain("Nothing more is scheduled");
    expect(at(12)).not.toContain("Nothing more is scheduled");
  });
  it("never during a whole-house event, and it carries names nowhere (a count only)", () => {
    expect(at(12, {}, { houseEvent: { kind: "premiere-entrances" } } as Partial<WhereaboutsView>)).not.toContain("quieting down");
    const line = at(12).split("\n").find((l) => l.includes("quieting down")) ?? "";
    expect(line).not.toMatch(/NPC [A-O]/);
  });
  it("a step of the premiere changes nothing about pacing: the cue is plain text (no clock, no rng)", () => {
    expect(at(12)).toBe(at(12));
  });
});
