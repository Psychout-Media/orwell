import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { GameEvent } from "../../src/domain/event";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { endHeldNight } from "../support/heldNight";

/**
 * ORW-315 (ORW-253 slice 3, Ryne approved the NPC minds design 2026-11-12; Ryne 2026-11-11: "The fact there are only 7 types seems
 * wild to me."): in a game a person PLAYS, the off-screen society is hour-by-hour house life from each houseguest's own goals, not a pair
 * and one of 7 stock scenes; a headless (advance-only) game keeps the old stretch. Real per-user sandbox, chat-paced. Roles only.
 */
type Life = NonNullable<GameEvent["houseLife"]>;

async function play(user: string, seed: number, opts: { messages: number; lifeOn?: boolean; chat?: boolean }) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  const session = reg.sandboxFor(user).session as GameSessionAdapter;
  if (opts.lifeOn === false) session.setHouseLifeEnabled(false);
  let msg = 0;
  for (let i = 0; i < opts.messages; i++) {
    if (opts.chat !== false) await mcp.callTool("noteMessage", { messageId: `${user}-${msg++}` });
    if (i % 12 === 11 || opts.chat === false) {
      const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown; finished?: boolean };
      if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `hl${seed}`, undefined, opts.chat === false ? { direct: true } : undefined);
      if (adv.pending) await mcp.callTool("submitDecision", answer(adv.pending));
      if (adv.finished) break;
    }
  }
  const snap = reg.snapshot(user) as SessionSnapshot;
  const life = snap.events.filter((e) => e.houseLife) as Array<GameEvent & { houseLife: Life }>;
  const offscreen = snap.events.filter((e) => e.id.startsWith("offscreen:"));
  return { reg, session, snap, life, offscreen };
}
function answer(p: { kind: string; options?: Array<{ id: string }> }): Record<string, unknown> {
  const o = (i: number) => p.options?.[i]?.id;
  switch (p.kind) {
    case "nominations": return { kind: p.kind, choice: [o(0), o(1)] };
    case "veto-decision": return { kind: p.kind, use: false };
    case "comp-intent": case "comp-round": return { kind: p.kind, intent: "compete" };
    case "goodbye-message": return { kind: p.kind, vote: "respectful" };
    default: return { kind: p.kind, vote: o(0) };
  }
}

describe("hour-by-hour house life in a played game (ORW-315)", () => {
  it("replaces the 7 stock scenes: every off-screen scene is a house-life action, many different kinds across a few days", async () => {
    const { life, offscreen } = await play("hl-a", 3, { messages: 360 });
    expect(life.length).toBeGreaterThan(20);
    const firstLife = offscreen.findIndex((e) => e.houseLife);
    expect(offscreen.slice(firstLife).every((e) => e.houseLife), "no stock-template scene once a person is playing (the pre-play premiere tick may still use the old one)").toBe(true);
    const kinds = new Set(life.map((e) => e.houseLife.action));
    expect(kinds.size, [...kinds].join(",")).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it("every scene is hidden (no player in it), happens where its people are, and nobody acts twice in one stretch", async () => {
    const { life } = await play("hl-b", 5, { messages: 240 });
    const byStretch = new Map<number, string[]>();
    for (const e of life) {
      expect(e.hidden).toBe(true);
      expect(e.witnessSet).not.toContain(PLAYER);
      expect(e.witnessSet).toContain(e.initiator);
      const list = byStretch.get(e.houseLife.stretch) ?? [];
      expect(list, `stretch ${e.houseLife.stretch}: ${e.initiator} acted twice`).not.toContain(e.initiator);
      list.push(e.initiator); byStretch.set(e.houseLife.stretch, list);
    }
  }, 120_000);

  it("goals cause scenes: a share of the scenes serve a goal (campaigns, pitches, begging, checking in)", async () => {
    const { life } = await play("hl-c", 7, { messages: 360 });
    const purposeful = life.filter((e) => ["campaign-against", "drive-a-wedge", "flip-a-vote", "frame", "pitch", "recruit", "check-in", "beg", "call-in-favor", "make-a-promise", "lobby-for", "count-votes", "split-roles", "fish", "test-a-rumor"].includes(e.houseLife.action));
    expect(purposeful.length, "the agenda drives part of house life").toBeGreaterThan(0);
  }, 120_000);

  it("a headless advance-only game keeps the old stretch (its seeded spine is byte-identical); the flag turns house life off", async () => {
    const headless = await play("hl-d", 3, { messages: 40, chat: false });
    expect(headless.life).toHaveLength(0);
    expect(headless.offscreen.length).toBeGreaterThan(0);
    const off = await play("hl-e", 3, { messages: 120, lifeOn: false });
    expect(off.life).toHaveLength(0);
  }, 120_000);
});
