import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { RelationshipModel } from "../../src/engine/relationships";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import { nominationStrategy } from "../../src/engine/season";
import { NPC_MEMORY, recordMemory, salience, memoryGrudge, memoryFavor, memoryTilt, type MemoryEntry, type NpcMemoryLedger } from "../../src/engine/npcMemory";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0024 — NPC MEMORY ACTS (PO ruling 2026-11-03). A structured ledger (never `SoulProvider.recall`), written at
 * existing fold sites, whose bounded RESIDUAL tilts the NPC vote / nominations / replacement. Roles only — no names.
 */

const NONE = { threatAboveBaseline: 0, bondAboveNeutral: 0 };
const betrayal = (week: number, severity = 1): MemoryEntry => ({ kind: "deal-broken", week, severity });
const favor = (week: number, severity = 1): MemoryEntry => ({ kind: "veto-saved", week, severity });

describe("npcMemory — salience, decay and the residual floor", () => {
  it("salience decays with age; a clash holder (decayScale 0.5, sticky) holds a grudge longer than a forgiving one (1.7)", () => {
    const e = [betrayal(1)];
    const kinds = new Set(["deal-broken"] as const);
    const fresh = salience(e, kinds, 1, 1);
    const later = salience(e, kinds, 9, 1);
    expect(fresh).toBeCloseTo(1);
    expect(later).toBeCloseTo(0.25); // two half-lives (4 weeks each) for a neutral holder
    expect(salience(e, kinds, 9, 0.5)).toBeGreaterThan(later); // clash: the grudge is still half-salient
    expect(salience(e, kinds, 9, 1.7)).toBeLessThan(later); // forgiving: mostly let go
  });

  it("is week-based, not recency-ranked: an OLD betrayal is not forgotten because newer kindnesses exist", () => {
    const entries = [betrayal(1), favor(8), favor(9)];
    const grudge = memoryGrudge(entries, 10, 1, NONE);
    expect(grudge).toBeGreaterThan(0);
    // the favors do not erase the grudge; they only add their own (weaker) warm term
    expect(memoryFavor(entries, 10, 1, NONE)).toBeGreaterThan(0);
    expect(memoryFavor(entries, 10, 1, NONE)).toBeLessThanOrEqual(NPC_MEMORY.favorMax);
  });

  it("the RESIDUAL floor: a fresh shock the edge still carries contributes 0; the memory only grows as the edge decays", () => {
    const entries = [betrayal(5)];
    const carried = memoryGrudge(entries, 5, 1, { threatAboveBaseline: 0.3, bondAboveNeutral: 0 }); // edge still hot
    const decayed = memoryGrudge(entries, 8, 1, NONE); // edge mean-reverted
    expect(carried).toBe(0);
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThanOrEqual(NPC_MEMORY.grudgeMax);
  });

  it("is bounded: a grudge never exceeds grudgeMax and a favor never exceeds favorMax, however many pile up", () => {
    const pile = Array.from({ length: 12 }, (_, i) => betrayal(i + 1));
    const ledger: NpcMemoryLedger = {};
    for (const e of pile) recordMemory(ledger, npc(1), npc(2), e);
    expect(ledger[npc(1)]![npc(2)]!.length).toBeLessThanOrEqual(NPC_MEMORY.maxEntriesPerPair);
    expect(memoryGrudge(ledger[npc(1)]![npc(2)], 13, 1, NONE)).toBeLessThanOrEqual(NPC_MEMORY.grudgeMax);
    expect(NPC_MEMORY.grudgeMax).toBeLessThan(RELATIONSHIP_CONSTANTS.BETRAYAL_SHOCK.threat ?? 1); // never exceeds a fresh betrayal
    expect(NPC_MEMORY.favorMax).toBeLessThan(NPC_MEMORY.grudgeMax); // negativity bias
  });

  it("the signed tilt is +grudge − favor; self-memories are never recorded", () => {
    const entries = [betrayal(1), favor(1)];
    expect(memoryTilt(entries, 4, 1, NONE)).toBeCloseTo(memoryGrudge(entries, 4, 1, NONE) - memoryFavor(entries, 4, 1, NONE));
    const ledger: NpcMemoryLedger = {};
    recordMemory(ledger, npc(1), npc(1), betrayal(1));
    expect(ledger).toEqual({});
  });
});

describe("the vote and nominations honor the memory tilt (discriminating fixtures)", () => {
  const [voter, a, b] = [npc(5), npc(1), npc(2)];
  const narrow = (): RelationshipModel => {
    const rel = new RelationshipModel(0.5);
    rel.edge(voter, a).threat = 0.42;
    rel.edge(voter, b).threat = 0.4;
    return rel;
  };
  const ctx = (rel: RelationshipModel, memoryTiltFor?: (s: EntityId, h: EntityId) => number): SeasonCtx => ({
    player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel, ...(memoryTiltFor ? { memoryTiltFor } : {}),
  });

  it("absent / zero ⇒ identical vote; a grudge toward `b` flips the vote from `a` to `b`; a favor toward `a` flips it away", () => {
    const rel = narrow();
    expect(voteChoice(voter, [a, b], ctx(rel))).toBe(a);
    expect(voteChoice(voter, [a, b], ctx(rel, () => 0))).toBe(a);
    expect(voteChoice(voter, [a, b], ctx(rel, (s, h) => (s === b && h === voter ? NPC_MEMORY.grudgeMax : 0)))).toBe(b);
    expect(voteChoice(voter, [a, b], ctx(rel, (s, h) => (s === a && h === voter ? -NPC_MEMORY.favorMax * 2 : 0)))).toBe(b);
  });

  it("a grudge pulls a low read onto the block; absent it does not", () => {
    const hoh = npc(7);
    const rel = new RelationshipModel(0.5);
    const active = [hoh, npc(1), npc(2), npc(3), npc(4)];
    rel.edge(hoh, npc(1)).threat = 0.6;
    rel.edge(hoh, npc(2)).threat = 0.5;
    rel.edge(hoh, npc(3)).threat = 0.4;
    rel.edge(hoh, npc(4)).threat = 0.15;
    const base = nominationStrategy(hoh, active, rel);
    expect(base).not.toContain(npc(4));
    // Exaggerated to exercise the plumbing; the real residual is clamped to grudgeMax upstream.
    const pushed = nominationStrategy(hoh, active, rel, { memoryPush: (t) => (t === npc(4) ? NPC_MEMORY.grudgeMax * 20 : 0) });
    expect(pushed).toContain(npc(4));
  });
});

describe("the adapter wiring (live)", () => {
  function liveHouse(seed: number) {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.createCharacter({ playerName: "The Player", seed });
    const ids = (session.snapshot().house?.npcs ?? []).map((n) => n.id);
    return { session, rel, ids };
  }
  type Priv = {
    live: { week: number; npcMemory?: NpcMemoryLedger; hoh?: EntityId; nominees?: [EntityId, EntityId]; saved?: EntityId; vetoHolder?: EntityId };
    foldCeremonyConsequence(ev: { beat: string; participants: EntityId[]; content: string }): void;
    ctx(): { memoryTiltFor?: (s: EntityId, h: EntityId) => number };
    memoryTiltFor(s: EntityId, h: EntityId): number;
    memoryBlocksPlayerDeal(id: EntityId): boolean;
    remember(h: EntityId, s: EntityId, k: "deal-broken" | "veto-saved", sev: number): void;
  };
  const p = (s: GameSessionAdapter): Priv => s as unknown as Priv;

  it("flags-off: no provider, nothing is ever written, the live state carries no ledger", () => {
    const { session, rel, ids } = liveHouse(41);
    expect(p(session).ctx().memoryTiltFor).toBeUndefined();
    const s = p(session).live;
    s.hoh = ids[0]!;
    s.nominees = [ids[1]!, ids[2]!];
    rel.edge(ids[1]!, ids[0]!).trust = 0.9;
    p(session).foldCeremonyConsequence({ beat: "nominations", participants: [], content: "" });
    expect(p(session).live.npcMemory).toBeUndefined();
    expect(JSON.stringify(session.snapshot())).not.toContain("npcMemory");
  });

  it("on: a nominee who TRUSTED the HOH remembers it; one who did not does not (the trust test reads the pre-fold edge)", () => {
    const { session, rel, ids } = liveHouse(42);
    session.setNpcMemoryEnabled(true);
    const s = p(session).live;
    s.hoh = ids[0]!;
    s.nominees = [ids[1]!, ids[2]!];
    rel.edge(ids[1]!, ids[0]!).trust = 0.9; // a friend
    rel.edge(ids[2]!, ids[0]!).trust = 0.05; // not a friend
    p(session).foldCeremonyConsequence({ beat: "nominations", participants: [], content: "" });
    const led = p(session).live.npcMemory!;
    expect(led[ids[1]!]?.[ids[0]!]?.[0]?.kind).toBe("nominated-by-friend");
    expect(led[ids[2]!]).toBeUndefined();
  });

  it("on: a veto save is remembered as a favor and the PLAYER is never a holder", () => {
    const { session, ids } = liveHouse(43);
    session.setNpcMemoryEnabled(true);
    const s = p(session).live;
    s.saved = ids[3]!;
    s.vetoHolder = ids[4]!;
    p(session).foldCeremonyConsequence({ beat: "veto-ceremony", participants: [], content: "" });
    expect(p(session).live.npcMemory![ids[3]!]![ids[4]!]![0]!.kind).toBe("veto-saved");
    p(session).remember(PLAYER, ids[0]!, "deal-broken", 1);
    expect(p(session).live.npcMemory![PLAYER]).toBeUndefined();
  });

  it("on: a decayed grudge toward the player tilts the vote and stops the NPC floating a deal; the player holder gets 0", () => {
    const { session, rel, ids } = liveHouse(44);
    session.setNpcMemoryEnabled(true);
    const npcId = ids[5]!;
    rel.edge(npcId, PLAYER).threat = RELATIONSHIP_CONSTANTS.baseline.threat; // the edge has mean-reverted ⇒ the full residual shows
    p(session).live.week = 8;
    p(session).remember(npcId, PLAYER, "deal-broken", 1);
    p(session).live.week = 9; // a week on: still highly salient whatever the holder temperament, so a real grudge
    expect(p(session).memoryTiltFor(PLAYER, npcId)).toBeGreaterThan(0);
    expect(p(session).memoryBlocksPlayerDeal(npcId)).toBe(true);
    expect(p(session).memoryTiltFor(npcId, PLAYER)).toBe(0); // the player's own seat is never modulated
    expect(p(session).ctx().memoryTiltFor).toBeDefined();
  });

  it("an ATTRIBUTED deal break (a public nomination) is remembered by the wronged party; a SEALED-ballot break writes NOTHING (the leak test)", () => {
    const { session, ids } = liveHouse(47);
    session.setNpcMemoryEnabled(true);
    type Deals = { deals: { make(parties: [EntityId, EntityId], kind: string, terms: string, ev?: string, week?: number): unknown }; reconcileDeals(a: { actor: EntityId; kind: string; targets: readonly EntityId[] }): void };
    const d = session as unknown as Deals;
    const [breaker, wronged] = [ids[0]!, ids[1]!];
    d.deals.make([breaker, wronged], "safety", "keep each other safe", undefined, 1);
    // A sealed eviction ballot: the wronged party must NOT learn (by behaviour) who voted against them.
    d.reconcileDeals({ actor: breaker, kind: "vote-evict", targets: [wronged] });
    expect(p(session).live.npcMemory?.[wronged]?.[breaker]).toBeUndefined();
    // A public nomination of the protected partner is attributed: the wronged party remembers the breaker.
    const d2 = liveHouse(48);
    d2.session.setNpcMemoryEnabled(true);
    const dd = d2.session as unknown as Deals;
    dd.deals.make([d2.ids[0]!, d2.ids[1]!], "safety", "keep each other safe", undefined, 1);
    dd.reconcileDeals({ actor: d2.ids[0]!, kind: "nominate", targets: [d2.ids[1]!] });
    expect(p(d2.session).live.npcMemory?.[d2.ids[1]!]?.[d2.ids[0]!]?.[0]?.kind).toBe("deal-broken");
  });

  it("NO player-facing projection carries a REAL planted ledger entry (it is in the save, absent from every projection)", async () => {
    const runtime = composeRuntime({ clock: new FakeClock(), seed: 1 });
    const user = "memory-leak";
    const mcp = runtime.registry.resolver()("player", user);
    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 49 });
    const sb = runtime.registry.sandboxFor(user);
    sb.session.setNpcMemoryEnabled(true);
    const state = (await mcp.callTool("getGameState", {})) as { house: Array<{ id: string }> };
    const [h, subj] = [state.house[0]!.id as EntityId, state.house[1]!.id as EntityId];
    // A distinctive severity so the check is on the ENTRY, not on kind names that could never appear anyway.
    const SENTINEL = 0.817346;
    (sb.session as unknown as Priv).remember(h, subj, "deal-broken", SENTINEL);
    expect(JSON.stringify((sb.session as unknown as Priv).live.npcMemory)).toContain("0.817346"); // really planted
    expect(JSON.stringify(sb.session.snapshot())).toContain("0.817346"); // and really persisted in the save
    const sweep = async (label: string): Promise<void> => {
      for (const [tool, args] of [
        ["getGameState", {}], ["whereabouts", {}], ["socialRead", { id: h }], ["npcVoice", { id: h }], ["npcVoice", { id: subj }],
        ["stateDelta", {}], ["seasonRecap", {}], ["dailyRecap", {}], ["getVisibleStateFor", { entity: "player" }], ["socialInitiatives", {}],
        ["playerDossier", {}], ["playerReceipts", {}],
      ] as const) {
        let out: string;
        try { out = JSON.stringify(await mcp.callTool(tool, args as Record<string, unknown>)); } catch { continue; } // a tool unavailable pre-premiere
        expect(out, `${label}: ${tool} must not carry the planted entry`).not.toContain("0.817346");
        expect(out, `${label}: ${tool} must not expose the ledger key`).not.toContain("npcMemory");
      }
    };
    await sweep("fresh");
    for (let i = 0; i < 12; i++) await mcp.callTool("advanceGame", {}); // the projections after the loop has run
    await sweep("after advancing");
  });

  it("the ledger persists with the live state and survives a snapshot/restore", () => {
    const { session, ids } = liveHouse(45);
    session.setNpcMemoryEnabled(true);
    p(session).remember(ids[0]!, ids[1]!, "deal-broken", 0.8);
    const revived = new GameSessionAdapter();
    revived.restore(session.snapshot());
    expect(p(revived).live.npcMemory).toEqual(p(session).live.npcMemory);
  });

  it("is deterministic and rng-free: two identical runs write the identical ledger", () => {
    const run = (): NpcMemoryLedger | undefined => {
      const { session, ids } = liveHouse(46);
      session.setNpcMemoryEnabled(true);
      p(session).remember(ids[0]!, ids[1]!, "deal-broken", 0.8);
      p(session).remember(ids[0]!, ids[1]!, "veto-saved", 0.6);
      return p(session).live.npcMemory;
    };
    expect(run()).toEqual(run());
  });
});
