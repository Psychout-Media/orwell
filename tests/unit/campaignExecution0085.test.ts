import { flagDefaultOn } from "../../src/domain/flagDefaults";
import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import type { Campaign } from "../../src/engine/campaigns";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0085 Phase B2 — the LIVE campaign layer on the adapter. SELF-GATED (default off ⇒ no-op,
 * byte-identical); when enabled it forms/advances campaigns on a dedicated rng, diffuses `knownTo`, and
 * exposes the bounded per-listener tilt. Roles only (a schemer, a threat, an ally).
 */

function liveHouse(seed: number): { session: GameSessionAdapter; rel: RelationshipModel; ids: EntityId[] } {
  const rel = new RelationshipModel(0.5);
  const session = new GameSessionAdapter(rel);
  session.createCharacter({ playerName: "The Player", seed });
  const ids = (session.snapshot().house?.npcs ?? []).map((n) => n.id);
  return { session, rel, ids };
}
const camps = (s: GameSessionAdapter): Campaign[] => (s as unknown as { campaigns: Campaign[] }).campaigns;

describe("0085 B2 — the campaign layer when EXPLICITLY OFF (byte-identical)", () => {
  it("campaignTick is a no-op when disabled — no campaign forms, no draws", () => {
    const { session, rel, ids } = liveHouse(11);
    rel.edge(ids[0]!, ids[1]!).threat = 0.9; // a strong threat that WOULD seed a campaign if enabled
    session.setCampaignsEnabled(false); // explicit OFF (default flip 2026-11-03)
    session.campaignTick();
    expect(camps(session)).toHaveLength(0);
  });
});

describe("0085 B2 — when enabled, campaigns form, advance, and diffuse", () => {
  it("a strong threat read seeds an evict campaign that accrues progress over ticks", () => {
    const { session, rel, ids } = liveHouse(12);
    rel.edge(ids[0]!, ids[1]!).threat = 0.85;
    session.setCampaignsEnabled(true);

    session.campaignTick();
    const formed = camps(session).find((c) => c.owners[0] === ids[0]);
    expect(formed, "an evict campaign formed").toBeTruthy();
    expect(formed!).toMatchObject({ goal: "evict", target: ids[1], status: "active" });
    const p1 = formed!.progress;
    expect(p1).toBeGreaterThan(0);

    session.campaignTick();
    const p2 = camps(session).find((c) => c.owners[0] === ids[0])!.progress;
    expect(p2).toBeGreaterThan(p1); // it builds the more it's worked
  });

  it("a lobby move diffuses the belief to an ally (knownTo grows) — symmetric perspective", () => {
    const { session, rel, ids } = liveHouse(13);
    rel.edge(ids[0]!, ids[1]!).threat = 0.85;
    rel.edge(ids[0]!, ids[2]!).affinity = 0.9; // the owner's closest ally — the lobby lands here first
    session.setCampaignsEnabled(true);
    session.campaignTick();
    const c = camps(session).find((x) => x.owners[0] === ids[0])!;
    expect(c.knownTo).toContain(ids[0]); // the owner always knows
    expect(c.knownTo).toContain(ids[2]); // the lobbied ally now knows
    expect(c.knownTo).not.toContain(ids[3]); // an un-lobbied houseguest does not
  });

  it("survives a snapshot/restore with progress + knownTo intact (accumulates)", () => {
    const { session, rel, ids } = liveHouse(14);
    rel.edge(ids[0]!, ids[1]!).threat = 0.85;
    session.setCampaignsEnabled(true);
    session.campaignTick();
    session.campaignTick();
    const before = camps(session);
    const revived = new GameSessionAdapter();
    revived.restore(session.snapshot());
    expect(camps(revived)).toEqual(before);
  });

  it("the live campaign produces a per-listener tilt — aware voters only, scaling with progress", () => {
    const { session, rel, ids } = liveHouse(20);
    rel.edge(ids[0]!, ids[1]!).threat = 0.85; // owner ids[0] wants ids[1] (the target) out
    rel.edge(ids[0]!, ids[2]!).affinity = 0.95; // ids[2] is the closest ally — the lobby reaches them
    session.setCampaignsEnabled(true);
    session.setVoteCountEnabled(false); session.setMoodCampaignEnabled(false); session.setCampaignMemoryEnabled(false); session.setNpcTellsEnabled(false); // explicit OFF: these default ON now and gate/alter campaign formation
    const tiltFor = (target: EntityId, voter: EntityId): number =>
      (session as unknown as { campaignTiltFor(t: EntityId, v: EntityId): number }).campaignTiltFor(target, voter);

    session.campaignTick();
    const [target, ally, stranger, other] = [ids[1]!, ids[2]!, ids[8]!, ids[3]!];
    expect(tiltFor(target, ally)).toBeGreaterThan(0); // an AWARE voter is pushed against the target
    expect(tiltFor(target, stranger)).toBe(0); // an UNAWARE voter is not (symmetric perspective)
    expect(tiltFor(other, ally)).toBe(0); // and only against the campaign's actual target

    const t1 = tiltFor(target, ally);
    session.campaignTick();
    session.campaignTick();
    expect(tiltFor(target, ally)).toBeGreaterThan(t1); // the push grows as the campaign builds progress
  });

  it("re-plans when the owner is nominated — pivots to self-protect (never vanishes)", () => {
    const { session, rel, ids } = liveHouse(15);
    rel.edge(ids[0]!, ids[1]!).threat = 0.85;
    session.setCampaignsEnabled(true);
    session.campaignTick();
    expect(camps(session).find((c) => c.owners[0] === ids[0])!.goal).toBe("evict");
    // Put the owner on the block, then tick: the campaign pivots rather than disappearing.
    (session as unknown as { ceremony: { nominees: EntityId[] } }).ceremony.nominees = [ids[0]!];
    session.campaignTick();
    const after = camps(session).find((c) => c.owners[0] === ids[0]);
    expect(after?.goal).toBe("protect");
  });
});
