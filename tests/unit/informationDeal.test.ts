import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { conditionFor, actionBreaks, actionHonors, horizonOf, type Deal } from "../../src/domain/deal";
import { DealLedger } from "../../src/engine/deals";
import type { DealView } from "../../src/ports/GameSession";

/**
 * ORW-88 / 0142 idea 3 (information): "I will tell you what I hear." The NPC (promisor) passes the player ONE held, witnessed-or-told fact per beat, ONLY while the two are in the same room, through the
 * content-anchored told-by pathway. Never Vault content. Played games with deal depth on only. Roles only.
 */
const SENTINEL = "VAULT-SENTINEL-INFO-DEAL";
type Internals = {
  live: { playedGame?: boolean; week: number };
  deals: { open(): Deal[] };
  presence: Map<string, string>;
  setNpcDealConsentEnabled(on: boolean): void;
  setDealDepthEnabled(on: boolean): void;
  deliverInformationDeals(): void;
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
};
function game(played = true, depth = true) {
  const sb = new GameSessionRegistry().sandboxFor(`info-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Internals;
  g.setNpcDealConsentEnabled(true); g.setDealDepthEnabled(depth); g.live.playedGame = played;
  const [npc, third] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  const e = g.rel.edge(npc!, PLAYER); e.trust = 0.7; e.affinity = 0.7; e.threat = 0.1;
  // the teller HOLDS a witnessed fact about a third houseguest (and a Vault secret exists that must never ride along)
  sb.engine.knowledge.seedBelief(npc!, { content: "the third was seen packing a bag", originalContent: "the third was seen packing a bag", factId: "fact:info-1", confidence: 0.9, hops: 0, distortion: 0, source: third!, subject: third! } as never, "origin");
  return { s: sb.session, sb, g, npc: npc!, third: third! };
}
const ask = (x: ReturnType<typeof game>) => x.s.makeDeal({ with: x.npc, kind: "information", terms: "tell me what you hear" } as never);
const playerHas = (x: ReturnType<typeof game>) => x.sb.engine.knowledge.knownTo(PLAYER).map((f) => f.content);

describe("the pure rule", () => {
  it("is week-scoped, one-way, and can never be broken or honored by a binding act", () => {
    const d = { id: "d", status: "open", kind: "information", terms: "t", parties: ["npc:a", "player"], condition: conditionFor("information", ["npc:a", "player"]) } as Deal;
    expect(horizonOf("information")).toBe("week");
    expect(d.condition.promisors).toEqual(["npc:a"]);
    for (const kind of ["nominate", "replace", "vote-evict"] as const) {
      expect(actionBreaks(d, { actor: "npc:a", kind, targets: ["player"] })).toBe(false);
      expect(actionHonors(d, { actor: "npc:a", kind, targets: ["npc:c"], alternatives: ["player", "npc:c"] })).toBe(false);
    }
  });
  it("an information deal that never delivered expires neutrally (not kept); one that delivered resolves kept", () => {
    const ledger = new DealLedger();
    const idle = ledger.make(["npc:a", "player"], "information", "t", undefined, 1);
    const told = ledger.make(["npc:b", "player"], "information", "t", undefined, 1);
    told.delivered = 1;
    expect(ledger.expireWeekScoped(2)).toEqual([told]);
    expect(told.status).toBe("kept");
    // deliberate re-pin (ORW-316): the undelivered deal used to be DELETED from the ledger (its object kept the stale "open"), which the non-degradation checkpoint refuses; it now LAPSES and stays in the saved list.
    expect(idle.status).toBe("lapsed");
    expect(ledger.open()).not.toContain(idle);
    expect(ledger.serialize().map((d) => d.id)).toContain(idle.id);
  });
});

describe("making it", () => {
  it("a willing NPC makes it in a played game with deal depth on; the NPC is the promisor", () => {
    const x = game();
    expect((ask(x) as DealView).kind).toBe("information");
    expect(x.g.deals.open()[0]!.parties).toEqual([x.npc, PLAYER]);
  });
  it("is refused (null) when nobody is playing or deal depth is off", () => {
    expect(ask(game(false))).toBeNull();
    expect(ask(game(true, false))).toBeNull();
  });
});

describe("delivery: only through co-presence, only held facts, never the Vault", () => {
  it("passes nothing when the two are not together; passes one held fact when they are (both ways)", () => {
    const x = game();
    ask(x);
    x.g.presence.set(PLAYER, "room:a"); x.g.presence.set(x.npc, "room:b");
    x.g.deliverInformationDeals();
    expect(playerHas(x)).not.toContain("the third was seen packing a bag");
    expect(x.g.deals.open()[0]!.delivered).toBeUndefined();
    x.g.presence.set(x.npc, "room:a");
    x.g.deliverInformationDeals();
    expect(playerHas(x)).toContain("the third was seen packing a bag");
    expect(x.g.deals.open()[0]!.delivered).toBe(1);
  });
  it("a fact the player already holds is not passed again", () => {
    const x = game();
    ask(x);
    x.g.presence.set(PLAYER, "room:a"); x.g.presence.set(x.npc, "room:a");
    x.g.deliverInformationDeals(); x.g.deliverInformationDeals();
    expect(x.g.deals.open()[0]!.delivered).toBe(1);
  });
  it("Vault sentinel: a sealed secret about the teller (and a hidden thread) never rides the told fact or any player surface", async () => {
    const x = game();
    x.sb.engine.vault.writeHidden({ id: "v:info-attr", kind: "hidden-attribute", subject: x.npc, content: SENTINEL });
    x.sb.engine.vault.writeHidden({ id: "v:info-conf", kind: "confessional", subject: x.npc, content: SENTINEL });
    expect(x.sb.engine.vault.readHidden().some((r) => r.content === SENTINEL)).toBe(true); // the sentinel really is sealed
    ask(x);
    x.g.presence.set(PLAYER, "room:a"); x.g.presence.set(x.npc, "room:a");
    x.g.deliverInformationDeals();
    expect(x.g.deals.open()[0]!.delivered).toBe(1);
    expect(JSON.stringify(x.sb.engine.knowledge.knownTo(PLAYER))).not.toContain(SENTINEL);
    for (const tool of ["getGameState", "getVisibleStateFor", "getMomentPrompt"]) {
      const out = await x.sb.mcp.player.callTool(tool, tool === "getVisibleStateFor" ? { id: PLAYER } : {});
      expect(JSON.stringify(out)).not.toContain(SENTINEL);
    }
    expect(JSON.stringify(x.sb.engine.events.queryAll().filter((e) => e.witnessSet.includes(PLAYER)))).not.toContain(SENTINEL);
  });
  it("delivery is a no-op without an information deal (headless byte-identity: no rng, no event)", () => {
    const x = game();
    const before = x.sb.engine.events.count();
    x.g.presence.set(x.npc, x.g.presence.get(PLAYER)!);
    x.g.deliverInformationDeals();
    expect(x.sb.engine.events.count()).toBe(before);
  });
});
