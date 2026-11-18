import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { MOOD_CAUSES, causeLine, isBadNight, isCloseFriend, mayShareEventCause, strongestCause, type MoodCauseEntry, type MoodCauseSource } from "../../src/engine/moodCauses";

/** 0194 / ORW-626: moods with more causes. Roles only (holder, other). */
const SOURCES: MoodCauseSource[] = ["lied-to", "betrayed", "friend-evicted", "bad-sleep", "won", "lost"];
const entry = (holder: string, source: MoodCauseSource, week: number): MoodCauseEntry => ({ holder, source, line: causeLine(source), week });

describe("the pure cause rules", () => {
  it("every source has first-person words, and a subject placeholder only where it names someone", () => {
    for (const s of SOURCES) expect(causeLine(s).length).toBeGreaterThan(5);
    for (const s of ["lied-to", "betrayed", "friend-evicted"] as const) expect(causeLine(s)).toContain("{subject}");
    for (const s of ["bad-sleep", "won", "lost"] as const) expect(causeLine(s)).not.toContain("{subject}");
  });
  it("the heaviest cause of the week is the one given; the latest wins a tie; other weeks and other people do not count", () => {
    const log = [entry("a", "won", 2), entry("a", "lied-to", 2), entry("a", "bad-sleep", 2), entry("b", "lied-to", 2), entry("a", "lied-to", 1)];
    expect(strongestCause(log, "a", 2)?.source).toBe("lied-to");
    expect(strongestCause(log, "a", 3)).toBeUndefined();
    expect(strongestCause([entry("a", "won", 2), entry("a", "lost", 2)], "a", 2)?.source).toBe("lost");
    expect(strongestCause(undefined, "a", 1)).toBeUndefined();
  });
  it("a cause that points at a grudge needs more trust and candor than a plain one", () => {
    expect(mayShareEventCause("won", 0.5, 0.45)).toBe(true);
    expect(mayShareEventCause("lied-to", 0.5, 0.45)).toBe(false);
    expect(mayShareEventCause("lied-to", 0.8, 0.5)).toBe(true);
  });
  it("a bad night and a close friend have a line", () => {
    expect(isBadNight(MOOD_CAUSES.badSleepDeficit)).toBe(true);
    expect(isBadNight(0.1)).toBe(false);
    expect(isCloseFriend(0.7, 0.5)).toBe(true);
    expect(isCloseFriend(0.4, 0.5)).toBe(false);
  });
});

type S = {
  live: { week: number; active: EntityId[]; moodCauseLog?: MoodCauseEntry[]; evictionOrder: EntityId[] };
  setMoodCausesEnabled(on: boolean): void;
  payForCaughtLie(p: { holder: EntityId; liar: EntityId; confidence: number; origin: "witnessed" | "told" }): void;
  noteFriendEvicted(evictee: EntityId): void;
  npcVoice(id: EntityId): { moodCause?: string } | null;
  soulObj(id: EntityId): { emotionalHistory: unknown[] } | undefined;
  rel: { edge(a: EntityId, b: EntityId): { affinity: number; trust: number } };
  agendaCharacterOf(id: EntityId): unknown;
};
async function setup(seed: number, played = true) {
  const reg = new GameSessionRegistry();
  const user = `mood-causes-${seed}-${Math.random()}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  if (played) await mcp.callTool("noteMessage", { messageId: "first" });
  const s = reg.sandboxFor(user).session as unknown as S;
  const [holder, other] = s.live.active.filter((x) => x !== PLAYER);
  return { s, holder: holder!, other: other! };
}

describe("wired into a played game", () => {
  it("a caught lie gives the holder a cause and a mood step; the liar gets nothing", async () => {
    const { s, holder, other } = await setup(21);
    const before = s.soulObj(holder)!.emotionalHistory.length;
    s.payForCaughtLie({ holder, liar: other, confidence: 0.8, origin: "told" });
    expect(s.live.moodCauseLog).toEqual([expect.objectContaining({ holder, source: "lied-to", about: other, week: s.live.week })]);
    expect(s.soulObj(holder)!.emotionalHistory.length).toBeGreaterThanOrEqual(before);
  });
  it("a close friend of the evictee has the cause; a stranger does not", async () => {
    const { s, holder, other } = await setup(22);
    const e = s.rel.edge(holder, other); e.trust = 0.9; e.affinity = 0.9;
    s.noteFriendEvicted(other);
    expect(s.live.moodCauseLog?.some((c) => c.holder === holder && c.source === "friend-evicted" && c.about === other)).toBe(true);
    const e2 = s.rel.edge(holder, other); e2.trust = 0.1; e2.affinity = 0.1;
    const n = s.live.moodCauseLog!.length;
    s.noteFriendEvicted(other);
    expect(s.live.moodCauseLog!.length).toBe(n);
  });
  it("the same cause on the same day is written once (append-only, no duplicates)", async () => {
    const { s, holder, other } = await setup(23);
    s.payForCaughtLie({ holder, liar: other, confidence: 0.8, origin: "told" });
    s.payForCaughtLie({ holder, liar: other, confidence: 0.8, origin: "told" });
    expect(s.live.moodCauseLog).toHaveLength(1);
  });
  it("flag off: nothing is recorded or said (byte-identical)", async () => {
    const { s, holder, other } = await setup(24);
    s.setMoodCausesEnabled(false);
    s.payForCaughtLie({ holder, liar: other, confidence: 0.8, origin: "told" });
    expect(s.live.moodCauseLog).toBeUndefined();
    expect(s.npcVoice(holder)?.moodCause).toBeUndefined();
  });
  it("a headless (unplayed) game records nothing", async () => {
    const { s, holder, other } = await setup(25, false);
    s.payForCaughtLie({ holder, liar: other, confidence: 0.8, origin: "told" });
    expect(s.live.moodCauseLog).toBeUndefined();
  });
  it("the player is never given a recorded cause", async () => {
    const { s, other } = await setup(26);
    s.payForCaughtLie({ holder: PLAYER, liar: other, confidence: 0.8, origin: "told" });
    expect(s.live.moodCauseLog).toBeUndefined();
  });
});

describe("the wall: a cause is told only by choice, never as a number or a hidden cause", () => {
  it("with low trust the cause stays hidden; with high trust it is said, in words, naming only a public name, and no engine key or number leaks", async () => {
    const { s, holder, other } = await setup(27);
    s.payForCaughtLie({ holder, liar: other, confidence: 0.8, origin: "told" });
    const e = s.rel.edge(holder, PLAYER);
    e.affinity = -0.5;
    expect(s.npcVoice(holder)?.moodCause).toBeUndefined();
    e.affinity = 1;
    const voice = s.npcVoice(holder);
    const said = voice?.moodCause;
    if (said !== undefined) {
      expect(said).not.toContain("{subject}");
      expect(said).not.toMatch(/lied-to|moodCauseLog|\d\.\d/);
    }
    expect(JSON.stringify(voice ?? {})).not.toMatch(/moodCauseLog|"source"|"weight"/);
  });
});
