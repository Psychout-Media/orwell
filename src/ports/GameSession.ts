import type { EntityId } from "../domain/ids";
import type { PhysicalCharacteristics } from "../domain/physicalCharacteristics";
import type { VoiceProfile } from "../domain/voiceProfile";
import type { ExchangeAccounting } from "../engine/producerRead";
import type { Receipt } from "../engine/receipts";
import type { PullQuoteWeek } from "../engine/pullQuoteReel";
import type { StructuralMilestone } from "../engine/daySchedule";
import type { TimeOfDay } from "../engine/timeOfDay";

/**
 * 0104 — the OUTWARD notoriety projection: only the returning player's short, Vault-free legend
 * clauses ("what the new house has heard"). Deliberately NOT the engine's full `NotorietySummary` —
 * the reputation facets are hidden numbers that drive the day-one biases and must never cross.
 */
export interface NotorietyLegendView {
  legendBeats: string[];
}

/**
 * Vault-free game-session port (onboarding + per-moment prompt injection).
 *
 * The outward MCP server reaches the running game through THIS interface only —
 * every type here is Vault-free by construction, so no outward module gains a
 * Vault handle. Onboarding (`createCharacter`) runs the OOBE and starts a game;
 * `getGameState` returns the public projection; `getMomentPrompt` returns the
 * managed system prompt the front-end injects so the LLM narrates *as the game*
 * (never as a generic assistant) — the persona/framing layer, NOT a secrecy
 * mechanism (the Vault Wall stays structural).
 */

/**
 * The casting card (0050) — the interview's payoff: the player's character type, strategy, and the
 * producer's QUALITATIVE read of their strengths. Tier WORDS derived from the hidden balanced stats;
 * the numbers themselves never cross the wall (mandate #2/#3). Carries nothing about any NPC.
 */
export interface CastingCard {
  /** The canonical archetype the engine accepted (their own words live on the PlayerCard persona). */
  characterType: string;
  strategyStyle: string;
  /** Per-aptitude tier words (e.g. standout / solid / scrappy) — never numeric values. */
  strengths: { physical: string; mental: string; social: string };
  /** The player's own authored material, played back. */
  story?: string;
  motivation?: string;
  /**
   * True when the engine DEFAULTED the character type (C6): the interview never captured a
   * recognizable archetype, so the median spec was used — surfaced so an early finalization
   * is visible on the card rather than a silent stat assignment.
   */
  defaulted?: boolean;
}

/** The player's own authored card. They authored it, so persona is theirs — but NO numeric stats cross the wall. */
export interface PlayerCard {
  id: EntityId;
  name: string;
  archetype: string;
  strategyStyle: string;
  /**
   * Where the player stands in the game (0046): `active` (still playing), `jury` (evicted into the
   * last-9 jury — they spectate the public ceremonies and vote at the finale), or `evicted` (voted out
   * pre-jury — their season is over). Public, Vault-free: it says nothing about anyone's hidden state.
   */
  status: "active" | "jury" | "evicted";
  /**
   * 0133 — how an early-evicted player follows the rest of the season: absent for an active player or before the
   * choice; `watch` = the engine-built skeleton season (one `weekDigests` line per week), `skip` = fast-forwarded to
   * the finale. Public, Vault-free.
   */
  spectator?: "watch" | "skip";
  /** The casting interview's distilled card (0050) — qualitative only; re-showable all season. */
  castingCard?: CastingCard;
  /**
   * The player's OWN qualitative tiredness (ADR 0006 §Principle 5): "rested" | "tired" | "running on
   * empty", from how late THEY chose to stay up. Their own body is their own knowledge — a cue, never
   * a number, and never any NPC's sleep state. Absent pre-game / when the clock isn't running.
   */
  restStatus?: string;
  /**
   * How the PLAYER presents (issue #1326) — the player-authored counterpart of a houseguest's public
   * `genderPresentation` facet (same enum, same `domain/gender` helpers). OPTIONAL: the casting
   * interview may capture it via `updateCasting({ genderPresentation })`, but it never gates `ready`/
   * `finalizable` (a human may decline to answer). Absent when never recorded (every pre-#1326 save,
   * and any player who skipped the question) — the narrator then simply omits the pronoun clause for
   * the player rather than forcing an "unconfirmed" fallback (unlike an NPC, whose facet is always
   * dealt by the diversity floor — the player's silence is a legitimate choice, not a data gap).
   */
  genderPresentation?: "man" | "woman" | "nonbinary";
}

/**
 * A public houseguest card (B61): name + status + the CURATED PUBLIC persona facets — the
 * things any houseguest can see across the kitchen counter (and the narrator needs to give
 * each person a consistent voice). NEVER stats, the soul, relationship values, or hidden
 * elements; those stay engine-side (the live sentinel sweep guards this projection).
 */
export interface HouseguestCard {
  id: EntityId;
  name: string;
  /** active | jury (evicted into the last-9) | evicted (pre-jury). Public ceremony fact. */
  status: string;
  archetype?: string;
  strategyStyle?: string;
  background?: string;
  age?: number;
  /**
   * The prose appearance blurb (the older 0004 facet). PRE-0058 FALLBACK ONLY: a card carries EITHER the
   * structured `physicalCharacteristics` (0058 — the single source of truth narration AND the portrait
   * read) OR this prose line, NEVER both — they were independently generated and could otherwise
   * contradict on build/skin/hair (L29). New 0058 casts ship `physicalCharacteristics`; only a pre-0058
   * save (or the player, who has no structured facet) falls back to this.
   */
  appearance?: string;
  presentation?: string;
  /**
   * The concrete, diverse backstory facets (L28): the houseguest's vocation and hometown — public,
   * Vault-free origin facts the narrator voices instead of inventing (and mirroring the player).
   */
  vocation?: string;
  hometown?: string;
  /**
   * The observable public DEMEANOR / voice register (L28) — how this houseguest comes across in the
   * room (blunt, deadpan, anxious, grandiose…). Public, Vault-free: the narrator voices THIS stored
   * register so each person sounds distinct, instead of defaulting everyone to warm-and-witty.
   */
  demeanor?: string;
  /**
   * The model-authored FREEFORM identity concept (feature 0116) — who this houseguest IS in the model's
   * own words, the open-set identity the narrator voices ALONGSIDE the derived `archetype` tag (never
   * replacing it — ADR 0005 generalized to world-gen). PUBLIC, Vault-free, byte-stable. Present only on a
   * model-authored genesis cast; absent on the deterministic floor cast (where the archetype IS the identity).
   */
  identityConcept?: string;
  /**
   * The PUBLIC deep-profile facets (feature 0058): a multi-sentence `biography` (the presentable
   * backstory) and the STRUCTURED `physicalCharacteristics` facet (the single source of truth the
   * narration AND the portrait prompt both read, L29/L23). Public, Vault-free, byte-stable. The
   * HIDDEN half (secrets, true goals, weakness, Day-1 perception) NEVER appears on this card.
   */
  biography?: string;
  physicalCharacteristics?: PhysicalCharacteristics;
  /**
   * The PUBLIC diversity-identity facets (feature 0063): `ethnicity` is a first-class heritage / cultural
   * identity (an authentic facet of a full character that grounds the skin tone so text and portrait
   * agree); `genderPresentation` is how the houseguest presents; `outOrientation` is present ONLY when the
   * houseguest is PUBLICLY OUT (a public facet the house knows). A PRIVATELY-held orientation is NEVER on
   * this card — it is Vault-sealed and surfaces only via a 0002 pathway. Public, Vault-free, byte-stable.
   * Descriptive only — never a competition input, never a defining single word.
   */
  ethnicity?: string;
  genderPresentation?: "man" | "woman" | "nonbinary";
  outOrientation?: string;
  /**
   * PUBLIC, Vault-FREE provenance flag (#1067): is this card's deep profile the model-AUTHORED one or the
   * seeded deterministic floor? Mirrors the persisted `deepProfileAuthored` — `true` once `recordCastProfile`
   * has authored a richer PUBLIC facet for this houseguest, otherwise absent (a floor character). It says
   * NOTHING secret — only "has the FE cast-authoring write-back landed yet" — so the FE backfill can target
   * the still-floor cards. It is NOT hidden content and is safe on the player-facing roster.
   */
  authored?: boolean;
  /**
   * I6 distinct-voices fix (NARR-15/PROMPT-2, 2026-07-05): a COMPACT, PLAYER-SURFACE-SAFE text clause
   * for HOW this houseguest talks (feature 0084) — the narrator reads it EVERY turn so the cast sounds
   * like sixteen people, not one, WITHOUT depending on the per-NPC `npcVoice` call it reliably under-calls.
   *
   * It is a pre-rendered STRING built ONLY from the controlled voice DIAL vocabulary (register/rhythm/
   * energy/directness/humor/stress-tell) via `voiceFingerprint()` — deliberately NOT the raw `VoiceProfile`
   * object: the free-text `signature`/`lexicon` fields are legitimate public persona but uncontrolled prose
   * (e.g. a villain signature "makes a threat sound like small talk", a "100%" filler), which would trip the
   * coarse Vault-Wall player-surface scan. The dial vocab is a closed, audited set — no hidden-layer word,
   * no number — so this is provably safe to ride the Vault-free projection. PUBLIC, byte-stable; the FULL
   * fingerprint stays on `npcVoice` (not a scanned surface) for a deep scene. Absent only on a pre-0084 save.
   */
  voice?: string;
}

/**
 * A Vault-free projection of a deal the PLAYER is party to (0039): the FACT and status only —
 * parties, kind, terms, kept/open/broken. NEVER a trust/threat number; NPC↔NPC deals never appear.
 */
export interface DealView {
  id: string;
  parties: NamedRef[];
  kind: string;
  terms: string;
  status: "open" | "kept" | "broken";
  /** 0109 — the NEGOTIATED term, when one exists (the player's own knowledge; never a derived magnitude). */
  term?: { expiresWeek?: number; vague?: boolean };
  /** 0142 (package): the id the two parts of a package share. On the `package` view itself, `parts` lists both. */
  packageId?: string;
  parts?: DealView[];
}

/**
 * NPC deal CONSENT: the houseguest DECLINED the player's proposed deal (the ENGINE decided, from the NPC's own read of the player; the narrator only voices it). No deal was
 * recorded and nothing was folded. `reason` is a coarse, Vault-free category; `narratable` is an in-fiction line (no numbers). Distinct from `null`, which stays "invalid request".
 */
export interface DealRefusal {
  refused: true;
  reason: "distrust" | "threat" | "targeted" | "grudge" | "opposed" | "cost";
  narratable: string;
  /** 0142: a lukewarm houseguest (reason `cost`) answers with terms instead of a flat no. Present only when one now stands as the open `openDealOffer` (the player accepts or declines it with submitDecision deal-offer). */
  counteroffer?: { kind: string; terms: string };
}

/** A portrait prompt for one houseguest (0051) — returned at season start for the FE to call the image API. */
export interface PortraitPromptEntry {
  houseguestId: string;
  name: string;
  prompt: string;
}

/** The shared, frozen real-world slices the cast moved in with (0062) — public flavor only. */
export interface WorldSnapshotSlices {
  screen: string[];
  music: string[];
  sports: string[];
  news: string[];
  internet: string[];
  /** One line reading the cultural moment at move-in. */
  mood: string;
}

/**
 * The Vault-free projection of the move-in zeitgeist snapshot (0062). PUBLIC, shared real-world flavor —
 * never Vault, never a game input (§6). Carries the in-fiction move-in marker, how it was seeded, the
 * voiceable slices, and the off-screen-channel "world you moved in with" prompt block (the C32-beyond
 * reach, §5). Provenance fields (the real capture timestamp / lag) NEVER cross.
 */
export interface WorldSnapshotView {
  /** The in-fiction move-in date the house is frozen at. */
  capturedFor: string;
  /** How it was seeded: "web_search" | "model-framed" | "absent" (the fail-soft tier). */
  source: string;
  /** The voiceable slices (the FROZEN shared world). */
  slices: WorldSnapshotSlices;
  /** The rendered off-screen-channel prompt block (so an NPC-to-NPC scene shares the same world). */
  offscreenPrompt: string;
}

/** The FE write-back of a real captured zeitgeist (0062, §8) — public flavor; any subset of slices. */
export interface RecordWorldSnapshotReq {
  /** Optionally override the in-fiction move-in marker. */
  capturedFor?: string;
  /** Optional provenance (the real capture timestamp) — stored, never voiced. */
  capturedAt?: string;
  /** Any subset of the public slices (each bounded to the budget; empty keeps the fallback's value). */
  slices?: Partial<WorldSnapshotSlices>;
}

/**
 * ORW-319 (ORW-253 slice 5, spec 0146 lane 1): the FE-driven write-back of what the utility model read from each houseguest's PUBLIC
 * profile: habits (2-3 from the closed set) and a season-aim hint (closed set) with a short why. The engine validates every value and
 * keeps each houseguest's first accepted record (frozen, like the zeitgeist). Engine-side only (an aim is a motive: Vault-class).
 */
export interface RecordNpcTraitsReq { traits: Array<{ id: EntityId; habits: string[]; aimHint?: string; aimWhy?: string }> }
export interface RecordNpcTraitsResult { accepted: number; rejected: number }
/** ORW-319 (spec 0146 lane 2): the FE-driven house-culture write-back (spots, rituals, a running joke), from the cast's PUBLIC facets. Once per season. */
export interface RecordHouseCultureReq { spots?: Array<{ room: string; nickname: string }>; rituals?: Array<{ timeOfDay: string; action: string; name: string }>; runningJoke?: string }
export interface RecordHouseCultureResult { accepted: boolean; reason?: string }

/** Whether the zeitgeist write-back was accepted, and the resulting source tier (0062). */
export interface RecordWorldSnapshotResult {
  /** True iff a game is started and the snapshot could be frozen onto it. */
  accepted: boolean;
  /** The resulting source: "web_search" once a real capture lands; "absent" when there was no game. */
  source: string;
}

/**
 * The FE-driven producer-DEEPENING write-back (increment 3 of #1626) — the front-end (which owns a
 * utility LLM) AUTHORS a richer producer persona (backstory / temperament / disposition / wit / quirk)
 * and writes it BACK so the ENGINE stays the source of truth (the `recordWorldSnapshot` / `recordCastProfile`
 * handshake). It DEEPENS the seeded off-camera casting producer; it never touches the seeded NAME (the
 * byline stays byte-stable, so the chat sender never churns). Every field is OPEN-SET public voice PROSE —
 * there is NO stat, NO number, and NO hidden game state on this request BY CONSTRUCTION (no such field is
 * typed), so the producer's Vault-free guarantee is structural. An authored overlay ACCUMULATES onto the
 * seeded floor (and any prior overlay): a field the model omits keeps the seeded value (non-degradation).
 * Best-effort / idempotent / fail-soft: with no model wired, the engine never receives a payload and the
 * seeded producer simply stands. Not a model lever (FE-driven, like `recordWorldSnapshot`).
 */
export interface RecordProducerProfileReq {
  /** Core temperament / register, in the model's own words. */
  archetype?: string;
  /** Observable demeanor / voice register. */
  demeanor?: string;
  /** The strategic read on running a casting room — the lens the producer probes a player through. */
  disposition?: string;
  /** The calculated, deliberate WIT style. */
  wit?: string;
  /** A small, distinct verbal quirk that colors the voice consistently. */
  quirk?: string;
  /** A richer backstory — who this producer is and how they came to the casting desk. */
  backstory?: string;
  /**
   * IGNORED by construction — the byline is SEEDED and immovable so it never churns. Accepted on the
   * request only so an FE payload that echoes a name never fails; the engine never applies it.
   */
  name?: string;
}

/** Whether the producer-deepening write-back was accepted, Vault-free — reports field NAMES only. */
export interface RecordProducerProfileResult {
  /** True iff at least one open-set field validated and was folded onto the overlay. */
  accepted: boolean;
  /** The accepted open-set field NAMES (never their values — though the values carry no secret anyway). */
  fields: string[];
  /** Set when nothing was accepted: "empty" (no usable fields) | "rejected" (all present fields carried forbidden Vault vocabulary). */
  reason?: string;
}

/**
 * Feature #1400 — the "what to hand the model" projection for the CURRENTLY-STAGING competition, so the
 * FE can author a theme + premise + per-round fiction MATCHED to the engine's ALREADY-FIXED outcome. The
 * winner and the full drop order are FIXED before this is ever non-null (the model dresses a decided
 * result — it can never touch it). Vault-free by construction: names + the PUBLIC drop ORDER (the same
 * order the reveal already tells the player round by round) + the public 0042 library scaffold — never a
 * score, lean, or number. `null` unless generation is enabled AND a staged comp has resolved its roll.
 */
export interface CompetitionStagingView {
  /** Which comp is staging: "hoh-competition" | "veto-competition". */
  comp: string;
  /** The governing competition type (endurance/memory/…). */
  type: string;
  week: number;
  /** The drawn 0042 library format (endurance/puzzle/quiz/skill/crapshoot/social), when known. */
  format?: string;
  /** The full field that competed (names). */
  participants: NamedRef[];
  /** The FIXED winner (name) — decided up front; the fiction dresses this, it can never change it. */
  winner: NamedRef;
  /** The FIXED elimination order of the losers, earliest-out first (names) — author one line per entry, IN ORDER. */
  dropOrder: NamedRef[];
  /** The 0042 library scaffold the model riffs ON (and the deterministic floor when no fiction is authored).
   *  `theme` is the seeded 0125 skin (Vault-free flavor) the mechanic is already dressed in; absent when off. */
  library: { name: string; theme?: string; premise: string; beats: string[]; winReads: string };
  /**
   * Whether VALIDATED fiction is ALREADY stored for this competition — the FE's persistent "author exactly
   * once per comp" guard. The staged comp stays surfaced across every reveal round until it crowns, so the
   * FE fires its authoring kickoff after every advance/decision; it MUST no-op once this is true (a
   * re-author is a wasted utility call + an overwrite that makes later rounds render different staging than
   * earlier ones). True the moment a fiction write-back lands; false again only when the comp crowns.
   */
  alreadyAuthored: boolean;
}

/**
 * Feature #1400 — the FE-driven write-back of the model-authored competition fiction. The engine
 * VALIDATES (hard) that `eliminations` names the SAME houseguests in the SAME order as the fixed drop
 * order; on any mismatch it is REJECTED and the deterministic 0042 library floor stands (the model can
 * never rename who goes or in what order). PRESENTATION ONLY — recorded AFTER the roll commits.
 */
export interface RecordCompetitionFictionReq {
  /** Which comp this dresses — must match the currently-staging comp ("hoh-competition" | "veto-competition"). */
  comp: string;
  /** The week it was authored for — must match the live week (a staleness guard). */
  week: number;
  /** The invented competition theme/name. */
  theme: string;
  /** The staging premise (how it's set up + played). */
  premise: string;
  /** Optional "how a win reads" line. */
  winReads?: string;
  /** The per-elimination fiction, ORDERED — one entry per drop-order entry, naming the SAME ids in the SAME order. */
  eliminations: Array<{ id: EntityId; fiction: string }>;
}

/** Whether the competition-fiction write-back was accepted; a Vault-free reason when it was not. */
export interface RecordCompetitionFictionResult {
  /** True iff the fiction validated against the fixed drop order and was stored (else the 0042 floor stands). */
  accepted: boolean;
  /**
   * Why a write-back was refused (Vault-free): "disabled" (flag off) | "no-game" | "no-competition"
   * (no comp staging) | "not-resolved" (the roll has not committed yet) | "comp-mismatch" |
   * "week-mismatch" | "already-authored" (fiction is ALREADY stored for this (comp, week) — the
   * engine-side exactly-once guard; a second write is refused, never overwrites) | "drop-order-mismatch"
   * (the named eliminations did NOT match the fixed order — the core safety reject) | "empty-fiction".
   * Absent on acceptance.
   */
  reason?: string;
}

/** The Vault-free projection of the running game the front-end may render. */
/** 0133 — one public line per completed week: only broadcast ceremony facts (named, Vault-free). */
export interface WeekDigestView {
  week: number;
  hoh: NamedRef | null;
  nominees: NamedRef[];
  vetoHolder: NamedRef | null;
  vetoUsed: boolean;
  evicted: NamedRef | null;
  juryCount: number;
}

/** How a juror regards the player, read from the RECORDED manner of their eviction (categorical; no numbers). */
export type JurorBearing = "warm" | "even" | "cool" | "sour";

export interface JuryHouseJurorView {
  id: EntityId;
  name: string;
  /** The week they went home (public record). */
  evictedWeek: number | null;
  bearing: JurorBearing;
}

export interface JuryHouseView {
  /** The other jurors, in the order they joined the jury. Never includes the player. */
  jurors: JuryHouseJurorView[];
}

export interface GameStateView {
  started: boolean;
  /**
   * The monotonic per-sandbox beat counter (0065 Part A) — increments by one on every committed state
   * mutation; stable on a no-op. NOT secret (a counter carries no Vault content), so it crosses freely.
   * The FE holds the last-seen value per canonical session and attaches it as `expectedBeatSeq` on the
   * next mutating call, so a write computed against a superseded board is refused (409 `stale-beat`),
   * not applied. Restart-safe (persisted in the snapshot, co-versioned with the save, 0007/0030).
   */
  beatSeq: number;
  /** N-17 vs 0092 - present only after the engine has surfaced something to the player off the tool path (a confidant slip / gossip chain): a counter and the source's PUBLIC id, never content. The FE treats a change as "an engine delivery happened". */
  surfacedToPlayer?: { n: number; sourceId: EntityId };
  week: number;
  phase: string;
  /**
   * 0133 — present only for an early-evicted player who chose to follow the season: the engine-built
   * week-by-week digests since their eviction (public broadcast facts only). Absent otherwise.
   */
  weekDigests?: WeekDigestView[];
  /**
   * 0129 — the JURY HOUSE: present ONLY while the player holds a juror's seat (0046). The other houseguests who are
   * on the jury right now, with the player's own public read of each. Vault-free by construction: the roster is the
   * public eviction order; `bearing` is a CATEGORICAL read of the recorded eviction manner toward the player (the
   * player witnessed how they left) — never an edge number, never a hidden lean. Absent for everyone else.
   */
  juryHouse?: JuryHouseView;
  /**
   * The in-game TIME OF DAY (ADR 0006): "morning" | "afternoon" | "evening" | "night" | "late-night".
   * A coarse, PUBLIC, shared band (one clock for the whole house) — never a wall-clock, never a number.
   * Drives the time-of-day HUD and grounds narration in the real hour. Absent pre-game.
   */
  timeOfDay?: string;
  /**
   * P0 clock grounding - the engine's exact in-game clock as a plain label ("9:40am, Day 1"), present only while the clock is running (same gate as `timeOfDay`). Public, Vault-free; the narrator is
   * told to name no other time. Absent pre-game / clock dormant => byte-identical.
   */
  clockLabel?: string;
  /**
   * ADR 0006 — the houseguests who've TURNED IN for the night (the complement of the awake set). Names
   * only; Vault-free and OBSERVABLE (the bedtime derivation stays hidden). Present only when the clock is
   * running (absent ⇒ dormant); never includes the player (their night is their own rest cue).
   */
  asleep?: NamedRef[];
  /**
   * The season is OVER — a winner is crowned (audit B6-01). Vault-free (whether the game ended is
   * public). Lets the FE gate the season lifecycle (0057 next-season) and fill the progress bar to
   * 100% without inferring it from `moment`/`phase`. `finished` lives on `AdvanceView`/`SeasonRecap`
   * too; surfacing it here keeps every read consistent.
   */
  finished: boolean;
  /** The current beat key (drives which managed prompt fragment is injected). */
  moment: string;
  /**
   * #1411 — the single ENGINE-OWNED lever this closed-set beat REQUIRES the narrator to call this
   * turn (today `"advanceGame"` at the deterministic comp/ceremony/eviction beats), or ABSENT when the
   * beat has no single legal lever (every ordinary/social/premiere/finale beat). Vault-free by
   * construction: a lever NAME only — never a secret, a number, or the player's binding pick
   * (`submitDecision` is never named; forcing it would invent the player's choice). The FRONT-END reads
   * THIS to force `tool_choice` on the wire at the closed-set beats, instead of keeping its own
   * beat→lever map that could drift from the tool registry (`src/surfaces/tools/registry.ts`). Derived
   * purely from `phase` via `requiredLeverForPhase`. Absent ⇒ no forcing ⇒ byte-identical (opt-in /
   * back-compat, 0065 sync-spine discipline; the golden replay's non-force turns are untouched).
   */
  requiredLever?: string | null;
  /**
   * This week's ceremony state — the HOH, the nominees, and the veto. All PUBLIC ceremony facts the
   * whole house knows (Vault-free; mirrors `PublicGameStatus`). Surfaced into the model's persistent
   * GAME CONTEXT (audit C8-04) so the narrator voices the REAL HOH / nominations / veto holder
   * instead of inventing them when it narrates a ceremony without separately fetching the status.
   * Empty/null pre-game and between ceremonies.
   */
  ceremony: {
    hoh: { id: EntityId; name: string } | null;
    nominees: Array<{ id: EntityId; name: string }>;
    /**
     * The veto: who holds it + whether it was used, AND the SIX drawn to play the veto comp
     * (`players` — the witnessed chip draw, E35/C-03; empty before the draw). Surfaced so the
     * narrator voices who actually competes (and never tells the player they're benched when the
     * engine drew them IN — audit R9-AGENCY-1) instead of inventing the field.
     */
    veto: { holder: { id: EntityId; name: string } | null; used: boolean; players: Array<{ id: EntityId; name: string }> };
  };
  /**
   * WHERE THE PLAYER IS — their room, who is with them, and each ADJACENT room with its occupants
   * (the player's own scoped view, Vault-free: only what they could see or hear themselves; non-
   * adjacent rooms never appear). Surfaced into the model's persistent GAME CONTEXT (L21/L24) so the
   * narrator voices the REAL occupancy instead of inventing positions or "still to arrive" houseguests
   * (the engine seats everyone at premiere — there are no arrivals). Null pre-game / when the player
   * is out of the house. Also feeds the "Where you are" gadget (L26).
   */
  whereabouts?: WhereaboutsView | null;
  player: PlayerCard | null;
  house: HouseguestCard[];
  /** Deals the player is party to (0039) — fact + status only, never the hidden opinion numbers. */
  deals?: DealView[];
  /**
   * The PUBLIC showmances (0059/L40) — the houseguest pairs whose romance has become VISIBLE to the
   * whole house (stage `visible`). A public fact at that point (not a Vault leak), surfaced so the
   * narrator may voice romance for THESE pairs only — never for ordinary high-affinity friendships.
   * Pre-visible (sealed) showmances and the pre-game ties NEVER appear here. Absent when there are none.
   */
  showmances?: Array<{ a: string; b: string }>;
  /** Pre-game only (0050): where the casting interview stands — what's captured, what's next. */
  casting?: CastingStatusView;
  /**
   * PREMIERE only (feature #380 follow-on): the engine-tracked meet-everyone progress — who the
   * player has met so far and who is STILL to introduce before the first HOH, each with their
   * OBSERVABLE public persona. Surfaced into the premiere moment prompt so the producer always
   * knows the next unmet houseguest (it never relies on the model to REMEMBER, the real bug), and
   * exposed for a player-facing "first impressions" surface. Present ONLY during the premiere
   * moment; absent once the first HOH begins. Vault-free — public facets only (see PremiereIntrosView).
   */
  premiere?: PremiereIntrosView;
  /**
   * Feature 01791 — Notoriety legend clauses: the Vault-free "what they heard about you" clauses
   * from the returning player's legend. Present on premiere and early-social (week 1 social)
   * phases when the player returned as the same character (has notoriety). Absent otherwise.
   * Vault-free by construction — open-set flavor strings only, never numbers or hidden state.
   */
  notorietyLegend?: string[];
  /**
   * #1792 — Producer Read: Vault-free post-scene exchange-accounting string,
   * delivered ONCE in the moment prompt immediately following a substantive
   * recordInteraction. Absent when no exchange is pending (flag OFF ⇒ byte-identical).
   * Vault-free by construction — boolean accounting + open-set summary strings only,
   * never numbers or hidden state.
   */
  producerRead?: string;
  /** Portrait prompts returned at season start (0051) — present only on the createCharacter response. The FE calls the image API with these and stores the results. */
  portraitPrompts?: PortraitPromptEntry[];
  /**
   * The producer's Diary-Room invitation (feature 0013 §5): present, with `invite: true`, when the
   * CURRENT beat is dramatic enough for the producers to gently pull the player aside (nomination,
   * veto ceremony, eviction — `src/engine/diaryRoom.ts` `producerPrompt`/`isDramatic`). Absent at every
   * routine beat. Vault-free by construction — `reason` is a short, non-numeric label naming which
   * beat triggered it, never a secret or a number; this is an INVITATION the front-end may voice, never
   * a forced interruption, and it carries no obligation — declining changes nothing.
   */
  diaryRoomInvite?: { invite: true; reason?: string };
  /**
   * 0115 — the player's recent Diary-Room STRATEGY, in their own words (most-recent-first, capped).
   * Vault-free by construction: it is the player's OWN out-of-character `NO_NPC_PATHWAY` knowledge —
   * never a Vault read, never any NPC's knowledge. Surfaced into the narrator's GAME CONTEXT as a
   * PRIVATE steer (`renderGameContext` fences it as GM-only / do-not-voice) so the GM narrates the
   * player's scenes grounded in their REAL strategy — the irony of a lie — instead of believing their
   * public mask, while the house stays deceived. The DR wall is unchanged: this NEVER reaches an NPC's
   * knowledge and NEVER drives NPC behavior (that stays structural). Absent when the player recorded none.
   */
  playerDiaryRoom?: string[];
  /**
   * #1793 — the player's OWN Diary-Room reads, grouped per houseguest (subject).
   * The player's own NO_NPC_PATHWAY knowledge with a subject field, grouped by subject.
   * NEVER reads engine truth, Vault, or NPC knowledge — only the player's own tagged reads.
   * When subjectId is specified, returns only that houseguest's entries.
   * Absent when the flag is OFF (byte-identical).
   */
  playerDossier?: Record<EntityId, { content: string; ts: number }[]>;
  /**
   * ADR 0019 Layer 2 — the per-PRESENT-NPC knowledge scope. For each houseguest actually in the
   * scene (`whereabouts.present`), the SAME Vault-free `knows`/`suspects` sets `npcVoice` returns —
   * baked into the built context so the narrator voices each present houseguest from THEIR bounded
   * knowledge BY DEFAULT, without depending on the reliably-under-called `npcVoice` tool. "Context is
   * not knowledge": a fact witnessed only by B appears here ONLY under B's block, never A's — so the
   * model is not handed (and cannot voice) what a given present houseguest has no in-game pathway to.
   * Vault-free by construction (mirrors `npcVoice.knows/suspects` — humanized content only, never a
   * number, never the hidden layer). Absent pre-game / when nobody is present ⇒ byte-identical.
   */
  presentKnowledge?: PresentKnowledgeView[];
  /**
   * 0118 — the DAY'S SHAPE, telegraphed: the next scheduled ceremony milestone, the in-game phase it is
   * set for ("this afternoon"), and whether the clock has reached it (`due`). Vault-free by construction —
   * a pure read of the live loop state + the day clock (no secret, no number beyond the public schedule).
   * The HUD shows it and the narrator context primes on it so run-up scenes carry the awareness of the
   * coming interruption. Present ONLY when the per-conversation clock is live (absent in the seeded
   * calibration spine / golden replay, which pin that clock off) ⇒ byte-identical (the 0108 golden fixture this once referenced was decommissioned 2026-07-21; nothing to re-record).
   */
  /** A8 (flag `ORWELL_DESIRE_CLOCK`): an NPC whose own desire clock crossed its threshold is cutting into the conversation - public name + coarse desire only. Absent when off / nobody. */
  interruption?: { npc: string; desire: string; /** ORW-261: what the houseguest chose to tell the player unprompted as they step in (already the player's own told-by knowledge). */ tells?: string };
  daySchedule?: { next: StructuralMilestone; phase: TimeOfDay; due: boolean; /** A7: whole in-game minutes until it is due (0 once due) - drives the optional 30-minute warning. */ minutesUntil?: number; /** ORW-258: while the next event waits behind its night, the event that belongs to TODAY (the header names it). Absent otherwise. */ todaysEvent?: StructuralMilestone };
  /**
   * A `createCharacter` that was REFUSED rather than honored (audit R4-05): a game already exists
   * and no `confirmRestart` was given, so the prior season is intact and untouched (this view IS
   * that prior season, not a new one). `in-progress` (a season is live) or `over` (a winner is
   * crowned). The producer must NOT narrate a new season — direct the player to the menu / a
   * confirmed restart. Absent on a real (fresh or confirmed) creation.
   *
   * `casting-incomplete` (the mobile short-circuit fix, 0050): the finalize carried a name but ZERO
   * authored substance (no archetype/strategy/backstory/motivation/persona/notes) — minting it would
   * produce the default-archetype "floater with no stats." The interview must continue; this is NOT a
   * started season (the prior state, if any, is untouched).
   */
  createRefused?: "in-progress" | "over" | "casting-incomplete";
  /**
   * A human-readable reason for `createRefused` (issue #1033 / F-2): the coded `createRefused` told
   * the FE WHICH refusal, but a stuck casting loop surfaced no diagnosis to the model/player. This
   * carries a plain-language reason string so the GM can tell the player WHY the season didn't start
   * (e.g. "the interview still needs more substance …") instead of silently looping. Vault-free —
   * it names only the missing player-authored intake, never any secret state. Present whenever
   * `createRefused` is.
   */
  createRefusedReason?: string;
  /**
   * ORW-208 - present ONLY when the strategy style the caller asked for was NOT one of the chosen archetype's own styles and the engine
   * stored the archetype's first style instead (it drives hidden stats/leakiness). Previously this substitution was silent. Public labels only.
   */
  strategyStyleAdjusted?: { requested: string; applied: string; archetype: string };
  /**
   * RC5 / feature 0116 / #1599 — the cast-identity COHERENCE outcome of this game start (Vault-free
   * diagnostic; NEVER player content, never a secret). A model-authored dossier is assembled across three
   * async write-backs (genesis skeleton + `recordCastIdentity` gender pin + `recordCastProfile` body), so a
   * houseguest can go live INTERNALLY CONTRADICTORY — the pinned `genderPresentation` reads one sex while a
   * self-referential field ("her shyness" / "his forearm") names the other (the Lily Evans object), or a bio
   * states a life span implausible for the age, or a public vocation disagrees with the cover story. At game
   * start the engine runs `validateDossierCoherence` over every committed Character and AUTO-CORRECTS: it
   * REPAIRS a hard contradiction (clears only the offending self-referential field — the pinned gender spine
   * is authoritative and never cleared), and if a contradiction SURVIVES repair it FLOORS the remaining
   * self-referential prose (never ships a contradictory cast). Present ONLY when a correction happened;
   * `repaired`/`floored` count the affected houseguests, and `houseguests[]` names the ids + the public
   * identity fields the correction touched (no secret content). The FE routes this to the #1599 health
   * rollup so an AUTO-CORRECTED cast still shows RED on /admin/status (a correction is not a cloak). Absent
   * on a clean cast (the deterministic floor is always coherent ⇒ this never appears for a floor cast).
   */
  castCoherence?: {
    repaired: number;
    floored: number;
    houseguests: Array<{ id: EntityId; fields: string[]; action: "repaired" | "floored" }>;
  };
  /**
   * M0-7 — the live pending decision, IDENTICAL to `gameStatus().pending` (both read
   * `pendingView()`). The two closed-set projections of one sandbox used to DISAGREE: a
   * pending created inside an advance (the eviction-vote ballot) surfaced on `gameStatus`
   * but read null here, and any consumer keying on state inherited the gap silently (the
   * golden driver absorbed 25 escalated turns on exactly this). Vault-free — the same
   * legal-options view the decision card renders.
   */
  pending: PendingDecisionView | null;
  /**
   * A-15 (rehearsal 2026-11-03) — the eviction staging state, the SAME Vault-free `EvictionView` advance returns: `null` when no
   * eviction is staging (or the game is finished); otherwise the anonymized ballots revealed SO FAR (never a voter, never a
   * tally). While the player's own eviction-vote card is open the view is non-null with an EMPTY `votesRevealed`; do not read
   * `null` as "the player has not voted yet". The FE's role-claim guard treats a count of 0 as "no ballot may air yet", so a
   * narrator cannot air a ballot or tally the engine has not revealed.
   */
  eviction?: EvictionView | null;
  /**
   * 0123 (PO ruling 2026-11-01) — a deal a houseguest has floated to the player and the player has not
   * answered yet, or null. NOT a pending decision and never a pop-up: it never blocks the week. The
   * narrator voices the houseguest raising it in-scene; when the player answers in chat it records the
   * answer via `submitDecision({ kind: "deal-offer", vote: "accept" | "decline" })`. Unanswered, it lapses
   * when the week rolls. Vault-free: public name, deal kind, a terms paraphrase — no numbers.
   */
  openDealOffer?: OpenDealOfferView | null;
  /** 0142: favors houseguests owe the player (present only while any are banked). */
  owedFavors?: OwedFavorView[];
}

/**
 * The casting interview's incremental intake (0050). OOBE is no longer one atomic call: the
 * producer records each answer AS IT LANDS, the engine tracks which building blocks are in,
 * and that status determines the interview's next step. All fields are the player's own
 * authored material; the intake lives pre-game and is durable (a half-done interview survives
 * a restart, 0030). `createCharacter` finalizes from it.
 */
export interface UpdateCastingReq {
  /**
   * The cast photo step (casting step #1, the photo-first OOBE): FE-set when the in-chat photo box
   * closes — `"uploaded"` (a cast photo was finalized) or `"skipped"` (the player declined). Any
   * non-empty string marks the step handled. The FIRST entry of `CASTING_COVERAGE`, so a fresh
   * interview's `next` asks for it before anything else — but it is OPTIONAL: it does NOT gate
   * `ready` (which stays name-only), so finalization proceeds whether the photo was uploaded or
   * skipped. Vault-free: the player's own metadata, never secret.
   */
  castPhoto?: string;
  /** The player's display name — the one REQUIRED field before casting can finalize. */
  playerName?: string;
  /** The producer's canonical casting-sheet mapping (drives balanced hidden stats). */
  archetype?: string;
  strategyStyle?: string;
  /** The player's OWN words for who they are / how they'll play (display & narrative only). */
  personaArchetype?: string;
  personaStrategyStyle?: string;
  /** Their life outside the house, in their words. */
  backstory?: string;
  /** Why they came to play — player-only material. */
  motivation?: string;
  /** How they ACTUALLY plan to play — player-only (NO_NPC_PATHWAY, 0013/0015). */
  privateStrategy?: string;
  /** Get-to-know notes — APPENDED to what's already recorded (never replaced). */
  interviewNotes?: string[];
  /**
   * How the player presents (issue #1326) — OPTIONAL, mirrors a houseguest's public
   * `genderPresentation` facet (same "man" | "woman" | "nonbinary" enum, same `domain/gender`
   * helpers). Stored as a plain string here (the incremental intake never type-narrows a scalar at
   * merge time — see `mergeCastingUpdate`); `createCharacter` validates it against the enum via
   * `isGenderPresentation` before it reaches the Character, exactly like `archetype`/`strategyStyle`.
   * Never gates `ready`/`finalizable` — a player may decline to answer.
   */
  genderPresentation?: string;
}

/** Where the casting interview stands (0050) — Vault-free; it echoes only the player's own words. */
export interface CastingStatusView {
  /** Fields already captured, echoing the recorded value (notes echo as a count). */
  known: Record<string, string>;
  /** Coverage still to acquire, in the engine's interview order. */
  missing: string[];
  /** The engine-picked next step of the interview (null when coverage is complete). */
  next: string | null;
  /** True once the required minimum (a name) is in — createCharacter may finalize. */
  ready: boolean;
  /**
   * True once a GENUINE interview has happened (name + backstory + motivation + at least one persona/
   * strategy answer; the cast photo does NOT count). `ready` is the floor for an EXPLICIT, player-driven
   * finalize; `finalizable` is the floor for an AUTOMATED/forced finalize — without it the mobile short-
   * circuit minted a default-archetype "floater with no stats" after only name+photo. Vault-free.
   */
  finalizable: boolean;
  /**
   * Scalar fields this update OVERWROTE — an already-captured value replaced by a different one
   * (audit C8's third sub-item). Present only on the `updateCasting` that caused it, so the
   * producer can CONFIRM the replacement ("changing their backstory — got it") rather than
   * silently clobbering an answer. Empty/absent when nothing captured was changed.
   */
  overwrote?: string[];
  /**
   * Keys the caller passed that are NOT casting fields (audit R4-01) — e.g. `name` (the field is
   * `playerName`), `notes`, or a typo. Echoed so a recording is never silently dropped: the
   * producer learns the answer didn't land and can re-file it under the right field. Absent when
   * every key was understood.
   */
  ignoredKeys?: string[];
  /**
   * Casting is CLOSED — there is already a game (audit R4-05). An honest refusal instead of a
   * fake "ready": `in-progress` (a season is live) or `over` (a winner is crowned). The producer
   * must NOT keep interviewing or claim a season started; a new season begins only through the
   * sanctioned restart door (the menu / a confirmed `createCharacter`). Absent pre-game.
   */
  refused?: "in-progress" | "over";
}

/** The player makes a deal WITH a houseguest (player↔NPC). NPC↔NPC deals are off-screen/Vault-held. */
/**
 * 0107 — the player names an alliance. `members` are the houseguests they propose; the engine bond-GATES
 * who actually joins (the unbonded decline), so this is a proposal, not a fiat. `name` is the player's
 * label for it (the cementing act).
 */
export interface FormAllianceReq {
  name: string;
  members: EntityId[];
  expectedBeatSeq?: number;
}

/** 0107 Phase B — the player accepts an alliance an NPC pitched them into (by its id). */
export interface JoinAllianceReq {
  allianceId: string;
  expectedBeatSeq?: number;
}

/** 0107 — a Vault-safe view of a named alliance: the NAME + members + whether the player founded it.
 *  Never carries the cement/favor magnitudes (those stay engine-only). */
export interface AllianceView {
  id: string;
  name: string;
  members: NamedRef[];
  youAreFounder: boolean;
}

/**
 * Features 0093 + 0099 — an optional, Vault-free descriptor for wielding a held secret WHILE making a
 * deal: `leverage` (0093 — a secret the player holds ABOUT the deal partner, pressed to color THAT
 * partner's formation likelihood) or `tradedSecret` (0099 — a secret the player holds about a THIRD
 * party, handed to the deal partner as consideration, valued to THE PARTNER). Either references a
 * `factId` the player already legitimately holds (validated against `knownTo(player)` — the player can
 * only wield what they learned), OR is a `bluff` (a fabricated claim that reads NOTHING from the Vault).
 * Absent ⇒ deal formation is BYTE-IDENTICAL to 0039 (fully opt-in). The engine owns the magnitude.
 */
export interface SecretLeverDescriptor {
  /** The learned fact the player wields (by its knowledge `factId`). Required unless `bluff` is set. */
  factId?: string;
  /**
   * A BLUFF (deception, owner direction 2026-06-27): the player invents a claim instead of wielding a
   * real held fact. No `factId` / no Vault read; the engine folds on BELIEF (trust × plausibility) and
   * NEVER tells the player whether the bluff matched a real truth. `subject` names who the bluff is about.
   */
  bluff?: boolean;
  /** For a `tradedSecret`/bluff: the houseguest the secret is ABOUT (the third-party subject). */
  subject?: EntityId;
}

/** The single-promise deal kinds a `makeDeal` may name (a `package` bundles two of these). */
export type DealReqKind = "safety" | "vote" | "final-two" | "target-other" | "comp-throw" | "veto-save" | "protect-third" | "conditional" | "information";

export interface MakeDealReq {
  with: EntityId;
  // 0121 — the two ACTIVE-obligation kinds (comp-throw / veto-save) are accepted only when the deal-depth
  // layer is on (`makeDeal` refuses them otherwise); off ⇒ only the four defensive kinds, byte-identical.
  kind: DealReqKind | "package";
  terms: string;
  /**
   * 0142 (ORW-88 idea 3) - for `protect-third` only: the THIRD houseguest the NPC swears not to move against (nominate, replace or vote out). The NPC is always the promisor (the player
   * asked them); a played game with the deal-depth layer on is required. Ignored for every other kind.
   */
  third?: EntityId;
  /**
   * B55 - for the ACTIVE kinds only (comp-throw / veto-save): who promises. `offer` (the default - "I'll throw it for you") binds the PLAYER; `ask` ("will you throw it for me?") binds the NPC. Ignored for the defensive kinds.
   */
  direction?: "offer" | "ask";
  /**
   * 0109 — OPTIONAL negotiated term, PROPOSED by the narrator from what was said in the scene. `weeks` =
   * how many weeks the promise runs counting the current one ("this week only" = 1, "for two weeks" = 2);
   * `vague` = the term was left unspoken. The ENGINE validates and bounds it (`DEAL_DURATION.maxTermWeeks`; a
   * non-integer / non-positive / non-finite `weeks` is ignored; an explicit `weeks` wins over `vague`) and
   * owns the break-severity magnitude it modulates. Absent / invalid ⇒ the kind-implied horizon,
   * byte-identical to 0039.
   */
  term?: { weeks?: number; vague?: boolean };
  /**
   * 0142 (ORW-88 idea 3) - for `package` only: the TWO promises bundled in one deal with `with` (each `{ kind, third?, terms? }`, the kinds being any of the defensive kinds, `protect-third`, `conditional` or
   * `information`; `third` as for `protect-third`). Each is adjudicated on its own; a break of either costs the package's reliability. Played games with deal depth on only. Ignored for every other kind.
   */
  parts?: Array<{ kind: Exclude<DealReqKind, "comp-throw" | "veto-save">; third?: EntityId; terms?: string }>;
  /**
   * 0093 — OPTIONAL leverage: a secret the player holds ABOUT the deal partner (`with`), pressed to make
   * them more likely to enter/honor the deal. The threat persists while the deal is open (owner R4);
   * EXPOSING the secret spends it. The engine owns the bounded, seeded factor; a wary partner can refuse
   * and resent it. Absent ⇒ deal formation byte-identical to 0039.
   */
  leverage?: SecretLeverDescriptor;
  /**
   * 0099 — OPTIONAL traded secret: a secret the player holds about a THIRD party, handed to the deal
   * partner (`with`) as consideration. Valued to the PARTNER (what they'd do with it); the partner learns
   * the secret via a recorded `told` pathway. Absent ⇒ deal formation byte-identical to 0039/0093.
   */
  tradedSecret?: SecretLeverDescriptor;
  /**
   * Optional compare-and-swap token (0065 Part A): the `beatSeq` the caller computed this write
   * against. When present and `!== current`, the engine REFUSES with a typed `stale-beat` conflict
   * (HTTP 409, no state change). Absent ⇒ byte-identical to the pre-0065 path (opt-in).
   */
  expectedBeatSeq?: number;
  /**
   * A10 / #591 / R1c — OPTIONAL at-most-once idempotency key (0065 Part B), the sibling of
   * `recordInteraction`'s. `makeDeal` creates a tracked promise AND folds consequence (a leverage
   * squeeze / a traded-secret warmth), so a stale-409 re-drive under sustained two-window concurrency
   * could double-apply (a duplicate deal + a doubled hidden-layer move). A REPEAT key returns the prior
   * `DealView` WITHOUT re-creating the deal or re-folding — checked BEFORE the CAS guard, so a re-driven
   * duplicate is a clean no-op even against a board that has since moved. Absent ⇒ byte-identical (opt-in).
   */
  idempotencyKey?: string;
}

/**
 * 0093 — the player OUTS a learned secret to the house (or a specific audience). The single engine
 * authority (like `runCompetition` / `confide`): the model previews/voices, the ENGINE resolves the
 * bounded, seeded standing fold + exposer backlash + records the exposure as a witnessed pathway event.
 */
export interface ExposeSecretReq {
  /** The learned fact the player exposes (by its knowledge `factId`). Required unless `bluff` is set. */
  factId?: string;
  /** A BLUFF expose (deception): the player publicly CLAIMS a secret they did not learn. No Vault read. */
  bluff?: boolean;
  /** The houseguest the secret is ABOUT (the subject who takes the standing hit). Required for a bluff. */
  subject?: EntityId;
  /** 0065 Part A — optional compare-and-swap token; stale ⇒ 409, no exposure. */
  expectedBeatSeq?: number;
  /**
   * A10 / #591 / R1c — OPTIONAL at-most-once idempotency key (0065 Part B), the `recordInteraction`
   * sibling. `exposeSecret` folds the standing hit onto the whole house + the exposer backlash and spends
   * the secret / increments the per-season cap, so a re-driven duplicate could double-apply. A REPEAT key
   * returns the prior `ExposeResult` WITHOUT re-folding or re-spending — checked BEFORE the CAS guard.
   * Absent ⇒ byte-identical (opt-in).
   */
  idempotencyKey?: string;
}

/**
 * 0093 — the result of an `exposeSecret`. The engine decided the bounded standing fold + backlash and
 * recorded the exposure as a witnessed pathway event. `exposed` is whether it went through (a non-learned
 * `factId`, a spent secret, or the season cap ⇒ false). NO number ever crosses — only what the model may
 * voice (`subjectImpactNarratable` is a Vault-safe phrase, never a magnitude).
 */
export interface ExposeResult {
  exposed: boolean;
  /** Why an expose was refused (Vault-free): "not-learned" | "already-spent" | "capped" | "no-subject". */
  refused?: "not-learned" | "already-spent" | "capped" | "no-subject";
  /** A Vault-safe phrase the model may voice for the fallout — never a number, never the hidden delta. */
  subjectImpactNarratable?: string;
}

/**
 * 0099 — the player TRADES a held secret to a THIRD-PARTY recipient for a one-off, non-deal concession
 * (a comp throw, a secret-for-secret swap). The single engine authority: the engine values the secret
 * to the recipient, resolves whether they take it, folds the relationship change, and records the trade
 * as a witnessed `told` pathway event (the recipient now holds the secret). For a STANDING deal, use
 * `makeDeal`'s `tradedSecret` descriptor instead.
 */
export interface TradeSecretReq {
  /** The learned fact the player offers (by its knowledge `factId`). Required unless `bluff` is set. */
  factId?: string;
  /** The recipient houseguest the secret is handed to (NOT necessarily its subject). */
  toNpcId: EntityId;
  /** A BLUFF trade (deception): the player offers a fabricated secret. No Vault read. */
  bluff?: boolean;
  /** For a bluff: who the fabricated secret is about. */
  subject?: EntityId;
  /** What the player asks in return (Vault-free label for the model to voice — never an outcome lever). */
  askKind?: string;
  /** 0065 Part A — optional compare-and-swap token. */
  expectedBeatSeq?: number;
  /**
   * A10 / #591 / R1c — OPTIONAL at-most-once idempotency key (0065 Part B), the `recordInteraction`
   * sibling. `tradeSecret` folds the recipient's warmth/sour, surfaces the secret, and increments the
   * per-season trade cap, so a re-driven duplicate could double-apply. A REPEAT key returns the prior
   * `TradeResult` WITHOUT re-folding or re-spending — checked BEFORE the CAS guard. Absent ⇒ byte-identical.
   */
  idempotencyKey?: string;
}

/** 0099 — the result of a `tradeSecret`. `accepted` is whether the recipient took it; no number crosses. */
export interface TradeResult {
  accepted: boolean;
  /** Why a trade was refused (Vault-free): "not-learned" | "already-spent" | "capped" | "declined" | "no-recipient". */
  refused?: "not-learned" | "already-spent" | "capped" | "declined" | "no-recipient";
  /** A Vault-safe phrase the model may voice — never a number, never the trade value. */
  narratable?: string;
}

/**
 * Feature 0095 — the Vault-safe result of `accuseTie`. The engine alone checked the SEALED pre-game-tie
 * layer (0059) and decided whether the pair really has one: `landed` is whether a real tie exists and
 * the accusation exposed it (the tie jumps to `public`, a betrayal-grade fallout folds); a `false` means
 * either no such tie exists OR the season exposure cap is already spent. NO number crosses and there is
 * NO tell distinguishing a miss from a hit beyond the fiction — the player infers a hit only from how
 * the accused pair and the house react, exactly as 0075 gives no "they're lying" marker.
 */
export interface AccuseTieResult {
  landed: boolean;
}

/**
 * Feature 0094 — the Vault-safe result of `confront`. `landed: true` means the cited belief was
 * faithful and the confrontation plays out as expected; `landed: false` means it was materially
 * distorted and the move misfired against reality — the engine NEVER states this is because the belief
 * was wrong, and NO confidence/distortion number ever crosses either way.
 */
export interface ConfrontResult {
  landed: boolean;
}

/** 0142: the houseguests who owe the player a favor for a deal they kept (Vault-free; `n` is how many are banked). */
export interface OwedFavorView { from: NamedRef; n: number }

/** 0142: a called-in favor. The ENGINE priced it; `honored` => an ordinary deal of `kind` now binds the houseguest; otherwise they ignored it (the favor is spent and the player's read of them drops). */
export interface CallInFavorResult { honored: boolean; kind: string; narratable: string }

/**
 * The result of a `confide` (feature 0075). The engine decided WHETHER the houseguest opened up,
 * WHICH tier (how much), and whether it was a real confidence or a fabricated one (a lie). The
 * `content` is the text the model is handed to VOICE — already redacted/fabricated to the tier, so
 * no undisclosed secret ever crosses. `truthful` is the ENGINE's record (so a later pathway can
 * contradict a lie); it is NOT a player-facing tell — the model voices the confidence plainly and
 * judging it is the human's job (anti-sycophancy). A motive below the floor ⇒ `disclosed: false`
 * and no `content` (the model plays the deflection — itself a small, real beat).
 */
export interface ConfideResult {
  disclosed: boolean;
  tier: "none" | "tease" | "partial" | "full";
  truthful: boolean;
  /** The text to voice — present only when `disclosed`. Redacted/fabricated to the tier. */
  content?: string;
}

/**
 * 0129 slice 3 — the juror-player asks a fellow juror what they know (the jury-house Q&A). The ENGINE decides
 * whether the juror tells (their bearing toward the player gates it) and WHICH of the juror's OWN
 * witnessed-or-told facts they share; the telling reaches the player only through the content-anchored
 * `told-by:<juror>` pathway. `told:false` ⇒ the model plays the deflection. No hidden lean/number crosses, and
 * there is NO pathway back to the live house.
 */
export interface AskJurorResult {
  told: boolean;
  /** The juror's bearing toward the player (categorical, the slice-1 word). */
  bearing: JurorBearing;
  /** The text to voice — present only when `told`; one fact the juror legitimately holds. */
  content?: string;
}

export interface CreateCharacterReq {
  /**
   * The player's authored display name (the only human-authored profile). Optional since 0050:
   * when omitted, finalization uses the name the casting interview recorded via `updateCasting`
   * (a name from SOMEWHERE is still required — creation is rejected without one).
   */
  playerName?: string;
  archetype?: string;
  strategyStyle?: string;
  // --- Casting-interview deepeners (0050): the producer's distillation of the interview. ---
  /** The player's OWN words for who they are / how they'll play (display & narrative only). */
  personaArchetype?: string;
  personaStrategyStyle?: string;
  /** Their life outside the house, in their words → the static Character's background. */
  backstory?: string;
  /** Why they came to play — player-only material; seeds the Soul memory. */
  motivation?: string;
  /** How they ACTUALLY plan to play — player-only (NO_NPC_PATHWAY, 0013/0015). */
  privateStrategy?: string;
  /** Distilled get-to-know answers — seed the Soul memory as the player's pre-game memories. */
  interviewNotes?: string[];
  /**
   * How the player presents (issue #1326) — OPTIONAL override, same shape/validation as the intake
   * field of the same name (`UpdateCastingReq.genderPresentation`); explicit args win over the intake
   * field-by-field like every other deepener here.
   */
  genderPresentation?: string;
  /** Optional seed for a reproducible house; the front-end may send a random one for variety. */
  seed?: number;
  /**
   * Explicit opt-in to REPLACE an already-started game (non-degradation guard, B36/audit A2). Without
   * it, calling `createCharacter` on a started season is REFUSED with a reason (`createRefused`) and
   * returns the current state UNCHANGED — so a stray/hallucinated/network call can never wipe an active
   * game. A real restart sets this (the admin reset path) — it is NOT part of the player tool's documented schema.
   */
  confirmRestart?: boolean;
  /**
   * Season-to-season continuity (0056): on a CONFIRMED restart, KEEP the prior player's character —
   * carry their authored fields (name/archetype/strategy/persona/backstory/motivation/private
   * strategy/interview notes) into the new season so the SAME static CHARACTER returns to a NEW cast
   * (a fresh seed). Explicit fields here still override field-by-field (a player may tweak on the way
   * through). The dynamic SOUL/relationships reset at move-in. Ignored without `confirmRestart`, and
   * a no-op on a fresh (no prior game) creation. Absent/false ⇒ a normal fresh creation (re-run casting).
   */
  keepCharacter?: boolean;
  /**
   * Cross-season name memory (NAME-1 / #547) — names used by PRIOR seasons in the SAME game, so a new
   * season's corpus-sampled cast AVOIDS them (replayability/sameness, mandate #4). Carries both full
   * names and given names. ENGINE-INTERNAL: set on a confirmed restart from the dead season's roster
   * (never part of the player tool's documented schema, like `confirmRestart`). Bounded & fail-soft —
   * if the corpus has no headroom to honor every exclusion, the sampler relaxes it rather than failing.
   */
  priorCastNames?: string[];
  /**
   * Season-over-season NOTORIETY carry (0104 / R4 — the diegetic opt-in). ENGINE-INTERNAL: the adapter
   * sets it true when this confirmed restart is a SAME-CHARACTER return (`keepCharacter`), so the
   * registry's restart hook folds the user's accumulated notoriety into the new cast's day-one reads. A
   * NEW-character restart leaves it absent ⇒ a clean slate ⇒ byte-identical `seedFirstImpressions`.
   * Never part of the player tool's documented schema (like `confirmRestart` / `priorCastNames`); the
   * adapter derives it from `keepCharacter` because the strip to `keepCharacter:false` happens first.
   */
  carriesNotoriety?: boolean;
}

export interface MomentPromptReq {
  /** Override the phase-derived beat (e.g. "diary-room", "character-creation"). */
  moment?: string;
  /**
   * Showrunner memory, Show Brief v1 skeleton (K6 §3, ORWELL_SHOW_BRIEF): present ONLY when the caller wants the
   * terminal Show Brief for this turn. Absent ⇒ the response is byte-identical to before (no `showBrief`).
   */
  brief?: ShowBriefReq;
}

/**
 * What the FE sends when it asks for a Show Brief. Every field is optional and re-validated by the engine; the
 * brief itself is built from the engine's own Vault-free projections, never from these strings (the FE echoes
 * are only used to say what CHANGED and which absences to state).
 */
export interface ShowBriefReq {
  /** The `seen` state the PREVIOUS brief of this conversation returned (the narrator's last view). Absent on the first brief. */
  seen?: BriefSeenState;
  /** Houseguest ids the player's latest message or the last scene named (resolved by the FE from the public roster). */
  askedAbout?: EntityId[];
  /** The last lines the player saw: the tail of the previous narrated reply, out-of-character asides removed. */
  lastShown?: string;
}

/** The player-visible state a brief was built from, echoed back by the FE next turn (no hidden position ever). */
export interface BriefSeenState {
  v: 1;
  beatSeq: number;
  /** The in-game clock label at that brief, when the clock runs. */
  clock?: string;
  /** The player's room. */
  room: string;
  /** Who was with the player (ids, sorted). */
  here: EntityId[];
  /** Each room in the player's sightline and who was in it (ids, sorted). */
  inView: Array<{ room: string; ids: EntityId[] }>;
}

/** The Show Brief v1 skeleton: one terminal system message, fixed section order, Vault-free by construction. */
/** ORW-223: the room-canon write-back request. Exactly these two fields; extra keys are rejected. */
export interface RecordRoomCanonReq {
  roomId: string;
  /** One line of narrated texture about the room, at most `ROOM_CANON_FEATURE_MAX` characters. */
  feature: string;
}

export interface RecordRoomCanonResult {
  accepted: boolean;
  /** Present when `accepted` is false: a code, never an echo of the text. */
  reason?: string;
  entryId?: string;
}

export interface ShowBriefView {
  text: string;
  /** Echo this back as `brief.seen` on the next turn. */
  seen: BriefSeenState;
  beatSeq: number;
  /** chars / 4.1 (the K6 estimator). */
  tokens: number;
  sections: Array<{ id: "header" | "now" | "changed" | "established" | "canon" | "threads"; tokens: number }>;
}

export interface MomentPromptView {
  moment: string;
  /** The composed system prompt to inject for this moment — base persona + beat fragment + Vault-free context. */
  systemPrompt: string;
  /**
   * #1735 (A4) — the terminal HARD-CONSTRAINTS block: THIS turn's binding pins (scene occupancy,
   * present-NPC pronoun locks, per-present-NPC knowledge scope), stated IMPERATIVELY and meant for the
   * caller to append as the LAST message of the turn, nearest generation — measured (live A/B on
   * GLM-4.7, reasoning-off) to bind pronoun/location far more reliably than the SAME facts stated once,
   * softly, mid-`systemPrompt` (the "lost in the middle" region on a long turn). A pure, Vault-free
   * restatement of facts already carried elsewhere in `systemPrompt` — never a new source of truth.
   * Absent when there is nothing to pin (pre-game, or the player has no live whereabouts this turn).
   */
  hardConstraints?: string;
  /** The producer persona's public name — the casting-interview voice / narrator byline (producer-persona
   *  feature). Vault-free (public voice flavor only). The FE uses it as the chat sender name so the
   *  producer reads as a real person, not the generic "Production" label. Always present. */
  producerName: string;
  /**
   * Showrunner memory — the Show Brief v1 skeleton, present ONLY when the request carried `brief` and a season is
   * live with the player in the house. Meant to be appended as a terminal system message, after the transcript,
   * so the cached prompt prefix is untouched.
   */
  showBrief?: ShowBriefView;
}

/**
 * Feature #1394 — narrator memory callbacks. The FE asks, before framing a player↔NPC scene, for the
 * witnessed past moments involving the houseguest(s) the player is with, so the narrator can reference
 * a real earlier beat ("you told me on day 3 you'd never write my name down"). Vault-free by
 * construction: the adapter reads ONLY the player's visible projection (see the registry wiring).
 */
export interface RecallSceneMemoriesReq {
  /** The houseguest(s) the player is in a scene with — the FE presence seam (`whereabouts.present` ids).
   *  Recall is scoped to witnessed moments involving these NPCs. Absent/empty ⇒ no recall. */
  withIds?: EntityId[];
  /** The current scene cue to rank relevance against (the player's message). Absent/empty ⇒ no recall. */
  cue?: string;
}

export interface RecallSceneMemoriesView {
  /** 0–2 Vault-free witnessed moments to hand the narrator as "facts you may reference." Empty when
   *  there is no relevant history (the enrichment policy: recall absence is NOT a failure). */
  moments: string[];
}

export interface RunCompetitionReq {
  /** Competition type; an unknown/missing value falls back to a sensible default. */
  type?: string;
  /** Optional subset of houseguest ids to compete; defaults to the whole house. */
  participantIds?: EntityId[];
}

/**
 * Vault-free competition outcome: the engine-decided winner (name only). The
 * engine resolves it from the live house's OWN stats — the caller (LLM/front-end)
 * supplies no stats and receives no scores or rankings (anti-sycophancy + Vault Wall).
 */
export interface CompetitionResultView {
  started: boolean;
  type: string;
  week: number;
  phase: string;
  winner: { id: EntityId; name: string } | null;
  /** The drawn competition's name (0042) — set while a comp beat is live. */
  name?: string;
  /** The seeded THEME/skin over the mechanic (0125) — e.g. "Outer Space". Vault-free flavor; absent when themes are off. */
  theme?: string;
  /** The drawn competition's narrative format (endurance / puzzle / quiz / skill / crapshoot / social). */
  format?: string;
  /** The Vault-free narrative scaffold (0042/0018): premise + beats + how a win reads — flavor only, never a stat or score. */
  narrative?: { premise: string; beats: string[]; winReads: string };
}

/** Vault-free public status for the status panel (0020): ceremony-level facts only. */
export interface PublicGameStatus {
  /**
   * The monotonic per-sandbox beat counter (0065 Part A) — see `GameStateView.beatSeq`. Surfaced on
   * every read/advance result so the FE always has the freshest token to attach to its next mutating
   * call. Vault-free (a counter carries no Vault content); restart-safe (persisted in the snapshot).
   */
  beatSeq: number;
  week: number;
  phase: string;
  /**
   * The in-game TIME OF DAY (ADR 0006) — see `GameStateView.timeOfDay`. The shared, public day-phase
   * the time-of-day HUD renders; Vault-free; absent pre-game / when the clock isn't running.
   */
  timeOfDay?: string;
  /** ORW-115 (Ryne: "Time of day only"): the in-game DAY number the HUD shows beside the time of day ("Morning, Day 1") - the same day as `GameStateView.clockLabel`. Public; present only while the clock runs. */
  dayNumber?: number;
  /**
   * ADR 0006 — the houseguests who've TURNED IN for the night (see `GameStateView.asleep`). Names only;
   * Vault-free; present only when the clock is running.
   */
  asleep?: NamedRef[];
  /**
   * The in-game DAY within the current HOH week (E58): hoh=1, nominations=2, veto=3,
   * veto-ceremony=4, eviction=5 — the canonical `dayOfWeek(phase)` mapping that already feeds the
   * GM moment prompt, now surfaced so the player UI can show "Day N". `null` off the weekly ladder
   * (pre-game, finale, twist beats). Ceremony-level fact only — no hidden state.
   */
  day: number | null;
  hoh: { id: EntityId; name: string } | null;
  nominees: Array<{ id: EntityId; name: string }>;
  veto: {
    holder: { id: EntityId; name: string } | null;
    used: boolean;
    /**
     * The drawn six (E35): WHO plays the Power of Veto this week — the witnessed chip draw is a
     * public ceremony of its own (HOH + the two nominees + three by chip, incl. any Houseguest's-
     * Choice pick). Empty before the draw has run and after the week rolls. Vault-free: the field
     * is public the moment the chips are pulled, so the narrator names THESE exact players instead
     * of inventing who competes (parallels the nominee grounding, audit C-03).
     */
    players: Array<{ id: EntityId; name: string }>;
  };
  /**
   * The CURRENT binding decision the loop is blocked on (the same Vault-free legal-options view the
   * advance returns), or null when the engine isn't waiting on the player. Surfaced here so the
   * decision card can re-arm from ENGINE TRUTH after a reload — robust to a front-end restart or an
   * out-of-band advance (the FE's last-seen cache is process-local and goes stale; this never does).
   */
  pending: PendingDecisionView | null;
  /**
   * 0123 (PO ruling 2026-11-01) — a deal a houseguest has floated to the player and the player has not
   * answered yet, or null. NOT a pending decision and never a pop-up: it never blocks the week. The
   * narrator voices the houseguest raising it in-scene; when the player answers in chat it records the
   * answer via `submitDecision({ kind: "deal-offer", vote: "accept" | "decline" })`. Unanswered, it lapses
   * when the week rolls. Vault-free: public name, deal kind, a terms paraphrase — no numbers.
   */
  openDealOffer?: OpenDealOfferView | null;
  /** 0142: favors houseguests owe the player (present only while any are banked). */
  owedFavors?: OwedFavorView[];
  /**
   * F3: whether the season is OVER (a winner is crowned). Mirrors the same public over-signal as
   * `AdvanceView.finished` / `SeasonRecap.finished` (`this.live.finished`). Surfaced here so a client
   * that only watches the status panel learns the game ended without separately hitting `/state` or
   * `/recap` — otherwise it hangs on the last ceremony state post-season.
   */
  finished: boolean;
  /**
   * F3: the PUBLIC broadcast season winner (id + display name), post-season only, else null. The same
   * Vault-free public winner exposed for the finale/retrospective (`this.live.winner`) — a broadcast
   * fact the whole house knows, NEVER any secret/Vault data.
   */
  winner: NamedRef | null;
  /** 0107 — the named alliances the player is a member of (Vault-safe: name + members, never a number). */
  alliances?: AllianceView[];
  /** 0107 Phase B — alliances an NPC has pitched the player (aware of, not yet a member): `joinAlliance` to accept. */
  alliancePitches?: AllianceView[];
}

/**
 * A player-visible event the delta feed (0065 Part E) emits — the SAME Vault-free projection the
 * player surface reads (ids→names scrubbed; never hidden/Vault content). `id`/`ts` let the FE de-dupe
 * against what it already showed; `content` is the player-facing prose.
 */
export interface DeltaEventView {
  id: string;
  ts: number;
  type: string;
  content: string;
}

/**
 * The `beatSeq`-keyed delta state feed (0065 Part E) — given the caller's last-seen `beatSeq`, exactly
 * WHAT CHANGED since: the player-visible events appended, the ceremony field transitions, and any
 * finished/winner flip. The FE weaves a tight "since your last turn: …" line into the moment context
 * so staleness is self-evident, and the engine's per-turn export stops growing with season length (the
 * delta is O(Δ) — it materializes only the events after the token, never the whole log; the R3 cure).
 *
 * VAULT-FREE BY CONSTRUCTION: `events` reuse the player's witness-filtered visible projection (no hidden
 * content), `board`/`changes` are the same ceremony-level public facts `gameStatus` exposes, and a
 * counter carries no Vault content. CROSS-USER ISOLATED: it reads only this sandbox's session.
 *
 * Two non-delta signals the FE must honor instead of guessing:
 *  - `fullRefresh` — the token is UNKNOWN (ahead of the current counter, negative, or older than the
 *    retained history window — e.g. after a restart, which resets the window). The FE should fetch the
 *    full projection (`getGameState`) rather than trust an incomplete delta. `events` is then empty.
 *  - an EMPTY delta (`events: []`, `changes` absent, `finishedChanged` false) — `sinceBeatSeq` equals
 *    the current `beatSeq`: nothing has committed since ("since last turn: nothing committed").
 */
export interface StateDeltaView {
  /** The current committed beat counter (what the caller should re-ground its last-seen token to). */
  beatSeq: number;
  /** True iff the token was unknown/too-old: fetch the full projection instead of trusting this delta. */
  fullRefresh: boolean;
  /** The player-visible events appended since the token, in order (empty on full-refresh / no change). */
  events: DeltaEventView[];
  /**
   * T0-3 — the broadcast chyron(s) committed since the token, in commit order (a reconnecting/second
   * window's catch-up path; the live path is `AdvanceView.announcements` on the mutating call itself).
   * Absent/empty on a full refresh or when nothing new committed — same absent-semantics as `events`.
   */
  announcements?: BeatAnnouncementView[];
  /**
   * The ceremony field transitions since the token — only the fields that actually CHANGED appear
   * (so an unchanged field is absent, not echoed). Present only when at least one changed; absent on a
   * full refresh or an empty delta. Vault-free (the same ceremony-level public facts as `board`).
   */
  changes?: {
    week?: { from: number; to: number };
    phase?: { from: string; to: string };
    hoh?: { from: NamedRef | null; to: NamedRef | null };
    nominees?: { from: NamedRef[]; to: NamedRef[] };
    vetoHolder?: { from: NamedRef | null; to: NamedRef | null };
    vetoUsed?: { from: boolean; to: boolean };
  };
  /** True iff the season's finished/winner flipped since the token (the terminal transition). */
  finishedChanged?: boolean;
  /** The winner now (name only), if the season is over; null otherwise. */
  winner?: NamedRef | null;
  /** The CURRENT Vault-free board (ceremony-level public status) — the freshest ground to re-anchor on. */
  board: PublicGameStatus;
}

/** A named houseguest reference for decisions/options (Vault-free — id + name only). */
export interface NamedRef {
  id: EntityId;
  name: string;
}

/**
 * T0-3 (issue #1778, D1 2026-07-21 owner ruling — the scoped ADR 0003 amendment): the kinds of
 * committed CLOSED-SET ceremony fact the engine broadcasts as a `BeatAnnouncementView` instead of
 * leaving the narration model to report it. Weekly-loop scope (HOH → eviction); finale/twist/
 * battle-back kinds are a follow-up (see `src/engine/beatAnnouncement.ts`'s doc comment).
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
  | "final-hoh-part";

/**
 * T0-3 — a single Vault-free, engine-authored broadcast fact for a JUST-COMMITTED ceremony beat.
 * The FE renders each as a diegetic broadcast "chyron" card (extending the shipped decision-card
 * family, `orwellDecision.js`) instead of trusting the narration model to state the outcome — this
 * is the structural fix for playtest findings F1 (phantom closed-set narration), F4 (triple
 * re-narration/silent retcons), and F5 (E12 secret-ballot misattribution): the chyron is the ONLY
 * source of truth for the fact; the model is demoted to color ("the chat gains a stage, not a
 * dashboard" — see `docs/decisions/0003-the-conversation-is-the-game.md`'s T0-3 amendment).
 *
 * `id` is a STABLE, NEVER-REUSED per-sandbox dedup key (monotonic; survives a restart) so a client
 * that sees the same announcement twice (a reload, a reconnecting mirror window) renders it exactly
 * once. `beatSeq` is the 0065 spine counter AS OF the commit that produced this fact — announcements
 * committed together (e.g. a T0-2 auto-advanced beat chained onto a resolved pending) share one
 * `beatSeq`, in commit order.
 */
export interface BeatAnnouncementView {
  id: string;
  kind: BeatAnnouncementKind;
  week: number;
  beatSeq: number;
  /** The Vault-free broadcast prose — deterministic, built ONLY from public ids (never the LLM). */
  headline: string;
  /** The houseguest(s) this fact is ABOUT, in the kind-specific fixed order documented on `BeatAnnouncementKind`'s builder (`buildBeatAnnouncements`). For `eviction-ballot`: the anonymized ballot sequence — the nominee each ballot named, in reveal order, NEVER the voter (E12). */
  subjects: NamedRef[];
  detail?: {
    /** Who is RESPONSIBLE for this fact (the nominating/replacing HOH); absent when not applicable. */
    by?: NamedRef;
    /** `veto-decision` only: whether the holder played the veto. */
    used?: boolean;
    /** `veto-decision` only, when used: who was saved. */
    saved?: NamedRef;
    /** `eviction-result` only: the HOH broke a tied vote (never implies an extra "HOH ballot", E12). */
    tieBroken?: boolean;
    /** `comp-round-result` only: houseguests still in the competition after this round's drops (a public count). */
    remaining?: number;
    /** `final-hoh-part` only (0128): which part of the three-part Final HOH the subject just won (1 or 2). */
    part?: number;
  };
}

/** A meaningful weekly-loop beat that just resolved (player-witnessed; names, not ids). */
export interface BeatEventView {
  beat: string;
  content: string;
  /**
   * EVT-1 (#569): the PUBLIC houseguests this beat is about (the new HOH, the nominees, the veto
   * field, the evictee…), projected role-safe — id + name only, exactly the public roster facts the
   * `content` prose already names. NON-VAULT by construction (it reads only `BeatEvent.participants`,
   * which carries identities, never hidden/secret state), so a ceremony result's identities are
   * structured for the surface instead of being prose-only. Absent ⇒ no participant beat (e.g. no event).
   */
  participants?: NamedRef[];
  /** A9 - structured, Vault-free detail for the premiere-entrance / premiere-toast beats (public names only). */
  detail?: unknown;
}

/** 0123 — a standing NPC deal offer, voiced in-scene (see `openDealOffer`). */
export interface OpenDealOfferView {
  from: NamedRef;
  kind: string;
  terms: string;
  /** The in-game week it was floated — it lapses when the week rolls past this. */
  madeWeek: number;
  /** The narrator's voicing instruction for this offer (carried here, not in the base prompt). */
  howToVoice: string;
}

/** ORW-281 slice 4a: the staged-ceremony step handle (`step` is 1-based; `of` is null when a ceremony's length is open-ended). */
export interface CeremonyStepView {
  kind: "nominations" | "veto-draw" | "veto-ceremony" | "eviction" | "final-eviction";
  step: number;
  of: number | null;
  stepId: string;
}

/** A decision the live loop is blocked on until the player resolves it (0011 + the finale, 0037). */
export interface PendingDecisionView {
  kind: "ceremony-step" | "nominations" | "veto-decision" | "comp-intent" | "comp-round" | "houseguests-choice" | "replacement" | "eviction-vote" | "tie-break" | "final-eviction"
    | "goodbye-message" | "finale-statement" | "finale-answer" | "juror-question" | "juror-vote"
    // --- exit interview (0130): the player, as the evictee, answers the producers on the way out with their
    // own posture (gracious / defiant / bitter) + optional words, never engine-authored. `evictee` echoes who
    // is being interviewed (the player); `stances` carries the legal postures. Resolved via submitDecision. ---
    | "exit-interview"
    // --- early eviction (0133): the pre-jury evictee picks how to follow the rest of the season (`options`
    // are the two spectator modes: watch or skip), and is interviewed on the finale night (`stances`, like 0130). ---
    | "spectator-choice" | "finale-interview"
    // --- self-eviction (0061): the player-level/OOC confirmation to voluntarily walk out / quit ---
    | "self-evict"
    // --- secret veto (0025 reactive redesign): the player is on the block and secretly holds a
    // one-time safety — their choice to play it (pull off the block) or hold it. `options` is the two
    // nominees; the prompt frames the choice. Vault-free: the power's existence is revealed only here. ---
    | "secret-veto"
    // --- NPC-initiated deal offer (0123): a motivated houseguest floats the player a deal. `options` are
    // the two picks (accept / decline); the `offer` detail carries who/kind/terms. Vault-free — a
    // player-witnessed approach, resolved via submitDecision({ kind:"deal-offer", vote:"accept"|"decline" }). ---
    | "deal-offer";
  by: NamedRef;
  /** A human-readable instruction for the moment (what the player must choose). */
  prompt: string;
  /**
   * The legal choices (the houseguests the player may pick among). For `finale-statement`
   * this is empty (the statement is free text); for `juror-vote` it is the two finalists.
   */
  options: NamedRef[];
  /**
   * The legal finale APPEALS for a `finale-answer` (Vault-free, name-agnostic enum values);
   * absent for every other decision kind. The engine scores the chosen appeal — never the prose.
   */
  appeals?: string[];
  /** The juror asking, for a `finale-answer` (Vault-free name only); absent otherwise. */
  juror?: NamedRef;
  /** The finalist being questioned, for a `juror-question` (E37); absent otherwise. */
  finalist?: NamedRef;
  /**
   * 0129 slice 4 — the INFORMED juror-vote card (ASSUMED, pending Ryne): for a `juror-vote`, what the player was
   * TOLD by fellow jurors in the jury house, grouped by the finalist it concerned. The player's OWN knowledge only
   * (facts that reached them through `told-by:<juror>`), capped, humanized — no vote lean, no number, nothing a
   * juror holds that was not actually told. Absent unless at least one such telling exists (⇒ the card is
   * byte-identical to before).
   */
  jurorBrief?: Array<{ finalist: NamedRef; heard: string[] }>;
  /** The evictee receiving the player's goodbye, for a `goodbye-message` (E34); absent otherwise. */
  evictee?: NamedRef;
  /**
   * 0130 — the legal exit-interview STANCES for an `exit-interview` decision (Vault-free enum values:
   * "gracious" | "defiant" | "bitter"); absent for every other kind. The player's own posture leaving —
   * the engine records the chosen stance, never the prose.
   */
  stances?: string[];
  /**
   * 0123 — the NPC-initiated deal offer detail, for a `deal-offer` decision; absent otherwise. Vault-free:
   * who floated it (public name), the deal `kind`, and a Vault-safe `terms` paraphrase — no number, no
   * sealed state. The player accepts or declines the whole offer (the `options` carry accept/decline).
   */
  offer?: { from: NamedRef; kind: string; terms: string };
  /**
   * STAGED competition (0006 staged-rounds evolution) — for a `comp-round` decision: which round this is
   * (1-based) and WHO IS STILL IN this round, so the player picks their approach based on the narrowed
   * field (e.g. everyone left is an ally → throw; a threat is still in → keep competing). Absent for every
   * other kind. Vault-free: the still-in field is a public ceremony fact (the houseguests still standing).
   */
  round?: number;
  stillIn?: NamedRef[];
  /** 0128 (flag-gated): for a Final-3 HOH `comp-round`, which part (1|2|3) of the three-part Final HOH this card is. Absent otherwise. */
  finalHohPart?: 1 | 2 | 3;
  /**
   * STAGED competition (#380 audit 2026-06-20) — for a `comp-round`, whether THIS round's approach is
   * BINDING. Only the first round binds (it is the intent the single outcome roll honors); later rounds
   * are non-binding FLAVOR over an already-decided result, so the surface presents them as color, not a
   * stakes decision. Absent for every other kind.
   */
  binding?: boolean;
  /**
   * ORW-281 slice 4a: present on EVERY pending that is a step of a staged ceremony (the `ceremony-step` watch pending AND a ceremony's binding step such as the
   * nominations `choose`). Vault-free: the ceremony kind, the 1-based step, the step count and a stable engine step id.
   */
  ceremony?: CeremonyStepView;
  /** ORW-281 4a: the short Vault-free line of a `ceremony-step` watch pending (public names + the step id only - never an outcome ahead of the engine). */
  text?: string;
  /** How many to pick (nominations = 2; others = 1; finale-statement / juror-question = 0). */
  pick: number;
}

/**
 * The Vault-free projection of a finale (0037). Names + the current stage + the reveals SO FAR
 * only — NEVER a lean, a vote tally, an eviction manner, or the pre-reveal winner. A juror's vote
 * appears here only once it has been revealed in order.
 *
 * S4-2: this projection SURVIVES the flip to `finished`. While the finale is STAGING, `winner` is
 * null (the pre-reveal winner never crosses); once the season is OVER it carries the COMPLETED
 * finale (every reveal, stage `reveal`) AND the crowned `winner` — the same public winner
 * `gameStatus`/`seasonRecap` expose — so a finale-panel client agrees with every other surface
 * post-finish instead of hanging on a null.
 */
export interface FinaleView {
  /** Which stage the finale is in: statements | questions | vote | reveal. */
  stage: string;
  /** The two finalists by name. */
  finalists: NamedRef[];
  /** The juror currently asking a question, if any (name only). */
  /**
   * The juror currently asking a question, if any. When `traitorsFuryEnabled` is ON, carries an
   * optional Vault-free `bearing`: the WORD describing the juror's demeanor toward the player (from
   * bearingWord), NEVER a number. (There is deliberately no "who they believe voted against them"
   * field — PO ruling 2026-11-02: vote attribution unseals only in the 0048 retrospective, E12.)
   */
  asking: (NamedRef & { bearing?: string }) | null;
  /** The votes revealed so far, in reveal order — each a (juror → finalist) pair by name. */
  reveals: Array<{ juror: NamedRef; votedFor: NamedRef }>;
  /**
   * The crowned winner (name only) — populated ONLY once the season is over (a Vault-free public
   * fact: the same `this.live.winner` broadcast on `AdvanceView`/`seasonRecap`/`gameStatus`).
   * `null` while the finale is still staging, so no pre-reveal winner can ever cross.
   */
  winner: NamedRef | null;
}

/**
 * The Vault-free projection of an in-progress weekly eviction (0047). The two nominees by name, the
 * current stage, and the votes REVEALED SO FAR only — NEVER the unread votes, never a pre-reveal tally,
 * never the evictee before the last vote lands. A vote appears here only once read in the seeded order.
 * E12: eviction votes are SECRET BALLOTS — the reveal carries the ballot ("a vote to evict X"), never
 * the voter; attributions unseal only in the post-season retrospective (0048).
 */
export interface EvictionView {
  /** Which stage the eviction is in: votes | goodbye | result. */
  stage: string;
  /** The two nominees by name. */
  nominees: NamedRef[];
  /** The anonymized ballots revealed so far, in reveal order — the nominee each vote names, never the voter. */
  votesRevealed: Array<{ votedFor: NamedRef }>;
  /**
   * The evictee, once the result beat has landed (PO ruling 2026-11-04: the whole ballot list is read in one turn and the result follows) — absent
   * while the ballots are unread or the result has not been committed. Public after the fact; never present before the last ballot.
   */
  evictee?: NamedRef;
}

/** The Vault-free result of advancing the game or resolving a decision. */
/** ORW-275 - the week-chapter recap (public ceremony facts only). */
export interface WeekChapterView {
  week: number;
  recap: { evicted: string[]; hoh: string | null; standing: string };
}

export interface AdvanceView {
  started: boolean;
  /** A65 (ORWELL_ADVANCE_GATE, default OFF): present ONLY when the engine REFUSED an ordinary beat because the next scheduled milestone is not yet due (the gate; nothing committed, `beatSeq` unchanged). Words and minutes only. */
  held?: { next: string; minutesUntil: number; /** ORW-97: present ("schedule") only on the A65 schedule hold (an event not yet due); absent on the night/bedtime holds. */ reason?: "schedule" };
  /**
   * The monotonic per-sandbox beat counter (0065 Part A) AFTER this advance/decision committed — see
   * `GameStateView.beatSeq`. The FE captures it as the new last-seen token. On an idempotency REPLAY
   * (Part B) this is the cached view's original `beatSeq`, returned verbatim (the replay advances
   * nothing). Vault-free; restart-safe.
   */
  beatSeq: number;
  /** ORW-281 slice 4a: the staged-ceremony step this result opened (or, on a ceremony's closing Continue, the step that just closed). Absent outside a staged ceremony. */
  ceremony?: CeremonyStepView;
  /** The beat that just resolved (null if blocked on a decision or the game is over). */
  event: BeatEventView | null;
  /** Set when the loop now needs a player decision before it can continue. */
  pending: PendingDecisionView | null;
  status: PublicGameStatus;
  finished: boolean;
  winner: NamedRef | null;
  /** The in-progress finale projection (0037); present only while the finale is staging. */
  finale?: FinaleView | null;
  /** The in-progress eviction projection (0047); present only while a weekly eviction is staging. */
  eviction?: EvictionView | null;
  /**
   * 0102 (PO review 2026-06-27 redesign, #884) — present ONLY on the `turnIn` result that closes an
   * in-game day: the Vault-free "day in review" digest + its optional non-committal cliffhanger. Absent
   * on every other advance/decision result, and absent on `turnIn` itself when the clock isn't running
   * or nothing closed (a quiet/no-op turn-in) — the narrator voices it only when present, never invents one.
   */
  dailyRecap?: DailyRecapView;
  /**
   * ORW-275 - present ONLY on the played-game `turnIn` that crosses a week boundary (the bed on eviction night): the Vault-free
   * "new chapter" recap. `week` is the NEW week. No numbers except the houseguest count in `standing`.
   */
  weekChapter?: WeekChapterView;
  /**
   * T0-3 — the Vault-free broadcast chyron(s) for every committed ceremony fact THIS advance/decision
   * just produced, in commit order (a T0-2 auto-advanced beat chained onto a resolved pending can
   * commit two facts in one call — e.g. a veto decision AND its immediately-following replacement
   * nominee — so this is a list, not a single value). Absent/empty when the beat produced none (an
   * ordinary/social/premiere beat, or the loop is blocked on a pending). Riding the SAME tool-result
   * both live windows already mirror (ADR 0008/0012) is what makes F5 two-window parity inherited here
   * rather than re-derived — no new transport.
   */
  announcements?: BeatAnnouncementView[];
}

/**
 * A houseguest who, by their own soul motivation, wants to approach the player now
 * (0012/0036, reshaped by audit E60 per ADR 0003): the name plus a COARSE categorical
 * motive — `bond` (their tie to the player drives the approach) or `probe` (their threat
 * read does). The motive is the fact the narrator voices in its own words; the underlying
 * trust/affinity/threat numbers never cross the wall, and the engine ships no canned
 * pretext line ("facts to voice, never scripts to recite").
 */
export interface SocialInitiative {
  houseguest: NamedRef;
  motive: "bond" | "probe";
}

/** A snarky, state-aware one-line hero tagline for the player (0033). Vault-free; one line. */
export interface PlayerTaglineView {
  text: string;
}

/**
 * PREMIERE — "meet everyone before the first HOH" (feature #380 follow-on). The player's OBSERVABLE
 * early read of one houseguest: their PUBLIC persona facets ONLY — the archetype / strategy style /
 * background / age / presentation any houseguest can clock across the room on move-in day. This lets
 * the player "clock people a bit earlier as their personality/archetype" BEFORE the first HOH.
 *
 * VAULT WALL + ANTI-SYCOPHANCY: every field here is a PUBLIC facet the engine already mints onto the
 * roster card — NEVER the soul, hidden elements, or a trust/threat/affinity NUMBER, and NEVER an
 * engine assertion of how the player feels ("you trust them"). The player INFERS; this is observable
 * persona, not relationship math. `met` flips once the producer has introduced this houseguest.
 */
export interface FirstImpressionView {
  houseguest: NamedRef;
  /** True once this houseguest has been introduced/met during the premiere. */
  met: boolean;
  /** The OBSERVABLE public persona (the same Vault-free facets on the roster card). */
  archetype?: string;
  strategyStyle?: string;
  background?: string;
  age?: number;
  presentation?: string;
  /** The observable voice register / demeanor (L28) — how they come across in the room. */
  demeanor?: string;
  /** ORW-194 (Ryne): the PUBLIC job and hometown (already on the roster card) so the champagne toast gives real first impressions, not just a photo. */
  vocation?: string;
  hometown?: string;
  /**
   * How the houseguest PRESENTS (feature 0063; #1140) — a PUBLIC facet already on the roster card, so the
   * premiere introduction voices the SAME stored gender/pronouns the portrait encodes (never inferred from
   * the name). Gender PRESENTATION only — a private orientation stays Vault-sealed and never appears here.
   */
  genderPresentation?: "man" | "woman" | "nonbinary";
}

/**
 * The premiere's meet-everyone progress (feature #380 follow-on) — the engine-tracked, Vault-free
 * answer to "who has the player met, and who is still to introduce, before the first HOH?". The
 * narrator is HANDED this so it never has to REMEMBER who's been introduced (the real bug: the
 * model under-tracked and skipped people). `complete` is the ALL-MET tally — true once the player has
 * met all 15 NPCs (the player counts themselves); with the staged entrances ON it reads false until the last arrival. It is NOT the power gate: the first HOH is REACHABLE
 * earlier, via `powerReachable` below (0111 — a couple of hot reads + nobody left invisible), WITHOUT
 * every formal introduction first.
 *
 * Public by construction: it carries only names + the same observable persona facets the roster
 * already exposes. No Vault data, no numbers, no hidden state.
 */
export interface PremiereIntrosView {
  /** True iff every active houseguest has been introduced/met (the full meet-everyone tally). */
  complete: boolean;
  /** How many of the cast (player + NPCs) have been met so far, and the total to meet. */
  metCount: number;
  total: number;
  /**
   * The houseguests still to meet. With the staged entrances OFF (champagne circle, 0111) the whole house is met at the opening toast, so this is `[]`. With the entrances ON
   * (default) it is non-empty only while `entrance.stage === "entrances"`: one ANONYMOUS placeholder per houseguest who has not walked in yet (ordinal id `unarrived:N`,
   * name "(not yet arrived)", no persona facets) - so the count is honest while the arrival order stays hidden - and `[]` from the toast on. Not a checklist to work through
   * (the narrator prompt says "you do NOT track introductions"); nothing in the engine is gated on it.
   */
  remaining: FirstImpressionView[];
  /** Everyone met so far — the player's early observable reads, for a "first impressions" surface. */
  met: FirstImpressionView[];
  /**
   * FEATURE 0111 (Pillar 3, #906) — "no one invisible, not everyone equal." The number of HOT first
   * reads formed (met NPCs, not counting the player). House entry is asymmetric: a few reads run hot,
   * the rest are met in motion. Purely a count — no Vault data, no relationship number.
   */
  hotReads: number;
  /**
   * FEATURE 0111 (Pillar 3, #906) — the ASYMMETRIC premiere gate: the first HOH is REACHABLE once a
   * couple of hot reads are formed AND no houseguest is left invisible (everyone is at least seated in
   * the house / met in motion), WITHOUT requiring all fifteen formal introductions first (`complete`).
   * This replaces "meet ALL before any power" with "first power fast, stragglers met in motion." The
   * first HOH itself stays a real, un-rigged seeded competition — only the GATE is reframed, never the
   * outcome (anti-sycophancy, mandate #3).
   */
  powerReachable: boolean;
  /**
   * FEATURE 0111 — the champagne-circle sub-state of the premiere. `"gathered"` = the game has convened
   * the whole house in the living room for the opening toast (the player is PINNED there and
   * `whereabouts()` reports a `champagne-circle` house event) — the narrator voices THE TOAST and cannot
   * stage it elsewhere or fire it while the player is away. `"done"` = the toast has resolved (the model's
   * first advanceGame); the player is released into free-roam premiere (bedroom pick, settling in) before
   * the first HOH. Absent only on a pre-0111 save mid-premiere. Vault-free (a projection flag).
   */
  champagneCircle?: "gathered" | "done";
  /**
   * A9 (`ORWELL_PREMIERE_ENTRANCES`, default ON; `=0` opts out) - present ONLY while the staged premiere entrances/toast run
   * (and until the premiere ends). Public names only (Vault-free). `index` = houseguests entered so far (the
   * player counts once they have walked in); `total` = 16; `playerPosition` is 1-based. `arrivedNames` is the
   * whole NPC inside-list (never invent who else is present). `justArrived` is the latest NPC to enter
   * (absent when the latest entrant was the player - see `playerJustEntered`). `speakers` = the most recent
   * toast batch (host = `{name,host:true}`, the player's slot = `{id,name,isPlayer:true}`, never filled by the engine).
   */
  entrance?: {
    stage: "entrances" | "toast" | "done";
    index: number;
    total: number;
    playerPosition: number;
    /** ORW-205: how many of the `total` are inside right now (the player counts once they have walked in) - the ONE headcount the narrator may state. */
    insideCount: number;
    /** ORW-205: has the player walked in yet (so "N of you" may or may not include them). */
    playerInside: boolean;
    /** ORW-205: the engine's ready-made headcount sentence, e.g. "12 of 16 are inside (the player is one of them)". The narrator quotes it and never counts on its own. */
    headcount: string;
    arrivedNames: string[];
    justArrived?: NamedRef;
    playerJustEntered?: boolean;
    speakers?: Array<{ id?: string; name: string; host?: true; isPlayer?: true }>;
  };
}

/**
 * #1318 — the SOURCE of a premiere meet-mark. `player` (the default) is a genuine player-formed read:
 * a model-driven introduction the player was part of, or a recorded player↔NPC scene — it feeds BOTH
 * the meet-list AND the asymmetric power gate's `hotReads`. `belt` is the FE regex auto-belt catching a
 * bare first name in narration — it fills the meet-list (its anti-soft-lock job, so the intro list keeps
 * shrinking) but is NOT a hot read and MUST NOT unlock power (name-drops are not engagement). Splitting
 * the two is the fix for "the first HOH fires the moment two names are heard."
 */
export interface MarkHouseguestMetOpts {
  via?: "player" | "belt";
}

/**
 * Where the player stands in the house RIGHT NOW (0049) — the Vault-free presence read. Who is in
 * the player's room and who is one room over: facts a houseguest could see or hear themselves.
 * NEVER motives, numbers, hidden state, or the occupancy of non-adjacent rooms (you can't see
 * through walls — fog of war is gameplay).
 */
export interface WhereaboutsView {
  /** The room the player is in. */
  room: string;
  /**
   * The player's SUB-ZONE within a big, zoned room (0077 — "over by the pool" / "the workout corner").
   * Present ONLY in a zoned room (backyard, lounge); absent everywhere else. Pure flavor — eyeshot stays
   * room-wide; the zone only scopes earshot.
   */
  zone?: string;
  /** Who else is in the player's room (names only). A51: with the tells flag on, each may carry `tell` - the strongest closed-vocabulary tell kind (a word). */
  present: Array<NamedRef & { tell?: string }>;
  /**
   * Each room the player has SIGHTLINE into (eyeshot — 0077 Phase 2) and who is in it (names only). The
   * open public core sees across itself + into the hallway mouth; a CLOSED door is opaque and never
   * appears here. (Historically "adjacent rooms"; now sightline-scoped, which is strictly narrower.)
   */
  nearby: Array<{ room: string; present: NamedRef[] }>;
  /**
   * DURATION — how many consecutive player-turns the player has been in this room (0 = just
   * arrived this turn). Grounds scene continuity so the narrator voices persistence ("you've held
   * the kitchen a while") instead of resetting the scene each turn (L21/L24). `companions` carries
   * the same tenure for each houseguest currently with the player, so the model knows who has been
   * lingering with them vs. who just walked in.
   */
  turnsHere: number;
  companions: Array<{ id: EntityId; name: string; turnsHere: number }>;
  /**
   * TRACKED OCCUPANCY (0077 Phase 2 — the privacy payoff): who the player BELIEVES is behind a closed
   * door, learned by WATCHING them head in (never the live map). Each carries the believed room (+ zone),
   * how long ago the sighting was (`sinceTurns`), a Vault-safe `stale` flag (derived from AGE, never the
   * secret live position), and its 0002 pathway + confidence. The bedrooms stay blanks in `nearby`; this
   * is the only way a closed room's occupants ever surface — and only because the player earned it.
   */
  tracked: Array<{
    id: EntityId; name: string; room: string; zone?: string;
    sinceTurns: number; stale: boolean; pathway: string; confidence: number;
  }>;
  /**
   * CONSPICUOUSNESS reads (0077 — "two alone too long is a tell"), DERIVED per call: a private room the
   * player tracked exactly two high-tenure houseguests into surfaces as a Vault-free line naming WHO,
   * WHERE, and HOW LONG — never what was said. Present only when at least one such read fires. Paranoia
   * is the human's to form (0017); the engine reports the meeting, never the motive.
   */
  conspicuous?: string[];
  /**
   * ORW-249 - who walked into / out of the player's room SINCE THE PLAYER LAST SENT (the engine re-seats the house after the send; the narrator was handed the send-time roster). Names only, Vault-free;
   * present only when someone changed - so the story can voice a short arrival/departure beat and story and widget move together. Absent when nothing changed or the player changed rooms.
   */
  sinceSend?: { arrived: string[]; departed: string[] };
  /**
   * 0106 — a LIVE whole-house EVENT is in session: an EXCLUSIVE set-piece (a competition, or a
   * nomination / veto / eviction ceremony). When present, the whole house is gathered for it — so
   * `present` lists everyone and `nearby` is empty (there are no side rooms to slip into, and the player
   * cannot wander off until it resolves). Nobody is away in a private scene. For a COMPETITION,
   * `competing` are the players and `spectating` are everyone else WATCHING and forming opinions as it
   * goes — ALWAYS including the outgoing HOH, who sits out the next HOH; `youAreCompeting` is the
   * player's own status (those three are absent for a ceremony, where the whole house simply attends).
   * A purely OBSERVATIONAL projection (it never mutates the seeded sim) ⇒ calibration-identical.
   */
  houseEvent?: {
    kind:
      | "hoh-competition"
      | "veto-competition"
      | "nominations"
      | "veto-draw" // ORW-281: the veto player draw (a mini ceremony; also the Houseguest Choice card)
      | "veto-ceremony"
      | "eviction"
      // FEATURE 0111 — the premiere's GATHERED champagne circle. The whole house is convened in the
      // living room for the opening toast, so (exactly like a comp/ceremony) `present` lists everyone,
      // `nearby` is empty, and the player cannot wander off until the toast resolves. Carries no
      // competing/spectating split (nobody competes — the house simply gathers to toast). Vault-free.
      | "champagne-circle"
      // A9 - the staged premiere ENTRANCES: only the houseguests already inside are present; the rest are not yet here.
      | "premiere-entrances";
    competing?: NamedRef[];
    spectating?: NamedRef[];
    youAreCompeting?: boolean;
    /**
     * L-F4 (#1743) — the PINNED presentation of the drawn competition (name + format + premise), so a
     * comp's format/premise stays CONSISTENT across every one of its beats (the first reveal AND every
     * staged elimination round). Present only for a competition house-event once its def is drawn (the
     * HOH comp before it stages carries none — its format isn't decided yet). The `format`/`premise` are
     * FIXED for the whole event (the library floor, or the pinned #1400 authored premise), so the
     * narrator can never re-author "what kind of comp this is" turn to turn. Vault-free public flavor —
     * never a stat, score, or hidden number. Absent for ceremonies / the champagne circle.
     */
    comp?: { name: string; format: string; premise: string };
  };
}

/**
 * ADR 0009 — the outcome of recording a narrated houseguest relocation (`recordHouseguestMove`):
 *   • `moved`   — the houseguest is now in the room;
 *   • `noop`    — already there (consistent; nothing changed);
 *   • `illegal` — an unknown/evicted houseguest, the PLAYER (use `movePlayer`), or an unresolvable /
 *                 non-walkable room. This is the "impossible claim" set the surface must catch BEFORE
 *                 emission (never a later-turn correction — the transcript must never show a conflict).
 * Carries the resulting whereabouts so the caller can re-ground the narrator from engine truth.
 */
export interface HouseguestMoveResult {
  status: "moved" | "noop" | "illegal";
  whereabouts: WhereaboutsView | null;
  /** A29 - on "moved" only: the closed-set beatSeq AFTER the commit this move made, so the front-end adopts it and its next compare-and-swap call is not a self-inflicted stale-beat 409. */
  beatSeq?: number;
}

/**
 * The per-NPC voicing projection (B65 / ADR 0003 §8 — "people must make sense", structurally).
 * Everything the narrator may draw on to voice ONE houseguest: their stable public persona, where
 * they are and who is with them, what THEY legitimately know (witnessed / told / overheard), their
 * hunches, and their organic stances (labels through their own disposition — NEVER numbers).
 *
 * The sanctioned, PER-NPC-BOUNDED voicing seam: the model is handed a knowledge-bounded houseguest
 * and structurally cannot voice what that houseguest never learned. What it contains of the hidden
 * layer is exactly what THIS houseguest knows — which they may, in character, choose to reveal
 * (that is the game); other houseguests' private knowledge, the Vault, souls, and every number
 * stay out by construction.
 */
export interface NpcVoiceView {
  /** A49 (#2017 E1a, flag ORWELL_NPC_TELLS, default OFF): the houseguest's observable carriage right now - at most 2 closed-vocabulary tells (kind, band, channel), words only, never a number or a cause. Present only for a houseguest who is PRESENT in the player's room and awake. Absent flag-off => byte-identical. */
  tells?: ReadonlyArray<{ kind: string; band: string; channel: string }>;
  /** A54 (#2017 M5, ORWELL_NPC_MEMORY_SPEECH, default OFF): up to 3 plain facts this houseguest holds about the PLAYER (words + a recency word; never a kind slug, severity or number). Absent flag-off or when they hold none. */
  rememberedAboutYou?: string[];
  /**
   * ORW-317 (ORW-253 slice 4): what this houseguest holds about OTHER houseguests in the room with them, first person, public names filled
   * in, with a recency word. ONLY memories of things the whole house saw (nominations, the veto used or withheld, being named the replacement),
   * so voicing one can never surface hidden off-screen content; private memories (deals, exposed secrets) reach speech only through the
   * engine's disclosure rules (theme 2). Up to 3. Absent when the memory-speech flag is off or they hold none about anyone present.
   */
  rememberedAboutOthers?: string[];
  /** A54: the engine decided this houseguest may raise the past unprompted THIS beat (seeded, salience-barred, at most once per in-game day). The model only words it. */
  bringUp?: true;
  houseguest: NamedRef;
  /**
   * Their public seat (NARR-7 / #542): `active` (still playing, voiced from inside the house),
   * `jury` (evicted into the last-9 jury — still voiced at the finale, from the jury box), or
   * `evicted` (out pre-jury). A non-active seat keeps its byte-stable public persona so the
   * narrator can voice a juror consistently with who they actually are — only the live-game
   * fields (whereabouts) go null. Vault-free: it says nothing about anyone's hidden state.
   */
  seat: "active" | "jury" | "evicted";
  /** The stable public persona facets (B61) — byte-stable across the whole season. */
  persona: {
    archetype?: string; strategyStyle?: string; background?: string;
    age?: number; presentation?: string;
    /**
     * Prose appearance (the older 0004 facet). PRE-0058 FALLBACK ONLY — a houseguest is voiced through
     * EITHER the structured `physicalCharacteristics` OR this prose, never both (independently generated,
     * they could contradict, L29). A 0058 houseguest is voiced via `physicalCharacteristics`.
     */
    appearance?: string;
    /** The observable voice register (L28) — voice this houseguest in THEIR demeanor, not a default. */
    demeanor?: string;
    /**
     * The PUBLIC deep-profile facets (0058) — voice the houseguest's STORED biography + physical
     * characteristics, never invent (and drift) them. Both are Vault-free public facets; the HIDDEN
     * profile (secrets/goals/weakness/perception) is NEVER on this projection.
     */
    biography?: string; physicalCharacteristics?: PhysicalCharacteristics;
    /**
     * The PUBLIC identity facets (0063) — heritage, gender presentation, and a PUBLICLY-OUT orientation
     * only. A PRIVATELY-held orientation is NEVER here (Vault-sealed; surfaces only via a 0002 pathway).
     * One true facet of a full character, never a reductive label.
     */
    ethnicity?: string; genderPresentation?: "man" | "woman" | "nonbinary"; outOrientation?: string;
    /**
     * Feature 0084 — the VOICE fingerprint: HOW this houseguest talks (register/rhythm/energy/
     * directness/humor/stress-tell + a prose signature + a light lexicon). PUBLIC, byte-stable, voiced
     * EVERY turn so the cast sounds like sixteen people, not one narrator. Absent on a pre-0084 save.
     */
    voice?: VoiceProfile;
  };
  /**
   * Feature 0084 — the houseguest's CURRENT mood as a Vault-safe AFFECT WORD, derived live from their
   * soul on two timescales (the acute spike + the marinated season-long baseline). Observable carriage
   * only — NEVER a number, NEVER the hidden cause (only a houseguest on a pathway to the precipitating
   * event knows WHY). Voiced so a rattled houseguest sounds rattled. Absent before presence/soul is live.
   */
  mood?: string;
  /** Where they are + who is in the room with them (0049). Null when presence is unseeded. */
  whereabouts: { room: string; present: NamedRef[] } | null;
  /** What THIS houseguest legitimately knows — content only, most recent first-capped. */
  knows: string[];
  /** Their hunches (no pathway): they may voice suspicion, never certainty (0002). */
  suspects: string[];
  /** Organic stances toward the other ACTIVE houseguests — labels, never numbers (ADR 0002). */
  stances: Array<{ toward: NamedRef; stance: string }>;
  /**
   * Feature 0075 — the read-only, Vault-SAFE hint that this houseguest is READY to confide in the
   * player (the "no cold open" emergent path). Present ONLY when the disclosure motive clears the
   * floor AND a fresh precipitating event makes the moment plausible — so the model leans into a
   * confidence the scene has EARNED, never a non-sequitur. It carries only a `reason` word and a
   * `warmth` word — NEVER the secret, NEVER a number. The model then drives it through the `confide`
   * lever so the disclosure stays engine-decided and recorded (never narrated free-hand). Absent ⇒
   * no readiness this scene (the common case).
   */
  mayConfide?: { ready: true; reason: string; warmth: "high" | "growing" };
  /**
   * Feature 0088 — a living, per-NPC CURRENT read of the player, derived from the evolving
   * NPC→player edge (distinct from the frozen `dayOnePerception`). Surfaced BEHAVIOR-ONLY:
   * a Vault-safe `toward` carriage word + a `drift` word. Never a number, never the edge
   * value, never a hidden cause. Present for ACTIVE houseguests only; absent on pre-0088 saves.
   * Sibling of `mood` (0084) — mood is how they feel; this is how they feel ABOUT YOU.
   */
  currentRead?: { toward: string; drift: "warming" | "cooling" | "steady" };
  /**
   * Feature 0096 — the Vault-SAFE `rivalry` tone hint: present ONLY for the houseguest currently held
   * as the player's emergent NEMESIS (a sustained, not spiked, threat-toward-player elevation of the
   * existing 0085 campaign + 0086 drive layer), and ONLY inside a live scene with them (no cold-open
   * arc announcement — the 0075 sibling guarantee). A coarse HEAT WORD only — NEVER a number, NEVER a
   * stated motivation ("they are your nemesis" is forbidden hand-holding), NEVER the threat edge. The
   * model may lean into needling/adversarial positioning; it never authors the rivalry's existence.
   * Absent for everyone else, and absent whenever the campaign layer hasn't elevated anyone this season.
   */
  rivalry?: { tone: "simmering" | "open" };
}

/**
 * The knowledge-wall manifest for the narration guard (ship-blocker A0): one private disclosure the
 * player holds, together with the ONLY houseguests who legitimately hold it too. Vault-free — it is
 * the PLAYER's OWN knowledge (never a Vault read), handed outward so the front-end can prove, before a
 * line reaches the player, that no houseguest voices content no in-game pathway ever gave them.
 *
 * `knownTo` is the complete pathway-holder set. For a Diary-Room entry it is EMPTY by construction —
 * the Diary Room is an OOC channel with no pathway to ANY houseguest, so NO npc may ever voice it.
 * A guard treats any houseguest speaker NOT in `knownTo` voicing this content as a leak.
 */
export interface SealedFact {
  /** The private content the player disclosed / recorded (humanized — no raw ids/slugs). */
  content: string;
  /**
   * The houseguests (if any) who legitimately hold this via a real in-game pathway. Empty ⇒ Diary
   * Room / sealed from the whole house. For `sealedFromHouse()` these are ids (always empty in
   * practice — the DR class). For the ADR 0019 `knowledgeScopeManifest()` these are houseguest DISPLAY
   * NAMES (the front-end staging guard matches a staged speaker by name), so a staged speaker whose
   * name is NOT here is voicing content no pathway gave them and the sentence is dropped.
   */
  knownTo: EntityId[];
}

/**
 * ADR 0019 Layer 2 — one PRESENT houseguest's own knowledge scope, baked into the built context so
 * the narrator voices them from THEIR bounded set by default. The SAME Vault-free `knows`/`suspects`
 * content `npcVoice` returns (humanized, capped, most-recent-first) — never a number, never the hidden
 * layer, never another houseguest's knowledge. "Context is not knowledge": a fact appears here only
 * under the block of a houseguest who legitimately holds it.
 */
export interface PresentKnowledgeView {
  id: EntityId;
  name: string;
  /** What THIS houseguest legitimately KNOWS (witnessed or was told) — content only. */
  knows: string[];
  /** What THIS houseguest merely SUSPECTS (a hunch with no pathway backing it) — content only. */
  suspects: string[];
  /**
   * Audit band D F2 — the SAME Vault-safe carriage cues `npcVoice` returns, pushed so the narrator
   * voices them without calling the under-called tool: 0084 `mood` (an affect word), 0088
   * `currentRead` (carriage word + drift word toward the player), 0096 `rivalry` (a heat word, held
   * nemesis only). Words only — never a number, never the hidden cause. Each absent when `npcVoice`
   * omits it ⇒ the rendered block is byte-identical to the pre-F2 shape.
   */
  mood?: string;
  currentRead?: { toward: string; drift: "warming" | "cooling" | "steady" };
  rivalry?: { tone: "simmering" | "open" };
}

/**
 * The season's PUBLIC arc, assembled from the event record (0048 — principle #7: stores, not
 * narrator memory). Vault-free at any time: it is exactly what the player lived through.
 */
export interface SeasonRecapView {
  started: boolean;
  finished: boolean;
  winner: NamedRef | null;
  weeksPlayed: number;
  /** Chronological public highlights straight from the recorded ceremony/deal events. */
  highlights: string[];
  /** The eviction order so far (names, in order). */
  evicted: NamedRef[];
  /** Deals the player was party to, with their final status. */
  deals: DealView[];
  /** 0107 — the named alliances the player is a member of (Vault-safe: name + members, never a number). */
  alliances?: AllianceView[];
}

/**
 * 0102 (PO review 2026-06-27 redesign, #884) — the non-committal cliffhanger a `DailyRecapView` may
 * carry. `thread` is an ENGINE-INTERNAL id (never shown; it exists only for a future payoff to link
 * back to), `framing` is the Vault-free, non-committal tease text for the narrator to voice AS A
 * POSSIBILITY — it names nothing the player hasn't already witnessed or been told, and it never
 * asserts a future result (ADR 0005: the seed still decides).
 */
export interface DailyRecapHook {
  thread: string;
  framing: string;
}

/**
 * 0102 (PO review 2026-06-27 redesign, #884) — the DAILY "day in review" digest, fired at the
 * player's own in-game bedtime (`turnIn`, ADR 0006), REPLACING the originally-drafted weekly recap.
 * Stitched from exactly two Vault-free sources (same discipline as `SeasonRecapView`, scoped to the
 * day that just closed): the player's witnessed ceremony/scene/deal events, plus gossip that has
 * ALREADY surfaced to the player through a real pathway (0002). A rumor still diffusing in the hidden
 * layer never appears. `hook` is present only when an in-motion, player-perceivable thread is
 * eligible (a quiet day closes with none — never a manufactured cliffhanger).
 */
export interface DaySummary {
  day: number;
  tier: "day" | "week";
  events: string[];
  themes: string[];
  /** Model-authored summary (FE write-back), capped; absent = floor entry only. */
  text?: string;
  /** Week tier: the inclusive day range this entry condenses. */
  coversDays?: [number, number];
  /** Day tier: true once a week entry has condensed it (kept in the ledger, never deleted). */
  merged?: boolean;
}

/** ORW-271 — FE-driven write-back: the model-authored summary for a closed day (or a week of days). */
export interface RecordDaySummaryReq {
  day: number;
  text: string;
  tier?: "day" | "week";
  coversDays?: [number, number];
}

export interface RecordDaySummaryResult {
  accepted: boolean;
  /** Why not accepted (absent when accepted). */
  reason?: "absent" | "unknown-day" | "empty";
}

export interface DailyRecapView {
  /** The 1-based in-game day this recap closes (ADR 0006's clock; not a calendar day). */
  day: number;
  /** The player's witnessed ceremony/scene/deal highlights for the day, straight from the record. */
  highlights: string[];
  /** Gossip that reached the player's own knowledge today via a real in-game pathway (0002). */
  surfaced: string[];
  /** The non-committal forward tease, when an eligible in-motion thread exists; absent on a quiet day. */
  hook?: DailyRecapHook;
}

/**
 * The unsealed hidden story (0048) — the Wall's ONE sanctioned, structurally-gated exception.
 * Returned ONLY for a finished season (the gate lives in code, on the terminal state): the
 * off-screen scheming, the confessionals, and the producer's sealed twists. While a season is
 * live this is unreachable — there is a game to spoil; afterwards it is the payoff.
 */
/**
 * ORW-313 - the DEBUG producer-vault dump: the retrospective render PLUS every NPC's agenda (goals, reasons, history), name-resolved. The agendas ride ONLY this dump (the owner-ruled DEBUG door 1 of mandate #2):
 * never the post-season retrospective view, never an advertised tool, never the player channel.
 */
export interface AgendaDumpGoal {
  horizon: "season" | "week";
  kind: string;
  /** Who the goal is about (a NAME), when it has a target. */
  target?: string;
  /** Why the goal exists: each cause as a readable line (kind, who it is about, how much it counted). */
  why: string[];
  /** The closed test the engine evaluates, as a readable sentence. */
  test: string;
  /** How committed the holder is, 0..100. */
  commitment: number;
  status: string;
  formed: string;
  resolved?: string;
  /** For a replaced / dropped goal: what replaced it or why it was let go. */
  endNote?: string;
}

export interface AgendaDumpHouseguest {
  houseguest: string;
  goals: AgendaDumpGoal[];
  history: AgendaDumpGoal[];
}

export interface ProducerVaultView extends RetrospectiveView {
  agendas: AgendaDumpHouseguest[];
}

export interface RetrospectiveView {
  winner: NamedRef | null;
  /**
   * 0115 — the player's OWN Diary-Room confessionals, in the order they recorded them: their side of
   * the story, surfaced post-season alongside the unsealed hidden truth. NOT a Vault read — it is the
   * player's own `NO_NPC_PATHWAY` knowledge (it never reached any NPC in life and does not now). Empty
   * when the player kept no confessional.
   */
  playerConfessionals: string[];
  /**
   * #1396 — the weekly Diary-Room PULL-QUOTE REEL: a curated montage of the season's most notable
   * confessional lines, collected BY WEEK — the player's OWN Diary-Room lines (`player-diary`) AND the
   * NPCs' confessionals (`npc-confessional`), each tagged with its source so the two channels stay
   * explicit. The NPC lines are Vault content and reach this reel ONLY here, at the sanctioned unseal —
   * exactly like `hiddenStory` / `evictionVotes` (mandate #2). Built ON `playerConfessionals` (0115),
   * not replacing it: a pure, rng-free, calibration-neutral selection over already-recorded lines, so
   * an empty reel leaves the rest of the retrospective byte-identical. Empty when no notable line exists.
   */
  pullQuoteReel: PullQuoteWeek[];
  /**
   * The hidden story in CHRONOLOGICAL order (#852): pre-season setup first, then the live hidden
   * layer ordered by its time marker. Each row carries an optional `ts` (a monotonic marker — absent
   * on pre-game setup rows, which sort first); names humanized, no raw ids/slugs.
   */
  hiddenStory: Array<{ type: string; content: string; ts?: number }>;
  /** The producer's sealed reserve twists: each kind + the week it fired (null = never fired). */
  twists: Array<{ kind: string; firedWeek: number | null }>;
  /**
   * The UNSEALED weekly eviction ballots (E12): who really voted to evict whom, week by week.
   * Secret all season (the live reveal is anonymized); tellable only here, post-season.
   */
  evictionVotes?: Array<{
    week: number;
    evictee: NamedRef;
    votes: Array<{ voter: NamedRef; votedFor: NamedRef }>;
  }>;
  /**
   * The finale jury vote, per juror (SG7/#1030): which finalist each jury member voted for at the
   * crowning. Mirrors `evictionVotes` (per-voter attribution) but for the final vote — present only
   * once the finale's votes are tallied (post-season). Like `evictionVotes`, this unseals ONLY here,
   * behind the same terminal gate; it is never revealed per-juror in-season (the live reveal stays
   * one-at-a-time choreography). `finalists` echoes who was on the block at the end for context.
   */
  juryVotes?: {
    finalists: NamedRef[];
    votes: Array<{ juror: NamedRef; votedFor: NamedRef }>;
  };
  /**
   * 0130 — each evictee's EXIT INTERVIEW, week by week: their public posture leaving (`stance`) and,
   * for the player, their own words (`message`). The season told through its exits, in the evictees'
   * own voices. Not a Vault read — an exit interview is a witnessed, public broadcast beat (the evictee
   * spoke it on the way out); it surfaces here as the retrospective's first-person exit reel. Empty when
   * no eviction was interviewed (e.g. a Final-3 atomic eviction outside the staged 0047 path).
   */
  exitInterviews?: Array<{ week: number; evictee: NamedRef; stance: string; message?: string }>;
  /** 0133 — the early-evicted player's own finale-night interview (posture + words), when they gave one. */
  finaleInterview?: { stance: string; message?: string };
}

/**
 * The Vault-free result of an ADMIN fast-forward to the finale (L38). The dev-only "finish my
 * season so the post-season retrospective unseals" lever DRIVES the deterministic engine — it
 * reads NO Vault and reveals nothing hidden: it carries only PUBLIC ceremony facts (the crowned
 * winner's NAME, weeks played, the player's final placement). The retrospective (0048) still
 * unseals through its OWN code-gated post-finale path — this only makes the season FINISH.
 */
export interface FinaleFastForwardView {
  /** True once the season is over — a winner is crowned (or it was already finished). */
  finished: boolean;
  /** The crowned winner's NAME (Vault-free public fact), or null if the season did not finish. */
  winnerName: string | null;
  /** Weeks played to the crown (the public week count). */
  weeks: number;
  /** Where the PLAYER finished — `winner`, `runner-up`, `jury`, or `evicted` (public seat facts). */
  playerPlacement: "winner" | "runner-up" | "jury" | "evicted" | "unknown";
  /** No game was started, so there was nothing to fast-forward (Vault-free; never raises). */
  started: boolean;
}

/**
 * B2 (2026-07-05 activation lane) — the God-Mode runtime dial for the "living house" behavioral-
 * fidelity layers that ship OPT-IN behind their own `ORWELL_*` env flag (0085 campaigns, 0087
 * trajectories, 0091 triggers, 0092 secret pacing, 0100 jury house, 0059 §5 seeded-tie surfacing).
 * Every field is OPTIONAL — an admin `setBehavioralFlags` call only touches the flags it names,
 * exactly like `setTimeOfDay` (ADR 0006). `undefined` ⇒ unchanged (leaves the env-derived default
 * or a prior override in place). Vault-free by construction: these are engine-tallied, calibration-
 * proven-neutral-when-off switches, never a Vault handle or a hidden value.
 */
export interface BehavioralFlags {
  /** 0085 — NPC campaigns & the scramble (hidden, adaptive agendas that tilt noms/votes). */
  campaigns?: boolean;
  /** 0087 — relationship trajectories (warming/cooling arcs bending off-screen scene selection). */
  trajectories?: boolean;
  /** 0091 — trigger secrets erupting into public house events under accumulated strain. */
  triggers?: boolean;
  /** 0092 — the secret-pacing drip (a paced ~1-2/week cadence for dormant secrets to surface). */
  secretPacing?: boolean;
  /** 0100 — the jury grudge book (the sequestered jury house as a hidden second society). */
  juryHouse?: boolean;
  /** 0059 §5 — organic surfacing of seeded pre-game ties as the pair's live bond genuinely warms. */
  seededTieSurfacing?: boolean;
  /** 0101 — NPC myth-making (the house turns a rare, notable player act into a spreading legend). */
  mythMaking?: boolean;
  /** 0101/#1401 — the AI showrunner (Vault-held producer notes that pace which simmering threads the
   *  off-screen tick emphasizes; open-set only — never an outcome). */
  showrunner?: boolean;
}

/** A player's answer to the current `PendingDecisionView`. */
export interface SubmitDecisionReq {
  // "ceremony-step" (ORW-281 4a) is a WATCH step answered by advanceGame; it is in this union only so a pending's kind is assignable - submitDecision REFUSES it (typed).
  kind: "ceremony-step" | "nominations" | "veto-decision" | "comp-intent" | "comp-round" | "houseguests-choice" | "replacement" | "eviction-vote" | "tie-break" | "final-eviction"
    | "goodbye-message" | "finale-statement" | "finale-answer" | "juror-question" | "juror-vote"
    // --- exit interview (0130): the player-evictee's own posture leaving (gracious / defiant / bitter)
    // rides the shared `vote` field like a goodbye tone, with optional words on `statement`. Recorded for
    // the 0048 retrospective, never engine-authored. ---
    | "exit-interview"
    // --- early eviction (0133): the spectator mode (watch or skip) rides the shared `vote` field; the
    // finale-night interview posture rides `vote` and the optional words ride `statement` (like 0130). ---
    | "spectator-choice" | "finale-interview"
    // --- self-eviction (0061): the explicit, confirmed voluntary walk-out / quit ---
    | "self-evict"
    // --- secret veto (0025 reactive redesign): the player plays or holds their one-time safety.
    // Accepts the shared boolean `use` (play it off the block when true; hold it when false/absent). ---
    | "secret-veto"
    // --- NPC deal offer (0123): the player accepts or declines a houseguest's floated deal. The choice
    // ("accept" | "decline") rides the shared `vote` field (a string, like a tone/appeal value). ---
    | "deal-offer";
  /**
   * self-evict (0061): the EXPLICIT confirmation. ONLY `confirmed:true` executes the irreversible
   * walk-out (record the event + fold its impact + flip status through the 0046 door). Anything else
   * (false/absent/cancel) leaves the player ACTIVE and in the house — the anti-accident gate.
   */
  confirmed?: boolean;
  /** nominations: exactly two houseguest ids. For houseguests-choice / tie-break / final-eviction
   *  a single pick may ride here as a 1-element array (the FE tool schema's convention) — the
   *  engine accepts it interchangeably with `vote` (audit A10). */
  choice?: EntityId[];
  /** veto-decision: whether to use the veto. secret-veto (0025): whether to play the one-time safety. */
  use?: boolean;
  /** veto-decision: the nominee saved when `use` is true. */
  save?: EntityId;
  /** replacement: the replacement nominee the HOH names. */
  replacement?: EntityId;
  /** eviction-vote / juror-vote: the finalist/nominee the player votes for.
   *  goodbye-message: the chosen tone ("warm" | "respectful" | "cold") rides here (E34). */
  vote?: EntityId;
  /** finale-statement / juror-question: the player's free text (flavor; carries no score).
   *  goodbye-message: the optional message text accompanying the chosen tone. */
  statement?: string;
  /** finale-answer: the structured appeal the player makes (engine-scored; never the prose). */
  appeal?: string;
  /** comp-intent / comp-round: the player's declared approach — "compete" | "throw" | "play-safe" (B46;
   *  0006 staged-rounds: `comp-round` carries the approach for THAT elimination round). */
  intent?: string;
  /**
   * Optional compare-and-swap token (0065 Part A): the `beatSeq` the caller computed this decision
   * against. When present and `!== current`, the decision is REFUSED with a typed `stale-beat`
   * conflict (HTTP 409, no state change) — the board moved under the queued turn (0064 §3.C). Absent
   * ⇒ byte-identical to the pre-0065 path (opt-in).
   */
  expectedBeatSeq?: number;
  /**
   * Optional at-most-once idempotency key (0065 Part B): a stable key the FE mints per INTENDED
   * decision and reuses on retry. A repeated key returns the ORIGINAL `AdvanceView` (its `beatSeq`
   * included) WITHOUT resolving the decision again — so a flaky-socket retry never double-applies.
   * Absent ⇒ unchanged behavior; the cache is bounded + best-effort (a restart that drops it degrades
   * safely, since the `expectedBeatSeq` guard still protects against a double-apply).
   */
  idempotencyKey?: string;
}

/** Optional progression controls (0065) carried alongside an `advanceGame` call. */
/**
 * "Hang out until X" (PO 2026-11-04) - the player's safe fast-forward. Request: optional CAS token + beat cap (<= 8).
 */
export interface HangOutReq {
  expectedBeatSeq?: number;
  /** Cap on beats this call (1..8; default 8). */
  maxBeats?: number;
}
/** Why a hang-out stopped (the engine decides; the narrator voices it). */
export type HangOutStopReason = "event-due" | "pulled" | "npc-approach" | "observed" | "bedtime" | "max-beats";
export interface HangOutView {
  /** false = nothing happened (no state change): see `reason`. */
  ok: boolean;
  reason?: "disabled" | "clock-off" | "no-game" | "pending-decision";
  stopReason?: HangOutStopReason;
  beats: number;
  /** In-game minutes spent. */
  minutes: number;
  /** ORW-22: the player-facing line for the stop (public facts only), present for every stop kind. */
  stopLine?: string;
  /** Vault-free public detail of the stop (names, never ids/numbers). */
  detail?: { by?: string; npc?: string; desire?: string; kind?: string; who?: string[] };
  timeOfDay?: string;
  beatSeq: number;
}

export interface AdvanceGameReq {
  /**
   * Optional compare-and-swap token (0065 Part A): the `beatSeq` the caller computed this advance
   * against. When present and `!== current`, the advance is REFUSED with a typed `stale-beat`
   * conflict (HTTP 409, no state change). Absent ⇒ byte-identical to the pre-0065 path (opt-in).
   */
  expectedBeatSeq?: number;
  /**
   * Optional at-most-once idempotency key (0065 Part B): see `SubmitDecisionReq.idempotencyKey`. A
   * repeated key returns the original `AdvanceView` without advancing again. Absent ⇒ unchanged.
   */
  idempotencyKey?: string;
}

/**
 * The write-back seam (feature 0058 / ledger L28b) — the FE producer-LLM authors a houseguest's rich
 * §3 profile (endless variety) and writes it BACK here so the ENGINE becomes the source of truth
 * (mirrors the 0051 portrait-prompt handshake). The engine validates / repairs (diversity + non-
 * player-mirroring), SPLITS it across the Vault Wall (public facets onto the byte-stable Character;
 * secrets/goals/weakness/perception sealed into the Vault), INDEXES it for full-fidelity recall
 * (L27b), and re-derives the story threads from it.
 *
 * NOW LIVE (Phase 2, commit 852f2db): the write-back validates / splits / seals / re-derives / re-indexes
 * for real, REPLACING the seeded floor for that houseguest (idempotent). The deterministic seeded floor
 * remains the offline fallback / pre-write source. Anti-sycophancy: the engine KEEPS its calibrated
 * seeded NPC→player leans (the LLM authors the Day-1 read TEXT only, never the hidden weights — so the
 * net-zero perception balance the juryReach calibration gate depends on is preserved). Everything PUBLIC
 * here may cross to the player; everything HIDDEN is sealed and never projected.
 */
export interface RecordCastProfileReq {
  /** Which houseguest this authored profile is for. */
  houseguestId: EntityId;
  // --- PUBLIC (crosses to the player; folded onto the byte-stable Character) ---
  /** An LLM-generated, real-sounding replacement display name (public). Absent ⇒ the engine's seeded corpus name stands (the deterministic floor). Rejected if not a reasonable two-token human name. */
  name?: string;
  /**
   * The houseguest's PUBLIC occupation — a short noun phrase, e.g. "court reporter" — the `vocation`
   * facet the player reads the job from. Author this WHENEVER the authored `biography` describes a
   * different occupation than the seeded skeleton's: the engine keeps `vocation` and the biography in
   * LOCKSTEP (both public) and RE-GROUNDS the seeded hidden secret stakes off the new occupation (#849),
   * so the hidden life can never cohere with a job the player would never infer. Absent ⇒ the seeded
   * `vocation` stands unchanged (and the hidden stakes keyed off it are left untouched). A blank /
   * non-string value is ignored (the seeded floor stands).
   */
  vocation?: string;
  /** A real multi-sentence backstory (the presentable parts). */
  biography?: string;
  /** The structured physical-characteristics facet (text↔image single source of truth). */
  physicalCharacteristics?: PhysicalCharacteristics;
  /**
   * The authored VOICE fingerprint (feature 0084 — idiolect/voice notes; the expressive-e2e authoring
   * widening, owner directive 2026-07-11). PUBLIC and Vault-free (how a person talks is observable) and
   * byte-stable once folded — voice is IDENTITY (owner ruling 2026-06-25), so like the other public
   * facets it is authored as part of the ONE season-start floor→authored upgrade, never drifted later.
   * Folded ONLY when the WHOLE profile is well-formed (all seven dials + signature non-empty short
   * strings, lexicon a small string list) — voice is replaced whole or not at all; anything partial /
   * malformed is dropped and the engine's seeded voice (the deterministic floor) simply stands. NEVER a
   * stat or hidden weight: this shapes how the houseguest TALKS, not any outcome math.
   */
  voice?: VoiceProfile;
  // --- HIDDEN (Vault-sealed; NEVER projected to player or admin) ---
  /** 2–3 secrets. */
  secrets?: string[];
  /** The true strategic goals. */
  trueGoals?: string[];
  /** The named weakness / blind spot. */
  weakness?: string;
  /** The Day-1 perception-of-the-player read (seeds the NPC→player edge). */
  dayOnePerception?: string;
}

/** Whether the write-back was accepted (and which fields, Vault-free — never echoes a secret). */
export interface RecordCastProfileResult {
  /** True iff the houseguest exists and a profile could be recorded. */
  accepted: boolean;
  /** The PUBLIC field NAMES that were accepted (never their hidden values). */
  publicFields: string[];
  /** The HIDDEN field NAMES that were accepted (names only — the values are sealed, never echoed). */
  hiddenFields: string[];
  /** Set when not accepted (unknown houseguest / no game / phase-2-deferred path). */
  reason?: string;
}

/**
 * The AI-driven cast-identity write-back (issue #544 — the deferred AI half of the 0063 diversity floor /
 * the 2026-06-23 ruling). The FE producer-LLM PROPOSES each houseguest's DESCRIPTIVE identity facets
 * targeting U.S.-population minority rates — heritage/ethnicity, gender presentation, orientation,
 * disclosure, age — and writes them BACK here. The ENGINE then VALIDATES + REPAIRS the whole-cast proposal
 * against the proportional targets already in `diversityConstants.ts`: recognized facets seed the deal, and
 * the engine's floors/caps (BIPOC ≥, gender balance, age spread, LGBTQ+ ≥, per-heritage cap) GUARANTEE a
 * realistic cast regardless of what the model returns (even a lazy/biased/monochrome proposal can't skew
 * it). `skinTone` is re-grounded from the FINAL heritage (the PR #527 hinge), so text + portrait agree.
 *
 * The HARD BOUNDARY: this writes ONLY descriptive identity facets — NEVER a hidden game weight. Each NPC's
 * seeded Day-1 read of the player and competition leans stay ENGINE-OWNED (anti-sycophancy #3 + the
 * juryReach calibration depend on the net-zero-balanced seed). AI drives WHO the houseguests are; the engine
 * drives the MATH of how they play. Calibration-neutral by construction (descriptive facets ride isolated
 * sub-streams, never a competition/vote input — the #338 golden test stays the proof).
 *
 * Pre-game write-back: lands on the PRE-WARMED cast (0065) before the player finishes the interview, or on
 * the live house if a season is already running. Best-effort/idempotent/fail-soft: with NO model, the engine
 * never receives a proposal and the deterministic weighted floor (PR #527) simply stands. Vault-free out.
 */
export interface RecordCastIdentityReq {
  /**
   * The LLM-proposed descriptive identity facets per houseguest id. Any subset of houseguests and any subset
   * of fields per houseguest — an omitted houseguest / field keeps the engine's seeded value. Unrecognized
   * facet values (an unknown heritage / orientation / sub-floor age) are ignored in favor of the seeded deal.
   */
  facets: Record<EntityId, ProposedCastIdentityFacets>;
}

/** One houseguest's PROPOSED descriptive identity facets (all optional; descriptive-only, never a weight). */
export interface ProposedCastIdentityFacets {
  /** Heritage / cultural-identity label (matched against the engine's pool; unknown ⇒ seeded deal). */
  ethnicity?: string;
  /** How the houseguest presents — "man" | "woman" | "nonbinary" (validated against the known set). */
  genderPresentation?: "man" | "woman" | "nonbinary";
  /** Sexual orientation — "straight" | "gay" | "lesbian" | "bisexual" | "queer" | "pansexual" (validated). */
  orientation?: string;
  /** Whether a queer orientation is PUBLICLY OUT (true) or held PRIVATELY (false) — absent ⇒ engine roll. */
  out?: boolean;
  /** Age — accepted only at/above the engine's eligibility floor (descriptive; never a competition input). */
  age?: number;
}

/** Whether the cast-identity write-back was accepted, Vault-free — counts only (no private value echoed). */
export interface RecordCastIdentityResult {
  /** True iff a cast existed (pre-warmed or live) to fold the validated/repaired identity layer onto. */
  accepted: boolean;
  /** How many houseguests had a proposed facet RECOGNIZED + applied (after validate/repair). */
  applied: number;
  /** Set when not accepted (no cast warmed / no game started). Vault-free reason. */
  reason?: string;
}

/**
 * Feature 0116 — the model-authored cast-genesis write-back (phase 2 of the casting upgrade). The FE
 * producer-LLM proposes the ENTIRE 15-NPC SKELETON — names, freeform identities (the archetype tag is
 * DERIVED, not a generative constraint), personas, hidden elements, banded stats, and the pre-show tie
 * graph — steered by a SEEDED season brief and carrying ZERO knowledge of the player. The ENGINE runs the
 * proposal through its validation ENVELOPE (`castGenesis.validateCastGenesis`): banded stat clamp (no
 * model number escapes), the cast-wide variance floor, name validators (uniqueness / plausibility /
 * legacy-Bible deny-list / player-collision), the closed hidden-element kinds + C9 gates, tie-graph
 * sanity, and hidden-game-weight stripping — then folds the committed skeleton onto the PRE-WARMED cast
 * (`preSeedCast` must have run first). Generalizes ADR 0005 to world-gen: identity is open-set (recorded
 * faithfully), power is closed-set (engine-dictated). A PRE-GAME operation only — refused once a season
 * runs. Descriptive 0063 identity facets (ethnicity/gender/orientation/age) continue to route through the
 * UNCHANGED `recordCastIdentity` pipeline, not this call. Vault-free out (violations name NPC/field/rule,
 * never a hidden value). Not a model lever (FE-driven, like preSeedCast/recordCastProfile).
 */
export interface GenesisStatDTO { physical?: number; mental?: number; social?: number }
export interface GenesisHiddenElementDTO { kind?: string; detail?: string }
/** One proposed pre-show tie — two NPC ids (never the player), a nature + freeform backstory (flavor). */
export interface GenesisTieDTO { a?: EntityId; b?: EntityId; nature?: string; backstory?: string }
/** One proposed NPC skeleton slot. `id` binds it to the warmed cast; every other field is optional (an omitted/failing field keeps the deterministic floor). */
export interface GenesisNpcDTO {
  id?: EntityId;
  name?: string;
  /** The freeform identity concept, in the model's own words — stored verbatim; the narrator voices this, never the bare tag. */
  identity?: string;
  /** The nearest canonical archetype tag (a derived coupling key); validated ∈ enum, else the floor tag stands. */
  archetype?: string;
  vocation?: string;
  hometown?: string;
  demeanor?: string;
  background?: string;
  biography?: string;
  presentation?: string;
  appearance?: string;
  /** Per-NPC banded stat proposal — the engine clamps the total into its band; no raw number is committed. */
  stats?: GenesisStatDTO;
  /** Per-NPC hidden elements (kind ∈ the closed set; details are open-set prose). Vault-routed; never projected. */
  hiddenElements?: GenesisHiddenElementDTO[];
}
export interface RecordCastGenesisReq {
  /** The whole-cast skeleton proposal (expected 15 NPCs). */
  npcs: GenesisNpcDTO[];
  /** The proposed pre-show tie graph (0–2 pairs; excess dropped, sanity-validated, sealed). */
  ties?: GenesisTieDTO[];
}
/** One structured, Vault-free validation violation (never echoes a hidden value). */
export interface GenesisViolationDTO {
  /** Per-NPC (re-roll that one NPC) vs cast-wide (re-roll the cast slice). */
  scope: "npc" | "cast";
  npcId?: EntityId;
  field: string;
  rule: string;
  action: "clamped" | "repaired" | "stripped" | "re-roll" | "ignored" | "dropped";
}
export interface RecordCastGenesisResult {
  /** True iff a PRE-WARMED cast existed to fold the validated skeleton onto (false ⇒ refused; see `reason`). */
  accepted: boolean;
  /** How many warmed NPC slots the proposal actually touched (folded ≥1 field onto). */
  committed: number;
  /** The structured violations (which NPC, which field, which rule, which action) — Vault-free, for the bounded FE re-roll. */
  violations: GenesisViolationDTO[];
  /** Whether the committed cast cleared the cast-wide stat variance floor (false ⇒ stats fell back to the floor + a cast re-roll is named). */
  varianceOk: boolean;
  /** Set when not accepted (no warmed cast / a season already running). Vault-free reason. */
  reason?: string;
}

/** The Vault-free skeleton of one recorded off-screen scene — public participant ids, room, and nature only (0070). */
export interface OffscreenSceneSkeleton {
  /** The event id — used by the FE to address the texture write-back. */
  eventId: string;
  /** The interaction type (alliance/gossip/conflict/bonding/strategy/showmance/betrayal). */
  nature: string;
  /** Public participant entity ids (both participants — no Vault content). */
  participants: string[];
  /**
   * The current prose content of the scene — either the voiced texture if the FE has written one back,
   * or the base deterministic template (participants+nature ONLY, no hidden-element/player-subject/scheme-target
   * enrichment). Never contains hidden attributes or relationship numbers.
   */
  templateContent: string;
}

/** The write-back request to enrich an already-recorded hidden off-screen scene (0070). */
export interface RecordOffscreenSceneTextureReq {
  /** The id of an already-recorded, already-hidden off-screen event to enrich. */
  eventId: string;
  /**
   * The model-voiced prose to set as the event's content. Must be non-empty.
   * CONTENT ONLY — the tool cannot change the witness set, hidden flag, type, or any
   * relationship number. Those stay engine-owned and closed-set.
   */
  content: string;
}

/** The result of a texture write-back (0070). */
export interface RecordOffscreenSceneTextureResult {
  /** True iff the event exists, is hidden, and the content was updated. */
  ok: boolean;
}

/**
 * 0065 — pre-warm the cast. Generate the player-INDEPENDENT cast (composition + diversity + deep
 * layer) off the season seed BEFORE the player finishes the casting interview, into an engine-side
 * pre-game holding store, so the FE can author it deeply (`recordCastProfile`) and the portrait
 * prompts read the FINISHED store. The whole cast is deterministic off the seed (no player field is
 * read), so this is safe to run the instant a model is selectable.
 */
export interface PreSeedCastReq {
  /**
   * Optional explicit seed (tests/replays). Default: mint + persist real entropy now — and the
   * later `createCharacter` ADOPTS this same seed, so the warmed cast is the cast that ships.
   */
  seed?: number;
}

/** The Vault-free pre-warmed cast (0065) — the same public roster facets `createCharacter` ships, plus the portrait prompts. */
export interface PreSeedCastView {
  /** True once the cast is warmed (the roster + prompts are available to author + shoot against). */
  warmed: boolean;
  /** The season seed the warmed cast was generated off (the one `createCharacter` will adopt). */
  seed: number;
  /** The Vault-free public roster — the same observable facets as `GameStateView.house` (no player). */
  house: HouseguestCard[];
  /** Portrait prompts (0051) built from the warmed PUBLIC facets — NPCs only (the player has their own headshot). */
  portraitPrompts: PortraitPromptEntry[];
  /** True when this call returned an ALREADY-warmed cast (idempotent re-call) rather than warming afresh. */
  alreadyWarmed?: boolean;
  /** Set when the cast could NOT be warmed (a season is already running) — Vault-free reason. */
  refused?: "in-progress" | "over";
}

/**
 * 0065 (advance-warm) — pre-warm the NEXT season's cast DURING the current season's finale, into a
 * per-user HOLDING STORE that survives the sandbox rotation. Unlike `preSeedCast` (which warms onto
 * the live adapter's pre-game store and is REFUSED while a season runs), this generates a fresh cast
 * off a NEW seed into a registry-level buffer the cutover ADOPTS — the active season is untouched.
 *
 * Optionally authors ONE houseguest of the held cast (the FE deep-author write-back, mirroring
 * `recordCastProfile`): when `profile` is present this call seals that profile onto the held cast
 * (PUBLIC/HIDDEN split) instead of (re)generating. A `houseguestId`-only authoring call against a
 * not-yet-warmed buffer first warms it.
 */
export interface PreSeedNextSeasonReq {
  /** Optional explicit seed (tests/replays). Default: mint + persist a NEW season seed for the held cast. */
  seed?: number;
  /**
   * Optional deep-author write-back for ONE houseguest of the held cast — same split/seal as
   * `recordCastProfile`, but it lands on the NEXT-season holding store, never the active season.
   */
  profile?: RecordCastProfileReq;
}

/** The Vault-free held next-season cast (0065 advance-warm) — same roster shape as `PreSeedCastView`. */
export interface PreSeedNextSeasonView {
  /** True once the next-season cast is warmed into the holding store. */
  warmed: boolean;
  /** The NEW season seed the held cast was generated off (the one the cutover will adopt). */
  seed: number;
  /** The Vault-free public roster — the same observable facets as `GameStateView.house` (no player). */
  house: HouseguestCard[];
  /** Portrait prompts (0051) built from the held PUBLIC facets — NPCs only. */
  portraitPrompts: PortraitPromptEntry[];
  /** True when this call returned an ALREADY-held cast (idempotent re-call) rather than warming afresh. */
  alreadyWarmed?: boolean;
  /** When `profile` was supplied: the authoring outcome (field NAMES only, never a hidden value). */
  authored?: RecordCastProfileResult;
  /** Set when the next-season cast could NOT be warmed (no active season to advance-warm from). */
  refused?: "no-active-season";
}

export interface GameSession {
  /** Run OOBE and start a new game; returns the Vault-free state. */
  createCharacter(req: CreateCharacterReq): GameStateView;
  /**
   * 0065 — pre-warm the player-INDEPENDENT cast off the season seed BEFORE the interview ends, so the
   * FE can author it deeply and portraits read the finished store. Idempotent; durable (a warmed cast
   * survives a restart). `createCharacter` ADOPTS the warmed cast (same seed) at finalize. Vault-free.
   */
  preSeedCast(req: PreSeedCastReq): PreSeedCastView;
  /**
   * 0065 (advance-warm) — pre-warm the NEXT season's cast DURING the current season's finale, into a
   * per-user holding store that survives the cutover rotation (`preSeedCast` is refused mid-season;
   * this is its mid-season counterpart). Generates a fresh cast off a NEW seed without touching the
   * active season; the confirmed next-season cutover ADOPTS it. Optionally authors one houseguest of
   * the held cast (the FE deep-author write-back). Vault-free out. Composed by the registry.
   */
  preSeedNextSeason(req: PreSeedNextSeasonReq): PreSeedNextSeasonView;
  /**
   * Record casting-interview answers as they land (0050) — any subset of fields, callable any
   * number of times pre-game. Returns where the interview stands (known / missing / next / ready);
   * the engine, not the model, decides the next step. No-op (current status) once a game started.
   */
  updateCasting(req: UpdateCastingReq): CastingStatusView;
  /** Vault-free public status (week/phase/HOH/nominees/veto) for the status panel. */
  gameStatus(): PublicGameStatus;
  /** The current Vault-free game state (phase, the player's card, the house roster). */
  getGameState(): GameStateView;
  /**
   * The `beatSeq`-keyed delta state feed (0065 Part E): given the caller's last-seen `beatSeq`, return
   * exactly WHAT CHANGED since (player-visible events appended, ceremony field diffs, finished/winner
   * flip). Vault-free by construction (reuses the player's witness-filtered visible projection) and
   * O(Δ) (materializes only the events after the token — the R3 latency cure). An unknown/too-old token
   * signals `fullRefresh` instead of guessing a partial delta; `sinceBeatSeq === current` ⇒ an empty
   * delta. A pure READ (never mutates / commits); safe to poll.
   */
  stateDelta(sinceBeatSeq: number): StateDeltaView;
  /** The managed system prompt to inject for the current (or requested) moment. */
  getMomentPrompt(req: MomentPromptReq): MomentPromptView;
  /**
   * Feature #1394 — recall the Vault-free witnessed moments involving the scene's houseguest(s),
   * ranked by relevance to the cue, for the narrator's framing. A pure READ (never mutates). Vault-free
   * by construction: it reads only the player's visible projection (the registry wires the source).
   * Returns `{ moments: [] }` when nothing relevant exists — never an error (enrichment absence is fine).
   */
  recallSceneMemories(req: RecallSceneMemoriesReq): RecallSceneMemoriesView;
  /**
   * Resolve a competition over the live house using the engine's OWN stats +
   * seeded temperature. Returns only the winner (name) — no stats/scores cross
   * the wall. The LLM may request this to drive the game; the ENGINE decides.
   */
  runCompetition(req: RunCompetitionReq): CompetitionResultView;
  /**
   * Advance the live weekly loop by ONE beat (0011): HOH comp → nominations →
   * veto comp → veto ceremony → eviction → finale. NPC beats resolve automatically
   * (relationship-driven); when the next beat is the PLAYER's own decision the loop
   * stops and returns it as `pending`. Idempotent while a decision is pending.
   *
   * 0065: an OPTIONAL `req` may carry `expectedBeatSeq` (compare-and-swap stale-write guard, Part A)
   * and/or `idempotencyKey` (at-most-once retry guard, Part B). Calling `advanceGame()` with no req is
   * byte-identical to the pre-0065 path.
   */
  advanceGame(req?: AdvanceGameReq): AdvanceView;
  /**
   * Clock-per-message (2026-11-05): the front-end announces ONE player message ({messageId}, its stable id); the announcement steps the in-game clock one message-step (~5 minutes), idempotent per id
   * (`accepted: false` for a repeat). From the first announcement on, commits bill the clock nothing - the clock is paid per PLAYER MESSAGE, not per engine mutation. FE clock infra, not a model lever.
   */
  noteMessage(req: { messageId: string }): { accepted: boolean; beatSeq: number };
  /** Resolve the current pending decision and continue the loop (validated; 0011). `req` may carry the
   *  optional 0065 `expectedBeatSeq` / `idempotencyKey` (absent ⇒ byte-identical to today). */
  submitDecision(req: SubmitDecisionReq): AdvanceView;
  /**
   * Self-eviction step 1 (0061 §4.2) — the player expresses an OOC intent to leave: surface the
   * `self-evict` CONFIRMATION pending and change NO state (the house never hears it; the L36/L39a
   * gate holds). It does NOT evict — only an explicit `submitDecision({ kind: "self-evict",
   * confirmed: true })` does (step 2). Idempotent; a no-op before a game starts or once the player
   * is already out. Returns the Vault-free view carrying the confirmation pending.
   */
  requestSelfEviction(): AdvanceView;
  /**
   * E-1 (2026-11-04) — a player in WATCH mode (pre-jury evictee, 0133) asks to switch to SKIP: re-raise the SAME `spectator-choice` card so they confirm on the card
   * (the card-only binding is untouched; the model cannot commit it). Idempotent while the card is open. Skip is irreversible: in skip mode, or with nothing to raise
   * (an active player, a finished season), this is a typed `EngineRefusal`. FE-driven (the visible "Skip ahead" control, or a skip-intent belt).
   */
  raiseSpectatorChoice(expectedBeatSeq?: number): AdvanceView;
  /**
   * Self-eviction cancel (0061 §4.2) — the player declines the confirmation: clear the `self-evict`
   * pending and leave them ACTIVE and in the house, state unchanged. A no-op when nothing is pending.
   */
  cancelSelfEviction(): AdvanceView;
  /**
   * The player's bedtime lever (ADR 0006 §Principle 6) — the player CHOOSES to turn in for the night.
   * Ends THEIR night where it stands (an early night ⇒ rested for tomorrow's comp; outlasting the house
   * into late-night ⇒ running on empty) and rolls the house to the next morning. The player is never
   * auto-slept; only this call retires them. A no-op when the clock isn't running, the game is over, or
   * the player has left. Returns the Vault-free view (the new morning + the player's own rest cue).
   *
   * 0065 — a mutating progression tool, so it takes the SAME optional sync-spine fields as `advanceGame`
   * (`AdvanceGameReq`): `expectedBeatSeq` (Part A CAS — a stale token ⇒ typed `stale-beat`/409, refused
   * before any mutation) and `idempotencyKey` (Part B at-most-once — a retried/duplicate turnIn REPLAYS
   * the original view instead of re-ending the night, which would re-stamp the rest penalty). Absent ⇒
   * byte-identical to the pre-0065 path (opt-in).
   */
  turnIn(req?: AdvanceGameReq): AdvanceView;
  /**
   * "Hang out until X" - a bounded run (<= 8) of short (15-30 in-game minute) engine-timed beats that stops at the FIRST of:
   * the scheduled event coming due (the clock is clamped to it - never fires or skips an event), the player being pulled
   * (diary room / production), an NPC approaching, something noteworthy observed, or bedtime. Seeded side stream, recorded,
   * the engine decides the stop reason. Flag-gated (`ORWELL_HANGOUT`); off or clock-off => `{ ok:false }`, zero state change.
   */
  hangOut(req?: HangOutReq): HangOutView;
  /**
   * The player makes a deal with a houseguest (0039) — a first-class tracked promise. Recorded as
   * a player-witnessed event (their knowledge); the engine reconciles it against later binding
   * actions and makes a broken promise hurt. Returns the new deal's Vault-free projection, or a `DealRefusal` when the NPC declines (the engine decides, not the narrator).
   */
  makeDeal(req: MakeDealReq): DealView | DealRefusal | null;
  /** 0107 — the player names an alliance (bond-gated membership); null if nobody close enough joins. */
  formAlliance(req: FormAllianceReq): AllianceView | null;
  /** 0107 Phase B — the player accepts an NPC's pitch and joins their alliance; null if not a live pitch. */
  joinAlliance(req: JoinAllianceReq): AllianceView | null;

  /**
   * Feature 0075 — press an ally to open up (a trust-gated confidence). The SINGLE authority, like
   * `runCompetition`: the model voices/previews, the ENGINE decides + commits. Evaluates the
   * Vault-hidden `disclosureMotive` (mutual bond + banked goodwill) — and, for a manipulative
   * houseguest reading the player as useful-but-threatening, a STRATEGIC motive that may produce a
   * LIE — picks the tier, selects/redacts the real secret (or fabricates a false one), RECORDS the
   * resulting belief as the player's knowledge via an in-game `told-by` pathway (0002), folds the
   * vulnerability bond bump (0023), and returns `{ disclosed, tier, content, truthful }`. The Wall
   * holds structurally: the engine never hands the model an UNdisclosed secret, a sub-`full` tier
   * never returns the whole premise, and a lie is engine-authored from the PUBLIC archetype (never a
   * real secret of anyone). Monotonic: a true secret is never re-confided at a LOWER tier than
   * already reached. `null` pre-game / for an unknown or non-active houseguest.
   * 0065 Part A: optional `expectedBeatSeq` compare-and-swap (stale ⇒ 409, no disclosure).
   * 0065 Part B / A10 / #591 / R1c: optional at-most-once `idempotencyKey` — `confide` folds the
   * vulnerability bond bump (or a betrayal-grade lie-catch) and mutates the lie/disclosure ledger, so a
   * stale-409 re-drive under two-window concurrency could double-apply. A REPEAT key returns the prior
   * `ConfideResult` WITHOUT re-folding — checked BEFORE the CAS guard. Absent ⇒ byte-identical (opt-in).
   */
  confide(npcId: EntityId, expectedBeatSeq?: number, idempotencyKey?: string): ConfideResult | null;
  /** 0129 slice 3 — the juror-player asks a fellow juror what they know; null unless the player holds a juror's seat and `jurorId` is another juror. */
  askJuror(jurorId: EntityId, expectedBeatSeq?: number, idempotencyKey?: string): AskJurorResult | null;

  /**
   * Feature 0095 — press a suspicion that two houseguests knew each other before the show. The SINGLE
   * authority, like `confide`: the model previews/voices the accusation, the ENGINE checks the SEALED
   * 0059 pre-game-tie layer and decides whether it LANDS (a real tie exists ⇒ it jumps to `public`, a
   * betrayal-grade fallout folds on the accuser's read of both members, recorded as the player's own
   * knowledge through an in-game pathway) or MISSES (no such tie ⇒ no Vault read, no fold — an ordinary
   * wrong guess). Rare and capped per season (`TIE_REVEAL.maxExposuresPerSeason`, shared with the
   * off-screen overhear pathway). Returns a Vault-safe `{ landed }` — no number, no tell on a miss.
   * 0065 Part A: optional `expectedBeatSeq` compare-and-swap (stale ⇒ 409, no accusation resolved).
   * `null` pre-game.
   */
  accuseTie(aId: EntityId, bId: EntityId, expectedBeatSeq?: number): AccuseTieResult | null;

  /**
   * Feature 0094 — CONFRONT a houseguest over a belief the player holds about them (a scheme, a
   * betrayal-in-progress, anything the player learned via a pathway) — the single closed-set authority
   * a confrontation resolves through, like `confide`/`accuseTie`: the model previews/voices the
   * confrontation, the ENGINE checks whether the CITED belief (`factId`, validated against what the
   * player legitimately holds — the Vault bright line, a non-learned fact is refused) is a materially
   * DISTORTED / low-confidence rumor (`isMateriallyDistorted`, reading only the belief's own already-
   * existing `distortion`/`confidence` fields — no new belief model) or a faithful one. A faithful
   * belief LANDS (no divergence — the move plays out as the player expects). A materially distorted
   * belief MISFIRES: the outcome resolves against REALITY, not the belief — the wrongly-confronted
   * houseguest's own read of the player takes the SAME betrayal-grade blow a real betrayal folds (0026),
   * seeded and deterministic. The engine NEVER states that a misfire happened BECAUSE the belief was
   * wrong — only the divergent outcome ever crosses; the truth surfaces later, if it does, through the
   * EXISTING gossip/pathway machinery (the same `factId` lineage already carries `originalContent`).
   * Returns a Vault-safe `{ landed }` — no number, no confidence/distortion value, no "this is false"
   * marker. `null` pre-game / for an unknown or non-active houseguest / an unrecognized `factId`.
   */
  confront(npcId: EntityId, factId: string, expectedBeatSeq?: number): ConfrontResult | null;
  /**
   * 0142 (ORW-88 idea 2) - call in a favor a houseguest owes the player (they kept a deal). `ask` is the deal kind requested (default "vote": "you owe me a vote"). Returns null when no favor is
   * owed by that houseguest (or the request is invalid). Played games only; the engine prices honoring it from trust, threat, memory and what it costs them.
   */
  callInFavor(npcId: EntityId, ask?: DealReqKind, expectedBeatSeq?: number): CallInFavorResult | null;

  /**
   * 0093 — OUT a learned secret to the house. The single engine authority (like `runCompetition` /
   * `confide`): the model previews/voices, the ENGINE validates the player legitimately holds the
   * `factId` (a non-learned secret is REJECTED — no Vault-minting), resolves the bounded, seeded
   * standing hit on the subject + the betrayal-grade backlash on the exposer (0026) + an optional jury
   * mark (0014), records the exposure as a witnessed pathway event so the house now KNOWS it (0002,
   * `surfaceInformationTo`), marks the secret SPENT (`usedAs: exposed` — never re-leveraged), and
   * increments the per-season expose cap. A `bluff` is a SEPARATE sanctioned path: the player publicly
   * CLAIMS a secret they did not learn — it reads NOTHING from the Vault, folds on belief, and the
   * engine never tells the player whether it matched a real truth. Returns `{ exposed, … }` — NO number.
   * `null` pre-game / for an unknown subject.
   */
  exposeSecret(req: ExposeSecretReq): ExposeResult | null;

  /**
   * 0099 — TRADE a held secret to a THIRD-PARTY recipient for a one-off concession. The single engine
   * authority: the engine values the secret TO THE RECIPIENT (what they'd do with it — bounded, seeded),
   * resolves whether they take it, folds the relationship change (a valued trade warms the recipient; a
   * refused one sours their read of the peddler), records the trade as a witnessed `told` pathway event
   * (the recipient now HOLDS the secret, 0002), marks it `usedAs: traded`, and increments the per-season
   * trade cap. Validates `knownTo(player)` (a non-learned/suspicion-only fact is REJECTED) unless `bluff`.
   * Returns `{ accepted, … }` — NO number. `null` pre-game / for an unknown recipient.
   */
  tradeSecret(req: TradeSecretReq): TradeResult | null;

  /**
   * Which houseguests want to approach the player right now (0012/0036) — relationship-driven
   * (allies scheme, rivals probe), so scenes start from EITHER side, not only player→NPC. Returns
   * names + a coarse motive (bond | probe); the hidden numbers never cross the wall. Empty before
   * a game starts.
   */
  socialInitiatives(): SocialInitiative[];
  /**
   * A snarky, state-aware Big Brother one-liner for the homepage hero (0033) — reflects the
   * player's CURRENT public standing (HOH / on the block / holding the veto / just a houseguest /
   * pre-game). Vault-free, anti-sycophantic (a weak spot is ribbed, not flattered), one line.
   */
  playerTagline(): PlayerTaglineView;

  /**
   * PREMIERE — the meet-everyone progress (feature #380 follow-on). The engine-tracked, Vault-free
   * answer to "who has the player met, who is still to introduce before the first HOH?" — so the
   * narrator never has to REMEMBER who's been introduced (the real skipped-introductions bug). Carries
   * each houseguest's OBSERVABLE public persona for the player's early reads. `null` outside the
   * premiere moment (once the first HOH begins there is nothing left to meet).
   */
  premiereIntros(): PremiereIntrosView | null;

  /**
   * @deprecated BL-005 — VESTIGIAL under the champagne circle (0111). The whole house is met at the
   * opening toast (`meetWholeHouseAtChampagneCircle`), so this is now a DORMANT, idempotent BACKSTOP:
   * every active NPC is already met, so a call never changes the tally. Kept wired (the FE name-belt /
   * the model may still call it) but it no longer drives a progressive roll-call — do not build a
   * meet-everyone checklist on it. A no-op for an unknown houseguest, the player (auto-met), or once
   * the premiere is over. Returns the resulting meet-everyone progress (or `null` outside the premiere).
   *
   * #1318 — `opts.via` distinguishes a genuine player-formed read (`player`, the default) from the FE
   * regex auto-belt (`belt`). Backward-compatible: an omitted `opts` is `player`.
   */
  markHouseguestMet(id: EntityId, opts?: MarkHouseguestMetOpts): PremiereIntrosView | null;

  /**
   * The Vault-free projection of a finale (0037 §8.1) for a polling finale panel — the SAME projection
   * already proven on `AdvanceView.finale`: names + the current stage + the reveals SO FAR only. No
   * lean, tally, manner, or pre-reveal winner. S4-2: it SURVIVES the flip to `finished` — post-season it
   * returns the COMPLETED finale plus the crowned `winner` (the same public winner `gameStatus`/
   * `seasonRecap` carry), so a finale panel agrees with every surface instead of hanging on null.
   * `null` only when no finale exists at all (never staged / no game). Infra (like `gameStatus`/
   * `playerTagline`), not a game-driving lever.
   */
  finaleView(): FinaleView | null;

  /**
   * The Vault-free presence read (0049): the player's room, who is in it, and who is in each
   * ADJACENT room. Grounds lingering play — "who's here? who's nearby?" has an engine answer the
   * narrator queries instead of inventing. `null` before a game starts (or once the player is out).
   */
  whereabouts(): WhereaboutsView | null;

  /**
   * The player walks to a room (L21/L24) — the player is a person, so THEY direct their movement;
   * the engine never auto-relocates them, only holds them where they chose (NPCs drive around them).
   * Sets the player's room + resets their tenure and returns the resulting whereabouts. No-op for an
   * unknown room / before a game starts (returns the current whereabouts unchanged). Vault-free.
   *
   * 0065: an OPTIONAL `expectedBeatSeq` compare-and-swap token (Part A) refuses a stale write
   * (`stale-beat` / 409, no move) when the board moved under it; absent ⇒ byte-identical to today.
   */
  movePlayer(room: string, expectedBeatSeq?: number): WhereaboutsView | null;

  /**
   * ADR 0009 — RECORD a narrated houseguest relocation (the model narrates the open texture of who
   * wanders where; the engine records it, so the board agrees with the prose and there is never a
   * visible historic conflict). Mutates ONLY the open, player-facing occupancy — never the
   * calibration-neutral baseline — so every seeded outcome is byte-identical. Legal-moves-only; the
   * result distinguishes a recorded move from an impossible claim the surface must catch pre-emission.
   * Vault-free.
   */
  recordHouseguestMove(id: EntityId, room: string): HouseguestMoveResult;

  /** The season's public arc from the event record (0048) — Vault-free, reproducible, any time. */
  seasonRecap(): SeasonRecapView;

  /**
   * 0102 (PO review 2026-06-27 redesign, #884) — the most recently CLOSED day's "day in review"
   * digest (materialized once, at the `turnIn` that closed it — see `AdvanceView.dailyRecap`), so a
   * caller can re-fetch the same day's recap without re-triggering it. `null` before any day has
   * closed (pre-game, the clock isn't running, or the player hasn't turned in yet). Vault-free,
   * reproducible: re-reading returns the exact same materialized view every time.
   */
  dailyRecap(): DailyRecapView | null;

  /**
   * ORW-271 — the append-only per-night day ledger (Vault-free; `[]` before any night closed). FE read.
   */
  dayLedger(): DaySummary[];

  /**
   * ORW-271 — FE-driven write-back (like `recordWorldSnapshot`; NOT a model lever): attach the
   * model-authored summary `text` to a closed day (idempotent per day+tier), or add a week-tier entry
   * covering `coversDays` and mark those day entries `merged` (kept, never deleted).
   */
  recordDaySummary(req: RecordDaySummaryReq): RecordDaySummaryResult;

  /**
   * The Vault unsealing (0048 §1): the hidden story of THIS user's FINISHED season. Returns `null`
   * for a live (or not-started) season — the gate is the terminal state, enforced in code, never
   * by prompt. The one sanctioned Vault-reading seam, post-season only, player-triggered.
   */
  seasonRetrospective(): RetrospectiveView | null;

  /**
   * DEBUG producer's vault (owner-ruled override of mandate #2): the LIVE hidden layer, unsealed for
   * operator debugging WITHOUT the post-season gate. The ONE sanctioned LIVE Vault-reading seam —
   * admin/God-Mode channel ONLY, exposed through the quarantined `DEBUG_VAULT_TOOLS` registry (the
   * only `readsVault: true` tools) and fired only behind an explicit FE "unseal" action. Returns the
   * same scrubbed, name-resolved `RetrospectiveView` as the retrospective; `null` when no game exists.
   */
  producerVaultDump(): ProducerVaultView | null;

  /**
   * The knowledge-bounded voicing projection for ONE active houseguest (B65 / ADR 0003 §8) —
   * everything the narrator may draw on to voice them, nothing they never learned. Null for an
   * unknown or non-active houseguest (the departed are voiced from the public record only).
   */
  npcVoice(id: EntityId): NpcVoiceView | null;

  /**
   * The knowledge-wall manifest (ship-blocker A0) — the player's private disclosures that are sealed
   * from some or all of the house, each with the houseguests who DO legitimately hold it. Vault-free
   * (the player's OWN knowledge). The narration guard reads this to prove no houseguest voices content
   * no in-game pathway gave them — most sharply the player's Diary-Room entries (`knownTo` empty: no
   * pathway to ANY npc, ever). Empty array when no game is started or nothing is sealed.
   */
  sealedFromHouse(): SealedFact[];

  /**
   * ADR 0019 Layer 3 — the GENERALIZED knowledge-scope manifest (the post-hoc guard's backstop). Every
   * distinctive fact currently held by a BOUNDED subset of the house (someone in the house does NOT
   * hold it), grouped by lineage, each with its complete pathway-holder set as houseguest DISPLAY NAMES
   * (`knownTo`). The narration guard drops a sentence in which a STAGED houseguest voices a fact whose
   * `knownTo` excludes them — generalizing `sealedFromHouse`'s always-sealed Diary-Room drop to the
   * full asymmetric case (the player told B in one room; A must not "recall" it in another).
   *
   * Vault-free by construction: it reads ONLY the KnowledgeService (the legitimate "witnessed-or-told"
   * layer that `npcVoice.knows` already projects outward per-NPC), never the Vault/soul. Diary-Room
   * facts are left to `sealedFromHouse` (their `knownTo` is empty by definition). Public facts the
   * whole house holds are omitted (there is no non-holder who could leak them). `[]` pre-game.
   */
  knowledgeScopeManifest(): SealedFact[];

  /**
   * Return the portrait prompt for a specific houseguest by id (0051) — Vault-free; uses public
   * appearance + authored storyline facets. Serves the live house, or PRE-GAME the warmed pre-seed
   * cast (0065/ADR 0013 — the per-NPC authored shoot fetches the store as it stands at shoot time).
   * Null when neither holds the id.
   */
  getPortraitPrompt(id: EntityId): { houseguestId: string; name: string; prompt: string } | null;

  /**
   * The Vault-free projection of the move-in zeitgeist snapshot (feature 0062) — the FROZEN, shared
   * real-world flavor the whole cast moved in WITH (public slices + the off-screen-channel "world you
   * moved in with" block an NPC-to-NPC society/gossip scene is colored by). A THIRD state category:
   * PUBLIC shared flavor — never Vault, never game truth (§6). `null` pre-game or when no snapshot was
   * captured (the §8 fail-soft skip). Provenance fields (`capturedAt`/`lagDays`) never cross — only the
   * voiceable slices + the rendered block do.
   */
  worldSnapshotView(): WorldSnapshotView | null;

  /**
   * The FE-owned write-back seam (feature 0062, §8) — the front-end (which owns the concrete `web_search`
   * provider, like the 0051 image port) captures a REAL move-in zeitgeist at season creation and writes
   * it back here so the ENGINE persists it as the single FROZEN artifact and RECALLS it (never
   * re-searches) all season (§9). Replaces the deterministic `model-framed` fallback for this season
   * (idempotent); freezes it byte-stable thereafter. Outward-safe by construction — the payload is PUBLIC
   * flavor (no Vault handle, no secret, no game input). A no-op before a game starts; empty slices keep
   * the fallback's value (a partial capture never thins the snapshot — non-degradation).
   */
  recordWorldSnapshot(req: RecordWorldSnapshotReq): RecordWorldSnapshotResult;
  /** ORW-319: freeze each houseguest's model-read habits + season-aim hint (validated, write-once). Not a model lever. */
  recordNpcTraits(req: RecordNpcTraitsReq): RecordNpcTraitsResult;
  /** ORW-319: freeze the season's house culture (validated, write-once). Not a model lever. */
  recordHouseCulture(req: RecordHouseCultureReq): RecordHouseCultureResult;

  /**
   * ORW-223 slice 1 (Showrunner memory part B, canon ledger v1, house map only) - the FE-driven write-back that
   * records a narrated TEXTURE feature of a room as append-only canon, so later turns stay consistent. Accepts
   * ONLY `{ roomId, feature }` (a known room, a one-line feature of at most `ROOM_CANON_FEATURE_MAX` chars);
   * anything else is rejected with a code. An invention can never create an event, outcome, secret, new place,
   * plot device, relationship change, knowledge or number (the canon ledger's own fence rejects those), and this
   * method touches no hidden state. A played game only; no rng; durable via the background seam (no beatSeq bump).
   * Not a model lever (FE-driven, like `recordWorldSnapshot`).
   */
  recordRoomCanon(req: RecordRoomCanonReq): RecordRoomCanonResult;

  /**
   * The FE-driven producer-DEEPENING write-back (increment 3 of #1626) — fold an AUTHORED overlay onto
   * the seeded off-camera casting producer so the engine stays the source of truth. DEEPENS the persona
   * (backstory / temperament / disposition / wit / quirk) while keeping the seeded NAME byte-stable (the
   * byline never churns). Validated through the `validateProducerProfile` envelope (open-set prose only,
   * length-capped, any stat/soul vocabulary stripped) and ACCUMULATED onto the seeded floor + any prior
   * overlay (non-degradation — a field the model omits keeps the seeded value). Vault-free by construction
   * (no stat/number/hidden field is typed on the request). Durable (persisted pre-game); NOT a board beat
   * (no beatSeq bump). Idempotent / fail-soft: an empty or all-rejected payload leaves the seeded producer
   * standing. Not a model lever (FE-driven, like `recordWorldSnapshot`).
   */
  recordProducerProfile(req: RecordProducerProfileReq): RecordProducerProfileResult;

  /**
   * Feature #1400 (READ) — the Vault-free "what to hand the model" projection for the currently-staging
   * competition (comp/type/field/FIXED winner/FIXED drop order/0042 scaffold), so the FE can author a
   * theme + per-round fiction MATCHED to the already-decided outcome. `null` unless generative
   * competitions are enabled AND a staged comp has resolved its roll (the model dresses a decided
   * result — there is nothing to hand it before the roll commits). Not a model lever (FE-driven infra).
   */
  competitionStagingView(): CompetitionStagingView | null;

  /**
   * Feature #1400 (WRITE-BACK) — the FE-driven write-back of the model-authored competition fiction
   * (theme + premise + per-round elimination fiction). The engine VALIDATES (hard) that every
   * elimination named maps to the fixed drop order EXACTLY; on any mismatch it is REJECTED and the
   * deterministic 0042 library floor stands. On success the fiction is stored (Vault-free, persisted)
   * and the reveal tells it round by round — PRESENTATION ONLY, so it can never perturb the winner, the
   * drop order, or any seeded roll. Refused (accepted:false) when the flag is off, no comp is staging,
   * the roll has not committed, or the drop order does not match. Not a model lever (FE-driven infra).
   */
  recordCompetitionFiction(req: RecordCompetitionFictionReq): RecordCompetitionFictionResult;

  /**
   * The deep-profile write-back seam (feature 0058 / L28b) — the FE-authored §3 profile is recorded
   * here so the ENGINE is the source of truth: PUBLIC facets fold onto the byte-stable Character;
   * HIDDEN facets are sealed into the Vault and NEVER projected. NOW LIVE (Phase 2): it validates the
   * target (non-player-mirroring), splits PUBLIC↔HIDDEN across the wall, seals + re-indexes the hidden
   * half for full-fidelity recall, and re-derives the story threads — replacing the seeded floor for
   * that houseguest (idempotent). The result never echoes a hidden value (it reports field NAMES only).
   */
  recordCastProfile(req: RecordCastProfileReq): RecordCastProfileResult;

  /**
   * The AI-driven cast-identity write-back seam (issue #544 — the deferred AI half of the 0063 diversity
   * floor). The FE producer-LLM PROPOSES the whole cast's DESCRIPTIVE identity facets (heritage / gender
   * presentation / orientation / disclosure / age) targeting U.S.-population rates; the ENGINE validates +
   * REPAIRS the proposal against the proportional targets in `diversityConstants.ts` (so a lazy/biased model
   * can never skew the cast), re-grounds `skinTone` from the FINAL heritage, folds the PUBLIC facets onto the
   * byte-stable Characters, and re-seals each PRIVATE orientation into the Vault. NEVER accepts a hidden game
   * weight — the seeded Day-1 read / competition leans stay engine-owned (anti-sycophancy #3 + juryReach).
   * Calibration-neutral (descriptive facets ride isolated sub-streams). Lands on the pre-warmed cast pre-game
   * or the live house; idempotent; with no proposal the deterministic floor stands. Vault-free out.
   */
  recordCastIdentity(req: RecordCastIdentityReq): RecordCastIdentityResult;

  /**
   * Feature 0116 — the model-authored cast-genesis write-back. Validate the whole-cast SKELETON proposal
   * against the engine's envelope (banded stats / variance floor / name validators / closed hidden-element
   * kinds / tie-graph sanity / hidden-weight stripping) and fold the committed skeleton onto the PRE-WARMED
   * cast (`preSeedCast` must have run). A PRE-GAME operation only — refused once a season runs. Returns the
   * structured, Vault-free violations for the bounded FE re-roll. Idempotent; with no proposal the
   * deterministic floor simply stands (byte-neutral). FE-driven; not a model lever.
   */
  recordCastGenesis(req: RecordCastGenesisReq): RecordCastGenesisResult;

  /**
   * 0070: the Vault-free skeletons of the off-screen scenes recorded in the most recent tick —
   * public participant ids and nature only. The FE uses these to voice texture and write it back
   * (via `recordOffscreenSceneTexture`). Never returns hidden content. Returns [] pre-game or when
   * no off-screen scenes have been recorded.
   */
  getOffscreenSceneSkeletons(): OffscreenSceneSkeleton[];

  /**
   * #1793 — the player's Diary-Room dossier: the player's OWN NO_NPC_PATHWAY diary-room reads,
   * grouped per houseguest subject. When subjectId is specified, returns only that houseguest's
   * entries. Vault-free by construction: only the player's own tagged diary-room entries, never
   * engine truth or NPC knowledge. An EMPTY record `{}` when the ORWELL_PLAYER_DOSSIER flag is OFF —
   * never `undefined`: every tool returns a JSON value, so the Vault-sentinel sweeps can scan it.
   */
  playerDossier(subjectId?: EntityId): Record<EntityId, { content: string; ts: number }[]>;

  /**
   * #1800 — The Booth Has Receipts: deterministic contradictions drawn ONLY from the player's own
   * record (deals, events, DR statements). Returns [] when the ORWELL_BOOTH_RECEIPTS flag is OFF.
   * Never reads the Vault. Never returns NPC knowledge or hidden state.
   */
  playerReceipts(): Receipt[];

  /**
   * 0104 — the (Vault-free) notoriety legend clauses the narrator may voice as a returning-cast
   * callback on premiere / early-social. Returns null when the player did not return as the same
   * character (PO ruling 2026-11-01: a NEW character is a clean slate; only a returning character
   * carries a legend). Only the legend gist crosses — this is a PROJECTION, never the full
   * `NotorietySummary`: the reputation FACETS (hidden numbers), placements and season counts that
   * drive the day-one biases never leave the engine.
   */
  notorietySummary(): NotorietyLegendView | null;

  /**
   * FE-driven write-back (0070): enrich the prose `content` of an already-recorded hidden
   * off-screen event with model-voiced texture. CONTENT ONLY — it cannot create an event,
   * alter a witness set, flip the hidden flag, or carry a relationship number. Idempotent;
   * a no-op for an unknown or non-hidden event (returns `{ ok: false }`). Fail-soft: a
   * missing driver leaves the deterministic template content intact. Not a model lever.
   */
  recordOffscreenSceneTexture(req: RecordOffscreenSceneTextureReq): RecordOffscreenSceneTextureResult;
}
