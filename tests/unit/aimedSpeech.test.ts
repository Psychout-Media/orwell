import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { claimsHeardBy, liesBy } from "../../src/engine/spokenClaims";

/**
 * ORW-611 follow-up (0151 / 0153): a speech step aimed at the player is told through the SAME door as an NPC-to-NPC telling (`sayInHouseLife` -> `planSpeech` -> `tellClaim`),
 * once the houseguest has stepped up to the player. Roles only (speaker, listener, target).
 */
async function setup(seed = 31) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry as GameSessionRegistry;
  const user = `aimed-speech-${seed}-${Math.random()}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const sess = reg.sandboxFor(user).session as any;
  const [speaker, listener, target] = (sess.livingIds() as EntityId[]).filter((i) => i !== PLAYER) as [EntityId, EntityId, EntityId];
  for (const id of [...sess.presence.keys()]) sess.presence.set(id, "backyard");
  sess.presence.set(PLAYER, "kitchen"); sess.presence.set(speaker, "kitchen");
  const salt = "aimed-test-salt";
  const step = { kind: "plant", actor: speaker, about: target, truthful: false };
  const arm = () => { sess.live.interruption = { npc: speaker, desire: "probe", atHour: 9, say: { kind: "plant", about: target, truthful: false, salt } }; sess.disclosureEpoch += 1; };
  const present = () => (sess.presentKnowledgeForPrompt() as Array<{ id: string; tellsYou?: Record<string, unknown> }>).find((e) => e.id === speaker);
  return { sess, speaker, listener, target, salt, step, arm, present, mcp };
}

describe("parity: the same speech step, an NPC listener and the player as listener", () => {
  it("records the same kind of claim by the same path; only the holder differs", async () => {
    const { sess, speaker, listener, step, salt } = await setup();
    const toNpc = sess.sayInHouseLife(step, listener, salt);
    const toPlayer = sess.sayInHouseLife(step, PLAYER, salt);
    expect(toNpc && toPlayer).toBeTruthy();
    for (const k of ["kind", "subject", "intent", "origin", "speaker"] as const) expect(toPlayer[k]).toEqual(toNpc[k]);
    expect(toPlayer.isTrue).toBe(toNpc.isTrue);
    expect(toNpc.listener).toBe(listener);
    expect(toPlayer.listener).toBe(PLAYER);
    // the NPC holds a told belief with the speaker as source; the player holds the claim in the log (the speaker is the source)
    const held = (sess.live.beliefs[listener] ?? []).find((b: any) => b.origin === "told" && b.source === speaker);
    expect(held).toBeTruthy();
    expect(claimsHeardBy(sess.live.claims, PLAYER).some((h) => h.speaker === speaker && h.kind === toPlayer.kind && h.subject === toPlayer.subject)).toBe(true);
  });
});

describe("a speech step aimed at the player, told when they step up", () => {
  it("lands as a told claim carrying its own hidden truth, once; the narrator gets the Vault-free fields", async () => {
    const { sess, speaker, arm, present } = await setup();
    arm();
    const view = present()!;
    expect(view.tellsYou).toBeTruthy();
    expect(Object.keys(view.tellsYou!).every((k) => ["kind", "subject", "object", "label", "certainty"].includes(k))).toBe(true);
    const told = sess.live.claims.items.filter((c: any) => c.speaker === speaker && c.listener === PLAYER);
    expect(told.length).toBe(1);
    expect(told[0].origin).toBe("engine");
    expect(typeof told[0].isTrue).toBe("boolean");
    expect(liesBy(sess.live.claims, speaker).some((c) => c.id === told[0].id)).toBe(!told[0].isTrue); // a lie is catchable like any other
    expect(sess.credibilityOf(PLAYER, speaker)).toBeGreaterThan(0);
    expect(sess.live.interruption.say).toBeUndefined(); // consumed
    sess.disclosureEpoch += 1; present();
    expect(sess.live.claims.items.filter((c: any) => c.speaker === speaker && c.listener === PLAYER && c.id === told[0].id).length).toBe(1);
  });

  it("is told only to the player's own framing, and only for the houseguest who stepped up (no stray listener)", async () => {
    const { sess, speaker, listener, arm } = await setup();
    arm();
    expect(sess.tellAimedSpeech(listener)).toBeUndefined();
    expect(sess.live.interruption.say).toBeTruthy();
    expect(sess.live.claims?.items.filter((c: any) => c.speaker === speaker) ?? []).toEqual([]);
  });

  it("the wall: no truth, intent or claim id in what the narrator sees (positive control: the engine log has them)", async () => {
    const { sess, speaker, arm, present, mcp } = await setup();
    arm();
    const view = present()!;
    const seen = JSON.stringify([view, await mcp.callTool("getGameState", {})]);
    const c = sess.live.claims.items.find((x: any) => x.speaker === speaker && x.listener === PLAYER);
    expect(JSON.stringify(c)).toContain('"isTrue"');
    expect(JSON.stringify(c)).toContain('"intent"');
    expect(seen).not.toContain(c.id);
    expect(seen).not.toContain('"isTrue"');
    expect(seen).not.toContain('"mislead"');
  });

  it("survives a save round trip (the claim and a pending say)", async () => {
    const { sess, arm, present, speaker } = await setup();
    arm();
    const copy = JSON.parse(JSON.stringify(sess.live.interruption));
    expect(copy.say.salt).toBe("aimed-test-salt");
    present();
    const logCopy = JSON.parse(JSON.stringify(sess.live.claims));
    expect(logCopy.items.some((c: any) => c.speaker === speaker && c.listener === PLAYER)).toBe(true);
  });

  it("flag off: nothing is told and nothing is consumed", async () => {
    const { sess, speaker, arm, present } = await setup();
    sess.setClaimsToPlayerEnabled(false);
    arm();
    expect(present()?.tellsYou).toBeUndefined();
    expect(sess.live.claims?.items.filter((c: any) => c.speaker === speaker && c.listener === PLAYER) ?? []).toEqual([]);
    expect(sess.live.interruption.say).toBeTruthy();
  });
});

describe("the seams", () => {
  it("the hour loop stashes the step on the approach it raised and the approach hands it to the interruption, under the existing flag (no new flag)", () => {
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    expect(src).toContain("g.say = { kind: p.kind, truthful: p.truthful");
    expect(src).toContain("this.live.interruption.say = aimedSay");
    expect(src).toContain("const aimed = !jury ? this.tellAimedSpeech(id) : undefined;");
    expect(readFileSync("src/featureFlags.ts", "utf8")).not.toContain("AIMED_SPEECH");
  });
});
