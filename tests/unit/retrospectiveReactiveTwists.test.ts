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
