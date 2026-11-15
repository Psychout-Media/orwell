import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { buildSystemPrompt, MOMENT_PROMPTS } from "../../src/engine/momentPrompts";
import { DAY_SCHEDULE, MILESTONE_LABEL, nextMilestone, milestoneDue, todaysEvent, beatFeltHours } from "../../src/engine/daySchedule";
import { nightBreakPending, vetoDrawStage } from "../../src/engine/liveSeason";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { GameStateView } from "../../src/ports/GameSession";

/**
 * ORW-281 slice 1 (Ryne: comps and ceremonies are built the same way under the hood; the VETO DRAW is a mini ceremony). The draw is its OWN milestone / ceremony beat: scheduled (morning), labelled,
 * ceremony-length on the clock, gathered like a ceremony, with its own narrator moment and commit gate. The structural beat stays `veto-competition` (the draw is its first stage, so the seeded stream
 * is untouched). Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

const live = (extra: Record<string, unknown> = {}): LiveSeasonState =>
  ({ beat: "veto-competition", timeOfDay: "morning", nightDepth: 9, week: 2, preHohNightPassed: true, preNomsNightPassed: true, preVetoNightPassed: true, preVetoCeremonyNightPassed: true, preEvictionNightPassed: true, ...extra } as unknown as LiveSeasonState);

describe("the schedule knows the draw", () => {
  it("is its own milestone: morning slot, a label, a ceremony-length clock cost", () => {
    expect(DAY_SCHEDULE["veto-draw"]).toBe("morning");
    expect(MILESTONE_LABEL["veto-draw"]).toMatch(/draw/i);
    expect(beatFeltHours("veto-draw")).toBe(beatFeltHours("nominations")); // ceremony hours, not the flat default
  });
  it("nextMilestone is the draw until the field exists, then the competition (afternoon)", () => {
    expect(nextMilestone(live())!.beat).toBe("veto-draw");
    expect(nextMilestone(live())!.phase).toBe("morning");
    expect(nextMilestone(live({ vetoField: ["a"] }))!.beat).toBe("veto-competition");
    expect(nextMilestone(live({ vetoField: ["a"] }))!.phase).toBe("afternoon");
  });
  it("the draw's night gate is the same one-shot flag, expressed through ONE helper (no loose !vetoField)", () => {
    expect(vetoDrawStage(live())).toBe(true);
    expect(vetoDrawStage(live({ vetoField: ["a"] }))).toBe(false);
    expect(vetoDrawStage(live({ beat: "nominations" }))).toBe(false);
    expect(nightBreakPending(live({ preVetoNightPassed: false }))).toBe(true);
    expect(nightBreakPending(live({ preVetoNightPassed: false, vetoField: ["a"] }))).toBe(false);
  });
  it("Ryne: the draw (morning) and the competition (afternoon) are NOT tied - once the field is drawn the competition is not due until its own afternoon slot, leaving the hours between for campaigning to the drawn players", () => {
    expect(milestoneDue(live({ nightDepth: 8 }))).toBe(true); // the draw, morning
    expect(milestoneDue(live({ nightDepth: 9, vetoField: ["a"] }))).toBe(false); // an hour after the draw: the comp waits
    expect(milestoneDue(live({ nightDepth: 12, vetoField: ["a"] }))).toBe(true); // the afternoon: the competition, reading only the drawn field
  });
  it("while the night before the draw is pending, today's event is the nominations", () => {
    expect(todaysEvent(live({ preVetoNightPassed: false, nightDepth: 20, timeOfDay: "night", playedGame: true }))).toBe("nominations");
  });
});

describe("the draw has its own moment and commit gate", () => {
  const base = (): GameStateView => new GameSessionAdapter().createCharacter({ playerName: "P", seed: 11 });
  const six = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `npc:${n}`, name: `P${n}` }));
  const withCeremony = (players: typeof six): GameStateView =>
    ({ ...base(), phase: "veto-competition", pending: null, ceremony: { hoh: null, nominees: [], veto: { holder: null, used: false, players } } } as GameStateView);
  it("the draw ritual lives in the veto-draw fragment, not the competition's", () => {
    expect(MOMENT_PROMPTS["veto-draw"]).toContain("VOICE THE CHIP DRAW AS ITS OWN RITUAL BEAT");
    expect(MOMENT_PROMPTS["veto-competition"]).not.toContain("VOICE THE CHIP DRAW AS ITS OWN RITUAL BEAT");
  });
  it("no draw yet: the script is replaced by a has-NOT-happened note", () => {
    const p = buildSystemPrompt("veto-draw", withCeremony([]));
    expect(p).not.toContain("VOICE THE CHIP DRAW AS ITS OWN RITUAL BEAT");
    expect(p).toMatch(/veto draw has NOT happened/);
    expect(p).toMatch(/call advanceGame/i);
  });
  it("drawn: the draw script is delivered", () => {
    expect(buildSystemPrompt("veto-draw", withCeremony(six))).toContain("VOICE THE CHIP DRAW AS ITS OWN RITUAL BEAT");
  });
  it("the competition moment, once drawn and undecided, still refuses to name a winner", () => {
    expect(buildSystemPrompt("veto-competition", withCeremony(six))).toMatch(/winner has NOT been decided/);
  });
});

describe("the live view: moment and gathering follow the draw", () => {
  type Internals = { live: { beat: string; vetoField?: string[]; pending?: unknown } };
  type Adv = { advanceView(ev: { beat: string; content: string; participants: string[] } | null): unknown };
  function setup() {
    GameSessionAdapter.setTimeOfDayEnabled(false);
    const sb = new GameSessionRegistry().sandboxFor(`veto-draw-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 21 });
    sb.session.advanceGame();
    return { sb, s: sb.session as unknown as Internals };
  }
  it("the moment is veto-draw until the draw has run AND been voiced, then the competition", () => {
    const { sb, s } = setup();
    s.live.beat = "veto-competition";
    expect(sb.session.getGameState().moment).toBe("veto-draw");
    s.live.vetoField = [PLAYER];
    sb.session.noteMessage({ messageId: "p1" });
    (sb.session as unknown as Adv).advanceView({ beat: "veto-draw", content: "x", participants: [] });
    expect(sb.session.getGameState().moment).toBe("veto-draw"); // the resolved draw is the live scene until the player speaks
    sb.session.noteMessage({ messageId: "p2" });
    expect(sb.session.getGameState().moment).not.toBe("veto-draw"); // (the fixture still sits in the premiere phase, so the competition key itself is covered by the pure cases above)
  });
  it("a resolved draw gathers the house like a ceremony; the Houseguest's Choice card is the DRAW, not the veto ceremony", () => {
    const { sb, s } = setup();
    s.live.beat = "veto-competition";
    s.live.pending = null;
    sb.session.noteMessage({ messageId: "p1" });
    (sb.session as unknown as Adv).advanceView({ beat: "veto-draw", content: "x", participants: [] });
    const w = sb.session.whereabouts()!;
    expect(w.houseEvent?.kind).toBe("veto-draw");
    expect(w.room).toBe("living-room");
    s.live.pending = { kind: "houseguests-choice" };
    sb.session.noteMessage({ messageId: "p2" });
    expect(sb.session.whereabouts()!.houseEvent?.kind).toBe("veto-draw");
  });
});
