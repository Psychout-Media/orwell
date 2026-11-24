import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { SessionCore } from "../../src/engine/sessionSnapshot";
import type { DealView, DealRefusal, MakeDealReq } from "../../src/ports/GameSession";

/** ORW-608: the REAL refusal reason is engine-only (never on the outward object); tests read it through the adapter's private map (TEST-ONLY seam). */
const realOf = (session: unknown, r: unknown): string | undefined => (session as { refusalReal: WeakMap<object, string> }).refusalReal.get(r as object);


/**
 * Engine-side NPC deal consent, through the real adapter with edges, memories and beliefs SET BY HAND (unit tests; the REAL PATH is tests/realpath/dealConsentLive.test.ts and
 * tests/realpath/dealConsentChain.test.ts, ORW-811) (`ORWELL_NPC_DEAL_CONSENT`, default ON). The NPC's agreement is decided by the ENGINE from their own
 * read of the player (trust / warmth / threat / remembered grudges + favors / belief that the player targets them) and the ask's cost — never the narrator.
 * A refusal records no deal and folds nothing. Flag OFF is today's behaviour exactly. Roles only.
 */
type Sess = ReturnType<GameSessionRegistry["sandboxFor"]>["session"];
interface Edge { trust: number; affinity: number; threat: number }
type Priv = { rel: { edge(a: string, b: string): Edge }; setNpcDealConsentEnabled(on: boolean): void; npcDealConsentEnabledNow(): boolean };

function setup(seed = 5, user = "dc"): { s: Sess; npc: string; other: string; p: Priv } {
  const s = new GameSessionRegistry().sandboxFor(`${user}-${seed}`).session;
  s.createCharacter({ playerName: "P", seed });
  s.advanceGame(); s.advanceGame();
  const ids = s.livingIds().filter((id) => id !== PLAYER);
  return { s, npc: ids[0]!, other: ids[1]!, p: s as unknown as Priv };
}
const setEdge = (p: Priv, npc: string, e: Partial<Edge>): void => { Object.assign(p.rel.edge(npc, PLAYER), e); };
const NEUTRAL_EDGE: Edge = { trust: 0.25, affinity: 0.25, threat: 0.3 }; // the "typical newcomer" reference edge (willingness 0)
const isRefusal = (r: DealView | DealRefusal | null): r is DealRefusal => !!r && (r as DealRefusal).refused === true;
const req = (npc: string, kind: MakeDealReq["kind"] = "safety"): MakeDealReq => ({ with: npc, kind, terms: "we look out for each other" });

// ORW-305: the hidden decision-WHY record is metadata about a decision (a refusal is a decision), not game state: compare snapshots without it.
const snapNoWhy = (s: { snapshot(): unknown }): string => JSON.stringify(s.snapshot(), (k, v) => (k === "decisionWhy" ? undefined : v));

describe("unit, state set by hand: makeDeal — the NPC decides whether they agree", () => {
  it("the flag defaults ON", () => {
    expect(setup().p.npcDealConsentEnabledNow()).toBe(true);
  });

  it("a trusted, warm NPC accepts a low-cost ask: a deal is recorded", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, { trust: 0.85, affinity: 0.8, threat: 0.05 });
    const r = s.makeDeal(req(npc));
    expect(isRefusal(r)).toBe(false);
    expect((r as DealView).kind).toBe("safety");
    expect(s.getGameState().deals?.length).toBe(1);
  });

  it("a distrustful NPC refuses ('distrust'), a threatened one ('threat'), and no deal is recorded", () => {
    const a = setup(5, "dc-d");
    setEdge(a.p, a.npc, { trust: 0, affinity: 0.05, threat: 0.3 });
    const r1 = a.s.makeDeal(req(a.npc));
    expect(isRefusal(r1) && realOf(a.s, r1)).toBe("distrust");
    const b = setup(5, "dc-t");
    setEdge(b.p, b.npc, { trust: 0.3, affinity: 0.3, threat: 0.9 });
    const r2 = b.s.makeDeal(req(b.npc, "vote"));
    expect(isRefusal(r2) && realOf(b.s, r2)).toBe("threat");
    expect(a.s.getGameState().deals ?? []).toHaveLength(0);
    expect(b.s.getGameState().deals ?? []).toHaveLength(0);
  });

  it("ORW-608: a refusal carries only the reason the houseguest GIVES (a stated-reason kind), no fixed line, no numbers", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, { trust: 0, affinity: 0.05, threat: 0.3 });
    const r = s.makeDeal(req(npc)) as DealRefusal;
    expect(r.refused).toBe(true);
    expect(["didnt-trust-you", "nothing-personal", "house-wants-it", "biggest-threat", "came-after-me"]).toContain(r.reason);
    expect(JSON.stringify(r)).not.toMatch(/\d\.\d/);
    expect(Object.keys(r).sort()).toEqual(["reason", "refused"]);
  });

  it("an NPC with a remembered grudge against the player refuses ('grudge') even at neutral edges", () => {
    const { s, npc, p } = setup();
    const core = JSON.parse(snapNoWhy(s)) as SessionCore;
    core.live!.npcMemory = { [npc]: { [PLAYER]: [{ kind: "deal-broken", week: core.live!.week, severity: 1 }] } };
    s.restore(core);
    (s as unknown as { setNpcMemoryStandaloneEnabled(on: boolean): void }).setNpcMemoryStandaloneEnabled(true);
    setEdge(p, npc, NEUTRAL_EDGE); // restore() may rebuild the edges; pin them again
    const r = s.makeDeal(req(npc));
    expect(isRefusal(r) && realOf(s, r)).toBe("grudge");
  });

  it("an NPC who believes the player targets them refuses ('targeted') when the belief store is on", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, NEUTRAL_EDGE);
    const core = JSON.parse(snapNoWhy(s)) as SessionCore;
    const week = core.live!.week;
    core.live!.beliefs = { [npc]: [{ id: "t1", holder: npc, kind: "targets-me", subject: PLAYER, object: npc, value: true, origin: "told", confidence: 0.95, week }] };
    s.restore(core);
    (s as unknown as { setNpcBeliefsEnabled(on: boolean): void }).setNpcBeliefsEnabled(true);
    setEdge(p, npc, NEUTRAL_EDGE); // restore() may rebuild the edges; pin them again
    const r = s.makeDeal(req(npc));
    expect(isRefusal(r) && realOf(s, r)).toBe("targeted");
    // with the belief store OFF the same claim is not read (flag-gated), so the NPC accepts
    (s as unknown as { setNpcBeliefsEnabled(on: boolean): void }).setNpcBeliefsEnabled(false);
    expect(isRefusal(s.makeDeal(req(npc)))).toBe(false);
  });

  it("an expensive ASK of a stranger (the NPC is to throw the comp) is refused as 'cost'; the player's own OFFER to throw is not (B55)", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, NEUTRAL_EDGE);
    (s as unknown as { setDealDepthEnabled(on: boolean): void }).setDealDepthEnabled(true);
    const r = s.makeDeal({ ...req(npc, "comp-throw"), direction: "ask" });
    expect(isRefusal(r) && realOf(s, r)).toBe("cost");
    expect(isRefusal(s.makeDeal(req(npc, "comp-throw"))), "the default is the player's offer, which costs the NPC nothing").toBe(false);
  });

  it("is deterministic: the same state and seed give the same decision, across sessions, and a re-ask in the same beat re-reaches it", () => {
    const ask = (user: string): { first: string; again: string } => {
      const { s, npc, p } = setup(7, user);
      setEdge(p, npc, { trust: 0.12, affinity: 0.12, threat: 0.35 });
      const first = s.makeDeal(req(npc, "vote"));
      const again = s.makeDeal(req(npc, "vote"));
      return { first: isRefusal(first) ? (first.reason ?? first.illegal ?? "refused") : "accepted", again: isRefusal(again) ? (again.reason ?? again.illegal ?? "refused") : "accepted" };
    };
    const a = ask("dc-det-a");
    expect(ask("dc-det-b")).toEqual(a);
    expect(a.again).toBe(a.first);
  });

  it("a refusal records no deal and folds nothing: the whole snapshot is unchanged", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, { trust: 0, affinity: 0.1, threat: 0.5 });
    const before = snapNoWhy(s);
    const events = s.getGameState().deals?.length ?? 0;
    const r = s.makeDeal({ ...req(npc), leverage: { bluff: true, subject: npc } });
    expect(isRefusal(r)).toBe(true);
    expect(snapNoWhy(s)).toBe(before);
    expect(s.getGameState().deals?.length ?? 0).toBe(events);
  });

  it("an at-most-once replay of a refused deal returns the same refusal (and still folds nothing)", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, { trust: 0, affinity: 0.1, threat: 0.5 });
    const k = { ...req(npc), idempotencyKey: "dc-key-1" };
    const r1 = s.makeDeal(k);
    const before = snapNoWhy(s);
    expect(s.makeDeal(k)).toEqual(r1);
    expect(snapNoWhy(s)).toBe(before);
  });

  it("invalid requests keep the old contract: null (not a refusal)", () => {
    const { s } = setup();
    expect(s.makeDeal(req("nobody-here"))).toBeNull();
    expect(s.makeDeal(req(PLAYER))).toBeNull();
  });
});

describe("unit, state set by hand: ORWELL_NPC_DEAL_CONSENT off — byte-identical to today", () => {
  it("OFF: a hostile NPC still 'agrees' (the deal is recorded exactly as before)", () => {
    const { s, npc, p } = setup();
    p.setNpcDealConsentEnabled(false);
    setEdge(p, npc, { trust: 0, affinity: 0, threat: 0.95 });
    const r = s.makeDeal(req(npc));
    expect(isRefusal(r)).toBe(false);
    expect((r as DealView).kind).toBe("safety");
  });

  it("an ACCEPTED deal leaves exactly the state flag-OFF leaves (the consent check draws nothing from shared state)", () => {
    const run = (on: boolean): string => {
      const { s, npc, p } = setup(9, `dc-id-${on}`);
      p.setNpcDealConsentEnabled(on);
      setEdge(p, npc, { trust: 0.8, affinity: 0.8, threat: 0.05 });
      const r = s.makeDeal(req(npc));
      expect(isRefusal(r)).toBe(false);
      // advance on, so any hidden shared-rng drift would show in the following beats
      s.advanceGame();
      return snapNoWhy(s).replace(/dc-id-(true|false)/g, "X");
    };
    expect(run(true)).toBe(run(false));
  });
});

describe("unit, state set by hand: the MCP boundary: a refusal reaches the tool caller as a refusal, never as a deal", () => {
  it("McpServer.callTool('makeDeal') returns { refused, reason } for a declined deal and a DealView for an agreed one; the tool description tells the narrator the engine decides", async () => {
    const { McpServer } = await import("../../src/adapters/mcp/McpServer");
    const { EngineCommandsAdapter } = await import("../../src/adapters/engine/EngineCommandsAdapter");
    const { PLAYER_TOOLS } = await import("../../src/surfaces/tools/registry");
    const { buildSandbox } = await import("../support/sandbox");
    const { GameSessionAdapter } = await import("../../src/adapters/engine/GameSessionAdapter");
    const sb = buildSandbox(5);
    const session = new GameSessionAdapter();
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands: new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge), session });
    session.createCharacter({ playerName: "The Player", seed: 5 });
    session.advanceGame(); session.advanceGame();
    const [a, b] = session.livingIds().filter((id) => id !== PLAYER) as [string, string];
    const p = session as unknown as Priv;
    setEdge(p, a, { trust: 0, affinity: 0.1, threat: 0.6 });
    setEdge(p, b, { trust: 0.85, affinity: 0.8, threat: 0.05 });
    const no = (await server.callTool("makeDeal", { with: a, kind: "safety", terms: "t" })) as DealRefusal;
    expect(no.refused).toBe(true);
    expect(typeof no.reason).toBe("string");
    expect(no.reason).not.toMatch(/^(distrust|threat|targeted|grudge|opposed|cost)$/); // ORW-608: the real reason never crosses
    const yes = (await server.callTool("makeDeal", { with: b, kind: "safety", terms: "t" })) as DealView;
    expect(yes.id).toBeTruthy();
    const desc = PLAYER_TOOLS.find((t) => t.name === "makeDeal")!.description;
    expect(desc).toMatch(/ENGINE decides whether THEY agree/);
    expect(desc).toMatch(/refused/);
  });
});

describe("unit, state set by hand: ORW-608: a refused deal gives a stated reason; the real one never crosses", () => {
  it("a houseguest scheming against the player, or who believes the player is coming after them, never says so - across many houses only covers come out", async () => {
    const { GameSessionRegistry } = await import("../../src/composition/registry");
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const sb = new GameSessionRegistry().sandboxFor(`orw608-${seed}`);
      sb.session.createCharacter({ playerName: "The Player", seed });
      const g = sb.session as unknown as { live: { playedGame?: boolean }; dealConsentRefusal(n: string, k: string): { reason: string } | null; refusalReal: WeakMap<object, string>; ownPushAgainstPlayer(n: string): number };
      g.live.playedGame = true;
      for (const npc of sb.session.livingIds().filter((id) => id !== PLAYER)) {
        g.ownPushAgainstPlayer = () => 5; // TEST-ONLY seam: every houseguest is working against the player (the 'opposed' drag dominates)
        const r = g.dealConsentRefusal(npc, "safety");
        if (!r) continue;
        const real = g.refusalReal.get(r);
        if (real === "opposed" || real === "targeted") seen.add(r.reason);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const said of seen) expect(["nothing-personal", "didnt-trust-you"]).toContain(said); // covers only: never a scheme, never "you're coming after me"
  });
  it("an honest houseguest's distrust is sometimes said as it is", async () => {
    const { truthfulKind } = await import("../../src/engine/agendaDecisions");
    expect(truthfulKind({ decision: "deal-consent", decider: "n", choice: PLAYER, terms: [], refusal: "distrust" })).toBe("didnt-trust-you");
    expect(truthfulKind({ decision: "deal-consent", decider: "n", choice: PLAYER, terms: [], refusal: "opposed" })).toBe("nothing-personal");
  });
});
