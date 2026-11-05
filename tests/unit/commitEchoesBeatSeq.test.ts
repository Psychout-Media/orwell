import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/**
 * A29 (class fix) - ANY tool whose call COMMITS (bumps the closed-set beatSeq) returns the post-commit token, so the front-end's last-seen token is never left stale for its next
 * compare-and-swap call. One case per lever below; a read / a no-op must NOT gain the key (byte-identical). Roles only.
 */
async function game(entrances = false) {
  const rt = composeRuntime({ clock: new FakeClock(), seed: 1 });
  const mcp = rt.registry.resolver()("player", "u");
  if (entrances) rt.registry.sandboxFor("u").session.setPremiereEntrancesEnabled(true);
  await mcp.callTool("createCharacter", { playerName: "P", archetype: "floater", seed: 7 });
  const session = rt.registry.sandboxFor("u").session;
  const npcs = session.livingIds().filter((i) => i !== "player");
  return { mcp, session, npcs };
}
type Obj = Record<string, unknown>;

describe("a committing tool echoes the post-commit beatSeq", () => {
  const levers: Array<[string, (npcs: string[]) => Obj]> = [
    ["diaryRoom", () => ({ entry: "a private thought" })],
    ["recordInteraction", (n) => ({ initiator: "player", witnessSet: ["player", n[0]!], content: "a chat about nothing", kind: "bonding" })],
    ["cancelSelfEviction", () => ({})],
    ["moveHouseguest", (n) => ({ id: n[0]!, room: "backyard" })],
    ["makeDeal", (n) => ({ with: n[0]!, kind: "safety", terms: "I will keep you safe this week" })],
  ];
  for (const [tool, mkArgs] of levers) {
    it(`${tool}: if the call bumped beatSeq, the result carries exactly the new token`, async () => {
      const { mcp, session, npcs } = await game();
      const before = session.beatSeqNow();
      const res = (await mcp.callTool(tool, mkArgs(npcs))) as Obj | null;
      const after = session.beatSeqNow();
      if (after !== before) {
        expect(res, `${tool} committed`).not.toBeNull();
        expect(res!.beatSeq, `${tool} must echo the post-commit token`).toBe(after);
      } else {
        // a no-op / refused call: nothing committed, so no key was invented
        expect(res === null || !("beatSeq" in (res as Obj)) || typeof (res as Obj).beatSeq === "number").toBe(true);
      }
      expect(after, `${tool} is a committing lever in this harness (the case would be vacuous otherwise)`).toBeGreaterThan(before);
    });
  }

  it("reads and idempotent calls are byte-identical (no beatSeq key invented)", async () => {
    const { mcp, session } = await game();
    const before = session.beatSeqNow();
    const w = (await mcp.callTool("whereabouts", {})) as Obj;
    expect(session.beatSeqNow()).toBe(before);
    expect("beatSeq" in w).toBe(false);
  });

  it("a result that already carries beatSeq is left untouched", async () => {
    const { mcp, session } = await game();
    const res = (await mcp.callTool("noteMessage", { messageId: "m-echo-1" })) as Obj;
    expect(res.beatSeq).toBe(session.beatSeqNow());
  });
});
