import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { parsePlayerPersonIntent, parsePlayerMoveIntent } from "../../src/engine/playerMoveIntent";

/** ORW-559: "I go to <houseguest>" walks the player to the room that houseguest is in, when the player can see them; never otherwise. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

type Priv = { presence: Map<string, string>; house: { player: { id: string } }; nameOf(id: string): string; livingIds(): string[] };

function start() {
  const rt = composeRuntime({ saveStore: new FileSaveStore(mkdtempSync(join(tmpdir(), "orw559-"))), clock: new FakeClock() });
  const s = rt.registry.sandboxFor("pm559").session;
  s.createCharacter({ playerName: "P", seed: 7 });
  (s as unknown as { live: { champagneCircle?: unknown } }).live.champagneCircle = undefined;
  const p = s as unknown as Priv;
  const others = p.livingIds().filter((id) => id !== p.house.player.id);
  // the turn's off-screen tick re-seats everyone on each noted message, so placements are applied AFTER noteMessage (in `say`)
  const plan: Array<[string, string]> = [];
  const put = (i: number, room: string) => { plan.push([others[i]!, room]); return p.nameOf(others[i]!).split(" ")[0]!; };
  s.movePlayer("living-room");
  planOf.set(s, { p, plan, others });
  return { s, p, put, others };
}
let n = 0;
const planOf = new WeakMap<object, { p: Priv; plan: Array<[string, string]>; others: string[] }>();
const say = (s: ReturnType<typeof start>["s"], text: string) => {
  s.noteMessage({ messageId: `m${++n}` });
  const { p, plan, others } = planOf.get(s)!;
  others.forEach((id) => p.presence.set(id, "bedroom-c")); // everyone else far away behind a closed door, so only the placed one is sighted
  plan.forEach(([id, room]) => p.presence.set(id, room));
  return s.resolvePlayerMove({ text });
};

describe("go to a houseguest by name", () => {
  it("a sighted houseguest in a neighbouring open room: the player walks to that room", () => {
    const { s, put } = start();
    const first = put(0, "kitchen");
    const r = say(s, `I go to ${first}`);
    expect(r.playerMove).toMatchObject({ from: "living-room", to: "kitchen" });
    expect(s.whereabouts()!.room).toBe("kitchen");
  });
  it.each(["walk to", "head to", "find", "look for", "seek out", "go find"])("%s <name> resolves the same", (v) => {
    const { s, put } = start();
    const first = put(0, "kitchen");
    expect(say(s, `I ${v} ${first}`).playerMove).toMatchObject({ to: "kitchen" });
  });
  it("a houseguest the player cannot see (closed bedroom): no move, nothing revealed", () => {
    const { s, put } = start();
    const first = put(0, "bedroom-a");
    const r = say(s, `I go to ${first}`);
    expect(r.playerMove).toBeNull();
    expect(s.whereabouts()!.room).toBe("living-room");
    const w = r.whereabouts!; // the public room-name map lists every room; the person must appear in no list
    expect(JSON.stringify([w.present, w.nearby, w.tracked])).not.toContain("bedroom-a");
    // ORW-711: the living room is the hub with the bathroom, the lounge and the stairs off it, so the player may genuinely have SEEN this houseguest walk into one of those
    // closed rooms on an earlier tick (a tracked belief the player earned by watching). What must never show is the bedroom they are in now, or them in view.
    expect(JSON.stringify([w.present, w.nearby])).not.toContain(first);
    expect(w.tracked.every((t) => t.room !== "bedroom-a")).toBe(true);
  });
  it("a houseguest already in the player's room: no move", () => {
    const { s, put } = start();
    const first = put(0, "living-room");
    expect(say(s, `I go to ${first}`).playerMove).toBeNull();
  });
  it("unknown name, the player's own name, and a future/hedged phrasing move nothing", () => {
    const { s, put } = start();
    put(0, "kitchen");
    expect(say(s, "I go to Zzyzx").playerMove).toBeNull();
    expect(say(s, "I go to P").playerMove).toBeNull();
    expect(s.whereabouts()!.room).toBe("living-room");
  });
  it("a room still resolves as a room", () => {
    const { s, put } = start();
    put(0, "backyard");
    expect(say(s, "I go to the kitchen").playerMove).toMatchObject({ to: "kitchen" });
  });
});

describe("the person parser", () => {
  it("extracts a name phrase, ignores rooms, hedges and quotes", () => {
    expect(parsePlayerPersonIntent("I go to Robin", "kitchen")).toBe("robin");
    expect(parsePlayerPersonIntent("I go to the kitchen", "backyard")).toBeNull();
    expect(parsePlayerPersonIntent("maybe I should go to Robin", "kitchen")).toBeNull();
    expect(parsePlayerPersonIntent('I say "go to Robin"', "kitchen")).toBeNull();
    expect(parsePlayerMoveIntent("I go to Robin", "kitchen")).toBeNull();
  });
});
