import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** ORW-583: small color is the narrator's; a real feeling, suspicion, stance or plan comes from the engine. Roles only. */
const HUNCH_HELD = "SENTINEL-583-hunch-nobody-delivered";
const HUNCH_SHARED = "SHARED-583-hunch-the-player-also-holds";

describe("ORW-583 the flavor rule is a rule, not a sample", () => {
  const src = readFileSync("src/engine/momentPrompts.ts", "utf8");
  const start = src.indexOf("FLAVOR vs OUTCOMES");
  const block = src.slice(start - 200, start + 1400);
  it("states the boundary", () => {
    expect(block).toContain("small color is yours to invent");
    expect(block).toContain("must come from a fact the game");
  });
  it("has no quoted example line, no invented-moods menu, no example marker", () => {
    expect(block).not.toMatch(/invent moods/);
    expect(block).not.toMatch(/\be\.g\.|for example|such as/i);
    expect(src).not.toContain("not my target yet, but could be");
    expect(src).not.toContain("Invent ambient FLAVOR");
  });
});

type S = {
  livingIds(): EntityId[];
  npcVoice(id: EntityId): { suspects: string[]; stances: { toward: { id: EntityId } }[] } | null;
  setDisclosureEngineEnabled(on: boolean): void;
  juryHouseView: () => unknown;
  presence: Map<EntityId, string>;
};
async function game() {
  const rt = composeRuntime({ clock: new FakeClock(), seed: 11 });
  const user = `w583-${Math.random()}`;
  const mcp = rt.registry.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed: 11, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = rt.registry.sandboxFor(user);
  const s = sb.session as unknown as S;
  const [holder, other] = s.livingIds().filter((i: EntityId) => i !== PLAYER) as [EntityId, EntityId];
  const k = sb.engine.knowledge as unknown as { addSuspicion(e: EntityId, f: { content: string; subject?: EntityId }): unknown };
  return { s, holder, other, k };
}

describe("ORW-583 suspects and stances pass the same disclosure gate as knows", () => {
  it("a hunch the player does not hold is withheld; one they hold is handed over; flag off hands both", async () => {
    const { s, holder, other, k } = await game();
    const seed = (who: EntityId, content: string) => k.addSuspicion(who, { content, subject: other });
    seed(holder, HUNCH_HELD);
    seed(holder, HUNCH_SHARED);
    seed(PLAYER, HUNCH_SHARED);
    const on = s.npcVoice(holder)!.suspects.join("|");
    expect(on).not.toContain(HUNCH_HELD);
    expect(on).toContain(HUNCH_SHARED);
    expect(on).not.toContain("keeping a close eye");
    s.setDisclosureEngineEnabled(false);
    const off = s.npcVoice(holder)!.suspects.join("|");
    expect(off).toContain(HUNCH_HELD);
  });
  it("stances: only the stance toward the player when gated; all of them when off", async () => {
    const { s, holder } = await game();
    const gated = s.npcVoice(holder)!.stances.map((x) => x.toward.id);
    expect(gated.every((id) => id === PLAYER)).toBe(true);
    s.setDisclosureEngineEnabled(false);
    expect(s.npcVoice(holder)!.stances.length).toBeGreaterThan(gated.length);
  });
  it("jury house: the gate is off, as it is for knows", async () => {
    const { s, holder } = await game();
    s.juryHouseView = () => ({ jurors: [] });
    expect(s.npcVoice(holder)!.stances.length).toBeGreaterThan(1);
  });
});
