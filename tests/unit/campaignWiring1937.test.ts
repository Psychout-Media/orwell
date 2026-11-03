import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import { newLiveSeason, advance, type SeasonCtx, type LiveSeasonState } from "../../src/engine/liveSeason";
import type { Campaign } from "../../src/engine/campaigns";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * #1937 WIRING — the pure helpers are pinned in `campaignPush1937.test.ts`; THESE tests fail if the call sites in
 * `liveSeason.ts` / `GameSessionAdapter.ts` are removed (deleting a wiring line must turn something red):
 *   - the NPC HOH's nominations read `ctx.campaignPushFor`,
 *   - the NPC veto holder's save read takes the bias,
 *   - the replacement nominee reads it,
 *   - `protect` nets against `evict` in `campaignTiltFor` (the scramble),
 *   - the NPC campaign re-planner leaves a player's declared campaign alone.
 * Roles only — no names.
 */

const hoh = npc(7);
const active = [PLAYER, hoh, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)];

function ctxWith(rel: RelationshipModel, push?: (t: EntityId, d: EntityId) => number): SeasonCtx {
  return {
    player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel,
    ...(push ? { campaignPushFor: push } : {}),
  };
}

function houseRel(): RelationshipModel {
  const rel = new RelationshipModel(0.5);
  rel.edge(hoh, npc(1)).threat = 0.6;
  rel.edge(hoh, npc(2)).threat = 0.5;
  rel.edge(hoh, npc(3)).threat = 0.4;
  rel.edge(hoh, npc(4)).threat = 0.15;
  return rel;
}

describe("the NPC HOH's nominations read the campaign push", () => {
  const nominate = (push?: (t: EntityId, d: EntityId) => number): EntityId[] => {
    const s = newLiveSeason(active);
    s.beat = "nominations";
    s.hoh = hoh;
    const ev = advance(s, ctxWith(houseRel(), push), new SeededRandom(3));
    expect(ev?.beat).toBe("nominations");
    return [...(s.nominees ?? [])];
  };

  it("an exaggerated evict push on the lowest read pulls them onto the block; absent, they are not", () => {
    expect(nominate()).not.toContain(npc(4));
    // The decider passed is the HOH — the wiring must call the provider as (target, hoh).
    expect(nominate((t, d) => (t === npc(4) && d === hoh ? 5 : 0))).toContain(npc(4));
  });

  it("a protect push on the top target takes them off the target seat", () => {
    expect(nominate()[0]).toBe(npc(1));
    expect(nominate((t, d) => (t === npc(1) && d === hoh ? -5 : 0))[0]).not.toBe(npc(1));
  });
});

describe("the NPC veto holder's save and the replacement read the campaign push", () => {
  /** Veto ceremony: holder npc3 (not nominated) trusts both nominees; npc1 slightly more. */
  const ceremony = (push?: (t: EntityId, d: EntityId) => number): LiveSeasonState => {
    const rel = houseRel();
    const holder = npc(3);
    rel.edge(holder, npc(1)).trust = 0.95;
    rel.edge(holder, npc(2)).trust = 0.85;
    const s = newLiveSeason(active);
    s.beat = "veto-ceremony";
    s.hoh = hoh;
    s.nominees = [npc(1), npc(2)];
    s.vetoHolder = holder;
    advance(s, ctxWith(rel, push), new SeededRandom(5));
    return s;
  };

  it("an evict campaign on the holder's favourite nominee flips whom they save", () => {
    expect(ceremony().saved).toBe(npc(1));
    expect(ceremony((t, d) => (t === npc(1) && d === npc(3) ? 0.25 : 0)).saved).toBe(npc(2));
  });

  it("a protect campaign on the other nominee also flips the save toward them", () => {
    expect(ceremony((t, d) => (t === npc(2) && d === npc(3) ? -0.25 : 0)).saved).toBe(npc(2));
  });

  it("the replacement nominee reads the push (decider = the HOH)", () => {
    const base = ceremony().replacement;
    const pushed = ceremony((t, d) => (t === npc(5) && d === hoh ? 5 : 0)).replacement;
    expect(base).toBeDefined();
    expect(base).not.toBe(npc(5));
    expect(pushed).toBe(npc(5));
  });
});

describe("the adapter: the scramble nets protect against evict, and the re-planner leaves a player's campaign alone", () => {
  function liveHouse(seed: number) {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.createCharacter({ playerName: "The Player", seed });
    const ids = (session.snapshot().house?.npcs ?? []).map((n) => n.id);
    return { session, rel, ids };
  }
  type Priv = { campaigns: Campaign[]; campaignTiltFor(t: EntityId, v: EntityId): number; ceremony: { nominees: EntityId[] } };
  const p = (s: GameSessionAdapter): Priv => s as unknown as Priv;
  const camp = (over: Partial<Campaign>): Campaign => ({
    id: "c", owners: [npc(1)], goal: "evict", target: npc(2), plan: ["lobby"], progress: 1, horizon: "week", status: "active",
    startedBeat: 0, deadlineBeat: 99, confidence: 0.5, knownTo: [npc(1), npc(3)], ...over,
  });

  it("a protect campaign on the nominee lowers an aware voter's push to evict them (and the player's protect counts per the ruling)", () => {
    const { session, ids } = liveHouse(61);
    session.setCampaignsEnabled(true);
    const [owner, target, voter, protector] = [ids[0]!, ids[1]!, ids[2]!, ids[3]!];
    p(session).campaigns = [camp({ id: "e", owners: [owner], target, knownTo: [owner, voter] })];
    const evictOnly = p(session).campaignTiltFor(target, voter);
    expect(evictOnly).toBeGreaterThan(0);
    p(session).campaigns = [
      camp({ id: "e", owners: [owner], target, knownTo: [owner, voter] }),
      camp({ id: "p", owners: [protector], goal: "protect", target, knownTo: [protector, voter] }),
    ];
    expect(p(session).campaignTiltFor(target, voter)).toBeLessThan(evictOnly); // the scramble: protect counters evict
    // The player's own protect campaign counts too (owner ruling 2026-11-03, CAMPAIGN_PUSH_INCLUDES_PLAYER_OWNED).
    p(session).campaigns = [
      camp({ id: "e", owners: [owner], target, knownTo: [owner, voter] }),
      camp({ id: "pp", owners: [PLAYER], goal: "protect", target, knownTo: [PLAYER, voter] }),
    ];
    expect(p(session).campaignTiltFor(target, voter)).toBeLessThan(evictOnly);
    // An UNAWARE voter is not swayed by the protect campaign.
    p(session).campaigns = [
      camp({ id: "e", owners: [owner], target, knownTo: [owner, voter] }),
      camp({ id: "p", owners: [protector], goal: "protect", target, knownTo: [protector] }),
    ];
    expect(p(session).campaignTiltFor(target, voter)).toBeCloseTo(evictOnly);
  });

  it("the NPC re-planner leaves a nominated PLAYER's declared evict campaign as evict (it used to flip it to protect)", () => {
    const { session, ids } = liveHouse(62);
    session.setCampaignsEnabled(true);
    p(session).campaigns = [camp({ id: "mine", owners: [PLAYER], goal: "evict", target: ids[1]!, knownTo: [PLAYER] })];
    p(session).ceremony.nominees = [PLAYER];
    session.campaignTick();
    const mine = p(session).campaigns.find((c) => c.id === "mine");
    expect(mine?.goal).toBe("evict");
  });
});
