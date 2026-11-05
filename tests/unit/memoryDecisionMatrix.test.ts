import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DECISION_SOURCES, UNREAD_PROVIDERS_ALLOWED, type MemoryProvider, type StrategicDecision } from "../../src/engine/memorySources";

/**
 * B7 / #2017 M0 - the DECISION x MEMORY-SOURCE gate. Scans the pure loop's source (`liveSeason.ts`) for the `ctx.<provider>` each strategic decision reads and holds it to
 * `DECISION_SOURCES`: (a) a decision reading a provider the table does not list FAILS (update the table, deliberately); (b) a listed provider that EXISTS in `SeasonCtx` but the decision no
 * longer reads FAILS; (c) any `SeasonCtx` memory-like provider (`*TiltFor` / `*PushFor` / `dealsOf` / the assurance + pitch providers) read by NO decision FAILS unless allow-listed with a reason
 * (the "write-only source" trap). Providers that do not exist on this branch yet are tolerated in the table (so feature PRs can land in either order). Roles only.
 */
const SRC = readFileSync("src/engine/liveSeason.ts", "utf8");
const ctxBody = (): string => {
  const a = SRC.indexOf("export interface SeasonCtx");
  const b = SRC.indexOf("\n}\n", a);
  return SRC.slice(a, b);
};
const interfaceMembers = (): Set<string> => new Set([...ctxBody().matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!));
const MEMORY_LIKE = /^(?:\w+TiltFor|\w+PushFor|dealsOf|assuranceVoteFor|assuranceProtects|pitchTiltFor|vetoMemoryFor|dealNomPushFor|hcMemoryFor|juryMemoryFor)$/;
const SCANNED = (Object.keys(DECISION_SOURCES) as StrategicDecision[]).filter((d): d is Exclude<StrategicDecision, "approaches"> => d !== "approaches");

function fnBody(startMarker: string, endMarker: string): string {
  const a = SRC.indexOf(startMarker);
  if (a < 0) throw new Error(`marker not found: ${startMarker}`);
  const b = SRC.indexOf(endMarker, a + startMarker.length);
  if (b < 0) throw new Error(`end marker not found: ${endMarker}`);
  return SRC.slice(a, b);
}
// `approaches` is not read in liveSeason (it is the adapter's player-facing approach ranking); it is held by approachMemory.test.ts, so the scan skips it.
const SLICES: Record<Exclude<StrategicDecision, "approaches">, () => string> = {
  evictionVote: () => fnBody("export function voteChoice(", "\n/** Count the eviction votes"),
  hohNominations: () => fnBody("const plan = nominationPlan(s.hoh!, s.active, ctx.rel, {", "const nominees = plan.nominees;"),
  replacementNominee: () => fnBody("const replacement = replacementPick(s.hoh!", "s.replacement = replacement;"),
  vetoSave: () => fnBody("// NPC veto holder: save self if nominated", "if (!saved) {"),
  houseguestsChoice: () => fnBody("function resolveVetoDraw(", "const hc = draw.houseguestsChoice;"),
  juryVote: () => fnBody("function precomputeVotes(", "return votes;"),
};
const readsOf = (body: string): Set<string> => new Set([...body.matchAll(/ctx\.(\w+)/g)].map((m) => m[1]!).filter((n) => MEMORY_LIKE.test(n)));

describe("decision x memory-source matrix (the drift gate)", () => {
  const members = interfaceMembers();
  for (const d of SCANNED) {
    it(`${d}: reads exactly the providers the table lists (among those that exist on this branch)`, () => {
      const found = readsOf(SLICES[d]());
      const listed = new Set<string>(DECISION_SOURCES[d]);
      for (const f of found) expect(listed.has(f), `${d} reads ctx.${f}, which DECISION_SOURCES does not list - update src/engine/memorySources.ts deliberately`).toBe(true);
      for (const l of listed) if (members.has(l)) expect(found.has(l), `${d} no longer reads ctx.${l}, but DECISION_SOURCES lists it`).toBe(true);
    });
  }
  it("no memory-like SeasonCtx provider is read by NO decision (the write-only source trap), unless allow-listed with a reason", () => {
    const readByAny = new Set<string>();
    for (const d of SCANNED) for (const f of readsOf(SLICES[d]())) readByAny.add(f);
    for (const m of members) {
      if (!MEMORY_LIKE.test(m)) continue;
      const allowed = (UNREAD_PROVIDERS_ALLOWED as Record<string, string | undefined>)[m];
      expect(readByAny.has(m) || !!allowed, `SeasonCtx.${m} is read by no strategic decision - wire it or allow-list it with a reason in UNREAD_PROVIDERS_ALLOWED`).toBe(true);
    }
  });
  it("the table is the only declaration: every decision has at least the campaign or memory source or is a known gap", () => {
    for (const d of Object.keys(DECISION_SOURCES) as StrategicDecision[]) expect(DECISION_SOURCES[d].length).toBeGreaterThan(0);
  });
});
