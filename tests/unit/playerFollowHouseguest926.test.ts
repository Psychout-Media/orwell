import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";


/** ORW-926: "I follow <houseguest> ..." is the same walk to the room that houseguest is in, when the player can see them (Fable's week-2 run: "I follow a friend inside to wherever they went" moved the player nowhere, then the narrator placed them in a room the engine did not). Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

type Priv = { presence: Map<string, string>; house: { player: { id: string } }; nameOf(id: string): string; livingIds(): string[] };

function start() {
  const rt = composeRuntime({ saveStore: new FileSaveStore(mkdtempSync(join(tmpdir(), "orw926-"))), clock: new FakeClock() });
  const s = rt.registry.sandboxFor("pm926").session;
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

describe("ORW-926 follow a houseguest by name", () => {
  it.each(["follow", "trail"])("%s <name> walks to the room a sighted houseguest is in", (v) => {
    const { s, put } = start();
    const first = put(0, "kitchen");
    expect(say(s, `I ${v} ${first}`).playerMove).toMatchObject({ from: "living-room", to: "kitchen" });
    expect(s.whereabouts()!.room).toBe("kitchen");
  });
  it("'follow <name> inside to wherever they went and close the door' (speech after it) still follows", () => {
    const { s, put } = start();
    const first = put(0, "kitchen");
    expect(say(s, `I follow ${first} inside to wherever they went and close the door. "A word, just us?"`).playerMove).toMatchObject({ to: "kitchen" });
  });
  it("a houseguest the player cannot see (closed bedroom): no move, nothing revealed", () => {
    const { s, put } = start();
    const first = put(0, "bedroom-a");
    const r = say(s, `I follow ${first}`);
    expect(r.playerMove).toBeNull();
    expect(JSON.stringify([r.whereabouts!.present, r.whereabouts!.nearby])).not.toContain(first);
  });
  it("hedged or future phrasing, an unknown name and a non-person move nothing", () => {
    const { s, put } = start();
    const first = put(0, "kitchen");
    expect(say(s, `maybe I follow ${first}`).playerMove).toBeNull();
    expect(say(s, `I will follow ${first} later`).playerMove).toBeNull();
    expect(say(s, "I follow Zzyzx").playerMove).toBeNull();
    expect(say(s, "I follow the plan").playerMove).toBeNull();
    expect(s.whereabouts()!.room).toBe("living-room");
  });
});
