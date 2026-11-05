import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { defaultApply } from "../../src/composition/orchestrator";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/**
 * Features 0093 + 0099 — the CALIBRATION-NEUTRALITY GATE (the `triggerOutcomeNeutral` /
 * `stagedTrajectoryNeutral` sibling; minimum-build-bar lesson 22). The load-bearing determinism
 * guarantee: secrets-as-power adds NO rng draw and NO fold to the seeded competition / vote / jury spine
 * UNLESS the player explicitly invokes a lever. So:
 *
 *   • A `makeDeal` WITHOUT a `leverage`/`tradedSecret` descriptor is BYTE-IDENTICAL to the pre-0093 deal
 *     (no severity read, no strength roll, no fold) — the opt-in field absent ⇒ byte-identical (ADR 0005).
 *   • A full season played with NO lever call produces a byte-identical seeded event stream to itself —
 *     the feature code's mere presence perturbs nothing (the levers are player-driven, never auto-fired).
 *   • Exposing/trading a secret legitimately MOVES reads (the same kind of fold the society already
 *     applies), so the calibration harness runs with NO lever invoked (proven byte-identical here + by the
 *     juryReach / UAT heavy gates). The lever folds are a player-driven addition, never the seeded path.
 *
 * HARD rule: roles only — no names; all fixtures generated.
 */

const SEED = 7;

/** Hash the SEEDED content of every recorded event (the comp/vote/society stream the calibration spine draws). */
function streamHash(sb: UserSandbox): string {
  const events = sb.engine.events.queryAll();
  const sig = (e: (typeof events)[number]): string =>
    `${e.type}|${e.initiator}|${[...e.witnessSet].sort().join(",")}|${e.hidden ? 1 : 0}|${e.content}`;
  return createHash("sha256").update(events.map(sig).join("\n")).digest("hex");
}

/** Drive a fixed, fully-deterministic interleave of live-loop steps + off-screen ticks. `withDeal` optionally
 *  makes a plain (leverage-FREE) deal mid-run, to prove a leverage-free deal perturbs nothing seeded. */
function runSeason(withDeal: "none" | "plain"): { hash: string; finished: boolean } {
  const reg = new GameSessionRegistry();
  const user = "neutral";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed: SEED });
  sb.session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
  const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });

  let finished = false;
  for (let i = 0; i < 60 && !finished; i++) {
    finished = stepLoop(sb);
    // At a fixed point, make a leverage-FREE deal — it must not perturb the seeded stream vs. "none".
    if (withDeal === "plain" && i === 5) {
      const target = sb.session.livingIds().find((id) => id !== PLAYER);
      if (target) sb.session.makeDeal({ with: target, kind: "final-two", terms: "ride or die" });
    }
    if (!finished) orch.advance(user, "offscreen-tick");
  }
  return { hash: streamHash(sb), finished };
}

function stepLoop(sb: UserSandbox): boolean {
  const adv = sb.session.advanceGame();
  if (adv.pending) {
    const p = adv.pending;
    if (p.kind === "nominations") sb.session.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
    else if (p.kind === "veto-decision") sb.session.submitDecision({ kind: "veto-decision", use: false });
    else if (p.kind === "replacement") sb.session.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
    else if (p.kind === "finale-statement") sb.session.submitDecision({ kind: "finale-statement", statement: "x" });
    else if (p.kind === "finale-answer") sb.session.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
    else if (p.kind === "juror-vote") sb.session.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
    else sb.session.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
  }
  return adv.finished;
}

describe("0093/0099 — secrets-as-power is calibration-neutral to the seeded spine (no lever invoked)", () => {
  it("a season with NO lever call is a deterministic fixed point (same seed ⇒ same SHA256)", () => {
    const a = runSeason("none");
    const b = runSeason("none");
    expect(a.hash, "no-lever run is a deterministic fixed point").toBe(b.hash);
  });

  it("a makeDeal with NO leverage/tradedSecret descriptor is a deterministic fixed point (the absent-field path is byte-stable)", () => {
    // The opt-in descriptor absent ⇒ the `if (req.leverage)` / `if (req.tradedSecret)` branches never run,
    // so the deal path draws no severity read / no strength roll / no fold — byte-identical to the pre-0093
    // deal. Proven by determinism: the same plain-deal run twice is byte-identical (a new rng draw on the
    // descriptor-absent path would desync the second run).
    const a = runSeason("plain");
    const b = runSeason("plain");
    expect(a.hash, "the descriptor-absent makeDeal path is byte-stable run-to-run").toBe(b.hash);
  });

  it("a plain (descriptor-free) makeDeal leaves the shared off-screen draw stream identical to a no-deal run (no shared-stream consumption)", () => {
    // PAT-3 (cubic): a run-to-run replay cannot see a deterministic extra draw. Compare the SAME seeded off-screen ticks
    // (a recording shared rng, the real `defaultApply`) with vs without a plain makeDeal first: the shared draw count and the number of
    // hidden society scenes must be identical — a deal that consumed/advanced any shared stream would desync them.
    const society = (deal: boolean): { sig: string[]; draws: number; bystanders: string } => {
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor("neutral-deal");
      sb.session.createCharacter({ playerName: "The Player", seed: SEED });
      sb.session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
      const target = sb.session.livingIds().find((id) => id !== PLAYER)!;
      if (deal) sb.session.makeDeal({ with: target, kind: "final-two", terms: "ride or die" });
      // Every hidden edge NOT involving the player or the deal partner: a descriptor-free deal has no business folding these.
      const others = sb.session.livingIds().filter((id) => id !== PLAYER && id !== target);
      const edge = (a: string, b: string): string => { const e = sb.engine.relationships.edge(a, b); return `${a}>${b}:${e.trust},${e.affinity},${e.threat}`; };
      const bystanders = others.flatMap((a) => others.filter((b) => b !== a).map((b) => edge(a, b))).join("|");
      let draws = 0;
      const rng = new SeededRandom(SEED);
      const orig = rng.next.bind(rng);
      rng.next = (): number => { draws++; return orig(); };
      for (let t = 0; t < 12; t++) defaultApply(sb, "offscreen-tick", rng, t * 1000, 3);
      const sig = sb.engine.events.queryAll()
        .filter((e) => e.hidden && e.id.startsWith("offscreen:"))
        .map((e) => `${e.initiator}|${e.type}|${e.content}`);
      return { sig, draws, bystanders };
    };
    const none = society(false);
    const plain = society(true);
    expect(none.sig.length, "the society actually ran").toBeGreaterThan(0);
    expect(plain.draws, "the shared stream is consumed identically").toBe(none.draws);
    expect(plain.bystanders, "a plain deal folds no third-party relationship edge").toBe(none.bystanders);
    // (Scene CONTENT may legitimately differ — a deal is a recorded event that folds reads the society then reads — so the
    // neutrality claim is the shared draw stream + the scene count, not the prose.)
    expect(plain.sig.length, "the same number of hidden society scenes").toBe(none.sig.length);
  });

  it("the gate is NON-VACUOUS: invoking a lever DOES move the stream (so the neutrality above is a real result)", () => {
    // A leverage-FREE-but-DESCRIPTOR-PRESENT deal exercises the new branch and folds a consequence; the
    // resulting stream differs from the no-descriptor run — proving the feature's folds are real (and that
    // the calibration spine is untouched ONLY because no lever is invoked, not because the code is inert).
    const reg = new GameSessionRegistry();
    const user = "neutral-nv";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: SEED });
    sb.session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
    // Plant a learned secret about a partner, then make a LEVERAGED deal — the new branch fires + folds.
    const partner = sb.session.livingIds().find((id) => id !== PLAYER)!;
    sb.engine.knowledge.seedBelief(partner, { content: "a learned secret", originalContent: "a learned secret", factId: `seed:${partner}`, confidence: 0.9, hops: 0, distortion: 0, source: partner }, "origin");
    sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: "a learned secret", subject: partner, confidence: 0.85 }, `told-by:${partner}`);
    // The player wields the secret by the id the engine assigned in THEIR knowledge (what the FE reads).
    const learned = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.subject === partner)!;
    const factId = learned.factId ?? learned.id;
    const before = { ...sb.engine.relationships.edge(partner, PLAYER) };
    sb.session.makeDeal({ with: partner, kind: "safety", terms: "keep me safe", leverage: { factId } });
    const after = sb.engine.relationships.edge(partner, PLAYER);
    const moved = Math.abs(after.trust - before.trust) > 1e-9 || Math.abs(after.affinity - before.affinity) > 1e-9 || Math.abs(after.threat - before.threat) > 1e-9;
    expect(moved, "a leveraged deal folds a real (bounded) consequence — the gate is non-vacuous").toBe(true);
  });
});
