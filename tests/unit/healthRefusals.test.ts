import { describe, it, expect } from "vitest";
import { HealthMetrics } from "../../src/adapters/mcp/healthMetrics";

describe("HealthMetrics refusals", () => {
  it("counts answered-but-refused calls by label, bounded, and projects them on the snapshot", () => {
    const m = new HealthMetrics();
    expect(m.snapshot().refusals).toEqual({});
    m.recordRefusal("noteMessage:no-game"); m.recordRefusal("noteMessage:no-game");
    expect(m.snapshot().refusals).toEqual({ "noteMessage:no-game": 2 });
    for (let i = 0; i < 100; i++) m.recordRefusal(`x${i}`);
    expect(Object.keys(m.snapshot().refusals).length).toBeLessThanOrEqual(32);
  });
});
