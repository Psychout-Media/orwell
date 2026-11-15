import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { linger } from "../support/linger";

/** ORW-462 (Kevin 15:58 MST): the player's last-known whereabouts of each houseguest is a record the game keeps from what the player could see, persists, and the house search reads. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Snap = { lastSeenAt?: Record<string, { room: string; tick: number; day: number; part: string }> };

function played(user: string, seed = 6): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(user).session;
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" }); // a person is playing
  return s;
}

describe("the player's last-known whereabouts", () => {
  it("a played game records who the player saw (room, day, part) and the record survives a save and restore", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = played("kw462a");
    s.setPerConversationClockEnabled(true);
    for (let i = 0; i < 12; i++) { s.noteMessage({ messageId: `m-${i}` }); if (i % 3 === 0) linger(s); }
    const snap = s.snapshot() as unknown as Snap;
    const rec = snap.lastSeenAt;
    expect(rec, "the player saw someone").toBeDefined();
    expect(Object.keys(rec!).length).toBeGreaterThan(0);
    for (const v of Object.values(rec!)) { expect(typeof v.room).toBe("string"); expect(Number.isFinite(v.tick)).toBe(true); expect(v.day).toBeGreaterThanOrEqual(1); }
    const again = new GameSessionAdapter();
    again.restore(JSON.parse(JSON.stringify(s.snapshot())));
    expect((again.snapshot() as unknown as Snap).lastSeenAt).toEqual(rec);
  });

  it("an older save without the record loads with an empty one, and a headless game never writes it", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = played("kw462b");
    const raw = JSON.parse(JSON.stringify(s.snapshot())) as Snap & Record<string, unknown>;
    delete raw.lastSeenAt;
    const old = new GameSessionAdapter();
    old.restore(raw as never);
    expect((old.snapshot() as unknown as Snap).lastSeenAt).toBeUndefined();
    const headless = new GameSessionRegistry().sandboxFor("kw462c").session;
    headless.createCharacter({ playerName: "P", seed: 6 });
    headless.advanceGame();
    expect((headless.snapshot() as unknown as Snap).lastSeenAt, "headless saves stay byte-identical").toBeUndefined();
  });
});
