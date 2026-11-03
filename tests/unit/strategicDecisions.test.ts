import { describe, it, expect } from "vitest";
import { nominationStrategy, nominationPlan, replacementPick, politicalTemperature, chooseNominations } from "../../src/engine/season";
import { voteChoice } from "../../src/engine/liveSeason";
import type { SeasonCtx } from "../../src/engine/liveSeason";
import { DECISION } from "../../src/engine/decisionConstants";
import { detectBlocs } from "../../src/engine/blocs";
import { RelationshipModel } from "../../src/engine/relationships";
import { DealLedger } from "../../src/engine/deals";
import { GameSessionRegistry } from "../../src/composition/registry";
import { npc, PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0044 — strategic nomination & vote refinements. Roles only — no fixture names.
 * The nomination/vote engines stay engine-decided + seeded; these tests pin the new strategic
 * dimensions (pawn/backdoor/bloc-protection noms; bloc/mood/deal-aware votes) and their bounds.
 */
const hoh = npc(7);

/** A QUIET house: the HOH holds distinct private reads, the rest of the house reads baseline. */
function quietHouse(): { rel: RelationshipModel; active: EntityId[] } {
  const rel = new RelationshipModel(0.5);
  const active = [hoh, npc(1), npc(2), npc(3), npc(4)];
  rel.edge(hoh, npc(1)).threat = 0.6;  // the target — the HOH's top private read
  rel.edge(hoh, npc(2)).threat = 0.5;
  rel.edge(hoh, npc(3)).threat = 0.4;
  rel.edge(hoh, npc(4)).threat = 0.15; // the obvious pawn
  return { rel, active };
}

/** A minimal SeasonCtx for the pure vote read. */
function voteCtx(rel: RelationshipModel, extra: Partial<SeasonCtx> = {}): SeasonCtx {
  return {
    player: PLAYER,
    statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }),
    rel,
    ...extra,
  };
}

describe("strategic nominations (0044 §4 — beyond raw threat)", () => {
  it("a schemer (clash) backdoors: the top threat stays OFF the block", () => {
    const { rel, active } = quietHouse();
    const noms = nominationStrategy(hoh, active, rel, { disposition: "clash" });
    expect(noms).not.toContain(npc(1));               // the real target is left off as the backdoor plan
    expect(noms.sort()).toEqual([npc(2), npc(3)].sort()); // the bait: the next two reads go up
    expect(noms).not.toEqual(chooseNominations(hoh, active, rel)); // ≠ the bare top-2-threat read
  });

  it("a loyalist (bond) sits a pawn beside the target", () => {
    const { rel, active } = quietHouse();
    const noms = nominationStrategy(hoh, active, rel, { disposition: "bond" });
    expect(noms).toContain(npc(1)); // threat still dominates WHO the target is
    expect(noms).toContain(npc(4)); // …but the seat beside them is the lowest read, not the second threat
  });

  it("a neutral HOH plays direct — byte-identical to the built threat-primary read", () => {
    const { rel, active } = quietHouse();
    expect(nominationStrategy(hoh, active, rel)).toEqual(chooseNominations(hoh, active, rel));
  });

  it("a runaway threat (hot political temperature) forces even a schemer direct", () => {
    const { rel, active } = quietHouse();
    expect(politicalTemperature(active, rel).runaway).toBe(false); // private reads alone stay quiet
    for (const reader of active) if (reader !== npc(1)) rel.edge(reader, npc(1)).threat = 0.95;
    const temp = politicalTemperature(active, rel);
    expect(temp.runaway).toBe(true);
    expect(temp.spread).toBeGreaterThan(DECISION.nomination.runawaySpread);
    const noms = nominationStrategy(hoh, active, rel, { disposition: "clash" });
    expect(noms).toContain(npc(1)); // the tactical games wait — the house moves on the runaway NOW
  });

  it("bloc-mates stay off the block — even as the pawn (0043 protection)", () => {
    const { rel, active } = quietHouse();
    // The HOH's bloc: two mates with iron mutual bonds and near-zero threat reads (pawn bait).
    for (const m of [npc(3), npc(4)]) {
      const a = rel.edge(hoh, m); a.trust = 0.9; a.affinity = 0.9; a.threat = 0.05;
      const b = rel.edge(m, hoh); b.trust = 0.9; b.affinity = 0.9;
    }
    const c = rel.edge(npc(3), npc(4)); c.trust = 0.9; c.affinity = 0.9;
    const d = rel.edge(npc(4), npc(3)); d.trust = 0.9; d.affinity = 0.9;
    const blocs = detectBlocs({ rel, active, loyaltyOf: () => 0.9 });
    expect(blocs[0]?.members).toContain(hoh);
    const noms = nominationStrategy(hoh, active, rel, { disposition: "bond", blocs });
    expect(noms).not.toContain(npc(3));
    expect(noms).not.toContain(npc(4)); // the cheapest pawn is a mate — still never nominated
    expect(noms.sort()).toEqual([npc(1), npc(2)].sort());
  });

  it("nominations remain legal under the 0005 rules for every tactic", () => {
    const { rel, active } = quietHouse();
    for (const disposition of ["bond", "neutral", "clash"] as const) {
      const [a, b] = nominationStrategy(hoh, active, rel, { disposition });
      expect(a).not.toBe(b);
      expect(a).not.toBe(hoh);
      expect(b).not.toBe(hoh);
      expect(active).toContain(a);
      expect(active).toContain(b);
    }
  });
});

describe("the replacement branches on the stored HOH target (#1948, 0044 §9)", () => {
  /**
   * A house where the pawn-seat read and the top-score read DISAGREE, so the stored-target branch and the legacy
   * score inference give DIFFERENT answers: everyone except `npc 5` is mutually bonded, so `npc 5` is the
   * isolated floater the pawn seat reaches for, while `npc 2` is the top strategic read.
   */
  function splitHouse(threats: Record<number, number>): { rel: RelationshipModel; active: EntityId[] } {
    const rel = new RelationshipModel(0.5);
    const ids = [1, 2, 3, 4, 5, 6];
    const active = [hoh, ...ids.map(npc)];
    const base: Record<number, number> = { 1: 0.6, 2: 0.5, 3: 0.4, 4: 0.15, 5: 0.3, 6: 0.35 };
    for (const [k, v] of Object.entries({ ...base, ...threats })) rel.edge(hoh, npc(Number(k))).threat = v;
    for (const a of [1, 2, 3, 4, 6]) for (const b of [1, 2, 3, 4, 6]) {
      if (a === b) continue;
      rel.edge(npc(a), npc(b)).trust = 0.95;
      rel.edge(npc(a), npc(b)).affinity = 0.95;
    }
    return { rel, active };
  }
  const options = [npc(2), npc(3), npc(5)];

  it("nominationPlan reports the target: on the block for a direct/pawn plan, OFF it for a backdoor", () => {
    const { rel, active } = quietHouse();
    const direct = nominationPlan(hoh, active, rel);
    expect(direct.target).toBe(direct.nominees[0]);
    const backdoor = nominationPlan(hoh, active, rel, { disposition: "clash" });
    expect(backdoor.nominees).not.toContain(backdoor.target);
    // nominationStrategy stays the same pair (no behavior change for existing callers).
    expect(nominationStrategy(hoh, active, rel, { disposition: "clash" })).toEqual(backdoor.nominees);
  });

  it("target SAVED (or a backdoor) while the remaining pawn outscores every option ⇒ a new TARGET — where the score inference wrongly names another pawn", () => {
    const { rel, active } = splitHouse({ 4: 0.95 }); // the pawn left on the block (npc 4) now outscores the options
    // By identity: the stored target (npc 1) is not the one still up ⇒ the top strategic read among the options.
    expect(replacementPick(hoh, npc(4), options, active, rel, { target: npc(1) })).toBe(npc(2));
    // The legacy inference reads "the remaining nominee outscores everyone ⇒ they're the target" and names a PAWN.
    expect(replacementPick(hoh, npc(4), options, active, rel)).toBe(npc(5));
  });

  it("target STILL UP but outscored by an option ⇒ a new PAWN — where the score inference wrongly names a new target", () => {
    const { rel, active } = splitHouse({ 1: 0.2, 5: 0.4 }); // the stored target (npc 1) has cooled below the options
    // By identity: the target is still on the block ⇒ the pawn seat (the isolated floater, npc 5).
    expect(replacementPick(hoh, npc(1), options, active, rel, { target: npc(1) })).toBe(npc(5));
    // The legacy inference reads "an option outscores the remaining nominee ⇒ the target came down" ⇒ the top read.
    expect(replacementPick(hoh, npc(1), options, active, rel)).toBe(npc(2));
  });

  it("without a stored target it is the legacy score inference, unchanged (a human HOH's nominations, an old save)", () => {
    const { rel, active } = splitHouse({ 4: 0.95 });
    expect(replacementPick(hoh, npc(4), options, active, rel)).toBe(replacementPick(hoh, npc(4), options, active, rel, {}));
  });
});

describe("political temperature — true median (issue #587: even-length house)", () => {
  /** Pin each houseguest's MENACE (the mean threat the rest of the house reads in them) to an
   *  exact value by giving every other reader an identical incoming threat edge toward them. */
  function houseWithMenaces(menaces: readonly number[]): { active: EntityId[]; rel: RelationshipModel } {
    const active = menaces.map((_, i) => npc(i + 1));
    const rel = new RelationshipModel(0.5);
    active.forEach((target, i) => {
      for (const reader of active) if (reader !== target) rel.edge(reader, target).threat = menaces[i]!;
    });
    return { active, rel };
  }

  it("averages the two central reads for an even-length house (falsifier [0,0,0.4,0.4] ⇒ median 0.2)", () => {
    // runawaySpread is 0.3; true median 0.2 ⇒ spread 0.4-0.2 = 0.2 (calm). The old upper-central
    // pick took reads[2]=0.4 ⇒ spread 0, biasing the read calmer still (the runaway under-trip).
    const { active, rel } = houseWithMenaces([0, 0, 0.4, 0.4]);
    const temp = politicalTemperature(active, rel);
    expect(temp.spread).toBeCloseTo(0.2, 10);
    expect(temp.runaway).toBe(false);
  });

  it("the corrected median can flip runaway ON where the upper-central pick masked it", () => {
    // Even-length house. True median of [0,0,0.1,0.9] is 0.05 ⇒ spread 0.85 > 0.3 ⇒ runaway.
    // The old pick took reads[2]=0.1 ⇒ spread 0.8 (still runaway here) — but the general bias was
    // DOWNWARD; this pins that the proper median strictly raises the spread for an even house.
    const { active, rel } = houseWithMenaces([0, 0, 0.1, 0.9]);
    const temp = politicalTemperature(active, rel);
    expect(temp.spread).toBeCloseTo(0.85, 10);
    expect(temp.runaway).toBe(true);
  });

  it("odd-length houses keep the single central read (unchanged path)", () => {
    // Median of [0,0,0.4] is the central 0 ⇒ spread 0.4-0 = 0.4 > 0.3 ⇒ runaway.
    const { active, rel } = houseWithMenaces([0, 0, 0.4]);
    const temp = politicalTemperature(active, rel);
    expect(temp.spread).toBeCloseTo(0.4, 10);
    expect(temp.runaway).toBe(true);
  });
});

describe("the enriched vote (0044 §4 — bloc + mood + deal + jury management)", () => {
  it("a rattled voter breaks a deal out of self-protection a calm voter honors", () => {
    const rel = new RelationshipModel(0.5);
    const voter = npc(5);
    const [a, b] = [npc(1), npc(2)];
    rel.edge(voter, a).threat = 0.6;  // the personally-scarier nominee — but deal-protected
    rel.edge(voter, b).threat = 0.38;
    const ledger = new DealLedger();
    const deal = ledger.make([voter, a], "vote", "vote-protection");
    const dealsOf = (id: EntityId): ReturnType<DealLedger["open"]> =>
      ledger.open().filter((d) => d.condition.promisors.includes(id));
    const calm = voteCtx(rel, { dealsOf, emotionalOf: () => 0.5 });
    expect(voteChoice(voter, [a, b], calm)).toBe(b); // the open deal is honored
    const rattled = voteCtx(rel, { dealsOf, emotionalOf: (id) => (id === voter ? 0 : 0.5) });
    expect(voteChoice(voter, [a, b], rattled)).toBe(a); // nerves shout down the promise
    // And the break is the ENGINE's to reconcile — with its full consequence (0039), never prose.
    const { broken } = ledger.reconcile({ actor: voter, kind: "vote-evict", targets: [a] });
    expect(broken).toContainEqual(expect.objectContaining({ id: deal.id, status: "broken" }));
  });

  it("a bloc-aligned voter votes WITH the bloc over their own raw read", () => {
    const rel = new RelationshipModel(0.5);
    const trio = [npc(1), npc(2), npc(3)];
    for (const x of trio) for (const y of trio) if (x !== y) {
      const e = rel.edge(x, y); e.trust = 0.85; e.affinity = 0.85;
    }
    const enemy = npc(8);
    for (const m of trio) rel.edge(m, enemy).threat = 0.9; // the shared enemy
    const voter = trio[0]!;
    const other = npc(9);
    rel.edge(voter, enemy).threat = 0.2;  // the VOTER privately reads the enemy as harmless…
    rel.edge(voter, other).threat = 0.3;  // …and the other nominee as slightly scarier
    const active = [...trio, enemy, other];
    const blocs = detectBlocs({ rel, active, loyaltyOf: () => 0.9 });
    const ctx = voteCtx(rel);
    expect(voteChoice(voter, [enemy, other], ctx)).toBe(other);        // alone: their own read
    expect(voteChoice(voter, [enemy, other], ctx, blocs)).toBe(enemy); // in the bloc: the bloc's enemy
  });

  it("light jury management shades a near-tie away from making a bitter juror", () => {
    const rel = new RelationshipModel(0.5);
    const voter = npc(5);
    const [x, y] = [npc(1), npc(2)];
    rel.edge(voter, x).threat = 0.5;
    rel.edge(voter, y).threat = 0.5;   // a dead heat on threat…
    rel.edge(x, voter).trust = 0.9;    // …but this nominee still TRUSTS the voter
    rel.edge(y, voter).trust = 0.1;
    expect(voteChoice(voter, [x, y], voteCtx(rel))).toBe(y); // don't make a bitter juror needlessly
  });

  it("the mood term is bounded: it scales the threat read, it never invents one", () => {
    const rel = new RelationshipModel(0.5);
    const voter = npc(5);
    const [a, b] = [npc(1), npc(2)];
    rel.edge(voter, a).threat = 0.8;
    rel.edge(voter, b).threat = 0.1;
    // Fully rattled or fully calm, a decisive threat gap is never flipped by mood alone.
    for (const mood of [0, 0.25, 0.5, 0.75, 1]) {
      expect(voteChoice(voter, [a, b], voteCtx(rel, { emotionalOf: () => mood }))).toBe(a);
    }
  });
});

describe("engine-decided, deterministic, Vault-free (0044 §6)", () => {
  it("the same seed plays the same nominations and votes (two live games compared)", () => {
    const run = (user: string): string[] => {
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor(user);
      const s = sb.session;
      s.createCharacter({ playerName: "The Player", seed: 21 });
      const trail: string[] = [];
      for (let i = 0; i < 160; i++) {
        const v = s.advanceGame();
        if (v.pending) {
          const p = v.pending;
          if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
          else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
          else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
          else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
        }
        const status = s.gameStatus();
        if (status.nominees.length === 2) {
          trail.push(`${status.week}:${status.hoh?.id}:${status.nominees.map((n) => n.id).sort().join("+")}`);
        }
        if (v.status.week >= 4 || v.finished) break;
      }
      return trail;
    };
    const a = run("det-a");
    const b = run("det-b");
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it("no strategy vocabulary, score, or magnitude crosses to any player surface", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("strat-wall");
    const s = sb.session;
    s.createCharacter({ playerName: "The Player", seed: 9 });
    for (let i = 0; i < 40; i++) {
      const v = s.advanceGame();
      if (v.pending) {
        const p = v.pending;
        if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
        else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
        else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
        else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
      }
      if (v.status.week >= 2) break;
    }
    const surface = JSON.stringify([s.getGameState(), s.gameStatus(), s.advanceGame()]);
    // The hidden strategy layer: none of its vocabulary or numbers may appear outward.
    expect(surface).not.toMatch(/backdoor|tactic|paranoia|dealHonor|juryManagement|moodSelfProtect|politicalTemperature|runaway/i);
    expect(surface).not.toMatch(/"score"|"threat"|"trust"|"affinity"|"loyalty/);
  });

  it("every magnitude lives in the single decisionConstants module", () => {
    expect(DECISION.nomination.paranoiaWeight).toBeGreaterThan(0);
    expect(DECISION.nomination.runawaySpread).toBeGreaterThan(0);
    expect(DECISION.vote.moodSelfProtectWeight).toBeGreaterThan(0);
    expect(DECISION.vote.dealHonorWeight).toBeGreaterThan(0);
    expect(DECISION.vote.juryManagementWeight).toBeGreaterThan(0);
    expect(DECISION.vote.juryManagementWeight).toBeLessThan(DECISION.vote.dealHonorWeight); // "light" stays light
    expect(Object.keys(DECISION.nomination.tacticFor).sort()).toEqual(["bond", "clash", "neutral"]);
  });
});
