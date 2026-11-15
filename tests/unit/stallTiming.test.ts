import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StallTimer, setStallTimerForTests, stallTimer } from "../../src/adapters/stallTiming";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FastembedEmbedding } from "../../src/adapters/embedding/FastembedEmbedding";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

const original = stallTimer;
afterEach(() => setStallTimerForTests(original));

/** A clock that advances by `stepMs` on every read: each phase then costs exactly one step. */
function steppedTimer(stepMs: number, lines: string[], threshold = 500): StallTimer {
  let t = 0;
  return new StallTimer((l) => lines.push(l), () => (t += stepMs), () => threshold);
}

describe("ORW-404 stall timing", () => {
  describe.each(["sync", "background"] as const)("save persist (%s mode)", (mode) => {
  const store = (dir: string) => new FileSaveStore(dir, { fsyncMode: mode, syncFile: async () => {}, syncDir: async () => {} });
  it("logs exactly one line with fields when a save persist is slow, and counts it", () => {
    const dir = mkdtempSync(join(tmpdir(), "stall-"));
    try {
      const lines: string[] = [];
      setStallTimerForTests(steppedTimer(300, lines));
      store(dir).saveFor("u", { a: 1 } as unknown as SessionSnapshot);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/step=save\.persist ms=\d+ serializeMs=300 writeMs=300 fsyncMs=300 renameMs=300 chars=\d+/);
      expect(stallTimer.snapshot()["save.persist"]).toMatchObject({ count: 1, slow: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("logs nothing on a fast save but still counts it", () => {
    const dir = mkdtempSync(join(tmpdir(), "stall-"));
    try {
      const lines: string[] = [];
      setStallTimerForTests(steppedTimer(1, lines));
      store(dir).saveFor("u", { a: 1 } as unknown as SessionSnapshot);
      expect(lines).toEqual([]);
      expect(stallTimer.snapshot()["save.persist"]).toMatchObject({ count: 1, slow: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  });

  function fakeEmbedder(): FastembedEmbedding {
    const sab = new SharedArrayBuffer(8 + 16 * 8);
    const ctl = new Int32Array(sab, 0, 2);
    const payload = new Float64Array(sab, 8);
    const worker = { postMessage: () => { payload.set([1, 2, 3]); ctl[1] = 3; Atomics.store(ctl, 0, 1); }, terminate: async () => 0 };
    const Ctor = FastembedEmbedding as unknown as new (...a: unknown[]) => FastembedEmbedding;
    return new Ctor(worker, ctl, payload, 3, 1000, { embed: () => [0, 0, 0] });
  }

  it("logs one line for a slow embed call and none for a fast one", () => {
    const slow: string[] = [];
    setStallTimerForTests(steppedTimer(900, slow));
    expect(fakeEmbedder().embed("hello")).toEqual([1, 2, 3]);
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatch(/step=embed\.call ms=900 chars=5/);

    const fast: string[] = [];
    setStallTimerForTests(steppedTimer(2, fast));
    fakeEmbedder().embed("hello");
    expect(fast).toEqual([]);
  });

  it("threshold is env-tunable and a throwing sink never breaks the caller", () => {
    process.env.ORWELL_STALL_LOG_MS = "10";
    try {
      const lines: string[] = [];
      let t = 0;
      const timer = new StallTimer((l) => lines.push(l), () => (t += 50));
      timer.record("x", 50);
      expect(lines).toHaveLength(1);
      const bad = new StallTimer(() => { throw new Error("boom"); });
      expect(() => bad.record("x", 5000)).not.toThrow();
    } finally { delete process.env.ORWELL_STALL_LOG_MS; }
  });
});
