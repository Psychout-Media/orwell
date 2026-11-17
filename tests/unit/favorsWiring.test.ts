import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { FAVOR } from "../../src/engine/favorConstants";
import { voteChoice, VOTE_TERM_NAMES } from "../../src/engine/liveSeason";
import { playedSession, sessionWithRoll, warm, cold, setEdge, ledger } from "../support/favorsSeam";
import { RelationshipModel } from "../../src/engine/relationships";
import { GameSessionRegistry } from "../../src/composition/registry";

/** 0171: the wiring through the real adapter. Roles only. */
describe("called-in favors at a close vote", () => {
  it("a warm debtor repays, shielding the holder at that vote; the favor is cleared and calledBeat set", () => {
    const p = sessionWithRoll("honor");
    const [h, d, o] = p.npcs as [string, string, string];
    p.session.recordFavor({ owedBy: d, owedTo: h, origin: "deal:1" });
    warm(p, d, h);
    p.seam.favorsAtTally([h, o], [d]);
    expect(ledger(p)[0]).toMatchObject({ state: "repaid" });
    expect((p.session as unknown as { favorShieldFor(n: string, v: string): number }).favorShieldFor(h, d)).toBeGreaterThan(0);
    expect((p.session as unknown as { favorShieldFor(n: string, v: string): number }).favorShieldFor(o, d)).toBe(0);
  });
  it("is called in only when the count is close", () => {
    const p = sessionWithRoll("honor");
    const [h, d, o] = p.npcs as [string, string, string];
    p.session.recordFavor({ owedBy: d, owedTo: h, origin: "deal:1" });
    p.seam.voteStillInDoubt = () => false;
    p.seam.favorsAtTally([h, o], [d]);
    expect(ledger(p)[0]).toMatchObject({ state: "owed" });
    expect(ledger(p)[0]!.calledBeat).toBeUndefined();
  });
  it("a debtor who cannot vote is not asked, and the player's own debts are never called", () => {
    const p = sessionWithRoll("honor");
    const [h, d, o] = p.npcs as [string, string, string];
    p.session.recordFavor({ owedBy: d, owedTo: h, origin: "deal:1" });
    p.session.recordFavor({ owedBy: PLAYER, owedTo: h, origin: "counter:1" });
    p.seam.favorsAtTally([h, o], [PLAYER]);
    expect(ledger(p).map((f) => f.state)).toEqual(["owed", "owed"]);
  });
  it("a refusal costs the holder's trust and the witnesses' at a lower weight, and moves nothing for others", () => {
    const p = sessionWithRoll("refuse");
    const [h, d, w, x, o] = p.npcs as [string, string, string, string, string];
    p.session.recordFavor({ owedBy: d, owedTo: h, origin: "deal:1", witnesses: [w] });
    cold(p, d, h);
    for (const id of [h, w, x]) setEdge(p, id, d, { trust: 0.7, affinity: 0.7, threat: 0.1 });
    p.seam.favorsAtTally([h, o], [d]);
    expect(ledger(p)[0]).toMatchObject({ state: "refused" });
    const lost = (id: string) => 0.7 - p.seam.rel.edge(id, d).trust;
    expect(lost(h)).toBeGreaterThan(lost(w));
    expect(lost(w)).toBeGreaterThan(0);
    expect(lost(x)).toBe(0);
    expect(FAVOR.refusalScale).toBeLessThan(1);
  });
  it("a debtor draws from the favors side stream only: the same seed answers the same way", () => {
    const run = () => { const p = sessionWithRoll("honor"); const [h, d, o] = p.npcs as [string, string, string]; p.session.recordFavor({ owedBy: d, owedTo: h, origin: "deal:1" }); warm(p, d, h); p.seam.favorsAtTally([h, o], [d]); return JSON.stringify(ledger(p)); };
    expect(run()).toBe(run());
  });
});

describe("the vote term", () => {
  it("is last and named, and an honored favor tips an even call toward keeping the holder; absent, it is byte-identical", () => {
    expect(VOTE_TERM_NAMES.at(-1)).toBe("favor");
    const rel = new RelationshipModel(0.5);
    const base = { rel, player: "player" } as unknown as Parameters<typeof voteChoice>[2];
    const withShield = { ...base, favorShieldFor: (n: string, v: string) => (n === "holder" && v === "voter" ? 0.2 : 0) } as unknown as Parameters<typeof voteChoice>[2];
    const zero = { ...base, favorShieldFor: () => 0 } as unknown as Parameters<typeof voteChoice>[2];
    // the pick is who is voted OUT; an even call falls to the first nominee
    expect(voteChoice("voter", ["holder", "other"], base)).toBe("holder");
    expect(voteChoice("voter", ["holder", "other"], withShield)).toBe("other"); // the shield spares the holder
    expect(voteChoice("voter", ["holder", "other"], zero)).toBe(voteChoice("voter", ["holder", "other"], base));
  });
});

describe("counters at the swap seam", () => {
  const swap = (favors: boolean) => {
    const p = playedSession(6, { favors });
    const [npc, rival] = p.npcs as [string, string];
    const deal = p.seam.deals.make([PLAYER, npc], "safety", "terms", undefined, p.seam.live.week);
    p.seam.agendaPullOf = (t) => ({ value: t === rival ? 0.9 : 0 });
    return { p, npc, rival, deal };
  };
  it("a goal-driven houseguest counters with the rival they want gone, from a seed that rolls it", () => {
    let found = 0;
    for (let seed = 1; seed < 60 && found < 3; seed++) {
      const p = playedSession(seed);
      const [npc, rival] = p.npcs as [string, string];
      const deal = p.seam.deals.make([PLAYER, npc], "safety", "terms", undefined, p.seam.live.week);
      p.seam.agendaPullOf = (t) => ({ value: t === rival ? 0.9 : 0 });
      const ask = p.seam.favorCounterAsk(npc, deal, p.npcs);
      if (ask) { expect(ask).toEqual({ kind: "target", target: rival }); found++; }
    }
    expect(found).toBeGreaterThan(0);
  });
  it("with no goal pulling, no counter is asked; the same seed asks the same", () => {
    const { p, npc, deal } = swap(true);
    p.seam.agendaPullOf = () => ({ value: 0 });
    expect(p.seam.favorCounterAsk(npc, deal, p.npcs)).toBeUndefined();
    const a = swap(true); const b = swap(true);
    expect(a.p.seam.favorCounterAsk(a.npc, a.deal, a.p.npcs)).toEqual(b.p.seam.favorCounterAsk(b.npc, b.deal, b.p.npcs));
  });
  it("taking a counter puts the player in the houseguest's debt; taking a plain swap puts the houseguest in the player's", () => {
    const { p, npc, rival } = swap(true);
    p.seam.live.dealOffer = { id: `offer:${npc}:1`, from: npc, kind: "vote", terms: "t", madeWeek: p.seam.live.week, counter: { round: 1, ask: { kind: "target", target: rival } } };
    p.seam.resolveDealOffer(true);
    expect(ledger(p)[0]).toMatchObject({ owedBy: PLAYER, owedTo: npc, state: "owed" });
    expect(ledger(p)[0]!.origin).toMatch(/^counter:/);
    const q = swap(true);
    q.p.seam.live.dealOffer = { id: `offer:${q.npc}:1`, from: q.npc, kind: "vote", terms: "t", madeWeek: q.p.seam.live.week, replacesDealId: q.deal.id };
    q.p.seam.resolveDealOffer(true);
    expect(ledger(q.p)[0]).toMatchObject({ owedBy: q.npc, owedTo: PLAYER });
    expect(ledger(q.p)[0]!.origin).toBe(q.deal.id);
  });
  it("the standing offer carries the counter as facts (a round and who goes up), no number and no ledger", () => {
    const { p, npc, rival } = swap(true);
    p.seam.live.dealOffer = { id: `offer:${npc}:1`, from: npc, kind: "vote", terms: "t", madeWeek: p.seam.live.week, replacesDealId: "deal:1", counter: { round: 1, ask: { kind: "target", target: rival } } };
    const view = p.session.getGameState().openDealOffer!;
    expect(view.counter).toEqual({ round: 1, ask: { kind: "target", target: { id: rival, name: expect.any(String) } } });
    expect(JSON.stringify(view)).not.toMatch(/owedBy|favor:|debt/);
  });
  it("switched off: nothing is recorded, a taken counter owes nothing, the snapshot has no favors key", () => {
    const { p, npc, rival } = swap(false);
    p.seam.live.dealOffer = { id: `offer:${npc}:1`, from: npc, kind: "vote", terms: "t", madeWeek: p.seam.live.week, counter: { round: 1, ask: { kind: "target", target: rival } } };
    p.seam.resolveDealOffer(true);
    expect(ledger(p)).toHaveLength(0);
    expect((p.session.snapshot() as { favors?: unknown }).favors).toBeUndefined();
  });
});

describe("headless seasons are byte-identical with the flag on or off", () => {
  it("the same seed plays the same, snapshot and all", () => {
    const run = (on: boolean) => {
      const sb = new GameSessionRegistry().sandboxFor(`favors-id-${on}`);
      sb.session.setFavorsEnabled(on);
      sb.session.createCharacter({ playerName: "The Player", seed: 9 });
      for (let i = 0; i < 12; i++) sb.session.advanceGame();
      const snap = JSON.stringify(sb.session.snapshot());
      return snap;
    };
    expect(run(true)).toBe(run(false));
  });
});
