import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { roomsBetween } from "../../src/domain/house";

/** ORW-711 player parity: the player's move to a room that is not next door is ONE move, pathed through the rooms between for WITNESSING. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

type Priv = { presence: Map<string, string>; house: { player: { id: string } }; livingIds(): string[]; live: { champagneCircle?: unknown; playedGame?: boolean } };

function start() {
  const rt = composeRuntime({ saveStore: new FileSaveStore(mkdtempSync(join(tmpdir(), "orw711-"))), clock: new FakeClock() });
  const sb = rt.registry.sandboxFor("pw711");
  const s = sb.session;
  s.createCharacter({ playerName: "P", seed: 7 });
  const p = s as unknown as Priv;
  p.live.champagneCircle = undefined;
  p.live.playedGame = true; // the walk-through is a played-game rule (a headless game stays byte-identical)
  const others = p.livingIds().filter((id) => id !== p.house.player.id);
  others.forEach((id) => p.presence.set(id, "bedroom-c")); // everyone far away, behind a closed door
  return { s, p, others, events: () => sb.engine.events.queryAll() };
}
const passes = (evs: ReturnType<ReturnType<typeof start>["events"]>) => evs.filter((e) => e.content.startsWith("The player went through"));

describe("roomsBetween (the shared walking path)", () => {
  it("is empty for an adjacent pair and the landing for the HOH room from the living room", () => {
    expect(roomsBetween("living-room", "landing")).toEqual([]);
    expect(roomsBetween("landing", "hoh-room")).toEqual([]);
    expect(roomsBetween("living-room", "hoh-room")).toEqual(["landing"]);
    expect(roomsBetween("bedroom-a", "hoh-room")).toEqual(["hallway", "living-room", "landing"]);
  });
});

describe("the player's walk through the house is witnessed", () => {
  it("a houseguest on the landing sees the player go into the HOH room; the move is still one move", () => {
    const { s, p, others, events } = start();
    s.movePlayer("living-room");
    p.presence.set(others[0]!, "landing");
    const before = events().length;
    const w = s.movePlayer("hoh-room");
    expect(w!.room).toBe("hoh-room"); // ONE move, straight to the destination
    const seen = passes(events().slice(before));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.hidden).toBe(false);
    expect(seen[0]!.witnessSet).toEqual([p.house.player.id, others[0]!]);
  });
  it("nobody on the way: nothing is recorded, and the player still arrives", () => {
    const { s, events } = start();
    s.movePlayer("living-room");
    const before = events().length;
    expect(s.movePlayer("hoh-room")!.room).toBe("hoh-room");
    expect(passes(events().slice(before))).toHaveLength(0);
  });
  it("an adjacent move records nothing and is unchanged", () => {
    const { s, p, others, events } = start();
    s.movePlayer("living-room");
    p.presence.set(others[0]!, "landing");
    const before = events().length;
    expect(s.movePlayer("landing")!.room).toBe("landing");
    expect(passes(events().slice(before))).toHaveLength(0);
  });
});
