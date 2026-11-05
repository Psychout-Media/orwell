import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { SessionCore } from "../../src/engine/sessionSnapshot";
import type { DealView, DealRefusal, MakeDealReq } from "../../src/ports/GameSession";

/**
 * Engine-side NPC deal consent, through the real adapter (`ORWELL_NPC_DEAL_CONSENT`, default ON). The NPC's agreement is decided by the ENGINE from their own
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

describe("makeDeal — the NPC decides whether they agree", () => {
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
    expect(isRefusal(r1) && r1.reason).toBe("distrust");
    const b = setup(5, "dc-t");
    setEdge(b.p, b.npc, { trust: 0.3, affinity: 0.3, threat: 0.9 });
    const r2 = b.s.makeDeal(req(b.npc, "vote"));
    expect(isRefusal(r2) && r2.reason).toBe("threat");
    expect(a.s.getGameState().deals ?? []).toHaveLength(0);
    expect(b.s.getGameState().deals ?? []).toHaveLength(0);
  });

  it("a refusal carries a Vault-free in-fiction line for the narrator and no numbers", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, { trust: 0, affinity: 0.05, threat: 0.3 });
    const r = s.makeDeal(req(npc)) as DealRefusal;
    expect(r.refused).toBe(true);
    expect(r.narratable).toMatch(/trust/i);
    expect(JSON.stringify(r)).not.toMatch(/\d\.\d/);
    expect(Object.keys(r).sort()).toEqual(["narratable", "reason", "refused"]);
  });

  it("an NPC with a remembered grudge against the player refuses ('grudge') even at neutral edges", () => {
    const { s, npc, p } = setup();
    const core = JSON.parse(JSON.stringify(s.snapshot())) as SessionCore;
    core.live!.npcMemory = { [npc]: { [PLAYER]: [{ kind: "deal-broken", week: core.live!.week, severity: 1 }] } };
    s.restore(core);
    (s as unknown as { setNpcMemoryStandaloneEnabled(on: boolean): void }).setNpcMemoryStandaloneEnabled(true);
    setEdge(p, npc, NEUTRAL_EDGE); // restore() may rebuild the edges; pin them again
    const r = s.makeDeal(req(npc));
    expect(isRefusal(r) && r.reason).toBe("grudge");
  });

  it("an NPC who believes the player targets them refuses ('targeted') when the belief store is on", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, NEUTRAL_EDGE);
    const core = JSON.parse(JSON.stringify(s.snapshot())) as SessionCore;
    const week = core.live!.week;
    core.live!.beliefs = { [npc]: [{ id: "t1", holder: npc, kind: "targets-me", subject: PLAYER, object: npc, value: true, origin: "told", confidence: 0.95, week }] };
    s.restore(core);
    (s as unknown as { setNpcBeliefsEnabled(on: boolean): void }).setNpcBeliefsEnabled(true);
    setEdge(p, npc, NEUTRAL_EDGE); // restore() may rebuild the edges; pin them again
    const r = s.makeDeal(req(npc));
    expect(isRefusal(r) && r.reason).toBe("targeted");
    // with the belief store OFF the same claim is not read (flag-gated), so the NPC accepts
    (s as unknown as { setNpcBeliefsEnabled(on: boolean): void }).setNpcBeliefsEnabled(false);
    expect(isRefusal(s.makeDeal(req(npc)))).toBe(false);
  });

  it("an expensive ask from a stranger is refused as 'cost'", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, NEUTRAL_EDGE);
    (s as unknown as { setDealDepthEnabled(on: boolean): void }).setDealDepthEnabled(true);
    const r = s.makeDeal(req(npc, "comp-throw"));
    expect(isRefusal(r) && r.reason).toBe("cost");
  });

  it("is deterministic: the same state and seed give the same decision, across sessions, and a re-ask in the same beat re-reaches it", () => {
    const ask = (user: string): { first: string; again: string } => {
      const { s, npc, p } = setup(7, user);
      setEdge(p, npc, { trust: 0.12, affinity: 0.12, threat: 0.35 });
      const first = s.makeDeal(req(npc, "vote"));
      const again = s.makeDeal(req(npc, "vote"));
      return { first: isRefusal(first) ? first.reason : "accepted", again: isRefusal(again) ? again.reason : "accepted" };
    };
    const a = ask("dc-det-a");
    expect(ask("dc-det-b")).toEqual(a);
    expect(a.again).toBe(a.first);
  });

  it("a refusal records no deal and folds nothing: the whole snapshot is unchanged", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, { trust: 0, affinity: 0.1, threat: 0.5 });
    const before = JSON.stringify(s.snapshot());
    const events = s.getGameState().deals?.length ?? 0;
    const r = s.makeDeal({ ...req(npc), leverage: { bluff: true, subject: npc } });
    expect(isRefusal(r)).toBe(true);
    expect(JSON.stringify(s.snapshot())).toBe(before);
    expect(s.getGameState().deals?.length ?? 0).toBe(events);
  });

  it("an at-most-once replay of a refused deal returns the same refusal (and still folds nothing)", () => {
    const { s, npc, p } = setup();
    setEdge(p, npc, { trust: 0, affinity: 0.1, threat: 0.5 });
    const k = { ...req(npc), idempotencyKey: "dc-key-1" };
    const r1 = s.makeDeal(k);
    const before = JSON.stringify(s.snapshot());
    expect(s.makeDeal(k)).toEqual(r1);
    expect(JSON.stringify(s.snapshot())).toBe(before);
  });

  it("invalid requests keep the old contract: null (not a refusal)", () => {
    const { s } = setup();
    expect(s.makeDeal(req("nobody-here"))).toBeNull();
    expect(s.makeDeal(req(PLAYER))).toBeNull();
  });
});

describe("ORWELL_NPC_DEAL_CONSENT off — byte-identical to today", () => {
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
      return JSON.stringify(s.snapshot()).replace(/dc-id-(true|false)/g, "X");
    };
    expect(run(true)).toBe(run(false));
  });
});

describe("the MCP boundary: a refusal reaches the tool caller as a refusal, never as a deal", () => {
  it("McpServer.callTool('makeDeal') returns { refused, reason, narratable } for a declined deal and a DealView for an agreed one; the tool description tells the narrator the engine decides", async () => {
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
    expect(no.narratable.length).toBeGreaterThan(0);
    const yes = (await server.callTool("makeDeal", { with: b, kind: "safety", terms: "t" })) as DealView;
    expect(yes.id).toBeTruthy();
    const desc = PLAYER_TOOLS.find((t) => t.name === "makeDeal")!.description;
    expect(desc).toMatch(/ENGINE decides whether THEY agree/);
    expect(desc).toMatch(/refused/);
  });
});
