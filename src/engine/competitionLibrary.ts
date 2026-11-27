import type { CompetitionType } from "../domain/competitionOutcome";
import type { RandomnessSource } from "../ports/RandomnessSource";

/**
 * Feature 0042 — the competition library: a seeded, CURATED set of competition definitions so a
 * season has real, structured variety. Each def names the comp, declares WHICH aptitude governs it
 * (explicitly — the def's `type` routes into the existing 0006/0028 resolution math, unchanged),
 * and carries a Vault-free narrative scaffold the narrator (0018) dresses — premise, beats, and how
 * a win reads. The library NEVER picks a winner (anti-sycophancy): `resolveCompetition` still
 * decides from stats + bounded temperature + the soul emotional modifier + intent.
 *
 * Tunable content, like `richnessConfig` / the temperature constants: add or reword defs freely —
 * the tests pin the structure (governing === the resolution map's stat for the def's type; ids
 * unique; both phases stocked), not the flavor.
 */
export type CompetitionPhase = "hoh" | "veto";
export type CompetitionFormat = "endurance" | "puzzle" | "quiz" | "skill" | "crapshoot" | "social";
export type Aptitude = "physical" | "mental" | "social";

/** The Vault-free narrative scaffold (0018): flavor only — no stats, no scores, no hidden state. */
export interface CompetitionNarrative {
  premise: string;
  beats: string[];
  winReads: string;
}

export interface CompetitionDef {
  id: string;
  name: string;
  phase: CompetitionPhase;
  /** The existing resolution type (0006) — `RELEVANT[type]` IS this comp's governing aptitude. */
  type: CompetitionType;
  /** The governing aptitude, explicit (pinned to `RELEVANT[type]` by test — never drifts). */
  governing: Aptitude;
  /** Narrative flavor only — a secondary read the scaffold mentions; resolution math unchanged. */
  secondary?: Aptitude;
  format: CompetitionFormat;
  narrative: CompetitionNarrative;
}

export const COMPETITION_LIBRARY: CompetitionDef[] = [
  // --- HOH competitions -----------------------------------------------------------------
  {
    id: "hoh-wall", name: "Hold the Wall", phase: "hoh", type: "endurance", governing: "physical",
    format: "endurance",
    narrative: {
      premise: "The houseguests grip a narrow ledge on a slowly tilting wall over the yard.",
      beats: ["the wall pitches forward and the first grips fail", "cold water sprays the holdouts", "two are left white-knuckled as the house chants"],
      winReads: "a war of attrition — the winner simply refused to drop",
    },
  },
  {
    id: "hoh-quiz", name: "House History", phase: "hoh", type: "quiz", governing: "mental", secondary: "social",
    format: "quiz",
    narrative: {
      premise: "Buzzer podiums in the living room: rapid-fire questions about what really happened this season.",
      beats: ["an easy opener lulls the field", "a brutal detail question splits the leaders", "sudden-death on the final buzzer"],
      winReads: "whoever was paying the closest attention all along",
    },
  },
  {
    id: "hoh-maze", name: "Night Maze", phase: "hoh", type: "memory", governing: "mental", secondary: "physical",
    format: "puzzle",
    narrative: {
      premise: "The yard is a blacked-out maze; each houseguest got one daylight walkthrough to memorize.",
      beats: ["the first wrong turns echo in the dark", "someone retraces from the start rather than guess", "a sprint to the glowing exit gate"],
      winReads: "a cool head holding a perfect mental map",
    },
  },
  {
    id: "hoh-haul", name: "The Long Haul", phase: "hoh", type: "physical", governing: "physical",
    format: "skill",
    narrative: {
      premise: "Carry sandbags across a greased balance beam to tip your scale before anyone else.",
      beats: ["early haulers slip and restart", "a steady rhythm emerges", "the leading scale creaks toward the buzzer"],
      winReads: "raw strength married to patience",
    },
  },
  {
    id: "hoh-count", name: "Count the House", phase: "hoh", type: "mental", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "Estimate the uncountable: jellybeans in a tub, seconds of a silent timer, steps in a montage.",
      beats: ["wild guesses scatter the board", "the cautious mid-range answers cluster", "the closest call takes the round"],
      winReads: "a calculating mind that refuses to panic",
    },
  },
  {
    id: "hoh-read", name: "Read the Room", phase: "hoh", type: "social", governing: "social", secondary: "mental",
    format: "social",
    narrative: {
      premise: "Predict, one by one, how the rest of the house answered anonymous questions about each other.",
      beats: ["a safe early read lands", "a shock answer exposes who knows whom", "the last prediction decides it"],
      winReads: "the houseguest who actually knows this house",
    },
  },
  // --- Veto competitions ----------------------------------------------------------------
  {
    id: "veto-lock", name: "Lock and Key", phase: "veto", type: "puzzle", governing: "mental", secondary: "physical",
    format: "puzzle",
    narrative: {
      premise: "Six locked boxes, hundreds of keys, one veto medallion — sort, test, and think under the clock.",
      beats: ["key piles collapse into chaos", "someone starts sorting instead of jamming", "the final lock clicks open"],
      winReads: "method beating frenzy",
    },
  },
  {
    id: "veto-whisper", name: "Whisper Network", phase: "veto", type: "social", governing: "social",
    format: "social",
    narrative: {
      premise: "Match each overheard houseguest quote to who said it — and to whom.",
      beats: ["the obvious quotes go fast", "a misattributed whisper costs a leader", "the deepest socializer pulls ahead"],
      winReads: "proof of who really listens in this house",
    },
  },
  {
    id: "veto-faces", name: "Face the Facts", phase: "veto", type: "memory", governing: "mental",
    format: "quiz",
    narrative: {
      premise: "Composite portraits flash for seconds: name the two houseguests blended in each.",
      beats: ["easy blends fall quickly", "a near-identical pair stalls everyone", "a lightning round settles it"],
      winReads: "a photographic memory under pressure",
    },
  },
  {
    id: "veto-hands", name: "Steady Hands", phase: "veto", type: "physical", governing: "physical", secondary: "mental",
    format: "skill",
    narrative: {
      premise: "Stack a card house on a wobbling table while the house is allowed to heckle.",
      beats: ["first towers collapse to jeers", "a slow builder ignores the noise", "one final card placed at full stretch"],
      winReads: "nerve and fine control, not brute force",
    },
  },
  {
    id: "veto-scramble", name: "House Scramble", phase: "veto", type: "puzzle", governing: "mental", secondary: "physical",
    format: "crapshoot",
    narrative: {
      premise: "A chaotic yard-wide scavenger scramble for hidden veto letters — part plan, part pandemonium.",
      beats: ["everyone sprints somewhere different", "two houseguests fight over the same hiding spot", "the last letter surfaces in plain sight"],
      winReads: "a scramble where keeping your head counted double",
    },
  },
  {
    id: "veto-hang", name: "Hang Tough", phase: "veto", type: "endurance", governing: "physical",
    format: "endurance",
    narrative: {
      premise: "Dangle from swinging rings over foam while the rig speeds up every minute.",
      beats: ["the first drops come early", "the rig jerks and thins the field", "two grips outlast the speed setting"],
      winReads: "whoever wanted it badly enough to hurt for it",
    },
  },
];

/**
 * Feature 0126 — the EXPANDED mechanic pool. 0125's theme layer reskins the SAME ~12 mechanics, so a
 * season still repeats each mechanic ~2×; this adds 9 HOH + 9 veto NEW mechanics so a full season (~14
 * HOH + ~13 veto comps) can run with essentially no repeated MECHANIC (not just no repeated skin). The
 * new defs preserve the base pool's governing-stat MIX per phase (physical ~33% / mental ~53% / social
 * ~13%) so the competition balance — and thus the seeded calibration distribution — stays stable.
 *
 * default ON (`ORWELL_COMP_MECHANICS_PLUS`; `=0` opts out, threaded via `SeasonCtx.expandedComps`): adding
 * mechanics changes WHICH def a fixed seed draws each week, and the def's `type` selects the resolution
 * stat, so it changes seeded winners (the documented COMP-4 cost). With the flag off the draw pool is the
 * bare base 12 ⇒ every seeded gate (juryReach / gradient / UAT / golden / the fixed-seed 0043 BDD) is
 * byte-identical. The deploy turns it on for real play; a flag-on calibration sanity proves the band holds.
 */
export const COMPETITION_LIBRARY_PLUS: CompetitionDef[] = [
  // --- HOH (9 new: 3 physical, 5 mental, 1 social — mirrors the base mix) ----------------
  {
    id: "hoh-slip", name: "Slip 'N Slide Shuffle", phase: "hoh", type: "physical", governing: "physical", secondary: "mental",
    format: "skill",
    narrative: {
      premise: "A foam-slick runway: belly-slide down, grab a puzzle piece, wade back, and build.",
      beats: ["the first sliders overshoot into the pit", "someone finds a slow, sure crawl", "the last piece is set with the buzzer looming"],
      winReads: "power that kept its footing on nothing",
    },
  },
  {
    id: "hoh-cling", name: "The Gauntlet", phase: "hoh", type: "physical", governing: "physical",
    format: "skill",
    narrative: {
      premise: "A timed agility run: vault the hurdles, weave the poles, swing the rope, and slap the buzzer.",
      beats: ["an early runner clips a hurdle and resets", "a clean, fast line sets the time to beat", "the last heat comes down to a hundredth of a second"],
      winReads: "raw speed and footwork under the clock",
    },
  },
  {
    id: "hoh-boulder", name: "Boulder Push", phase: "hoh", type: "physical", governing: "physical",
    format: "skill",
    narrative: {
      premise: "Roll a giant weighted ball up a switchback ramp and park it on a narrow mark.",
      beats: ["early pushes roll back over the pushers", "a measured pace finds the groove", "the leader's ball teeters on the mark"],
      winReads: "brute strength married to control",
    },
  },
  {
    id: "hoh-grid", name: "Gridlock", phase: "hoh", type: "puzzle", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "A giant sliding-tile board: shuffle the squares to rebuild the house logo, one move at a time.",
      beats: ["everyone slides fast and scrambles it worse", "one player stops to plan the sequence", "the final tile clicks home"],
      winReads: "patience out-thinking panic",
    },
  },
  {
    id: "hoh-timeline", name: "Before & After", phase: "hoh", type: "quiz", governing: "mental", secondary: "social",
    format: "quiz",
    narrative: {
      premise: "Put the season's events in order: which happened before which, buzzers only.",
      beats: ["the obvious order goes fast", "two tangled events split the leaders", "a sudden-death ordering decides it"],
      winReads: "the sharpest memory for how the season unspooled",
    },
  },
  {
    id: "hoh-montage", name: "Photo Finish", phase: "hoh", type: "memory", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "A montage of house moments flashes by; then answer how many, who, and in what order.",
      beats: ["easy counts land quickly", "a near-identical pair of frames stalls everyone", "the tiebreak comes down to one detail"],
      winReads: "a mind that filed every frame",
    },
  },
  {
    id: "hoh-numbers", name: "By the Numbers", phase: "hoh", type: "mental", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "Reach the target number from a scramble of digits and operators, fastest math wins.",
      beats: ["wild stabs miss high and low", "the careful arithmetic clusters near the mark", "the closest exact answer takes it"],
      winReads: "a calculating head under the clock",
    },
  },
  {
    id: "hoh-truefalse", name: "Fact or Fiction", phase: "hoh", type: "quiz", governing: "mental",
    format: "quiz",
    narrative: {
      premise: "True or false, rapid fire: statements about what really happened in the house.",
      beats: ["a run of gimmes lulls the field", "a cleverly-worded trap catches a leader", "the final statement is a coin-flip of nerve"],
      winReads: "who read the house closest, and second-guessed least",
    },
  },
  {
    id: "hoh-poll", name: "Popularity Contest", phase: "hoh", type: "social", governing: "social", secondary: "mental",
    format: "social",
    narrative: {
      premise: "Guess how the house ranked each other in an anonymous poll — most likely to flip, to win, to bore.",
      beats: ["a safe first guess lands", "a shock ranking exposes who really sees the house", "the last prediction crowns it"],
      winReads: "the houseguest who actually knows where they all stand",
    },
  },
  // --- Veto (9 new: 3 physical, 5 mental, 1 social) --------------------------------------
  {
    id: "veto-beam", name: "Balance Beam", phase: "veto", type: "physical", governing: "physical", secondary: "mental",
    format: "skill",
    narrative: {
      premise: "Ferry stacked tokens across a wobbling beam over water; a drop sends you back to start.",
      beats: ["first crossers wobble into the drink", "a slow, planted stride emerges", "the winning stack lands at full stretch"],
      winReads: "nerve and fine balance beating haste",
    },
  },
  {
    id: "veto-deadhang", name: "Dead Eye", phase: "veto", type: "physical", governing: "physical",
    format: "skill",
    narrative: {
      premise: "Precision toss: land bean-bags and rings on distant targets, one throw per turn, points climbing.",
      beats: ["early throws sail wide of the board", "someone finds the arc and stacks points", "the final throw needs a bullseye to win"],
      winReads: "a steady arm and a cool aim",
    },
  },
  {
    id: "veto-crawl", name: "Mud Crawl", phase: "veto", type: "physical", governing: "physical", secondary: "mental",
    format: "crapshoot",
    narrative: {
      premise: "Belly-crawl a muddy obstacle course collecting veto tokens under a low net.",
      beats: ["everyone bogs down in the first pit", "a churning rhythm breaks someone free", "the last token surfaces caked in mud"],
      winReads: "grit that kept moving through the muck",
    },
  },
  {
    id: "veto-tangram", name: "Tangram Trial", phase: "veto", type: "puzzle", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "Fit a heap of odd shapes into one silhouette board — only one arrangement solves it.",
      beats: ["forced pieces jam the frame", "one builder clears the board and restarts clean", "the final shape snaps flush"],
      winReads: "spatial sense out-lasting frustration",
    },
  },
  {
    id: "veto-rewind", name: "Spellbound", phase: "veto", type: "puzzle", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "A wall of scrambled letter tiles: unscramble the houseguest names and house words against the clock.",
      beats: ["short words fall fast", "a long anagram jams the leaders", "the final word is spelled at the buzzer"],
      winReads: "a nimble mind for letters and patterns",
    },
  },
  {
    id: "veto-spot", name: "Process of Elimination", phase: "veto", type: "mental", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "A logic grid of clues — 'the veto is not behind a blue door', 'it is left of the red' — deduce the one true answer.",
      beats: ["the first deductions rule out the easy options", "a contradiction forces a rethink", "one airtight chain of logic lands the answer"],
      winReads: "cold deduction that never guessed",
    },
  },
  {
    id: "veto-countdown", name: "Crack the Safe", phase: "veto", type: "mental", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "A locked safe and a secret combination — each guess lights how many digits are right and right-placed. Crack it in the fewest tries.",
      beats: ["the opening guesses map the field", "the feedback narrows the code", "the last dial-in swings the door open"],
      winReads: "deductive code-breaking under pressure",
    },
  },
  {
    id: "veto-ballmaze", name: "Total Recall", phase: "veto", type: "memory", governing: "mental", secondary: "physical",
    format: "skill",
    narrative: {
      premise: "A growing sequence of house moments lights up on the wall; step out the whole order on the floor pads, adding one each round.",
      beats: ["the short sequences are easy to walk", "a long chain trips a leader mid-step", "the final round is a marathon of memory"],
      winReads: "a flawless memory that never broke stride",
    },
  },
  {
    id: "veto-tells", name: "Tells", phase: "veto", type: "social", governing: "social", secondary: "mental",
    format: "social",
    narrative: {
      premise: "Watch silent clips of houseguests answering yes/no — call who was lying.",
      beats: ["the obvious tells go fast", "a practiced poker face fools a leader", "the sharpest reader pulls ahead"],
      winReads: "proof of who really reads this house",
    },
  },
];

/**
 * ORW-530 (Ryne 2026-11-27: grow the authored pool from 30 to about 50): 10 HOH + 10 veto more mechanics, per phase 3 physical, 5 mental, 2 social (the base mix: mental-dominant, physical second, social a minority).
 * Drawn only when `ORWELL_COMP_MECHANICS_MORE` is on (`SeasonCtx.moreComps`, together with the 0126 expanded pool): the flag is ON in the deploy defaults, so prod draws from all 50; the seeded TEST lanes pin it
 * OFF (tests/support/premiereTestDefault.ts) until the follow-up card ORW-1104 re-hints the seed-pinned tests, because a larger pool moves which mechanic a fixed seed draws. Off => the 30 pool, byte-identical.
 */
export const COMPETITION_LIBRARY_MORE: CompetitionDef[] = [
  {
    id: "hoh-ladder", name: "The Greased Ladder", phase: "hoh", type: "physical", governing: "physical",
    format: "skill",
    narrative: {
      premise: "A slick ladder bolted to the yard wall: climb it, ring the bell at the top, and climb back down before the next houseguest starts.",
      beats: ["the first climber slides to the bottom twice", "someone finds grip on the outer rails and sets the pace", "the final pair race the clock on the way down"],
      winReads: "the one who trusted their grip over their speed",
    },
  },
  {
    id: "hoh-tug", name: "House Tug", phase: "hoh", type: "endurance", governing: "physical",
    format: "endurance",
    narrative: {
      premise: "Teams of two haul a long rope across the yard, round after round, until one pair is left standing.",
      beats: ["a heavy pair drags the first round without effort", "the rope burns and the weaker side lets go early", "the last two pairs dig their heels in until one slips"],
      winReads: "stamina in the shoulders and patience in the heels",
    },
  },
  {
    id: "hoh-bucket", name: "Bucket Brigade", phase: "hoh", type: "physical", governing: "physical", secondary: "mental",
    format: "skill",
    narrative: {
      premise: "Fill a bucket at the pool, run it to the shed, and pour it into a tank that only shows its level at the end.",
      beats: ["spills cost the leaders their lead", "a runner learns to carry less and keep moving", "the tank reads full and the cheering turns to counting"],
      winReads: "the one who ran steady and kept the count in their head",
    },
  },
  {
    id: "hoh-crossword", name: "Crosswords in the Dark", phase: "hoh", type: "puzzle", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "A crossword about the house, printed on the ceiling in the dark: read it by flashlight and fill the grid on paper below.",
      beats: ["the corners fill first and the middle stays blank", "a long answer unlocks three others at once", "the last clue is the one nobody has said aloud all season"],
      winReads: "a patient reader who saw the pattern before the others",
    },
  },
  {
    id: "hoh-lights", name: "Light Sequence", phase: "hoh", type: "memory", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "A wall of colored bulbs flashes a pattern, then goes dark: repeat it, then repeat it longer.",
      beats: ["the first rounds are a warm-up", "one bulb drops out of a long pattern and half the field freezes", "two houseguests are left reciting from memory"],
      winReads: "a clean memory under pressure",
    },
  },
  {
    id: "hoh-price", name: "The Price Is Wrong", phase: "hoh", type: "quiz", governing: "mental",
    format: "quiz",
    narrative: {
      premise: "Rapid-fire estimates: what did the house spend, how many days since move-in, how many steps to the backyard - closest without going over wins the round.",
      beats: ["the overbidders go out first", "a lucky guess becomes a streak", "the final round is a number nobody has thought about"],
      winReads: "the best guesser in a house full of guessers",
    },
  },
  {
    id: "hoh-cipher", name: "The Cipher Wall", phase: "hoh", type: "mental", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "A wall of symbols swaps letters for pictures: decode the message that tells where the key is hidden.",
      beats: ["a few symbols fall quickly and everyone copies them", "someone breaks the pattern and keeps their paper hidden", "the last word is the key's hiding place"],
      winReads: "a quiet mind that cracked it while the others whispered",
    },
  },
  {
    id: "hoh-saidit", name: "Who Said It", phase: "hoh", type: "quiz", governing: "mental",
    format: "quiz",
    narrative: {
      premise: "Quotes from the season, read aloud with the name removed: name the speaker and the day.",
      beats: ["the loud quotes go to the loud houseguests", "a mumbled line splits the leaders", "the last quote was said to someone in this room"],
      winReads: "whoever really was listening",
    },
  },
  {
    id: "hoh-pitch", name: "The Pitch", phase: "hoh", type: "social", governing: "social",
    format: "social",
    narrative: {
      premise: "Each houseguest gets sixty seconds to pitch the house on why they should hold power this week; the house votes with their feet.",
      beats: ["a funny opener wins a laugh and a few steps", "a promise to someone in the crowd lands hard", "the final pitch is a confession that shifts the room"],
      winReads: "a read of the room better than anyone else's",
    },
  },
  {
    id: "hoh-tales", name: "Tall Tales", phase: "hoh", type: "social", governing: "social",
    format: "social",
    narrative: {
      premise: "Each houseguest tells a story about the house that might be true; the others guess whether it is, and the best bluff wins.",
      beats: ["a plain truth is doubted and a lie is believed", "a story gets a gasp from someone it is about", "the last teller holds the room in silence"],
      winReads: "a straight face and a sense of what the room would believe",
    },
  },
  {
    id: "veto-swing", name: "Rope Swing Relay", phase: "veto", type: "physical", governing: "physical",
    format: "skill",
    narrative: {
      premise: "Swing across the pool on a rope, drop a ring onto a peg, and swim back before the next houseguest goes.",
      beats: ["the first swinger drops short and gets wet", "a clean swing lands a ring on the first try", "the final two trade the lead on the last peg"],
      winReads: "timing and a good grip",
    },
  },
  {
    id: "veto-wheel", name: "Wheel of Pain", phase: "veto", type: "endurance", governing: "physical",
    format: "endurance",
    narrative: {
      premise: "Everyone hangs from a spinning wheel; it speeds up every minute and the last one hanging wins.",
      beats: ["the wheel starts slowly and nobody lets go", "a stumble sends two off at once", "the wheel hums and the last holds on to a smile"],
      winReads: "who could take it the longest",
    },
  },
  {
    id: "veto-darts", name: "Bullseye Blitz", phase: "veto", type: "physical", governing: "physical", secondary: "mental",
    format: "skill",
    narrative: {
      premise: "A wall of balloons, a handful of darts, and a number on each balloon that adds up to the score to beat.",
      beats: ["the first rounds are noisy and wild", "a steady thrower adds up while the others guess", "a final throw decides it with the crowd quiet"],
      winReads: "a steady hand with a quick head for sums",
    },
  },
  {
    id: "veto-sudoku", name: "Sudoku Sprint", phase: "veto", type: "puzzle", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "A giant numbers grid with half the squares empty: fill it by hand against the clock.",
      beats: ["the easy rows fall in seconds", "a wrong digit costs the leader their lead", "the last square is a three-way tie broken by time"],
      winReads: "a logic-minded finisher who never guessed",
    },
  },
  {
    id: "veto-tune", name: "Name That Tune", phase: "veto", type: "memory", governing: "mental",
    format: "quiz",
    narrative: {
      premise: "A few notes of a song played on a piano: name it and who sang it, then the year.",
      beats: ["the hits go fast", "a half-remembered chorus splits the room", "the last clip is a song from the house's first night"],
      winReads: "a good ear and a good memory",
    },
  },
  {
    id: "veto-zebra", name: "Who Sleeps Where", phase: "veto", type: "mental", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "A logic puzzle with the house's own beds as the clues: work out who sleeps where from a list of hints.",
      beats: ["the first clue seems to say nothing", "a contradiction sends a leader back to the start", "the last two cross-check each other and one is right"],
      winReads: "the person who kept the whole grid in their head",
    },
  },
  {
    id: "veto-mapmaker", name: "Map the House", phase: "veto", type: "memory", governing: "mental",
    format: "puzzle",
    narrative: {
      premise: "Shown the house floor plan for thirty seconds, then handed a blank one: place every room and bed from memory.",
      beats: ["the big rooms are easy and the closets are not", "a mislabeled door costs the leader a point", "the last bed goes down and the judges count"],
      winReads: "a spatial memory that had been quietly walking the halls",
    },
  },
  {
    id: "veto-trivia", name: "Season Trivia", phase: "veto", type: "quiz", governing: "mental",
    format: "quiz",
    narrative: {
      premise: "Questions from this season's own record: who won, who was nominated, who said what, buzzer rules.",
      beats: ["an easy start separates no one", "a trick question gets two wrong answers at once", "a sudden-death buzz on a detail from week one"],
      winReads: "the one who was keeping score all along",
    },
  },
  {
    id: "veto-hotseat", name: "Hot Seat", phase: "veto", type: "social", governing: "social",
    format: "social",
    narrative: {
      premise: "Each houseguest sits in the hot seat for a minute while the others ask anything; the house scores who handled it best.",
      beats: ["a joke defuses the first question", "a hard question about a real conflict lands in silence", "the last answer wins the room back"],
      winReads: "someone who stayed honest and stayed charming",
    },
  },
  {
    id: "veto-silent", name: "Silent Movie", phase: "veto", type: "social", governing: "social", secondary: "mental",
    format: "social",
    narrative: {
      premise: "Act out a scene from the season without words; the others guess the moment and the people in it.",
      beats: ["the obvious scenes are guessed in seconds", "a gesture is misread as a fight and the room laughs", "the last scene is one only two people remember"],
      winReads: "a performer with an audience that knew them",
    },
  },
];

/**
 * How many most-recent draws (per phase) the next draw must avoid — no immediate repeats.
 *
 * NOTE (COMP-4/BB-8, audit 2026-07-03): widening this (e.g. to 3) would meaningfully cut short-
 * interval verbatim repeats over an 11-week season, but it changes WHICH def a fixed seed draws each
 * week — and because the drawn def's `type` selects the resolution stat, that can flip an HOH/veto
 * winner for a fixed seed, cascading into a different nomination/eviction trajectory. Confirmed live:
 * bumping this to 3 broke the single-fixed-seed `emergent_blocs` BDD scenario (0043) by changing which
 * seed held HOH. Deferred — needs either a seed-tolerant rewrite of the affected fixed-seed tests or a
 * dedicated calibration re-measurement pass, not a one-line bump. See docs/audits/2026-07-03-final-
 * pre-ship-audit/lanes/comp-variety.md COMP-4 for the fuller variety options (growing the pool is
 * lower-risk than narrowing the repeat window).
 */
export const NO_REPEAT_WINDOW = 1;

/** Library lookup by id (searches BOTH the base 12 and the 0126 expanded pool, so a deferred veto
 *  drawn from the expanded pool still resolves the comp it already drew). */
export function competitionById(id: string): CompetitionDef | undefined {
  return COMPETITION_LIBRARY.find((d) => d.id === id) ?? COMPETITION_LIBRARY_PLUS.find((d) => d.id === id) ?? COMPETITION_LIBRARY_MORE.find((d) => d.id === id);
}

/**
 * Deterministically draw the week's competition for a phase: the seeded rng picks from the phase's
 * pool, avoiding the last `NO_REPEAT_WINDOW` used (variety, reproducibly by seed). PURE — the
 * caller owns `recent` (persisted with the season, 0030) and records the draw when the comp
 * actually resolves.
 *
 * `expanded` (0126) folds the extra mechanic pool into the draw. Default false ⇒ the bare base 12,
 * byte-identical to pre-0126 (the seeded spine is untouched unless a caller opts in via the flag).
 */
export function drawCompetition(
  phase: CompetitionPhase, week: number, rng: RandomnessSource, recent: readonly string[] = [],
  expanded = false, more = false,
): CompetitionDef {
  const library = expanded ? [...COMPETITION_LIBRARY, ...COMPETITION_LIBRARY_PLUS, ...(more ? COMPETITION_LIBRARY_MORE : [])] : COMPETITION_LIBRARY;
  const pool = library.filter((d) => d.phase === phase);
  // 0126: with the expanded pool the window widens to the whole pool minus one — a rolling shuffle, so no
  // mechanic repeats until every one has been used (a season of ~14 comps from 15 is repeat-free). The base
  // pool keeps the NO_REPEAT_WINDOW=1 behavior byte-identically (the seeded spine is unmoved when off).
  const window = expanded ? pool.length - 1 : NO_REPEAT_WINDOW;
  const avoid = new Set(recent.slice(-window));
  const candidates = pool.filter((d) => !avoid.has(d.id));
  const from = candidates.length > 0 ? candidates : pool; // a fully-exhausted pool can only repeat
  return from[rng.int(from.length)]!;
}
