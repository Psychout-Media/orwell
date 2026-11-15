import { describe, it, expect, vi } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { LogicalClock } from "../../src/adapters/time/LogicalClock";
import { TurnRefusedError } from "../../src/domain/errors";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";
import { npc } from "../../src/domain/ids";

/**
 * ORW-321 - an integrity-checkpoint refusal must never fail silently. The live ORW-316 freeze was diagnosable only by an offline replay because the refusal said just "degradation". Now it names the FIRST
 * failing invariant (a field name only - never content), in the thrown error, the HTTP body source (`invariants`), the fault ring (`sandboxHealth`) and the log line. Roles only.
 */
type Any = Record<string, any>;
function game() {
  const reg = new GameSessionRegistry();
  const orch = new Orchestrator(reg, new LogicalClock());
  const sb = reg.sandboxFor("u-refuse");
  (sb.session as Any).createCharacter({ playerName: "P", seed: 9 });
  (sb.session as Any).noteMessage({ messageId: "m1" });
  orch.commitPlayerTurn("u-refuse"); // the baseline
  return { reg, orch, sb: sb.session as Any };
}

describe("a refused turn names the failing invariant", () => {
  it("a deleted deal (the ORW-316 shape) is refused as sessionCore.deals, state unchanged", () => {
    const { reg, orch, sb } = game();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    sb.deals.make([npc(1), npc(2)], "conditional", "keep each other if on the block", undefined, 1);
    reg.invalidateSnapshot("u-refuse");
    orch.commitPlayerTurn("u-refuse"); // the deal is now part of the baseline
    sb.deals.load([]); // simulate the old bug: the entry vanishes
    reg.invalidateSnapshot("u-refuse"); // a direct ledger write bypasses the registry's snapshot-cache key (rev + event count); a real mutation goes through a session call that bumps it
    let thrown: unknown;
    try { orch.commitPlayerTurn("u-refuse"); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TurnRefusedError);
    const t = thrown as TurnRefusedError;
    expect(t.kinds).toEqual(["degradation"]);
    expect(t.invariants).toEqual(["sessionCore.deals"]);
    // the fault ring carries the same name, so sandboxHealth is diagnosable in one look
    const health = orch.sandboxHealth("u-refuse") as Any;
    expect(health.lastIntegrity).toBe("fault");
    expect(health.faults.some((f: Any) => f.kind === "degradation" && f.detail === "sessionCore.deals")).toBe(true);
    // and the operator log line names it
    expect(err.mock.calls.some((c) => String(c[0]).includes("invariant=sessionCore.deals"))).toBe(true);
    err.mockRestore();
  });
  it("no content or id ever rides the invariant name (a field name only)", () => {
    const { reg, orch, sb } = game();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    sb.deals.make([npc(3), npc(4)], "conditional", "SECRET-TERMS", undefined, 1);
    reg.invalidateSnapshot("u-refuse");
    orch.commitPlayerTurn("u-refuse");
    sb.deals.load([]);
    reg.invalidateSnapshot("u-refuse");
    let t: TurnRefusedError | undefined;
    try { orch.commitPlayerTurn("u-refuse"); } catch (e) { t = e as TurnRefusedError; }
    const blob = JSON.stringify([t?.message, t?.invariants, orch.sandboxHealth("u-refuse")]);
    expect(blob).not.toMatch(/SECRET-TERMS|npc:3|npc:4|deal:1/);
    err.mockRestore();
  });
  it("sessionCoreSupersetViolation names the dimension (null when nothing was lost)", () => {
    const { reg, sb } = game();
    const before = sb.snapshot();
    expect(sessionCoreSupersetViolation(before, before)).toBeNull();
    sb.deals.make([npc(1), npc(2)], "vote", "a vote", undefined, 1);
    const withDeal = sb.snapshot();
    sb.deals.load([]);
    expect(sessionCoreSupersetViolation(sb.snapshot(), withDeal)).toBe("deals");
    void reg;
  });
});
