import { composeAll } from "./data/composedFloor";
import type { EventStore } from "../ports/EventStore";
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { EntityId, GameEvent } from "../domain/event";
import { PLAYER } from "../domain/ids";
import type { SoulProvider } from "../ports/SoulProvider";
import type { RelationshipModel } from "./relationships";
import { CONFESSIONAL, salienceClassOf } from "./confessionalConstants";
import type { SalienceClass } from "./confessionalConstants";
import type { VoiceProfile } from "../domain/voiceProfile";

/**
 * NPC Diary Room confessionals (feature 0040). A houseguest's private read of their
 * own game — who they're targeting, who they trust — GROUNDED in the engine's
 * relationship truth (never invented by the narrator). Recorded Vault-only: hidden,
 * witnessed by the confessing NPC alone, so by the 0002 visibility model it can never
 * enter the player's knowledge, and (the admin surface reads no events) never the
 * admin's either. The inverse of the player Diary Room (0013): NPC interiority with
 * no pathway to anyone.
 */
export interface Confessional {
  npc: EntityId;
  /** Who the NPC reads as their biggest threat (their target) — the highest-threat peer. */
  target: EntityId | null;
  /** Who the NPC trusts most — the strongest bond. */
  ally: EntityId | null;
  /** The Vault-only private line (reaches no one). */
  content: string;
  /** What prompted this confessional (audit E55) — the beat/scene it reacts to. */
  trigger?: string;
  /** The NPC's coarse mood at the moment of confessing (from their hidden soul, 0041). */
  mood?: "rattled" | "steady" | "confident";
  /**
   * Feature 0122 — the DEEP facets, each present ONLY when the confessor's situation triggered it (this is
   * NOT a fixed multi-slot form; depth is earned by game state, so an HOH / nominee gets several and a
   * coasting houseguest gets none). Every facet is grounded in the confessor's OWN reads + PUBLIC role/beat
   * state — no number, no other houseguest's sealed state. Absent unless `ctx.depth` was supplied (⇒ the
   * whole confessional is BYTE-IDENTICAL to 0040 when depth is off — the calibration/golden guarantee).
   */
  /** Their intended next move (triggered by holding power/danger — HOH/veto-holder/nominee). */
  plan?: string;
  /** How safe they feel, from PUBLIC role state only (never another's hidden threat-of-me edge). */
  standing?: "safe" | "exposed" | "reading";
  /** A peer they hold a real grudge against (lowest trust, below the grudge floor) — distinct from target. */
  grudge?: EntityId | null;
  /** The partner of a significant recent conversation this facet reacts to (how that talk sat with them). */
  aftermath?: EntityId | null;
  /** A relation of theirs who was just in a public beat, read through the bond ("my ally won HOH"). */
  adjacent?: { relation: EntityId; bond: "ally" | "target"; beat: "won-power" | "nominated" } | null;
}

/**
 * A single Vault-safe FACT a reactive confessional reacts to (feature 0089). The caller has ALREADY
 * selected this from the confessor's OWN witnessed events (`witnessedBy: npc`) and redacted it to this
 * shape — so it carries the event's CLASS, the confessor's ROLE in it, and a class-keyed `gist`, and
 * NEVER a raw number, another houseguest's sealed read, or the verbatim content of another participant.
 * `confessionalFor` opens the line with the `gist` (the concrete beat the confessor lived) when present.
 */
export interface RecentEventFact {
  /** The event's salience class (competition / ceremony / reveal / social / flavor). */
  type: SalienceClass;
  /** The confessor's role in the event: they initiated it, or merely witnessed it. */
  role: "initiator" | "witness";
  /** A Vault-safe, class-keyed phrase the confessional opens with — never a premise, never a number. */
  gist: string;
}

/**
 * The structured context a confessional is composed FROM (audit E55): the beat that triggered it,
 * the confessor's soul state, and a seeded rng for phrasing — so confessionals vary across a
 * season (the 0048 unsealing payoff) instead of one canned line.
 */
export interface ConfessionalContext {
  /** The triggering beat/scene, e.g. "the nomination ceremony" / "the veto ceremony". */
  trigger?: string;
  /**
   * Feature 0089 — the confessor's OWN recent witnessed events, already selected + redacted to
   * Vault-safe gists by the caller (`selectRecentForConfessional`). When present and NON-EMPTY,
   * `confessionalFor` opens the reaction with the concrete recent beat (a real Diary Room cut: "after
   * the veto ceremony…") instead of the bare `trigger` label, then keeps the grounded target/ally read.
   * ABSENT (or empty) ⇒ the composer falls back to today's `trigger` behavior, BYTE-IDENTICAL to 0040
   * (additive, back-compatible). The facts come ONLY from the confessor's witness set — never a free
   * Vault read — and carry no number/other-houseguest sealed state (mandate #2/#3).
   */
  recentEvents?: readonly RecentEventFact[];
  /** The confessor's hidden emotional state (0..1; 0.5 = calm) — colors the voice. */
  emotionalState?: number;
  /** Seeded phrasing variance. Omitted ⇒ the first template (deterministic, pre-E55-compatible). */
  rng?: RandomnessSource;
  /**
   * PV1 (#1029) — the PLAYER as an eligible SUBJECT of an NPC's private read. The confessor draws its
   * target/ally from `others` (the NPC roster) only, so the player — who rides the whole season — was
   * NEVER named as a confessor's biggest threat or closest ally, even at Final 2. When supplied, the
   * player is folded into the SAME engine-grounded read (`rel.edge(npc, player)`) as any houseguest, so
   * an NPC can confess the player as their target or ally GROUNDED in real signals, never invented.
   * The player is a SUBJECT only — `recordConfessional` still witnesses the confessing NPC ALONE, so
   * the confessional stays Vault-only and reaches no one directly (the inverse player Diary Room, 0013).
   */
  player?: EntityId;
  /**
   * Feature 0090 — the confessor's PUBLIC, byte-stable 0084 voice fingerprint. When supplied, the
   * target/ally lines are drawn from voice-keyed PARALLEL pools (a clipped/blunt voice confesses curtly,
   * a rambling/warm voice expansively) and a habitual `lexicon` filler is woven in deterministically, so
   * a comp-beast's confessional and a social-butterfly's read as two different PEOPLE even on identical
   * engine-grounded content (same target, same ally — that truth never changes; only the phrasing does).
   * ABSENT ⇒ the composer uses the original shared `TARGET_LINES`/`ALLY_LINES`, BYTE-IDENTICAL to 0040
   * (additive, back-compatible — the calibration spine is untouched). Voice carries NO hidden state
   * (mandate #2): it is read only for PHRASING and never moves a closed-set value (ADR 0005).
   */
  voice?: VoiceProfile;
  /**
   * Optional id→display-name resolver (#845 companion). When supplied, the composed `content` bakes the
   * DISPLAY NAME of the confessor + their target/ally (instead of the raw EntityId) into the line. This
   * matters for the PLAYER: their id is the BARE word `player` (`ids.ts`), which `humanizeForRetrospective`
   * deliberately leaves untranslated (the #845 common-noun guard resolves COLON-bearing ids only) — so a
   * confessional that targets the player would otherwise render the literal token "player" even in a named
   * game. Resolving here, at compose time, fixes that WITHOUT touching the bare-word exclusion downstream.
   * ABSENT ⇒ the raw id is baked, BYTE-IDENTICAL to the role-only behavior (additive, back-compatible) —
   * the role-only unit tests stay green. The resolver yields a PUBLIC display name only (no Vault read).
   */
  nameOf?: (id: EntityId) => string;
  /**
   * Feature 0122 — the caller-supplied, Vault-safe inputs that TRIGGER the deep facets. Present ⇒ the
   * composer computes + renders whichever facets are grounded (plan/standing/grudge/aftermath/adjacent),
   * appended after the base line; ABSENT ⇒ NONE of the deep logic runs and the confessional is
   * BYTE-IDENTICAL to 0040 (the calibration/golden guarantee — the daily sweep supplies this only when
   * the flag + in-game clock are live). The caller (`GameSessionAdapter`) computes these from PUBLIC role
   * state + the confessor's OWN witnessed events — never another houseguest's hidden read, never a number.
   */
  depth?: ConfessionalDepth;
}

/**
 * Feature 0122 — the Vault-safe grounding inputs for the deep facets, pre-computed by the caller (which
 * owns the live board + the confessor's witnessed events). `grudge` is derived INSIDE `confessionalFor`
 * from `rel` (lowest-trust peer below the grudge floor) — the rest are public-state facts the confessor
 * legitimately knows. Every field is optional: a facet renders only when its input is present, so depth
 * tracks the confessor's real situation (an HOH/nominee triggers several; a coasting houseguest none).
 */
export interface ConfessionalDepth {
  /** The confessor's PUBLIC role this week — drives the plan + safe/exposed standing. */
  role?: "hoh" | "veto-holder" | "nominee" | "none";
  /** A significant recent conversation partner the confessor witnessed (the "how that talk sat" facet). */
  recentTalk?: EntityId;
  /** A relation of the confessor who was just in a public beat, read through the bond (the adjacent move). */
  adjacent?: { relation: EntityId; bond: "ally" | "target"; beat: "won-power" | "nominated" };
}

const MOOD_OF = (state: number): "rattled" | "steady" | "confident" =>
  state < 0.4 ? "rattled" : state > 0.6 ? "confident" : "steady";

/**
 * ORW-509: each fallback pool is the authored lines (kept FIRST, so the no-rng `lines[0]` read is byte-identical) followed by lines COMPOSED from independent
 * parts (lead x core x closer). The pick is still one `rng.int(pool.length)`, so consumption is unchanged; the pool is just wide. The writer authors the live
 * confessional from the confessor's own read; these are what the engine says offline. Every part states the SAME engine-grounded fact (a voiced line never moves one).
 */
const widen = (authored: readonly string[], axes: ReadonlyArray<ReadonlyArray<string>>, join: (p: string[]) => string = joinSentence): string[] =>
  [...authored, ...composeAll(axes, join).filter((l) => !authored.includes(l))];
/** lead + core + closer; a closer carries its own leading punctuation (", and ..." / " - ...") so the join is a plain concatenation. */
function joinSentence(p: string[]): string {
  const [lead, core, closer] = p as [string, string, string];
  return `${lead ? `${lead} ` : ""}${core}${closer}`;
}

const TARGET_LEADS = ["", "", "Honestly,", "Look,", "Here's the thing:", "I'll say it plainly:", "Real talk:", "Between us,", "Not gonna lie,", "At this point,"];
const TARGET_CORES = [
  "{T} is the biggest threat in this house", "{T} has to be the next one out", "I can't see my game surviving {T}", "{T} is the name I keep landing on",
  "{T} is playing a better game than they're letting on", "I'd feel safer the day {T} is gone", "{T} is the one standing between me and the end", "every plan I make has {T} in the way",
];
const TARGET_CLOSERS = ["", ", and I'm not hiding it", ", whether they know it or not", ", plain and simple", ", and the clock is running", " - I just have to find the moment", ", and I've known it for a while"];
const ALLY_LEADS = ["", "", "Honestly,", "Look,", "If I'm being real,", "For what it's worth,", "At the end of the day,", "Weirdly,"];
const ALLY_CORES = [
  "{A} is the one person I'd trust with my game", "{A} has had my back from the start", "{A} is the closest thing I have to a real friend in here", "I feel safest when {A} is in the room",
  "{A} is the only one I'd tell the truth to", "{A} and I are on the same page about this whole house", "if it came down to it I'd walk to the end with {A}",
];
const ALLY_CLOSERS = ["", ", and that doesn't happen often", ", which says a lot in here", ", even if I'd never say it out loud", ", no matter how the week goes", ", and I think they feel the same"];
const GRUDGE_CORES = [
  "I haven't forgotten what {G} did to me", "{G} crossed a line with me and I'm still thinking about it", "what {G} pulled is still sitting with me", "I keep coming back to what {G} did",
  "{G} burned me once and I remember", "I'm not over {G} yet",
];
const GRUDGE_LEADS = ["", "And", "Also,", "Honestly,", "And look,", "Still,"];
const GRUDGE_CLOSERS = ["", ", and it shows", ", whatever they say", " - that isn't going away", ", and I won't pretend otherwise"];
const WARM_CORES = ["that talk with {P} left me feeling better", "talking with {P} cleared the air a little", "I came out of that chat with {P} closer to them", "{P} and I are in a better place after that"];
const COOL_CORES = ["that talk with {P} left me uneasy", "I walked away from {P} with more questions than answers", "something in how {P} spoke sits wrong with me", "I trust {P} a little less after that"];
const AFTERMATH_LEADS = ["", "Honestly,", "Funny thing is,", "After everything,", "Strange as it sounds,"];
const AFTERMATH_CLOSERS = ["", ", and I'm still turning it over", ", for better or worse", ", which I didn't expect", ", and I can't shake it"];
const CURT_TARGET_CORES = ["{T} goes", "{T}'s my target", "I'm coming for {T}", "{T}. That's the name", "It's {T}", "{T} is the one", "Eyes on {T}", "{T} has to go"];
const CURT_TARGET_CLOSERS = [". Done", ". Simple", ". No debate", ". Period", ". That's it", ". Moving on"];
const CURT_ALLY_CORES = ["{A}'s my one", "I trust {A}", "{A} and me", "Ride or die? {A}", "It's {A}. Always", "{A} has my back", "Only {A}", "{A}. No one else"];
const CURT_ALLY_CLOSERS = [". That's it", ". Locked", ". Nobody else", ". Period", ". Simple", ". Done"];
const EXP_TARGET_LEADS = ["okay so the thing is,", "look, I love a lot of people in here, but", "if I'm being real with myself,", "I keep going back and forth, and honestly,", "I didn't want to say this out loud, but", "so, like,"];
const EXP_TARGET_CORES = [
  "{T} is just - they're playing everyone, and it scares me a little", "every road to the end somehow runs straight through {T}", "{T} is the one keeping me up at night",
  "{T} is the biggest threat I've got, and the longer I sit on that the worse it gets",
];
const EXP_TARGET_CLOSERS = [", so yeah, they have to go", ", and I think deep down we all know it", ", and I just can't have that", ", and I need to do something about it soon", ", you know?"];
const EXP_ALLY_LEADS = ["but", "and then there's", "okay, and", "honestly,", "and I mean it, because", "oh my gosh,"];
const EXP_ALLY_CORES = [
  "{A} is the one person in here I genuinely trust", "{A} just gets me - we see this whole house the same way", "if I've got a ride-or-die in this place, it's {A}",
  "the only person I'd actually walk to the end with is {A}",
];
const EXP_ALLY_CLOSERS = [", like with everything", ", it's kind of wild", ", no question about it", ", and I'd do it in a heartbeat", ", honestly, completely"];

/** Varied target/ally phrasings ({T}/{A} = names) — seeded pick, grounded in the same engine truth. */
const TARGET_LINES = widen([
  "I need {T} gone — they're my biggest threat",
  "every road to the end runs through {T}, and they have to go",
  "{T} is the one I'm watching — they're playing everybody",
  "if I get any power this week, {T} is the name I write down",
], [TARGET_LEADS, TARGET_CORES, TARGET_CLOSERS]);
const ALLY_LINES = widen([
  "{A} is the one I actually trust",
  "if I have a ride-or-die in here, it's {A}",
  "{A} and I see this house the same way",
  "the only person I'd go to the end with is {A}",
], [ALLY_LEADS, ALLY_CORES, ALLY_CLOSERS]);
const MOOD_LINES: Record<"rattled" | "steady" | "confident", string> = {
  rattled: "I'm shaken — this house just got very real",
  steady: "I'm keeping my head down and my eyes open",
  confident: "honestly? I feel untouchable right now",
};

/**
 * Feature 0122 — the DEEP-facet phrasing pools ({T}=target, {G}=grudge, {P}=talk partner, {R}=relation).
 * Same seeded `pick` the base uses; every line states the SAME engine-grounded fact (the facet only
 * changes WHAT is voiced, never invents a stance). Each facet renders only when its trigger fired, so
 * these are drawn from à la carte — an HOH's confessional strings several, a coasting one none.
 */
const PLAN_LINES: Record<"hoh" | "veto-holder" | "nominee" | "none", string> = {
  hoh: "This power is mine now, so the plan is simple: {T} goes up",
  "veto-holder": "I've got the veto, and I'm using it to steer this straight at {T}",
  nominee: "I'm on the block, so I have to win — or {T} sends me home",
  none: "If I get any power at all, {T} is the name I'm writing down",
};
const STANDING_LINES: Record<"safe" | "exposed" | "reading", string> = {
  safe: "And I'm sitting pretty this week — nobody can touch me",
  exposed: "And I know exactly how exposed I am right now",
  reading: "And I'm still reading where I stand in all this",
};
const GRUDGE_LINES = widen([
  "I also haven't forgotten what {G} did to me",
  "and don't get me started on {G} — that betrayal still stings",
  "{G} crossed me once, and I hold onto that",
], [GRUDGE_LEADS, GRUDGE_CORES, GRUDGE_CLOSERS]);
const AFTERMATH_WARM_LINES = widen([
  "that talk with {P} sat right with me — we're tighter for it",
  "after getting into it with {P}, I feel better about where we are",
], [AFTERMATH_LEADS, WARM_CORES, AFTERMATH_CLOSERS]);
const AFTERMATH_COOL_LINES = widen([
  "that conversation with {P} put me on edge",
  "I came out of that talk with {P} trusting them a little less",
], [AFTERMATH_LEADS, COOL_CORES, AFTERMATH_CLOSERS]);
const ADJACENT_LINES: Record<"won-power" | "nominated", Record<"ally" | "target", string>> = {
  "won-power": {
    ally: "{R} taking power changes everything for me — my person is on top",
    target: "the one I'm gunning for, {R}, just grabbed power, and that's a problem",
  },
  nominated: {
    ally: "they put {R} on the block, and that's my closest person up there",
    target: "seeing {R} on the block? That's exactly where I wanted them",
  },
};

/**
 * Feature 0090 — VOICE-KEYED parallel target/ally pools. The same engine-grounded read ({T}/{A}) phrased
 * in three textures so the cast stops confessing in one uniform template voice: CURT (a clipped/blunt
 * voice — comp-beast, mastermind under pressure), EXPANSIVE (a rambling/warm voice — social-butterfly,
 * flirt), and MEASURED (the existing balanced pool, reused as the middle register). The pools are
 * deterministic data; the seeded `pick` chooses within the selected style exactly as the 0040 path does,
 * so a voiced confessional is as reproducible as an un-voiced one. Only the PHRASING differs across the
 * three — every line names the same {T}/{A} the engine computed (voice never moves a fact, ADR 0005).
 */
const CURT_TARGET_LINES = widen([
  "{T} goes. Simple as that",
  "{T}'s my target. Done",
  "I'm coming for {T} — no debate",
  "{T}. That's the name. Period",
], [[""], CURT_TARGET_CORES, CURT_TARGET_CLOSERS]);
const CURT_ALLY_LINES = widen([
  "{A}'s my one. That's it",
  "I trust {A}. Nobody else",
  "{A} and me — locked",
  "Ride or die? {A}",
], [[""], CURT_ALLY_CORES, CURT_ALLY_CLOSERS]);
const EXPANSIVE_TARGET_LINES = widen([
  "okay so the thing is, {T} is just — they're playing everyone, and honestly it scares me a little, so yeah, {T} has to go",
  "I keep coming back to {T}, you know? Every single road to the end somehow runs straight through them, and I just can't have that",
  "look, I love a lot of people in here, but {T}? {T} is the one keeping me up at night, and I think deep down we all know they've got to go",
  "if I'm being real with myself, {T} is the biggest threat I've got, and the longer I sit on that the worse it gets for me",
], [EXP_TARGET_LEADS, EXP_TARGET_CORES, EXP_TARGET_CLOSERS]);
const EXPANSIVE_ALLY_LINES = widen([
  "but {A} — oh my gosh, {A} is the one person in here I genuinely, completely trust, like with everything",
  "and then there's {A}, who honestly just gets me — we see this whole house exactly the same way, it's kind of wild",
  "if I've got a ride-or-die in this place, a real one, it's {A}, hundred percent, no question about it",
  "the only person I'd actually walk to the end with is {A} — I'd do it in a heartbeat, that's how much I mean it",
], [EXP_ALLY_LEADS, EXP_ALLY_CORES, EXP_ALLY_CLOSERS]);

/**
 * Feature 0090 — map a voice fingerprint to one of the three confessional textures. Reads only the PUBLIC
 * 0084 dials (`rhythm`/`directness`/`energy`), never any hidden state. A clipped/blunt voice ⇒ curt; a
 * rambling or warm/manic voice ⇒ expansive; everything else ⇒ the existing measured pool.
 */
function voiceStyle(voice: VoiceProfile): "curt" | "expansive" | "measured" {
  if (voice.rhythm === "clipped" || voice.directness === "blunt") return "curt";
  if (voice.rhythm === "rambling" || voice.energy === "manic" || voice.energy === "warm") return "expansive";
  return "measured";
}

/**
 * Build an NPC's confessional from their ACTUAL relationship signals (anti-sycophancy:
 * the NPC's "real feelings" are queried from the engine, not improvised). Pure + seeded.
 * With a `ConfessionalContext` (E55) the content is STRUCTURED — it names its trigger, carries
 * the confessor's mood, and varies its phrasing by seed — never one identical line all season.
 */
export function confessionalFor(
  npc: EntityId,
  others: readonly EntityId[],
  rel: RelationshipModel,
  ctx: ConfessionalContext = {},
): Confessional {
  let target: EntityId | null = null;
  let ally: EntityId | null = null;
  let maxThreat = -Infinity;
  // PV1 (#1029) — the player is an eligible SUBJECT of this read (never invented; same engine signals
  // as any houseguest). They are a candidate ONLY, never the confessor: `confessionalFor` is called
  // for an NPC `npc` and the player is excluded as a confessor upstream (`involvedConfessionals`).
  const candidates: readonly EntityId[] =
    ctx.player && ctx.player !== npc && !others.includes(ctx.player) ? [...others, ctx.player] : others;
  // First pass: the true biggest threat (their target) — unchanged read.
  for (const o of candidates) {
    if (o === npc) continue;
    const e = rel.edge(npc, o);
    if (e.threat > maxThreat) {
      maxThreat = e.threat;
      target = o;
    }
  }
  // Second pass: the strongest bond (their ally), EXCLUDING the target so the same
  // houseguest is never named as both biggest threat and most-trusted (issue #839). With
  // the top bond skipped this naturally falls to the runner-up; with 0/1 distinct others
  // `ally` legitimately stays null. Selection over existing edges only — consumes no rng.
  let maxBond = -Infinity;
  for (const o of candidates) {
    if (o === npc || o === target) continue;
    const e = rel.edge(npc, o);
    const bond = (e.trust + e.affinity) / 2;
    if (bond > maxBond) {
      maxBond = bond;
      ally = o;
    }
  }
  const pick = (lines: readonly string[]): string => (ctx.rng ? lines[ctx.rng.int(lines.length)]! : lines[0]!);
  // Feature 0090 — select the voice-keyed parallel pool when the confessor's 0084 voice is supplied; with
  // NO voice we use the exact 0040 shared pools (byte-identical fallback). A habitual `lexicon` filler is
  // woven in front of the target read for an expansive voice only (a warm/rambling cadence) — deterministic
  // (the first filler, no extra rng draw), a light seasoning per the no-catchphrase rule, never for a curt
  // voice (clipped voices don't pad). The {T}/{A} substitution is identical across all three styles.
  const style = ctx.voice ? voiceStyle(ctx.voice) : "measured";
  const targetPool =
    style === "curt" ? CURT_TARGET_LINES : style === "expansive" ? EXPANSIVE_TARGET_LINES : TARGET_LINES;
  const allyPool = style === "curt" ? CURT_ALLY_LINES : style === "expansive" ? EXPANSIVE_ALLY_LINES : ALLY_LINES;
  const filler =
    style === "expansive" && ctx.voice && ctx.voice.lexicon.length > 0 ? `${ctx.voice.lexicon[0]}, ` : "";
  // #845 companion — bake the DISPLAY NAME (not the raw id) into the line when a resolver is supplied. This
  // is the only thing that fixes a player-targeted confessional (the bare `player` id survives the
  // retrospective scrubber); for an NPC subject it is the same name the scrubber would resolve anyway. No
  // resolver ⇒ the raw id is substituted, BYTE-IDENTICAL to the role-only behavior.
  const display = (id: EntityId): string => (ctx.nameOf ? ctx.nameOf(id) : id);
  // `replaceAll`: the EXPANSIVE voice pool repeats {T} within one line, so a single-shot `.replace` left a
  // literal `{T}`/`{A}` in the rendered confessional — replace EVERY occurrence (the measured/curt pools
  // carry one each, so this is byte-identical for them).
  const targetStr = target
    ? `${filler}${pick(targetPool).replaceAll("{T}", display(target))}`
    : "I'm still reading the room";
  const allyStr = ally ? pick(allyPool).replaceAll("{A}", display(ally)) : "I'm not sure who to trust yet";
  const mood = ctx.emotionalState !== undefined ? MOOD_OF(ctx.emotionalState) : undefined;
  // Feature 0089 — when the caller hands over the confessor's OWN recent witnessed events, the line
  // OPENS with the concrete beat the engine selected (a real Diary Room reaction), then still names its
  // `trigger` beat so the structured occasion stays discoverable. The gists are already Vault-safe +
  // class-keyed (no number, no other-houseguest sealed read). With NO `recentEvents` the opening is
  // EXACTLY the 0040 `trigger` opener ⇒ the whole `content` is BYTE-IDENTICAL to 0040 (the back-compat
  // guarantee). The reacted facts NEVER assert an outcome the engine did not produce — they reference a
  // CLASS of beat the confessor lived ("after that competition", "after where that ceremony left me"),
  // so a reactive confessional can never fabricate a result (anti-sycophancy #3 / ADR 0005).
  const reactedGists = [...new Set((ctx.recentEvents ?? []).slice(0, CONFESSIONAL.anchorCount).map((f) => f.gist))];
  const reaction =
    reactedGists.length > 0
      ? `${reactedGists.join(", and ")}${ctx.trigger ? ` — after ${ctx.trigger}` : ""}: `
      : ctx.trigger
        ? `After ${ctx.trigger}: `
        : "";
  const opening = reaction;
  const moodStr = mood ? ` ${MOOD_LINES[mood]}.` : "";
  // Feature 0122 — the DEEP FACETS (triggered, not templated). Runs ONLY when the caller supplied
  // `ctx.depth` (the daily sweep, with the flag + in-game clock live); absent ⇒ none of this executes and
  // `content` + the structured fields are BYTE-IDENTICAL to 0040 (the calibration/golden guarantee). Every
  // facet is grounded in PUBLIC role/beat state + the confessor's OWN edges — no number, no other
  // houseguest's sealed read — and renders ONLY when its trigger fired, so an HOH/nominee strings several
  // while a coasting houseguest gets none.
  let planStr: string | undefined;
  let standing: "safe" | "exposed" | "reading" | undefined;
  let grudge: EntityId | null = null;
  let aftermath: EntityId | null = null;
  let adjacent: NonNullable<Confessional["adjacent"]> | null = null;
  const deepParts: string[] = [];
  const dep = ctx.depth;
  if (dep) {
    const role = dep.role;
    // plan — earned by power/danger (HOH / veto-holder / nominee); a coasting houseguest gets no plan.
    if (target && (role === "hoh" || role === "veto-holder" || role === "nominee")) {
      planStr = PLAN_LINES[role].replaceAll("{T}", display(target));
      deepParts.push(planStr);
    }
    // standing — safe/exposed from PUBLIC role state ONLY (never another houseguest's hidden threat-of-me).
    if (role === "nominee") standing = "exposed";
    else if (role === "hoh" || role === "veto-holder") standing = "safe";
    if (standing) deepParts.push(STANDING_LINES[standing]);
    // grudge — the lowest-trust peer below the grudge floor, PREFERRED distinct from the current target.
    let worstTrust: number = CONFESSIONAL.depth.grudgeTrust;
    for (const o of candidates) {
      if (o === npc) continue;
      const t = rel.edge(npc, o).trust;
      if (t < worstTrust) { worstTrust = t; grudge = o; }
    }
    if (grudge !== null && grudge === target) {
      let altTrust: number = CONFESSIONAL.depth.grudgeTrust;
      let alt: EntityId | null = null;
      for (const o of candidates) {
        if (o === npc || o === target) continue;
        const t = rel.edge(npc, o).trust;
        if (t < altTrust) { altTrust = t; alt = o; }
      }
      if (alt !== null) grudge = alt;
    }
    if (grudge !== null) deepParts.push(pick(GRUDGE_LINES).replaceAll("{G}", display(grudge)));
    // aftermath — how a significant recent conversation sat with them (warm vs cool by their OWN read).
    if (dep.recentTalk && dep.recentTalk !== npc) {
      aftermath = dep.recentTalk;
      const e = rel.edge(npc, aftermath);
      const warm = (e.trust + e.affinity) / 2 >= CONFESSIONAL.depth.clearBond;
      deepParts.push(pick(warm ? AFTERMATH_WARM_LINES : AFTERMATH_COOL_LINES).replaceAll("{P}", display(aftermath)));
    }
    // adjacent — a relation of theirs who just moved on the PUBLIC board, read through the bond.
    if (dep.adjacent && dep.adjacent.relation !== npc) {
      adjacent = dep.adjacent;
      deepParts.push(ADJACENT_LINES[adjacent.beat][adjacent.bond].replaceAll("{R}", display(adjacent.relation)));
    }
  }
  const deepStr = deepParts.length > 0 ? ` ${deepParts.join(". ")}.` : "";
  return {
    npc,
    target,
    ally,
    content: `[confessional ${display(npc)}] ${opening}${targetStr}. ${allyStr}.${moodStr}${deepStr}`,
    ...(ctx.trigger ? { trigger: ctx.trigger } : {}),
    ...(mood ? { mood } : {}),
    ...(planStr ? { plan: planStr } : {}),
    ...(standing ? { standing } : {}),
    ...(grudge !== null ? { grudge } : {}),
    ...(aftermath !== null ? { aftermath } : {}),
    ...(adjacent !== null ? { adjacent } : {}),
  };
}

/**
 * Feature 0122 — the BARE-GAME gate for the daily sweep. A houseguest with **nothing to say** stays
 * quiet that day: no clear TARGET (no peer they read as a real threat), no clear ALLY (no genuine bond),
 * and no salient recent beat they witnessed. Everyone with any real hook confesses; a pure wallflower
 * waits until the house touches them. Pure + grounded in the confessor's OWN edges (no number crosses).
 * `hasSalientRecent` is the caller's answer to "did they witness any non-flavor event recently?"
 * (`selectRecentForConfessional` supplies the recency).
 */
export function isBareGame(
  npc: EntityId,
  others: readonly EntityId[],
  rel: RelationshipModel,
  hasSalientRecent: boolean,
): boolean {
  let hasTarget = false;
  let hasAlly = false;
  for (const o of others) {
    if (o === npc) continue;
    const e = rel.edge(npc, o);
    if (e.threat >= CONFESSIONAL.depth.clearThreat) hasTarget = true;
    if ((e.trust + e.affinity) / 2 >= CONFESSIONAL.depth.clearBond) hasAlly = true;
  }
  return !hasTarget && !hasAlly && !hasSalientRecent;
}

/**
 * Feature 0089 — the pure SELECTOR/RANKER for a reactive confessional. Given the recorded events and the
 * confessor `npc`, it returns the top-N recent events THE CONFESSOR WITNESSED, redacted to Vault-safe
 * `RecentEventFact` gists, for `confessionalFor` to open the reaction with.
 *
 * The Vault Wall is structural here (mandate #2): the selector keeps ONLY events whose witness set
 * includes `npc` (`witnessedBy: npc`) — never another houseguest's hidden read, another's confessional,
 * or an off-screen scene the confessor was not in — so a confessional reacts to *what this person
 * lived*, never omniscient board truth. It returns no number and no other-houseguest sealed state: each
 * fact is the event's CLASS + the confessor's ROLE + a class-keyed `gist` (`confessionalConstants.ts`).
 *
 * Anti-sycophancy (mandate #3): the ENGINE selects which events + their factual class from the recorded
 * log; the model never selects or invents one. Determinism (0007): the ranking consumes NO rng beyond a
 * single optional seeded tiebreak (`opts.rng`) for events that tie on BOTH salience AND recency — it
 * draws on no shared stream, so the seeded society/competition/vote spine is untouched. Selection over
 * EXISTING events only; with the same history + seed it returns the same facts.
 */
export function selectRecentForConfessional(
  events: readonly GameEvent[],
  npc: EntityId,
  now: number,
  opts: { window?: number; count?: number; rng?: RandomnessSource } = {},
): RecentEventFact[] {
  const window = opts.window ?? CONFESSIONAL.recencyWindow;
  const count = opts.count ?? CONFESSIONAL.anchorCount;
  // Witness-set bound (the crux): only what the confessor legitimately witnessed. We also drop the
  // confessor's OWN confessionals — a confessional reacting to a prior confessional is self-referential
  // noise (and we never re-voice another confessional's content). `idx` preserves the append order so
  // recency is the original log position, not the post-filter position.
  //
  // BOUNDED SCAN (F-EN-2): the only events we rank are the LAST `window` the confessor witnessed, so we
  // walk the append-only log from the TAIL and stop as soon as we have `window` of them — rather than
  // map+filtering the whole, ever-growing log every tick (an O(events) per-tick, O(events²)/season cost).
  // In the common case (the confessor witnessed most of the recent house events) this scans only ~`window`
  // events from the end. Byte-identical to `events.filter(witnessed).slice(-window)`: same elements, same
  // original `idx`, same ascending order — so the ranking + result is unchanged.
  const recent: { ev: GameEvent; idx: number }[] = [];
  for (let idx = events.length - 1; idx >= 0 && recent.length < window; idx--) {
    const ev = events[idx]!;
    if (ev.witnessSet.includes(npc) && ev.type !== "confessional") recent.push({ ev, idx });
  }
  if (recent.length === 0) return [];
  recent.reverse(); // tail-first collection → restore ascending (append) order, matching `.slice(-window)`
  const ranked = recent
    .map(({ ev, idx }) => {
      const cls = salienceClassOf(ev);
      return { ev, idx, cls, salience: CONFESSIONAL.salience[cls] ?? CONFESSIONAL.salience.flavor! };
    })
    .sort((a, b) => {
      if (b.salience !== a.salience) return b.salience - a.salience; // more salient first
      if (b.idx !== a.idx) return b.idx - a.idx; // then more recent (later in the log) first
      return opts.rng ? opts.rng.int(2) * 2 - 1 : 0; // a true tie: seeded coin (no shared-stream draw)
    });
  void now; // accepted for symmetry with ts-based windows; recency is the log position here
  return ranked.slice(0, count).map(({ ev, cls }) => {
    const role: "initiator" | "witness" = ev.initiator === npc ? "initiator" : "witness";
    return { type: cls, role, gist: CONFESSIONAL.gists[cls]![role] };
  });
}

/**
 * Record a confessional as a VAULT-ONLY event: hidden, witnessed by the NPC alone —
 * the player is NEVER a witness, so it can never enter player knowledge (0002), and the
 * admin surface (which reads no events) never sees it (0001/0016).
 */
export function recordConfessional(events: EventStore, conf: Confessional, rng: RandomnessSource, ts: number): void {
  events.record({
    id: `confessional:${conf.npc}:${events.count()}:${rng.int(1_000_000_000)}`, // store-size-keyed: restart-safe (B71)
    ts,
    type: "confessional",
    initiator: conf.npc,
    witnessSet: [conf.npc],
    hidden: true,
    content: conf.content,
  });
}

/**
 * The directly-involved NPC houseguests at a dramatic beat (e.g. the HOH and the two nominees at a
 * nomination ceremony) each confess their REAL, engine-grounded read. The player is excluded — they
 * have their own player Diary Room (0013) and never confess as an NPC. Pure: returns the confessionals;
 * the caller records them Vault-only.
 */
export function involvedConfessionals(
  confessors: readonly EntityId[],
  houseguests: readonly EntityId[],
  rel: RelationshipModel,
  /** Per-confessor structured context (E55): trigger + soul mood + seeded phrasing. */
  ctxFor?: (npc: EntityId) => ConfessionalContext,
): Confessional[] {
  const seen = new Set<EntityId>();
  const out: Confessional[] = [];
  for (const c of confessors) {
    if (c === PLAYER || seen.has(c)) continue;
    seen.add(c);
    out.push(confessionalFor(c, houseguests, rel, ctxFor ? ctxFor(c) : {}));
  }
  return out;
}

/**
 * Fold a confessional into the confessing NPC's dynamic Soul (0024): append-only, so confessionals
 * ACCUMULATE across beats without losing earlier ones (0007), and a later `recall` can surface a
 * specific past confessional to keep the NPC's voice consistent. Vault-stays-Vault: the soul is
 * engine-only and the player never reads it; this only deepens the hidden interiority.
 */
export function recordConfessionalToSoul(soul: SoulProvider, conf: Confessional): void {
  soul.recordToSoul(conf.npc, conf.content);
}
