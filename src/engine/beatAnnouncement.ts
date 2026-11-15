import type { EntityId } from "../domain/ids";
import type { BeatEvent, EvictionProgress, LiveSeasonState } from "./liveSeason";

/**
 * Feature T0-3 (issue #1778, D1 2026-07-21 owner ruling) — the ADR 0003 amendment: closed-set
 * ceremony OUTCOMES stop being something the narration model reports and become something the
 * engine BROADCASTS. This module is the pure, Vault-free derivation: given a just-committed
 * weekly-loop `BeatEvent` and the live season state immediately after it committed, decide which
 * (if any) `BeatAnnouncement` facts that beat represents.
 *
 * Scope (weekly loop, HOH → eviction — the T0-3 DoD bar): HOH winner, nominations, veto winner,
 * the veto decision, the replacement nominee, the anonymized eviction ballot sequence (E12), and
 * the eviction result (including the Final-3 `final-eviction` variant). Finale/twist/battle-back
 * announcements are an explicit, scoped-out follow-up (see the PR body) — every other beat maps
 * to zero announcements here, which is the correct, inert default (nothing is dropped; it is
 * simply not yet built).
 *
 * STRUCTURALLY Vault-free: this file reads only `BeatEvent` (already player-witnessed, EVT-1) and
 * the handful of `LiveSeasonState` fields that are ALSO exposed, verbatim, through
 * `PublicGameStatus`/`GameStateView.ceremony`/`EvictionView` (`hoh`, `nominees`, `vetoHolder`,
 * `vetoUsed`, `saved`, `replacement`, `eviction.{nominees,voteOf}`) — never a hidden/Vault field —
 * and it imports nothing from `VaultStore`/`VectorIndex`, so the dependency-cruiser Vault-Wall gate
 * covers it for free, same as every other file under `src/engine`.
 */
export type BeatAnnouncementKind =
  | "hoh-winner"
  | "nominations"
  | "veto-field"
  | "veto-winner"
  | "veto-decision"
  | "replacement-nominee"
  | "secret-veto"
  | "eviction-ballot"
  | "eviction-result"
  | "comp-round-result"
  | "final-hoh-part"; // 0128: Part 1 / Part 2 of the three-part Final HOH (flag-gated)

/**
 * The engine-internal (id-keyed) shape of one broadcast fact. The adapter resolves `subjects`/
 * `detail` ids to public display names and assigns a stable dedup `id` + the post-commit `beatSeq`
 * before surfacing it outward as a `BeatAnnouncementView` (`src/ports/GameSession.ts`).
 */
export interface BeatAnnouncement {
  kind: BeatAnnouncementKind;
  week: number;
  /** The houseguest(s) this fact is ABOUT, in a kind-specific fixed order (documented per case below). */
  subjects: EntityId[];
  detail?: {
    /** Who is RESPONSIBLE for this fact (the nominating/replacing HOH); absent when not applicable. */
    by?: EntityId;
    /** `veto-decision` only: whether the holder played the veto. */
    used?: boolean;
    /** `veto-decision` only, when used: who was saved. */
    saved?: EntityId;
    /** `eviction-result` only: the HOH broke a tied vote (E12 — never implies an extra "HOH ballot"). */
    tieBroken?: boolean;
    /** `comp-round-result` only: how many houseguests are still in the competition after this round's drops. */
    remaining?: number;
    /** `final-hoh-part` only: which part (1 or 2) the subject just won. */
    part?: number;
  };
}

/** Every ballot cast for a nominee, tallied — the SAME shape `advanceEviction`'s private `revealedTally`
 *  computes, reimplemented here (this module never reaches into `liveSeason.ts`'s private helpers) over
 *  the FULL `voteOf` map (every ballot is revealed by the time the `"eviction"` beat commits). */
function fullBallotTally(e: EvictionProgress): Record<EntityId, number> {
  const tally: Record<EntityId, number> = { [e.nominees[0]]: 0, [e.nominees[1]]: 0 };
  for (const votedFor of Object.values(e.voteOf)) tally[votedFor] = (tally[votedFor] ?? 0) + 1;
  return tally;
}

/**
 * From a committed weekly-loop `BeatEvent` + the live season state immediately after it committed,
 * derive zero or more Vault-free broadcast facts. PURE — no I/O, no rng, no mutation. Called once
 * per committed `BeatEvent`, at the SAME commit seam for both a plain `advanceGame` step and a
 * T0-2 auto-advanced beat chained off `submitDecision` (both funnel through
 * `GameSessionAdapter.commit`), so the two paths announce identically.
 */
export function buildBeatAnnouncements(ev: BeatEvent, s: LiveSeasonState): BeatAnnouncement[] {
  const week = s.week;
  switch (ev.beat) {
    case "comp-elimination": {
      // A staged competition round's drops (A-14 N-3): `participants` = [...dropped, ...stillIn] (liveSeason), so the
      // dropped are everyone no longer in `s.competition.stillIn`. Public ids only; the remaining count is a public fact.
      const stillIn = new Set(s.competition?.stillIn ?? []);
      const dropped = ev.participants.filter((id) => !stillIn.has(id));
      return dropped.length > 0
        ? [{ kind: "comp-round-result", week, subjects: dropped, detail: { remaining: stillIn.size } }]
        : [];
    }
    case "final-hoh-part": {
      // 0128: the subject won Part 1 / Part 2 of the three-part Final HOH; `s.finalHohPart` is already the NEXT part (2 or 3), so the part just won is that minus one.
      const winner = ev.participants[0];
      const part = (s.finalHohPart ?? 2) - 1;
      return winner ? [{ kind: "final-hoh-part", week, subjects: [winner], detail: { part } }] : [];
    }
    case "hoh-competition": {
      const winner = ev.participants[0];
      return winner ? [{ kind: "hoh-winner", week, subjects: [winner] }] : [];
    }
    case "nominations": {
      const [hoh, a, b] = ev.participants;
      if (!hoh || !a || !b) return [];
      return [{ kind: "nominations", week, subjects: [a, b], detail: { by: hoh } }];
    }
    case "veto-draw": // ORW-281 4b: announced ONLY at a staged draw's 'field' step (the ceremony is still open at commit); a one-beat (headless) draw announces nothing, as before
      return s.ceremony?.kind === "veto-draw" && ev.participants.length > 0 ? [{ kind: "veto-field", week, subjects: [...ev.participants] }] : [];
    case "veto-competition": {
      // The crown event's participants are the FULL comp field (so the soul fold sees everyone who
      // played) — the actual winner is `s.vetoHolder`, already set by `crownCompetition` before commit.
      const winner = s.vetoHolder;
      return winner ? [{ kind: "veto-winner", week, subjects: [winner] }] : [];
    }
    case "veto-ceremony": {
      const out: BeatAnnouncement[] = [];
      const holder = s.vetoHolder;
      // The veto DECISION (use / don't-use) landed in THIS commit iff `s.saved` (already set by the
      // time `commit` runs) is one of this beat's participants — the ONE case that is NOT true is the
      // later, SEPARATE "replacement" decision, whose participants are exactly `[hoh, replacement]`
      // and never include the (earlier-committed, different) `saved` nominee. This lets one committed
      // fact ("used the veto on X") and a LATER, independently-committed fact ("named Y the
      // replacement") — or both bundled into the SAME commit (the NPC-holder fast path) — announce
      // exactly once apiece, never duplicated, with zero extra persisted state.
      const decisionInThisBeat = s.saved !== undefined && ev.participants.includes(s.saved);
      const replacementInThisBeat = s.replacement !== undefined && ev.participants.includes(s.replacement);
      if (holder && (decisionInThisBeat || !replacementInThisBeat)) {
        out.push({
          kind: "veto-decision", week, subjects: [holder],
          detail: { used: s.vetoUsed === true, ...(decisionInThisBeat && s.saved !== undefined ? { saved: s.saved } : {}) },
        });
      }
      if (replacementInThisBeat && s.hoh && s.replacement !== undefined) {
        out.push({ kind: "replacement-nominee", week, subjects: [s.replacement], detail: { by: s.hoh } });
      }
      return out;
    }
    case "twist-reveal": {
      // P5d — ONLY a secret veto PLAYED this week is announced (the holder's reveal is a public, witnessed ceremony fact, like the Power of Veto): who came off the block,
      // then the HOH's replacement nominee. `playSecretVeto` stamps `firedTwists` before it commits, and its participants are [holder, hoh, replacement, staying] — the staying
      // nominee is deliberately NOT named here (they were already announced at the nominations). Every other twist-reveal (double eviction…) stays silent: out of scope.
      const fired = s.firedTwists?.[s.firedTwists.length - 1];
      if (!fired || fired.kind !== "secret-veto" || fired.beat !== week) return [];
      const [holder, hoh, replacement] = ev.participants;
      if (!holder || !hoh || !replacement) return [];
      return [
        { kind: "secret-veto", week, subjects: [holder] },
        { kind: "replacement-nominee", week, subjects: [replacement], detail: { by: hoh } },
      ];
    }
    case "eviction-reveal": {
      // E12: `ev.participants` IS the anonymized ballot sequence already — the nominee each ballot
      // names, in reveal order, never the voter (`batchedRevealContent` builds the matching prose from
      // this SAME array). Projecting it verbatim is what makes the chyron byte-equal to engine data.
      return ev.participants.length > 0 ? [{ kind: "eviction-ballot", week, subjects: [...ev.participants] }] : [];
    }
    case "eviction": {
      // The evictee is DECIDED here (the last ballot just landed, or a tie-break/secret-veto resolved
      // it) — `s.eviction` is still populated (cleared only later, at the `"result"` stage), so the
      // full tally is available to detect an HOH tie-break without any extra persisted state.
      const evictee = ev.participants[0];
      if (!evictee) return [];
      let tieBroken = false;
      const e = s.eviction;
      if (e) {
        const tally = fullBallotTally(e);
        tieBroken = tally[e.nominees[0]] === tally[e.nominees[1]];
      }
      return [{
        kind: "eviction-result", week, subjects: [evictee],
        detail: { ...(s.hoh ? { by: s.hoh } : {}), ...(tieBroken ? { tieBroken: true } : {}) },
      }];
    }
    case "final-eviction": {
      // Final 3 (0045): the final HOH personally evicts a rival — no ballots, no tie-break.
      const [hoh, evictee] = ev.participants;
      if (!hoh || !evictee) return [];
      return [{ kind: "eviction-result", week, subjects: [evictee], detail: { by: hoh } }];
    }
    default:
      // Every other beat (comp-elimination, day-break, veto-draw, battle-back,
      // eviction-goodbye, exit-interview, finale, self-eviction, complete…) announces nothing here —
      // either it carries no closed-set ceremony FACT (day-break, veto-draw, goodbyes, exit-interview)
      // or it is explicitly scoped OUT of this pass (finale/battle-back/double-eviction — a follow-up; a played secret veto is announced, P5d).
      return [];
  }
}

/** Resolve one subject/detail id to its public display name — the SAME contract `nameOf` already
 *  guarantees on the adapter (falls back to the raw id for an unknown/off-roster id). */
export type NameResolver = (id: EntityId) => string;

/**
 * The Vault-free broadcast headline for one announcement — deterministic prose built ONLY from the
 * announcement's own ids + a name resolver (no Vault, no rng, no LLM). This is the text a diegetic
 * broadcast chyron renders; the narration model's job shrinks to reacting to it, never re-stating it.
 * E12: the `eviction-ballot` headline NEVER names a voter — only who each anonymized ballot named.
 */
export function announcementHeadline(a: BeatAnnouncement, nameOf: NameResolver): string {
  switch (a.kind) {
    case "hoh-winner":
      return `${nameOf(a.subjects[0]!)} is the new Head of Household.`;
    case "nominations": {
      const by = a.detail?.by;
      const [n1, n2] = a.subjects;
      const nominator = by ? `${nameOf(by)} has nominated` : "The house has nominated";
      return `${nominator} ${nameOf(n1!)} and ${nameOf(n2!)} for eviction.`;
    }
    case "veto-field":
      return `The Power of Veto players are ${a.subjects.map((id) => nameOf(id)).join(", ")}.`;
    case "veto-winner":
      return `${nameOf(a.subjects[0]!)} wins the Power of Veto.`;
    case "veto-decision": {
      const holder = nameOf(a.subjects[0]!);
      if (!a.detail?.used) return `${holder} does not use the Power of Veto.`;
      const saved = a.detail.saved;
      const savedName = saved !== undefined ? (saved === a.subjects[0] ? "themselves" : nameOf(saved)) : undefined;
      return savedName ? `${holder} uses the Power of Veto on ${savedName}.` : `${holder} uses the Power of Veto.`;
    }
    case "replacement-nominee": {
      const by = a.detail?.by;
      const namer = by ? nameOf(by) : "The Head of Household";
      return `${namer} names ${nameOf(a.subjects[0]!)} as the replacement nominee.`;
    }
    case "secret-veto":
      return `${nameOf(a.subjects[0]!)} plays a secret veto and comes off the block.`;
    case "comp-round-result": {
      const names = a.subjects.map((id) => nameOf(id));
      const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
      const rem = a.detail?.remaining;
      return `${list} ${names.length === 1 ? "is" : "are"} out of the competition${rem !== undefined ? `; ${rem} remain` : ""}.`;
    }
    case "final-hoh-part":
      return `${nameOf(a.subjects[0]!)} wins Part ${a.detail?.part ?? 1} of the final Head of Household competition.`;
    case "eviction-ballot":
      return a.subjects.map((id) => `a vote to evict ${nameOf(id)}.`).join(" ");
    case "eviction-result": {
      const tie = a.detail?.tieBroken ? " after the Head of Household broke a tied vote" : "";
      return `${nameOf(a.subjects[0]!)} has been evicted from the house${tie}.`;
    }
  }
}
