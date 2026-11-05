import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { deriveNpcKnowledge } from "../../src/engine/diaryRoom";
import { resolvePending } from "../support/adr0003";
import { APPROACH_GATE } from "../../src/engine/decisionConstants";
import { PLAYER } from "../../src/domain/ids";

// Feature 0036: the two built-but-unwired social capabilities are now live player tools.
// We drive them through the actual MCP player channel (the live tool path).

const sandboxWithGame = (seed = 11, user = "user-a") => {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "Player", seed });
  return sb;
};

/** Advance the live loop until the first ceremony beat (the week-1 HOH result) commits. */
const advancePastFirstHoh = (sb: ReturnType<GameSessionRegistry["sandboxFor"]>): void => {
  for (let i = 0; i < 60; i++) {
    if (sb.session.snapshot().live?.hoh !== undefined) return;
    const v = sb.session.advanceGame();
    if (v.pending) resolvePending(sb.session, v.pending);
  }
  throw new Error("the week-1 HOH never resolved");
};

describe("0036 — socialInitiatives (NPC-initiated approaches)", () => {
  it("returns houseguests who want to approach the player — names + a coarse motive only (E60)", async () => {
    const sb = sandboxWithGame();
    advancePastFirstHoh(sb); // E89: approaches only exist once the house is actually playing
    const out = (await sb.mcp.player.callTool("socialInitiatives")) as Array<{ houseguest: { id: string; name: string }; motive: string }>;

    expect(out.length).toBeGreaterThan(0); // the house reaches out — scenes are bidirectional
    for (const it of out) {
      expect(typeof it.houseguest.name).toBe("string");
      expect(it.houseguest.name.length).toBeGreaterThan(0);
      // ADR 0003: the engine hands the GM the categorical FACT to voice, never a canned line.
      expect(["bond", "probe"]).toContain(it.motive);
    }
    // The canned pretext is gone — no scripted sentence ships in the projection.
    expect(JSON.stringify(out)).not.toContain("wants a word");
  });

  it("never leaks the hidden drive (no trust/threat number crosses the wall)", async () => {
    const sb = sandboxWithGame();
    advancePastFirstHoh(sb);
    const out = (await sb.mcp.player.callTool("socialInitiatives")) as unknown[];
    expect(out.length).toBeGreaterThan(0); // a non-empty projection, so the sweep below means something
    // The Approach.drive (a relationship-derived number) must not appear in the projected shape.
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/drive/i);
    expect(json).not.toMatch(/trust|affinity|threat/i);
  });

  it("is empty before a game starts", async () => {
    const reg = new GameSessionRegistry();
    const out = await reg.sandboxFor("nobody").mcp.player.callTool("socialInitiatives");
    expect(out).toEqual([]);
  });
});

describe("E89 (ruling #5) — no approach fires at the very start of the game", () => {
  it("the gate is a constants-module switch, not an inline literal", () => {
    expect(APPROACH_GATE.requireFirstCeremonyBeat).toBe(true);
  });

  it("a fresh game pre-first-HOH ⇒ empty across seeds; post-HOH ⇒ approaches resume", async () => {
    for (const seed of [1, 7, 11, 23, 42, 99, 123, 2024]) {
      const sb = sandboxWithGame(seed, `user-${seed}`);
      // Move-in, before any ceremony beat resolves: the house stays quiet.
      const before = (await sb.mcp.player.callTool("socialInitiatives")) as unknown[];
      expect(before).toEqual([]);
      // Once the week-1 HOH result commits, approaches resume.
      advancePastFirstHoh(sb);
      const after = (await sb.mcp.player.callTool("socialInitiatives")) as unknown[];
      expect(after.length).toBeGreaterThan(0);
    }
  });

  it("the gate stays open for the rest of the season (rollWeek clearing the HOH cannot re-mute the house)", async () => {
    const sb = sandboxWithGame(5, "user-rollweek");
    // Drive past the first eviction so rollWeek has cleared the week's ceremony state.
    for (let i = 0; i < 300; i++) {
      const v = sb.session.advanceGame();
      if (v.pending) resolvePending(sb.session, v.pending);
      if (v.event?.beat === "eviction-result") break;
    }
    const snap = sb.session.snapshot();
    expect(snap.live!.evictionOrder.length).toBeGreaterThan(0); // a week genuinely rolled
    const out = (await sb.mcp.player.callTool("socialInitiatives")) as unknown[];
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("0036 — diaryRoom (the player's OOC channel, walled from NPCs)", () => {
  it("records the entry as the player's own knowledge", async () => {
    const sb = sandboxWithGame();
    const res = await sb.mcp.player.callTool("diaryRoom", { entry: "I am quietly targeting the HOH" });
    expect(res).toMatchObject({ recorded: true }); // A29: a committing tool also echoes the post-commit beatSeq

    const known = sb.player.getVisibleState().knowledge.map((k) => k.content);
    expect(known).toContain("I am quietly targeting the HOH");
  });

  it("no houseguest can ever learn the Diary-Room content", async () => {
    const sb = sandboxWithGame();
    const SECRET = "DR_SECRET_no_npc_may_know";
    await sb.mcp.player.callTool("diaryRoom", { entry: SECRET });

    // 1) The recorded DR event witnesses the PLAYER alone — no NPC was present.
    const drEvent = sb.engine.events.queryAll().find((e) => e.type === "diary-room");
    expect(drEvent).toBeDefined();
    expect(drEvent!.witnessSet).toEqual([PLAYER]);

    // 2) Even if the DR fact were offered to NPC-knowledge derivation, the wall drops it (0013).
    const drFact = sb.player.getVisibleState().knowledge.find((k) => k.content === SECRET);
    expect(drFact).toBeDefined();
    expect(deriveNpcKnowledge([drFact!])).toEqual([]);
  });
});
