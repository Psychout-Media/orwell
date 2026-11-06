import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession, DailyRecapView } from "../../src/ports/GameSession";

/**
 * 0102 (PO review 2026-06-27 redesign, #884) — the DAILY "day in review" recap, fired at the
 * player's own bedtime (`turnIn`, ADR 0006), replacing the originally-drafted weekly recap. Roles
 * only — no names. Wires a live `GameSessionAdapter` with the SAME provider seams
 * `composition/registry.ts` wires (mirroring `tests/unit/secretPowerBoundary.test.ts`'s pattern),
 * backed by a `buildSandbox` event/knowledge store, so witnessed ceremony beats and surfaced
 * gossip actually land where `materializeDailyRecap` reads them.
 */

afterEach(() => { delete process.env.ORWELL_TIME_OF_DAY; });

/** Resolve any pending decision legally, so the live loop always progresses. */
function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id });
}

/** Wire a live session the same way registry.ts does (the seams `materializeDailyRecap` reads). */
function liveSession(seed: number): { session: GameSessionAdapter; sb: ReturnType<typeof buildSandbox> } {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setPlayerKnowledgeReader(() =>
    sb.engine.knowledge.knownTo(PLAYER).map((f) => ({
      id: f.id, content: f.content, subject: f.subject, factId: f.factId, pathway: f.pathway,
    })),
  );
  session.setRecordProviders({
    events: () => sb.engine.events.queryAll(),
    hidden: () => sb.engine.vault.readHidden(),
  });
  session.setOnEvent((ev) => sb.engine.events.record({
    id: `season:${sb.engine.events.count()}`,
    ts: sb.engine.events.count(),
    type: "house-event",
    initiator: ev.participants[0] ?? PLAYER,
    witnessSet: [PLAYER, ...ev.participants.filter((p) => p !== PLAYER)],
    hidden: false,
    content: ev.content,
  }));
  return { session, sb };
}

function started(seed: number): { session: GameSessionAdapter; sb: ReturnType<typeof buildSandbox> } {
  const rig = liveSession(seed);
  rig.session.createCharacter({ playerName: "The Player", seed });
  return rig;
}

/** Anchor a fresh belief on some living NPC and surface it to the player through a real pathway. */
function surfaceGossipToPlayer(session: GameSessionAdapter, sb: ReturnType<typeof buildSandbox>, content: string): void {
  const teller = session.livingIds().find((id) => id !== PLAYER)!;
  sb.engine.knowledge.seedBelief(teller, { content, factId: `gossip:${content}` }, "witnessed");
  sb.engine.knowledge.surfaceInformationTo(PLAYER, { content }, `told-by:${teller}`);
}

describe("0102 — the daily recap is dormant unless the clock is running", () => {
  it("turnIn carries no dailyRecap, and dailyRecap() reads null, when ORWELL_TIME_OF_DAY is off", () => {
    process.env.ORWELL_TIME_OF_DAY = "0"; // explicit OFF (default flip 2026-11-03)
    const { session } = started(101);
    const v = session.turnIn();
    expect(v.dailyRecap).toBeUndefined();
    expect(session.dailyRecap()).toBeNull();
  });
});

describe("0102 — dailyRecap is advertised and dispatches through McpServer.callTool", () => {
  it("is a registered player tool and a real model lever (not FE-only infra)", () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("dailyRecap");
    expect(PLAYER_AGENT_LEVERS).toContain("dailyRecap");
  });

  it("dispatches through the MCP boundary and returns null before any day has closed", async () => {
    const { session, sb } = started(10); // ORWELL_TIME_OF_DAY unset — still a valid, dispatchable read
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    const res = (await server.callTool("dailyRecap", {})) as DailyRecapView | null;
    expect(res).toBeNull();
  });

  it("dispatches and returns the just-materialized recap after a real turnIn", async () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const { session, sb } = started(11);
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    const v = session.turnIn();
    const res = (await server.callTool("dailyRecap", {})) as DailyRecapView | null;
    expect(res).toEqual(v.dailyRecap);
  });
});

describe("0102 — the recap is stitched from witnessed + already-surfaced material only", () => {
  it("turnIn's result carries a dailyRecap for day 1 with witnessed highlights and surfaced gossip", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const { session } = started(1);
    for (let i = 0; i < 3; i++) { const a = session.advanceGame(); if (a.pending) resolveLegally(session, a.pending); }
    const v = session.turnIn();
    expect(v.dailyRecap).toBeDefined();
    expect(v.dailyRecap!.day).toBe(2); // ORW-116: Day 1 is the premiere + first night; the first HOH is Day 2's afternoon
    expect(Array.isArray(v.dailyRecap!.highlights)).toBe(true);
    expect(v.dailyRecap!.highlights.length).toBeGreaterThan(0); // real weekly-loop beats happened
  });

  it("already-surfaced gossip appears; a rumor still diffusing in the hidden layer never does", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const { session, sb } = started(2);
    const SURFACED = "a surfaced rumor the player was actually told";
    const UNSURFACED = "an un-surfaced rumor still diffusing off-screen";
    surfaceGossipToPlayer(session, sb, SURFACED);
    // A belief seeded on an NPC but NEVER surfaced to the player — must never appear.
    const otherNpc = session.livingIds().find((id) => id !== PLAYER)!;
    sb.engine.knowledge.seedBelief(otherNpc, { content: UNSURFACED, factId: "never-surfaced" }, "witnessed");
    const v = session.turnIn();
    expect(v.dailyRecap!.surfaced).toContain(SURFACED);
    expect(v.dailyRecap!.surfaced.join(" ")).not.toContain(UNSURFACED);
    expect(JSON.stringify(v.dailyRecap)).not.toContain(UNSURFACED);
  });

  it("excludes the player's own OOC Diary Room (no in-game pathway to any houseguest)", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const { session, sb } = started(3);
    const DR_CONTENT = "a private diary-room confession";
    sb.engine.knowledge.recordDiaryRoom(DR_CONTENT);
    const v = session.turnIn();
    expect(v.dailyRecap!.surfaced.join(" ")).not.toContain(DR_CONTENT);
  });
});

describe("0102 — the Vault Wall holds for the recap and its hook", () => {
  it("no sealed Vault sentinel ever appears in the recap, on the player or admin surface", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const { session, sb } = started(4);
    for (let i = 0; i < 3; i++) { const a = session.advanceGame(); if (a.pending) resolveLegally(session, a.pending); }
    surfaceGossipToPlayer(session, sb, "an ordinary surfaced fact");
    const v = session.turnIn();
    const dump = JSON.stringify(v.dailyRecap) + JSON.stringify(session.dailyRecap());
    for (const sentinel of sb.sentinels) expect(dump).not.toContain(sentinel);
    for (const hidden of sb.hiddenContents) expect(dump).not.toContain(hidden);
  });
});

describe("0102 — the cliffhanger teases an in-motion thread but commits to no outcome", () => {
  it("a quiet turn with no in-motion thread closes with no fabricated hook", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const { session } = started(5);
    const v = session.turnIn(); // nothing surfaced, no deal under strain
    expect(v.dailyRecap).toBeDefined();
    expect(v.dailyRecap!.hook).toBeUndefined();
  });

  it("a hook, when present, never asserts a future result", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const { session, sb } = started(6);
    surfaceGossipToPlayer(session, sb, "something worth watching");
    const v = session.turnIn();
    expect(v.dailyRecap!.hook).toBeDefined();
    const framing = v.dailyRecap!.hook!.framing.toLowerCase();
    for (const banned of ["wins hoh", "will win", "evicted", "goes home", "nominated", "will be"]) {
      expect(framing).not.toContain(banned);
    }
    // The hook's internal `thread` id is engine bookkeeping only — never a player-facing secret string.
    expect(typeof v.dailyRecap!.hook!.thread).toBe("string");
  });
});

describe("0102 — the recap augments play and is reproducible", () => {
  it("progresses no game state: week/phase/ceremony are unchanged by materializing the recap", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const { session } = started(7);
    for (let i = 0; i < 2; i++) { const a = session.advanceGame(); if (a.pending) resolveLegally(session, a.pending); }
    const before = session.gameStatus();
    session.turnIn();
    const after = session.gameStatus();
    expect(after.week).toBe(before.week);
    expect(after.hoh).toEqual(before.hoh);
    expect(after.nominees).toEqual(before.nominees);
  });

  it("re-reading dailyRecap() after turnIn reproduces the exact same materialized digest", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const { session, sb } = started(8);
    surfaceGossipToPlayer(session, sb, "a fact worth recalling");
    const v = session.turnIn();
    const reread = session.dailyRecap();
    expect(reread).toEqual(v.dailyRecap);
    // A second read is stable too (no re-computation drift).
    expect(session.dailyRecap()).toEqual(reread);
  });

  it("day advances and the next day's recap never repeats the prior day's content", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const { session, sb } = started(9);
    surfaceGossipToPlayer(session, sb, "day one's fact");
    const day1 = session.turnIn().dailyRecap!;
    expect(day1.day).toBe(1);
    surfaceGossipToPlayer(session, sb, "day two's fact");
    const day2 = session.turnIn().dailyRecap!;
    expect(day2.day).toBe(2);
    expect(day2.surfaced.join(" ")).not.toContain("day one's fact");
    expect(day2.surfaced.join(" ")).toContain("day two's fact");
  });
});
