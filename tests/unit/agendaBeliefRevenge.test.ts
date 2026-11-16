import { describe, expect, it } from "vitest";
import { recheckAgenda, seedAgenda, type AgendaBoard, type AgendaView } from "../../src/engine/agenda";

/** 0150 / ORW-330 slice 2 - a believed grievance forms a revenge goal with the belief as its reason; never a second revenge on someone a grudge already made one on. Roles only. */
const OWNER = "npc:o", ACCUSED = "npc:a", OTHER = "npc:x";
const board: AgendaBoard = { day: 3, week: 1, inHouse: [OWNER, ACCUSED, OTHER, "player"], evicted: [], juryStarted: false, finalFive: false, nominees: [], weekClosed: false };
const view = (over: Partial<AgendaView> = {}): AgendaView => ({
  owner: OWNER, character: { archetype: "analyst", strategyStyle: "social", secretKinds: [] },
  threats: [ACCUSED, OTHER].map((toward) => ({ toward, threat: 0.3 })), affinity: [ACCUSED, OTHER].map((toward) => ({ toward, affinity: 0.4 })),
  grudges: [], emotional: 0.5, allianceMates: [], secretExposed: false, openQuestions: [], answered: [], powerWins: 0, ...over,
});

describe("0150: believed grievances and goals", () => {
  it("a believed grievance becomes a revenge goal whose reason is the belief", () => {
    const a = recheckAgenda(seedAgenda(view(), board, 7), view({ believedGrievances: [{ toward: ACCUSED, strength: 0.7, ref: "voted-against-me" }] }), board, "week-start", 7);
    const r = a.goals.filter((g) => g.kind === "revenge" && g.target === ACCUSED);
    expect(r).toHaveLength(1);
    expect(r[0]!.why[0]).toMatchObject({ kind: "belief", about: ACCUSED, ref: "voted-against-me" });
  });

  it("without the belief no revenge forms, and a remembered grudge on the same person is not doubled", () => {
    const none = recheckAgenda(seedAgenda(view(), board, 7), view(), board, "week-start", 7);
    expect(none.goals.filter((g) => g.kind === "revenge")).toEqual([]);
    const both = recheckAgenda(seedAgenda(view(), board, 7), view({ grudges: [{ toward: ACCUSED, salience: 0.9, ref: "betrayed" }], believedGrievances: [{ toward: ACCUSED, strength: 0.7, ref: "voted-against-me" }] }), board, "week-start", 7);
    const r = both.goals.filter((g) => g.kind === "revenge" && g.target === ACCUSED);
    expect(r).toHaveLength(1);
    expect(r[0]!.why[0]!.kind).toBe("memory");
  });
});
