import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { diaryWalkOrder, walkersForPress } from "../../src/engine/voteBeat";
import { renderVoteBeatBlock } from "../../src/engine/momentPrompts";

/**
 * ORW-771 (owner-ruled): a Continue press through the eviction VOTE gets a short narrated beat, sealed like the real show. The engine hands the narrator third-person FACTS per press
 * (`eviction.voteBeat`): who walks into the Diary Room, who comes back, the room, and on the result press that the tally is read with names. E12: it names no ballot content, and
 * the walk order is independent of the seeded ballot reveal order. Real path: a played season driven by the engine's own advance/decision calls to the eviction vote, then pressed
 * ONE STEP AT A TIME exactly as the Continue button does. Roles only; no state is set by hand.
 */
type Any = Record<string, any>;
afterEach(() => { GameSessionAdapter.setTimeOfDayEnabled(null); });

function driveToBallots(seed: number, flagOn: boolean): { s: Any; views: Any[] } {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orw771-")))).sandboxFor("u").session as unknown as Any;
  s.setVoteBeatEnabled(flagOn);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  for (let i = 0; i < 900; i++) {
    if (s.live.pending?.kind === "eviction-vote") break;
    const p = s.advanceGame().pending ?? s.live.pending;
    if (!p) continue;
    if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
    else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
    else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0].id });
    else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
    else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0].id });
    else if (p.kind === "eviction-vote") break;
  }
  expect(s.live.pending?.kind, "the season reached the player's own vote card").toBe("eviction-vote");
  const views: Any[] = [];
  for (let i = 0; i < 60; i++) {
    const p = s.live.pending as Any | undefined;
    if (p && p.kind !== "ceremony-step") {
      if (p.kind === "eviction-vote") { views.push(s.submitDecision({ kind: "eviction-vote", vote: s.live.nominees[0] })); continue; } // the player's own card: their own act, and its press reads the first ballot
      break;
    }
    const v = s.advanceGame();
    views.push(v);
    if (v.event?.beat === "eviction") break;
  }
  return { s, views };
}

describe("ORW-771: the sealed vote beat on each Continue press through a played eviction vote", () => {
  it("every ballot press carries the beat fact (sealed, a walker per press), the result press says the tally is read with names, and no ballot content is in it", () => {
    const { s, views } = driveToBallots(5, true);
    const ballots = views.filter((v) => v.event?.beat === "eviction-reveal");
    const result = views.find((v) => v.event?.beat === "eviction");
    expect(ballots.length).toBeGreaterThan(3);
    expect(result).toBeDefined();
    for (const v of ballots) {
      const b = v.eviction?.voteBeat;
      expect(b, "the beat fact is present on every ballot press").toBeDefined();
      expect(b.sealed).toBe(true);
      expect(b.tallyRead).toBe(false);
      expect(Object.keys(b).sort()).toEqual(expect.arrayContaining(["gathered", "nominees", "of", "press", "sealed", "tallyRead"]));
      // E12: no key or text of the beat can carry a ballot (a vote target, a voter's choice, a count) - only these public fields exist
      expect(Object.keys(b).every((k) => ["sealed", "press", "of", "intoDiaryRoom", "backFromDiaryRoom", "tallyRead", "gathered", "timeOfDay", "nominees"].includes(k))).toBe(true);
      expect(JSON.stringify(b)).not.toMatch(/votedFor|vote|ballot|count|tally\b/i);
    }
    expect(ballots[0].eviction.voteBeat.intoDiaryRoom).toBeDefined();
    expect(ballots[0].eviction.voteBeat.backFromDiaryRoom).toBeUndefined(); // nobody has come back yet on the first press
    expect(ballots[1].eviction.voteBeat.backFromDiaryRoom?.id).toBe(ballots[0].eviction.voteBeat.intoDiaryRoom.id);
    // the walkers are never the player (the engine never walks for the player)
    for (const v of ballots) expect(v.eviction.voteBeat.intoDiaryRoom?.id).not.toBe(PLAYER);
    // E12: the walk order is NOT the ballot reveal order (so naming a walker names no ballot's caster)
    const revealOrder: string[] = s.live.eviction.revealOrder.filter((id: string) => id !== PLAYER);
    const walked = ballots.map((v) => v.eviction.voteBeat.intoDiaryRoom?.id).filter(Boolean);
    expect(walked).not.toEqual(revealOrder.slice(0, walked.length));
    // the result press: the tally is read with names
    const rb = result!.eviction?.voteBeat;
    expect(rb?.tallyRead).toBe(true);
    expect(rb?.sealed).toBe(true);
  });

  it("flag off: no beat fact on any press (the banner-only press, byte for byte)", () => {
    const { views } = driveToBallots(5, false);
    expect(views.length).toBeGreaterThan(3);
    for (const v of views) expect(v.eviction?.voteBeat).toBeUndefined();
  });

  it("adds no clock to a press: the eviction night's budget is the same with the beat on or off (ORW-262)", () => {
    const on = driveToBallots(5, true), off = driveToBallots(5, false);
    expect(on.s.live.nightDepth).toBe(off.s.live.nightDepth);
    expect(on.views.length).toBe(off.views.length);
  });

  it("the walk order reads only the week and the voter ids (independent of ballots and the reveal order), and the rendered block names no ballot", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    expect(diaryWalkOrder(ids, 3)).toEqual(diaryWalkOrder([...ids].reverse(), 3));
    expect(walkersForPress(diaryWalkOrder(ids, 3), 1).back).toBeUndefined();
    expect(walkersForPress(diaryWalkOrder(ids, 3), 7)).toEqual({ back: diaryWalkOrder(ids, 3)[5] });
    const block = renderVoteBeatBlock({ eviction: { stage: "votes", nominees: [], votesRevealed: [], voteBeat: { sealed: true, press: 2, of: 6, intoDiaryRoom: { id: "x", name: "Role Two" }, backFromDiaryRoom: { id: "y", name: "Role One" }, tallyRead: false, gathered: 14, timeOfDay: "evening", nominees: [{ id: "n1", name: "Nominee One" }, { id: "n2", name: "Nominee Two" }] } } } as any).join("\n");
    expect(block).toMatch(/SEALED/);
    expect(block).toMatch(/Role Two walks into the Diary Room/);
    expect(block).not.toMatch(/e\.g\.|for example|such as/i);
  });
});
