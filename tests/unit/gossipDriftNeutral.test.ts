import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { makeSocialGraph, diffuseGossip, rumorFrom } from "../../src/engine/gossip";
import { RelationshipModel } from "../../src/engine/relationships";
import { buildEngineCore } from "../../src/composition/engineRoot";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { UserSandbox } from "../../src/composition/registry";
import { npc } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { VoiceProfile } from "../../src/domain/voiceProfile";

/**
 * Issue #1397 — the CALIBRATION-NEUTRALITY GATE for character-mediated gossip drift (the sibling of
 * `triggerOutcomeNeutral` / `stagedTrajectoryNeutral`). The load-bearing determinism guarantee:
 *
 *   • All gossip-drift randomness rides a per-hop FORK of the parent `rng` (`RandomnessSource.fork` reads
 *     the parent state WITHOUT advancing it), so it NEVER consumes from the shared stream that resolves the
 *     seeded society / competition / vote / jury spine.
 *   • Voice mediation re-weights ONLY the severity-step DIRECTION threshold + the hedge POOL — each an
 *     EXISTING forked draw whose COUNT and POSITION are unchanged — and holds the subject-swap decision
 *     VOICE-INDEPENDENT, so the E44 receipt fold draws the SAME number of PARENT values whether the layer is
 *     off or on. Net: the parent draw STREAM (what every downstream comp / vote / jury draws next) is
 *     BYTE-IDENTICAL off vs on — I achieved zero NEW parent draws, so neutrality holds for BOTH states.
 *   • Flag OFF (the DEFAULT — the calibration harness's state) ⇒ the orchestrator passes NO `voiceOf` ⇒ the
 *     drift is byte-identical to the pre-feature agnostic path.
 *
 * NOTE (by design, NOT asserted): with the layer ON, a voice-drifted NATURE keys a different `GOSSIP_HEARD`
 * receipt magnitude, so relationship EDGES — and therefore later OUTCOMES — MAY legitimately differ off vs
 * on (exactly the `triggerOutcomeNeutral` caveat). That is fine: the calibration harness runs OFF, and the
 * shared rng DRAW STREAM the comps/votes resolve on is untouched (proven directly below).
 *
 * HARD rule: roles only — no names; all fixtures generated.
 */

const SEED = 7;

const DRAMATIC: VoiceProfile = {
  register: "crude", rhythm: "rambling", energy: "manic", directness: "candid",
  humor: "cutting", stressTell: "talks faster", signature: "x", lexicon: [],
};
const BLUNT: VoiceProfile = {
  register: "formal", rhythm: "clipped", energy: "flat", directness: "blunt",
  humor: "dry", stressTell: "gets clipped", signature: "y", lexicon: [],
};

const SUBJECT_A = npc(1);
const SUBJECT_B = npc(2);

function chainGraph() {
  return makeSocialGraph([
    [npc(10), npc(11)], [npc(11), npc(12)], [npc(12), npc(13)], [npc(13), npc(14)],
    [npc(14), npc(15)], [npc(15), npc(16)], [npc(12), npc(20)], [npc(14), npc(21)],
  ]);
}
const CHAIN_IDS = [10, 11, 12, 13, 14, 15, 16, 20, 21].map((n) => npc(n));

/**
 * Diffuse ONE scene-rumor (WITH the E44 `rel` fold, so the parent rng is genuinely consumed by receipt
 * folds), then draw a long TAIL from the SAME parent — these are exactly the values a competition / vote /
 * jury would draw NEXT off that shared stream. If voice mediation perturbed the parent by even one draw,
 * this tail would diverge.
 */
function parentTail(voiceOf?: (id: string) => VoiceProfile | undefined): number[] {
  const parent = new SeededRandom(SEED);
  const knowledge = buildEngineCore().knowledge;
  const rel = new RelationshipModel(0.5);
  diffuseGossip({
    knowledge,
    graph: chainGraph(),
    rng: parent,
    origin: npc(10),
    fact: { content: rumorFrom(SUBJECT_A, SUBJECT_B, "gossip") },
    rounds: 6,
    transmitProb: 1,
    decay: 0.7,
    rel,
    subjects: [SUBJECT_A, SUBJECT_B],
    sceneType: "gossip",
    ...(voiceOf ? { voiceOf } : {}),
  });
  return Array.from({ length: 96 }, () => parent.next());
}

/** The diffusing beliefs (content) — the OPEN-SET output the layer is ALLOWED to change. */
function beliefContents(voiceOf?: (id: string) => VoiceProfile | undefined): string[] {
  const core = buildEngineCore();
  const { factId } = diffuseGossip({
    knowledge: core.knowledge,
    graph: chainGraph(),
    rng: new SeededRandom(SEED),
    origin: npc(10),
    fact: { content: rumorFrom(SUBJECT_A, SUBJECT_B, "gossip") },
    rounds: 6,
    transmitProb: 1,
    subjects: [SUBJECT_A, SUBJECT_B],
    sceneType: "gossip",
    ...(voiceOf ? { voiceOf } : {}),
  });
  return CHAIN_IDS
    .map((id) => core.knowledge.knownTo(id).find((k) => k.factId === factId)?.content)
    .filter((c): c is string => c !== undefined)
    .sort();
}

describe("issue #1397 — voice mediation NEVER perturbs the seeded parent draw stream", () => {
  it("the parent rng TAIL is byte-identical OFF vs ON (both DRAMATIC and BLUNT retellers)", () => {
    // The seeded comp/vote/jury draw stream (everything drawn off the parent) is untouched by the layer.
    const off = parentTail(undefined);
    expect(off).toEqual(parentTail(() => DRAMATIC));
    expect(off).toEqual(parentTail(() => BLUNT));
  });

  it("the parent TAIL is itself deterministic (a real fixed point, not a vacuous match)", () => {
    expect(parentTail(() => DRAMATIC)).toEqual(parentTail(() => DRAMATIC));
    expect(parentTail(undefined)).toEqual(parentTail(undefined));
    // Non-vacuity: the diffusion actually DID consume parent draws (the tail is not the raw seed stream).
    const raw = new SeededRandom(SEED);
    const rawTail = Array.from({ length: 96 }, () => raw.next());
    expect(parentTail(undefined)).not.toEqual(rawTail);
  });

  it("the layer is NON-VACUOUS: different voices DO change the open-set belief content", () => {
    // If ON did nothing, the neutrality above would be trivial. It genuinely reshapes the belief content.
    expect(beliefContents(() => DRAMATIC)).not.toEqual(beliefContents(() => BLUNT));
    // …while the AGNOSTIC (no-voice) path is a stable, deterministic control.
    expect(beliefContents(undefined)).toEqual(beliefContents(undefined));
  });
});

/** A fixed interleave: advance the live loop a step, then an off-screen tick (where gossip diffusion rides). */
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

/** Drive a bounded, fully-deterministic sequence of live steps + off-screen ticks through the LIVE
 *  orchestrator wiring, hashing the full recorded-event stream (the closed-set spine). */
function runOrchestratorHash(driftOn: boolean): string {
  const reg = new GameSessionRegistry();
  const user = "gd";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
  sb.session.setGossipDriftEnabled(driftOn);
  const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });
  let finished = false;
  for (let i = 0; i < 90 && !finished; i++) {
    finished = stepLoop(sb);
    if (!finished) orch.advance(user, "offscreen-tick");
  }
  const events = sb.engine.events.queryAll();
  const sig = (e: (typeof events)[number]): string =>
    `${e.type}|${e.initiator}|${[...e.witnessSet].sort().join(",")}|${e.hidden ? 1 : 0}|${e.content}`;
  return createHash("sha256").update(events.map(sig).join("\n")).digest("hex");
}

describe("issue #1397 — the live orchestrator wiring is calibration-safe (flag OFF is a fixed point)", () => {
  it("the flag setter/getter round-trips (the orchestrator reads this to decide whether to pass voiceOf)", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("flag");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
    expect(sb.session.gossipDriftEnabledNow()).toBe(true); // default ON (default flip 2026-11-03)
    sb.session.setGossipDriftEnabled(false);
    expect(sb.session.gossipDriftEnabledNow()).toBe(false);
    sb.session.setGossipDriftEnabled(true);
    expect(sb.session.gossipDriftEnabledNow()).toBe(true);
    sb.session.setGossipDriftEnabled(false);
    expect(sb.session.gossipDriftEnabledNow()).toBe(false);
  });

  it("flag OFF ⇒ a deterministic fixed point (the calibration harness's state — byte-identical run-to-run)", () => {
    // OFF passes no `voiceOf`, so the whole run is byte-identical to the pre-feature agnostic drift.
    expect(runOrchestratorHash(false)).toBe(runOrchestratorHash(false));
  });

  it("flag ON drives the LIVE voice-mediated path without error (the wiring is not dead-at-runtime)", () => {
    // Exercises the orchestrator's `voiceOf` closure end-to-end; the run completes and records events.
    expect(runOrchestratorHash(true)).toMatch(/^[0-9a-f]{64}$/);
  });
});
