import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { retroArmedIntroductions, sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";
import { PLAYER } from "../../src/domain/ids";
import { resolvePending } from "../../features/support/answerPending";

/**
 * ORW-800 - a save already in the toast with no introduction record (what the code before ORW-690 wrote for a game with no house tour) loads AND arms meet-the-cast. The old-shape save is produced the way the old code
 * wrote it (a played game, no tour, the meet-the-cast flag off so nothing arms) and loaded through the registry's real resume path (`restore`, the one the engine restart and the rollback use). Roles only.
 */
type Pe = { stage: string; order: string[]; arrived: number; spoke: string[]; introduced?: string[] };
const peOf = (s: GameSessionAdapter) => (s as unknown as { live: { premiereEntrance?: Pe } }).live.premiereEntrance!;
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); return v; };

function oldSave(seed: number, toastBatches: number) {
  const reg = new GameSessionRegistry();
  const user = `old-save-${seed}-${toastBatches}`;
  const s = reg.sandboxFor(user).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true); s.setBedRushEnabled(true); s.setHouseTourEnabled(false); s.setMeetTheCastEnabled(false);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  for (let i = 0; i < 40 && peOf(s).stage === "entrances"; i++) step(s);
  for (let i = 0; i < toastBatches; i++) step(s); // some of the toast has already been spoken
  return { reg, user, s, snap: JSON.parse(JSON.stringify(reg.snapshot(user))) as ReturnType<GameSessionRegistry["snapshot"]> };
}

describe("an older save in the toast with no introduction record arms meet-the-cast on load", () => {
  it("loads, arms, introduces those who already spoke, and the rest are introduced as the circle runs", () => {
    for (const seed of [3, 7, 11]) {
      const old = oldSave(seed, 2);
      expect(peOf(old.s).stage).toBe("toast");
      expect(peOf(old.s).introduced, "the old code wrote no record").toBeUndefined();
      const spoken = peOf(old.s).spoke.filter((x) => x !== "host");
      expect(spoken.length).toBeGreaterThan(0);

      const reg = new GameSessionRegistry();
      const s = reg.restore(`resume-${seed}`, old.snap).session;
      const pe = peOf(s);
      expect(pe.stage).toBe("toast");
      expect(pe.introduced, "armed on load").toEqual(spoken);
      const met = (s as unknown as { premiereMet: Set<string> }).premiereMet;
      for (const id of spoken.filter((x) => x !== PLAYER)) expect(met.has(id), "met").toBe(true);

      for (let i = 0; i < 40 && peOf(s).stage === "toast"; i++) step(s);
      const intro = peOf(s).introduced!;
      expect(new Set(intro).size, "no one twice").toBe(intro.length);
      expect([...intro].sort()).toEqual([...pe.order].sort());

      // superset: the armed save never holds less than the old one
      expect(sessionCoreSupersetViolation(reg.snapshot(`resume-${seed}`), old.snap)).toBeNull();
    }
  });
  it("a save armed on load is not re-armed or double-introduced by a second load", () => {
    const old = oldSave(5, 1);
    const reg = new GameSessionRegistry();
    const once = JSON.parse(JSON.stringify(reg.restore("r1", old.snap) && reg.snapshot("r1")));
    const intro = (once as { live: { premiereEntrance: Pe } }).live.premiereEntrance.introduced;
    const twice = reg.restore("r2", once).session;
    expect(peOf(twice).introduced).toEqual(intro);
  });
  it("saves that need nothing are left alone: an armed record, a premiere not yet in the toast, a finished premiere, flag off", () => {
    expect(retroArmedIntroductions(undefined)).toBeUndefined();
    expect(retroArmedIntroductions({ stage: "entrances", spoke: [] })).toBeUndefined();
    expect(retroArmedIntroductions({ stage: "done", spoke: ["host"] })).toBeUndefined();
    expect(retroArmedIntroductions({ stage: "toast", spoke: ["a"], introduced: [] })).toBeUndefined();
    expect(retroArmedIntroductions({ stage: "toast", spoke: ["host", "a", "a", "b"] })).toEqual(["a", "b"]);
    const old = oldSave(7, 1);
    const reg = new GameSessionRegistry();
    // flag off at load: nothing arms (the same gate as arming in play)
    const sb = (reg as unknown as { sandboxFor(u: string): { session: GameSessionAdapter } }).sandboxFor("off");
    sb.session.setMeetTheCastEnabled(false);
    sb.session.restore(old.snap as never);
    sb.session.armRestoredMeetTheCast();
    expect(peOf(sb.session).introduced).toBeUndefined();
  });
});
