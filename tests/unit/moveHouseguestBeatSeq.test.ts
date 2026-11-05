import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { HouseguestMoveResult } from "../../src/ports/GameSession";

/**
 * A29 - an APPLIED narrated NPC relocation commits (it persists, so it bumps the closed-set beatSeq) but its result carried no token, so the front-end's last-seen beatSeq went stale and its
 * NEXT compare-and-swap call (the deferred scene-fold settle) got a self-inflicted stale-beat 409 (7 in the P0d run, 3+ right after "auto-moved"). The result must carry the post-commit
 * beatSeq on a "moved" so the FE can refresh. A "noop" commits nothing and bumps nothing. Roles only.
 */
async function game() {
  const rt = composeRuntime({ clock: new FakeClock(), seed: 1 });
  const mcp = rt.registry.resolver()("player", "u");
  await mcp.callTool("createCharacter", { playerName: "P", archetype: "floater", seed: 7 });
  const session = rt.registry.sandboxFor("u").session;
  const npcId = session.livingIds().filter((i) => i !== "player")[0]!;
  return { mcp, session, npcId };
}

describe("moveHouseguest returns the post-commit beatSeq", () => {
  it("a moved result carries the beatSeq the commit just produced", async () => {
    const { mcp, session, npcId } = await game();
    const before = session.beatSeqNow();
    const res = (await mcp.callTool("moveHouseguest", { id: npcId, room: "kitchen" })) as HouseguestMoveResult;
    // pick a room the NPC is NOT already in so the move is applied
    const r2 = res.status === "moved" ? res : ((await mcp.callTool("moveHouseguest", { id: npcId, room: "backyard" })) as HouseguestMoveResult);
    expect(r2.status).toBe("moved");
    expect(session.beatSeqNow(), "the applied move bumped the counter").toBeGreaterThan(before);
    expect(r2.beatSeq, "the moved result carries the token the FE must adopt").toBe(session.beatSeqNow());
  });

  it("a noop move commits nothing and bumps nothing", async () => {
    const { mcp, session, npcId } = await game();
    await mcp.callTool("moveHouseguest", { id: npcId, room: "kitchen" });
    const seq = session.beatSeqNow();
    const again = (await mcp.callTool("moveHouseguest", { id: npcId, room: "kitchen" })) as HouseguestMoveResult;
    expect(again.status).toBe("noop");
    expect(session.beatSeqNow()).toBe(seq);
  });
});
