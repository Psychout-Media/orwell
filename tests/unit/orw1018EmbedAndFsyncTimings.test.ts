import { describe, it, expect } from "vitest";
import { useDynamicPadding } from "../../src/adapters/embedding/fastembedWorker";

/** ORW-1018: fastembed pads every input to 512 tokens; the worker swaps in batch-longest padding (no maxLength). */
describe("useDynamicPadding", () => {
  it("sets padding without a maxLength so the batch pads to its longest sequence", () => {
    const calls: Array<Record<string, unknown>> = [];
    const embedder = { tokenizer: { setPadding: (o: Record<string, unknown>) => { calls.push(o); } } };
    expect(useDynamicPadding(embedder, { padId: 0, padToken: "[PAD]" })).toBe(true);
    expect(calls).toEqual([{ padId: 0, padToken: "[PAD]" }]);
    expect("maxLength" in calls[0]!).toBe(false);
  });

  it("is fail-soft: a missing tokenizer or a throwing setPadding keeps the fixed padding", () => {
    expect(useDynamicPadding({}, { padId: 0, padToken: "[PAD]" })).toBe(false);
    expect(useDynamicPadding({ tokenizer: {} }, { padId: 0, padToken: "[PAD]" })).toBe(false);
    const boom = { tokenizer: { setPadding: () => { throw new Error("no"); } } };
    expect(useDynamicPadding(boom, { padId: 0, padToken: "[PAD]" })).toBe(false);
  });
});

import { StallTimer, SAVE_FSYNC_OUTLIER_MS } from "../../src/adapters/stallTiming";

describe("save.fsync default SLOW line (ORW-1018)", () => {
  it("a normal ~1 s background fsync is counted but not logged; a real outlier is logged; other steps keep 500 ms", () => {
    const lines: string[] = [];
    const t = new StallTimer((l) => lines.push(l));
    t.record("save.fsync", 1000, { version: 1 });
    t.record("save.fsync", SAVE_FSYNC_OUTLIER_MS + 1, { version: 2 });
    t.record("embed.call", 600, { chars: 10 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("step=save.fsync ms=5001");
    expect(lines[1]).toContain("step=embed.call");
    expect(t.snapshot()["save.fsync"]).toMatchObject({ count: 2, slow: 1 });
  });
});
