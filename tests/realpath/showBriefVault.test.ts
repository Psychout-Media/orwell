import { describe, it, expect } from "vitest";
import type { DeepProfile, StoryThread } from "../../src/engine/deepProfile";
import { type Stop, firstStop, wfScan } from "./playedSeason";

/**
 * The Show Brief is Vault-free - in a PLAYED season (ORW-812: before, sentinels were written into a snapshot and restored). The season is played by the scripted talking player
 * (seed 1, was 7) to the middle of week 2; the hidden material the season really holds (every story thread's premise and trigger, every houseguest's secrets, true goals and weakness) is
 * read from the session, and none of it may reach the brief, asked about every houseguest, first read and echoed read alike. The other brief checks stay in
 * tests/unit/showBriefSession.test.ts. Roles only.
 */
const hiddenOf = (s: Stop): string[] => {
  const core = s.sess.snapshot() as { storyThreads?: StoryThread[]; deepProfiles?: Record<string, DeepProfile> };
  const out: string[] = [];
  for (const t of core.storyThreads ?? []) out.push(t.premise, t.trigger);
  for (const p of Object.values(core.deepProfiles ?? {})) out.push(...p.secrets, ...p.trueGoals, p.weakness);
  return out.filter((x): x is string => typeof x === "string" && x.trim().length >= 12); // a fragment shorter than a phrase would match ordinary words
};

describe("the brief is Vault-free in a played season", () => {
  it("no hidden premise, trigger, secret, goal or weakness the season holds ever reaches the brief", async () => {
    // ORW-1159: the stop needs the player in the house (no whereabouts, no brief); the tether moved seed 7 to a week-1 player eviction, so the hint is now 1 (Ryne OK'd 11-28). ORW-995: hint 1 (was 7); the census-hometown cast moves the seeded draws and seed 7 (like 5) builds no brief.
    const at = await firstStop((s) => (s.sess.live?.week ?? 1) >= 2 && s.sess.whereabouts() != null && hiddenOf(s).length > 0, wfScan(1));
    const hidden = hiddenOf(at);
    expect(hidden.length, "non-vacuous: the season holds hidden material").toBeGreaterThan(10);
    const everyone = (at.sess.livingIds() as string[]).filter((id) => id !== "player");
    const first = await at.call("getMomentPrompt", { brief: { askedAbout: everyone.slice(0, 32), lastShown: "A quiet line." } });
    const second = await at.call("getMomentPrompt", { brief: { seen: first.showBrief!.seen } });
    expect(first.showBrief?.text, "a brief was built").toBeTruthy();
    for (const mp of [first, second]) {
      const text = JSON.stringify(mp.showBrief);
      for (const h of hidden) expect(text, "hidden material in the brief").not.toContain(h);
    }
  }, 120_000);
});
