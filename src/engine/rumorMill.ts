/**
 * Feature 0157 / ORW-525 (theme 2, slice 8) - THE RUMOR MILL in the post-season retrospective. VAULT-CLASS (listed in the dependency-cruiser engine
 * denylist): it reads the engine-only claim log, which holds every claim's truth and intent.
 *
 * Its ONLY caller is `GameSessionAdapter.seasonRetrospective()`, behind the `live.finished` gate - the 0048 post-season door (mandate #2, exception 3), and
 * nothing else. Pure and deterministic: no I/O, no rng, and it only READS the log (it never writes, so what was recorded is never thinned).
 *
 * SCOPE: `biggest` covers CLAIM-PLANTED beliefs only (a belief the claim log planted, told by one houseguest to an NPC). `aboutYou` is WIDER: it also
 * counts beliefs the engine formed some other way (witnessed, deduced, gossip, derived from campaigns) that an NPC holds about the PLAYER, when the engine's
 * own records (`truthOf`, houseSpeech.ts) say the believed fact is false. The belief store is capped per holder, so "who started it" reads the claim log
 * first; a belief-only row names the belief's recorded source, else the holder (they worked it out themselves).
 *
 * A "false belief" is a group of false claims (`isTrue` false) sharing one kind, subject and second party. DEFINITIONS (deterministic):
 *  - believers: the distinct NPCs those false claims were told to (the player is not a believer: the player holds no belief, and has `toldToYou`).
 *  - starter: the speaker of the EARLIEST false claim in the group (log order). Later tellers whose intent was `inform` are `passedOn` (leaks, not
 *    starters); a later teller who meant to mislead, deflect, recruit, warn or protect is not listed as a leak.
 *  - biggest: rank by number of believers, then number of tellings, then the earliest claim; the top `RUMOR_MILL_CAP`.
 *  - aboutYou: the false groups whose subject is the player, ranked the same way. A held (unrefuted, value true) belief about the player that has a claim
 *    form (`claimFromBelief`) and that `truthOf` says is false joins the group with the same kind and second party (its holder becomes a believer); a
 *    group with no spoken claim is belief-only (tellings = its believers, startedWeek = its earliest belief). Player-held beliefs never count.
 */
import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import type { ClaimLog, SpokenClaim, SpokenClaimKind } from "./spokenClaims";
import { claimsOf, type BeliefStore } from "./beliefStore";
import { claimFromBelief, truthOf, type TruthFacts } from "./houseSpeech";
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
    case "lying-about": return object ? `that ${subject} was lying to ${object}` : `that ${subject} was lying to them`;
    case "voted-against": return `that ${subject} voted to evict ${object ?? "them"}`;
    case "voted-to-keep": return `that ${subject} voted to keep ${object ?? "them"}`;
  }
}

interface Group { first: number; claims: SpokenClaim[] }

/** What the house wrongly believes about the player outside the claim log: key -> the believing holders, earliest week, and a source if recorded. */
function falseBeliefsAboutPlayer(beliefs: BeliefStore | undefined, facts: TruthFacts | undefined) {
  const out = new Map<string, { kind: SpokenClaimKind; subject: EntityId; object?: EntityId; holders: Set<EntityId>; week: number; source?: EntityId }>();
  if (!beliefs || !facts) return out;
  for (const holder of Object.keys(beliefs).sort()) {
    if (holder === PLAYER) continue;
    for (const b of [...claimsOf(beliefs, holder)].sort((x, y) => x.week - y.week || x.id.localeCompare(y.id))) {
      if (b.subject !== PLAYER) continue;
      const c = claimFromBelief(b, holder, holder);
      if (!c || truthOf({ ...c, listener: holder }, facts)) continue;
      const key = `${c.kind}|${c.subject}|${c.object ?? ""}`;
      const g = out.get(key);
      if (g) { g.holders.add(holder); g.week = Math.min(g.week, b.week); if (g.source === undefined && b.source) g.source = b.source; }
      else out.set(key, { kind: c.kind, subject: c.subject, ...(c.object ? { object: c.object } : {}), holders: new Set([holder]), week: b.week, ...(b.source ? { source: b.source } : {}) });
    }
  }
  return out;
}

export function buildRumorMill(log: ClaimLog | undefined, nameOf: (id: EntityId) => string, beliefs?: BeliefStore, facts?: TruthFacts): RumorMill | undefined {
  const lies = (log?.items ?? []).filter((c) => !c.isTrue);
  const extra = falseBeliefsAboutPlayer(beliefs, facts);
  if (!lies.length && !extra.size) return undefined;
  const groups = new Map<string, Group>();
  lies.forEach((c, i) => {
    const key = `${c.kind}|${c.subject}|${c.object ?? ""}`;
    const g = groups.get(key);
    if (g) g.claims.push(c); else groups.set(key, { first: i, claims: [c] });
  });
  const ref = (id: EntityId): NamedRef => ({ id, name: nameOf(id) });
  const aboutOnly = new Set<Group>();
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
  // beliefs the engine formed some other way, about the player: fold into a matching claim group, else a belief-only row after the claim rows
  let order = lies.length;
  const claimRows = [...rows];
  for (const [key, e] of extra) {
    const hit = claimRows.find((r) => `${r.g.claims[0]!.kind}|${r.g.claims[0]!.subject}|${r.g.claims[0]!.object ?? ""}` === key);
    if (hit) {
      const have = new Set(hit.row.believers.map((x) => x.id));
      const more = [...e.holders].filter((h) => !have.has(h)).sort();
      hit.row.believers = [...hit.row.believers, ...more.map(ref)].sort((a, b) => a.id.localeCompare(b.id));
      continue;
    }
    const starter = e.source ?? [...e.holders].sort()[0]!;
    const g: Group = { first: order++, claims: [] };
    rows.push({ g, subject: e.subject, row: {
      claim: claimText(e.kind, nameOf(e.subject), e.object ? nameOf(e.object) : undefined),
      starter: ref(starter), startedWeek: e.week, passedOn: [], believers: [...e.holders].sort().map(ref), tellings: e.holders.size, toldToYou: false,
    } });
    aboutOnly.add(g);
  }
  const rank = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    b.row.believers.length - a.row.believers.length || b.row.tellings - a.row.tellings || a.g.first - b.g.first;
  const top = (xs: typeof rows) => [...xs].sort(rank).slice(0, RUMOR_MILL_CAP).map((x) => x.row);
  return { biggest: top(rows.filter((x) => !aboutOnly.has(x.g))), aboutYou: top(rows.filter((x) => x.subject === PLAYER)) };
}
