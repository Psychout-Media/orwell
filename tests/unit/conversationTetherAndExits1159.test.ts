import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { renderGameContext } from "../../src/engine/momentPrompts";

/**
 * ORW-1159 / ORW-1160 (Ryne 2026-11-28): "Valerie asked a question, and within the next message she walked out to a different room and wasn't there to hear the answer", and "there was no transition out".
 * Rule 1: a houseguest in a live talk with the player is not walked out of the player's room by the engine's own movement; the hold lapses by itself.
 * Rule 2: every departure from the player's room since the last reply reaches the narrator as engine truth (who, where to, the engine's reason when it has one).
 * Both run through the session (GameSessionRegistry sandbox) with APIs main already has. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Internals = { presence: Map<string, string>; presenceBase: Map<string, string> | null; presenceTick(rng: SeededRandom): void; live: { approachAsked?: Record<string, unknown> }; absHour(): number };
function setup(seed = 11) {
  GameSessionAdapter.setTimeOfDayEnabled(false); // the clock is not the subject here: the hold is bounded by replies
  const sb = new GameSessionRegistry().sandboxFor(`tether-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.advanceGame(); // leave the premiere champagne circle
  sb.session.noteMessage({ messageId: "m1" }); // a person is playing from here
  const s = sb.session as unknown as Internals;
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
  s.presence.set(PLAYER, "living-room"); s.presenceBase?.set(PLAYER, "living-room");
  return { sb, s, npcs };
}
/** Tick the house `n` times with the player held in the living room; true while `who` never leaves it. */
function staysThrough(s: Internals, who: string, n: number, seed: number): boolean {
  const rng = new SeededRandom(seed * 7919);
  for (let t = 0; t < n; t++) {
    s.presence.set(PLAYER, "living-room"); s.presenceBase?.set(PLAYER, "living-room");
    s.presenceTick(rng);
    if (s.presence.get(who) !== "living-room") return false;
  }
  return true;
}
const SEEDS = [1, 2, 3, 4, 5, 6];

describe("ORW-1159: the conversation tether", () => {
  it("a houseguest the narrator walked into the room stays through the engine's own movement (every seed, 40 ticks)", () => {
    for (const seed of SEEDS) {
      const { sb, s, npcs } = setup(seed);
      const a = npcs[0]!;
      s.presence.set(a, "kitchen"); s.presenceBase?.set(a, "kitchen");
      expect(sb.session.recordHouseguestMove(a, "living-room").status).toBe("moved"); // the narrated entrance
      expect(staysThrough(s, a, 40, seed), `seed ${seed}`).toBe(true);
    }
  });
  it("a houseguest named in a scene fold still staged from the last reply stays through the tick the next message steps", () => {
    for (const seed of SEEDS) {
      const { sb, s, npcs } = setup(seed);
      const a = npcs[1]!;
      s.presence.set(a, "living-room"); s.presenceBase?.set(a, "living-room"); // in the room, never narrated in by a move
      sb.session.noteMessage({ messageId: "m2", withIds: [a] } as { messageId: string });
      expect(staysThrough(s, a, 40, seed), `seed ${seed}`).toBe(true);
    }
  });
  it("a houseguest who asked the player something and was not answered stays", () => {
    for (const seed of SEEDS) {
      const { s, npcs } = setup(seed);
      const a = npcs[2]!;
      s.presence.set(a, "living-room"); s.presenceBase?.set(a, "living-room");
      s.live.approachAsked = { [a]: { q: "a question", week: 1, n: 0, shownAt: s.absHour() } };
      expect(staysThrough(s, a, 40, seed), `seed ${seed}`).toBe(true);
    }
  });
  it("the tether expires by itself: after the talk lulls (past the last two replies) the houseguest is free to go", () => {
    let leftSomewhere = 0;
    for (const seed of SEEDS) {
      const { sb, s, npcs } = setup(seed);
      const a = npcs[0]!;
      s.presence.set(a, "kitchen"); s.presenceBase?.set(a, "kitchen");
      sb.session.recordHouseguestMove(a, "living-room");
      for (const id of ["m2", "m3", "m4"]) sb.session.noteMessage({ messageId: id }); // three more replies with no talk to them
      if (!staysThrough(s, a, 60, seed)) leftSomewhere++;
    }
    expect(leftSomewhere).toBeGreaterThan(0);
  });
  it("a narrated exit is the reply voicing their own leaving: it is not blocked, and it ends the hold", () => {
    const { sb, s, npcs } = setup();
    const a = npcs[0]!;
    s.presence.set(a, "kitchen");
    sb.session.recordHouseguestMove(a, "living-room");
    expect(sb.session.recordHouseguestMove(a, "kitchen").status).toBe("moved");
    expect(s.presence.get(a)).toBe("kitchen");
  });
});

describe("ORW-1160: exits are handed to the narrator", () => {
  it("whereabouts().sinceSend.left names who left, where to (next door) and no ids in prose", () => {
    const { sb, s, npcs } = setup();
    const a = npcs[0]!;
    s.presence.set(a, "living-room");
    sb.session.noteMessage({ messageId: "m2" }); // the roster is frozen with them in the room
    s.presence.set(a, "kitchen"); // the engine's tick walks them out
    const since = sb.session.whereabouts()!.sinceSend!;
    const left = (since as { left?: Array<{ id: string; name: string; to?: string; toName?: string }> }).left;
    expect(left).toBeDefined();
    expect(left!.length).toBe(1);
    expect(left![0]!.to).toBe("kitchen");
    expect(left![0]!.toName).toMatch(/kitchen/i);
    expect(left![0]!.name).not.toMatch(/\d/);
  });
  it("the moment prompt carries a JUST LEFT line with the name and the room, like an arrival", () => {
    const { sb, s, npcs } = setup();
    const a = npcs[0]!;
    s.presence.set(a, "living-room");
    sb.session.noteMessage({ messageId: "m2" });
    s.presence.set(a, "kitchen");
    const name = sb.session.whereabouts()!.sinceSend!.departed[0]!;
    const ctx = renderGameContext(sb.session.getGameState());
    const toName = (sb.session.whereabouts()!.sinceSend as { left?: Array<{ toName?: string }> }).left![0]!.toName!; // the season's own name for the room
    expect(ctx).toContain(`JUST LEFT: ${name}, to ${toName}`);
  });
  it("a departure to a room the player cannot watch them step into names no room", () => {
    const { sb, s, npcs } = setup();
    const a = npcs[0]!;
    s.presence.set(a, "living-room");
    sb.session.noteMessage({ messageId: "m2" });
    s.presence.set(a, "bedroom-a");
    const left = (sb.session.whereabouts()!.sinceSend as { left?: Array<{ to?: string }> }).left;
    expect(left?.[0]).toBeDefined();
    expect(left![0]!.to).toBeUndefined();
  });
  it("nothing is handed over when nobody left", () => {
    const { sb, s, npcs } = setup();
    s.presence.set(npcs[0]!, "living-room");
    sb.session.noteMessage({ messageId: "m2" });
    expect((sb.session.whereabouts()?.sinceSend as { left?: unknown[] } | undefined)?.left).toBeUndefined();
    expect(renderGameContext(sb.session.getGameState())).not.toContain("JUST LEFT");
  });
});
