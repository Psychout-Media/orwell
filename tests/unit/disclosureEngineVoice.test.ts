import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * A52 / ORW-23 (Ryne card 19: he does not want the narrator improvising disclosures). In a PLAYED game `npcVoice.knows` is only the shared ground: facts the player also holds (witnessed together, or already
 * delivered by an engine disclosure). What a houseguest holds about third parties that no engine decision has delivered never reaches the narrator, so whether a secret spills is an engine roll, not the model's call.
 * A press the engine declined this beat carries `deflect`. OFF (the flag, or a headless game) the projection is byte-identical. Roles only (holder, other).
 */
const HELD = "SENTINEL-A52-held-secret-about-the-other-houseguest";
const SHARED = "SHARED-A52-the-whole-house-saw-the-holder-and-the-other-argue";
const SHARED_FOR_PLAYER = "SHARED-A52-the-holder-told-me-they-argued"; // the player's own copy of the same lineage, worded differently

type S = {
  livingIds(): EntityId[];
  npcVoice(id: EntityId): { knows: string[]; deflect?: true } | null;
  getMomentPrompt(a: object): { systemPrompt: string };
  setDisclosureEngineEnabled(on: boolean): void;
  presence: Map<EntityId, string>;
  noteDisclosure(npc: EntityId, e: { outcome: "confirm" | "slip" | "deflect"; via: "confide" | "drip"; truthful: boolean }): void;
};
async function game(played: boolean) {
  const rt = composeRuntime({ clock: new FakeClock(), seed: 11 });
  const user = `a52-${Math.random()}`;
  const mcp = rt.registry.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed: 11, archetype: "floater" });
  if (played) await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = rt.registry.sandboxFor(user);
  const s = sb.session as unknown as S;
  const [holder, other] = s.livingIds().filter((i: EntityId) => i !== PLAYER) as [EntityId, EntityId];
  const k = sb.engine.knowledge as unknown as { seedBelief(e: EntityId, f: { content: string; factId: string; subject?: EntityId }, p: string): unknown };
  k.seedBelief(holder, { content: HELD, factId: "f-held", subject: other }, "told-by:npc:9");
  k.seedBelief(holder, { content: SHARED, factId: "f-shared", subject: other }, "witnessed");
  k.seedBelief(PLAYER, { content: SHARED_FOR_PLAYER, factId: "f-shared", subject: other }, "told-by:" + holder);
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  s.presence.set(holder, "kitchen"); s.presence.set(PLAYER, "kitchen");
  return { s, holder, other };
}

describe("the narrator is handed only what the engine has put on the table (A52)", () => {
  it("a played game: the shared fact (even worded differently for the player) is in `knows`, the held third-party secret is not, in the voice and in the moment prompt", async () => {
    const { s, holder } = await game(true);
    const v = s.npcVoice(holder)!;
    expect(v.knows.join("|")).toContain("argue");
    expect(v.knows.join("|")).not.toContain(HELD);
    const prompt = s.getMomentPrompt({}).systemPrompt;
    expect(prompt).not.toContain(HELD);
    expect(prompt).toContain("only what the engine has put on the table");
  });

  it("flag off: byte-identical to before (the held fact is handed over, the prompt has no instruction)", async () => {
    const { s, holder } = await game(true);
    s.setDisclosureEngineEnabled(false);
    expect(s.npcVoice(holder)!.knows.join("|")).toContain(HELD);
    expect(s.getMomentPrompt({}).systemPrompt).not.toContain("only what the engine has put on the table");
  });

  it("a headless game (nobody has played) is untouched even with the flag on", async () => {
    const { s, holder } = await game(false);
    expect(s.npcVoice(holder)!.knows.join("|")).toContain(HELD);
    expect(s.getMomentPrompt({}).systemPrompt).not.toContain("only what the engine has put on the table");
  });

  it("a press the engine declined this beat carries deflect; a confirm or nothing does not; flag off does not", async () => {
    const { s, holder } = await game(true);
    expect("deflect" in s.npcVoice(holder)!).toBe(false);
    s.noteDisclosure(holder, { outcome: "confirm", via: "confide", truthful: true });
    expect("deflect" in s.npcVoice(holder)!).toBe(false);
    s.noteDisclosure(holder, { outcome: "deflect", via: "confide", truthful: true });
    expect(s.npcVoice(holder)!.deflect).toBe(true);
    s.setDisclosureEngineEnabled(false);
    expect("deflect" in s.npcVoice(holder)!).toBe(false);
  });

  it("it is a read-only projection: a played session reaches the same state with the engine on and off", async () => {
    const run = async (on: boolean): Promise<string> => {
      const rt = composeRuntime({ clock: new FakeClock(), seed: 13 });
      const user = "a52-state";
      const mcp = rt.registry.resolver()("player", user);
      await mcp.callTool("createCharacter", { playerName: "The Player", seed: 13, archetype: "floater" });
      (rt.registry.sandboxFor(user).session as unknown as S).setDisclosureEngineEnabled(on);
      for (let i = 0; i < 30; i++) { await mcp.callTool("noteMessage", { messageId: `m${i}` }); await mcp.callTool("getMomentPrompt", {}).catch(() => undefined); }
      return JSON.stringify(rt.registry.snapshot(user));
    };
    expect(await run(true)).toBe(await run(false));
  });
});
