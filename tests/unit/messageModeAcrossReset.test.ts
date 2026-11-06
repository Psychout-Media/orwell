import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * Review lead 6 (Coordinator 2026-11-06): does `messageMode` (clock billing once per announced player message) survive a restart, and does a new-season reset return it to legacy billing -
 * never leaving a stale "message mode" on, nor dropping a live season back to per-commit billing after a restart? Contract: the mode is derived from the persisted seen-message-id ring
 * (non-empty => on). A reset clears the ring and the flag together; the ring only drops its oldest id past 256, so it never empties once a message was announced. Roles only.
 */
type Sess = { messageModeNow(): boolean; noteMessage(r: { messageId: string }): unknown; createCharacter(r: Record<string, unknown>): unknown; advanceGame(): unknown };
const dir = (): string => mkdtempSync(join(tmpdir(), "orwell-mm-"));
const start = (reg: GameSessionRegistry): Sess => {
  const s = reg.sandboxFor("u").session as unknown as Sess;
  s.createCharacter({ playerName: "P", seed: 5 });
  s.advanceGame(); s.advanceGame();
  return s;
};
const reload = (d: string): Sess => new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Sess;

describe("messageMode across a restart and a new-season reset", () => {
  it("a restart after an announcement stays in message mode", () => {
    const d = dir();
    const reg = new GameSessionRegistry(new FileSaveStore(d));
    const s = start(reg);
    expect(s.messageModeNow(), "legacy billing before any announcement").toBe(false);
    s.noteMessage({ messageId: "m-1" });
    expect(s.messageModeNow()).toBe(true);
    reg.saveUser("u");
    expect(reload(d).messageModeNow(), "restored from the non-empty ring").toBe(true);
  });

  it("a restart BEFORE any announcement stays in legacy billing (nothing to restore)", () => {
    const d = dir();
    const reg = new GameSessionRegistry(new FileSaveStore(d));
    start(reg);
    reg.saveUser("u");
    expect(reload(d).messageModeNow()).toBe(false);
  });

  it("a new-season reset returns to legacy billing, and a restart after the reset stays there until announced", () => {
    const d = dir();
    const reg = new GameSessionRegistry(new FileSaveStore(d));
    const s = start(reg);
    s.noteMessage({ messageId: "m-1" });
    reg.saveUser("u");
    const fresh = reg.resetUser("u").session as unknown as Sess;
    fresh.createCharacter({ playerName: "P", seed: 6 });
    fresh.advanceGame(); fresh.advanceGame();
    expect(fresh.messageModeNow(), "the dead season's mode must not carry into the new season").toBe(false);
    reg.saveUser("u");
    expect(reload(d).messageModeNow(), "a restart before the new season's first announcement is legacy, not stale message mode").toBe(false);
    // the new season's own announcements take effect, and survive a restart
    fresh.noteMessage({ messageId: "m-1" }); // the SAME id as the dead season's: a fresh season forgot the old ring, so it is accepted
    expect(fresh.messageModeNow()).toBe(true);
    reg.saveUser("u");
    expect(reload(d).messageModeNow()).toBe(true);
  });

  it("a confirmed createCharacter restart (the sanctioned door) lands in legacy billing", () => {
    const d = dir();
    const reg = new GameSessionRegistry(new FileSaveStore(d));
    const s = start(reg);
    s.noteMessage({ messageId: "m-1" });
    expect(s.messageModeNow()).toBe(true);
    s.createCharacter({ playerName: "P", seed: 9, confirmRestart: true }); // routes through the registry's resetUser: a NEW adapter in a clean sandbox
    const next = reg.sandboxFor("u").session as unknown as Sess;
    expect(next.messageModeNow()).toBe(false);
  });
});
