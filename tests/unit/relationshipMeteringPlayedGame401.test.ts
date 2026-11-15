import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-401 end to end (the card's done-means), through a REAL played game: the window is the in-game day + part of day (`foldWindowKey`),
 * so scenes in different parts of the day each restart at full effect, scenes in the same part shrink 1, 1/2, 1/4, and a save/restore
 * mid-window keeps the meter. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Live = { timeOfDay?: string; dayNumber?: number };

function played(user: string, dir: string) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry(new FileSaveStore(dir));
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "P", seed: 12 });
  sb.session.setPerConversationClockEnabled(true);
  sb.session.noteMessage({ messageId: "m1" }); // a person is playing: message mode + playedGame
  return { reg, sb };
}
const live = (s: GameSessionAdapter): Live => (s as unknown as { live: Live }).live;
const guest = (s: GameSessionAdapter) => s.getGameState().house.find((h) => h.id !== s.getGameState().player?.id && h.status === "active")!.id;

describe("ORW-401 metering through a played game", () => {
  it("six scenes across parts of the day each restart at full effect; three in the same part give 1 + 1/2 + 1/4", () => {
    const { sb } = played("m401a", mkdtempSync(join(tmpdir(), "orw401-")));
    const s = sb.session;
    const g = guest(s);
    const edge = () => sb.engine.relationships.read(g, PLAYER).signals.affinity;
    const scene = (): number => {
      const before = edge();
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, g], content: "a friendly chat", kind: "bonding" });
      return edge() - before;
    };
    const parts = ["morning", "afternoon", "evening", "night"];
    live(s).timeOfDay = "morning";
    expect(s.foldWindowKey(), "the played game has a window key").toMatch(/^d\d+:morning$/);

    // three scenes in ONE part of the day: 1, 1/2, 1/4 of the first
    const count = (): number => Object.values(sb.commands.foldMeterState()?.counts ?? {}).reduce((a, b) => Math.max(a, b), 0);
    const first = scene(); expect(count()).toBe(1);
    const second = scene(); expect(count()).toBe(2);
    const third = scene(); expect(count()).toBe(3);
    // the meter scales the nth fold by 1/2^(n-1) (the raw draw and the edge's own diminishing returns add a little spread, hence the bands)
    expect(first).toBeGreaterThan(0);
    expect(second / first).toBeGreaterThan(0.3); expect(second / first).toBeLessThan(0.7);
    expect(third / first).toBeGreaterThan(0.12); expect(third / first).toBeLessThan(0.4);
    expect(third).toBeLessThan(second);

    // six scenes across parts of the day: the first scene of each new part moves it as much as a fresh first scene
    const firsts: number[] = [first];
    const newPart = (): void => { firsts.push(scene()); expect(count(), "a new part of the day opens a fresh window: the meter is back at its first scene").toBe(1); };
    for (const part of parts.slice(1)) { live(s).timeOfDay = part; newPart(); }
    live(s).dayNumber = (live(s).dayNumber ?? 1) + 1; live(s).timeOfDay = "morning"; newPart();
    live(s).timeOfDay = "afternoon"; newPart();
    expect(firsts).toHaveLength(6);
    for (const f of firsts.slice(1)) expect(f, "a fresh window's first scene moves the edge more than the shrunk third scene did").toBeGreaterThan(third);
    const totalSteps = firsts.filter((f) => f > 0).length;
    expect(totalSteps, "the edge moved more than 3 times across the parts of the day").toBeGreaterThan(3);
  });

  it("save and restore mid-window keeps the meter: the next scene in the same part is still shrunk", () => {
    const dir = mkdtempSync(join(tmpdir(), "orw401-"));
    const a = played("m401b", dir);
    const sa = a.sb.session;
    const g = guest(sa);
    live(sa).timeOfDay = "evening";
    const scene = (sb: typeof a.sb): number => {
      const e = () => sb.engine.relationships.read(g, PLAYER).signals.affinity;
      const before = e();
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, g], content: "a friendly chat", kind: "bonding" });
      return e() - before;
    };
    const first = scene(a.sb);
    scene(a.sb); scene(a.sb); // third scene saves the window's count
    expect(Math.max(0, ...Object.values(a.sb.commands.foldMeterState()?.counts ?? {}))).toBe(3);

    // a restart: a NEW registry over the same save directory resumes the game from disk
    const reg2 = new GameSessionRegistry(new FileSaveStore(dir));
    const sb2 = reg2.sandboxFor("m401b");
    expect(live(sb2.session).timeOfDay).toBe("evening");
    expect(sb2.session.foldWindowKey()).toBe(sa.foldWindowKey());
    const after = scene(sb2);
    expect(after, "a restart does not refill the budget").toBeLessThan(first * 0.3);
  });
});
