import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import type { DaySummary } from "../../src/ports/GameSession";

// ORW-271 slice 1 - the append-only per-night day ledger + the recordDaySummary write-back. Roles only.

afterEach(() => { delete process.env.ORWELL_TIME_OF_DAY; delete process.env.ORWELL_DAY_CONDENSE; });

function rig(seed: number, played = true) {
  process.env.ORWELL_TIME_OF_DAY = "1";
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setPlayerKnowledgeReader(() =>
    sb.engine.knowledge.knownTo(PLAYER).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId, pathway: f.pathway })));
  session.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
  session.createCharacter({ playerName: "The Player", seed });
  if (played) session.noteMessage({ messageId: "m1" });
  return { session, sb };
}

/** Close a night: force the late clock so the bedtime gate admits the turnIn. */
function closeNight(session: GameSessionAdapter): void {
  const live = (session as unknown as { live: { timeOfDay: string } }).live;
  live.timeOfDay = "night";
  session.turnIn();
}

describe("ORW-271 - the floor ledger entry at turnIn", () => {
  it("pushes one day entry per closed night for a played game, no text yet", () => {
    const { session, sb } = rig(1);
    const teller = session.livingIds().find((id) => id !== PLAYER)!;
    sb.engine.knowledge.seedBelief(teller, { content: "a surfaced rumor", factId: "g1" }, "witnessed");
    sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: "a surfaced rumor" }, `told-by:${teller}`);
    closeNight(session);
    const l = session.dayLedger();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ day: 1, tier: "day" });
    expect(l[0]!.text).toBeUndefined();
    expect(l[0]!.themes).toContain("rumor");
    expect(l[0]!.events.length).toBeGreaterThan(0);
  });

  it("is empty for an unplayed (headless) game and with the flag off", () => {
    const a = rig(2, false); closeNight(a.session);
    expect(a.session.dayLedger()).toEqual([]);
    process.env.ORWELL_DAY_CONDENSE = "0";
    const b = rig(3); closeNight(b.session);
    expect(b.session.dayLedger()).toEqual([]);
  });

  it("round-trips through snapshot/restore", () => {
    const { session } = rig(4);
    closeNight(session);
    session.recordDaySummary({ day: 1, text: "A quiet night." });
    const before = session.dayLedger();
    expect(before).toHaveLength(1);
    const core = JSON.parse(JSON.stringify(session.snapshot()));
    const fresh = new GameSessionAdapter();
    fresh.restore(core);
    expect(fresh.dayLedger()).toEqual(before);
  });
});

describe("ORW-271 - recordDaySummary", () => {
  it("is idempotent per (day,tier), caps and strips text", () => {
    const { session } = rig(5);
    closeNight(session);
    expect(session.recordDaySummary({ day: 1, text: "first\u0007\n  text " + "x".repeat(2000) }).accepted).toBe(true);
    const t = session.dayLedger()[0]!.text!;
    expect(t.length).toBeLessThanOrEqual(900);
    expect(t).not.toMatch(/[\u0000-\u001f]/);
    session.recordDaySummary({ day: 1, text: "second" });
    expect(session.dayLedger()).toHaveLength(1);
    expect(session.dayLedger()[0]!.text).toBe(t);
  });

  it("refuses an unknown day, empty text, and a pre-game call", () => {
    const { session } = rig(6);
    closeNight(session);
    expect(session.recordDaySummary({ day: 99, text: "x" })).toEqual({ accepted: false, reason: "unknown-day" });
    expect(session.recordDaySummary({ day: 1, text: "  " })).toEqual({ accepted: false, reason: "empty" });
    expect(new GameSessionAdapter().recordDaySummary({ day: 1, text: "x" }).reason).toBe("absent");
  });

  it("a week entry marks its days merged, keeps them, and is idempotent", () => {
    const { session } = rig(7);
    closeNight(session); closeNight(session);
    expect(session.dayLedger().map((d) => d.day)).toEqual([1, 2]);
    const r = { day: 2, tier: "week" as const, coversDays: [1, 2] as [number, number], text: "The week." };
    expect(session.recordDaySummary(r).accepted).toBe(true);
    session.recordDaySummary(r);
    const l = session.dayLedger();
    expect(l).toHaveLength(3);
    expect(l.filter((d) => d.tier === "day").every((d) => d.merged === true)).toBe(true);
    expect(l.find((d) => d.tier === "week")).toMatchObject({ coversDays: [1, 2], text: "The week." });
  });
});

describe("ORW-271 - the Vault Wall", () => {
  it("no sealed sentinel or hidden content appears in the ledger JSON", () => {
    const { session, sb } = rig(8);
    for (let i = 0; i < 3; i++) session.advanceGame();
    closeNight(session);
    session.recordDaySummary({ day: 1, text: "A public summary." });
    const dump = JSON.stringify(session.dayLedger());
    expect(dump.length).toBeGreaterThan(10);
    for (const s of sb.sentinels) expect(dump).not.toContain(s);
    for (const h of sb.hiddenContents) expect(dump).not.toContain(h);
  });
});

describe("ORW-271 - the MCP boundary", () => {
  it("both tools are player tools and not model levers", () => {
    const names = PLAYER_TOOLS.map((t) => t.name);
    expect(names).toContain("recordDaySummary");
    expect(names).toContain("dayLedger");
    expect(PLAYER_AGENT_LEVERS).not.toContain("recordDaySummary");
    expect(PLAYER_AGENT_LEVERS).not.toContain("dayLedger");
  });

  it("dispatches recordDaySummary and dayLedger through McpServer.callTool, refusing malformed args", async () => {
    const { session, sb } = rig(9);
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    closeNight(session);
    const res = (await server.callTool("recordDaySummary", { day: 1, text: "Via the wire." })) as { accepted: boolean };
    expect(res.accepted).toBe(true);
    const l = (await server.callTool("dayLedger", {})) as DaySummary[];
    expect(l[0]!.text).toBe("Via the wire.");
    await expect(server.callTool("recordDaySummary", { day: "1", text: "x" })).rejects.toThrow(/day/);
    await expect(server.callTool("recordDaySummary", { day: 1, text: "x", tier: "month" })).rejects.toThrow(/tier/);
  });
});

describe("ORW-271 - seeded-sim byte-identity", () => {
  it("an unplayed headless run's snapshot is identical with the flag on and off", () => {
    const run = (flag: string) => {
      process.env.ORWELL_DAY_CONDENSE = flag;
      const { session } = rig(10, false);
      for (let i = 0; i < 4; i++) session.advanceGame();
      closeNight(session);
      return JSON.stringify(session.snapshot());
    };
    expect(run("1")).toBe(run("0"));
  });
});

describe("ORW-271 - played-game byte-identity and rng neutrality", () => {
  const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "dayLedger" ? undefined : x)));
  /** A played game over several nights: messages, turnIns, and beats AFTER each close (so any extra rng draw at the ledger would shift every later roll). */
  const play = (flag: string) => {
    process.env.ORWELL_DAY_CONDENSE = flag;
    const { session } = rig(21, true);
    const played = (session as unknown as { live: { playedGame?: boolean } }).live.playedGame;
    for (let night = 0; night < 3; night++) {
      session.noteMessage({ messageId: `n${night}` });
      for (let i = 0; i < 2; i++) session.advanceGame();
      closeNight(session);
    }
    for (let i = 0; i < 3; i++) session.advanceGame();
    return { played, snap: JSON.parse(JSON.stringify(session.snapshot())), ledger: session.dayLedger() };
  };

  it("with the flag on vs off, every snapshot field except dayLedger (all downstream seeded rolls) is identical in a PLAYED game", () => {
    const on = play("1");
    const off = play("0");
    expect(on.played).toBe(true);
    expect(on.ledger.length).toBeGreaterThan(0); // the control: the flag really did write entries
    expect(off.ledger).toEqual([]);
    expect(strip(on.snap)).toEqual(strip(off.snap));
  });

  it("the ledger consumes no rng: the next seeded draw after the closes is the same on and off", () => {
    const next = (flag: string) => {
      process.env.ORWELL_DAY_CONDENSE = flag;
      const { session } = rig(22, true);
      closeNight(session);
      session.recordDaySummary({ day: 1, text: "A summary." });
      // the game's per-moment seeded stream (keyed on game seed + state); a ledger that drew from any rng would shift this
      const rng = (session as unknown as { beatRng(): { next(): number } }).beatRng();
      return { has: true, v: rng.next(), snap: strip(session.snapshot()) };
    };
    const on = next("1");
    const off = next("0");
    expect(on.has).toBe(true);
    expect(on.v).toBe(off.v);
    expect(on.snap).toEqual(off.snap);
  });
});
