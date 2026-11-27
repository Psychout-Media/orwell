import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { BedsState } from "../../src/engine/beds";

/**
 * ORW-1090 (Ryne 2026-11-26, "fair game; the sleeper may react when they wake, annoyed or fine depending on how they feel about the joiner"; the same for houseguests joining a sleeping player or houseguest): the
 * reaction is read from the sleeper's warmth toward the joiner (the swap bar), once per join, on the first tick of a later day; when the player is one of the two it is handed to the narrator for one turn.
 * Unit level over the real adapter's own method and its own relationship model (the warmth reader is the one seam stubbed). Roles only.
 */
type Priv = { createCharacter(r: unknown): unknown; livingIds(): string[]; reactToHalfJoins(b: BedsState, day: number, living: ReadonlySet<string>): void; bedWakeNote: { sleeper: string; joiner: string; mood: string } | null; bedReader: () => unknown; rel: { applyImpactDirected: (...a: unknown[]) => void } };
function setup(warm: number) {
  const s = new GameSessionRegistry().sandboxFor(`orw1090-${Math.random()}`).session as unknown as Priv;
  s.createCharacter({ playerName: "P", seed: 7 });
  const ids = s.livingIds().filter((i: string) => i !== "player");
  const [a, b] = ids as [string, string];
  const beds: BedsState = { owner: {}, claims: [] };
  const living = new Set<string>(["player", a, b]);
  const folds: unknown[][] = []; const orig = s.rel.applyImpactDirected.bind(s.rel);
  s.rel.applyImpactDirected = (...x: unknown[]) => { folds.push(x); orig(...x); };
  const real = s.bedReader; s.bedReader = () => ({ ...(real.call(s) as object), warmth: () => warm });
  return { s, a, b, beds, living, folds };
}
const join = (beds: BedsState, sleeper: string, joiner: string, day: number) => {
  beds.owner[sleeper] = "bedroom-a#d1:1"; beds.owner[joiner] = "bedroom-a#d1:2";
  beds.claims.push({ who: sleeper, bed: "bedroom-a#d1:1", day: 1, why: "move-in" }, { who: joiner, bed: "bedroom-a#d1:2", day, why: "move" });
};

describe("ORW-1090: the sleeper's reaction when they wake beside a joiner", () => {
  it("a houseguest who does not like the player is annoyed; the narrator is told for one turn; nothing folds (narration only)", () => {
    const { s, a, beds, living, folds } = setup(-0.5);
    join(beds, a, "player", 1);
    s.reactToHalfJoins(beds, 2, living);
    expect(s.bedWakeNote).toMatchObject({ mood: "annoyed" });
    expect(folds.length, "narration only: no relationship fold").toBe(0);
    s.reactToHalfJoins(beds, 3, living);
    expect(s.bedWakeNote, "told once: the join already reacted").toBeNull();
    expect(beds.wokeBeside?.length).toBe(1);
  });
  it("a houseguest who likes the joiner is fine: told", () => {
    const { s, a, beds, living, folds } = setup(0.6);
    join(beds, a, "player", 1);
    s.reactToHalfJoins(beds, 2, living);
    expect(s.bedWakeNote).toMatchObject({ mood: "fine" });
    expect(folds.length).toBe(0);
  });
  it("the same day as the join there is no reaction yet (they have not slept on it)", () => {
    const { s, a, beds, living } = setup(-0.5);
    join(beds, a, "player", 2);
    s.reactToHalfJoins(beds, 2, living);
    expect(s.bedWakeNote).toBeNull();
    expect(beds.wokeBeside).toBeUndefined();
  });
  it("parity: a houseguest joining a sleeping PLAYER is told to the narrator", () => {
    const { s, a, beds, living, folds } = setup(-0.5);
    join(beds, "player", a, 1);
    s.reactToHalfJoins(beds, 2, living);
    expect(s.bedWakeNote).toMatchObject({ mood: "annoyed" });
    expect(folds.length).toBe(0);
  });
  it("two houseguests: nothing is told to the narrator and nothing folds", () => {
    const { s, a, b, beds, living, folds } = setup(-0.5);
    join(beds, a, b, 1);
    s.reactToHalfJoins(beds, 2, living);
    expect(s.bedWakeNote).toBeNull();
    expect(folds.length).toBe(0);
    expect(beds.wokeBeside?.length, "the join is still recorded as reacted").toBe(1);
  });
});
