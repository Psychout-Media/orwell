import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01 } from "../domain/num";
import { PLAYER as PLAYER_ID } from "../domain/ids";

/**
 * Feature 0107 — NAMED ALLIANCES. An explicit, NAMED, multi-party pact layered over the emergent bloc
 * (0043) + deal (0039) systems. The point is the *name*: in Big Brother, naming an alliance cements it
 * "in reality" — real or not. So a named alliance does three things, all bounded:
 *
 *   1. CEMENT — a small per-pair TIE BOOST added to co-members' mutual bond in `detectBlocs`, so naming
 *      pulls a borderline cluster together and tightens it. But the real bonds still rule: the boost is
 *      bounded, so a HOLLOW alliance over weak bonds never reaches the bloc threshold — it stays hollow.
 *   2. FAVOR — a bounded GOODWILL bump toward each co-ally (feeds the 0075 confidence ledger): naming an
 *      alliance is an easy way to bank a little good favor with the people in it.
 *   3. STAKES — betraying a NAMED co-ally is a heavier betrayal than breaking an unspoken bond (a
 *      multiplier on the reconciliation demerit): putting it on record raises the cost of breaking it.
 *
 * SATURATION DILUTES (the owner's "the show has too many alliances that mean nothing"): the more
 * alliances a houseguest piles into, the less each one cements — so a tight, exclusive pact beats a web
 * of overlapping ones. Pure + deterministic; Vault-only (the cement/favor magnitudes never cross to the
 * player — they see the NAME + members, never a number).
 */

export interface Alliance {
  id: string;
  name: string;
  members: EntityId[];
  founder: EntityId;
  /** The beat the alliance was named (for ordering / recency). */
  formedBeat: number;
  /** Who is AWARE the alliance exists (symmetric perspective, like a campaign's `knownTo`): the members,
   *  plus anyone who later learns of it through a pathway. Never the whole house by default. */
  knownTo: EntityId[];
  /** ORW-353: consecutive in-game days the alliance's cohesion (the bloc measure: its weakest mutual bond) has sat under `cohesionFloor`. Absent (an older save) = 0. */
  lowDays?: number;
  /** ORW-353: the last in-game day the neglect check ran for this alliance (so a day is counted once). Absent = never checked. */
  checkedDay?: number;
  /** 0172 / ORW-603: the roster the player was TOLD when the alliance was pitched to them (ids, frozen at the pitch). The player's pitch view shows this, never the live membership. Absent = never pitched with the flag on. */
  toldRoster?: EntityId[];
}

export interface AllianceConstants {
  /** Base per-pair tie boost a single named alliance adds to co-members' mutual bond (cements clustering). */
  tieBoost: number;
  /** The bounded favor (goodwill) co-membership banks toward an ally — feeds the 0075 confidence ledger. */
  favor: number;
  /** Saturation: a member's Nth alliance contributes `saturationFalloff^(N-1)` of the effect (dilution). */
  saturationFalloff: number;
  /** A houseguest declines to JOIN unless their mutual bond toward the founder clears this floor. */
  joinBondFloor: number;
  /** How much heavier a betrayal of a NAMED co-ally is vs. an unspoken bond (multiplier on the demerit). */
  betrayalMultiplier: number;
  /** Phase B: an NPC names an alliance only over co-members whose mutual bond clears this (higher than the
   *  player floor — an NPC commits to real bonds, not a hopeful pitch). */
  npcAllyFloor: number;
  /** ORW-353 (Ryne 2026-11-14: "if alliances are formed they are formed... the weakest wouldn't necessarily last"): there is NO count cap any more; an alliance whose cohesion (the weakest mutual bond among its members, the same measure a bloc uses) stays under this for `fadeDays` in-game days in a row dissolves. */
  cohesionFloor: number;
  /** ORW-353: how many in-game days in a row under the floor before an alliance fades. */
  fadeDays: number;
  /** ORW-353: the daily chance (seeded per member and alliance) that a member whose own get-them-out / revenge goal is aimed at a fellow member breaks the alliance by betrayal. */
  goalClashBreak: number;
  /** ORW-341: how much warmer a houseguest who has been pitched this week counts toward the pitcher when deciding to join (a bounded bonus on the mutual bond, not a new magnitude). */
  pitchedWarmth: number;
  /** Phase B: the most houseguests an NPC-named alliance starts with (the founder + up to this−1 allies). */
  maxNpcSize: number;
  /** Phase B: an NPC founder pitches the PLAYER into their alliance only when their mutual bond clears this. */
  pitchPlayerFloor: number;
  /** Phase B: the bounded threat bump a named-alliance betrayal lands on the wronged → betrayer edge. */
  betrayalThreatBump: number;
}

export const ALLIANCE: AllianceConstants = {
  tieBoost: 0.12,        // bounded — a hollow (low-bond) pact never reaches the 0.5 bloc threshold on this alone
  favor: 0.15,           // ≈ an open deal's goodwill: a little good favor, never trust on its own
  saturationFalloff: 0.6,
  joinBondFloor: 0.45,
  betrayalMultiplier: 1.5,
  npcAllyFloor: 0.58,
  pitchedWarmth: 0.05,
  cohesionFloor: 0.4,
  fadeDays: 3,
  goalClashBreak: 0.12,
  maxNpcSize: 4,
  pitchPlayerFloor: 0.6,
  betrayalThreatBump: 0.18,
};

/**
 * ORW-509: the composed alliance-name floor. A fixed house of names ran dry and fell back to "The Core 2"; names are now composed from parts (no dealt list), so a season never repeats a name and two seasons rarely share one. The writer still names live alliances from the cast's own
 * story; this is what the engine says offline. Generic, BB-plausible, never a houseguest name.
 */
const ALLIANCE_COLLECTIVES: readonly string[] = [
  "Brigade", "Committee", "Core", "Nucleus", "Quad", "Pact", "Syndicate", "Crew", "Founders", "Outsiders", "Regulators", "Hitmen", "Cartel", "Council", "Coalition",
  "Posse", "Union", "Guild", "Order", "Network", "Collective", "Faction", "Cabal", "Alliance", "Squad", "Circle", "Cooperative", "Society", "Wolf Pack", "Task Force",
  "Roundtable", "Board", "Firm", "Mob", "Lodge", "Tribe", "Gang", "Band", "Ring", "Clique", "Camp", "Table", "Troop", "League", "Party", "Fellowship", "Majority",
  "Minority", "Underground", "Resistance", "Dynasty", "Empire", "Legion", "Orchard", "Vault Club", "Group Chat", "Study Group", "Book Club", "Welcome Committee",
];
const ALLIANCE_QUALITIES: readonly string[] = [
  "Quiet", "Silent", "Loyal", "Last", "First", "Midnight", "Backyard", "Kitchen", "Wildcard", "Underdog", "Sleeper", "Golden", "Iron", "Velvet", "Tidal", "Hidden",
  "Rogue", "Bold", "Steady", "Careful", "Reckless", "Honest", "Sunday", "Late-Night", "Fearless", "Patient", "Narrow", "Broken", "Rising", "Unlikely", "Cold",
  "Clever", "Scrappy", "Secret", "Ride-or-Die", "Odd", "Lucky", "Moonlit", "Hot", "Dusty",
];
const ALLIANCE_PLACES: readonly string[] = [
  "Pantry", "Patio", "Hammock", "Hot Tub", "Kitchen", "Couch", "Laundry", "Back Porch", "Hallway", "Bunk", "Rooftop", "Garden", "Gym", "Pool", "Fire Pit", "Porch",
  "Basement", "Attic", "Driveway", "Dock",
];
const ALLIANCE_NUMBERS: readonly string[] = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
const ALLIANCE_NUMBER_NOUNS: readonly string[] = ["Pack", "Squad", "Strong", "Deep", "Club", "Alliance", "Plan", "Rule", "Pact", "Count"];

/** Every composed name, once: the four composed shapes with any repeat of an earlier name dropped (a name never sits in two regions). */
const ALLIANCE_NAME_LIST: readonly string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (n: string): void => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
  for (const c of ALLIANCE_COLLECTIVES) add(`The ${c}`);
  for (const q of ALLIANCE_QUALITIES) for (const c of ALLIANCE_COLLECTIVES) add(`The ${q} ${c}`);
  for (const w of ALLIANCE_PLACES) for (const c of ALLIANCE_COLLECTIVES) add(`${w} ${c}`);
  for (const n of ALLIANCE_NUMBERS) for (const k of ALLIANCE_NUMBER_NOUNS) add(`${n} ${k}`);
  return out;
})();

/** How many distinct names the composed floor can make. */
export const ALLIANCE_NAME_SPACE = ALLIANCE_NAME_LIST.length;

/** The `index`th composed alliance name (any integer; wraps). Pure. */
export function allianceNameAt(index: number): string {
  return ALLIANCE_NAME_LIST[((Math.floor(index) % ALLIANCE_NAME_SPACE) + ALLIANCE_NAME_SPACE) % ALLIANCE_NAME_SPACE]!;
}

/**
 * Pick an unused alliance name (seeded). ONE `rng.int` draw, exactly as before (the main stream's consumption is unchanged); the draw addresses the whole
 * composed space, and a taken name moves to the next free one (bounded, then a numbered plain fallback, which a space this size never reaches in a season).
 * `avoid` is the previous seasons' names (an explicit input, default empty): they are skipped while any other name is left, so two seasons do not share names.
 */
export function pickAllianceName(rng: { int(n: number): number }, taken: ReadonlySet<string>, avoid: ReadonlySet<string> = new Set()): string {
  const start = rng.int(ALLIANCE_NAME_SPACE);
  for (const skipAvoid of [true, false]) {
    for (let k = 0; k < ALLIANCE_NAME_SPACE; k++) {
      const name = allianceNameAt(start + k);
      if (!taken.has(name) && !(skipAvoid && avoid.has(name))) return name;
    }
  }
  return `${allianceNameAt(start)} ${taken.size + 1}`;
}

/** Whether two member lists are the same set (order-independent) — the NPC-formation dedup. */
export function sameMembers(a: readonly EntityId[], b: readonly EntityId[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((m) => s.has(m));
}

/** The active alliances a houseguest is a member of. */
export function alliancesOf(alliances: readonly Alliance[], member: EntityId): Alliance[] {
  return alliances.filter((a) => a.members.includes(member));
}

/** Saturation weight for a member's `n`th-and-up alliances: 1 for the first, falling off thereafter. */
function saturationWeight(count: number, c: AllianceConstants): number {
  return count <= 0 ? 0 : Math.pow(c.saturationFalloff, count - 1);
}

/**
 * The CEMENT — the bounded tie boost the NAMED alliances two houseguests SHARE add to their mutual bond
 * in `detectBlocs`. Saturation-diluted by how many alliances each is in (the busier the web, the weaker
 * each strand), and capped so naming can pull a borderline pair together but never fabricate a bloc from
 * nothing. 0 when they share no alliance ⇒ byte-identical bloc detection.
 */
export function allianceTieBoost(alliances: readonly Alliance[], a: EntityId, b: EntityId, c: AllianceConstants = ALLIANCE): number {
  const shared = alliances.filter((al) => al.members.includes(a) && al.members.includes(b)).length;
  if (shared === 0) return 0;
  const busiest = Math.max(alliancesOf(alliances, a).length, alliancesOf(alliances, b).length);
  // The pair's strongest shared strand, diluted by the busiest member's saturation. Capped at the base
  // boost so even several shared alliances never exceed one clean tie (no stacking a hollow bloc into being).
  return clamp01(Math.min(c.tieBoost, c.tieBoost * shared * saturationWeight(busiest, c)));
}

/**
 * The FAVOR — the bounded goodwill co-membership in named alliances banks toward `ally` from `holder`'s
 * side (added to the 0075 deal-goodwill ledger). Saturation-diluted; 0 if they share no alliance.
 */
export function allianceFavor(alliances: readonly Alliance[], holder: EntityId, ally: EntityId, c: AllianceConstants = ALLIANCE): number {
  const shared = alliances.filter((al) => al.members.includes(holder) && al.members.includes(ally)).length;
  if (shared === 0) return 0;
  return clamp01(c.favor * saturationWeight(alliancesOf(alliances, holder).length, c));
}

/**
 * The STAKES — the betrayal multiplier when `actor` moves against `target` and they share a named
 * alliance: a named betrayal cuts deeper than breaking an unspoken bond. 1 (no scaling) when they share
 * none, so the existing reconciliation is unchanged absent alliances.
 */
export function allianceBetrayalScale(alliances: readonly Alliance[], actor: EntityId, target: EntityId, c: AllianceConstants = ALLIANCE): number {
  const shared = alliances.some((al) => al.members.includes(actor) && al.members.includes(target));
  return shared ? c.betrayalMultiplier : 1;
}

/**
 * Enroll the WILLING members of a proposed alliance (the bond-gated join — anti-watering-down): the
 * founder is always in; every other proposed member joins ONLY if their mutual bond toward the founder
 * clears `joinBondFloor`. So you cannot name everyone your ally — a houseguest who barely knows you
 * declines, and the alliance forms only over real-enough bonds. PURE: the caller supplies the bond reads.
 */
export function willingMembers(
  founder: EntityId,
  proposed: readonly EntityId[],
  mutualBondTo: (member: EntityId) => number,
  c: AllianceConstants = ALLIANCE,
): EntityId[] {
  const out = [founder];
  for (const m of proposed) {
    if (m === founder || out.includes(m)) continue;
    if (mutualBondTo(m) >= c.joinBondFloor) out.push(m);
  }
  return out;
}

/**
 * ORW-544 / 0161 - ALLIANCE HISTORY. The live list above loses a row when an alliance fades, falls under two members or is voted out of existence; this ledger keeps every change, so
 * nothing about an alliance is ever deleted (non-degradation, mandate #4). APPEND-ONLY: an entry is never removed or rewritten once appended (only `eventId` is filled in the one time the
 * engine records the matching event). Engine-only and Vault-sealed: the entries carry who was in a hidden pact, so no player or admin view reads them; the post-season retrospective may.
 */
export type AllianceChange = "formed" | "joined" | "left" | "betrayed" | "faded" | "dissolved" | GroupChange;
/** 0172 (Theme 3 slice 6): the hidden group-life kinds the history also keeps. History-only: none of them records a player-facing event by itself (the act that a player can see records its own). */
export type GroupChange = "roles" | "inner-circle" | "purpose" | "spy-planted" | "spy-report" | "spy-turned" | "spy-confessed" | "shadow-formed" | "cracked" | "pitched" | "pitch-withdrawn";
/** The group-life kinds as a set (the event flush skips these: they are history, not events). */
export const GROUP_CHANGES: ReadonlySet<string> = new Set<GroupChange>(["roles", "inner-circle", "purpose", "spy-planted", "spy-report", "spy-turned", "spy-confessed", "shadow-formed", "cracked", "pitched", "pitch-withdrawn"]);

export interface AllianceHistoryEntry {
  /** 1-based, strictly increasing, never reused (the append position). */
  seq: number;
  allianceId: string;
  name: string;
  founder: EntityId;
  kind: AllianceChange;
  /** The beat and (when known) the in-game day the change happened. */
  beat: number;
  day?: number;
  /** The roster as it stood BEFORE a leave / betrayal / fade / dissolve (so an ended alliance keeps its whole membership), and AFTER a formation / join. */
  members: EntityId[];
  /** The member a `joined` / `left` / `betrayed` entry is about. */
  who?: EntityId;
  /** Why it ended or left: `betrayal`, `cohesion`, `evicted`, `evicted-out`, `too-few-members`, `crack`. */
  why?: string;
  /** 0172: what a group-life entry is about (engine-only, Vault-sealed): the roles dealt, the purpose reached, the alliance a shadow group answers, the alliance a cracked-off group came from. */
  detail?: string;
  /** Whether the player was a member or had been told of the alliance when this happened (decides whether its event is visible to them). */
  playerKnew: boolean;
  /** The event recorded for this change (set once). */
  eventId?: string;
}

/** A live, mutable store of named alliances (sibling to the 0039 `DealStore`). Engine-only; Vault-sealed. */
export class AllianceStore {
  private alliances: Alliance[] = [];
  private seq = 0;
  private log: AllianceHistoryEntry[] = [];
  private at: { beat: number; day?: number } = { beat: 0 };

  /** The append-only history, oldest first. */
  history(): readonly AllianceHistoryEntry[] { return this.log; }

  /** Stamp the beat (and in-game day) the next changes are recorded at. */
  stamp(beat: number, day?: number): void { this.at = { beat, ...(day !== undefined ? { day } : {}) }; }

  /** The entries that still need an event recorded for them. */
  unrecorded(): AllianceHistoryEntry[] { return this.log.filter((e) => e.eventId === undefined); }

  markRecorded(seq: number, eventId: string): void {
    const e = this.log.find((x) => x.seq === seq);
    if (e && e.eventId === undefined) e.eventId = eventId;
  }

  private note(a: Pick<Alliance, "id" | "name" | "founder" | "knownTo">, kind: AllianceChange, members: readonly EntityId[], extra: { who?: EntityId; why?: string; detail?: string } = {}): void {
    this.log.push({
      seq: (this.log[this.log.length - 1]?.seq ?? 0) + 1,
      allianceId: a.id, name: a.name, founder: a.founder, kind,
      beat: this.at.beat, ...(this.at.day !== undefined ? { day: this.at.day } : {}),
      members: [...members],
      ...(extra.who !== undefined ? { who: extra.who } : {}),
      ...(extra.why !== undefined ? { why: extra.why } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      playerKnew: members.includes(PLAYER_ID) || a.knownTo.includes(PLAYER_ID),
    });
  }

  all(): readonly Alliance[] { return this.alliances; }

  /** ORW-1178: the name `want` may take, never one another alliance already bears (compared the way the naming rules compare: case, a leading "The" and punctuation ignored). A clash takes the next free number. */
  uniqueName(want: string, exceptId?: string): string {
    const norm = (t: string): string => t.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
    const taken = new Set(this.alliances.filter((x) => x.id !== exceptId).map((x) => norm(x.name)));
    if (!taken.has(norm(want))) return want;
    for (let n = 2; ; n++) if (!taken.has(norm(`${want} ${n}`))) return `${want} ${n}`;
  }

  add(name: string, founder: EntityId, members: EntityId[], formedBeat: number): Alliance {
    const a: Alliance = {
      id: `alliance:${++this.seq}`,
      name: this.uniqueName(name.trim() || `Alliance ${this.seq}`),
      members: [...members],
      founder,
      formedBeat,
      knownTo: [...members], // symmetric perspective: only the members know at formation
    };
    this.alliances.push(a);
    this.note(a, "formed", a.members);
    return a;
  }

  forMember(member: EntityId): Alliance[] { return alliancesOf(this.alliances, member); }

  /** ORW-509: set an alliance's name (the caller has already applied the naming rules). */
  rename(id: string, name: string): Alliance | undefined {
    const i = this.alliances.findIndex((a) => a.id === id);
    if (i < 0) return undefined;
    this.alliances[i] = { ...this.alliances[i]!, name: this.uniqueName(name, id) }; // ORW-1178: a rename never lands on a name another alliance bears
    return this.alliances[i];
  }

  byId(id: string): Alliance | undefined { return this.alliances.find((a) => a.id === id); }

  /** The alliances a houseguest is AWARE of but NOT a member of (a pitch they can still accept). */
  pitchesFor(who: EntityId): Alliance[] {
    return this.alliances.filter((a) => a.knownTo.includes(who) && !a.members.includes(who));
  }

  /** Make `who` aware of an alliance (a pitch surfaces it without enrolling them). `told` (0172): the roster the player is told at the pitch, frozen once. */
  reveal(id: string, who: EntityId, told?: readonly EntityId[]): void {
    const a = this.byId(id);
    if (a && told && who === PLAYER_ID && !a.toldRoster) a.toldRoster = [...told];
    if (a && !a.knownTo.includes(who)) {
      a.knownTo.push(who);
      // The player told of an alliance in the same pass it formed: its still-unrecorded entries are then known to them (the only field of an entry that moves, besides `eventId`, and only false -> true before its event is recorded).
      if (who === PLAYER_ID) for (const e of this.log) if (e.allianceId === id && e.eventId === undefined) e.playerKnew = true;
    }
  }

  /** Enroll `who` (they accepted a pitch); also makes them aware. No-op if already a member. */
  join(id: string, who: EntityId): Alliance | undefined {
    const a = this.byId(id);
    if (!a) return undefined;
    const isNew = !a.members.includes(who);
    if (isNew) a.members.push(who);
    if (!a.knownTo.includes(who)) a.knownTo.push(who);
    if (isNew) this.note(a, "joined", a.members, { who });
    return a;
  }

  /** Remove `who` (they betrayed it / left); an alliance that falls below two members dissolves. */
  removeMember(id: string, who: EntityId, why: "betrayal" | "left" = "betrayal"): void {
    const a = this.byId(id);
    if (!a) return;
    const before = [...a.members];
    a.members = a.members.filter((m) => m !== who);
    this.note(a, why === "betrayal" ? "betrayed" : "left", before, { who, why });
    if (a.members.length < 2) {
      this.alliances = this.alliances.filter((x) => x.id !== id);
      this.note(a, "dissolved", before, { why: why === "betrayal" ? "betrayal" : "too-few-members" });
    }
  }

  /**
   * 0172: a hidden group-life entry (roles dealt, an inner circle, a spy, a shadow group, a purpose shift) appended to the history for a live alliance, or for an ended one by its last
   * entry's name. Append-only like every entry; nothing about the live list changes. Returns false when the id was never an alliance.
   */
  annotate(allianceId: string, kind: GroupChange, extra: { who?: EntityId; why?: string; detail?: string; members?: readonly EntityId[] } = {}): boolean {
    const a = this.byId(allianceId);
    if (a) { this.note(a, kind, extra.members ?? a.members, extra); return true; }
    const last = [...this.log].reverse().find((e) => e.allianceId === allianceId);
    if (!last) return false;
    this.note({ id: last.allianceId, name: last.name, founder: last.founder, knownTo: [] }, kind, extra.members ?? last.members, extra);
    return true;
  }

  /** 0172 / ORW-611: the alliance withdraws a pitch the player has not accepted (an observable act; the player's awareness of it as a pitch ends, the history keeps it). Never touches an alliance the player belongs to. */
  withdrawPitch(id: string, who: EntityId): boolean {
    const a = this.byId(id);
    if (!a || a.members.includes(who) || !a.knownTo.includes(who)) return false;
    this.note(a, "pitch-withdrawn", a.members, { who });
    a.knownTo = a.knownTo.filter((k) => k !== who);
    return true;
  }

  /**
   * 0172: an alliance CRACKS. `leavers` walk out of it; two or more of them found a new alliance (named by the caller, already through the naming rules), one alone just leaves. Nothing is deleted: the original keeps its
   * history (a `cracked` entry with its whole roster, a `left` per leaver), and the new one gets its own `formed`. The original dissolves, as ever, when it falls under two members. Returns the new alliance, if any.
   */
  crack(id: string, leavers: readonly EntityId[], newName: string, formedBeat: number): Alliance | undefined {
    const a = this.byId(id);
    if (!a) return undefined;
    const out = a.members.filter((m) => leavers.includes(m));
    if (out.length === 0 || out.length === a.members.length) return undefined;
    const before = [...a.members];
    this.note(a, "cracked", before, { why: "crack", detail: out.join(",") });
    a.members = a.members.filter((m) => !out.includes(m));
    for (const m of out) this.note(a, "left", before, { who: m, why: "crack" });
    if (a.members.length < 2) {
      this.alliances = this.alliances.filter((x) => x.id !== id);
      this.note(a, "dissolved", before, { why: "crack" });
    }
    if (out.length < 2) return undefined;
    const founder = out[0]!;
    return this.add(newName, founder, out, formedBeat);
  }

  /** Every active alliance the two houseguests SHARE (for the betrayal-stakes fold). */
  shared(a: EntityId, b: EntityId): Alliance[] {
    return this.alliances.filter((al) => al.members.includes(a) && al.members.includes(b));
  }

  /**
   * ORW-353: the neglect check, once per in-game day per alliance. `cohesionOf` is the bloc measure for the alliance's members; `skip` marks an alliance that never fades (the player's own named pact, which only breaks by betrayal or eviction).
   * A day under the floor adds to `lowDays` (a gap of several days counts each), a day at or above it resets it; an alliance reaching `fadeDays` is dissolved. Returns the dissolved alliances.
   */
  fade(day: number, cohesionOf: (a: Alliance) => number, skip: (a: Alliance) => boolean, c: AllianceConstants = ALLIANCE): Alliance[] {
    const gone: Alliance[] = [];
    for (const a of this.alliances) {
      if (skip(a)) continue;
      const since = a.checkedDay ?? day;
      if (day <= since && a.checkedDay !== undefined) continue;
      const elapsed = Math.max(1, day - since);
      a.checkedDay = day;
      a.lowDays = cohesionOf(a) < c.cohesionFloor ? (a.lowDays ?? 0) + elapsed : 0;
      if (a.lowDays >= c.fadeDays) gone.push(a);
    }
    if (gone.length) {
      this.alliances = this.alliances.filter((a) => !gone.includes(a));
      for (const a of gone) this.note(a, "faded", a.members, { why: "cohesion" });
    }
    return gone;
  }

  /** Drop any member who has left the game (evicted); a one-member alliance dissolves. Returns whether anything changed. */
  prune(living: ReadonlySet<EntityId>): boolean {
    if (this.alliances.every((a) => a.members.every((m) => living.has(m)) && a.knownTo.every((k) => living.has(k)))) return false;
    const next: Alliance[] = [];
    for (const a of this.alliances) {
      const kept = a.members.filter((m) => living.has(m));
      for (const m of a.members) if (!living.has(m)) this.note(a, "left", a.members, { who: m, why: "evicted" });
      if (kept.length >= 2) next.push({ ...a, members: kept, knownTo: a.knownTo.filter((k) => living.has(k)) });
      else this.note(a, "dissolved", a.members, { why: "evicted-out" });
    }
    this.alliances = next;
    return true;
  }

  serialize(): Alliance[] { return this.alliances.map((a) => ({ ...a, members: [...a.members], knownTo: [...a.knownTo] })); }

  serializeHistory(): AllianceHistoryEntry[] { return this.log.map((e) => ({ ...e, members: [...e.members] })); }

  load(rows: readonly Alliance[], history: readonly AllianceHistoryEntry[] = []): void {
    this.log = history.map((e) => ({ ...e, members: [...e.members] }));
    this.alliances = rows.map((a) => ({ ...a, members: [...a.members], knownTo: [...a.knownTo] }));
    // A dissolved alliance (betrayal, fade, eviction) leaves a gap in the ids, so the row count can be lower than the highest id still in use; restoring
    // `seq` from the count would hand the next alliance an id a live one already holds. Resume after the highest numeric id instead.
    // ORW-544: a dissolved alliance's id lives on in the history, so the top id is read from the history too: an id is never reused, even when the highest-numbered alliance is the one that ended.
    const idOf = (id: string): number => Number(/^alliance:(\d+)$/.exec(id)?.[1] ?? 0);
    this.seq = Math.max(rows.length, ...rows.map((a) => idOf(a.id)), ...this.log.map((e) => idOf(e.allianceId)));
  }
}
