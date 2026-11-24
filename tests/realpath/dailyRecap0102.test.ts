import { describe, it, expect, afterEach } from "vitest";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { PLAYER } from "../../src/domain/ids";
import type { DailyRecapView } from "../../src/ports/GameSession";
import { playUntil, learned, bedtimeNow, type Stop, firstStop, wfScan } from "./playedSeason";
import type { PlayOpts } from "../support/whatFired/player";

/**
 * 0102 (PO review 2026-06-27 redesign, #884) - the DAILY "day in review" recap, fired at the player's own bedtime (`turnIn`, ADR 0006), in a PLAYED season (ORW-810: before, the
 * session was wired by hand and every rumor was planted). The season is played by the scripted talking player (seed 3 unless a test says otherwise); each test stops at the first
 * moment the state it needs exists in play and the player then acts through the MCP channel (turnIn, dailyRecap, diaryRoom), or it reads the recaps the season itself made at each
 * bedtime. Roles only.
 */
const SEED = 3;
afterEach(() => { delete process.env.ORWELL_TIME_OF_DAY; });

/** The player's learned facts since the last recap (the recap's own cursor): what tonight's recap may draw on. */
const sinceLastRecap = (s: Stop) => {
  const all = s.engine.knowledge.knownTo(PLAYER);
  return all.slice(Math.min(s.sess.live?.dailyRecapKnowledgeCursor ?? 0, all.length)).filter((f) => f.pathway !== "diary-room");
};
/** Turn in through the player channel and return the view. */
const turnIn = async (s: Stop) => (await s.call("turnIn", {})) as { dailyRecap?: DailyRecapView; held?: unknown };
/** The text a fact is voiced in on the recap (the engine's own tidy humanizer). */
const tidy = (s: Stop, content: string): string => s.sess.humanizeTidy(content) as string;
/** Content the player holds through no pathway: houseguests' own beliefs the player was never told, hidden scenes, the Vault. */
function unsurfaced(s: Stop): string[] {
  const mine = new Set(s.engine.knowledge.knownTo(PLAYER).map((f) => tidy(s, f.content)));
  const npcOnly = s.sess.livingIds().filter((id: string) => id !== PLAYER).flatMap((id: string) => s.engine.knowledge.knownTo(id).map((f) => f.content)).filter((c: string) => !mine.has(tidy(s, c)));
  const hidden = [...s.engine.events.queryAll().filter((e) => e.hidden && !e.witnessSet.includes(PLAYER)).map((e) => String(e.content)), ...s.engine.vault.readHidden().map((r) => r.content)];
  return [...npcOnly, ...npcOnly.map((c: string) => tidy(s, c)), ...hidden].filter((c) => c.trim().length > 0);
}
/** Every recap the season made at its own bedtimes, read as each one is materialized; stops when `done` says so. */
async function recapsUntil(seed: number, done: (recaps: DailyRecapView[]) => boolean, act?: (s: Stop) => Promise<void>): Promise<DailyRecapView[]> {
  const recaps: DailyRecapView[] = [];
  await playUntil(seed, async (s) => {
    if (act) await act(s);
    const r = s.sess.dailyRecap() as DailyRecapView | null;
    if (r && r.day !== recaps[recaps.length - 1]?.day) recaps.push(r);
    return done(recaps);
  }, { user: `wf-${seed}` });
  return recaps;
}
/** A player who only sends messages through the premiere (no advance, no talk): the premiere night falls before anyone has told them anything. */
const QUIET: Omit<Partial<PlayOpts>, "seed" | "watch"> = {
  advanceEvery: 1_000_000, talkEvery: 1_000_000,
  setup: (sess) => { sess.setPerConversationClockEnabled(true); },
};

describe("0102 - the daily recap is dormant unless the clock is running", () => {
  it("turnIn carries no dailyRecap, and dailyRecap reads null, when ORWELL_TIME_OF_DAY is off", async () => {
    process.env.ORWELL_TIME_OF_DAY = "0"; // not as shipped: the dormancy check (the recap needs the clock); unset again after each test
    const at = await playUntil(SEED, () => true, { user: `wf-${SEED}` });
    const v = await turnIn(at);
    expect(v.dailyRecap).toBeUndefined();
    expect(await at.call("dailyRecap", {})).toBeNull();
  }, 120_000);
});

describe("0102 - dailyRecap is advertised and dispatches through the player channel", () => {
  it("is a registered player tool and a real model lever (not FE-only infra)", () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("dailyRecap");
    expect(PLAYER_AGENT_LEVERS).toContain("dailyRecap");
  });

  it("returns null before any day has closed", async () => {
    const at = await playUntil(SEED, () => true, { user: `wf-${SEED}` });
    expect(at.sess.gameStatus().dayNumber ?? 1).toBe(1);
    expect(await at.call("dailyRecap", {})).toBeNull();
  }, 120_000);

  it("returns the just-materialized recap after the player's own turnIn", async () => {
    const at = await firstStop(bedtimeNow, wfScan(SEED));
    const v = await turnIn(at);
    expect(v.dailyRecap).toBeDefined();
    expect(await at.call("dailyRecap", {})).toEqual(v.dailyRecap);
  }, 120_000);
});

describe("0102 - the recap is stitched from witnessed + already-surfaced material only", () => {
  it("the first bedtime's recap is day 1, with the witnessed highlights of the day's real beats", async () => {
    const [first] = await recapsUntil(SEED, (rs) => rs.length >= 1);
    expect(first!.day).toBe(1);
    expect(first!.highlights.length).toBeGreaterThan(0);
  }, 120_000);

  it("gossip the player was told today appears; what only the houseguests hold, hidden scenes and the Vault never do", async () => {
    const at = await firstStop((s) => bedtimeNow(s) && sinceLastRecap(s).length > 0 && unsurfaced(s).length > 0, wfScan(SEED));
    const today = sinceLastRecap(at).map((f) => tidy(at, f.content));
    const hidden = unsurfaced(at);
    const v = await turnIn(at);
    const r = v.dailyRecap!;
    expect(r.surfaced.length).toBeGreaterThan(0);
    for (const line of r.surfaced) expect(today, "every surfaced line is something the player learned today").toContain(line);
    const dump = JSON.stringify(r) + JSON.stringify(await at.call("dailyRecap", {}));
    for (const c of hidden) expect(dump).not.toContain(c);
  }, 120_000);

  it("excludes the player's own out-of-character Diary Room (no in-game pathway to any houseguest)", async () => {
    const at = await firstStop(bedtimeNow, wfScan(SEED));
    const DR = "a private diary room confession about my plan for the week";
    await at.call("diaryRoom", { entry: DR });
    const v = await turnIn(at);
    expect(JSON.stringify(v.dailyRecap)).not.toContain(DR);
  }, 120_000);
});

describe("0102 - the cliffhanger teases an in-motion thread but commits to no outcome", () => {
  it("a quiet day (nothing learned, no deal) closes with no fabricated hook", async () => {
    // The premiere night of a player who has only been talking among the arrivals (QUIET): nobody has told them anything and they hold no deal.
    const at = await firstStop((s) => bedtimeNow(s) && learned(s).length === 0, wfScan(SEED), { ...QUIET });
    expect(at.sess.deals.forParty(PLAYER)).toEqual([]);
    const r = (await turnIn(at)).dailyRecap!;
    expect(r).toBeDefined();
    expect(r.surfaced).toEqual([]);
    expect(r.hook).toBeUndefined();
  }, 120_000);

  it("a hook, when present, never asserts a future result", async () => {
    const recaps = await recapsUntil(SEED, (rs) => rs.filter((r) => r.hook).length >= 3);
    for (const r of recaps.filter((x) => x.hook)) {
      const framing = r.hook!.framing.toLowerCase();
      for (const banned of ["wins hoh", "will win", "evicted", "goes home", "nominated", "will be"]) expect(framing).not.toContain(banned);
      expect(typeof r.hook!.thread).toBe("string");
    }
  }, 120_000);

  it("ORW-517: every hook is in the player's own first person, for a rumor heard and for a deal on borrowed time (Ryne, card 29)", async () => {
    const first = (t: string) => /\b(I|my|me)\b/.test(t) && !/\b(you|your|yours|the player)\b/i.test(t);
    const kinds = (rs: DailyRecapView[]) => new Set(rs.flatMap((r) => (r.hook ? [r.hook.thread.split(":")[0]] : [])));
    // The player strikes a deal and leaves its term unspoken (a vague deal is on borrowed time): the player's own act, through the channel, accepted or refused by the houseguest.
    let dealt = false;
    const strike = async (s: Stop): Promise<void> => {
      if (dealt || !s.sess.getGameState().started || s.sess.getGameState().phase === "premiere") return;
      for (const npc of s.sess.livingIds().filter((id: string) => id !== PLAYER)) {
        const d = await s.call("makeDeal", { with: npc, kind: "safety", terms: "we look out for each other", term: { vague: true } });
        if (d?.id) { dealt = true; return; }
      }
    };
    const recaps = await recapsUntil(SEED, (rs) => kinds(rs).has("surfaced") && kinds(rs).has("deal"), strike);
    expect(dealt).toBe(true);
    for (const r of recaps.filter((x) => x.hook)) expect(first(r.hook!.framing), r.hook!.framing).toBe(true);
  }, 300_000);
});

describe("0102 - the recap augments play and is reproducible", () => {
  it("materializing the recap progresses no game state: week, HOH and nominees are unchanged by the turnIn", async () => {
    const at = await firstStop(bedtimeNow, wfScan(SEED));
    const before = at.sess.gameStatus();
    await turnIn(at);
    const after = at.sess.gameStatus();
    expect(after.week).toBe(before.week);
    expect(after.hoh).toEqual(before.hoh);
    expect(after.nominees).toEqual(before.nominees);
  }, 120_000);

  it("re-reading dailyRecap after turnIn reproduces the exact same materialized digest", async () => {
    const at = await firstStop((s) => bedtimeNow(s) && sinceLastRecap(s).length > 0, wfScan(SEED));
    const v = await turnIn(at);
    const reread = await at.call("dailyRecap", {});
    expect(reread).toEqual(v.dailyRecap);
    expect(await at.call("dailyRecap", {})).toEqual(reread);
  }, 120_000);

  it("the day advances and the next day's recap never repeats the prior day's content", async () => {
    const recaps = await recapsUntil(SEED, (rs) => rs.length >= 2 && rs.slice(1).some((r, i) => r.surfaced.length > 0 && rs[i]!.surfaced.length > 0));
    let pairs = 0;
    for (let i = 1; i < recaps.length; i++) {
      const [prev, next] = [recaps[i - 1]!, recaps[i]!];
      expect(next.day).toBeGreaterThan(prev.day);
      if (prev.surfaced.length === 0 || next.surfaced.length === 0) continue;
      pairs++;
      for (const line of next.surfaced) expect(prev.surfaced, `day ${next.day} repeats day ${prev.day}`).not.toContain(line);
    }
    expect(pairs).toBeGreaterThan(0);
  }, 120_000);
});
