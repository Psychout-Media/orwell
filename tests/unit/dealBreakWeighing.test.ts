import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { DealLedger, type Deal } from "../../src/engine/deals";
import { weighDealBreak, decideDealBreak, renegotiatedKind, type DealBreakInputs } from "../../src/engine/dealTemptation";
import { DEAL_TEMPTATION } from "../../src/engine/dealTemptationConstants";
import type { Agenda } from "../../src/engine/agenda";

/**
 * 0142 idea 4 - NPCs weigh breaking a deal (ORW-88). Roles only. The temptation vs the price of being known as a liar; one side-rng roll; a quiet Vault-held break; a renegotiation offer.
 */
const base: DealBreakInputs = { kind: "safety", threat: 0.1, trust: 0.9, affinity: 0.9, ownPush: 0, agendaPull: 0, loyalty: 0.7, credibility: 1, reliableShare: 0.5, endgame: 0 };

describe("the pure weighing", () => {
  it("a high-credibility, high-bond NPC with no pull has no temptation and never breaks, whatever the roll", () => {
    const w = weighDealBreak(base);
    expect(w.temptation).toBe(0);
    expect(w.pBreak).toBe(0);
    for (const r of [0, 0.001, 0.5, 0.999]) expect(decideDealBreak(w, r)).toBe("keep");
  });
  it("an agenda pull to get the player out, a threat read and a low bond tempt past the price", () => {
    const w = weighDealBreak({ ...base, trust: 0.2, affinity: 0.2, threat: 0.9, agendaPull: 0.9, credibility: 0.3, reliableShare: 0, loyalty: 0.2 });
    expect(w.margin).toBeGreaterThan(0);
    expect(w.pBreak).toBeGreaterThan(0);
    expect(w.pBreak).toBeLessThanOrEqual(1);
    expect(w.pBreak).toBeCloseTo(Math.min(1, DEAL_TEMPTATION.breakSlope * w.margin), 10); // the margin alone sets the chance
    expect(decideDealBreak(w, 0)).toBe("break");
    expect(decideDealBreak(w, 0.999)).toBe("keep");
  });
  it("renegotiates only when temptation is high but the margin is not positive; never breaks then", () => {
    const w = weighDealBreak({ ...base, trust: 0.35, affinity: 0.35, threat: 0.9, credibility: 1, reliableShare: 0.6, loyalty: 0.5 });
    expect(w.temptation).toBeGreaterThanOrEqual(DEAL_TEMPTATION.renegotiateFloor);
    expect(w.margin).toBeLessThanOrEqual(0);
    expect(w.pBreak).toBe(0);
    expect(w.pRenegotiate).toBeGreaterThan(0);
    expect(decideDealBreak(w, 0)).toBe("renegotiate");
    expect(decideDealBreak(w, 0.999)).toBe("keep");
  });
  it("monotone: more credibility, bond or loyalty never raise the break chance; a vote deal has nothing lighter to swap to", () => {
    const tempted = { ...base, trust: 0.3, affinity: 0.3, threat: 0.9, agendaPull: 0.5 };
    const p = (o: Partial<DealBreakInputs>) => weighDealBreak({ ...tempted, ...o }).pBreak;
    expect(p({ credibility: 0.2 })).toBeGreaterThanOrEqual(p({ credibility: 1 }));
    expect(p({ loyalty: 0 })).toBeGreaterThanOrEqual(p({ loyalty: 1 }));
    expect(p({ reliableShare: 0 })).toBeGreaterThanOrEqual(p({ reliableShare: 1 }));
    expect(renegotiatedKind("vote")).toBeUndefined();
    expect(renegotiatedKind("final-two")).toBe("vote");
  });
});

describe("DealLedger.breakDeliberately", () => {
  it("marks the deal broken and sealed (it keeps projecting open), shares the ordinary fallout, and refuses a non-promisor", () => {
    const l = new DealLedger();
    const d = l.make(["npc:a", "player"], "safety", "t", undefined, 1);
    const seen: string[] = [];
    expect(l.breakDeliberately(d, "npc:zzz")).toBeUndefined();
    expect(l.breakDeliberately(d, "npc:a", { juryDemerit: () => seen.push("jury"), reveal: (_w, _b, _d, cause) => { seen.push(`reveal:${cause}`); return "ev:1"; } })).toBe("player");
    expect(d.status).toBe("broken");
    expect(d.sealedBallot).toBe(true);
    expect(d.resolvedEventId).toBe("ev:1");
    expect(seen).toEqual(["jury", "reveal:deliberate"]);
    expect(l.breakDeliberately(d, "npc:a")).toBeUndefined(); // once
  });
});

// --- the live adapter ------------------------------------------------------------------------------------------------------------------
type Internals = {
  live: { playedGame?: boolean; week: number; hoh?: string; pending?: unknown; dealOffer?: { replacesDealId?: string; kind: string; from: string }; agendas?: Record<string, Agenda>; decisionWhy?: Array<{ kind: string; by: string }>; statedReasons?: Array<{ decision: string; public: boolean }>; evictionOrder: string[] };
  deals: DealLedger;
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
  setDealDepthEnabled(on: boolean): void;
  weighDealBreaks(): void;
  resolveDealOffer(accept: boolean): unknown;
};
type Setup = { s: GameSessionAdapter; g: Internals; npc: string; deal: Deal };
function setup(o: { trust: number; affinity: number; threat: number; goal?: boolean; goalKind?: "keep-them-safe" | "long-con-final-five"; active?: number; played?: boolean; kind?: Deal["kind"]; seed?: number }): Setup {
  const sb = new GameSessionRegistry().sandboxFor(`weigh-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: o.seed ?? 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const s = sb.session as GameSessionAdapter;
  const g = s as unknown as Internals;
  g.setDealDepthEnabled(true);
  g.live.playedGame = o.played ?? true;
  const npc = [...s.livingIds()].find((i) => i !== PLAYER)!;
  g.live.hoh ??= npc; g.live.pending = undefined;
  const e = g.rel.edge(npc, PLAYER); e.trust = o.trust; e.affinity = o.affinity; e.threat = o.threat;
  if (o.active !== undefined) (g.live as unknown as { active: string[] }).active = (g.live as unknown as { active: string[] }).active.slice(0, o.active);
  const goalKind = o.goalKind === "keep-them-safe" ? "keep-them-safe" : o.goalKind ? "long-con" : "get-them-out";
  const goalTest = o.goalKind === "long-con-final-five" ? { kind: "cut-later", who: PLAYER, stage: "final-five" } : { kind: "evicted", who: PLAYER };
  g.live.agendas = { [npc]: { owner: npc, formedForWeek: 1, history: [], goals: o.goal || o.goalKind ? [{ id: "g1", owner: npc, horizon: "season", kind: goalKind, target: PLAYER, why: [], test: goalTest, commitment: 1, status: "active", formedDay: 1, formedWeek: 1 } as never] : [] } };
  const deal = g.deals.make([npc as never, PLAYER], o.kind ?? "safety", "t", undefined, g.live.week);
  return { s, g, npc, deal };
}
/** Re-weigh the same deal across many distinct weeks (each week is a fresh seeded roll); returns how many weeks broke it / asked to renegotiate. */
function sweep(x: Setup, weeks = 150): { broke: number; reneg: number; offers: Array<{ replacesDealId?: string }> } {
  let broke = 0, reneg = 0; const offers: Array<{ replacesDealId?: string }> = [];
  for (let w = 100; w < 100 + weeks; w++) {
    x.g.live.week = w; x.g.live.dealOffer = undefined;
    x.deal.status = "open"; delete x.deal.sealedBallot; delete x.deal.weighedWeek;
    x.g.weighDealBreaks();
    const offer = x.g.live.dealOffer as { replacesDealId?: string } | undefined;
    if ((x.deal.status as string) === "broken") broke++;
    else if (offer) { reneg++; offers.push({ ...offer }); }
  }
  return { broke, reneg, offers };
}

describe("(a) a played week: who breaks and who keeps", () => {
  it("an NPC with a get-them-out goal and low credibility cost breaks a safety deal; a high-bond, no-pull NPC never does", () => {
    const breaker = sweep(setup({ trust: 0.2, affinity: 0.2, threat: 0.9, goal: true }));
    const keeper = sweep(setup({ trust: 0.9, affinity: 0.9, threat: 0.1 }));
    expect(breaker.broke).toBeGreaterThan(10);
    expect(keeper.broke).toBe(0);
    expect(keeper.reneg).toBe(0);
  });
  it("mutation: zeroing the temptation stops the breaking; zeroing the cost breaks more", () => {
    const K = DEAL_TEMPTATION as unknown as Record<string, number>;
    const keep = { ...K };
    try {
      const mid = () => sweep(setup({ trust: 0.45, affinity: 0.45, threat: 0.8, goal: false })).broke;
      const normal = mid();
      for (const k of ["threatWeight", "lowBondWeight", "pushWeight", "agendaWeight", "endgameJury", "endgameFinalFive"]) K[k] = 0;
      expect(sweep(setup({ trust: 0.2, affinity: 0.2, threat: 0.9, goal: true })).broke).toBe(0);
      Object.assign(K, keep);
      for (const k of ["credibilityWeight", "reliableWeight", "bondWeight", "loyaltyWeight"]) K[k] = 0;
      expect(mid()).toBeGreaterThan(normal);
    } finally { Object.assign(K, keep); }
  });
  it("a break is quiet: the deal keeps projecting open to the player, no player-visible event, the why is recorded Vault-side, the reason is never voiced", () => {
    const x = setup({ trust: 0.2, affinity: 0.2, threat: 0.9, goal: true });
    for (let w = 200; (x.deal.status as string) !== "broken" && w < 240; w++) { x.g.live.week = w; delete x.deal.weighedWeek; x.g.weighDealBreaks(); }
    expect(x.deal.status).toBe("broken");
    expect(x.deal.sealedBallot).toBe(true);
    const view = (x.s.seasonRecap().deals ?? []).find((d) => d.id === x.deal.id)!;
    expect(view.status).toBe("open");
    expect(x.g.live.decisionWhy!.some((w) => w.kind === "deal-break" && w.by === x.npc)).toBe(true);
    const reason = x.g.live.statedReasons!.find((r2) => r2.decision === "deal-break")!;
    expect(reason.public).toBe(false);
    expect((x.s as unknown as { statedReasonsFor(id: string): unknown[] }).statedReasonsFor(x.npc)).toEqual([]); // a quiet break is never voiced
    expect(x.s.seasonRecap().highlights.some((h) => /broke/.test(h))).toBe(false); // no player-witnessed betrayal event: the break is Vault-held
  });
});

describe("signed agenda pull: a goal to keep the player, or a long con not yet at its break stage, makes the NPC LESS tempted", () => {
  // threat 1, no bond, endgame pressure: the same NPC with no goal breaks sometimes (positive margin), so a subtracting goal has something to take away.
  const hot = { trust: 0, affinity: 0, threat: 1, active: 5 } as const;
  it("a protect-the-player goal lowers the break frequency below the same NPC with no goal (and below a get-them-out goal)", () => {
    const none = sweep(setup({ ...hot })).broke;
    const protect = sweep(setup({ ...hot, goalKind: "keep-them-safe" })).broke;
    const out = sweep(setup({ ...hot, goal: true })).broke;
    expect(none).toBeGreaterThan(0);
    expect(protect).toBeLessThan(none);
    expect(out).toBeGreaterThan(none);
  });
  it("a long con keeps the deal before its break stage and only turns tempted once the stage is reached", () => {
    const early = { trust: 0, affinity: 0, threat: 1, active: 6 } as const; // 6 left: final five not reached
    const atStage = { trust: 0, affinity: 0, threat: 1, active: 5 } as const; // 5 left: the con's cut stage
    const noneEarly = sweep(setup({ ...early })).broke;
    const conEarly = sweep(setup({ ...early, goalKind: "long-con-final-five" })).broke;
    const noneStage = sweep(setup({ ...atStage })).broke;
    const conStage = sweep(setup({ ...atStage, goalKind: "long-con-final-five" })).broke;
    expect(conEarly).toBeLessThanOrEqual(noneEarly);
    expect(conEarly).toBe(0);
    expect(conStage).toBeGreaterThan(noneStage);
    expect(conStage).toBeGreaterThan(conEarly);
  });
});

describe("(b) renegotiation", () => {
  it("high temptation with no positive margin yields a standing offer that replaces the deal (open, non-blocking); accepting retires the old deal neutrally", () => {
    const x = setup({ trust: 0.35, affinity: 0.35, threat: 0.9, kind: "final-two" });
    const r = sweep(x);
    expect(r.broke).toBe(0);
    expect(r.reneg).toBeGreaterThan(0);
    expect(r.offers[0]!.replacesDealId).toBe(x.deal.id);
    // re-create one standing offer and accept it
    for (let w = 400; w < 600 && !x.g.live.dealOffer; w++) { x.g.live.week = w; delete x.deal.weighedWeek; x.g.weighDealBreaks(); }
    expect(x.g.live.dealOffer?.replacesDealId).toBe(x.deal.id);
    expect(x.deal.status).toBe("open"); // still binding until the player answers
    const statedBefore = x.g.live.statedReasons!.filter((r2) => r2.decision === "deal-renegotiate" && r2.public).length;
    expect(statedBefore).toBeGreaterThan(0);
    const voiced = (x.s as unknown as { statedReasonsFor(id: string): Array<Record<string, unknown>> }).statedReasonsFor(x.npc);
    expect(voiced.length).toBeGreaterThan(0);
    for (const v of voiced) expect(Object.keys(v).sort()).toEqual(["about", "decision", "kind"]); // kind + subject only: never the candor, goal or terms
    x.g.resolveDealOffer(true);
    expect(x.deal.status).toBe("lapsed");
    expect(x.g.deals.open().some((d) => d.kind === "vote" && d.parties.includes(PLAYER))).toBe(true);
  });
});

describe("gating: only a played game, once per deal per week", () => {
  it("a game nobody is playing, or with deal depth off, weighs nothing and marks nothing", () => {
    const idle = setup({ trust: 0.2, affinity: 0.2, threat: 0.9, goal: true, played: false });
    expect(sweep(idle).broke).toBe(0);
    expect(idle.deal.weighedWeek).toBeUndefined();
    const off = setup({ trust: 0.2, affinity: 0.2, threat: 0.9, goal: true });
    off.g.setDealDepthEnabled(false);
    expect(sweep(off).broke).toBe(0);
  });
  it("weighs a deal once a week, and not at all while a ceremony step is pending", () => {
    const x = setup({ trust: 0.2, affinity: 0.2, threat: 0.9, goal: true });
    x.g.live.week = 300; x.g.weighDealBreaks();
    expect(x.deal.weighedWeek).toBe(300);
    const w = x.deal.status; x.g.weighDealBreaks(); expect(x.deal.status).toBe(w);
    const y = setup({ trust: 0.2, affinity: 0.2, threat: 0.9, goal: true });
    y.g.live.pending = { kind: "nominations" };
    y.g.weighDealBreaks();
    expect(y.deal.weighedWeek).toBeUndefined();
  });
});

describe("(d) save/restore round-trips the weighing and the sealed break", () => {
  it("weighedWeek and the deliberate, sealed break survive snapshot -> restore", () => {
    const x = setup({ trust: 0.2, affinity: 0.2, threat: 0.9, goal: true });
    for (let w = 500; x.deal.status === "open" && w < 700; w++) { x.g.live.week = w; delete x.deal.weighedWeek; x.g.weighDealBreaks(); }
    expect(x.deal.status).toBe("broken");
    const core = JSON.parse(JSON.stringify(x.s.snapshot()));
    const revived = new GameSessionRegistry().sandboxFor(`weigh-rt-${Math.random()}`).session as GameSessionAdapter;
    revived.restore(core);
    const d = (revived as unknown as Internals).deals.all.find((q) => q.id === x.deal.id)!;
    expect(d.status).toBe("broken");
    expect(d.sealedBallot).toBe(true);
    expect(d.weighedWeek).toBe(x.deal.weighedWeek);
    expect((revived.seasonRecap().deals ?? []).find((q) => q.id === d.id)!.status).toBe("open");
  });
});
