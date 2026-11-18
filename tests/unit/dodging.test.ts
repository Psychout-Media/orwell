import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { approachWeights, decideDodge, type DodgeInput } from "../../src/engine/dodging";

/**
 * 0196 / ORW-630 - dodging the question. A pressed houseguest the engine has decided will not answer also gets HOW they dodge: engine-decided from character, bond and stakes on a keyed side stream, saved append-only,
 * and handed to the narrator as a third-person, number-free, content-free fact. Roles only (holder, asker).
 */
const base: DodgeInput = { cunning: 0.5, leakiness: 0.3, rattled: 0.2, trustInAsker: 0.5, stakes: 0.3 };
const SENTINEL = "SENTINEL-0196-held-secret-text";

describe("decideDodge (pure)", () => {
  it("is deterministic in its rolls and every approach stays possible", () => {
    expect(decideDodge(base, [0.2, 0.5, 0.5])).toEqual(decideDodge(base, [0.2, 0.5, 0.5]));
    for (const w of Object.values(approachWeights({ ...base, cunning: 0, trustInAsker: 0, rattled: 0, stakes: 1 }))) expect(w).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(decideDodge(base, [i / 200, 0.5, 0.5]).approach);
    expect(seen.size).toBe(6);
  });
  it("character moves it: the guileful push back and ask back more, the rattled read uneasy, the trusting laugh it off more", () => {
    const rate = (i: DodgeInput, pick: (f: ReturnType<typeof decideDodge>) => boolean): number => { let n = 0; for (let k = 0; k < 400; k++) if (pick(decideDodge(i, [(k * 0.618) % 1, (k * 0.377) % 1, (k * 0.911) % 1]))) n++; return n / 400; };
    expect(rate({ ...base, cunning: 0.9 }, (f) => f.pushesBack)).toBeGreaterThan(rate({ ...base, cunning: 0.1 }, (f) => f.pushesBack));
    expect(rate({ ...base, rattled: 1, leakiness: 0.6 }, (f) => f.openness === "uneasy")).toBeGreaterThan(rate({ ...base, rattled: 0 }, (f) => f.openness === "uneasy"));
    expect(rate({ ...base, trustInAsker: 1, stakes: 0 }, (f) => f.approach === "laugh-off")).toBeGreaterThan(rate({ ...base, trustInAsker: 0, stakes: 0 }, (f) => f.approach === "laugh-off"));
    expect(rate({ ...base, rattled: 1 }, (f) => f.approach === "stall")).toBeGreaterThan(rate({ ...base, rattled: 0 }, (f) => f.approach === "stall"));
  });
});

type S = {
  livingIds(): EntityId[];
  npcVoice(id: EntityId): { deflect?: true; dodge?: { approach: string; openness: string; pushesBack: boolean } } | null;
  getMomentPrompt(a: object): { systemPrompt: string };
  setDodgingEnabled(on: boolean): void;
  presence: Map<EntityId, string>;
  noteDisclosure(npc: EntityId, e: { outcome: "confirm" | "slip" | "deflect"; via: "confide" | "drip"; truthful: boolean }): void;
  recordDodge(npc: { id: EntityId; character: { strategyStyle?: string } }, s: object): void;
  dodgeLog: unknown[];
  house: { npcs: Array<{ id: EntityId; character: { strategyStyle?: string } }> };
  snapshotCore?: unknown;
};
async function game(played: boolean, seed = 11) {
  const rt = composeRuntime({ clock: new FakeClock(), seed });
  const user = `d0196-${Math.random()}`;
  const mcp = rt.registry.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  if (played) await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = rt.registry.sandboxFor(user);
  const s = sb.session as unknown as S;
  const holder = s.livingIds().filter((i: EntityId) => i !== PLAYER)[0]!;
  const k = sb.engine.knowledge as unknown as { seedBelief(e: EntityId, f: { content: string; factId: string }, p: string): unknown };
  k.seedBelief(holder, { content: SENTINEL, factId: "f-held" }, "witnessed");
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  s.presence.set(holder, "kitchen"); s.presence.set(PLAYER, "kitchen");
  return { s, holder, mcp };
}
const sig = { npcTrust: 0.3, npcAffinity: 0.3, npcThreat: 0.1, playerTrust: 0.3, playerAffinity: 0.3, goodwill: 0, archetype: "floater" };

describe("the dodge reaches the voice (played game)", () => {
  it("a declined press carries a dodge fact with exactly approach, openness, pushesBack; it is stable within the beat and no content or number crosses", async () => {
    const { s, holder } = await game(true);
    expect("dodge" in s.npcVoice(holder)!).toBe(false);
    s.noteDisclosure(holder, { outcome: "deflect", via: "confide", truthful: true });
    expect("dodge" in s.npcVoice(holder)!).toBe(false); // the engine has not decided how yet
    s.recordDodge(s.house.npcs.find((n) => n.id === holder)!, sig);
    s.recordDodge(s.house.npcs.find((n) => n.id === holder)!, sig); // a repeat press the same beat appends nothing
    expect(s.dodgeLog).toHaveLength(1);
    const v = s.npcVoice(holder)!;
    expect(v.deflect).toBe(true);
    expect(Object.keys(v.dodge!).sort()).toEqual(["approach", "openness", "pushesBack"]);
    const wire = JSON.stringify(v) + s.getMomentPrompt({}).systemPrompt;
    expect(wire).not.toContain(SENTINEL);
    expect(JSON.stringify(v.dodge)).not.toMatch(/\d/);
    expect(s.getMomentPrompt({}).systemPrompt).toContain("`dodge`");
  });
  it("a real confide press that is turned aside records a dodge and one that is given does not", async () => {
    let deflected = 0, dodged = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { s, holder, mcp } = await game(true, seed);
      const r = (await mcp.callTool("confide", { npcId: holder })) as { disclosed?: boolean } | null;
      const v = s.npcVoice(holder)!;
      if (r && r.disclosed === false && v.deflect) { deflected++; if (v.dodge) dodged++; }
      if (r?.disclosed) expect(v.dodge).toBeUndefined();
    }
    expect(deflected).toBeGreaterThan(0);
    expect(dodged).toBe(deflected);
  });
  it("flag off, or a headless game: no key, nothing recorded", async () => {
    const off = await game(true);
    off.s.setDodgingEnabled(false);
    off.s.noteDisclosure(off.holder, { outcome: "deflect", via: "confide", truthful: true });
    off.s.recordDodge(off.s.house.npcs.find((n) => n.id === off.holder)!, sig);
    expect(off.s.dodgeLog).toHaveLength(0);
    expect("dodge" in off.s.npcVoice(off.holder)!).toBe(false);
    expect(off.s.getMomentPrompt({}).systemPrompt).not.toContain("`dodge`");
    const head = await game(false);
    head.s.recordDodge(head.s.house.npcs.find((n) => n.id === head.holder)!, sig);
    expect(head.s.dodgeLog).toHaveLength(0);
  });
});
