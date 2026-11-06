import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";

/**
 * Watch list item 4 (ORW-106): VOTE COUNTING gates campaigning. With ORWELL_VOTE_COUNT on (set explicitly here), an NPC works the house against a target only while it believes the count is CLOSE: when
 * every other voter is hostile to the target (the count is decided in its favour) no evict campaign forms; when the house is split, one does on some seeds. Switching vote counting off lets the same
 * decided house campaign (the mutant). Runs the real campaign tick. Roles only.
 */
type Camp = { owners: string[]; target: string; status: string; goal: string };
const campsOf = (s: GameSessionAdapter): Camp[] => (s as unknown as { campaigns: Camp[] }).campaigns;

function campaignForms(seed: number, house: "decided" | "split", voteCount: boolean): boolean {
  const rel = new RelationshipModel(0.5);
  const s = new GameSessionAdapter(rel);
  s.createCharacter({ playerName: "The Player", seed });
  s.setCampaignsEnabled(true);
  s.setVoteCountEnabled(voteCount);
  const ids = (s.snapshot().house?.npcs ?? []).map((n) => n.id);
  const [owner, target] = [ids[0]!, ids[1]!];
  for (const o of ids) if (o !== owner) { rel.edge(owner, o).threat = 0.1; rel.edge(owner, o).affinity = 0.2; }
  rel.edge(owner, target).threat = 0.95; // the owner wants the target out either way
  ids.slice(2).forEach((v, i) => {
    const hostile = house === "decided" ? true : i % 2 === 0; // decided: everyone is against the target; split: every other voter is
    const e = rel.edge(v, target);
    if (hostile) { e.threat = 0.95; e.trust = 0.05; } else { e.threat = 0.05; e.trust = 0.95; }
  });
  s.campaignTick();
  return campsOf(s).some((c) => c.owners[0] === owner && c.target === target && c.status === "active" && c.goal === "evict");
}

describe("vote counting gates campaigns (live campaign tick, vote count on)", () => {
  const seeds = [1, 2, 3, 4, 5, 6];
  it("a house where the count is decided in the owner's favour starts no evict campaign", () => {
    for (const seed of seeds) expect(campaignForms(seed, "decided", true), `seed ${seed}: no campaign when the count is decided`).toBe(false);
  });
  it("a split house does start campaigns on some seeds (the gate is not simply closed)", () => {
    const formed = seeds.filter((seed) => campaignForms(seed, "split", true)).length;
    expect(formed, `${formed} of ${seeds.length} split-house seeds formed a campaign`).toBeGreaterThan(0);
  });
  it("paired control: every seed whose decided house campaigns with vote counting OFF starts none with it ON (so the owner and target are eligible and the gate is what stops it)", () => {
    const offFormed = seeds.filter((seed) => campaignForms(seed, "decided", false));
    expect(offFormed.length, "without vote counting the decided house still campaigns on some seeds").toBeGreaterThan(0);
    for (const seed of offFormed) expect(campaignForms(seed, "decided", true), `seed ${seed}: the same decided house, vote counting on`).toBe(false);
  });
});
