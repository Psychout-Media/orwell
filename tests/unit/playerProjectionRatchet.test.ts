import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { PLAYER_PROJECTION_REGISTRY } from "../support/playerProjectionRegistry";

/**
 * ORW-299 ratchet - same pattern as portDispatchCoverage.test.ts. The port's methods are read MECHANICALLY from src/ports/GameSession.ts (TypeScript compiler API),
 * and each is classified from its return type: a `Record<Thing>Result` receipt (or the bare noteMessage ack) is a write-back with no player-facing text; EVERYTHING
 * else returns a view / text / structure and must be registered in PLAYER_PROJECTION_REGISTRY with how the player-perspective sentinel covers it. A new projection
 * method therefore cannot ship without joining the sentinel (or an explicit, reasoned entry).
 */
function portMethods(): { name: string; returns: string }[] {
  const file = join(__dirname, "../../src/ports/GameSession.ts");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: { name: string; returns: string }[] = [];
  sf.forEachChild((n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === "GameSession") {
      for (const m of n.members) if (ts.isMethodSignature(m)) out.push({ name: m.name.getText(sf), returns: m.type ? m.type.getText(sf).replace(/\s+/g, " ") : "void" });
    }
  });
  return out;
}
const isReceipt = (returns: string): boolean => /^Record[A-Za-z]*Result$/.test(returns) || /^HouseguestMoveResult$/.test(returns) || returns === "{ accepted: boolean; beatSeq: number }";

describe("ORW-299 - every GameSession port projection joins the player-perspective sentinel", () => {
  const methods = portMethods();
  const byName = new Map(PLAYER_PROJECTION_REGISTRY.map((e) => [e.method, e]));

  it("parses the port (guard against a silent empty scan)", () => { expect(methods.length).toBeGreaterThan(50); });

  it.each(methods.map((m) => [m.name, m.returns] as const))("%s (%s) is registered", (name, returns) => {
    const e = byName.get(name);
    expect(e, `port method "${name}" returns ${returns} but is not in PLAYER_PROJECTION_REGISTRY (tests/support/playerProjectionRegistry.ts): register it and make the player-perspective sentinel sweep it`).toBeDefined();
    expect(e!.note.length, `${name}: a registry entry needs a reason`).toBeGreaterThan(5);
    if (!isReceipt(returns)) expect(e!.coveredBy, `${name} returns ${returns} (player-facing text/structure) - it cannot be filed as a bare write-back receipt`).not.toBe("write-back");
  });

  it("has no stale entries for methods the port no longer has", () => {
    const names = new Set(methods.map((m) => m.name));
    expect(PLAYER_PROJECTION_REGISTRY.filter((e) => !names.has(e.method)).map((e) => e.method)).toEqual([]);
  });
});
