import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * 0016 (2026-10-25 audit, band A finding 3) — God-Mode `configure` / `overrideMechanic` used to write ONLY the admin's own projection,
 * which the live game never reads: the admin saw success for a no-op. They now reach the LIVE session for the count knobs the engine
 * honors (reserve-twist COUNT, tie / showmance budgets) and every response says which were `knobsApplied` / `knobsNotApplied`.
 * Roles only. Counts only — never twist/tie CONTENT.
 */
const reserveCount = (s: SessionSnapshot): number => s.live?.reserve?.length ?? 0;
const tieCount = (s: SessionSnapshot): number => s.seededRelationships?.ties.length ?? 0;
const showmanceCount = (s: SessionSnapshot): number => s.seededRelationships?.showmances.length ?? 0;

function dealt(user: string, seed: number, knobs?: Record<string, unknown>): { reserve: number; ties: number; showmances: number; view?: Record<string, unknown> } {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  const view = knobs ? (sb.admin.configure(knobs) as Record<string, unknown>) : undefined;
  sb.session.createCharacter({ playerName: "The Player", seed });
  const snap = sb.session.snapshot() as SessionSnapshot;
  return { reserve: reserveCount(snap), ties: tieCount(snap), showmances: showmanceCount(snap), view };
}

describe("0016 — God-Mode count knobs reach the live game", () => {
  it("configure({reserveTwists}) changes how many reserve twists the NEXT season is dealt (default > 0, set to 0 => none)", () => {
    expect(dealt("a", 3).reserve, "the default deals some reserve twists").toBeGreaterThan(0);
    const off = dealt("b", 3, { reserveTwists: 0 });
    expect(off.reserve).toBe(0);
    expect(off.view!.knobsApplied).toEqual(["reserveTwists"]);
    expect(off.view!.knobsNotApplied).toEqual([]);
  });

  it("configure({tieBudget: 0}) deals no pre-game ties where the default budget does", () => {
    let seed = 0;
    for (let s = 1; s <= 60 && !seed; s++) if (dealt(`t${s}`, s).ties > 0) seed = s;
    expect(seed, "some seed deals a tie at the default budget").toBeGreaterThan(0);
    const none = dealt("tie-off", seed, { tieBudget: 0 });
    expect(none.ties).toBe(0);
    expect(none.view!.knobsApplied).toEqual(["tieBudget"]);
  });

  it("overrideMechanic routes a count knob to the live game too, and reports phase/week/unknown knobs as NOT applied", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("o");
    const v1 = sb.admin.overrideMechanic({ mechanic: "reserveTwists", value: 0 }) as Record<string, unknown>;
    expect(v1.knobsApplied).toEqual(["reserveTwists"]);
    for (const mechanic of ["phase", "week", "temperature"]) {
      const v = sb.admin.overrideMechanic({ mechanic, value: mechanic === "phase" ? "eviction" : 3 }) as Record<string, unknown>;
      expect(v.knobsApplied, mechanic).toEqual([]);
      expect(v.knobsNotApplied, mechanic).toEqual([mechanic]);
    }
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    expect(reserveCount(sb.session.snapshot() as SessionSnapshot), "the earlier reserveTwists override stuck").toBe(0);
  });

  it("invalid / out-of-range values are not applied and the game keeps its defaults", () => {
    for (const bad of [-1, 99, Number.NaN, "2", null]) {
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor("bad");
      const v = sb.admin.configure({ reserveTwists: bad }) as Record<string, unknown>;
      expect(v.knobsApplied, String(bad)).toEqual([]);
      expect(v.knobsNotApplied, String(bad)).toEqual(["reserveTwists"]);
      sb.session.createCharacter({ playerName: "The Player", seed: 3 });
      expect(reserveCount(sb.session.snapshot() as SessionSnapshot), String(bad)).toBeGreaterThan(0);
    }
  });

  it("is per user: one user's knobs never change another user's game (cross-user isolation)", () => {
    const reg = new GameSessionRegistry();
    reg.sandboxFor("alice").admin.configure({ reserveTwists: 0 });
    const bob = reg.sandboxFor("bob");
    bob.session.createCharacter({ playerName: "The Player", seed: 3 });
    expect(reserveCount(bob.session.snapshot() as SessionSnapshot)).toBeGreaterThan(0);
  });

  it("the Vault wall holds: the response carries counts and names only, no twist/tie content", () => {
    const { view } = dealt("v", 3, { reserveTwists: 1, tieBudget: 1 });
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/fireAtBeat|nature|backstory|kind":"/i);
  });

  it("configure({showmanceBudget: 0}) deals no showmance seeds where the default budget does", () => {
    let seed = 0;
    for (let s = 1; s <= 80 && !seed; s++) if (dealt(`s${s}`, s).showmances > 0) seed = s;
    expect(seed, "some seed deals a showmance at the default budget").toBeGreaterThan(0);
    const none = dealt("showmance-off", seed, { showmanceBudget: 0 });
    expect(none.showmances).toBe(0);
    expect(none.view!.knobsApplied).toEqual(["showmanceBudget"]);
    expect(none.view!.knobsNotApplied).toEqual([]);
  });

  it("reserveTwists is capped at the pool size (an out-of-effect 4/5 is NOT reported applied)", () => {
    for (const n of [4, 5]) {
      const v = new GameSessionRegistry().sandboxFor(`cap${n}`).admin.configure({ reserveTwists: n }) as Record<string, unknown>;
      expect(v.knobsApplied, String(n)).toEqual([]);
      expect(v.knobsNotApplied, String(n)).toEqual(["reserveTwists"]);
    }
    const ok = new GameSessionRegistry().sandboxFor("cap3").admin.configure({ reserveTwists: 3 }) as Record<string, unknown>;
    expect(ok.knobsApplied).toEqual(["reserveTwists"]);
  });

  it("reactive twist mode ignores a twist count, so the knob is reported NOT applied there", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("reactive");
    sb.session.setReactiveTwistsEnabled(true);
    const v = sb.admin.configure({ reserveTwists: 1 }) as Record<string, unknown>;
    expect(v.knobsApplied).toEqual([]);
    expect(v.knobsNotApplied).toEqual(["reserveTwists"]);
  });

  it("the inspectable config (including unsupported/invalid knobs) survives a sandbox rebuild; only honored knobs reach the live session", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("rebuild");
    sb.admin.configure({ temperature: 0.4, reserveTwists: 0, tieBudget: 99 });
    // simulate an LRU eviction + resume: the registry drops the in-memory sandbox and rebuilds it for the same user
    (reg as unknown as { sandboxes: Map<string, unknown> }).sandboxes.delete("rebuild");
    const again = reg.sandboxFor("rebuild");
    const view = again.admin.inspect() as Record<string, unknown>;
    const cfg = view.config as Record<string, unknown>;
    expect(cfg.temperature, "unsupported knob stays inspectable").toBe(0.4);
    expect(cfg.tieBudget, "an invalid value stays inspectable (but was never applied)").toBe(99);
    again.session.createCharacter({ playerName: "The Player", seed: 3 });
    expect(reserveCount(again.session.snapshot() as SessionSnapshot), "the honored knob was re-applied to the rebuilt session").toBe(0);
  });
});
