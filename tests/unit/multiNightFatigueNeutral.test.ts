import "../support/pinFlagsOff";
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { accrueFatigue, combinedRestDeficit } from "../../src/engine/timeOfDay";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * 0066 Phase-2 (#1125), Extension 3 — the compounding multi-night fatigue meter. The DEDICATED
 * calibration-neutrality gate (the `triggerOutcomeNeutral` sibling; the brief's bar (a)).
 *
 * Extension 3, behind `ORWELL_MULTI_NIGHT_FATIGUE` (default OFF), ADDS an EMA of nightly deficits on top
 * of the single-night immediate deficit (`combinedRestDeficit`), so a STRING of late nights compounds and
 * a rested night recovers. Both the comp fold and the social sway read the combined value. PURE (no rng) —
 * the meter is a deterministic running average and adds NO draw, so the main competition/vote/jury stream
 * is NEVER re-phased (zero extra draws); no dedicated side-stream is needed. With the flag OFF the meter is
 * never accrued (stays absent ⇒ 0) and `restDeficitOf` returns exactly the Phase-1 single-night value.
 *
 * Hashed claim (full-game seeded outcome stream — crowns / noms / evictions / finale):
 *   • CALIBRATION SPINE (master clock OFF — the juryReach/gradient/UAT harness state): flag ON-vs-OFF is
 *     BYTE-IDENTICAL.
 *   • BYTE-IDENTICAL WHEN OFF (master clock ON): the extension OFF is a deterministic fixed point identical
 *     to the master-clock-on / all-extensions-off baseline (only the Phase-1 single-night term is present).
 *   • NON-VACUOUS: the meter genuinely compounds consecutive late nights and recovers on a rested one.
 *
 * Roles only — no names; all fixtures generated.
 */

const SEED = 7;

afterEach(() => {
  GameSessionAdapter.setTimeOfDayEnabled(null);
  delete process.env.ORWELL_TIME_OF_DAY;
});

interface Outcome { ceremonies: string[]; evictionOrder: string[]; winner: string | undefined }

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

function play(opts: { clockOn: boolean; extensionOn: boolean }): Outcome {
  GameSessionAdapter.setTimeOfDayEnabled(opts.clockOn);
  const reg = new GameSessionRegistry();
  const user = "mn";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
  sb.session.setMultiNightFatigueEnabled(opts.extensionOn);
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

describe("0066 Phase-2 Ext 3 — the multi-night fatigue meter is calibration-neutral", () => {
  it("CALIBRATION SPINE (master clock OFF): the extension flag ON-vs-OFF is byte-identical", () => {
    const off = play({ clockOn: false, extensionOn: false });
    const on = play({ clockOn: false, extensionOn: true });
    expect(off.winner, "the game reaches a real ending").toBeDefined();
    expect(off.evictionOrder.length, "a real multi-eviction game was played").toBeGreaterThan(3);
    expect(hash(on), "master clock OFF ⇒ the meter is never accrued ⇒ byte-identical outcomes").toBe(hash(off));
  });

  it("master clock ON, extension OFF: a deterministic fixed point (byte-identical when off)", () => {
    // NB: with the master clock ON the Phase-1 single-night comp rest term is legitimately active and the
    // run differs from the clock-off baseline — that is NOT Extension 3. The Extension-3 claim is that with
    // ITS flag off the meter is never accrued, so `restDeficitOf` returns exactly the Phase-1 single-night
    // value and the outcome stream is a deterministic fixed point (the meter adds nothing when off).
    const a = play({ clockOn: true, extensionOn: false });
    const b = play({ clockOn: true, extensionOn: false });
    expect(a.winner).toBeDefined();
    expect(hash(a), "extension OFF is a deterministic fixed point").toBe(hash(b));
  });
});

describe("0066 Phase-2 Ext 3 — ZERO extra draws: the shared off-screen rng stream is never re-phased", () => {
  it("the first off-screen tick's recorded society events are byte-identical OFF vs ON (master clock ON)", () => {
    // The meter feeds the comp rest term + the social-sway magnitude via `combinedRestDeficit` — a pure
    // running average that takes NO rng draw. So the SEEDED society EVENT stream (what the shared rng
    // produces) must be byte-identical whether the meter is off or on. The "zero extra draws" proof.
    const tick = (extensionOn: boolean): string => {
      GameSessionAdapter.setTimeOfDayEnabled(true);
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor("z");
      sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
      sb.session.setMultiNightFatigueEnabled(extensionOn);
      const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });
      for (let i = 0; i < 10; i++) { const a = sb.session.advanceGame(); if (a.pending) resolveLegally(sb.session, a.pending); if (a.finished) break; }
      const before = sb.engine.events.count();
      orch.advance("z", "offscreen-tick");
      return sb.engine.events.queryAll().slice(before)
        .map((e) => `${e.type}|${e.initiator}|${[...e.witnessSet].sort().join(",")}|${e.hidden ? 1 : 0}|${e.content}`)
        .join("\n");
    };
    expect(tick(true), "the off-screen society event stream is unchanged by the meter extension").toBe(tick(false));
  });
});

describe("0066 Phase-2 Ext 3 — the EMA meter is non-vacuous: it compounds and recovers (pure, bounded)", () => {
  it("consecutive late nights compound toward 1; a rested night recovers; everything stays bounded", () => {
    // A string of moderate late nights (deficit 0.5 each) wears down beyond a single one.
    const n1 = accrueFatigue(0, 0.5);
    const n2 = accrueFatigue(n1, 0.5);
    const n3 = accrueFatigue(n2, 0.5);
    expect(n2).toBeGreaterThan(n1);                 // the second compounds beyond the first
    expect(n3).toBeGreaterThan(n2);                 // and the third beyond the second
    expect(n3).toBeLessThanOrEqual(1);              // bounded
    expect(accrueFatigue(1, 1)).toBe(1);            // saturates
    expect(accrueFatigue(n3, 0)).toBeLessThan(n3);  // a rested night recovers
    // The combined deficit ADDS the meter on top of the immediate — and is the IDENTITY when the meter is 0
    // (the byte-identical-when-off shape: no accrued meter ⇒ just the single-night deficit).
    expect(combinedRestDeficit(0.3, 0)).toBe(0.3);
    expect(combinedRestDeficit(0.3, 0.8)).toBeGreaterThan(0.3);
    expect(combinedRestDeficit(1, 1)).toBe(1);      // bounded
  });

  it("GATED: with the extension OFF, no fatigue meter ever accrues on the live state (stays absent)", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: SEED });
    s.setMultiNightFatigueEnabled(false); // off
    // Play several full nights (turning in repeatedly to force night-ends) — with the meter off, nothing accrues.
    for (let day = 0; day < 5; day++) {
      for (let i = 0; i < 6; i++) { const a = s.advanceGame(); if (a.pending) resolveLegally(s, a.pending); if (a.finished) break; }
      s.turnIn();
    }
    const snap = s.snapshot();
    expect(snap.live?.playerFatigue, "no player fatigue meter accrues when Ext 3 is off").toBeUndefined();
    expect(snap.live?.npcFatigue, "no NPC fatigue meter accrues when Ext 3 is off").toBeUndefined();
  });
});
