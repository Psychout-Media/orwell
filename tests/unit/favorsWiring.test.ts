import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { FAVOR } from "../../src/engine/favorConstants";
import { voteChoice, VOTE_TERM_NAMES, honorWeight } from "../../src/engine/liveSeason";
import { DECISION } from "../../src/engine/decisionConstants";
import { playedSession, sessionWithRoll, warm, cold, setEdge, ledger, gather } from "../support/favorsSeam";
import { RelationshipModel } from "../../src/engine/relationships";
import { GameSessionRegistry } from "../../src/composition/registry";

/** 0171: the wiring through the real adapter with ledgers, edges, presence and the vote doubt SET BY HAND through tests/support/favorsSeam (unit tests; the REAL PATH is
 * tests/uat/realPathFavors.test.ts, ORW-811). Roles only. */
describe("unit, state set by hand: called-in favors at a close vote", () => {
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
    p.session.recordFavor({ owedBy: d, owedTo: h, origin: "deal:1", witnesses: [w, x] });
    gather(p, [h, d, w]); // x heard the promise but is not in the room
    cold(p, d, h);
    for (const id of [h, w, x]) setEdge(p, id, d, { trust: 0.7, affinity: 0.7, threat: 0.1 });
    p.seam.favorsAtTally([h, o], [d]);
    expect(ledger(p)[0]).toMatchObject({ state: "refused" });
    const lost = (id: string) => 0.7 - p.seam.rel.edge(id, d).trust;
    expect(lost(h)).toBeGreaterThan(lost(w));
    expect(lost(w)).toBeGreaterThan(0);
    expect(lost(x)).toBe(0); // heard the promise, was not there to see the refusal
    expect(FAVOR.refusalScale).toBeLessThan(1);
  });
  it("a debtor draws from the favors side stream only: the same seed answers the same way", () => {
    const run = () => { const p = sessionWithRoll("honor"); const [h, d, o] = p.npcs as [string, string, string]; p.session.recordFavor({ owedBy: d, owedTo: h, origin: "deal:1" }); warm(p, d, h); p.seam.favorsAtTally([h, o], [d]); return JSON.stringify(ledger(p)); };
    expect(run()).toBe(run());
  });
});

describe("unit, state set by hand: the vote term", () => {
  it("is named (after 0180's herd joined the list, no longer last), and an honored favor tips an even call toward keeping the holder; absent, it is byte-identical", () => {
    expect(VOTE_TERM_NAMES).toContain("favor");
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

describe("unit, state set by hand: counters at the swap seam", () => {
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
  it("taking a counter is a CONDITION: booked only if the rival is on the block at that eviction, else lapsed unbooked", () => {
    for (const goesUp of [true, false]) {
      const { p, npc, rival } = swap(true);
      const other = p.npcs.find((x) => x !== npc && x !== rival)!;
      p.seam.live.dealOffer = { id: `offer:${npc}:1`, from: npc, kind: "vote", terms: "t", madeWeek: p.seam.live.week, counter: { round: 1, ask: { kind: "target", target: rival } } };
      p.seam.resolveDealOffer(true);
      expect(ledger(p)).toHaveLength(0); // not booked on the spot
      expect(p.seam.live.favorConditions![0]).toMatchObject({ state: "waiting", owedBy: PLAYER, owedTo: npc });
      p.seam.favorsAtTally(goesUp ? [rival, other] : [other, npc], [PLAYER]);
      expect(p.seam.live.favorConditions![0]!.state).toBe(goesUp ? "booked" : "lapsed");
      if (goesUp) expect(ledger(p)[0]).toMatchObject({ owedBy: PLAYER, owedTo: npc, state: "owed" });
      else expect(ledger(p)).toHaveLength(0);
    }
  });
  it("a protect counter is booked only if the protected houseguest is NOT on the block", () => {
    const { p, npc, rival } = swap(true);
    const other = p.npcs.find((x) => x !== npc && x !== rival)!;
    p.seam.live.dealOffer = { id: `offer:${npc}:1`, from: npc, kind: "vote", terms: "t", madeWeek: p.seam.live.week, counter: { round: 1, ask: { kind: "protect", target: rival } } };
    p.seam.resolveDealOffer(true);
    p.seam.favorsAtTally([rival, other], [PLAYER]);
    expect(p.seam.live.favorConditions![0]!.state).toBe("lapsed");
  });
  it("taking a plain swap puts the houseguest in the player's debt", () => {
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

describe("unit, state set by hand: headless seasons are byte-identical with the flag on or off", () => {
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

describe("unit, state set by hand: one favor bank (the 0142 bank folded into the ledger)", () => {
  it("a legacy owedFavors row is copied into the ledger on restore, losing none, and the lever still works through it", () => {
    const p = playedSession(6);
    const [a, b] = p.npcs as [string, string];
    p.seam.live.owedFavors = [{ debtor: a, n: 2, madeWeek: 1 }, { debtor: b, n: 1, madeWeek: 1 }];
    const core = JSON.parse(JSON.stringify(p.session.snapshot()));
    const q = playedSession(6);
    q.session.restore(core);
    expect(ledger(q).filter((f) => f.owedTo === PLAYER && f.state === "owed")).toHaveLength(3);
    expect((q.seam.live as { owedFavors?: unknown }).owedFavors).toBeUndefined();
    const view = (q.session.getGameState() as { owedFavors?: Array<{ from: { id: string }; n: number }> }).owedFavors!;
    expect(view.map((v) => [v.from.id, v.n]).sort()).toEqual([[a, 2], [b, 1]].sort());
    const before = ledger(q).length;
    q.session.callInFavor(a, "vote");
    expect(ledger(q)).toHaveLength(before); // append-only: the spent favor stays on the ledger
    expect(ledger(q).filter((f) => f.owedBy === a && f.state === "owed")).toHaveLength(1);
    expect(q.session.bondReader().bond(PLAYER, b).debt).toBeGreaterThan(0); // the ONE bank is the debt source
  });
  it("a kept deal banks into the ledger, capped at three open per houseguest", () => {
    const p = playedSession(6);
    const [a] = p.npcs as [string];
    const bank = (p.session as unknown as { bankOwedFavor(h: string, w: string): void });
    for (let i = 0; i < 5; i++) bank.bankOwedFavor(a, PLAYER);
    expect(ledger(p).filter((f) => f.owedBy === a && f.holder === PLAYER)).toHaveLength(3);
  });
  it("switched off, the legacy bank is untouched", () => {
    const p = playedSession(6, { favors: false });
    const [a] = p.npcs as [string];
    p.seam.live.owedFavors = [{ debtor: a, n: 2, madeWeek: 1 }];
    p.session.getGameState();
    expect(p.seam.live.owedFavors).toHaveLength(1);
    expect(ledger(p)).toHaveLength(0);
  });
});

describe("unit, state set by hand: favors both ways", () => {
  it("the engine never calls in a favor the player holds", () => {
    const p = sessionWithRoll("honor");
    const [d, o] = p.npcs as [string, string];
    p.session.recordFavor({ owedBy: d, owedTo: PLAYER, origin: "bank:1" });
    p.seam.favorsAtTally([d, o], [PLAYER]);
    expect(ledger(p)[0]).toMatchObject({ state: "owed" });
    expect(ledger(p)[0]!.calledBeat).toBeUndefined();
  });
  it("an NPC nominee calls in what the player owes through the one standing offer; accepting repays it", () => {
    const p = playedSession(6);
    const [h, o] = p.npcs as [string, string];
    p.session.recordFavor({ owedBy: PLAYER, owedTo: h, origin: "counter:1" });
    p.seam.favorsAtTally([h, o], [PLAYER]);
    const offer = p.session.getGameState().openDealOffer!;
    expect(offer.favor).toEqual({ kind: "called-in" });
    expect(offer.from.id).toBe(h);
    p.seam.resolveDealOffer(true);
    expect(ledger(p)[0]).toMatchObject({ state: "repaid" });
  });
  it("declining costs the player the NPC's trust and leaves a memory, a grudge and a bond fold; an absent witness is unchanged", () => {
    const p = playedSession(6);
    const [h, o, w, x] = p.npcs as [string, string, string, string];
    p.session.recordFavor({ owedBy: PLAYER, owedTo: h, origin: "counter:1", witnesses: [w, x] });
    gather(p, [h, w, PLAYER]);
    for (const id of [h, w, x]) setEdge(p, id, PLAYER, { trust: 0.7, affinity: 0.7, threat: 0.1 });
    p.seam.favorsAtTally([h, o], [PLAYER]);
    p.seam.resolveDealOffer(false);
    expect(ledger(p)[0]).toMatchObject({ state: "refused" });
    const lost = (id: string) => 0.7 - p.seam.rel.edge(id, PLAYER).trust;
    expect(lost(h)).toBeGreaterThan(lost(w));
    expect(lost(w)).toBeGreaterThan(0);
    expect(lost(x)).toBe(0);
    expect(p.seam.live.npcMemory?.[h]?.[PLAYER]?.length ?? 0).toBeGreaterThan(0);
    expect(Object.keys(p.seam.live.grudges ?? {})).toContain(`${h}|${PLAYER}`);
    expect(Object.keys(p.seam.live.bonds ?? {}).length).toBeGreaterThan(0);
  });
  it("a nominee who reads the player warmly may ask them for a favor; granting it puts the NPC in the player's debt", () => {
    let asked = 0;
    for (let seed = 1; seed < 40 && !asked; seed++) {
      const p = playedSession(seed);
      const [h, o] = p.npcs as [string, string];
      warm(p, h, PLAYER);
      p.seam.favorsAtTally([h, o], [PLAYER]);
      const offer = p.seam.live.dealOffer;
      if (offer?.favor && offer.favor.favorId === undefined && offer.from === h) { asked++; p.seam.resolveDealOffer(true); expect(ledger(p)[0]).toMatchObject({ owedBy: h, owedTo: PLAYER }); }
    }
    expect(asked).toBe(1);
  });
  it("a refusal's event witnesses include the refused person, and the player only when present", () => {
    const run = (playerThere: boolean) => {
      const p = sessionWithRoll("refuse");
      const [h, d, o] = p.npcs as [string, string, string];
      const seen: string[][] = [];
      (p.session as unknown as { onPlayerEvent: (t: string, w: string[]) => void }).onPlayerEvent = (_t, w) => { seen.push(w); return undefined as never; };
      p.session.recordFavor({ owedBy: d, owedTo: h, origin: "deal:1" });
      cold(p, d, h);
      gather(p, playerThere ? [h, d, PLAYER] : [h, d]);
      p.seam.favorsAtTally([h, o], [d]);
      return seen.find((w) => w.includes(d) && w.includes(h))!;
    };
    expect(run(false)).not.toContain(PLAYER);
    expect(run(true)).toContain(PLAYER);
  });
  it("the hidden refusal's wording never carries the old dodge and differs from the public one", () => {
    const texts: string[] = [];
    for (const there of [false, true]) {
      const p = sessionWithRoll("refuse");
      const [h, d, o] = p.npcs as [string, string, string];
      (p.session as unknown as { onPlayerEvent: (t: string) => void }).onPlayerEvent = (t) => { texts.push(t); return undefined as never; };
      p.session.recordFavor({ owedBy: d, owedTo: h, origin: "deal:1" });
      cold(p, d, h); gather(p, there ? [h, d, PLAYER] : [h, d]);
      p.seam.favorsAtTally([h, o], [d]);
    }
    const refusal = texts.filter((t) => /no by|turned down/.test(t));
    expect(refusal).toHaveLength(2);
    expect(refusal[0]).not.toBe(refusal[1]);
    expect(texts.join("\n")).not.toMatch(/off-screen/);
  });
});

describe("unit, state set by hand: ORW-617: one honor weight for any holder", () => {
  it("an honored favor weighs the same as a formal deal, whoever the holder is", () => {
    const p = sessionWithRoll("honor");
    const [h, d] = p.npcs as [string, string];
    p.session.recordFavor({ owedBy: d, owedTo: h, origin: "deal:1" });
    warm(p, d, h);
    p.seam.favorsAtTally([h, p.npcs[2]!], [d]);
    const shield = (p.session as unknown as { favorShieldFor(n: string, v: string): number }).favorShieldFor(h, d);
    expect(shield).toBe(honorWeight()); // what a called-in favor of the PLAYER binds (a deal) is honorWeight x trust
    expect(shield).toBe(honorWeight(1));
  });
  it("the same favor, honored, moves a vote the same whether the holder is the player or an NPC", () => {
    const rel = new RelationshipModel(0.5);
    const base = { rel, player: "player" } as unknown as Parameters<typeof voteChoice>[2];
    // the favor term for any holder: shield (weight at trust 1) x the voter's trust in them; the deal term: honorWeight(trust)
    for (const trustVal of [0.2, 0.5, 1]) {
      const ctx = { ...base, dealTrustFor: () => trustVal, favorShieldFor: (n: string) => (n === "holder" ? honorWeight() : 0) } as unknown as Parameters<typeof voteChoice>[2];
      const noFavor = { ...base, dealTrustFor: () => trustVal } as unknown as Parameters<typeof voteChoice>[2];
      const sw = { ...ctx, favorShieldFor: (n: string) => (n === "player" ? honorWeight() : 0) } as unknown as Parameters<typeof voteChoice>[2];
      // a shield on either holder tips an even call away from them the same way
      expect(voteChoice("voter", ["holder", "other"], noFavor)).toBe("holder");
      expect(voteChoice("voter", ["holder", "other"], ctx)).toBe("other");
      expect(voteChoice("voter", ["player", "other"], noFavor)).toBe("player");
      expect(voteChoice("voter", ["player", "other"], sw)).toBe("other");
    }
    expect(honorWeight(0.5)).toBe(DECISION.vote.dealHonorWeight * 0.5);
  });
});
