import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import type { Agenda, Goal } from "../../src/engine/agenda";
import type { StatedReasonRecord } from "../../src/engine/agendaDecisions";
import { validateReflection } from "../../src/engine/npcMindsAuthored";
import { buildSandbox } from "../support/sandbox";
import { playSeason } from "../support/agendaSeasonDriver";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-320 (ORW-253 slice 7, spec 0146 "the house you never saw"): the post-season retrospective carries, per houseguest, the real story - aim and why,
 * goals in order, the real reason beside what they said (lies marked), a long con, and nightly reflections. Sealed all season; complete for an early
 * evictee. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Live = { agendas?: Record<string, Agenda>; statedReasons?: StatedReasonRecord[]; evictionOrder: string[]; finished?: boolean; voteRecord?: Array<{ week: number; evictee: string }>; npcMindsAuthored?: { reflections?: Record<string, Array<{ night: number; text: string }>> } };
const live = (s: GameSessionAdapter): Live => (s as unknown as { live: Live }).live;
const COVER_LINE = "it is purely strategic, nothing personal";

function plant(s: GameSessionAdapter): { con: string; liar: string; early: string; mark: string } {
  const l = live(s);
  const ids = Object.keys(l.agendas!).sort();
  const early = l.evictionOrder[0]!;
  const con = ids.find((i) => i !== early)!;
  const mark = ids.find((i) => i !== early && i !== con)!;
  const goal: Goal = { id: `${con}:season:long-con:${mark}:d2`, owner: con, horizon: "season", kind: "long-con", target: mark, why: [{ kind: "threat-read", about: mark, weight: 1 }],
    test: { kind: "cut-later", who: mark, stage: "jury" }, commitment: 1, status: "achieved", formedDay: 2, formedWeek: 1, resolvedDay: 40, endNote: "cut at the jury" };
  l.agendas![con]!.history.push(goal);
  (l.statedReasons ??= []).push({ week: 2, day: 9, decider: con, decision: "nominate", public: true,
    real: { decision: "nominate", decider: con, choice: mark, goalKind: "long-con", goalId: goal.id, terms: [{ name: "threat", value: 0.7 }], tactic: "direct" },
    stated: { kind: "nothing-personal", about: mark, candor: "cover" } });
  return { con, liar: con, early, mark };
}

describe("ORW-320: the house you never saw", () => {
  it("(a) sealed while the season is live: no retrospective, and the post-crown write-back stores nothing", () => {
    const s = playSeason(3, { stopAtWeek: 2 }).s;
    expect(live(s).finished).not.toBe(true);
    expect(s.seasonRetrospective()).toBeNull();
    const r = s.recordNpcReflections({ reflections: [{ id: Object.keys(live(s).agendas!)[0]! as never, night: 1, reflection: "A quiet night." }] });
    expect(r).toEqual({ accepted: 0, rejected: 1, reason: "not-finished" });
    expect(live(s).npcMindsAuthored?.reflections).toBeUndefined();
  }, 300_000);

  it("(b)+(c) after the crown: a planted long con, a cover-story reason with the lie marked, a reflection, and the week-2 evictee's full story", () => {
    const { s, finished } = playSeason(3);
    expect(finished).toBe(true);
    const { con, early, mark } = plant(s);
    const before = s.seasonRetrospective()!.houseYouNeverSaw!;
    expect(before.length).toBeGreaterThan(5);
    const mine = before.find((h) => h.houseguest.id === con)!;
    expect(mine.longCon).toMatchObject({ mark: expect.any(String), ended: expect.stringContaining("it worked on day 40") });
    expect(mine.longCon!.plan).toContain("cut after the jury starts");
    const lie = mine.decisions.find((d) => d.honesty === "lie" && d.week === 2 && d.day === 9 && d.said.includes(COVER_LINE))!;
    expect(lie.said).toContain(COVER_LINE);
    expect(lie.aired).toBe(true);
    expect(lie.real).toContain("their goal to keep");
    expect(lie.real).toContain("they saw them as a threat");
    expect(lie.act).toContain("nominated");
    expect(mine.goals.length).toBeGreaterThan(0);
    // the early evictee keeps their whole agenda: nothing trimmed
    const ag = live(s).agendas![early]!;
    const e = before.find((h) => h.houseguest.id === early)!;
    expect(e.goals).toHaveLength(ag.history.length + ag.goals.length);
    expect(e.leftWeek).toBeDefined();
    expect(e.leftWeek!).toBeLessThanOrEqual(3);
    expect(e.seasonAim).toBeDefined();
    // reflections: accepted only for a night the story moved, write-once, validated
    const night = mine.reflectionNights[0]!;
    const res = s.recordNpcReflections({ reflections: [
      { id: con as never, night, reflection: "I smiled at them all day and counted the days to the jury." },
      { id: con as never, night, reflection: "A second try must not replace the first." },
      { id: con as never, night: 9999, reflection: "Not a night I have a story for." },
      { id: PLAYER, night, reflection: "The player has no stored mind." },
      { id: con as never, night: mine.reflectionNights[1] ?? night + 1, reflection: `${mark} was npc:7 in my head` },
    ] });
    expect(res.accepted).toBe(1);
    expect(res.rejected).toBe(4);
    const after = s.seasonRetrospective()!.houseYouNeverSaw!.find((h) => h.houseguest.id === con)!;
    expect(after.reflections).toEqual([{ night, text: "I smiled at them all day and counted the days to the jury." }]);
    // names and days only: no raw engine ids, no weights
    const json = JSON.stringify(s.seasonRetrospective()!.houseYouNeverSaw, (k, v) => (k === "id" ? undefined : v)); // the NamedRef id is the one sanctioned id (the FE write-back addresses it)
    expect(json).not.toMatch(/npc:\d+/);
    expect(json).not.toMatch(/weight|commitment/);
  }, 600_000);

  it("the debug dump never carries the readable story, only the raw agenda rows", () => {
    const { s } = playSeason(3, { stopAtWeek: 1 });
    const dump = s.producerVaultDump()!;
    expect((dump as unknown as { houseYouNeverSaw?: unknown }).houseYouNeverSaw).toBeUndefined();
  }, 300_000);

  it("validateReflection: first-person prose <= 60 words, no engine id", () => {
    expect(validateReflection("I kept my head down.")).toBe("I kept my head down.");
    expect(validateReflection(Array(61).fill("word").join(" "))).toBeUndefined();
    expect(validateReflection("npc:3 knows")).toBeUndefined();
    expect(validateReflection(7)).toBeUndefined();
  });
});

describe("ORW-320: the four-place wiring (boundary through McpServer.callTool)", () => {
  it("is player-channel infra (not a model lever) and dispatches; mid-season it is refused with bare counts", async () => {
    const names = PLAYER_TOOLS.map((t) => t.name);
    expect(names).toContain("recordNpcReflections");
    expect(PLAYER_AGENT_LEVERS).not.toContain("recordNpcReflections");
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands: new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge), session });
    session.createCharacter({ playerName: "The Player", seed: 9 });
    const npcs = session.livingIds().filter((i) => i !== PLAYER);
    const res = await server.callTool("recordNpcReflections", { reflections: [{ id: npcs[0], night: 1, reflection: "A quiet night." }] });
    expect(res).toEqual({ accepted: 0, rejected: 1, reason: "not-finished" });
    await expect(server.callTool("recordNpcReflections", { reflections: "x" })).rejects.toThrow();
    await expect(server.callTool("recordNpcReflections", { reflections: [{ id: npcs[0] }] })).rejects.toThrow();
  });
});
