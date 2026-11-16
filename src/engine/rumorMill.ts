/**
 * Feature 0157 / ORW-525 (theme 2, slice 8) - THE RUMOR MILL in the post-season retrospective. VAULT-CLASS (listed in the dependency-cruiser engine
 * denylist): it reads the engine-only claim log, which holds every claim's truth and intent.
 *
 * Its ONLY caller is `GameSessionAdapter.seasonRetrospective()`, behind the `live.finished` gate - the 0048 post-season door (mandate #2, exception 3), and
 * nothing else. Pure and deterministic: no I/O, no rng, and it only READS the log (it never writes, so what was recorded is never thinned).
 *
 * SCOPE: it covers CLAIM-PLANTED beliefs only (a belief the claim log planted, told by one houseguest to an NPC). Beliefs the engine formed by other
 * means (deduced, derived from campaigns) carry no claim and so no recorded truth; they are not covered. The belief store is capped per holder, so
 * "who started it" reads the claim log, never the store.
 *
 * A "false belief" is a group of false claims (`isTrue` false) sharing one kind, subject and second party. DEFINITIONS (deterministic):
 *  - believers: the distinct NPCs those false claims were told to (the player is not a believer: the player holds no belief, and has `toldToYou`).
 *  - starter: the speaker of the EARLIEST false claim in the group (log order). Later tellers whose intent was `inform` are `passedOn` (leaks, not
 *    starters); a later teller who meant to mislead, deflect, recruit, warn or protect is not listed as a leak.
 *  - biggest: rank by number of believers, then number of tellings, then the earliest claim; the top `RUMOR_MILL_CAP`.
 *  - aboutYou: the false groups whose subject is the player, ranked the same way.
 */
import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import type { ClaimLog, SpokenClaim, SpokenClaimKind } from "./spokenClaims";
import type { NamedRef, RumorMill, RumorMillBelief } from "../ports/GameSession";

export const RUMOR_MILL_CAP = 5;

/** What the false claim said, in plain words ("them" = each believer). */
function claimText(kind: SpokenClaimKind, subject: string, object: string | undefined): string {
  switch (kind) {
    case "targets-you": return `that ${subject} was targeting them`;
    case "voted-to-evict-you": return `that ${subject} voted to evict them`;
    case "final-two-with": return `that ${subject} had a final two with ${object}`;
    case "going-after": return `that ${subject} was going after ${object}`;
    case "talking-about": return `that ${subject} was talking about ${object} behind their back`;
    case "voted-against": return `that ${subject} voted to evict ${object}`;
    case "voted-to-keep": return `that ${subject} voted to keep ${object}`;
    case "lying-about": return object ? `that ${subject} was lying to ${object}` : `that ${subject} was lying to them`;
    case "voted-against": return `that ${subject} voted to evict ${object ?? "them"}`;
    case "voted-to-keep": return `that ${subject} voted to keep ${object ?? "them"}`;
  }
}

interface Group { first: number; claims: SpokenClaim[] }

export function buildRumorMill(log: ClaimLog | undefined, nameOf: (id: EntityId) => string): RumorMill | undefined {
  const lies = (log?.items ?? []).filter((c) => !c.isTrue);
  if (!lies.length) return undefined;
  const groups = new Map<string, Group>();
  lies.forEach((c, i) => {
    const key = `${c.kind}|${c.subject}|${c.object ?? ""}`;
    const g = groups.get(key);
    if (g) g.claims.push(c); else groups.set(key, { first: i, claims: [c] });
  });
  const ref = (id: EntityId): NamedRef => ({ id, name: nameOf(id) });
  const rows = [...groups.values()].map((g) => {
    const start = g.claims[0]!;
    const believers = [...new Set(g.claims.filter((c) => c.listener !== PLAYER).map((c) => c.listener))].sort();
    const passed = [...new Set(g.claims.slice(1).filter((c) => c.intent === "inform" && c.speaker !== start.speaker).map((c) => c.speaker))].sort();
    const row: RumorMillBelief = {
      claim: claimText(start.kind, nameOf(start.subject), start.object ? nameOf(start.object) : undefined),
      starter: ref(start.speaker), startedWeek: start.week,
      passedOn: passed.map(ref), believers: believers.map(ref),
      tellings: g.claims.length, toldToYou: g.claims.some((c) => c.listener === PLAYER),
    };
    return { g, row, subject: start.subject };
  });
  const rank = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    b.row.believers.length - a.row.believers.length || b.row.tellings - a.row.tellings || a.g.first - b.g.first;
  const top = (xs: typeof rows) => [...xs].sort(rank).slice(0, RUMOR_MILL_CAP).map((x) => x.row);
  return { biggest: top(rows), aboutYou: top(rows.filter((x) => x.subject === PLAYER)) };
}
