import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import { nominationStrategy, replacementPick } from "../../src/engine/season";
import { campaignPushFor, CAMPAIGN, CAMPAIGN_PUSH_INCLUDES_PLAYER_OWNED, type Campaign } from "../../src/engine/campaigns";
import { npc, PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * #1937 — NPC campaigns (0085) now also push NOMINATIONS, the REPLACEMENT nominee, the VETO save, and (via
 * `protect`) counter the eviction-vote tilt (the scramble). A bounded, signed, aware-only push: evict adds,
 * protect subtracts. Roles only — no names.
 */

const decider = npc(7);
const owner = npc(3);
const target = npc(1);
const infl = { persuasiveness: 1, susceptibility: 1 };
const deps = (over: Partial<Parameters<typeof campaignPushFor>[3]> = {}) => ({
  player: PLAYER, influenceOf: () => infl, trustOf: () => 1, ...over,
});
const camp = (over: Partial<Campaign>): Campaign => ({
  id: "c", owners: [owner], goal: "evict", target, plan: ["lobby"], progress: 1, horizon: "week", status: "active",
  startedBeat: 0, deadlineBeat: 9, confidence: 0.5, knownTo: [owner, decider], ...over,
});

describe("campaignPushFor — the signed, bounded, aware-only push", () => {
  it("evict adds, protect subtracts, each the character-mediated campaign tilt", () => {
    const evict = campaignPushFor([camp({})], target, decider, deps());
    const protect = campaignPushFor([camp({ goal: "protect" })], target, decider, deps());
    expect(evict).toBeCloseTo(CAMPAIGN.base);
    expect(protect).toBeCloseTo(-CAMPAIGN.base);
  });

  it("only a campaign the decider is AWARE of moves them (symmetric perspective)", () => {
    expect(campaignPushFor([camp({ knownTo: [owner] })], target, decider, deps())).toBe(0);
  });

  it("ignores other targets, inactive campaigns and non-push goals", () => {
    expect(campaignPushFor([camp({ target: npc(2) })], target, decider, deps())).toBe(0);
    expect(campaignPushFor([camp({ status: "won" })], target, decider, deps())).toBe(0);
    expect(campaignPushFor([camp({ goal: "build-alliance" }), camp({ goal: "discredit" })], target, decider, deps())).toBe(0);
  });

  it("skips the decider's OWN campaign (already in their own read — and no self-edge)", () => {
    expect(campaignPushFor([camp({ owners: [decider] })], target, decider, deps({ trustOf: () => { throw new Error("self-edge read"); } }))).toBe(0);
  });

  it("clamps the net to ±base however many campaigns pile on", () => {
    const many = [camp({ id: "a" }), camp({ id: "b", owners: [npc(4)] }), camp({ id: "c", owners: [npc(5)], knownTo: [npc(5), decider] }), camp({ id: "d", owners: [npc(6)], knownTo: [npc(6), decider] })];
    expect(campaignPushFor(many.map((c) => ({ ...c, knownTo: [...c.owners, decider] })), target, decider, deps())).toBeCloseTo(CAMPAIGN.base);
  });

  it("the player's own campaigns COUNT (owner ruling 2026-11-03), through the single switch", () => {
    expect(CAMPAIGN_PUSH_INCLUDES_PLAYER_OWNED).toBe(true);
    const mine = camp({ owners: [PLAYER], knownTo: [PLAYER, decider] });
    expect(campaignPushFor([mine], target, decider, deps())).toBeCloseTo(CAMPAIGN.base);
    expect(campaignPushFor([mine], target, decider, deps({ includePlayerOwned: false }))).toBe(0); // the switch off
    // …still bounded: the player's push can never exceed the same ±base cap, however many campaigns they stack.
    expect(Math.abs(campaignPushFor([mine, camp({ id: "m2", owners: [PLAYER], knownTo: [PLAYER, decider] })], target, decider, deps()))).toBeLessThanOrEqual(CAMPAIGN.base);
  });

  it("a BLOC campaign: the decider (or the player) being ANY owner, not just the first, counts as own / player-owned", () => {
    const bloc = camp({ owners: [owner, decider], knownTo: [owner, decider] });
    expect(campaignPushFor([bloc], target, decider, deps())).toBe(0); // a secondary owner is the decider: their own plan
    const playerBloc = camp({ owners: [owner, PLAYER], knownTo: [owner, PLAYER, decider] });
    expect(campaignPushFor([playerBloc], target, decider, deps({ includePlayerOwned: false }))).toBe(0); // the switch covers a bloc member
    expect(campaignPushFor([playerBloc], target, decider, deps({ includePlayerOwned: true }))).toBeCloseTo(CAMPAIGN.base);
  });

  it("is a lower trust / lower susceptibility ⇒ a smaller push (character-mediated)", () => {
    const full = campaignPushFor([camp({})], target, decider, deps());
    const gullible0 = campaignPushFor([camp({})], target, decider, deps({ influenceOf: (id) => (id === decider ? { persuasiveness: 1, susceptibility: 0 } : infl) }));
    expect(gullible0).toBe(0);
    expect(campaignPushFor([camp({})], target, decider, deps({ trustOf: () => 0 }))).toBeLessThan(full);
  });
});

/** A QUIET house: the HOH holds distinct private reads. */
function house(): { rel: RelationshipModel; active: EntityId[] } {
  const rel = new RelationshipModel(0.5);
  const hoh = decider;
  const active = [hoh, npc(1), npc(2), npc(3), npc(4)];
  rel.edge(hoh, npc(1)).threat = 0.6;
  rel.edge(hoh, npc(2)).threat = 0.5;
  rel.edge(hoh, npc(3)).threat = 0.4;
  rel.edge(hoh, npc(4)).threat = 0.15;
  return { rel, active };
}

describe("the push on nominations and the replacement", () => {
  it("absent ⇒ byte-identical; an evict push on the LOWEST read pulls them onto the block", () => {
    const { rel, active } = house();
    const base = nominationStrategy(decider, active, rel);
    expect(nominationStrategy(decider, active, rel, { campaignPush: () => 0 })).toEqual(base);
    // npc 4 is the lowest read and is NOT on the block without a push (the fixture discriminates the branch).
    expect(base).not.toContain(npc(4));
    // The plumbing is exercised with an exaggerated push; the real push is clamped to ±CAMPAIGN.base upstream.
    const pushed = nominationStrategy(decider, active, rel, { campaignPush: (t) => (t === npc(4) ? CAMPAIGN.base * 8 : 0) });
    expect(pushed).toContain(npc(4));
  });

  it("a protect push (negative) takes the top read off the block's target seat", () => {
    const { rel, active } = house();
    expect(nominationStrategy(decider, active, rel)[0]).toBe(npc(1)); // without a push npc 1 is the target
    const protectedTop = nominationStrategy(decider, active, rel, { campaignPush: (t) => (t === npc(1) ? -CAMPAIGN.base * 8 : 0) });
    expect(protectedTop[0]).not.toBe(npc(1));
  });

  it("the replacement honors the push too", () => {
    const { rel, active } = house();
    const options = [npc(2), npc(3), npc(4)];
    const without = replacementPick(decider, npc(1), options, active, rel);
    const withPush = replacementPick(decider, npc(1), options, active, rel, { campaignPush: (t) => (t === npc(4) ? CAMPAIGN.base * 8 : 0) });
    expect(without).toBe(npc(2)); // without a push the top read is named (the fixture discriminates)
    expect(withPush).toBe(npc(4));
  });
});

describe("the veto-save bias", () => {
  it("absent ⇒ unchanged; a protect bias can lift a nominee over the save threshold", () => {
    const rel = new RelationshipModel(0.5);
    const holder = npc(1);
    const nominee = npc(2);
    const plain = rel.chooseVetoSave(holder, [nominee]);
    expect(rel.chooseVetoSave(holder, [nominee], () => 0)).toBe(plain);
    expect(rel.chooseVetoSave(holder, [nominee], () => 5)).toBe(nominee);
    expect(rel.chooseVetoSave(holder, [nominee], () => -5)).toBeUndefined();
  });
});

describe("the adapter wiring (live, campaigns on)", () => {
  function liveHouse(seed: number) {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.createCharacter({ playerName: "The Player", seed });
    const ids = (session.snapshot().house?.npcs ?? []).map((n) => n.id);
    return { session, rel, ids };
  }
  const camps = (s: GameSessionAdapter): Campaign[] => (s as unknown as { campaigns: Campaign[] }).campaigns;
  const ctxOf = (s: GameSessionAdapter) => (s as unknown as { ctx(): { campaignPushFor?: (t: EntityId, d: EntityId) => number } }).ctx();

  it("the provider is absent with campaigns OFF (flags-off is byte-identical)", () => {
    const { session } = liveHouse(31);
    session.setCampaignsEnabled(false); // explicit: the shipped profile (ORWELL_CAMPAIGNS=1) must not change this fixture
    expect(ctxOf(session).campaignPushFor).toBeUndefined();
  });

  it("with campaigns ON: an aware decider is pushed, an unaware one and the PLAYER are not", () => {
    const { session, rel, ids } = liveHouse(32);
    rel.edge(ids[0]!, ids[1]!).threat = 0.85;
    rel.edge(ids[0]!, ids[2]!).affinity = 0.95; // the lobby reaches ids[2]
    session.setCampaignsEnabled(true);
    session.setVoteCountEnabled(false); session.setMoodCampaignEnabled(false); session.setCampaignMemoryEnabled(false); session.setNpcTellsEnabled(false); // explicit OFF: these default ON now and gate/alter campaign formation
    session.campaignTick();
    const push = ctxOf(session).campaignPushFor!;
    expect(camps(session).some((c) => c.goal === "evict" && c.target === ids[1])).toBe(true);
    expect(push(ids[1]!, ids[2]!)).toBeGreaterThan(0); // aware ⇒ pushed toward nominating the target
    expect(push(ids[1]!, ids[8]!)).toBe(0); // unaware ⇒ no push
    expect(push(ids[1]!, PLAYER)).toBe(0); // the player's own seat is never modulated
    expect(push(ids[1]!, ids[0]!)).toBe(0); // the owner's own campaign is not double-counted
  });
});
