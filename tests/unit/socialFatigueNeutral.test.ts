import { describe, it, expect, afterEach, vi } from "vitest";

// P0 flip: calibration-neutrality baseline (the extension ON-vs-OFF must be byte-identical on the flag-off spine). Those layers now default ON, so this file pins them OFF explicitly (hoisted: some adapter consts read env at import). Tests that need a layer ON turn it on through its setter.
vi.hoisted(() => { for (const k of ["ORWELL_ASSURANCES", "ORWELL_VOTE_COUNT", "ORWELL_VETO_MEMORY", "ORWELL_DEAL_NOMS", "ORWELL_CAMPAIGN_MEMORY", "ORWELL_APPROACH_MEMORY", "ORWELL_HC_MEMORY", "ORWELL_MEMORY_PROMISES", "ORWELL_FORGIVENESS", "ORWELL_LOBBYING", "ORWELL_DESIRE_CLOCK", "ORWELL_WANT_MOVEMENT", "ORWELL_MULTI_NIGHT_FATIGUE", "ORWELL_MORNING_APPROACH", "ORWELL_NPC_TELLS", "ORWELL_TELL_REACTIONS", "ORWELL_MOOD_VETO", "ORWELL_MOOD_APPROACH", "ORWELL_MOOD_DEAL", "ORWELL_MOOD_CAMPAIGN", "ORWELL_DRIFT_FIX", "ORWELL_NPC_MEMORY_SPEECH", "ORWELL_DRIVE_DECISIONS"]) process.env[k] = "0"; });
import { createHash } from "node:crypto";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { socialSwayScale, soreSwayScale, SOCIAL_SWAY_FLOOR } from "../../src/engine/timeOfDay";
import { scaleImpactByValence } from "../../src/engine/relationshipConstants";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * 0066 Phase-2 (#1125), Extension 2 — NPC next-day social fatigue. The DEDICATED calibration-neutrality
 * gate (the `triggerOutcomeNeutral` sibling; the brief's bar (a)).
 *
 * Extension 2 has two arms, BOTH gated behind `ORWELL_SOCIAL_FATIGUE` (default OFF):
 *   • a tired houseguest sways the off-screen house LESS (the fold-magnitude scale `socialFoldScale`);
 *   • a CHARACTER conflict drains the houseguest in it to an EARLIER bedtime (`nightConflicts`).
 * Both are PURE (no rng) — they scale an already-decided fold / read an already-decided tally — so the
 * main competition/vote/jury rng stream is NEVER re-phased (zero extra draws). No dedicated side-stream is
 * needed; the proof is that the seeded OUTCOME stream is byte-identical when the extension is off.
 *
 * Hashed claim (full-game seeded outcome stream — crowns / noms / evictions / finale):
 *   • CALIBRATION SPINE (master clock OFF — the juryReach/gradient/UAT harness state): flag ON-vs-OFF is
 *     BYTE-IDENTICAL.
 *   • BYTE-IDENTICAL WHEN OFF (master clock ON): the extension OFF is a deterministic fixed point.
 *   • NON-VACUOUS: `socialFoldScale` is the identity (1) when off and genuinely dampens when on+tired.
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

/** Play a full seeded game through the live adapter + the turn-driven orchestrator (so the off-screen
 *  society — where `socialFoldScale` + the conflict drain ride — runs every turn). */
function play(opts: { clockOn: boolean; extensionOn: boolean }): Outcome {
  GameSessionAdapter.setTimeOfDayEnabled(opts.clockOn);
  const reg = new GameSessionRegistry();
  const user = "sf";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
  sb.session.setSocialFatigueEnabled(opts.extensionOn);
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

describe("0066 Phase-2 Ext 2 — NPC social fatigue is calibration-neutral", () => {
  it("CALIBRATION SPINE (master clock OFF): the extension flag ON-vs-OFF is byte-identical", () => {
    const off = play({ clockOn: false, extensionOn: false });
    const on = play({ clockOn: false, extensionOn: true });
    expect(off.winner, "the game reaches a real ending").toBeDefined();
    expect(off.evictionOrder.length, "a real multi-eviction game was played").toBeGreaterThan(3);
    expect(hash(on), "master clock OFF ⇒ the extension is fully inert ⇒ byte-identical outcomes").toBe(hash(off));
  });

  it("master clock ON, extension OFF: a deterministic fixed point (byte-identical when off)", () => {
    // NB: with the master clock ON, the Phase-1 single-night comp rest term is legitimately active (a
    // houseguest who ran late competes worse) — that is NOT Extension 2 and the clock-on run is expected
    // to differ from the clock-off baseline. The Extension-2 claim is that with ITS flag off the outcome
    // stream is a deterministic fixed point — i.e. the social-fatigue arm adds nothing when off.
    const a = play({ clockOn: true, extensionOn: false });
    const b = play({ clockOn: true, extensionOn: false });
    expect(a.winner).toBeDefined();
    expect(hash(a), "extension OFF is a deterministic fixed point (same seed ⇒ same SHA256)").toBe(hash(b));
  });
});

describe("0066 Phase-2 Ext 2 — ZERO extra draws: the shared off-screen rng stream is never re-phased", () => {
  it("the first off-screen tick's recorded society events are byte-identical OFF vs ON (master clock ON)", () => {
    // `socialFoldScale` scales the relationship FOLD MAGNITUDE only — applied AFTER the society generates
    // its scenes, taking the SAME jitter draws either way. So the SEEDED society EVENT stream (what the
    // shared rng produces) must be byte-identical whether the extension is off or on; only the hidden
    // relationship edges move (legitimate, like the trigger layer). This is the "zero extra draws" proof.
    const tick = (extensionOn: boolean): string => {
      GameSessionAdapter.setTimeOfDayEnabled(true);
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor("z");
      sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
      sb.session.setSocialFatigueEnabled(extensionOn);
      const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });
      // Run the clock into the night first so a deficit exists (the extension would dampen folds if it could
      // perturb the stream). Then ONE off-screen tick; hash its seeded society event content.
      for (let i = 0; i < 10; i++) { const a = sb.session.advanceGame(); if (a.pending) resolveLegally(sb.session, a.pending); if (a.finished) break; }
      const before = sb.engine.events.count();
      orch.advance("z", "offscreen-tick");
      return sb.engine.events.queryAll().slice(before)
        .map((e) => `${e.type}|${e.initiator}|${[...e.witnessSet].sort().join(",")}|${e.hidden ? 1 : 0}|${e.content}`)
        .join("\n");
    };
    expect(tick(true), "the off-screen society event stream is unchanged by the fold-scale extension").toBe(tick(false));
  });
});

describe("0066 Phase-2 Ext 2 — the sway dampening is the identity when off and real when on", () => {
  it("socialFoldScale via the session is exactly 1 when the extension is off (zero dampening, no draw)", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: SEED });
    s.setSocialFatigueEnabled(false); // off
    // Run the clock deep into the night so a deficit WOULD exist if the extension read it.
    for (let i = 0; i < 30; i++) { const a = s.advanceGame(); if (a.pending) resolveLegally(s, a.pending); if (a.finished) break; }
    for (const id of s.livingIds()) {
      expect(s.socialFoldScale(id), "off ⇒ the off-screen fold is unscaled (byte-identical)").toBe(1);
    }
  });

  it("the pure socialSwayScale is non-vacuous: 1 when rested, dropping to the floor at a full deficit", () => {
    expect(socialSwayScale(0)).toBe(1);             // rested ⇒ identity
    expect(socialSwayScale(1)).toBe(SOCIAL_SWAY_FLOOR);
    expect(socialSwayScale(0.5)).toBeLessThan(1);   // genuinely dampens a tired houseguest
    expect(socialSwayScale(0.5)).toBeGreaterThan(SOCIAL_SWAY_FLOOR);
  });
});

describe("#1419 — the fatigue bias is ASYMMETRIC: warming dampened, souring amplified", () => {
  it("soreSwayScale is 1 when rested and rises above 1 with deficit (a tired houseguest cuts deeper)", () => {
    expect(soreSwayScale(0)).toBe(1);               // rested ⇒ identity (byte-identical path)
    expect(soreSwayScale(1)).toBeGreaterThan(1);    // full deficit ⇒ souring folds amplified
    expect(soreSwayScale(0.5)).toBeGreaterThan(1);
    expect(soreSwayScale(1)).toBeGreaterThanOrEqual(soreSwayScale(0.5)); // monotone up
  });

  it("at a real deficit warm < 1 < sore: positive nudges land softer, negative spats land harder", () => {
    const deficit = 0.8;
    const warm = socialSwayScale(deficit);
    const sore = soreSwayScale(deficit);
    expect(warm).toBeLessThan(1);                   // charm dampened
    expect(sore).toBeGreaterThan(1);                // barbs amplified
    expect(sore).toBeGreaterThan(warm);             // net bias toward negative consequence
  });

  it("scaleImpactByValence applies warm to warming components and sore to souring ones", () => {
    // A mixed fold from a tired initiator: trust UP (warming), affinity DOWN (souring), threat UP (souring
    // — the inverted axis), threat DOWN would be warming.
    const warm = 0.5, sore = 1.3;
    const out = scaleImpactByValence(
      { trust: 0.1, affinity: -0.1, threat: 0.1 }, warm, sore,
    );
    expect(out.trust).toBeCloseTo(0.1 * warm, 10);      // warming ⇒ dampened
    expect(out.affinity).toBeCloseTo(-0.1 * sore, 10);  // souring ⇒ amplified
    expect(out.threat).toBeCloseTo(0.1 * sore, 10);     // rising threat is souring ⇒ amplified
    // The inverted axis: a FALLING threat is warming ⇒ dampened.
    expect(scaleImpactByValence({ threat: -0.1 }, warm, sore).threat).toBeCloseTo(-0.1 * warm, 10);
  });

  it("with warm===sore===1 (rested / flag-off) the valence scale is byte-identical to the raw fold", () => {
    const raw = { trust: 0.12, affinity: -0.07, threat: 0.09, alignment: -0.03 };
    expect(scaleImpactByValence(raw, 1, 1)).toEqual(raw);
  });
});
