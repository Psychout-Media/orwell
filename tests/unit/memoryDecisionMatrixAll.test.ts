import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { OTHER_DECISION_READS, OTHER_DECISION_GAPS, type OtherDecision } from "../../src/engine/memorySources";

/** B52 (AMEND 3b): the drift gate extended to every remaining decision. For each, the memory-like tokens its source slice reads must equal the table, both ways. Roles only. */
const LS = readFileSync("src/engine/liveSeason.ts", "utf8");
const GA = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
const WATCH = [
  "voteChoice", "memoryTiltFor", "beliefTiltFor", "campaignPushFor", "campaignTiltFor", "drivePushFor", "moodTiltFor", "moodVetoFor", "dealsOf", "assuranceVoteFor", "assuranceProtects", "pitchTiltFor",
  "memoryGrudge", "memoryFavor", "targetsMeTilt", "moodDealFor", "moodApproachFor", "desireFor", "applyWantToPulls", "ownBallotLean", "tellsOf", "drives.get",
  "byThreat", "nominationScore", "bondStrength", "edgeAsJuryRel", "mannerFor", "gameRespectTerm", "appealPerf", "jurorProfile",
];
function slice(src: string, a: string, b: string): string {
  const i = src.indexOf(a);
  if (i < 0) throw new Error(`marker not found: ${a}`);
  const j = src.indexOf(b, i + a.length);
  if (j < 0) throw new Error(`end marker not found: ${b}`);
  return src.slice(i, j);
}
const SLICES: Record<OtherDecision, () => string> = {
  tieBreak: () => slice(LS, 'if (s.hoh === ctx.player) { s.pending = { kind: "tie-break"', "return commitStagedEviction(s, ctx, evictee, rng);"),
  jury: () => slice(LS, "function precomputeVotes(", "return votes;"),
  final3Eviction: () => slice(LS, 'return { kind: "final-eviction", evict: byThreat(p.by, p.options) };', "};"),
  secretVetoReplacement: () => slice(LS, "function playSecretVeto(", "s.finalNominees = [staying, replacement];"),
  dealConsent: () => slice(GA, "private dealConsentRefusal(", "return d.accept"),
  movement: () => slice(GA, "private movementIntentFor(", "return pulls.length ? pulls : null;"),
};
const stripComments = (b: string): string => b.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""); // a name only MENTIONED in a comment is not a read
const readsOf = (body: string): Set<string> => new Set(WATCH.filter((t) => new RegExp(`(?<![\\w])${t.replace(".", "\\.")}(?![\\w])`).test(stripComments(body))));

describe("the drift gate, every remaining decision (B52)", () => {
  for (const d of Object.keys(SLICES) as OtherDecision[]) {
    it(`${d}: reads exactly the tokens the table lists, and its gap is written down`, () => {
      const found = readsOf(SLICES[d]());
      const listed = new Set<string>(OTHER_DECISION_READS[d]);
      for (const f of found) expect(listed.has(f), `${d} reads ${f}, which OTHER_DECISION_READS does not list - update src/engine/memorySources.ts deliberately`).toBe(true);
      for (const l of listed) expect(found.has(l), `${d} no longer reads ${l}, but OTHER_DECISION_READS lists it`).toBe(true);
      expect(OTHER_DECISION_GAPS[d].length).toBeGreaterThan(20);
    });
  }
});
