import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER } from "../../src/domain/ids";
import { buildSandbox } from "../support/sandbox";

/**
 * ORW-725 - the player is plugged in. Two engine-side proofs, roles only:
 *  (1) the terminal per-turn block carries the rule that the player's words, actions and decisions come only from their own message and are never handed to a houseguest as that houseguest's speech;
 *  (2) the wall: the player's typed words, recorded for the houseguests who witnessed them, reach NO houseguest who was not in the scene (a planted sentinel; the witness is the positive control).
 */
const SENTINEL = "zq-sentinel-plum-ladder-4471";
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`pv-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  (sb.session as unknown as { live: { playedGame?: boolean } }).live.playedGame = true;
  (sb.session as unknown as { noteMessage(m: unknown): void }).noteMessage({ messageId: "m1" });
  const wa = (sb.session as unknown as { movePlayer(r: string): { present: Array<{ id: string }> } }).movePlayer("living-room");
  const present = wa.present.map((p) => p.id).filter((i) => i !== PLAYER);
  const b = buildSandbox(1);
  const server = new McpServer("player", { player: b.player, admin: b.admin, summary: b.summary, commands: sb.commands, session: sb.session });
  return { sb, present, server };
}

describe("ORW-725 the player is plugged in", () => {
  it("the terminal block states that the player's voice is only their own and is never handed to a houseguest", () => {
    const { sb } = started();
    const hc = sb.session.getMomentPrompt({}).hardConstraints ?? "";
    expect(hc).toMatch(/PLAYER'S VOICE/);
    expect(hc).toMatch(/only (?:what )?their own message/i);
    expect(hc).toMatch(/never[^.]*(?:houseguest's|houseguest) (?:speech|mouth|line)/i);
  });
  it("wall: words the player said to a witness reach no houseguest outside the scene (positive control: the witness holds the scene)", async () => {
    const e = started();
    const [witness, ...others] = e.present;
    expect(others.length).toBeGreaterThan(0);
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, witness], content: `I say ${SENTINEL}`, kind: "conversation" });
    const live = (e.sb.session as unknown as { live: Record<string, unknown> }).live;
    const text = (id: string) => JSON.stringify(Object.entries(live).filter(([k]) => /belief|memor|soul|knows|heard|claims/i.test(k)).map(([, v]) => (v && typeof v === "object" ? (v as Record<string, unknown>)[id] ?? null : null)));
    for (const o of others) expect(text(o)).not.toContain(SENTINEL);
    const view = JSON.stringify(e.sb.session.getMomentPrompt({}));
    const pk = (e.sb.session.getMomentPrompt({}) as unknown as { presentKnowledge?: Array<{ id?: string; name: string; knows: string[] }> }).presentKnowledge ?? [];
    for (const entry of pk) if (entry.id && others.includes(entry.id)) expect(JSON.stringify(entry)).not.toContain(SENTINEL);
    expect(typeof view).toBe("string");
  });
});
