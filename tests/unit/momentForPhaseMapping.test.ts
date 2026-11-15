import { describe, it, expect } from "vitest";
import { momentForPhase, momentFragment } from "../../src/engine/momentPrompts";

// Batch C gate #5 (2026-07-11 narrator-prompt audit) — momentForPhase MAPPING AUDIT.
//
// The gap the audit found (finding 7): `momentForPhase` routed the Final-3 `final-eviction` phase
// through its `includes("evict")` fall-through to the ordinary `eviction` fragment — which scripts
// the SECRET-BALLOT staged drip (read ONE anonymized ballot per turn, build the count…). But the
// final eviction is NOTHING like that: the final HOH casts the SOLE, OPEN deciding vote — no ballot,
// no drip, no tally. So the narrator was handed a fragment whose mechanics were WRONG for the beat.
//
// This table-driven gate pins each structural phase to the fragment it maps to AND asserts that
// fragment's mechanics claims actually HOLD for that beat — so a mapping that lands a beat on a
// fragment describing the wrong ceremony fails here.
describe("momentForPhase mapping audit (Batch C #5 — each phase → a fragment whose mechanics hold)", () => {
  interface Row {
    phase: string;
    moment: string;
    /** Claims the mapped fragment MUST make (the beat's real mechanics). */
    holds: RegExp[];
    /** Claims the mapped fragment must NOT make (another beat's mechanics). */
    absent?: RegExp[];
  }

  const table: Row[] = [
    {
      phase: "hoh-competition",
      moment: "hoh-competition",
      holds: [/Head of Household competition/i, /advanceGame/, /runCompetition/],
    },
    {
      phase: "nominations",
      moment: "nominations",
      holds: [/Nomination ceremony/i, /two nominees/i, /recordInteraction/],
    },
    {
      phase: "veto-competition",
      moment: "veto-competition",
      // ORW-281 slice 1: the chip draw is its own 'veto-draw' ceremony moment now (tests/unit/momentFramingFixes.test.ts pins its ritual there); the competition fragment keeps the play itself.
      holds: [/Power of Veto competition/i, /SIX houseguests play/i],
    },
    {
      phase: "veto-ceremony",
      moment: "veto-ceremony",
      holds: [/Veto ceremony/i, /replacement/i],
    },
    {
      // The ordinary weekly eviction IS the secret-ballot staged drip.
      phase: "eviction",
      moment: "eviction",
      holds: [/SECRET BALLOT/i, /STAGED/i, /anonymized/i],
    },
    {
      // Finding 7: the Final-3 eviction is the final HOH's SOLE, OPEN vote — it must NOT inherit the
      // eviction fragment's secret-ballot drip. This is the core assertion of the whole gate.
      phase: "final-eviction",
      moment: "final-eviction",
      holds: [/SOLE deciding vote/i, /no ballot drip/i, /cast OPENLY/i],
      absent: [/STAGED/i, /each advanceGame hands you ONE anonymized ballot/i],
    },
    {
      // The underscore variant the audit fix also guards (a phase string could arrive either way).
      phase: "final_eviction",
      moment: "final-eviction",
      holds: [/SOLE deciding vote/i],
    },
    {
      phase: "finale",
      moment: "jury-finale",
      holds: [/Jury & finale/i, /jury vote/i],
    },
    {
      // The bare "jury" phase is its OWN moment (the player-JUROR watching from sequester) — it must
      // NOT collapse into the "jury-finale" ceremony fragment. `jury` is an exact moment key, so it
      // wins over the `includes("jury")` fall-through; this pins that distinction.
      phase: "jury",
      moment: "jury",
      holds: [/jury seat/i, /sequester/i],
      absent: [/final statements/i],
    },
    {
      // A jury-ish finale phase string (not the bare key) DOES route to the ceremony fragment.
      phase: "jury-vote",
      moment: "jury-finale",
      holds: [/jury vote/i],
    },
    {
      phase: "setup",
      moment: "character-creation",
      holds: [/casting interview/i],
    },
    {
      phase: "premiere",
      moment: "premiere",
      holds: [/Premiere night/i],
    },
  ];

  for (const row of table) {
    it(`phase "${row.phase}" → "${row.moment}" fragment, mechanics correct`, () => {
      expect(momentForPhase(row.phase)).toBe(row.moment);
      const fragment = momentFragment(momentForPhase(row.phase));
      for (const re of row.holds) {
        expect(fragment, `"${row.phase}" fragment must claim ${re}`).toMatch(re);
      }
      for (const re of row.absent ?? []) {
        expect(
          re.test(fragment),
          `"${row.phase}" fragment must NOT carry ${re} (that belongs to a different beat)`,
        ).toBe(false);
      }
    });
  }

  it("final-eviction does NOT fall through to the secret-ballot eviction fragment (finding 7)", () => {
    // The exact regression: `includes("evict")` used to route final-eviction to `eviction`.
    expect(momentForPhase("final-eviction")).not.toBe("eviction");
    // The two fragments describe genuinely different mechanics — prove they are distinct text.
    expect(momentFragment("final-eviction")).not.toBe(momentFragment("eviction"));
  });
});
