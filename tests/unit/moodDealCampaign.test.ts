import { describe, it, expect } from "vitest";
import { moodDealTerm, moodUnsteady, MOOD_TERMS } from "../../src/engine/tellReactions";
import { decideDealConsent, dealWillingness } from "../../src/engine/dealConsent";
import { formCampaigns } from "../../src/engine/campaigns";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";

/** B31 (#2017 15.6 E4b): visible mood into deal consent (ORWELL_MOOD_DEAL) and campaign formation (ORWELL_MOOD_CAMPAIGN). Pure terms + the decision they move; flag-off is byte-identical (absent input). */
const base = { trust: 0.5, affinity: 0.5, threat: 0.3, grudge: 0, favor: 0, targetsMe: 0, jitter: 0 };

describe("deal consent mood", () => {
  it("rattled -> accepts protection more; snapping -> less willing; others and no tells -> 0", () => {
    expect(moodDealTerm([{ kind: "withdrawn" }], "veto-save")).toBe(MOOD_TERMS.dealProtect);
    expect(moodDealTerm([{ kind: "tearful" }], "safety")).toBe(MOOD_TERMS.dealProtect);
    expect(moodDealTerm([{ kind: "tearful" }], "vote")).toBe(0);
    expect(moodDealTerm([{ kind: "snapping" }], "vote")).toBe(MOOD_TERMS.dealSnap);
    expect(moodDealTerm([{ kind: "giddy" }], "safety")).toBe(0);
    expect(moodDealTerm(undefined, "safety")).toBe(0);
  });
  it("absent mood is byte-identical; a mood shift moves willingness by exactly that much and can flip a marginal accept", () => {
    const i = { ...base, kind: "veto-save" as const };
    expect(dealWillingness({ ...i, mood: 0 })).toBe(dealWillingness(i));
    expect(dealWillingness({ ...i, mood: MOOD_TERMS.dealProtect })).toBeCloseTo(dealWillingness(i) + MOOD_TERMS.dealProtect, 9);
    let flipped = false;
    for (let t = 0; t <= 1 && !flipped; t += 0.005) {
      const x = { ...i, trust: t, affinity: t };
      if (!decideDealConsent(x).accept && decideDealConsent({ ...x, mood: MOOD_TERMS.dealProtect }).accept) flipped = true;
    }
    expect(flipped).toBe(true);
  });
});

describe("campaign formation mood", () => {
  const actor = (id: number) => ({ id: npc(id), persuasiveness: 0.9, threats: [{ toward: npc(9), threat: 0.95 }], allies: [] }) as never;
  it("unsteady = rattled or snapping only", () => {
    expect(moodUnsteady([{ kind: "withdrawn" }])).toBe(true);
    expect(moodUnsteady([{ kind: "snapping" }])).toBe(true);
    expect(moodUnsteady([{ kind: "giddy" }])).toBe(false);
    expect(moodUnsteady(undefined)).toBe(false);
  });
  it("a rattled actor forms no campaign; absent `steady` forms as before", () => {
    const mk = (steady?: (a: never) => boolean) => formCampaigns([actor(1)], { rng: new SeededRandom(1), beat: 3, ...(steady ? { steady } : {}) } as never);
    const plain = mk();
    expect(plain.length).toBe(1);
    expect(mk(() => false).length).toBe(0);
    expect(mk(() => true)).toEqual(plain);
  });
});

import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
type Internals = { soulObj(id: EntityId): { tells?: Array<{ kind: string; since: number; band: string }> } | undefined; setNpcTellsEnabled(on: boolean): void;
  setMoodDealEnabled(on: boolean): void; setMoodCampaignEnabled(on: boolean): void; moodDealFor(n: EntityId, k: string): number; moodSteady(n: EntityId): boolean };
function game(o: { tells: boolean; deal: boolean; campaign: boolean }) {
  const sb = new GameSessionRegistry().sandboxFor(`b31-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setNpcTellsEnabled(o.tells); s.setMoodDealEnabled(o.deal); s.setMoodCampaignEnabled(o.campaign);
  const who = sb.session.livingIds().filter((i) => i !== PLAYER)[0]!;
  s.soulObj(who)!.tells = [{ kind: "withdrawn", since: 1, band: "strong" }];
  return { s, who };
}
describe("adapter wiring", () => {
  it("OFF (each flag alone, tells off): no term, steady", () => {
    const a = game({ tells: true, deal: false, campaign: false });
    expect(a.s.moodDealFor(a.who, "safety")).toBe(0);
    expect(a.s.moodSteady(a.who)).toBe(true);
    const b = game({ tells: false, deal: true, campaign: true });
    expect(b.s.moodDealFor(b.who, "safety")).toBe(0);
    expect(b.s.moodSteady(b.who)).toBe(true);
  });
  it("ON: a rattled NPC gets the protection shift and is unsteady; flags independent", () => {
    const d = game({ tells: true, deal: true, campaign: false });
    expect(d.s.moodDealFor(d.who, "safety")).toBe(MOOD_TERMS.dealProtect);
    expect(d.s.moodSteady(d.who)).toBe(true);
    const c = game({ tells: true, deal: false, campaign: true });
    expect(c.s.moodSteady(c.who)).toBe(false);
    expect(c.s.moodDealFor(c.who, "safety")).toBe(0);
  });
});
