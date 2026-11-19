import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playSeason } from "../support/whatFired/player";
import { firstDifference, restartVerdict } from "../support/whatFired/compare";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { sessionCoreSupersetViolation, type SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";

/**
 * ORW-730: a restart must never reroll the season. The engine's two stateful seeded streams (the orchestrator's per-user
 * off-screen stream and the command seam's) are saved by POSITION and picked up again on a resume. Every other draw in the
 * live path is a keyed hash of the game seed plus its own key and has nothing to save.
 */
const MESSAGES = 70;
const SEEDS = [1, 2];

describe("a seeded stream's position (ORW-730)", () => {
  it("seekTo puts a fresh stream exactly where a played one was, and position only counts forward", () => {
    const played = new SeededRandom(7);
    expect(played.position()).toBe(0);
    for (let i = 0; i < 1234; i++) played.next();
    expect(played.position()).toBe(1234);
    const fresh = new SeededRandom(7);
    fresh.seekTo(played.position());
    for (let i = 0; i < 50; i++) expect(fresh.next()).toBe(played.next());
    expect(fresh.position()).toBe(played.position());
    fresh.seekTo(-1); fresh.seekTo(1.5); fresh.seekTo(Number.NaN); // a bad count is ignored
    expect(fresh.position()).toBe(1284);
  });
});

describe("a restart continues the season it saved (ORW-730)", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: restarts at several points leave the played season identical to the uninterrupted one`, async () => {
      const whole = await playSeason({ seed, maxMessages: MESSAGES, sampleEvery: 1 });
      for (const point of [8, 23, 41]) {
        const dir = mkdtempSync(join(tmpdir(), "restart-pos-"));
        try {
          const restarted = await playSeason({ seed, maxMessages: MESSAGES, sampleEvery: 1, restartAt: point, saveDir: dir });
          const diff = firstDifference(whole.trace, restarted.trace);
          expect(restartVerdict(point, diff, restarted.trace), `restart at ${point}: ${JSON.stringify(diff)}`).toBe("identical");
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    }, 120_000);
  }
});

describe("the saved position in the save (ORW-730)", () => {
  const play = async (dir: string, messages: number): Promise<void> => { await playSeason({ seed: 2, maxMessages: messages, saveDir: dir }); };
  const newest = (dir: string): { file: string; snap: SessionSnapshot } => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const files = walk(dir).filter((f) => f.endsWith(".json"));
    const file = files.sort().at(-1)!;
    return { file, snap: JSON.parse(readFileSync(file, "utf8")) as SessionSnapshot };
  };

  it("is written, never goes backwards (a rewind is a save-integrity violation), and an old save without it still loads and plays on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-pos-"));
    try {
      await play(dir, 30);
      const { file, snap } = newest(dir);
      expect(snap.streamPos?.tick ?? 0).toBeGreaterThan(0);
      // the superset check: later >= earlier passes; a rewound position is named
      expect(sessionCoreSupersetViolation(snap, snap)).toBeNull();
      const rewound = { ...snap, streamPos: { ...snap.streamPos, tick: (snap.streamPos?.tick ?? 0) - 1 } } as SessionSnapshot;
      expect(sessionCoreSupersetViolation(rewound, snap)).toBe("streamPos.tick");
      const lostCommands = { ...snap, streamPos: { tick: snap.streamPos?.tick ?? 0 } } as SessionSnapshot;
      if ((snap.streamPos?.commands ?? 0) > 0) expect(sessionCoreSupersetViolation(lostCommands, snap)).toBe("streamPos.commands");

      // an OLD save: the field stripped from every saved file. It loads, resumes, and keeps playing with no fault.
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
      for (const f of walk(dir).filter((x) => x.endsWith(".json"))) {
        const j = JSON.parse(readFileSync(f, "utf8"));
        if (j && typeof j === "object" && "streamPos" in j) { delete j.streamPos; writeFileSync(f, JSON.stringify(j)); }
      }
      expect(file.length).toBeGreaterThan(0);
      const rt = composeRuntime({ saveStore: new FileSaveStore(dir), seed: 2 });
      const call = (n: string, a: Record<string, unknown>) => rt.registry.resolver()("player", "wf-2").callTool(n, a) as Promise<any>;
      const gs = await call("getGameState", {});
      expect(gs?.started).toBe(true);
      for (let i = 0; i < 12; i++) await call("noteMessage", {}).catch(() => undefined);
      const after = await call("getGameState", {});
      expect(after?.started).toBe(true);
      expect(JSON.stringify(after)).not.toContain("streamPos"); // engine-only: never on a read
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});
