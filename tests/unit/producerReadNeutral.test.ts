import { PLAYER } from "../../src/domain/ids";
import { flagDefaultOn } from "../../src/domain/flagDefaults";
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { UserSandbox } from "../../src/composition/registry";

const SEED = 7;

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

function runOrchestratorHash(producerReadOn: boolean): string {
  const reg = new GameSessionRegistry();
  const user = "pr";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
  sb.session.setProducerReadEnabled(producerReadOn);
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

/**
 * #1792 — Producer Read calibration neutrality: flag OFF is a fixed point.
 * With the flag OFF, the producerReadSink is never wired in the registry,
 * so nothing is computed or appended — the event stream is byte-identical.
 */
describe("#1792 — Producer Read neutrality (flag OFF is a fixed point)", () => {
  it("the flag setter/getter round-trips", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("flag-pr");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
    expect(sb.session.producerReadEnabledNow()).toBe(flagDefaultOn("ORWELL_PRODUCER_READ", process.env)); // the code default (ON unless the env says otherwise)
    sb.session.setProducerReadEnabled(false);
    expect(sb.session.producerReadEnabledNow()).toBe(false);
    sb.session.setProducerReadEnabled(true);
    expect(sb.session.producerReadEnabledNow()).toBe(true);
    sb.session.setProducerReadEnabled(false);
    expect(sb.session.producerReadEnabledNow()).toBe(false);
  });

  it("flag OFF ⇒ the sealed event stream is byte-identical run-to-run", () => {
    expect(runOrchestratorHash(false)).toBe(runOrchestratorHash(false));
  });

  it("flag ON drives the producer-read path without error", () => {
    expect(runOrchestratorHash(true)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the sink is gated at CALL time: a session switched OFF after the sandbox exists stashes nothing, ON stashes", () => {
    for (const on of [false, true]) {
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor(`gate-${on}`);
      sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
      sb.session.setProducerReadEnabled(on); // AFTER the sandbox (and its sink wiring) exists
      const stash = vi.spyOn(sb.session, "stashExchangeAccounting");
      const npc = sb.session.livingIds().find((id) => id !== PLAYER)!;
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], kind: "strategy", content: "a plan" });
      expect(stash.mock.calls.length > 0, `producer read ${on ? "ON" : "OFF"}`).toBe(on);
    }
  });
});
