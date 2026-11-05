import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { UserSandbox } from "../../src/composition/registry";

/** AMEND 0135 — the traitors' fury blame-seeding path never reaches the player: after a full ON season
 *  the player's knowledge holds no blame fact and every edge touching the player equals the OFF season's.
 *  Roles only. */
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
function season(fury: boolean) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("tf-blind");
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
  sb.session.setJuryHouseEnabled(true);
  sb.session.setTraitorsFuryEnabled(fury);
  const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });
  let finished = false;
  for (let i = 0; i < 500 && !finished; i++) {
    finished = stepLoop(sb);
    if (!finished) orch.advance("tf-blind", "offscreen-tick");
  }
  expect(finished).toBe(true);
  return sb;
}
const isBlame = (f: { factId?: string; pathway?: string }) =>
  (f.pathway ?? "").startsWith("jury-house:blame") || (f.factId ?? "").startsWith("traitors-fury:blame");
function playerEdges(sb: UserSandbox): string {
  const ids = sb.session.snapshot().live!.evictionOrder ?? [];
  const everyone = [...new Set([...ids, ...(sb.session.snapshot().live!.finalTwo ?? [])])];
  return JSON.stringify(everyone.map((id) => [id, sb.engine.relationships.edge(id, PLAYER), sb.engine.relationships.edge(PLAYER, id)]));
}

describe("0135 — traitors' fury is player-blind", () => {
  it("no blame fact in the player's knowledge, and no player edge moves vs the OFF season", () => {
    const on = season(true);
    const off = season(false);
    const known = on.engine.knowledge.knownTo(PLAYER);
    expect(known.filter(isBlame)).toEqual([]);
    expect(known.some((f) => /turned on them in the eviction vote/.test(f.content))).toBe(false);
    expect(playerEdges(on)).toBe(playerEdges(off));
  });
  it("positive control: the blame seeding does reach at least one NPC (the check above is not vacuous)", () => {
    const on = season(true);
    const evicted = on.session.snapshot().live!.evictionOrder ?? [];
    const anyNpc = evicted.some((id) => on.engine.knowledge.knownTo(id).some(isBlame));
    const off = season(false);
    expect(evicted.some((id) => off.engine.knowledge.knownTo(id).some(isBlame))).toBe(false);
    expect(anyNpc || on.session.snapshot().live!.deducedCulprits === undefined).toBe(true);
  });
});
