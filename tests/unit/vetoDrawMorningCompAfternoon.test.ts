import { describe, it, expect, afterEach } from "vitest";
import { toDayTwoMorning } from "../support/dayTwoMorning";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-281 slice 1b (Ryne: "the veto draw should be morning. And the comp in the afternoon... they should have two starts and ends and not be tied. The only thing tying them is deciding who is
 * playing in the comp itself, and it taking place the same day"). End to end on a PLAYED game with the schedule gate ON: the draw ceremony runs in the morning slot; once the field is drawn
 * the competition is HELD (typed, nothing committed) until its own afternoon slot, with real in-game hours between them for campaigning; both happen on the same in-game day. Roles only.
 */
type Any = Record<string, any>;
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

function played(seed: number): GameSessionAdapter {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`vd-${seed}-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true);
  toDayTwoMorning(s);
  (s as unknown as Any).noteMessage({ messageId: "m1" }); // a PLAYED game (ceremonies stage)
  s.setAdvanceGateEnabled(true);
  return s;
}
const live = (s: GameSessionAdapter): Any => (s as unknown as Any).live;

describe("veto draw (morning) and competition (afternoon) are separate, untied, same-day", () => {
  it("draw in the morning slot, comp held until the afternoon slot, hours between, same day", () => {
    const s = played(7);
    const a = s as unknown as Any;
    let drawDone: { tod: string; clock: number; day: unknown } | undefined;
    let held: { next: string; minutesUntil: number } | undefined;
    let compStart: { tod: string; clock: number; day: unknown } | undefined;
    for (let i = 0; i < 3000 && !compStart; i++) {
      const v = s.advanceGame() as Any;
      const L = live(s);

      if (v.held) {
        if (drawDone && !held && v.held.next === "veto-competition") held = v.held; // the comp is held after the draw
        s.advanceClockPerConversation();
        continue;
      }
      const p = v.pending;
      if (L.vetoField && !drawDone && !L.ceremony) drawDone = { tod: L.timeOfDay, clock: L.nightDepth, day: L.day };
      if (p?.kind === "ceremony-step") continue;
      if (p?.kind === "comp-intent" || p?.kind === "comp-round") {
        if (L.vetoField && drawDone) { compStart = { tod: L.timeOfDay, clock: L.nightDepth, day: L.day }; break; }
        s.submitDecision({ kind: p.kind, intent: "compete" } as never);
      } else if (p?.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] } as never);
      else if (p?.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", choice: p.options[0] } as never);
    }
    void a;
    expect(drawDone, "the draw completed").toBeDefined();
    expect(drawDone!.tod).toBe("morning");
    expect(held, "after the draw the competition is HELD until its own slot").toBeDefined();
    expect(held!.minutesUntil).toBeGreaterThan(0);
    expect(compStart, "the competition then starts").toBeDefined();
    expect(compStart!.tod).toBe("afternoon");
    expect(compStart!.clock - drawDone!.clock, "real in-game hours between the two").toBeGreaterThan(0);
    expect(compStart!.day).toBe(drawDone!.day);
  });
});
