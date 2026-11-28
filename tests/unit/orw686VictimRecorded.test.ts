import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, type EntityId } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import type { Deal } from "../../src/domain/deal";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";

/**
 * ORW-686 (the victim recorded from the real event). A betrayal rumor that traces to a recorded betrayal (a broken deal, played through the real
 * binding-action reconcile) carries WHO WAS BETRAYED, so the victim branch fires in play: the betrayed folds 'targets me', everyone else distrusts
 * the betrayer. A rumor with no recorded betrayal behind it stays victim-less. UNIT: the deal is made and broken through private seams and the house is seated by hand (ORW-813: the
 * played checks are in tests/realpath/orw686VictimRecorded.test.ts). Roles only: the betrayer (the player), the betrayed (v), a bystander (o), a teller (t).
 */
type Seam = {
  live: { playedGame?: boolean; week: number; beliefs?: Record<string, BeliefClaim[]> };
  deals: { make(parties: [string, string], kind: string, terms: string, madeEventId?: string, madeWeek?: number): Deal };
  reconcileDeals(a: { actor: string; kind: string; targets: string[] }): void;
  noteTargetsMeClaims(h: string): void;
  rel: { edge(a: string, b: string): { trust: number } };
  presence: Map<string, string>;
  presenceZone: Map<string, string>;
};

function played(seed: number, breakIt: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`orw686-victim-rec-${seed}-${breakIt}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.advanceGame(); sb.session.advanceGame();
  sb.session.setHeardAboutMeEnabled(true);
  const s = sb.session as unknown as Seam;
  s.live.playedGame = true;
  const [v, o, t] = sb.session.livingIds().filter((id) => id !== PLAYER) as [EntityId, EntityId, EntityId];
  if (breakIt) {
    const deal = s.deals.make([PLAYER, v], "safety", "a safety deal", undefined, s.live.week);
    s.reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [v] }); // the real break: the player nominates the one they promised safety
    expect(deal.status).toBe("broken");
    expect(deal.brokenBy).toBe(PLAYER);
  }
  s.presence = new Map<string, string>([[PLAYER, "backyard"], [v, "backyard"], [o, "backyard"], [t, "backyard"]]);
  s.presenceZone = new Map<string, string>([[PLAYER, "patio"], [v, "patio"], [o, "patio"], [t, "patio"]]); // ORW-1167 (drift): a premiere comp gathers the house in the yard whatever the test seats, and earshot now drops a far-zone listener; the four stand in the yard in ONE zone so the test stays about the rumor
  sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, t, v, o], content: "one houseguest tells the others what they believe about the player", kind: "gossip", heardAboutMe: { nature: "betrayal", from: t } } as never);
  return { sb, s, v, o, t };
}
const rumorsOf = (s: Seam, holder: string): BeliefClaim[] => (s.live.beliefs?.[holder] ?? []).filter((c) => c.kind === "heard-rumor" && c.nature === "betrayal" && c.origin === "told");

describe("a betrayal rumor records its victim from the real betrayal event (unit: the betrayal set up by hand)", () => {
  it("a real broken deal names the betrayed on the rumor; the betrayed folds 'targets me', a bystander distrusts the betrayer", () => {
    let proved = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { s, v, o } = played(seed, true);
      const toV = rumorsOf(s, v).find((c) => c.subject === PLAYER);
      const toO = rumorsOf(s, o).find((c) => c.subject === PLAYER);
      if (!toV || !toO) continue; // a mishearing put the rumor on someone else: not this case
      expect(toV.object).toBe(v);
      expect(toO.object).toBe(v);
      const trustO = s.rel.edge(o, PLAYER).trust;
      const trustV = s.rel.edge(v, PLAYER).trust;
      s.noteTargetsMeClaims(v); s.noteTargetsMeClaims(o);
      s.noteTargetsMeClaims(v); s.noteTargetsMeClaims(o); // idempotent
      expect((s.live.beliefs?.[v] ?? []).filter((c) => c.kind === "targets-me" && c.subject === PLAYER)).toHaveLength(1);
      expect(s.rel.edge(v, PLAYER).trust).toBe(trustV); // the betrayed folds no told-rumor distrust
      expect((s.live.beliefs?.[o] ?? []).filter((c) => c.kind === "targets-me")).toEqual([]);
      expect(trustO - s.rel.edge(o, PLAYER).trust).toBeGreaterThan(0);
      expect(trustO - s.rel.edge(o, PLAYER).trust).toBeLessThan(0.1);
      proved++;
    }
    expect(proved).toBeGreaterThan(0);
  });

  it("a rumor with no recorded betrayal behind it stays victim-less, and a headless season never records one", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { s, v, o } = played(seed, false);
      for (const h of [v, o]) for (const c of rumorsOf(s, h)) expect(c.object).toBeUndefined();
    }
    const sb = new GameSessionRegistry().sandboxFor("orw686-victim-rec-headless");
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    sb.session.advanceGame(); sb.session.advanceGame();
    sb.session.setHeardAboutMeEnabled(true);
    const s = sb.session as unknown as Seam;
    s.live.playedGame = false;
    const [v, o, t] = sb.session.livingIds().filter((id) => id !== PLAYER) as [EntityId, EntityId, EntityId];
    s.deals.make([PLAYER, v], "safety", "a safety deal", undefined, s.live.week);
    s.reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [v] });
    s.presence = new Map<string, string>([[PLAYER, "backyard"], [v, "backyard"], [o, "backyard"], [t, "backyard"]]);
    s.presenceZone = new Map<string, string>([[PLAYER, "patio"], [v, "patio"], [o, "patio"], [t, "patio"]]); // ORW-1167 (drift): one earshot zone
  s.presenceZone = new Map<string, string>([[PLAYER, "patio"], [v, "patio"], [o, "patio"], [t, "patio"]]); // ORW-1167 (drift): a premiere comp gathers the house in the yard whatever the test seats, and earshot now drops a far-zone listener; the four stand in the yard in ONE zone so the test stays about the rumor
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, t, v, o], content: "a tell", kind: "gossip", heardAboutMe: { nature: "betrayal", from: t } } as never);
    for (const h of [v, o]) for (const c of rumorsOf(s, h)) expect(c.object).toBeUndefined();
  });

  it("the victim survives a save and restore (the claim is the record)", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { sb, s, v } = played(seed, true);
      if (!rumorsOf(s, v).some((c) => c.subject === PLAYER)) continue;
      const snap = JSON.parse(JSON.stringify(sb.session.snapshot()));
      const sb2 = new GameSessionRegistry().sandboxFor(`orw686-victim-rec-restored-${seed}`);
      sb2.session.restore(snap);
      const s2 = sb2.session as unknown as Seam;
      expect(rumorsOf(s2, v).find((c) => c.subject === PLAYER)?.object).toBe(v);
      expect(sessionCoreSupersetViolation(snap as never, snap as never)).toBeNull();
      return;
    }
    throw new Error("no seed produced an un-misheard rumor");
  });
});
