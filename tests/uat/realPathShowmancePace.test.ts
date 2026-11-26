import { describe, it, expect, beforeAll } from "vitest";
import { SHOWMANCE_PACE } from "../../src/engine/attractionLife";
import { playedGame } from "../support/playedGame";
import { playMixGame } from "../support/houseMixDriver";
import { firstSeedWhere, firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-736: the showmance slow build, REAL PATH. A whole season is played through the player's levers only, so every romance and every step of its pace is the
 * house's own, played until some pair has climbed two levels. Each turn the test only READS the stage of every seeded showmance. Checked: every pace record
 * belongs to a romance the house started; its steps come in
 * order, never before the day the romance began plus the first minimum, each at least the level's minimum days after the last; a noticing step names who caught it;
 * no showmance is public before the earliest public day. With pacing off, the same seed played to the moment the first romance began keeps no pace record.
 * The seed is scanned from 21 (ORW-880; seed 21 plays in its old sandbox "ps21"): the first whose season has a pair climb two levels (of seeds 3, 7, 13, 21 measured
 * once, only 21 did, so the scan is slow if 21 ever stops).
 * HEAVY LANE (tests/uat/realPath*, the `real-path` leg): most of a played season, twice up to the first romance. Roles only.
 */
type Pace = { level: number; since: number; steps: Array<{ day: number; from: number; to: number; seenBy: string[] }> };
type Priv = { live: { romances?: Record<string, number>; showmancePace?: Record<string, Pace>; dayNumber?: number }; seededRels: { showmances: Array<{ a: string; b: string; stage: string }> } };

describe("ORW-736 REAL PATH: a showmance builds slowly in a played season", () => {
  let pace: Record<string, Pace> = {};
  let romances: Record<string, number> = {};
  let publicBefore: Array<{ day: number; pair: string }> = [];
  let firstRomanceTurn = -1;
  let seed = 0, user = "";
  beforeAll(() => {
    const found = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      const p = g.s as unknown as Priv;
      const climbedTwo = (): boolean => Object.values(p.live.showmancePace ?? {}).some((r) => r.steps.length >= 2);
      const early: Array<{ day: number; pair: string }> = [];
      let finished = false, first = -1;
      for (let i = 0; i < 20_000 && !finished && !climbedTwo(); i++) {
        finished = g.turn().finished === true;
        if (first < 0 && Object.keys(p.live.romances ?? {}).length > 0) first = i + 1;
        const day = p.live.dayNumber ?? 1;
        for (const sm of p.seededRels.showmances ?? []) if (sm.stage === "visible" && day < SHOWMANCE_PACE.publicNotBeforeDay) early.push({ day, pair: `${sm.a}|${sm.b}` });
      }
      return climbedTwo() ? { p, early, first } : undefined;
    }, { from: 1, to: 24, hint: [3, 21], sandbox: (s) => (s === 21 ? "ps21" : `ps-${s}`), what: "a pair climbing two levels before the crown" });
    seed = found.seed; user = found.sandbox;
    publicBefore = found.at.early;
    firstRomanceTurn = found.at.first;
    pace = found.at.p.live.showmancePace ?? {};
    romances = found.at.p.live.romances ?? {};
  }, 900_000);

  it("pace records belong to romances the house started; steps keep the minimum days; noticing names who caught it; nothing is public early", () => {
    expect(Object.keys(pace).length).toBeGreaterThan(0);
    for (const pk of Object.keys(pace)) expect(romances[pk], `${pk} is a romance the house started`).toBeDefined();
    const min = SHOWMANCE_PACE.minDays.map((m) => m * (1 - SHOWMANCE_PACE.jitter));
    let climbed = 0;
    for (const [pk, rec] of Object.entries(pace)) {
      expect(rec.steps.map((s) => s.to)).toEqual(rec.steps.map((_, i) => i + 1));
      if (rec.steps[0]) expect(rec.steps[0].day, "the first step waits the first minimum after the romance began").toBeGreaterThanOrEqual(romances[pk]! + min[0]! - 1);
      for (let i = 1; i < rec.steps.length; i++) expect(rec.steps[i]!.day - rec.steps[i - 1]!.day).toBeGreaterThanOrEqual(min[i]! - 1);
      if (rec.steps.length >= 2) { climbed++; expect(rec.steps[1]!.seenBy.length, "the noticing step names who caught it").toBeGreaterThan(0); }
      if (rec.steps.length >= 4) expect(rec.steps[3]!.day).toBeGreaterThanOrEqual(SHOWMANCE_PACE.publicNotBeforeDay);
    }
    expect(climbed, "a pair climbed at least two levels").toBeGreaterThan(0);
    expect(publicBefore).toEqual([]);
  });

  it("pacing off: the same seed, played to the moment the first romance began, keeps no pace record", () => {
    expect(firstRomanceTurn).toBeGreaterThan(0);
    // not as shipped: the control arm, the same seed with this feature off, proves the feature is what makes the difference
    const off = playedGame({ seed, user: user, before: (s) => (s as unknown as { setShowmancePacingEnabled(on: boolean): void }).setShowmancePacingEnabled(false) });
    for (let i = 0; i < firstRomanceTurn + 20; i++) off.turn();
    expect((off.s as unknown as Priv).live.showmancePace).toBeUndefined();
  }, 900_000);

  // Blocked, not faked: in four played seasons (seeds 3, 7, 13, 21) no showmance reached the public stage (the furthest climbed two of four levels, from day 41), so the
  // "public couple late, once" claim and the house's one noticing beat are proven only by the unit test that drives the days by hand (tests/unit/showmancePaceLive.test.ts).
  it("ORW-842: in a chat-paced played season a strong pair reaches the public couple stage within about five weeks, never before the earliest public day", async () => {
    // The precondition (a season where some pair reaches the public couple stage) is SCANNED apart from the pace assertions (ORW-880): any change to the played season may pick another seed, never make the assertions pass with nothing to check.
    // ORW-892: the scan plays up to 2400 messages (about day 46; it was 1500, about day 31). With the casts of ORW-893 (mostly straight) there are fewer seeded strong pairs, and the best of them (seed 15) reaches the public couple on day 32, so the 1500-message scan ended a few days short on every seed; the claims below are unchanged.
    // ORW-842: a pair that REACHED level 4 (a step up to 4), not merely one with four or more steps: a pair that climbs to 3 and fades back has [1,2,3,2,1] and never went public.
    const publicPair = (s: unknown): [string, Pace] | undefined => Object.entries((s as Priv).live.showmancePace ?? {}).find(([, r]) => r.steps.some((x) => x.to === 4));
    const found = await firstSeedWhere<[string, Pace]>(async (seed, sandbox) => {
      let got: [string, Pace] | undefined;
      await playMixGame(seed, 2400, { user: sandbox, advanceEvery: 6, stopWhen: (s) => publicPair(s) !== undefined, inspect: (s) => { got = publicPair(s); } });
      return got;
    }, { from: 1, to: 16, hint: [15], sandbox: (seed) => `mixdrv-${seed}`, what: "a pair reaching the public couple stage in a chat-paced played season" });
    const rec = found.at[1];
    const at = rec.steps.findIndex((x) => x.to === 4);
    expect(rec.steps.slice(0, at + 1).map((x) => x.to), "it climbed one level at a time up to the public couple").toEqual([1, 2, 3, 4]);
    expect(rec.steps[at]!.day, "never before the earliest public day").toBeGreaterThanOrEqual(SHOWMANCE_PACE.publicNotBeforeDay);
    expect(rec.steps[at]!.day, "within about five weeks").toBeLessThanOrEqual(35);
    expect(rec.steps[at]!.seenBy.length, "the house has caught it").toBeGreaterThan(0);
  }, 1_800_000);
  it.todo("real path: the player's own romance runs the same pace, not attempted: it needs the player's gender facet set in casting and a houseguest drawn to them, which the played driver does not reach (ORW-736)");
});
