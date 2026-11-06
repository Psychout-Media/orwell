import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { renderGameContext } from "../../src/engine/momentPrompts";
import {
  DAY_SCHEDULE, MILESTONE_LABEL, nextMilestone, milestoneDue,
} from "../../src/engine/daySchedule";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * Feature 0118 (Phase 2 of the in-game-time pivot) — ceremonies are TELEGRAPHED, TIMED interrupts. The day
 * has a known schedule ("the comp is this afternoon"), the narrator is primed for it during the run-up, and
 * a `due` signal tells the FE when to fire the gather. All Vault-free, all gated on the per-conversation
 * clock, so the seeded spine + golden replay are byte-identical. Roles only; in-game time only.
 */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

const asLive = (beat: string, timeOfDay: string | undefined, nightDepth?: number): LiveSeasonState =>
  ({ beat, timeOfDay, nightDepth } as unknown as LiveSeasonState);

describe("0118 — the day schedule (pure, deterministic reads)", () => {
  it("nextMilestone maps each ceremony beat to its scheduled phase + target hour", () => {
    for (const beat of Object.keys(DAY_SCHEDULE)) {
      const m = nextMilestone({ ...(asLive(beat, "morning", 9) as object), vetoField: ["a"] } as unknown as LiveSeasonState); // vetoField set = the veto draw has happened (competition proper)
      expect(m).not.toBeNull();
      expect(m!.beat).toBe(beat);
      expect(m!.phase).toBe(DAY_SCHEDULE[beat as keyof typeof DAY_SCHEDULE]);
    }
    // ORW-116 (Ryne): competitions in the afternoon, ceremonies (nominations, veto ceremony) and evictions in the evening, the veto player DRAW in the morning of the veto day.
    expect(DAY_SCHEDULE["hoh-competition"]).toBe("afternoon");
    expect(DAY_SCHEDULE["veto-competition"]).toBe("afternoon");
    expect(DAY_SCHEDULE["nominations"]).toBe("evening");
    expect(DAY_SCHEDULE["veto-ceremony"]).toBe("evening");
    expect(DAY_SCHEDULE["eviction"]).toBe("evening");
    expect(nextMilestone(asLive("veto-competition", "morning", 9))!.phase).toBe("morning");          // field not drawn yet: the draw is due in the morning
    expect(nextMilestone({ ...(asLive("veto-competition", "morning", 9) as object), vetoField: ["a"] } as unknown as LiveSeasonState)!.phase).toBe("afternoon"); // drawn: the competition is the afternoon
  });

  it("nextMilestone is null off a milestone beat (inert / terminal / no clock)", () => {
    expect(nextMilestone(asLive("comp-elimination", "morning", 9))).toBeNull();
    expect(nextMilestone(asLive("day-break", "morning", 9))).toBeNull();
    expect(nextMilestone(asLive("complete", "evening", 18))).toBeNull();
    expect(nextMilestone(null)).toBeNull();
  });

  it("milestoneDue is false before the scheduled phase and true once the clock reaches it", () => {
    const beat = "hoh-competition"; // scheduled afternoon (hour 12)
    expect(milestoneDue(asLive(beat, "morning", 9))).toBe(false);   // 9am — before
    expect(milestoneDue(asLive(beat, "afternoon", 12))).toBe(true); // 12 — at the threshold
    expect(milestoneDue(asLive(beat, "evening", 17))).toBe(true);   // already past
    expect(milestoneDue(asLive(beat, undefined))).toBe(false);      // clock not started
  });
});

/** Production-shaped: turn-driven + auxTicksNever; per-conversation clock on when clockOn. */
function harness(opts: { clockOn: boolean; seed: number; user: string }) {
  GameSessionAdapter.setTimeOfDayEnabled(opts.clockOn);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(opts.user);
  sb.session.createCharacter({ playerName: "The Player", seed: opts.seed });
  sb.session.setPerConversationClockEnabled(true);
  const orch = new Orchestrator(reg, new FakeClock(), { seed: opts.seed, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  return { reg, sb };
}

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") s.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id });
}

function toLiveClock(sb: ReturnType<GameSessionRegistry["sandboxFor"]>): void {
  for (let i = 0; i < 120; i++) {
    if (sb.session.perConversationClockLive() && sb.session.snapshot().live?.hoh !== undefined) return;
    const a = sb.session.advanceGame();
    if (a.pending) resolveLegally(sb.session, a.pending);
    if (a.finished) return;
  }
}

const socialTurn = (sb: ReturnType<GameSessionRegistry["sandboxFor"]>, c: string): void => {
  const npc = sb.session.livingIds().filter((id) => id !== PLAYER)[0]!;
  sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], content: c });
};

describe("0118 — the telegraphed schedule rides the view + primes the narrator (clock live)", () => {
  it("the view exposes the next milestone + its phase; the narrator context telegraphs the run-up", () => {
    const { sb } = harness({ clockOn: true, seed: 7, user: "u-sched" });
    toLiveClock(sb);
    const view = sb.session.getGameState();
    const ds = view.daySchedule;
    expect(ds).toBeDefined();
    expect(ds!.next).toBe(sb.session.snapshot().live!.beat); // the current milestone
    expect(ds!.phase).toBe(DAY_SCHEDULE[ds!.next]);

    const ctx = renderGameContext(view);
    expect(ctx).toContain(MILESTONE_LABEL[ds!.next]); // the milestone is named for the narrator
    expect(ctx).toMatch(/COMING UP|IT IS TIME/); // it is telegraphed
  });

  it("as the clock reaches the scheduled phase, `due` flips true and the narrator calls the gather", () => {
    const { sb } = harness({ clockOn: true, seed: 13, user: "u-due" });
    toLiveClock(sb);
    const target = nextMilestone(sb.session.snapshot().live)!.targetHour;
    // Linger through social play until the in-game clock reaches the scheduled milestone hour.
    for (let t = 0; t < 60 && (sb.session.inGameHour() ?? 0) < target; t++) socialTurn(sb, `linger ${t}`);
    expect(sb.session.inGameHour()!).toBeGreaterThanOrEqual(target);

    expect(sb.session.milestoneDue()).toBe(true);
    expect(sb.session.getGameState().daySchedule!.due).toBe(true);
    expect(renderGameContext(sb.session.getGameState())).toContain("IT IS TIME");
  });
});

describe("0118 — byte-identical / golden-safe + Vault-free guardrails", () => {
  it("with the in-game clock OFF, daySchedule is absent and the narrator context has no schedule line", () => {
    const { sb } = harness({ clockOn: false, seed: 7, user: "u-off" });
    toLiveClock(sb);
    const view = sb.session.getGameState();
    expect(view.daySchedule).toBeUndefined();
    expect(sb.session.milestoneDue()).toBe(false);
    const ctx = renderGameContext(view);
    expect(ctx).not.toMatch(/COMING UP|IT IS TIME/);
  });

  it("the schedule + priming leak no planted Vault content", () => {
    const { sb } = harness({ clockOn: true, seed: 7, user: "u-vault" });
    toLiveClock(sb);
    const SENT = "VAULT_118_SENTINEL";
    sb.engine.vault.writeHidden({ id: "v118", kind: "hidden-attribute", content: `hidden ${SENT}` });
    const view = sb.session.getGameState();
    expect(JSON.stringify(view.daySchedule)).not.toContain(SENT);
    expect(renderGameContext(view)).not.toContain(SENT);
  });
});

import { minutesUntilDue } from "../../src/engine/daySchedule";
describe("A7 - minutesUntilDue", () => {
  const live = (hour: number, beat = "veto-competition") => ({ beat, timeOfDay: "morning", nightDepth: hour, vetoField: ["a"] }) as never;
  it("counts whole minutes to the scheduled hour, 0 once due, null with no milestone/clock", () => {
    expect(minutesUntilDue(live(11.5))).toBe(30);   // afternoon starts at 12
    expect(minutesUntilDue(live(11.9))).toBe(6);
    expect(minutesUntilDue(live(12))).toBe(0);
    expect(minutesUntilDue(live(13))).toBe(0);
    expect(minutesUntilDue(live(11.5, "premiere"))).toBeNull();
    expect(minutesUntilDue({ beat: "veto-competition" } as never)).toBeNull();
  });
});
