import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import type { UserSandbox } from "../../src/composition/registry";

/**
 * Feature 0123 — NPC-initiated deal offers. A motivated houseguest floats the PLAYER a deal at a lull
 * (the NPC->player counterpart of makeDeal). Drives a real season (no LLM) and proves: an offer surfaces
 * as Vault-free OPEN STATE (`openDealOffer`) — never a pending card, never blocking the week (PO ruling
 * 2026-11-01); accept makes a real player deal; decline cools the rebuffed NPC; an unanswered offer LAPSES
 * at week's end with an NPC-dependent (volatility-scaled) cooling; the offer is player-witnessed (not
 * hidden); flag off is byte-identical; seed-deterministic. Roles only — no names.
 */

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

function newGame(user: string, seed: number, offersOn: boolean): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setNpcDealOffersEnabled(offersOn);
  return sb;
}

type Offer = NonNullable<ReturnType<GameSession["getGameState"]>["openDealOffer"]>;

/** Drive advanceGame (resolving ceremony pendings) until an NPC deal offer stands; return it or null. */
function driveToOffer(sb: UserSandbox, maxSteps = 200): Offer | null {
  for (let i = 0; i < maxSteps; i++) {
    const v = sb.session.advanceGame();
    const o = sb.session.getGameState().openDealOffer;
    if (o) return o;
    if (v.pending) resolveLegally(sb.session, v.pending);
    if (v.finished) return null;
  }
  return null;
}

describe("0123 — a houseguest floats the player a deal, resolved accept/decline", () => {
  it("an offer surfaces as open state naming who, kind, and terms — never a pending card", () => {
    const sb = newGame("offer-basic", 7, true);
    const offer = driveToOffer(sb);
    expect(offer, "an NPC offered the player a deal").not.toBeNull();
    expect(offer!.from.id).not.toBe(PLAYER); // an NPC floated it
    expect(["safety", "final-two"]).toContain(offer!.kind);
    expect(offer!.terms.length).toBeGreaterThan(0);
    // PO ruling 2026-11-01: no pop-up — the offer is never a pending decision (status and state agree).
    expect(sb.session.getGameState().pending?.kind).not.toBe("deal-offer");
    expect(sb.session.gameStatus().pending?.kind).not.toBe("deal-offer");
    expect(sb.session.gameStatus().openDealOffer?.from.id).toBe(offer!.from.id);
    // Vault-safe: the approach is a PLAYER-WITNESSED event (not hidden) — the NPC came to them.
    const approach = sb.engine.events.queryAll().find((e) => e.content.includes("float") && e.content.includes("deal"));
    expect(approach, "the approach was recorded").toBeDefined();
    expect(approach!.hidden).toBeFalsy();
    expect(approach!.witnessSet.includes(PLAYER)).toBe(true);
  });

  it("accepting the offer makes a REAL player↔NPC deal on the board", () => {
    const sb = newGame("offer-accept", 7, true);
    const offer = driveToOffer(sb);
    expect(offer).not.toBeNull();
    const from = offer!.from.id;
    const before = (sb.session.getGameState().deals ?? []).length;
    sb.session.submitDecision({ kind: "deal-offer", vote: "accept" });
    const deals = sb.session.getGameState().deals ?? [];
    expect(deals.length).toBe(before + 1);
    // DealView.parties are { id, name } refs — the new deal binds the player and the offering NPC.
    const partyIds = (d: (typeof deals)[number]): string[] =>
      d.parties.map((p) => (typeof p === "string" ? p : p.id));
    expect(deals.some((d) => partyIds(d).includes(PLAYER) && partyIds(d).includes(from))).toBe(true);
    // The offer is consumed — nothing stands after answering.
    expect(sb.session.getGameState().openDealOffer).toBeUndefined();
  });

  it("declining the offer makes NO deal and cools the rebuffed houseguest (hidden)", () => {
    const sb = newGame("offer-decline", 7, true);
    const offer = driveToOffer(sb);
    expect(offer).not.toBeNull();
    const from = offer!.from.id;
    const beforeThreat = sb.engine.relationships.edge(from, PLAYER).threat;
    const beforeDeals = (sb.session.getGameState().deals ?? []).length;
    sb.session.submitDecision({ kind: "deal-offer", vote: "decline" });
    expect((sb.session.getGameState().deals ?? []).length).toBe(beforeDeals); // no deal created
    // The rebuff is a small directed cooling — the NPC reads the player as a bit more of a threat.
    expect(sb.engine.relationships.edge(from, PLAYER).threat).toBeGreaterThan(beforeThreat);
  });

  it("a malformed/missing vote is a no-op — the offer stands and the NPC is not cooled", () => {
    const sb = newGame("offer-malformed", 7, true);
    const offer = driveToOffer(sb);
    expect(offer).not.toBeNull();
    const from = offer!.from.id;
    const beforeThreat = sb.engine.relationships.edge(from, PLAYER).threat;
    const beforeDeals = (sb.session.getGameState().deals ?? []).length;
    // A garbled/stale client call with no explicit accept/decline must NOT consume the offer or cool the NPC.
    sb.session.submitDecision({ kind: "deal-offer" } as never);
    expect(sb.engine.relationships.edge(from, PLAYER).threat).toBe(beforeThreat); // no hidden cooling
    expect((sb.session.getGameState().deals ?? []).length).toBe(beforeDeals);     // no deal created
    // The offer still stands and can be answered properly afterward.
    expect(sb.session.getGameState().openDealOffer?.from.id).toBe(from);
  });

  it("with the layer OFF, no offer is ever floated (byte-identical)", () => {
    const sb = newGame("offer-off", 7, false);
    const offer = driveToOffer(sb, 200);
    expect(offer).toBeNull();
    expect(sb.engine.events.queryAll().some((e) => e.content.includes("float") && e.content.includes("deal"))).toBe(false);
  });

  it("is seed-deterministic — the same seed floats the same offer (from + kind)", () => {
    const a = driveToOffer(newGame("offer-det", 11, true));
    const b = driveToOffer(newGame("offer-det", 11, true));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.from.id).toBe(b!.from.id);
    expect(a!.kind).toBe(b!.kind);
  });
});

describe("0123 — the offer's kind is grounded in the NPC's real read", () => {
  it("a houseguest who strongly bonds with the player floats a FINAL-TWO offer", () => {
    const sb = newGame("offer-grounded", 7, true);
    // Make one NPC read the player as a very strong ally so they are the most-motivated offerer.
    const ally = sb.session.livingIds().find((id) => id !== PLAYER)!;
    sb.engine.relationships.edge(ally, PLAYER).trust = 0.95;
    sb.engine.relationships.edge(ally, PLAYER).affinity = 0.95;
    const offer = driveToOffer(sb);
    expect(offer).not.toBeNull();
    // The strongest-bond NPC offers, and a strong bond ⇒ a final-two ask (grounded, not invented).
    expect(offer!.from.id).toBe(ally);
    expect(offer!.kind).toBe("final-two");
  });
});

describe("0123 (PO ruling 2026-11-01) — a floated offer never blocks the week, and lapses unanswered", () => {
  it("the week keeps moving while an offer stands (no freeze)", () => {
    const sb = newGame("offer-nonblocking", 7, true);
    const offer = driveToOffer(sb);
    expect(offer).not.toBeNull();
    const seq0 = sb.session.gameStatus().beatSeq;
    let moved = false;
    for (let i = 0; i < 6 && !moved; i++) {
      const v = sb.session.advanceGame();
      expect(v.pending?.kind, "a floated offer is never a pending card").not.toBe("deal-offer");
      if (v.pending) resolveLegally(sb.session, v.pending);
      moved = sb.session.gameStatus().beatSeq > seq0;
    }
    expect(moved, "advanceGame still moves the game with an unanswered offer standing").toBe(true);
  });

  it("one offer at a time (ORW-86): while an offer stands in its week, no second offer replaces or joins it", () => {
    for (const seed of [7, 8, 9]) {
      const sb = newGame(`offer-single-${seed}`, seed, true);
      const offer = driveToOffer(sb);
      if (!offer) continue;
      const week = sb.session.getGameState().week;
      const floats = () => sb.engine.events.queryAll().filter((e) => e.content.includes("float") && e.content.includes("deal")).length;
      const before = floats();
      for (let i = 0; i < 10; i++) {
        const v = sb.session.advanceGame();
        if (v.pending) resolveLegally(sb.session, v.pending);
        const cur = sb.session.getGameState();
        if (cur.week !== week || !cur.openDealOffer) break;
        expect(cur.openDealOffer.from.id, "the standing offer is never replaced by another").toBe(offer.from.id);
        expect(cur.openDealOffer.terms).toBe(offer.terms);
        expect(floats(), "no second approach was recorded while one stands").toBe(before);
      }
    }
  });

  it("an unanswered offer lapses when the week rolls — no deal, recorded as player-witnessed", () => {
    const sb = newGame("offer-lapse", 7, true);
    const offer = driveToOffer(sb);
    expect(offer).not.toBeNull();
    const beforeDeals = (sb.session.getGameState().deals ?? []).length;
    for (let i = 0; i < 400 && sb.session.getGameState().openDealOffer; i++) {
      const v = sb.session.advanceGame();
      if (v.pending) resolveLegally(sb.session, v.pending);
      if (v.finished) break;
    }
    expect(sb.session.getGameState().openDealOffer, "the offer lapsed").toBeUndefined();
    expect(sb.session.getGameState().week).toBeGreaterThan(offer!.madeWeek);
    const lapse = sb.engine.events.queryAll().find((e) => e.content.includes("lapsed unanswered"));
    expect(lapse, "the lapse was recorded").toBeDefined();
    expect(lapse!.hidden).toBeFalsy();
    expect(lapse!.witnessSet.includes(PLAYER)).toBe(true);
    // No deal was made from the lapsed offer: none binds the player and that offerer.
    const deals = sb.session.getGameState().deals ?? [];
    expect(deals.length).toBeGreaterThanOrEqual(beforeDeals);
    expect(
      deals.some((d) => {
        const ids = d.parties.map((p) => (typeof p === "string" ? p : p.id));
        return ids.includes(PLAYER) && ids.includes(offer!.from.id);
      }),
    ).toBe(false);
  });

  it("how hard a houseguest takes being ignored depends on their temper (volatility-scaled)", () => {
    // Same game, same offer, same beat — only the offerer's hidden volatility differs. The offer is
    // back-dated one week so the very next advance lapses it.
    const lapseDelta = (vol: number): number => {
      const sb = newGame("offer-temper", 7, true);
      const offer = driveToOffer(sb)!;
      const snap = sb.session.snapshot();
      snap.live!.dealOffer!.madeWeek = snap.live!.week - 1;
      snap.house!.npcs.find((n) => n.id === offer.from.id)!.soul.volatility = vol;
      sb.session.restore(snap);
      const before = sb.engine.relationships.edge(offer.from.id, PLAYER).threat;
      sb.session.advanceGame();
      expect(sb.session.getGameState().openDealOffer).toBeUndefined();
      return sb.engine.relationships.edge(offer.from.id, PLAYER).threat - before;
    };
    const calm = lapseDelta(0.05);
    const hothead = lapseDelta(0.95);
    expect(hothead).toBeGreaterThan(calm);
    expect(calm).toBeGreaterThanOrEqual(0);
  });
});

describe("0123 — a deal-offer answer after the season ends binds nothing", () => {
  it("submitDecision deal-offer is a no-op once the season is finished", () => {
    const sb = newGame("offer-postseason", 7, true);
    const offer = driveToOffer(sb)!;
    const snap = sb.session.snapshot();
    snap.live!.finished = true;
    sb.session.restore(snap);
    const before = (sb.session.getGameState().deals ?? []).length;
    sb.session.submitDecision({ kind: "deal-offer", vote: "accept" });
    expect((sb.session.getGameState().deals ?? []).length).toBe(before);
    expect(offer.from.id).not.toBe(PLAYER);
  });
});

describe("0123 — an offer whose party has left is void (Greptile #1911)", () => {
  it("an offer from a houseguest who is then evicted can neither stand nor be accepted", () => {
    const sb = newGame("offer-evicted", 7, true);
    const offer = driveToOffer(sb)!;
    const snap = sb.session.snapshot();
    snap.live!.evictionOrder = [...snap.live!.evictionOrder, offer.from.id];
    sb.session.restore(snap);
    const before = (sb.session.getGameState().deals ?? []).length;
    sb.session.submitDecision({ kind: "deal-offer", vote: "accept" });
    const deals = sb.session.getGameState().deals ?? [];
    expect(deals.length).toBe(before);
    expect(sb.session.getGameState().openDealOffer).toBeUndefined();
  });
});
