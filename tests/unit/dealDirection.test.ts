import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { DealView, DealRefusal, MakeDealReq } from "../../src/ports/GameSession";
import { decideDealConsent } from "../../src/engine/dealConsent";

/**
 * B55 (a bug in #2110): a player-proposed comp-throw / veto-save bound the PLAYER as promisor (parties[0]) but dealConsent priced it as a cost to the NPC, so the player's OFFER was refused as "costs too much" and
 * ASKING an NPC to throw still bound the player. The proposer's DIRECTION now decides the promisor (offering vs asking) and the cost is priced to the promisor. Default = offer (the narrator schema already says
 * "throw a competition FOR them"), which is the binding the engine always had. Roles only.
 */
type Sess = ReturnType<GameSessionRegistry["sandboxFor"]>["session"];
interface Edge { trust: number; affinity: number; threat: number }
type Priv = { rel: { edge(a: string, b: string): Edge }; setDealDepthEnabled(on: boolean): void; deals: { open(): Array<{ kind: string; parties: string[]; condition: { promisors: string[]; protect: string } }> } };
function setup(seed = 5, user = "dir") {
  const s: Sess = new GameSessionRegistry().sandboxFor(`${user}-${seed}`).session;
  s.createCharacter({ playerName: "P", seed });
  s.advanceGame(); s.advanceGame();
  const p = s as unknown as Priv;
  p.setDealDepthEnabled(true);
  const npc = s.livingIds().filter((id) => id !== PLAYER)[0]!;
  return { s, p, npc };
}
const NEUTRAL: Edge = { trust: 0.25, affinity: 0.25, threat: 0.3 };
const ALLY: Edge = { trust: 1, affinity: 1, threat: 0 };
const isRefusal = (r: DealView | DealRefusal | null): r is DealRefusal => !!r && (r as DealRefusal).refused === true;
const req = (npc: string, kind: "comp-throw" | "veto-save", direction?: "offer" | "ask"): MakeDealReq => ({ with: npc, kind, terms: "t", ...(direction ? { direction } : {}) });

describe("pure pricing: the cost is the promisor's", () => {
  const base = { trust: 0.25, affinity: 0.25, threat: 0.3, grudge: 0, favor: 0, targetsMe: 0, jitter: 0 };
  it("an ASK of the NPC is priced as before (a stranger refuses as cost); an OFFER by the player costs the NPC nothing (a stranger accepts)", () => {
    for (const kind of ["comp-throw", "veto-save"] as const) {
      expect(decideDealConsent({ ...base, kind })).toEqual({ accept: false, reason: "cost" });
      expect(decideDealConsent({ ...base, kind, direction: "ask" })).toEqual({ accept: false, reason: "cost" });
      expect(decideDealConsent({ ...base, kind, direction: "offer" }).accept, kind).toBe(true);
    }
  });
});

describe("the live deal: offer binds the player, ask binds the NPC", () => {
  it("OFFER (the default): a stranger accepts the player's offer to throw / save, and the PLAYER is the promisor", () => {
    for (const kind of ["comp-throw", "veto-save"] as const) {
      for (const dir of [undefined, "offer" as const]) {
        const { s, p, npc } = setup(5, `o-${kind}-${dir}`);
        Object.assign(p.rel.edge(npc, PLAYER), NEUTRAL);
        const r = s.makeDeal(req(npc, kind, dir));
        expect(isRefusal(r), `${kind}/${dir} offered by the player is not 'too costly' for the NPC`).toBe(false);
        const d = p.deals.open().find((x) => x.kind === kind)!;
        expect(d.condition.promisors).toEqual([PLAYER]);
        expect(d.condition.protect).toBe(npc);
      }
    }
  });
  it("ASK: a stranger refuses ('cost'), a close ally agrees, and the NPC is then the promisor protecting the player", () => {
    for (const kind of ["comp-throw", "veto-save"] as const) {
      const a = setup(5, `a-${kind}`);
      Object.assign(a.p.rel.edge(a.npc, PLAYER), NEUTRAL);
      const refused = a.s.makeDeal(req(a.npc, kind, "ask"));
      expect(isRefusal(refused) && refused.reason, kind).toBe("cost");
      expect(a.p.deals.open()).toHaveLength(0);
      const b = setup(5, `b-${kind}`);
      Object.assign(b.p.rel.edge(b.npc, PLAYER), ALLY);
      const ok = b.s.makeDeal(req(b.npc, kind, "ask"));
      expect(isRefusal(ok)).toBe(false);
      const d = b.p.deals.open().find((x) => x.kind === kind)!;
      expect(d.condition.promisors).toEqual([b.npc]);
      expect(d.condition.protect).toBe(PLAYER);
    }
  });
  it("defensive kinds are unaffected by a direction (mutual / player-first as before)", () => {
    const { s, p, npc } = setup(5, "def");
    Object.assign(p.rel.edge(npc, PLAYER), ALLY);
    const r = s.makeDeal({ with: npc, kind: "safety", terms: "t", direction: "ask" });
    expect(isRefusal(r)).toBe(false);
    expect(p.deals.open().find((x) => x.kind === "safety")!.parties[0]).toBe(PLAYER);
  });
});

import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { buildSandbox } from "../support/sandbox";

describe("the MCP boundary carries the direction (the FE write-back wiring)", () => {
  function server() {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    session.createCharacter({ playerName: "The Player", seed: 5 });
    session.advanceGame(); session.advanceGame();
    session.setDealDepthEnabled(true);
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    return { srv: new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session }), session };
  }
  it("a junk direction is refused at the boundary; offer / ask pass through to the engine", async () => {
    const { srv, session } = server();
    const npc = session.livingIds().filter((id) => id !== PLAYER)[0]!;
    await expect(srv.callTool("makeDeal", { with: npc, kind: "comp-throw", terms: "t", direction: "sideways" })).rejects.toThrow(/direction/);
    (session as unknown as Priv).rel.edge(npc, PLAYER).trust = 1;
    const ok = (await srv.callTool("makeDeal", { with: npc, kind: "comp-throw", terms: "t", direction: "ask" })) as DealView | DealRefusal | null;
    expect(isRefusal(ok)).toBe(false);
    const d = (session as unknown as Priv).deals.open().find((x) => x.kind === "comp-throw")!;
    expect(d.condition.promisors).toEqual([npc]);
  });
});
