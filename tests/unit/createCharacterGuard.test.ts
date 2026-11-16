import { testTmpDir } from "../support/freshTmpDir";
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * Feature B36 / audit A2 — non-degradation at its single most destructive point: createCharacter must
 * never silently wipe an already-started season. HARD rule: roles only — no names.
 */
const freshDir = (): string => testTmpDir("orwell-b36-");   // removed when its test ends
const userDir = (dir: string, user: string): string => join(dir, Buffer.from(user, "utf8").toString("hex"));
const versions = (dir: string, user: string): string[] =>
  readdirSync(userDir(dir, user)).filter((f) => /^v\d+\.json$/.test(f));

describe("B36 — createCharacter never silently wipes a started season", () => {
  it("a second createCharacter without confirmRestart is a no-op (state + prior saves intact)", () => {
    const dir = freshDir();
    const reg = new GameSessionRegistry(new FileSaveStore(dir));
    const session = reg.sandboxFor("u").session;

    const first = session.createCharacter({ playerName: "The Player", seed: 2 });
    expect(first.started).toBe(true);
    const snapBefore = JSON.stringify(session.snapshot());
    const versionsBefore = versions(dir, "u").length;

    // A stray / hallucinated / network second call with DIFFERENT inputs must not replace the game.
    const again = session.createCharacter({ playerName: "Imposter", seed: 999 });
    expect(again.player!.name).toBe("The Player");                // returns the CURRENT game, unchanged
    expect(JSON.stringify(session.snapshot())).toBe(snapBefore);   // byte-identical state
    expect(versions(dir, "u").length).toBe(versionsBefore);        // no new save version written
  });

  it("an explicit confirmRestart DOES start a fresh game (the admin reset path)", () => {
    const session = new GameSessionRegistry().sandboxFor("u").session;
    session.createCharacter({ playerName: "The Player", seed: 2 });
    const reborn = session.createCharacter({ playerName: "Reborn", seed: 7, confirmRestart: true });
    expect(reborn.player!.name).toBe("Reborn");
  });

  it("fresh-sandbox onboarding is unaffected", () => {
    const view = new GameSessionRegistry().sandboxFor("new").session.createCharacter({ playerName: "P", seed: 1 });
    expect(view.started).toBe(true);
    expect((view.house as unknown[]).length).toBe(15);
  });
});
