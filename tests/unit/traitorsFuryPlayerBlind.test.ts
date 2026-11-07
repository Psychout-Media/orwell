import { describe, it, expect, vi } from "vitest";

// P0 flip: the ON-vs-OFF fury comparison and its positive control assume the flag-off baseline for every other layer. Those layers now default ON, so this file pins them OFF explicitly (hoisted: some adapter consts read env at import). Tests that need a layer ON turn it on through its setter.
vi.hoisted(() => { for (const k of ["ORWELL_ASSURANCES", "ORWELL_VOTE_COUNT", "ORWELL_VETO_MEMORY", "ORWELL_DEAL_NOMS", "ORWELL_CAMPAIGN_MEMORY", "ORWELL_APPROACH_MEMORY", "ORWELL_HC_MEMORY", "ORWELL_MEMORY_PROMISES", "ORWELL_FORGIVENESS", "ORWELL_LOBBYING", "ORWELL_DESIRE_CLOCK", "ORWELL_WANT_MOVEMENT", "ORWELL_MULTI_NIGHT_FATIGUE", "ORWELL_MORNING_APPROACH", "ORWELL_NPC_TELLS", "ORWELL_TELL_REACTIONS", "ORWELL_MOOD_VETO", "ORWELL_MOOD_APPROACH", "ORWELL_MOOD_DEAL", "ORWELL_MOOD_CAMPAIGN", "ORWELL_DRIFT_FIX", "ORWELL_NPC_MEMORY_SPEECH", "ORWELL_DRIVE_DECISIONS"]) process.env[k] = "0"; });

// B36: this test asserts the OLD graph-diffusion path (or its neutrality / a positive control that rides it). The co-presence layer (ORWELL_GOSSIP_COPRESENCE) REPLACES that path when on, so the
// test pins the layer OFF explicitly instead of depending on the process env (the one-hop-by-scene equivalents live in copresenceSpread / copresenceScenes tests).
import { beforeAll as _b36BeforeAll, afterAll as _b36AfterAll } from "vitest";
const _b36Prev = process.env["ORWELL_GOSSIP_COPRESENCE"];
_b36BeforeAll(() => { process.env["ORWELL_GOSSIP_COPRESENCE"] = "0"; });
_b36AfterAll(() => { if (_b36Prev === undefined) delete process.env["ORWELL_GOSSIP_COPRESENCE"]; else process.env["ORWELL_GOSSIP_COPRESENCE"] = _b36Prev; });
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
function season(fury: boolean, seed = SEED) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("tf-blind");
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.setJuryHouseEnabled(true);
  sb.session.setTraitorsFuryEnabled(fury);
  const orch = new Orchestrator(reg, new FakeClock(), { seed });
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
    // Pre-show ties are rare now (ORW-132), so a given seed may deal a season where no blame lands; scan a few seeds for one where it does, and require the OFF season on that seed to carry none.
    let found = false;
    for (let seed = SEED; seed < SEED + 12 && !found; seed++) {
      const on = season(true, seed);
      const evicted = on.session.snapshot().live!.evictionOrder ?? [];
      if (!evicted.some((id) => on.engine.knowledge.knownTo(id).some(isBlame))) continue;
      const off = season(false, seed);
      expect(evicted.some((id) => off.engine.knowledge.knownTo(id).some(isBlame))).toBe(false);
      found = true;
    }
    expect(found, "some seed in the window seeds blame into an NPC with the fury ON").toBe(true);
  });
});
