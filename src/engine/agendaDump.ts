/**
 * ORW-313 (ORW-253 slice 1, spec 0145) - the debug-dump rendering of NPC agendas. VAULT-CLASS (listed in the dependency-cruiser engine denylist with agenda.ts): an agenda is secret state.
 *
 * Its ONLY reader outside the engine is the owner-ruled DEBUG `producerVault` unseal (CLAUDE.md mandate #2, door 1; admin channel only, out-of-band, behind the explicit FE unseal). It rides that dump and nothing
 * else: not the post-season retrospective view, not any advertised tool, not the player channel. Pure and deterministic; names only (no raw ids / slugs cross), so a person can read it on a phone.
 * Ryne 2026-11-12: "an admin debug view through the sanctioned producerVault door only" - to check during play that goals form, hold and resolve the way the design says.
 */
import type { EntityId } from "../domain/ids";
import type { Agenda, Cause, Goal, SuccessTest } from "./agenda";
import type { AgendaDumpGoal, AgendaDumpHouseguest } from "../ports/GameSession";

export type { AgendaDumpGoal, AgendaDumpHouseguest };

const pct = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 100);
const label = (s: string): string => s.replace(/-/g, " ");

function causeLine(c: Cause, nameOf: (id: EntityId) => string, scrub: (s: string) => string): string {
  const parts = [label(c.kind)];
  if (c.about) parts.push(`about ${nameOf(c.about)}`);
  if (c.ref) parts.push(`(${scrub(c.ref)})`);
  parts.push(`weight ${pct(c.weight)}%`);
  return parts.join(" ");
}

function testLine(t: SuccessTest, nameOf: (id: EntityId) => string): string {
  switch (t.kind) {
    case "evicted": return `${nameOf(t.who)} is evicted while the holder is still playing`;
    case "survives-week": return "the holder is still in the house when the week closes";
    case "allied-with": return `${nameOf(t.who)} is in an alliance with the holder`;
    case "still-in": return `${nameOf(t.who)} is still in the house when the week closes`;
    case "holds-power": return "the holder is HOH or veto holder this week";
    case "question-answered": return "an open question the holder had is answered";
    case "reaches-jury": return "the jury phase starts with the holder still playing";
    case "final-two-alliance": return "both finalists are the holder or the holder's alliance mates";
    case "reaches-final-two": return `${nameOf(t.who)} makes the final two`;
    case "wins": return "the holder wins the season";
    case "wins-power-once": return "the holder wins HOH or veto at least once";
    case "secret-kept": return "the holder's secret is never exposed";
    case "cut-later": return `${nameOf(t.who)} leaves after ${t.stage === "jury" ? "the jury starts" : "the final five"}, with the holder still in`;
  }
}

function goalRow(g: Goal, nameOf: (id: EntityId) => string, scrub: (s: string) => string): AgendaDumpGoal {
  return {
    horizon: g.horizon,
    kind: label(g.kind),
    ...(g.target ? { target: nameOf(g.target) } : {}),
    why: g.why.map((c) => causeLine(c, nameOf, scrub)),
    test: testLine(g.test, nameOf),
    commitment: pct(g.commitment),
    status: g.status,
    formed: `week ${g.formedWeek}, day ${g.formedDay}`,
    ...(g.resolvedDay !== undefined ? { resolved: `day ${g.resolvedDay}` } : {}),
    ...(g.endNote ? { endNote: scrub(g.endNote) } : {}),
  };
}

/** One block per houseguest who holds an agenda, in id order; empty when the season has none (an unplayed game). `scrub` is the dump's own name-resolving scrubber for free-text engine words. */
export function agendaDumpRows(
  agendas: Readonly<Record<EntityId, Agenda>> | undefined,
  nameOf: (id: EntityId) => string,
  scrub: (s: string) => string = (s) => s,
): AgendaDumpHouseguest[] {
  if (!agendas) return [];
  return Object.keys(agendas).sort().map((owner) => {
    const a = agendas[owner as EntityId]!;
    return {
      houseguest: nameOf(owner as EntityId),
      goals: a.goals.map((g) => goalRow(g, nameOf, scrub)),
      history: a.history.map((g) => goalRow(g, nameOf, scrub)),
    };
  });
}
