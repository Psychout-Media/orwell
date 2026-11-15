import { describe, it, expect, vi } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** Review of #2778: the pre-save sequence (moods, recap catch-up, onPersist) is ONE function used by persist() and by the inOneCommit tail, so the two cannot drift. Roles only. */
type Priv = { runPersistSequence(): void; persist(): void; inOneCommit<T extends { beatSeq: number }>(fn: () => T): T };

describe("one pre-save sequence", () => {
  it("a direct persist() and a deferred one-commit tail each run it exactly once", () => {
    const s = new GameSessionAdapter();
    const p = s as unknown as Priv;
    const spy = vi.spyOn(p, "runPersistSequence").mockImplementation(() => {});
    p.persist();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    p.inOneCommit(() => { p.persist(); p.persist(); return { beatSeq: 0 }; }); // deferred twice, saved once at the tail
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
