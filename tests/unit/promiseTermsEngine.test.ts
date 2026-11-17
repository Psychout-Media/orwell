import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { claimsOf, type BeliefStore } from "../../src/engine/beliefStore";
import { brokenPromiseClaimId } from "../../src/engine/promiseTerms";
import type { OpenLedger } from "../../src/engine/openLedger";

/**
 * ORW-586 / 0187 - a promise that carries a term is judged by the ENGINE on the same board events that settle assurances. Real engine, no model. Roles only:
 * the promiser, the promisee (who it was made to), a third houseguest.
 */
type Mem = { kind: string; severity: number };
type G = {
  recordPromiseTerm(r: unknown): { accepted: boolean; reason?: string; entryId?: string; duplicate?: boolean };
  resolveOpenLedger(r: unknown): { accepted: boolean; reason?: string };
  assuranceNominated(h: string, n: string, among?: readonly string[]): void;
  assuranceVotedOut(v: string, n: string, among?: readonly string[]): void;
  assuranceKeptAtNominations(h: string, ns: readonly string[]): void;
  assuranceKeptAtVote(v: string, spared: string, among?: readonly string[]): void;
  rel: { edge(a: string, b: string): { trust: number } };
  setNpcBeliefsEnabled(on: boolean): void; setMemoryPromisesEnabled(on: boolean): void; setPromiseTermsEnabled(on: boolean): void; setLiesCaughtEnabled(on: boolean): void;
  movePlayer(room: string): { present: Array<{ id: string }> } | undefined;
  noteMessage(m: unknown): void; setAdvanceGateEnabled(on: boolean): void;
  snapshot(): { live: { assurances?: { items: Array<{ status: string; kind: string }> }; beliefs?: BeliefStore; npcMemory?: Record<string, Record<string, Mem[]>> }; openLedger?: OpenLedger };
  openLedgerHere(): unknown[];
};
function started(opts: { flag?: boolean } = {}) {
  const sb = new GameSessionRegistry().sandboxFor(`pt-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  (sb.session as unknown as { live: { playedGame?: boolean } }).live.playedGame = true;
  g.setAdvanceGateEnabled(false);
  sb.session.setAssurancesEnabled(true);
  g.setNpcBeliefsEnabled(true); g.setMemoryPromisesEnabled(true); g.setLiesCaughtEnabled(true);
  g.setPromiseTermsEnabled(opts.flag ?? true);
  g.noteMessage({ messageId: "m1" });
  const present = g.movePlayer("living-room")!.present.map((p) => p.id).filter((i) => i !== PLAYER);
  if (present.length < 3) throw new Error("need three houseguests present");
  const [promiser, promisee, third] = present as [string, string, string];
  return { sb, g, promiser, promisee, third, others: present };
}
const snap = (g: G) => g.snapshot();
const entry = (g: G, id: string) => snap(g).openLedger!.entries.find((e) => e.id === id)!;
const trust = (g: G, a: string, b: string): number => g.rel.edge(a, b).trust;
const sev = (g: G, holder: string, about: string, kind: string): number => (snap(g).live.npcMemory?.[holder]?.[about] ?? []).filter((m) => m.kind === kind).reduce((n, m) => n + m.severity, 0);
const lied = (g: G, holder: string) => claimsOf(snap(g).live.beliefs ?? {}, holder).filter((c) => c.kind === "lied-to-me");

describe("an NPC's promise with a term is judged by the engine", () => {
  it("no-nominate: kept when final nominations leave the promisee off, the entry closed by the engine with an engine note", () => {
    const { g, promiser, promisee, third } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    expect(r.accepted).toBe(true);
    g.assuranceKeptAtNominations(promiser, [third]);
    const e = entry(g, r.entryId!);
    expect(e.status).toBe("kept");
    expect(e.note).toMatch(/^engine judged kept/);
    expect(sev(g, promisee, promiser, "deal-kept")).toBeGreaterThan(0);
    expect(snap(g).live.assurances!.items.map((a) => a.status)).toEqual(["kept"]); // ONE resolver: the assurance row agrees
  });
  it("no-nominate: broken when the promiser nominates the promisee: the entry closes broken, trust drops once, a lied-to-me claim is written", () => {
    const { g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    const t0 = trust(g, promisee, promiser);
    g.assuranceNominated(promiser, promisee);
    g.assuranceNominated(promiser, promisee); // a repeat is a no-op
    const e = entry(g, r.entryId!);
    expect(e.status).toBe("broken");
    expect(trust(g, promisee, promiser)).toBeCloseTo(Math.max(0, t0 - 0.12), 10);
    expect(lied(g, promisee).filter((c) => c.subject === promiser)).toHaveLength(1);
    expect(snap(g).live.assurances!.items.map((a) => a.status)).toEqual(["broken"]);
  });
  it("a promise about a THIRD person (no assurance row) is folded by the term itself: same magnitudes, the stable claim id, idempotent", () => {
    const { g, promiser, promisee, third } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate", subject: third });
    expect(snap(g).live.assurances?.items ?? []).toHaveLength(0);
    const t0 = trust(g, promisee, promiser);
    g.assuranceNominated(promiser, third);
    g.assuranceNominated(promiser, third);
    expect(entry(g, r.entryId!).status).toBe("broken");
    expect(trust(g, promisee, promiser)).toBeCloseTo(Math.max(0, t0 - 0.12), 10);
    const claims = lied(g, promisee).filter((c) => c.subject === promiser);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.id).toBe(brokenPromiseClaimId(promisee, promiser, r.entryId!));
    expect(claims[0]!.confidence).toBe(0.8);
    expect(sev(g, promisee, promiser, "deal-broken")).toBeGreaterThan(0);
  });
  it("a promise about a third person kept: the promisee remembers a favor at the kept severity", () => {
    const { g, promiser, promisee, third, others } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate", subject: third });
    g.assuranceKeptAtNominations(promiser, others.filter((o) => o !== third && o !== promiser).slice(0, 2));
    expect(entry(g, r.entryId!).status).toBe("kept");
    expect(sev(g, promisee, promiser, "deal-kept") + lied(g, promisee).length).toBeGreaterThan(0); // a favor, or (B39) the seeded rumored break; never nothing
  });
  it("a player-as-promiser break DOES fold: the NPC promisee loses trust in the player", () => {
    const { g, promisee } = started();
    const r = g.recordPromiseTerm({ by: PLAYER, to: promisee, what: "no-nominate", subject: promisee });
    expect(r.accepted).toBe(true);
    const t0 = trust(g, promisee, PLAYER);
    g.assuranceNominated(PLAYER, promisee);
    expect(entry(g, r.entryId!).status).toBe("broken");
    expect(trust(g, promisee, PLAYER)).toBeCloseTo(Math.max(0, t0 - 0.12), 10);
  });
  it("a promise made TO the player closes, but nothing acts on the player's hidden read (the #1963 rule)", () => {
    const { g, promiser } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: PLAYER, what: "no-nominate" });
    expect(r.accepted).toBe(true);
    const t0 = trust(g, PLAYER, promiser);
    g.assuranceNominated(promiser, PLAYER);
    expect(entry(g, r.entryId!).status).toBe("broken");
    expect(trust(g, PLAYER, promiser)).toBe(t0);
    expect(lied(g, PLAYER)).toEqual([]);
  });
});

describe("the model may only withdraw a termed promise", () => {
  it("refuses kept and broken, accepts withdrawn, and leaves a free-text entry resolvable", () => {
    const { g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    expect(g.resolveOpenLedger({ entryId: r.entryId, status: "kept", note: "x" })).toEqual({ accepted: false, reason: "engine-judged" });
    expect(g.resolveOpenLedger({ entryId: r.entryId, status: "broken", note: "x" })).toEqual({ accepted: false, reason: "engine-judged" });
    expect(entry(g, r.entryId!).status).toBe("open");
    expect(g.resolveOpenLedger({ entryId: r.entryId, status: "withdrawn", note: "x" })).toEqual({ accepted: true });
  });
});

describe("a promise with no term, or share-info, is never auto-judged", () => {
  it("share-info stays open through every board fact and no assurance row is written", () => {
    const { g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "share-info" });
    g.assuranceNominated(promiser, promisee); g.assuranceKeptAtNominations(promiser, []); g.assuranceVotedOut(promiser, promisee); g.assuranceKeptAtVote(promiser, promisee);
    expect(entry(g, r.entryId!).status).toBe("open");
    expect(snap(g).live.assurances?.items ?? []).toHaveLength(0);
  });
});

describe("a sealed-ballot break names nobody", () => {
  it("the folded promise is pool-split with no named claim, and the visible entry stays open", () => {
    const { g, promiser, promisee, third, others } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-evict-vote", subject: third });
    const pool = [promiser, ...others.filter((o) => o !== promisee && o !== promiser)];
    g.assuranceVotedOut(promiser, third, pool);
    expect(entry(g, r.entryId!).status, "a 'broken' line would single the voter out").toBe("open");
    expect(lied(g, promisee), "no claim naming anyone").toEqual([]);
    const shares = pool.filter((s) => s !== promisee).map((s) => sev(g, promisee, s, "deal-broken"));
    expect(shares[0]!).toBeGreaterThan(0);
    for (const x of shares) expect(x).toBeCloseTo(shares[0]!, 12);
  });
});

describe("persistence and the flag", () => {
  it("a save and load keeps the term and the outcome", () => {
    const { g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    g.assuranceNominated(promiser, promisee);
    const saved = JSON.parse(JSON.stringify(snap(g).openLedger)) as OpenLedger;
    const e = saved.entries.find((x) => x.id === r.entryId)!;
    expect(e.term).toMatchObject({ by: promiser, to: promisee, what: "no-nominate" });
    expect(e.status).toBe("broken");
  });
  it("flag off: nothing is recorded, nothing is judged, a model may still resolve", () => {
    const { g, promiser, promisee } = started({ flag: false });
    expect(g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" })).toEqual({ accepted: false, reason: "off" });
    g.assuranceNominated(promiser, promisee);
    expect(snap(g).openLedger?.entries ?? []).toHaveLength(0);
  });
  it("the player-visible view carries no term and no judgement note", () => {
    const { g, promiser, promisee } = started();
    g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    g.assuranceNominated(promiser, promisee);
    expect(JSON.stringify(g.openLedgerHere())).not.toMatch(/term|engine judged|"what"|subject/);
  });
  it("the hooks are wired from the same liveSeason ctx as the assurances (source pin)", () => {
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    expect(src.match(/this\.settleTermsAt\(/g)!.length).toBeGreaterThanOrEqual(4);
  });
});
