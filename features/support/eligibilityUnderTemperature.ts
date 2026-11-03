import assert from "node:assert/strict";
import { resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import type { Competitor } from "../../src/domain/competitionOutcome";
import { TEMPERATURE_CONSTANTS } from "../../src/domain/temperatureConstants";
import { eligibleForHOH, selectableReplacements } from "../../src/domain/eligibility";
import type { WeekState } from "../../src/domain/eligibility";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/** Temperature turned UP so far it swamps every stat: if it could ever override a hard rule, this is where it would. */
const LOUD = {
  ...TEMPERATURE_CONSTANTS,
  outcome: { ...TEMPERATURE_CONSTANTS.outcome, temperature: 50 },
};

/**
 * 0005/0006 — "temperature never overrides an eligibility hard rule", exercised through the real path:
 * the HOH field is whatever `eligibleForHOH` returns, the replacement pool is whatever `selectableReplacements`
 * returns, and a competition is resolved over that field across many seeds under a deafening temperature weight.
 * The outgoing HOH is given the BEST stats, so if they were ever let back in they would be crowned (or at least
 * rolled a temperature) — the assertion fails the moment the rule stops excluding them.
 */
export function assertHardRulesSurviveTemperature(week: WeekState, seeds = 300): void {
  const outgoing = week.outgoingHoh!;
  const vetoWinner = week.vetoWinner!;
  assert.ok(outgoing && vetoWinner, "the scenario needs an outgoing HOH and a veto winner to mean anything");
  const eligible = eligibleForHOH(week);
  const field: Competitor[] = eligible.map((id) => ({ id, stats: { physical: 0.5, mental: 0.5, social: 0.5 } }));
  // The excluded houseguest is the strongest in the house — the one temperature would most want to hand the crown to.
  const strongest: Competitor = { id: outgoing, stats: { physical: 1, mental: 1, social: 1 } };
  const rawField = [strongest, ...field.filter((c) => c.id !== outgoing)];
  assert.equal(rawField.length, week.houseguests.length, "sanity: the unfiltered field is the whole house");
  assert.equal(field.length, rawField.length - 1, "the eligible field is exactly the house minus the outgoing HOH");

  for (let seed = 1; seed <= seeds; seed++) {
    const r = resolveCompetition(field, "physical", new CompetitionIntents(), new SeededRandom(seed), LOUD);
    assert.notEqual(r.winner, outgoing, `seed ${seed}: the outgoing HOH was crowned despite the hard rule`);
    assert.ok(!(outgoing in r.scores) && !(outgoing in r.temperature), `seed ${seed}: the outgoing HOH was rolled a temperature`);
    // The replacement draw: whatever temperature does, the pool the HOH picks from never contains the veto winner.
    const pool = selectableReplacements(week);
    assert.ok(!pool.includes(vetoWinner), "the veto winner is in the replacement pool");
    const pickRoll = new SeededRandom(seed).pick(pool);
    assert.notEqual(pickRoll, vetoWinner, `seed ${seed}: a roll landed the veto winner as the replacement`);
  }
}
