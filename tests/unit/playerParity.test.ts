import { describe, it, expect } from "vitest";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import { DealLedger, type ReconcileSink } from "../../src/engine/deals";
import type { BindingAction } from "../../src/domain/deal";
import { nominationPlan, replacementPick, type Stats } from "../../src/engine/season";
import { detectBlocs, type Bloc } from "../../src/engine/blocs";
import {
  newLiveSeason, advance, applyDecision, voteChoice, type LiveSeasonState, type SeasonCtx,
} from "../../src/engine/liveSeason";
import { campaignPushFor, formCampaigns, deriveDrive, drivePushFor, type Campaign, type CampaignActor } from "../../src/engine/campaigns";
import { GameSessionRegistry } from "../../src/composition/registry";
import { claimsOf, type BeliefStore } from "../../src/engine/beliefStore";

/**
 * ORW-615 — PLAYER PARITY. Ryne's rule (2026-11-17): every social system treats the player as a full participant in
 * BOTH directions unless a ruling says otherwise — the player is scored, costed and folded by the same terms as any
 * houseguest. These are structural guards for the systems that ARE plugged in today, so a later change cannot quietly
 * special-case the player.
 *
 * The main tool is RELABELING: build a house, then build the SAME house with the player's id swapped for a
 * houseguest's (every edge carried over). A rule that treats the player like anyone else must give the swapped answer
 * (equivariance); any `if (x === PLAYER)` in the path breaks it. Where a system is wired through the live loop or
 * the adapter, the test runs the same act once with an NPC and once with the player and compares what moved.
 *
 * Systems NOT plugged in yet (favors toward the player, alliances fading with the player, HOH lobbying, house
 * meetings, vote talk, scene memories, the bond record from player scenes — ORW-609) have their own cards and are
 * deliberately not covered here. Roles only (HOH, nominee, NPC, player) — no names.
 */

const HOUSE: EntityId[] = [PLAYER, ...Array.from({ length: 9 }, (_, i) => npc(i + 1))];

/** The swap that exchanges the player's seat with one houseguest's. */
const swap = (a: EntityId, b: EntityId) => (x: EntityId): EntityId => (x === a ? b : x === b ? a : x);

/** A house with every directed edge drawn from a seed (all six signals). */
function randomRel(seed: number, ids: readonly EntityId[] = HOUSE): RelationshipModel {
  const rng = new SeededRandom(seed);
  const rel = new RelationshipModel(0.5);
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const e = rel.edge(a, b);
    e.trust = rng.next(); e.affinity = rng.next(); e.threat = rng.next();
    e.alignment = rng.next(); e.confidence = 0.3 + 0.4 * rng.next(); e.reliability = rng.next();
  }
  return rel;
}

/** The same house with every id passed through `sigma` (edge a->b becomes sigma(a)->sigma(b)). */
function relabel(rel: RelationshipModel, sigma: (x: EntityId) => EntityId): RelationshipModel {
  const out = new RelationshipModel(0.5);
  out.load(rel.serialize().edges.map((e) => ({ ...e, from: sigma(e.from), to: sigma(e.to) })));
  return out;
}

/** Every edge of `b` equals the sigma-image of the matching edge of `a` — "the same stores moved by the same amount". */
function expectSameGraph(a: RelationshipModel, b: RelationshipModel, sigma: (x: EntityId) => EntityId, ids: readonly EntityId[] = HOUSE): void {
  for (const x of ids) for (const y of ids) {
    if (x === y) continue;
    expect(b.edge(sigma(x), sigma(y)), `${x}->${y}`).toEqual(a.edge(x, y));
  }
}

const canonBlocs = (blocs: readonly Bloc[], sigma: (x: EntityId) => EntityId) =>
  blocs.map((b) => ({ members: b.members.map(sigma).sort(), sharedTarget: b.sharedTarget === null ? null : sigma(b.sharedTarget), cohesion: b.cohesion, loyaltyStrength: b.loyaltyStrength }))
    .sort((x, y) => x.members[0]!.localeCompare(y.members[0]!));

// ---------------------------------------------------------------------------------------------------------------
// Deals (0039 / 0109 / 0121): ONE ledger, one cost table — the player's breaks and keeps cost what an NPC's do.
// ---------------------------------------------------------------------------------------------------------------
describe("deals: the player's breaks and keeps are costed like any houseguest's", () => {
  type Trace = { demerits: string[]; reveals: string[]; reputations: string[] };
  function sink(rel: RelationshipModel, sigmaBack: (x: EntityId) => EntityId): { sink: ReconcileSink; trace: Trace } {
    // Every sink call is recorded in the ORIGINAL house's ids, so the two runs can be compared directly.
    const trace: Trace = { demerits: [], reveals: [], reputations: [] };
    return {
      trace,
      sink: {
        rel, rng: new SeededRandom(41), currentWeek: 2, dealDepth: true,
        juryDemerit: (w, b) => { trace.demerits.push(`${sigmaBack(w)}<-${sigmaBack(b)}`); },
        reveal: (w, b, _d, kind) => { trace.reveals.push(`${sigmaBack(w)}<-${sigmaBack(b)}:${kind}`); return "ev"; },
        reputation: (h, o) => { trace.reputations.push(`${sigmaBack(h)}->${sigmaBack(o)}`); },
      },
    };
  }
  /** Run one deal story in the original house and in the house with the player swapped into `seat`; return both. */
  function story(seat: EntityId, run: (ledger: DealLedger, s: ReconcileSink, id: (x: EntityId) => EntityId) => unknown) {
    const base = randomRel(7);
    const sigma = swap(PLAYER, seat);
    const swapped = relabel(base, sigma);
    const a = sink(base, (x) => x);
    const b = sink(swapped, sigma); // sigma is its own inverse
    const outA = run(new DealLedger(), a.sink, (x) => x);
    const outB = run(new DealLedger(), b.sink, sigma);
    return { base, swapped, sigma, a: a.trace, b: b.trace, outA, outB };
  }

  // In the original house the breaker is npc(1), the wronged partner npc(2), the other nominee npc(3).
  const BREAKER = npc(1), PARTNER = npc(2), OTHER = npc(3);

  it("a broken safety deal: the player as BREAKER takes the same betrayal fold, jury demerit and reveal as an NPC breaker", () => {
    const r = story(BREAKER, (ledger, s, id) => {
      ledger.make([id(BREAKER), id(PARTNER)], "safety", "safe this week", undefined, 2);
      const act: BindingAction = { actor: id(BREAKER), kind: "nominate", targets: [id(PARTNER), id(OTHER)] };
      return ledger.reconcile(act, s).broken.map((d) => d.status);
    });
    expect(r.outA).toEqual(["broken"]);
    expect(r.outB).toEqual(r.outA);
    expectSameGraph(r.base, r.swapped, r.sigma);
    expect(r.a.demerits).toEqual([`${PARTNER}<-${BREAKER}`]);
    expect(r.b).toEqual(r.a);
  });

  it("a broken safety deal: the player as the WRONGED party is folded and demerited exactly like a wronged NPC", () => {
    const r = story(PARTNER, (ledger, s, id) => {
      ledger.make([id(BREAKER), id(PARTNER)], "safety", "safe this week", undefined, 2);
      return ledger.reconcile({ actor: id(BREAKER), kind: "nominate", targets: [id(PARTNER), id(OTHER)] }, s).broken.length;
    });
    expect(r.outA).toBe(1);
    expect(r.outB).toBe(1);
    expectSameGraph(r.base, r.swapped, r.sigma);
    expect(r.b).toEqual(r.a);
  });

  it("a kept vote deal (loyalty streak on): the player as HONORER builds the partner's trust and reputation like an NPC honorer", () => {
    const r = story(BREAKER, (ledger, s, id) => {
      ledger.make([id(BREAKER), id(PARTNER)], "vote", "you have my vote", undefined, 2);
      const act: BindingAction = { actor: id(BREAKER), kind: "vote-evict", targets: [id(OTHER)], alternatives: [id(PARTNER), id(OTHER)] };
      return ledger.reconcile(act, s).kept.map((d) => d.status);
    });
    expect(r.outA).toEqual(["kept"]);
    expect(r.outB).toEqual(r.outA);
    expectSameGraph(r.base, r.swapped, r.sigma);
    expect(r.a.reputations).toEqual([`${BREAKER}->${PARTNER}`]);
    expect(r.b).toEqual(r.a);
  });

  it("a deliberate quiet break: the player walking a deal back costs what an NPC walking it back costs", () => {
    const r = story(BREAKER, (ledger, s, id) => {
      const deal = ledger.make([id(BREAKER), id(PARTNER)], "final-two", "the two of us to the end", undefined, 2);
      const wronged = ledger.breakDeliberately(deal, id(BREAKER), s);
      return wronged === undefined ? undefined : id(wronged);
    });
    expect(r.outA).toBe(PARTNER);
    expect(r.outB).toBe(PARTNER);
    expectSameGraph(r.base, r.swapped, r.sigma);
    expect(r.b).toEqual(r.a);
  });

  // Found by this suite and FIXED in ORW-615: `sealedBreak` used to exempt the player as breaker, so the wronged NPC in effect learned how the player
  // voted (full attributed betrayal + demerit + "deal-broken" memory). The player's secret ballot is now sealed like anyone's.
  it("a deal broken by a SECRET eviction ballot is sealed the same whether the breaker is the player or an NPC", () => {
    const sb = new GameSessionRegistry().sandboxFor(`parity-sealed-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    const [wronged, voter] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
    const g = sb.session as unknown as { live: { eviction?: unknown }; sealedBreak(w: string, b: string, k: string): boolean };
    // Both the player and the NPC voter voted to evict the wronged houseguest on this week's secret ballot.
    g.live.eviction = { voteOf: { [PLAYER]: wronged!, [voter!]: wronged! } };
    expect(g.sealedBreak(wronged!, PLAYER, "vote-evict")).toBe(g.sealedBreak(wronged!, voter!, "vote-evict"));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Casual assurances (B4): the player's broken / kept assurance folds into the assured NPC like an NPC's does.
// ---------------------------------------------------------------------------------------------------------------
describe("casual assurances: the player as ASSURER is held to the same promise as an NPC", () => {
  type G = {
    recordAssurance(a: unknown): void; assuranceNominated(h: string, n: string): void; assuranceKeptAtVote(v: string, sp: string): void;
    rel: RelationshipModel; setNpcBeliefsEnabled(on: boolean): void;
  };
  type Mem = Record<string, Record<string, { kind: string; severity: number }[]>>;
  function started(beliefs: boolean) {
    const sb = new GameSessionRegistry().sandboxFor(`parity-asr-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    sb.session.setAssurancesEnabled(true);
    const g = sb.session as unknown as G;
    g.setNpcBeliefsEnabled(beliefs);
    const [holder, assured] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
    const live = () => sb.session.snapshot().live as { npcMemory?: Mem; beliefs?: Record<string, unknown> };
    return { g, holder: holder!, assured: assured!, live };
  }
  /** One run: `assurer` promised the assured they were safe, then nominated them. What the assured carries afterwards. */
  function brokenBy(asPlayer: boolean) {
    const { g, holder, assured, live } = started(true);
    const assurer = asPlayer ? PLAYER : holder;
    g.rel.edge(assured, assurer).trust = 0.6;
    g.recordAssurance({ from: assurer, to: assured, kind: "safe", sincerity: 1, source: asPlayer ? "player" : "npc" });
    g.assuranceNominated(assurer, assured);
    const mem = (live().npcMemory?.[assured]?.[assurer] ?? []).map((m) => ({ kind: m.kind, severity: m.severity }));
    const claim = claimsOf((live().beliefs ?? {}) as BeliefStore, assured).some((c) => c.kind === "lied-to-me" && c.subject === assurer);
    return { trust: g.rel.edge(assured, assurer).trust, mem, claim };
  }
  it("a broken assurance costs the player the assured's trust, the grudge and the lied-to-me claim, exactly as for an NPC", () => {
    const npcRun = brokenBy(false);
    const playerRun = brokenBy(true);
    expect(npcRun.trust).toBeLessThan(0.6);
    expect(npcRun.mem.map((m) => m.kind)).toEqual(["deal-broken"]);
    expect(npcRun.claim).toBe(true);
    expect(playerRun).toEqual(npcRun);
  });
  it("a kept assurance earns the player the same remembered favor as an NPC", () => {
    const run = (asPlayer: boolean) => {
      const { g, holder, assured, live } = started(false);
      const assurer = asPlayer ? PLAYER : holder;
      g.recordAssurance({ from: assurer, to: assured, kind: "vote", sincerity: 1, source: asPlayer ? "player" : "npc" });
      g.assuranceKeptAtVote(assurer, assured);
      return (live().npcMemory?.[assured]?.[assurer] ?? []).map((m) => ({ kind: m.kind, severity: m.severity }));
    };
    const npcRun = run(false);
    expect(npcRun.map((m) => m.kind)).toEqual(["deal-kept"]);
    expect(run(true)).toEqual(npcRun);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The live loop: the player's ballot and goodbye are adjudicated like any houseguest's; nominations are NOT (yet).
// ---------------------------------------------------------------------------------------------------------------
function liveHouse(seed: number): { s: LiveSeasonState; ctx: SeasonCtx } {
  const ids = HOUSE.slice(0, 7);
  const rng = new SeededRandom(seed);
  const stats = new Map<EntityId, Stats>(ids.map((id) => [id, { physical: rng.next(), mental: rng.next(), social: rng.next() }]));
  return { s: newLiveSeason(ids), ctx: { player: PLAYER, statsOf: (id) => stats.get(id)!, rel: randomRel(seed, ids) } };
}

describe("live loop: the player's acts settle the same promises as an NPC's", () => {
  it("every eviction ballot — the player's included — breaks or keeps the voter's assurances, over the same sealed pool", () => {
    const { s, ctx } = liveHouse(5);
    const votedOut: Array<[EntityId, EntityId, string]> = [];
    const keptAt: Array<[EntityId, EntityId, string]> = [];
    ctx.assuranceVotedOut = (v, n, among) => { votedOut.push([v, n, [...(among ?? [])].sort().join(",")]); };
    ctx.assuranceKeptAtVote = (v, sp, among) => { keptAt.push([v, sp, [...(among ?? [])].sort().join(",")]); };
    s.hoh = npc(1); s.nominees = [npc(2), npc(3)]; s.finalNominees = [npc(2), npc(3)]; s.vetoUsed = false; s.beat = "eviction";
    expect(advance(s, ctx, new SeededRandom(1))).toBeNull();
    expect(s.pending?.kind).toBe("eviction-vote");
    applyDecision(s, { kind: "eviction-vote", vote: npc(2) }, ctx, new SeededRandom(1));
    const voters = [PLAYER, npc(4), npc(5), npc(6)].sort();
    // One break-check and one keep-check per voter, the player in the same loop as everyone else, all over the same pool.
    expect(votedOut.map(([v]) => v).sort()).toEqual(voters);
    expect(keptAt.map(([v]) => v).sort()).toEqual(voters);
    expect(new Set([...votedOut, ...keptAt].map(([, , pool]) => pool)).size).toBe(1);
    expect(votedOut.find(([v]) => v === PLAYER)).toEqual([PLAYER, npc(2), voters.join(",")]);
    expect(keptAt.find(([v]) => v === PLAYER)).toEqual([PLAYER, npc(3), voters.join(",")]);
  });

  it("a goodbye message: the player's chosen tone folds into the evictee's jury read exactly as an NPC's derived tone does", () => {
    const { s, ctx } = liveHouse(9);
    const evictee = npc(2), sender = npc(4);
    ctx.rel.edge(sender, evictee).affinity = 0.9; // the NPC's tone is derived from its edge: warm
    s.hoh = npc(1); s.beat = "eviction"; s.mannerByEvictee = {};
    s.eviction = { stage: "goodbye", nominees: [npc(2), npc(3)], revealOrder: [], voteOf: {}, revealIx: 0, evictee, goodbyeFrom: [sender, PLAYER], goodbyeIx: 0 };
    expect(advance(s, ctx, new SeededRandom(1))?.beat).toBe("eviction-goodbye");
    expect(advance(s, ctx, new SeededRandom(1))).toBeNull();
    expect(s.pending?.kind).toBe("goodbye-message");
    applyDecision(s, { kind: "goodbye-message", tone: "warm" }, ctx);
    const row = s.mannerByEvictee![evictee]!;
    expect(row[sender]).toEqual({ goodbye: "warm" });
    expect(row[PLAYER]).toEqual(row[sender]);
  });

  // Found by this suite and FIXED in ORW-615: the player HOH's nominations and replacement (staged and plain paths) used to skip the assurance settlement,
  // so a player who told a houseguest "you're safe" and then nominated them paid nothing where an NPC HOH pays the assured's trust and a grudge.
  it("the HOH's nominations break (and keep) the HOH's assurances whether the HOH is an NPC or the player", () => {
    const calls = (hohIsPlayer: boolean): string[] => {
      const { s, ctx } = liveHouse(3);
      const log: string[] = [];
      ctx.assuranceNominated = (h) => { log.push(`break-check:${h === s.hoh ? "HOH" : h}`); };
      ctx.assuranceKeptAtNominations = (h, ns) => { log.push(`kept-check:${h === s.hoh ? "HOH" : h}:${ns.length}`); };
      s.hoh = hohIsPlayer ? PLAYER : npc(1); s.beat = "nominations";
      const ev = advance(s, ctx, new SeededRandom(1));
      if (hohIsPlayer) {
        expect(ev).toBeNull();
        applyDecision(s, { kind: "nominations", choice: [npc(2), npc(3)] }, ctx);
      }
      return log.sort();
    };
    expect(calls(true)).toEqual(calls(false));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Nominations / replacement / veto save / Houseguest's Choice / the vote / blocs: the player is SCORED like anyone.
// ---------------------------------------------------------------------------------------------------------------
describe("decision scoring: identical edges => identical decision whether the candidate is the player or a houseguest", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
  const loyalty = (id: EntityId): number => 0.3 + 0.5 * ((id.charCodeAt(id.length - 1) % 7) / 7);

  it("blocs: the player joins, anchors and is targeted by blocs exactly as a houseguest in their seat would be", () => {
    let playerInBloc = 0;
    for (const seed of SEEDS) {
      const base = randomRel(seed);
      // Bond the player tightly to two houseguests so a bloc with the player in it really forms.
      for (const m of [npc(1), npc(2)]) for (const [a, b] of [[PLAYER, m], [m, PLAYER]] as const) { base.edge(a, b).trust = 0.95; base.edge(a, b).affinity = 0.95; }
      base.edge(npc(1), npc(2)).trust = 0.9; base.edge(npc(2), npc(1)).trust = 0.9; base.edge(npc(1), npc(2)).affinity = 0.9; base.edge(npc(2), npc(1)).affinity = 0.9;
      const sigma = swap(PLAYER, npc(5));
      const lo = (id: EntityId) => loyalty(id);
      const A = detectBlocs({ rel: base, active: HOUSE, loyaltyOf: lo });
      const B = detectBlocs({ rel: relabel(base, sigma), active: HOUSE.map(sigma), loyaltyOf: (id) => lo(sigma(id)) });
      expect(canonBlocs(B, sigma)).toEqual(canonBlocs(A, (x) => x));
      if (A.some((b) => b.members.includes(PLAYER))) playerInBloc++;
    }
    expect(playerInBloc).toBeGreaterThan(0);
  });

  it("nominations: an NPC HOH's plan treats the player as one more candidate (same terms, same seat, same target)", () => {
    let playerNominated = 0;
    for (const seed of SEEDS) {
      const base = randomRel(seed);
      const hoh = npc(1);
      const sigma = swap(PLAYER, npc(4));
      const swapped = relabel(base, sigma);
      const blocsA = detectBlocs({ rel: base, active: HOUSE, loyaltyOf: loyalty });
      const blocsB = detectBlocs({ rel: swapped, active: HOUSE.map(sigma), loyaltyOf: (id) => loyalty(sigma(id)) });
      const A = nominationPlan(hoh, HOUSE, base, { blocs: blocsA, mood: 0.3 });
      const B = nominationPlan(hoh, HOUSE.map(sigma), swapped, { blocs: blocsB, mood: 0.3 });
      expect(B.nominees.map(sigma)).toEqual(A.nominees);
      expect(sigma(B.target!)).toBe(A.target);
      if (A.nominees.includes(PLAYER)) playerNominated++;
    }
    expect(playerNominated).toBeGreaterThan(0);
  });

  it("replacement: an NPC HOH names the player as the replacement (new pawn or new target) by the same read as a houseguest", () => {
    // Two branches: the HOH's target is still on the block (a new PAWN is named) or the target came down (the new TARGET is named).
    for (const target of [npc(2), npc(8)]) {
      let playerNamed = 0;
      for (const seed of SEEDS) {
        const base = randomRel(seed);
        const hoh = npc(1), remaining = npc(2);
        const options = [PLAYER, npc(3), npc(4), npc(5)];
        const sigma = swap(PLAYER, npc(6));
        const A = replacementPick(hoh, remaining, options, HOUSE, base, { target });
        const B = replacementPick(hoh, remaining, options.map(sigma), HOUSE.map(sigma), relabel(base, sigma), { target });
        expect(sigma(B)).toBe(A);
        if (A === PLAYER) playerNamed++;
      }
      expect(playerNamed, `target ${target === npc(2) ? "still up" : "came down"}`).toBeGreaterThan(0);
    }
  });

  it("veto save: an NPC holder saves the player on the same trust + loyalty read as a nominated houseguest", () => {
    let playerSaved = 0;
    for (const seed of SEEDS) {
      const base = randomRel(seed);
      const holder = npc(1);
      const sigma = swap(PLAYER, npc(3));
      const A = base.chooseVetoSave(holder, [PLAYER, npc(2)]);
      const B = relabel(base, sigma).chooseVetoSave(holder, [sigma(PLAYER), npc(2)]);
      expect(B === undefined ? undefined : sigma(B)).toBe(A);
      if (A === PLAYER) playerSaved++;
    }
    expect(playerSaved).toBeGreaterThan(0);
  });

  it("Houseguest's Choice: an NPC chip holder picks the player by the same bond read (same seeded roll) as a houseguest", () => {
    let playerPicked = 0;
    for (const seed of SEEDS) {
      const base = randomRel(seed);
      const holder = npc(1);
      const cands = [npc(2), PLAYER, npc(3), npc(4)];
      const sigma = swap(PLAYER, npc(5));
      const A = base.chooseStrongestBond(holder, cands, new SeededRandom(seed));
      const B = relabel(base, sigma).chooseStrongestBond(holder, cands.map(sigma), new SeededRandom(seed));
      expect(sigma(B)).toBe(A);
      if (A === PLAYER) playerPicked++;
    }
    expect(playerPicked).toBeGreaterThan(0);
  });

  it("the eviction vote (blocs, HOH referendum, jury management included): an NPC voter scores the player like a houseguest nominee", () => {
    const outcomes = new Set<boolean>();
    for (const seed of SEEDS) {
      const base = randomRel(seed);
      const voter = npc(1), hoh = npc(6);
      const sigma = swap(PLAYER, npc(7));
      const swapped = relabel(base, sigma);
      const ctxA: SeasonCtx = { player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel: base };
      const ctxB: SeasonCtx = { ...ctxA, rel: swapped }; // the player is still the player: only their SEAT moved
      const blocsA = detectBlocs({ rel: base, active: HOUSE, loyaltyOf: loyalty });
      const blocsB = detectBlocs({ rel: swapped, active: HOUSE.map(sigma), loyaltyOf: (id) => loyalty(sigma(id)) });
      const fn: [EntityId, EntityId] = [PLAYER, npc(2)];
      const A = voteChoice(voter, fn, ctxA, blocsA, hoh);
      const B = voteChoice(voter, [sigma(fn[0]), sigma(fn[1])], ctxB, blocsB, hoh);
      expect(sigma(B)).toBe(A);
      outcomes.add(A === PLAYER);
    }
    expect(outcomes).toEqual(new Set([true, false])); // the player is sometimes evicted, sometimes kept
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Campaigns & drives (0085 / 0086 / #1937): NPC schemes aim at the player as at anyone; the player's own push counts.
// ---------------------------------------------------------------------------------------------------------------
describe("campaigns and drives target the player and count the player's campaigns like anyone's", () => {
  const camp = (owner: EntityId, target: EntityId, decider: EntityId, goal: "evict" | "protect"): Campaign => ({
    id: `c:${owner}`, owners: [owner], goal, target, plan: ["lobby"], progress: 0.7, horizon: "week", status: "active",
    startedBeat: 1, deadlineBeat: 6, confidence: 0.7, knownTo: [owner, decider],
  });
  const deps = { player: PLAYER, influenceOf: () => ({ persuasiveness: 0.8, susceptibility: 0.6 }), trustOf: () => 0.5 };

  it("a campaign aimed at the player pushes a decider exactly as one aimed at a houseguest", () => {
    const decider = npc(1), owner = npc(2);
    for (const goal of ["evict", "protect"] as const) {
      const atPlayer = campaignPushFor([camp(owner, PLAYER, decider, goal)], PLAYER, decider, deps);
      const atNpc = campaignPushFor([camp(owner, npc(3), decider, goal)], npc(3), decider, deps);
      expect(Math.abs(atNpc)).toBeGreaterThan(0);
      expect(atPlayer).toBe(atNpc);
    }
  });

  it("the player's OWN campaign pushes a decider exactly as an NPC's (owner ruling 2026-11-03)", () => {
    const decider = npc(1);
    const byPlayer = campaignPushFor([camp(PLAYER, npc(3), decider, "evict")], npc(3), decider, deps);
    const byNpc = campaignPushFor([camp(npc(2), npc(3), decider, "evict")], npc(3), decider, deps);
    expect(byNpc).toBeGreaterThan(0);
    expect(byPlayer).toBe(byNpc);
  });

  it("formation and drives: an NPC whose top threat is the player forms the same evict campaign and drive as against a houseguest", () => {
    const actors = (top: EntityId): CampaignActor[] => [
      { id: npc(1), persuasiveness: 0.9, threats: [{ toward: top, threat: 0.92 }, { toward: npc(3), threat: 0.4 }], allies: [{ toward: npc(3), affinity: 0.5 }] },
      { id: npc(3), persuasiveness: 0.4, threats: [{ toward: npc(1), threat: 0.2 }], allies: [{ toward: npc(1), affinity: 0.3 }] },
    ];
    const sigma = swap(PLAYER, npc(9));
    const A = formCampaigns(actors(PLAYER), { rng: new SeededRandom(3), beat: 4 });
    const B = formCampaigns(actors(npc(9)), { rng: new SeededRandom(3), beat: 4 });
    expect(A.find((c) => c.owners[0] === npc(1))).toMatchObject({ goal: "evict", target: PLAYER });
    expect(B.map((c) => ({ ...c, target: sigma(c.target) }))).toEqual(A);
    const ctx = { nominated: false, aggression: 0.6, emotional: 0.4 };
    const dA = deriveDrive(actors(PLAYER)[0]!, ctx, undefined);
    const dB = deriveDrive(actors(npc(9))[0]!, ctx, undefined);
    expect(dA).toMatchObject({ motivation: "target", target: PLAYER });
    expect({ ...dB, target: sigma(dB.target!) }).toEqual(dA);
    expect(drivePushFor(dA, PLAYER)).toBeGreaterThan(0);
    expect(drivePushFor(dA, PLAYER)).toBe(drivePushFor(dB, npc(9)));
  });
});
