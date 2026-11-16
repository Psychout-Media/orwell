import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-478 (review of #2825): through the REAL runtime (registry, orchestrator, save store) a valid move is handed to the narrator's state on the message it was made for, and only then. The orchestrator's off-screen tick that
 * follows the move's commit used to bump the player's tenure, so a tenure check could never mark "just arrived"; the move is stamped with its message instead. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function start() {
  const dir = mkdtempSync(join(tmpdir(), "orw478-"));
  const rt = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
  const s = rt.registry.sandboxFor("pm478").session;
  s.createCharacter({ playerName: "P", seed: 7 });
  (s as unknown as { live: { champagneCircle?: unknown } }).live.champagneCircle = undefined; // the premiere's gathered toast is a house event; a real game is past it (as in the 0049 move scenarios)
  s.movePlayer("backyard");
  return { rt, s, dir };
}

describe("the player's move belongs to the message it was made on", () => {
  it("a valid move backyard -> kitchen is in the state the front end reads after the commit and the tick, and after another commit", () => {
    const { s } = start();
    s.noteMessage({ messageId: "m1" });
    const r = s.resolvePlayerMove({ text: "I go to the kitchen" });
    expect(r.playerMove).toMatchObject({ from: "backyard", to: "kitchen" });
    expect(s.getGameState().playerMove).toMatchObject({ from: "backyard", to: "kitchen" });
    expect(s.whereabouts()!.room).toBe("kitchen");
    s.noteMessage({ messageId: "m1" }); // a replay of the same message changes nothing
    expect(s.getGameState().playerMove).toMatchObject({ to: "kitchen" });
  });

  it("the next message whose resolvePlayerMove call never happened (it is fail-soft) is not handed last turn's move", () => {
    const { s } = start();
    s.noteMessage({ messageId: "m1" });
    s.resolvePlayerMove({ text: "I go to the kitchen" });
    s.noteMessage({ messageId: "m2" }); // the front end noted the new message; its resolve call failed
    expect(s.getGameState().playerMove, "last turn's move is over").toBeUndefined();
    expect(s.whereabouts()!.room).toBe("kitchen");
  });

  it("a restart restore keeps the move for the same message, and drops it once a later message arrives", () => {
    const { rt, s, dir } = start();
    s.noteMessage({ messageId: "m1" });
    s.resolvePlayerMove({ text: "I go to the kitchen" });
    const rt2 = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
    const s2 = rt2.registry.sandboxFor("pm478").session;
    expect(s2.getGameState().playerMove).toMatchObject({ to: "kitchen" });
    s2.noteMessage({ messageId: "m2" });
    expect(s2.getGameState().playerMove).toBeUndefined();
    void rt;
  });

  it("a harness call with no message noted still carries its move (no message to belong to)", () => {
    const { s } = start();
    s.resolvePlayerMove({ text: "I go to the kitchen" });
    expect(s.getGameState().playerMove).toMatchObject({ to: "kitchen" });
  });
});
