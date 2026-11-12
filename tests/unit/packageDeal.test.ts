import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { DealLedger, PACKAGE_BREAK_SCALE, type ReconcileSink } from "../../src/engine/deals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import type { Deal } from "../../src/domain/deal";
import type { DealView, DealRefusal } from "../../src/ports/GameSession";

/**
 * ORW-88 / 0142 idea 3 (package): two promises bundled in one deal. Each part is gated + consent-checked on its own before anything is recorded; each is adjudicated on its OWN condition; a break of either
 * also costs the package's reliability. Played games with deal depth on only. Roles only.
 */
type Internals = {
  live: { playedGame?: boolean };
  deals: { open(): Deal[]; all: readonly Deal[] };
  reconcileDeals(a: unknown): void;
  setNpcDealConsentEnabled(on: boolean): void;
  setDealDepthEnabled(on: boolean): void;
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
};
function game(played = true, depth = true, bond = 0.7) {
  const sb = new GameSessionRegistry().sandboxFor(`pkg-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Internals;
  g.setNpcDealConsentEnabled(true); g.setDealDepthEnabled(depth); g.live.playedGame = played;
  const [n, third, other] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  const e = g.rel.edge(n!, PLAYER); e.trust = bond; e.affinity = bond; e.threat = 0.1;
  return { s: sb.session, sb, g, npc: n!, third: third!, other: other! };
}
type G = ReturnType<typeof game>;
const pkg = (x: G, parts?: unknown) => x.s.makeDeal({ with: x.npc, kind: "package", terms: "a bundle",
  parts: parts ?? [{ kind: "safety" }, { kind: "protect-third", third: x.third }] } as never);

describe("making it", () => {
  it("a willing NPC makes both parts, sharing a packageId; the NPC is the promisor of the protect-third part", () => {
    const x = game();
    const v = pkg(x) as DealView;
    expect(v.kind).toBe("package");
    expect(v.parts).toHaveLength(2);
    const open = x.g.deals.open();
    expect(open.map((d) => d.kind).sort()).toEqual(["protect-third", "safety"]);
    expect(new Set(open.map((d) => d.packageId)).size).toBe(1);
    expect(open[0]!.packageId).toBe(v.packageId);
  });
  it("is refused (null) outside a played game, with deal depth off, or when malformed - and records nothing", () => {
    for (const x of [game(false), game(true, false)]) { expect(pkg(x)).toBeNull(); expect(x.g.deals.open()).toHaveLength(0); }
    const y = game();
    for (const bad of [[{ kind: "safety" }], [{ kind: "safety" }, { kind: "safety" }], [{ kind: "safety" }, { kind: "comp-throw" }], [{ kind: "safety" }, { kind: "protect-third" }], [{ kind: "safety" }, null], "x"]) {
      expect(pkg(y, bad)).toBeNull();
    }
    expect(y.g.deals.open()).toHaveLength(0);
  });
  it("a refusal on either part refuses the whole package: no deal, no event", () => {
    const x = game(true, true, 0.0);
    const events = x.sb.engine.events.count();
    const out = pkg(x) as DealRefusal;
    expect(out.refused).toBe(true);
    expect(x.g.deals.open()).toHaveLength(0);
    expect(x.sb.engine.events.count()).toBe(events);
  });
});

describe("each part is adjudicated on its own; a break of either costs the package", () => {
  it("breaking the protect-third part breaks ONLY that part, the safety part stays open", () => {
    const x = game(); pkg(x);
    x.g.reconcileDeals({ actor: x.npc, kind: "nominate", targets: [x.third] });
    const by = (k: string) => x.g.deals.all.find((d) => d.kind === k)!;
    expect(by("protect-third").status).toBe("broken");
    expect(by("safety").status).toBe("open");
  });
  it("the ledger folds a further betrayal hit for a packaged break, none for a stand-alone one (both ways)", () => {
    const A = npc(1), B = npc(2), C = npc(3);
    const run = (packageId?: string) => {
      const rel = new RelationshipModel(0.5), ledger = new DealLedger();
      const d = ledger.make([A, B], "target-other", "spare them", undefined, 1);
      if (packageId) d.packageId = packageId;
      const sink: ReconcileSink = { rel, rng: new SeededRandom(7), dealDepth: true, currentWeek: 1 };
      ledger.reconcile({ actor: A, kind: "nominate", targets: [B] }, sink);
      expect(d.status).toBe("broken");
      const e = rel.edge(B, A); return e.trust - e.threat - e.affinity * 0.5;
    };
    void C;
    expect(run("pkg:1")).toBeLessThan(run());
    expect(PACKAGE_BREAK_SCALE).toBeGreaterThan(0);
    // dealDepth off: no extra cost even when packaged (headless byte-identity)
    const rel = new RelationshipModel(0.5), ledger = new DealLedger();
    const d = ledger.make([A, B], "target-other", "t", undefined, 1); d.packageId = "pkg:1";
    const plain = new RelationshipModel(0.5), l2 = new DealLedger(); l2.make([A, B], "target-other", "t", undefined, 1);
    ledger.reconcile({ actor: A, kind: "nominate", targets: [B] }, { rel, rng: new SeededRandom(7), currentWeek: 1 });
    l2.reconcile({ actor: A, kind: "nominate", targets: [B] }, { rel: plain, rng: new SeededRandom(7), currentWeek: 1 });
    expect(JSON.stringify(rel.edge(B, A))).toBe(JSON.stringify(plain.edge(B, A)));
  });
});
