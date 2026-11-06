import "../support/pinFlagsOff";
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { advanceClock, advanceClockPerConversation as advanceClockPerConversationPure } from "../../src/engine/liveSeason";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { WAKE_HOUR, DAY_END_HOUR } from "../../src/engine/timeOfDay";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * 0066 Phase-2 (#1125), Extension 1 — the per-conversation clock advance. The DEDICATED calibration-
 * neutrality gate (the `triggerOutcomeNeutral` / `stagedTrajectoryNeutral` sibling; the brief's bar (a)).
 *
 * The load-bearing claim, proven by hashing the SEEDED competition/vote/jury OUTCOME stream — every
 * HOH/veto crown, every nomination, every eviction, the finale — as a full game runs:
 *
 *   • THE CALIBRATION SPINE (master clock OFF — the EXACT state the juryReach/gradient/UAT sims run in):
 *     the extension flag ON-vs-OFF is BYTE-IDENTICAL. Flipping the extension can never perturb the
 *     calibration band, because the master clock gates it (and the band runs clock-off).
 *   • BYTE-IDENTICAL WHEN OFF (master clock ON): with the extension OFF the outcome stream is a
 *     deterministic fixed point.
 *
 * Plus the pure-unit guarantees: the per-conversation advance adds NO rng draw (a pure night-depth
 * mutation), is correctly GATED (a no-op unless its flag AND the master clock are on), is NON-VACUOUS
 * (it genuinely presses the clock), and NEVER rushes (it clamps at late-night, never wrapping the night).
 *
 * Roles only — no names; all fixtures generated.
 */

const SEED = 7;
const PHASES = ["morning", "afternoon", "evening", "night", "late-night"];

afterEach(() => {
  GameSessionAdapter.setTimeOfDayEnabled(null);
  delete process.env.ORWELL_TIME_OF_DAY;
});

interface Outcome {
  ceremonies: string[];
  evictionOrder: string[];
  winner: string | undefined;
}

/** The beats that DEFINE the seeded outcome trajectory (not presentation drops / vote choreography). */
const OUTCOME_BEATS = new Set([
  "hoh-competition", "veto-competition", "nominations", "veto-ceremony",
  "eviction", "final-eviction", "finale-result",
]);

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

/**
 * Play a full seeded game through the live adapter + the TURN-DRIVEN orchestrator (so the per-turn
 * off-screen tick — where the per-conversation clock advance rides — actually fires), capturing the
 * seeded outcome trajectory. `clockOn` flips the master clock; `extensionOn` flips Extension 1.
 */
function play(opts: { clockOn: boolean; extensionOn: boolean }): Outcome {
  GameSessionAdapter.setTimeOfDayEnabled(opts.clockOn);
  const reg = new GameSessionRegistry();
  const user = "pc";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
  sb.session.setPerConversationClockEnabled(opts.extensionOn);
  const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED, turnDriven: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));

  const out: Outcome = { ceremonies: [], evictionOrder: [], winner: undefined };
  for (let i = 0; i < 4000; i++) {
    const adv = sb.session.advanceGame();
    if (adv.event && OUTCOME_BEATS.has(adv.event.beat)) out.ceremonies.push(`${adv.event.beat}: ${adv.event.content}`);
    if (adv.pending) resolveLegally(sb.session, adv.pending);
    if (adv.finished) break;
  }
  const snap = sb.session.snapshot();
  out.evictionOrder = [...(snap.live?.evictionOrder ?? [])];
  out.winner = snap.live?.winner;
  return out;
}

const hash = (o: Outcome): string =>
  createHash("sha256").update(JSON.stringify({ c: o.ceremonies, e: o.evictionOrder, w: o.winner })).digest("hex");

describe("0066 Phase-2 Ext 1 — per-conversation clock advance is calibration-neutral", () => {
  it("CALIBRATION SPINE (master clock OFF): the extension flag ON-vs-OFF is byte-identical", () => {
    // Exactly the harness state the seeded juryReach/gradient/UAT sims run in. The extension cannot touch
    // the seeded outcome stream because the master clock gates it.
    const off = play({ clockOn: false, extensionOn: false });
    const on = play({ clockOn: false, extensionOn: true });
    expect(off.winner, "the game reaches a real ending").toBeDefined();
    expect(off.evictionOrder.length, "a real multi-eviction game was played").toBeGreaterThan(3);
    expect(hash(on), "master clock OFF ⇒ the extension is fully inert ⇒ byte-identical outcomes").toBe(hash(off));
  });

  it("master clock ON, extension OFF: a deterministic fixed point (byte-identical when off)", () => {
    const a = play({ clockOn: true, extensionOn: false });
    const b = play({ clockOn: true, extensionOn: false });
    expect(a.winner).toBeDefined();
    expect(hash(a), "extension OFF is a deterministic fixed point (same seed ⇒ same SHA256)").toBe(hash(b));
  });
});

describe("0066 Phase-2 Ext 1 — the pure advance is gated, non-vacuous, and never rushes", () => {
  it("advanceClockPerConversation is GATED: a no-op unless its flag AND the master clock are on", () => {
    const mk = (clockOn: boolean, extOn: boolean): GameSessionAdapter => {
      GameSessionAdapter.setTimeOfDayEnabled(clockOn);
      const s = new GameSessionAdapter();
      s.createCharacter({ playerName: "The Player", seed: SEED });
      s.setPerConversationClockEnabled(extOn);
      s.advanceGame(); // 0111: close the premiere champagne circle
      s.advanceGame(); // initialize the clock (if it's on)
      return s;
    };
    // Both off, and each half off ⇒ the depth never moves.
    for (const [clockOn, extOn] of [[false, false], [false, true], [true, false]] as const) {
      const s = mk(clockOn, extOn);
      const before = s.snapshot().live?.nightDepth ?? 0;
      for (let i = 0; i < 10; i++) s.advanceClockPerConversation();
      expect(s.snapshot().live?.nightDepth ?? 0, `clockOn=${clockOn} extOn=${extOn} ⇒ inert`).toBe(before);
    }
  });

  it("NON-VACUOUS: with both on, lingering presses the night depth forward (and the public phase advances)", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: SEED });
    s.setPerConversationClockEnabled(true);
    s.advanceGame(); // 0111: close the premiere champagne circle
    s.advanceGame(); // start the day
    const startDepth = s.snapshot().live?.nightDepth ?? 0;
    for (let i = 0; i < 20; i++) s.advanceClockPerConversation();
    const endDepth = s.snapshot().live?.nightDepth ?? 0;
    expect(endDepth, "the per-conversation advance genuinely presses the clock").toBeGreaterThan(startDepth);
    expect(PHASES).toContain(s.gameStatus().timeOfDay);
  });

  it("DEFAULT ON: a fresh session with the master clock on advances per-conversation time WITHOUT opting in", () => {
    // The fast-forward-bug fix: `PER_CONVERSATION_CLOCK_ENABLED_DEFAULT` is now ON, so a real playtest (the
    // FE runs the master clock) gets in-fiction time during social play WITHOUT any env var or setter. We do
    // NOT call setPerConversationClockEnabled here — the default alone must make lingering press the clock.
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: SEED });
    s.advanceGame(); // 0111: close the premiere champagne circle
    s.advanceGame(); // start the day (no opt-in call)
    const startDepth = s.snapshot().live?.nightDepth ?? 0;
    for (let i = 0; i < 20; i++) s.advanceClockPerConversation();
    expect(s.snapshot().live?.nightDepth ?? 0, "the DEFAULT-on per-conversation clock presses time forward").toBeGreaterThan(startDepth);
  });

  it("NEVER RUSHES: a long lingering run clamps near the 8am wake and never WRAPS the night (no auto-bedtime)", () => {
    // The pure liveSeason check — the per-conversation step holds at the bitter pre-dawn edge; only the
    // player's own turnIn (or a ceremony beat) ends the night. So a player can linger indefinitely in an
    // engaged scene without ever being skipped past their bedtime decision (ADR 0003 / the lull rule).
    const s = { nightDepth: WAKE_HOUR, timeOfDay: "morning", evictionOrder: [] } as unknown as LiveSeasonState;
    for (let i = 0; i < 1000; i++) advanceClockPerConversationPure(s);
    expect(s.timeOfDay, "clamps at late-night, never wraps to a new morning").toBe("late-night");
    expect(s.nightDepth, "held at the bitter pre-dawn edge (just below the 8am wake)").toBeLessThan(DAY_END_HOUR);
    expect(s.nightDepth, "and pressed all the way there").toBeGreaterThan(DAY_END_HOUR - 1);
    expect(s.lastSleepDepth, "no auto-bedtime was banked (the player owns turnIn)").toBeUndefined();
    expect(s.playerRetired, "the player is never auto-retired").toBeFalsy();
    // By contrast the PER-BEAT clock DOES wrap (banking a late night the player never ended) — proving the
    // two paths are deliberately different, and only the per-conversation one is rush-proof.
    const beatState = { nightDepth: DAY_END_HOUR - 1, timeOfDay: "late-night", evictionOrder: [] } as unknown as LiveSeasonState;
    advanceClock(beatState);
    expect(beatState.timeOfDay, "the per-beat clock wraps the night to the 8am wake").toBe("morning");
    expect(beatState.nightDepth, "back at the wake hour").toBe(WAKE_HOUR);
  });
});

// ── G16 (#1850) — the 0066 Phase-2 flag-trio doc block must state its polarity truthfully ──────────────

describe("G16 (#1850) — the 0066 Phase-2 flag-trio doc block doesn't self-contradict on default polarity", () => {
  const SRC_PATH = "src/adapters/engine/GameSessionAdapter.ts";

  /** Ground truth pulled straight from the `_ENABLED_DEFAULT` assignment expression, never from prose. */
  function actualDefaultOn(envName: string, src: string): boolean {
    if (new RegExp(`process\\.env\\.${envName} !== "0"`).test(src)) return true; // opt-out ⇒ default ON
    if (new RegExp(`flagDefaultOn\\("${envName}"\\)`).test(src)) return true; // the shared default-ON reader ⇒ default ON
    if (new RegExp(`process\\.env\\.${envName} === "1"`).test(src)) return false; // opt-in ⇒ default OFF
    throw new Error(`could not find a recognizable default expression for ${envName} in ${SRC_PATH}`);
  }

  it("the block-level summary agrees with the per-item annotations, which agree with the actual code default for each flag", () => {
    const src = readFileSync(SRC_PATH, "utf8");
    const blockMatch = src.match(/\/\*\*\n \* 0066 Phase-2 \(#1125\)[\s\S]*?\n \*\//);
    expect(blockMatch, "the 0066 Phase-2 doc block must exist above the three flag consts").toBeTruthy();
    const block = blockMatch![0];

    const listStart = block.indexOf("1. `ORWELL_TIME_PER_CONVERSATION`");
    expect(listStart, "the numbered per-flag list must exist inside the block").toBeGreaterThan(-1);
    const summary = block.slice(0, listStart);
    const list = block.slice(listStart);

    const flags = [
      "ORWELL_TIME_PER_CONVERSATION",
      "ORWELL_SOCIAL_FATIGUE",
      "ORWELL_MULTI_NIGHT_FATIGUE",
    ] as const;
    const defaults = flags.map((env) => actualDefaultOn(env, src));

    // Per-item annotation truth: each item's own "**Default ON/OFF**" tag must agree with the code —
    // this is what a reader who reads past the header actually sees, and it must never lie either.
    flags.forEach((env, i) => {
      const itemMatch = list.match(new RegExp("`" + env + "`[\\s\\S]{0,400}?\\*\\*Default (ON|OFF)\\*\\*"));
      expect(itemMatch, `the ${env} item must carry a **Default ON/OFF** annotation`).toBeTruthy();
      expect(itemMatch![1] === "ON", `${env}'s per-item annotation must match its actual code default`).toBe(defaults[i]);
    });

    // The G16 gap itself: the block-level SUMMARY (the part a skimming reader sees first) must never contradict the per-item truth. While the trio's defaults are MIXED it must call that out and
    // must not blanket the trio as opt-in; once they are UNIFORM (all three default ON since the 2026-11-05 flip) it must state the uniform default and must not claim a mixed/not-uniform polarity.
    const summaryClaimsUniformOptIn = /each\b[\s\S]{0,120}\bopt-in\b/i.test(summary);
    expect(summaryClaimsUniformOptIn, "the summary must not describe the whole trio as opt-in when any of them defaults ON").toBe(false);
    const mixedPolarity = new Set(defaults).size > 1;
    if (mixedPolarity) {
      expect(/\bnot uniform\b|\bmixed\b/i.test(summary), "a mixed-default trio's summary must call out that polarity differs per item, not assert one uniform default").toBe(true);
    } else {
      expect(/\bnot uniform\b|\bmixed\b/i.test(summary), "a uniform-default trio's summary must not claim mixed polarity").toBe(false);
      expect(summary.includes(defaults[0] ? "default ON" : "default OFF"), "a uniform-default trio's summary must state the uniform default").toBe(true);
    }
  });
});
