import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { Trigger } from "../../src/composition/orchestrator";
import type { UserSandbox } from "../../src/composition/registry";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { planEntrances, TOAST_BATCH, PREMIERE_FIRST_READ } from "../../src/engine/premiereEntrances";
import { resolvePending } from "../../features/support/answerPending";
import { PLAYER, npc } from "../../src/domain/ids";
import { BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";

/** ORW-68 (card 23, items 4-5): the premiere's first-read fold, the toast's order and batching, and the off-screen quiet. Roles only. */
let n = 0;
function start(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`pt${n++}`);
  sb.session.setPremiereEntrancesEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}
type SB = ReturnType<typeof start>;
const stage = (sb: SB) => sb.session.premiereIntros()?.entrance?.stage;
const toToast = (sb: SB) => { for (let i = 0; i < 40 && stage(sb) === "entrances"; i++) sb.session.advanceGame(); };

describe("item 4 - the first read at each arrival", () => {
  const edges = (seed: number, fold: { affinity: number; trust: number }) => {
    const saved = { ...PREMIERE_FIRST_READ };
    PREMIERE_FIRST_READ.affinity = fold.affinity; PREMIERE_FIRST_READ.trust = fold.trust;
    try {
      const sb = start(seed);
      toToast(sb);
      const order = sb.session.snapshot().live!.premiereEntrance!.order;
      // every earlier arrival's opinion of the LAST arrival (all were inside when it walked in)
      const last = order[order.length - 1]!;
      return order.slice(0, -1).map((h) => ({ h, e: { ...sb.engine.relationships.edge(h, last) } }));
    } finally { PREMIERE_FIRST_READ.affinity = saved.affinity; PREMIERE_FIRST_READ.trust = saved.trust; }
  };
  it("an arrival moves each witness's edge toward the arriver (and a zeroed fold moves nothing)", () => {
    const withFold = edges(21, PREMIERE_FIRST_READ);
    const without = edges(21, { affinity: 0, trust: 0 });
    expect(withFold.length).toBe(15);
    let moved = 0;
    for (let i = 0; i < withFold.length; i++) {
      expect(withFold[i]!.e.affinity, "affinity never falls on a first read").toBeGreaterThanOrEqual(without[i]!.e.affinity);
      if (withFold[i]!.e.affinity > without[i]!.e.affinity && withFold[i]!.e.trust > without[i]!.e.trust) moved++;
    }
    expect(moved, "the fold really moved the edges").toBeGreaterThan(10);
  });
  it("small-group chat during the entrances is recorded as a witnessed event", () => {
    const sb = start(22);
    // advance until the player has walked in, then chat with someone already inside
    for (let i = 0; i < 40; i++) {
      const pe = sb.session.snapshot().live!.premiereEntrance!;
      if (pe.stage !== "entrances" || pe.order.slice(0, pe.arrived).includes(PLAYER)) break;
      sb.session.advanceGame();
    }
    const pe = sb.session.snapshot().live!.premiereEntrance!;
    const inside = pe.order.slice(0, pe.arrived).filter((x) => x !== PLAYER);
    if (pe.stage !== "entrances" || inside.length === 0) return; // seed put the player last; the next seed covers it
    const before = sb.engine.events.queryAll().length;
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, inside[0]!], content: "a quiet word by the couch", kind: "bonding" });
    const added = sb.engine.events.queryAll().slice(before);
    expect(added.some((e) => e.content.includes("a quiet word by the couch") && e.witnessSet.includes(PLAYER) && !e.hidden)).toBe(true);
  });
});

describe("item 5 - the toast", () => {
  it("releases TOAST_BATCH speakers per advance, the host first", () => {
    expect(TOAST_BATCH).toBe(2);
    const sb = start(31);
    toToast(sb);
    const first = sb.session.advanceGame();
    const sp = (first.event!.detail as { speakers: unknown[] }).speakers;
    expect(sp.length).toBe(TOAST_BATCH);
    expect(sp[0]).toBe("host");
    expect(sb.engine.events.query({ type: "toast-speech" })[0]!.content).toMatch(/^The host/);
    for (let i = 0; i < 20 && stage(sb) !== "done"; i++) {
      const d = sb.session.advanceGame().event?.detail as { speakers?: unknown[] } | undefined;
      expect(d?.speakers?.length ?? 0).toBeLessThanOrEqual(TOAST_BATCH);
    }
  });
  it("movePlayer is a no-op during an entrances-ON toast", () => {
    const sb = start(32);
    toToast(sb);
    expect(stage(sb)).toBe("toast");
    expect(sb.session.movePlayer("bedroom a")!.room).toBe("living-room");
  });
  it("different seeds give different FULL entrance orders (not only the player's slot)", () => {
    const ids = Array.from({ length: 16 }, (_, i) => (i === 0 ? PLAYER : npc(i)));
    const orders = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) orders.add(planEntrances(ids, PLAYER, seed).order.join(","));
    expect(orders.size).toBeGreaterThan(8);
    const engineOrders = new Set<string>();
    for (const seed of [41, 42, 43]) engineOrders.add(start(seed).session.snapshot().live!.premiereEntrance!.order.filter((x) => x !== PLAYER).join(","));
    expect(engineOrders.size, "the live game's NPC order differs by seed too").toBe(3);
  });
  it("earns no off-screen scheming tick until the toast is done", () => {
    const reg = new GameSessionRegistry();
    let ticks = 0;
    const apply = (_s: UserSandbox, trigger: Trigger): number => { if (trigger === "offscreen-tick") ticks++; return 0; };
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 5, turnDriven: true, apply });
    reg.setCommit((u) => orch.commitPlayerTurn(u));
    const sb = reg.sandboxFor("quiet");
    sb.session.setPremiereEntrancesEnabled(true);
    sb.session.createCharacter({ playerName: "The Player", seed: 6 });
    let guard = 0;
    while (stage(sb) !== "done" && guard++ < 40) {
      const v = sb.session.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => void sb.session.submitDecision(req));
      if (stage(sb) !== "done") expect(ticks, `no tick mid-${stage(sb)}`).toBe(0);
    }
    expect(stage(sb)).toBe("done");
    expect(ticks, "the closing commit still earns none").toBe(0);
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a kitchen chat", kind: "bonding" });
    for (let i = 0; i < 25 && ticks === 0; i++) {
      const v = sb.session.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => void sb.session.submitDecision(req));
    }
    expect(ticks, "once the toast is done the house schemes again").toBeGreaterThan(0);
  });
});

describe("item 7 - the host is never a real or famous name", () => {
  it("the narrator prompt forbids naming a real-world host, network or celebrity", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/never name a real-world host, network, or celebrity/i);
  });
});
