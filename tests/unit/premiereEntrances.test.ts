import { endHeldNightSync } from "../support/heldNight";
import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { planEntrances, toastSpeakers, PREMIERE_FIRST_READ } from "../../src/engine/premiereEntrances";
import { resolvePending } from "../../features/support/answerPending";
import type { AdvanceView } from "../../src/ports/GameSession";

/** A9 - staged premiere entrances + toast. Roles only; no fixture names. */
let n = 0;
function start(seed: number, on = true) {
  const sb = new GameSessionRegistry().sandboxFor(`pe${n++}`);
  sb.session.setPremiereEntrancesEnabled(on);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}
const ids16 = (s: GameSessionAdapter): string[] => {
  const h = s.snapshot().house!;
  return [h.player.id, ...h.npcs.map((x) => x.id)];
};
const entranceEvents = (sb: ReturnType<typeof start>) => sb.engine.events.query({ type: "premiere-entrance" });
const toastEvents = (sb: ReturnType<typeof start>) => sb.engine.events.query({ type: "toast-speech" });
function runToDone(sb: ReturnType<typeof start>): AdvanceView[] {
  const views: AdvanceView[] = [];
  for (let i = 0; i < 40 && sb.session.premiereIntros()?.entrance?.stage !== "done"; i++) views.push(sb.session.advanceGame());
  return views;
}

describe("A9 pure plan", () => {
  const ids = Array.from({ length: 16 }, (_, i) => `x${i}`);
  it("is a permutation, seeded, and varies the player's slot", () => {
    const p = planEntrances(ids, "x0", 7);
    expect([...p.order].sort()).toEqual([...ids].sort());
    expect(p.order[p.playerPos]).toBe("x0");
    expect(planEntrances(ids, "x0", 7)).toEqual(p);
    const positions = new Set(Array.from({ length: 20 }, (_, s) => planEntrances(ids, "x0", s).playerPos));
    expect(positions.size).toBeGreaterThanOrEqual(3);
  });
  it("toast speakers: host first then entrance order (player slot included as a marker)", () => {
    const p = planEntrances(ids, "x0", 3);
    expect(toastSpeakers(p.order)).toEqual(["host", ...p.order]);
  });
});

describe("A9 engine entrances", () => {
  it("flag OFF: premiereEntrance absent and the snapshot equals a build that never knew the feature", () => {
    const a = start(11, false), b = new GameSessionRegistry().sandboxFor("pe-plain");
    b.session.createCharacter({ playerName: "The Player", seed: 11 });
    expect(a.session.snapshot().live!.premiereEntrance).toBeUndefined();
    expect(JSON.stringify(a.session.snapshot().live)).not.toContain("premiereEntrance");
    expect(JSON.stringify(a.session.snapshot().live)).toEqual(JSON.stringify(b.session.snapshot().live));
    expect(a.session.premiereIntros()!.entrance).toBeUndefined();
    expect(a.session.whereabouts()!.houseEvent!.kind).toBe("champagne-circle");
  });

  it("each houseguest enters exactly once; stages entrances -> toast -> done; then HOH staging works", () => {
    const sb = start(11);
    const s = sb.session;
    const pe0 = s.snapshot().live!.premiereEntrance!;
    expect(pe0.stage).toBe("entrances");
    expect(pe0.arrived).toBe(pe0.playerPos);
    expect(s.snapshot().live!.champagneCircle).toBeUndefined();
    const stages: string[] = [];
    const arrivalViews: AdvanceView[] = [];
    for (let i = 0; i < 40; i++) {
      const st = s.premiereIntros()!.entrance!.stage;
      if (st === "done") break;
      const v = s.advanceGame();
      if (st === "entrances") arrivalViews.push(v);
      stages.push(st);
    }
    expect(stages[0]).toBe("entrances");
    expect(stages.at(-1)).toBe("toast");
    const ents = entranceEvents(sb);
    expect(ents.length).toBe(16);
    expect(new Set(ents.map((e) => e.content)).size).toBe(16);
    // released one at a time, with the contract detail
    expect(arrivalViews.length).toBe(16 - pe0.playerPos);
    const d = (arrivalViews[0]!.event!.detail as { index: number; of: number; playerEntrance: boolean; arriver: { name: string } });
    expect(d.of).toBe(16);
    expect(arrivalViews.filter((v) => (v.event!.detail as { playerEntrance: boolean }).playerEntrance).length).toBe(1);
    expect(s.snapshot().live!.champagneCircle).toBe("done");
    // old HOH-staging advance works only now
    const v = s.advanceGame();
    expect(v.event?.beat).not.toBe("premiere-entrance");
  });

  it("every NPC and the player end up pairwise met via witness sets; per-NPC knowledge is witness-scoped", () => {
    const sb = start(5);
    runToDone(sb);
    const ids = ids16(sb.session);
    const ents = entranceEvents(sb);
    const witnessOf = (id: string) => ents.find((e) => e.content.startsWith(`${sb.session.publicName(id)} arrives`))!;
    // an earlier arriver is a witness of every later arrival; a later arriver does not witness earlier ones
    const order = sb.session.snapshot().live!.premiereEntrance!.order;
    for (let i = 0; i < order.length; i++) {
      const w = witnessOf(order[i]!).witnessSet;
      for (let j = 0; j < order.length; j++) expect(w.includes(order[j]!)).toBe(j <= i);
    }
    for (const a of ids) for (const b of ids) if (a !== b) {
      const later = order.indexOf(a) > order.indexOf(b) ? a : b, earlier = later === a ? b : a;
      expect(witnessOf(later).witnessSet).toContain(earlier);
    }
  });

  it("host and every NPC speaker have a toast-speech; the player's slot is not recorded", () => {
    const sb = start(5);
    runToDone(sb);
    const t = toastEvents(sb).map((e) => e.content);
    const me = sb.session.snapshot().house!.player.id;
    expect(t.filter((c) => c.startsWith("The host")).length).toBe(1);
    expect(t.length).toBe(16); // host + 15 NPCs; the player's slot is chat-authored
    expect(t.some((c) => c.startsWith(`${sb.session.publicName(me)} `))).toBe(false);
    for (const e of toastEvents(sb)) expect(e.witnessSet.length).toBe(16);
    expect(sb.session.snapshot().live!.premiereEntrance!.spoke.length).toBe(17);
  });

  it("un-arrived NPCs are absent from whereabouts, approaches and met lists during the entrances", () => {
    const sb = start(11);
    const s = sb.session;
    for (let k = 0; k < 3; k++) {
      const pe = s.snapshot().live!.premiereEntrance!;
      if (pe.stage !== "entrances") break;
      const outside = new Set(pe.order.slice(pe.arrived));
      const me = s.snapshot().house!.player.id;
      const w = s.whereabouts()!;
      expect(w.houseEvent!.kind).toBe("premiere-entrances");
      const shown = [...w.present, ...w.nearby.flatMap((r) => r.present), ...(w.companions ?? [])].map((x) => x.id);
      for (const id of shown) expect(outside.has(id) && id !== me).toBe(false);
      expect(w.present.length).toBe(pe.arrived - (pe.order.slice(0, pe.arrived).includes(me) ? 1 : 0));
      for (const a of s.socialInitiatives()) expect(outside.has(a.houseguest.id)).toBe(false);
      const view = s.premiereIntros()!;
      expect(view.complete).toBe(true);
      expect(view.powerReachable).toBe(true);
      expect(view.remaining).toEqual([]);
      for (const m of view.met) expect(outside.has(m.houseguest.id)).toBe(false);
      s.markHouseguestMet([...outside].find((x) => x !== me)!); // a stray belt mark of an un-arrived NPC is a no-op
      for (const m of s.premiereIntros()!.met) expect(outside.has(m.houseguest.id)).toBe(false);
      s.advanceGame();
    }
  });

  it("board entrance view: public names only, positions 1-based", () => {
    const sb = start(11);
    const e = sb.session.premiereIntros()!.entrance!;
    expect(e.total).toBe(16);
    expect(e.stage).toBe("entrances");
    expect(e.playerPosition).toBe(sb.session.snapshot().live!.premiereEntrance!.playerPos + 1);
    expect(e.arrivedNames.length).toBe(e.index);
    for (const nm of e.arrivedNames) expect(nm).not.toMatch(/^npc:/);
  });

  it("snapshot/restore mid-entrances resumes at the same arrival", () => {
    const a = start(11), b = start(11);
    for (let i = 0; i < 2; i++) { a.session.advanceGame(); b.session.advanceGame(); }
    const revived = new GameSessionAdapter();
    revived.restore(a.session.snapshot());
    expect(revived.snapshot().live!.premiereEntrance).toEqual(b.session.snapshot().live!.premiereEntrance);
    const next = b.session.snapshot().live!.premiereEntrance!;
    const v = revived.advanceGame();
    expect((v.event!.detail as { index: number }).index).toBe(next.arrived + 1);
    expect(revived.snapshot().live!.premiereEntrance!.arrived).toBe(next.arrived + 1);
  });

  it("the entrance draw does not perturb the season: flag on/off reach the same full-run eviction order", () => {
    const run = (on: boolean): string[] => {
      const sb = start(7, on);
      for (let i = 0; i < 8000; i++) {
        const v = sb.session.advanceGame();
        if (v.held) endHeldNightSync(sb.session, { direct: true }); // ORW-116: a held night is the player's: time passes, then they turn in
        if (v.pending) resolvePending(v.pending, (r) => void sb.session.submitDecision(r));
        if (v.finished) break;
      }
      return sb.session.snapshot().live!.evictionOrder;
    };
    // The staging + the order draw alone must not perturb the spine; the (deliberate, bounded) first-read
    // fold is a real consequence and is neutralized here to isolate the draw. With it ON the season may differ.
    const saved = { ...PREMIERE_FIRST_READ };
    PREMIERE_FIRST_READ.affinity = 0; PREMIERE_FIRST_READ.trust = 0;
    try {
      const off = run(false), on = run(true);
      expect(off.length).toBeGreaterThan(5);
      expect(on).toEqual(off);
    } finally { Object.assign(PREMIERE_FIRST_READ, saved); }
  });
});

/** ORW-205 - the engine supplies the one true headcount in the entrance payload. */
describe("ORW-205 entrance headcount", () => {
  it("insideCount/playerInside/headcount track the arrivals and say whether the player is counted", () => {
    // Across seeds, so BOTH states (player not yet in, player in) are seen and asserted for sure.
    const sawPlayerOutside = { v: false }, sawPlayerInside = { v: false };
    for (const seed of [11, 5, 3, 8]) {
      const sb = start(seed);
      const s = sb.session;
      for (let i = 0; i < 40; i++) {
        const e = s.premiereIntros()!.entrance!;
        const pe = s.snapshot().live!.premiereEntrance!;
        expect(e.insideCount).toBe(pe.arrived);
        expect(e.playerInside).toBe(pe.arrived > pe.playerPos);
        expect(e.headcount.startsWith(`${pe.arrived} of ${e.total} are inside`)).toBe(true);
        expect(e.headcount).toContain(e.playerInside ? "the player is one of them" : "the player has NOT walked in yet");
        (e.playerInside ? sawPlayerInside : sawPlayerOutside).v = true;
        if (e.stage === "done") break;
        s.advanceGame();
      }
    }
    expect(sawPlayerOutside.v && sawPlayerInside.v).toBe(true);
  });
  it("the final headcount is all of them with the player inside", () => {
    const sb = start(5);
    runToDone(sb);
    const e = sb.session.premiereIntros()!.entrance!;
    expect(e.insideCount).toBe(e.total);
    expect(e.headcount).toBe(`${e.total} of ${e.total} are inside (the player is one of them)`);
  });
});

