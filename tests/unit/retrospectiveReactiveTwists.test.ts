import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { SessionCore } from "../../src/engine/sessionSnapshot";
import { resolvePending } from "../../features/support/answerPending";

/**
 * 0048 "any unfired twist" on the REACTIVE path (default-on since 2026-11-03): the post-crown retrospective names the twists the sealed plan ARMED but the house
 * never earned (null week), alongside the ones that fired; an unarmed twist was never in play so it is not listed. Roles only.
 */
const plan = (over: Record<string, unknown>) => ({
  doubleEvictionAtActive: 99, doubleEvictionArmed: false, secretVetoStreak: 99, secretVetoArmed: false, battleBackAtJury: 99, battleBackArmed: false, ...over,
});

function playWithPlan(seed: number, twistPlan: Record<string, unknown>) {
  const s = new GameSessionRegistry().sandboxFor(`rr${seed}`).session;
  s.createCharacter({ playerName: "P", seed });
  const core = JSON.parse(JSON.stringify(s.snapshot())) as SessionCore;
  core.live!.twistPlan = twistPlan as never;
  s.restore(core);
  for (let i = 0; i < 9000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    if (v.finished) break;
  }
  return s.seasonRetrospective()!;
}

describe("the retrospective unseals the reactive plan's armed-but-unfired twists", () => {
  it("an armed twist that can never be earned is named with a null week; an unarmed one is absent", () => {
    // double eviction armed but with an unreachable threshold (<= 1 active) => never fires; battle-back unarmed => not listed
    const retro = playWithPlan(4, plan({ doubleEvictionArmed: true, doubleEvictionAtActive: 1 }));
    expect(retro.twists).toEqual([{ kind: "double-eviction", firedWeek: null }]);
  });
  it("a twist that fired is listed with its week, and an armed-unfired sibling alongside it", () => {
    const retro = playWithPlan(4, plan({ doubleEvictionArmed: true, doubleEvictionAtActive: 14, battleBackArmed: true, battleBackAtJury: 99 }));
    const byKind = Object.fromEntries(retro.twists.map((t) => [t.kind, t.firedWeek]));
    expect(typeof byKind["double-eviction"]).toBe("number");
    expect(byKind["battle-back"]).toBeNull();
    expect(Object.keys(byKind)).not.toContain("secret-veto");
  });
});

// AMEND 0025 (Ryne-approved 2026-11-04): the DEPLOYED path — natural seasons, twists ON, no hand-set plan. The retrospective must list the reactive twists that
// fired AND the ones armed that did not, name nothing for an unarmed one, and show NOTHING before the season ends.
describe("AMEND 0025 — the post-season retrospective under the deployed (twists ON) defaults", () => {
  const ARMED_FLAG: Record<string, string> = { "double-eviction": "doubleEvictionArmed", "secret-veto": "secretVetoArmed", "battle-back": "battleBackArmed" };
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  it("nothing is unsealed before the season ends; after it, fired twists carry their week and armed-unfired ones a null week", () => {
    let sawFired = 0, sawUnfired = 0;
    for (const seed of SEEDS) {
      const s = new GameSessionRegistry().sandboxFor(`am25-${seed}`).session;
      s.createCharacter({ playerName: "P", seed });
      let finished = false;
      for (let i = 0; i < 9000 && !finished; i++) {
        const v = s.advanceGame();
        if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
        finished = !!v.finished;
        if (!finished && i % 40 === 0) expect(s.seasonRetrospective(), `seed ${seed}: the retrospective shows nothing while the season is live`).toBeNull();
      }
      expect(finished, `seed ${seed}: the season finished`).toBe(true);
      const live = s.snapshot().live!;
      const retro = s.seasonRetrospective()!;
      expect(retro, `seed ${seed}: unsealed after the crown`).toBeTruthy();
      const plan = live.twistPlan as unknown as Record<string, boolean>;
      const fired = new Map((live.firedTwists ?? []).map((t) => [t.kind as string, t.beat as number]));
      const listed = new Map(retro.twists.map((t) => [t.kind as string, t.firedWeek as number | null]));
      for (const [kind, flag] of Object.entries(ARMED_FLAG)) {
        if (fired.has(kind)) { sawFired++; expect(listed.get(kind), `seed ${seed}: fired ${kind} is listed with its week`).toBe(fired.get(kind)); }
        else if (plan?.[flag]) { sawUnfired++; expect(listed.has(kind), `seed ${seed}: armed-but-unfired ${kind} is named`).toBe(true); expect(listed.get(kind), `seed ${seed}: …with a null week`).toBeNull(); }
        else expect(listed.has(kind), `seed ${seed}: an unarmed ${kind} was never in play, so it is not listed`).toBe(false);
      }
    }
    expect(sawFired, "the sample exercised at least one fired twist").toBeGreaterThan(0);
    expect(sawUnfired, "…and at least one armed-but-unfired twist").toBeGreaterThan(0);
  }, 900_000);
});
