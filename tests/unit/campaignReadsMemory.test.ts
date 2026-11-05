import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * B7 / #2017 M4 (approved tie-in #5) - campaign TARGETS read grudges and beliefs, not only the top threat edge: an NPC's ranked threat list (which seeds an evict campaign) is bent by what the owner
 * remembers (a grudge raises a rival, a favor lowers them) and believes (they target me). Bounded; flag-off (ORWELL_CAMPAIGN_MEMORY) byte-identical. Roles only.
 */
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`campmem-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const [owner, a, b] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  return { sb, owner: owner!, a: a!, b: b! };
}
type G = { setCampaignMemoryEnabled(on: boolean): void; threatReadsOf(owner: string): Array<{ toward: string; threat: number }>; remember(h: string, s: string, k: string, sev: number): void };

describe("threatReadsOf with the campaign memory bend (ORWELL_CAMPAIGN_MEMORY)", () => {
  it("flag off (default): identical to the raw edge ranking", () => {
    const { sb, owner, a } = started(); const g = sb.session as unknown as G;
    const before = JSON.stringify(g.threatReadsOf(owner));
    g.remember(owner, a, "deal-broken", 0.9);
    expect(JSON.stringify(g.threatReadsOf(owner))).toBe(before);
  });
  it("flag on: a remembered grudge RAISES that rival's read; a remembered favor LOWERS it; others unchanged", () => {
    const { sb, owner, a, b } = started(); const g = sb.session as unknown as G; g.setCampaignMemoryEnabled(true);
    const base = Object.fromEntries(g.threatReadsOf(owner).map((r) => [r.toward, r.threat]));
    g.remember(owner, a, "deal-broken", 0.9);
    g.remember(owner, b, "veto-saved", 0.9);
    const now = Object.fromEntries(g.threatReadsOf(owner).map((r) => [r.toward, r.threat]));
    expect(now[a]!).toBeGreaterThan(base[a]!);
    expect(now[b]!).toBeLessThan(base[b]!);
  });
  it("is deterministic, bounded to [0,1], and sorted high to low", () => {
    const { sb, owner, a } = started(); const g = sb.session as unknown as G; g.setCampaignMemoryEnabled(true);
    g.remember(owner, a, "deal-broken", 1);
    const r = g.threatReadsOf(owner);
    expect(JSON.stringify(g.threatReadsOf(owner))).toBe(JSON.stringify(r));
    for (const x of r) { expect(x.threat).toBeGreaterThanOrEqual(0); expect(x.threat).toBeLessThanOrEqual(1); }
    for (let i = 1; i < r.length; i++) expect(r[i - 1]!.threat).toBeGreaterThanOrEqual(r[i]!.threat);
  });
});
