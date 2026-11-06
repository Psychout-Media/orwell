import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * ADR 0006 — the runtime toggle (the FE settings switch) + the Vault-free "who's turned in" projection.
 * The clock can be flipped on/off at runtime via the admin `setTimeOfDay` tool (no engine restart);
 * `null` restores the `ORWELL_TIME_OF_DAY` env default so the seeded golden sims stay OFF + byte-identical.
 * The `asleep` projection lists the houseguests who've turned in (observable; never the player, never a
 * hidden number). Roles only.
 */

afterEach(() => {
  GameSessionAdapter.setTimeOfDayEnabled(null); // never leak the process-global override across tests
  delete process.env.ORWELL_TIME_OF_DAY;
});

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

describe("ADR 0006 — the runtime toggle (the FE settings switch)", () => {
  it("flips the clock at runtime with no env var, and the override beats the env", () => {
    GameSessionAdapter.setTimeOfDayEnabled(false); // ORW-116: the clock now STARTS at the premiere entry when it is on (default), so "dormant" means explicitly off
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 7 });
    const a0 = s.advanceGame();
    if (a0.pending) resolveLegally(s, a0.pending);
    expect(s.gameStatus().timeOfDay, "dormant with no env and no override").toBeUndefined();

    GameSessionAdapter.setTimeOfDayEnabled(true); // the switch turns it ON
    let on = false;
    for (let i = 0; i < 6; i++) {
      const a = s.advanceGame();
      if (a.pending) resolveLegally(s, a.pending);
      if (s.gameStatus().timeOfDay) { on = true; break; }
    }
    expect(on, "the clock runs once toggled on").toBe(true);

    GameSessionAdapter.setTimeOfDayEnabled(false); // the OFF override wins over the env default
    process.env.ORWELL_TIME_OF_DAY = "1";
    expect(s.gameStatus().timeOfDay, "OFF override beats the env").toBeUndefined();

    GameSessionAdapter.setTimeOfDayEnabled(null); // null restores the env default (now "1")
    expect(s.gameStatus().timeOfDay, "null falls back to the env default").toBeDefined();
  });

  it("the admin setTimeOfDay tool flips it through the composition delegate", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("toggle-user");
    GameSessionAdapter.setTimeOfDayEnabled(false); // ORW-116: explicit off (see above)
    sb.session.createCharacter({ playerName: "The Player", seed: 5 });
    const a0 = sb.session.advanceGame();
    if (a0.pending) resolveLegally(sb.session, a0.pending);
    expect(sb.session.gameStatus().timeOfDay).toBeUndefined(); // off by default

    sb.admin.setTimeOfDay(true); // the FE settings switch path (admin tool → delegate → engine override)
    let on = false;
    for (let i = 0; i < 6; i++) {
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
      if (sb.session.gameStatus().timeOfDay) { on = true; break; }
    }
    expect(on, "the admin switch turns the clock on").toBe(true);

    sb.admin.setTimeOfDay(false);
    expect(sb.session.gameStatus().timeOfDay).toBeUndefined();
  });
});

describe("ADR 0006 — the asleep projection (who's turned in)", () => {
  it("surfaces the turned-in houseguests on both reads, Vault-free, never the player; dormant when off", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 3 });
    for (let i = 0; i < 40; i++) {
      if (s.gameStatus().timeOfDay === "night") break;
      const a = s.advanceGame();
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
    }
    const asleep = s.gameStatus().asleep;
    expect(asleep, "the projection is present while the clock runs").toBeDefined();
    expect((asleep ?? []).every((a) => a.id !== PLAYER), "the player is never listed asleep").toBe(true);
    for (const a of asleep ?? []) { expect(a.id).toBeTruthy(); expect(a.name).toBeTruthy(); }
    // the gadget reads the state view too
    expect(s.getGameState().asleep, "asleep also rides the state view").toBeDefined();
    // Vault-free: no bedtime/derivation/soul field rides along
    const json = JSON.stringify(s.gameStatus());
    for (const banned of ["bedtime", "owlScore", "restPenalty", "lastSleepPhase", "playerRetired"]) {
      expect(json).not.toContain(banned);
    }
    // dormant when the switch is off
    GameSessionAdapter.setTimeOfDayEnabled(false);
    expect(s.gameStatus().asleep).toBeUndefined();
    expect(s.getGameState().asleep).toBeUndefined();
  });
});
