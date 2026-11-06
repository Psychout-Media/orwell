# 0100 — The jury grudge book, made felt (evicted jurors gossip; goodbyes decide the crown)

> **Disambiguation:** "jury house" names two things. **This spec (0100) is the built, hidden NPC↔NPC layer** (`src/engine/juryHouse.ts`). [0129](./0129-the-jury-house.md) is the *player-facing* sequestered jury house a juror-player would visit (unbuilt).
> **Current default (AMEND 2026-11-06):** `ORWELL_JURY_HOUSE` is **default ON** in the engine (`src/featureFlags.ts`, `defaultOn`; `=0` turns it off, and the deploy profile sets it too). The "default off" / "opt-in" wording below records how it was built and calibrated (byte-identical OFF), not today's default.

> **Status:** ✅ **BUILT (2026-06-27; Tracks #882).** Engine-internal, behind `ORWELL_JURY_HOUSE`
> (code default off ⇒ byte-identical calibration; the deploy profile sets it ON). **Cadence (owner ruling 2026-11-02, #1922; PR #1932): the jury house is a fast-forward limbo, one short stretch of 1–3 hidden juror scenes per new juror ARRIVAL (about once a week), not one per off-screen tick**; the text below that says "per tick" is the original design. It holds only jurors (see 0129): `src/engine/juryHouse.ts` (`runJuryHouseStretch`) +
> `src/engine/juryHouseConstants.ts` (`JURY_HOUSE`), wired from the orchestrator's off-screen tick via the
> self-gated adapter `juryHouseTick`, accumulated into the persisted `live.juryGrudge`, consumed at the
> finale by `edgeAsJuryRel`. Gated by `tests/unit/juryHouse.test.ts`, `tests/unit/juryHouseAdapter.test.ts`,
> and the BDD `0100-jury-grudge-book.feature` (in `cucumber.cjs`). The design for making jury management *tense and
> legible-by-behavior*: the last nine evictees keep living in a sequestered **jury house** where they
> gossip about the player and each other (hidden, NPC↔NPC), and their final votes reflect the
> accumulated treatment they carried in **plus** what the jury house does to those reads. *"Every
> goodbye matters."* The grudge is real, recorded, and folded into the engine-owned vote — and it
> reaches the player **only** through behavior (a juror's coldness at the finale, a vote that breaks
> the wrong way), never a number.
> **Executable spec:** [`0100-jury-grudge-book.feature`](./0100-jury-grudge-book.feature)

> **Builds on (does NOT rebuild):** 0014 (jury & endgame — the jury IS the last nine evictees, the
> `juryLean`/`tallyJuryVote`/tie-break math), 0037 (the live interactive finale + **recorded eviction
> manner** — `mannerByEvictee`, the symmetric A5 manner-applies-to-the-player ruling, the
> engine-legible appeal sway), 0045 (Final 5 → Final 2 — every late eviction records manner and adds a
> juror), and the live off-screen society + gossip (**0038 / ADR 0002** — `src/engine/offscreen.ts`'s
> `richOffscreenStretch`, `src/engine/gossip.ts`'s `diffuseGossip`, run from
> `composition/orchestrator.ts` `defaultApply`). This is **not a new jury system** — it is a *second
> society* (the jury house) wired to the *same* manner→lean machinery the finale already reads.
> **Depends on:** 0001 (Vault Wall), 0002 (event visibility, gossip pathways, the relationship model),
> 0023/0026 (the consequence/relationship fold), 0030/0007 (persistence & non-degradation), 0021
> (per-user isolation). **Bounded by:** mandate #1 (behavioral fidelity — the jury house is a real,
> living backstage), #2 (the Vault Wall — a juror's grudge is hidden state; secret ballots stay
> sealed), #3 (anti-sycophancy — the engine tallies, the model only voices), #4 (non-degradation —
> every juror-house beat accumulates, never thins).

> **Owner framing (Tracks #882):** *"the jury grudge book, made felt."* The hidden layer already
> records how the player treated each evictee. Make jury management tense and legible-by-behavior:
> evicted jurors GOSSIP about the player in the jury house, and their final votes reflect accumulated
> treatment + those jury-house dynamics. Surface only through behavior — a juror's coldness at the
> finale — never a number.

## Why — the late game is where retention is won, and right now the jury house is dead air

The single most-quoted promise of *Big Brother* jury play is **"every goodbye matters"**: the way you
cut someone follows you to the end, because the people you evicted **sit in a house together and talk
about you** for weeks before they vote. That backstage is where a bitter jury hardens, where a sloppy
blindside metastasises into a bloc against you, and where a respectful exit earns a vote you didn't
know you had. It is the emotional payoff of the whole long game.

Two things are true in the current build:

1. **The grudge is recorded but inert-after-eviction.** 0014/0037/0045 already record *eviction
   manner* (`betrayed` / `blindsided` / `disrespected` / `respected`, graded by the real edge) into
   `mannerByEvictee`, and `juryLean` reads it at the finale — jury management already cuts both ways
   (audit A5). Good. But the read is **frozen at the moment of eviction**. Nothing happens to it
   afterward.

2. **Jurors stop living the moment they're evicted.** `defaultApply`
   (`composition/orchestrator.ts:498`) explicitly removes evicted houseguests from the off-screen
   society — *"B52/audit D5: evicted houseguests stop living… no more scheming/confessing weeks after
   eviction."* That belt was correct for the **main house** (a ghost can't scheme in a game they left),
   but it has a side effect: **the jury house does not exist.** The nine people deciding the winner are,
   between their eviction and the finale, simulated as nothing. They never compare notes, a bitter
   juror never poisons a neutral one, the player's worst betrayal never echoes down the hall.

So the most human, highest-stakes back-half beat in the game — *the jury turning on you while you
can't defend yourself* — is dead air. The finale vote is a snapshot of nine independent grudges frozen
at nine different moments, with no social life between them. This feature gives the jury house a
(hidden) life, so the long game stays alive right up to the crown.

### The retention value (why this earns its tokens, ADR 0003 litmus)

ADR 0003 says every engine addition must serve **behavioral fidelity** (mandate #1) and the four
fixes, not bolt on a system. This does exactly that and nothing more: it is a *thin second society*
reusing the existing off-screen sim + gossip + manner→lean machinery to fix a fidelity gap (the jury
house is real *BB*; an inert one is a degradation). It makes the back third of a season — historically
the thinnest stretch, where a player who has lost the HOH race is just riding to a likely loss — carry
genuine, legible tension: **what you did on the way to Final 2 is still being litigated, in a room you
can't enter.** That is the payoff the long game was building toward.

## The bright line this feature has to respect (read first)

A juror "souring on the player in the jury house" sounds, at a glance, like the engine *deciding the
human should lose* — a sycophancy/agency hazard — and the gossip itself sounds like new Vault content.
Neither is true, for the same structural reasons the rest of the architecture relies on:

1. **The engine tallies; the model only voices (ADR 0005, mandate #3).** Whether a juror's lean
   shifts in the jury house, by how much, and which way the vote finally breaks are **engine-computed**
   from sealed relationship/manner state on a **seeded** stream. The model is handed only the *voiced
   result* — a juror's tone, a vote read aloud — and never sets a lean or a tally. The vote stays
   exactly as engine-owned as it is today (0014 §6); this feature only feeds it a richer (still hidden)
   lean.

2. **The grudge is hidden state behind the Vault Wall (mandate #2).** A juror's evolving read of the
   player is `Soul`/relationship + manner data — engine-only, never on any player-facing **or admin**
   projection. The jury-house gossip is ordinary **hidden** off-screen events (witness set excludes the
   player; the player is *not in the jury house*), exactly like the main-house society (0038). The
   player learns of it **only** through behavior at the finale (a cold juror, an unexpected vote) — the
   *feeling* is theirs to read (0017), never a surfaced number.

3. **Secret ballots stay sealed (the mandate, audit E12).** Per-voter attribution unseals **only** in
   the 0048 post-season retrospective. This feature changes *how a juror's lean is computed*, **not**
   when or whether the ballot is revealed. The staged reveal still reads anonymized
   ("a vote to evict / a vote to win for…"); who voted which way stays sealed until the retrospective.

4. **Anti-sycophancy is symmetric and unflattering.** The jury house can only ever make a *bitter*
   jury more coherent or a *respectful* exit pay off — it never invents goodwill the player didn't earn,
   and it never *spares* the player a grudge they did earn. A player who blindsided half the jury should
   feel the room close ranks; a player who cut people cleanly should feel it hold. The engine never
   nudges the vote *toward* the human to please them (mandate #3).

## The mechanic

### 1. The jury house — a sequestered second society (built on 0038)

The jury is already exactly the **last nine evictees** (`s.evictionOrder.slice(-9)`, 0014/0045).
Sequester begins at the first juror's eviction (0014 §3). From that eviction onward, the jurors form a
**separate off-screen society** — the jury house — that lives *in parallel with* the main house, behind
the same bounds, seeding, Vault Wall, and isolation the main-house tick already guarantees.

- **It reuses the existing sim.** A juror-house stretch runs the *same* `richOffscreenStretch` /
  `diffuseGossip` machinery (0038), over the **juror set** instead of the living-house set. No new sim:
  the jurors bond, clash, and gossip among themselves exactly as the house does — they just do it in a
  different room (the jury house) and about a different, now-fixed cast of subjects (each other **and
  the player**, who is still in the game).
- **It is gated and opt-in (calibration-critical, see §determinism).** The jury-house society runs on
  a **dedicated, isolated rng** behind an explicit flag (sibling to `ORWELL_CAMPAIGNS` — proposed
  `ORWELL_JURY_HOUSE`), so that with it **off**, **no juror-house draw is taken and no lean is moved** —
  the seeded `juryReach` / UAT calibration spine is **byte-identical**.
- **It does not touch the main house.** The main-house society still excludes evicted houseguests
  (`defaultApply:498` is unchanged) — a juror cannot scheme back into the game they left. The jury house
  is strictly additive: a *second* hidden society whose only downstream effect is the (hidden) jury
  lean, read at the finale.

### 2. What the jurors talk about — the player is the subject (built on 0002 gossip)

The point of the jury house is that the player is **the subject of the conversation they can't hear.**
Two kinds of juror-house beat:

- **Juror↔juror gossip about the player.** A juror who carries a grievance (the manner already
  recorded at *their* eviction) is a **source**: their grievance **diffuses** to other jurors along the
  jury-house social graph (`diffuseGossip`, 0002), drifting and decaying with each retelling exactly as
  main-house gossip does. When a grievance-belief about the player *reaches* another juror, it folds a
  small, confidence-scaled move into **that juror's** read of the player (the existing `GOSSIP_HEARD`
  receipt fold) — so **one player-betrayed juror can sour a second juror who left on good terms.** This
  is the bloc-against-you forming, made mechanical: the bitterness is contagious, bounded, and seeded.
- **Juror↔juror social life.** The jurors also bond and clash *with each other* (ordinary
  `richOffscreenStretch` scenes), which matters because affinity between jurors is the **edge gossip
  travels along** — two jurors who were already close pass a grievance readily; an isolated juror is
  harder to turn. (This is the same affinity-graph rule the main house uses; it just makes "who turns
  whom" emergent rather than uniform.)

Crucially — and this is the Vault Wall holding — **the player is a node the gossip can be *about* but
never *reaches*** during sequester: the player is not in the jury house, so no jury-house pathway
terminates at the player. The player learns nothing of it until the finale, and even then only through
behavior. (Contrast the main house, where a terminating pathway legitimately *does* reach the player —
0038/B27b. Here, by construction, it cannot.)

### 3. The accumulated grudge folds into the final vote (built on 0014/0037, engine-owned)

The finale vote already reads each juror's lean as `juryLean(rel, manner)` (0014/0037), weighted by
`JURY_WEIGHTS`, with the finale appeal a small bounded sway on top. This feature changes **only the
inputs to that lean** — never the tally, never the tie-break, never the reveal:

- The **manner recorded at eviction** (already there) is the *baseline* grudge.
- The **jury-house drift** (this feature) is a bounded, hidden **adjustment** to the juror's read of
  the player accumulated over sequester — a juror who heard, again and again, how the player burned
  someone goes in *colder* than the snapshot at their own eviction implied; a juror who heard nothing
  bad (or heard others vouch for a clean game) holds steady.
- That adjusted read flows through the **same** `juryLean` / `castJuryVote` / `tallyJuryVote` path —
  the engine still decides every vote, the LLM still only voices it, the **last-evicted juror** still
  breaks a tie (0005/0014). The finale appeal sway is **unchanged** and still bounded by
  `JURY_WEIGHTS.finale` (it sways close jurors, never overturns a lead) — so a bitter jury house can
  make a lead insurmountable, but a strong finale can still tip a *close* one. "Mend" appeals (0037)
  remain the player's lever to address a grievance they *can* read in the room.

The adjustment is **bounded and sized to be felt, not flatten** (the 0086 ruling-#1 lesson): it is a
*texture* term, well within the band, never a second flat knob — so it deepens the existing
jury-management signal rather than swamping it. Calibrated against `juryReach`, never deterministic.

### 4. How it surfaces — behavior only, never a number (mandate #2 / 0017)

The player **never** sees a jury-house event, a grudge tally, or a lean. What the player gets:

- At the finale, a juror who soured in the jury house **reads colder** — the model voices their
  question and their bearing from their (hidden) state (the existing `npcVoice`/finale voicing path,
  fed the Vault-free *texture* only, never the number). A juror who came around reads warmer.
- The **vote** breaks the way the accumulated grudge dictates — and a player who managed the jury
  badly *feels* it as a loss they can trace to specific goodbyes, exactly as a real *BB* player does in
  the jury roundtable. The *why* is the human's to infer (0017); the engine never announces "they're
  bitter because you blindsided them."
- The full, attributed picture — who soured, who held, the per-voter ballot — unseals **only** in the
  0048 retrospective (secret ballots; the mandate). The 0048 unsealing is the natural place to *show*
  the grudge book after the game, if desired (an enrichment, noted in open questions).

## Engine seams (where this lands — all reuse, minimal new surface)

- `src/engine/juryHouse.ts` *(new, pure)* — the jury-house stretch: given the juror set + their edges +
  the recorded manner, run a bounded juror↔juror society (delegating to `richOffscreenStretch`) and a
  grudge **diffusion** (delegating to `diffuseGossip` with the player as a *subject only*, never a
  graph terminus), then compute each juror's **bounded grudge adjustment** to their read of the player.
  No I/O, no Vault handle — handed the already-read signals (the 0075 / 0038 pattern). All magnitudes
  in a single `JURY_HOUSE` tunable (the `GOSSIP`/`SOCIETY`/`juryConstants` sibling; covered by the B59
  grep gate).
- `src/engine/juryHouseConstants.ts` *(new)* — the `JURY_HOUSE` tunable: the stretch size per
  sequestered tick (now per juror arrival, `scenesPerArrival`), the grudge-diffusion transmit/decay (or a reuse of `GOSSIP`), the **bounded**
  grudge-adjustment cap, and the per-juror saturation (a grudge can't run away). Sized *under* the
  manner+relationship terms so it deepens, never dominates (the 0086 ruling-#1 calibration discipline).
- `composition/orchestrator.ts` `defaultApply` — **after** the main-house stretch, when a jury exists
  and `ORWELL_JURY_HOUSE` is enabled, run **one bounded jury-house stretch** on the **dedicated rng**
  (never the main tick's stream — the 0085 `campaignTick` isolation pattern), recording its hidden
  events to the `EventStore` (witness set = jurors only, excludes the player) and folding the grudge
  adjustment into the hidden jury read. Self-gated ⇒ a no-op (zero draws) when off. The main-house
  exclusion of evicted houseguests (`:498`) is **unchanged**.
- `src/engine/liveSeason.ts` — `edgeAsJuryRel` / `mannerFor` (the finale's per-juror read, already
  there) consume the **accumulated** grudge adjustment alongside the recorded manner when assembling
  the `JuryRel` passed to `juryLean`. This is the only change to the vote path: a richer (still hidden)
  lean input; the tally/tie-break/reveal are untouched (reused verbatim — 0014/0037).
- **No new outward surface, no new tool.** Nothing crosses the wall: the jury house produces only
  hidden events + a hidden lean adjustment. `readsVault: false` holds everywhere; the 0001 sentinel
  canary extends over the live jury-house path (no grudge number, no jury-house scene content, no
  pre-reveal lean on any player **or admin** projection).

## Persistence (0007 / 0030 — non-degradation)

- The jury-house hidden events are ordinary recorded 0002 events — already durable, append-only; they
  **deepen, never thin** over sequester (mandate #4).
- The **accumulated grudge adjustment** per juror persists in the session snapshot (sibling to
  `mannerByEvictee` / `drives` / `surfacedThreadCount`), so a game restored mid-jury resumes with the
  jury house's accumulated bitterness **intact** — never re-rolled, never lost (the consequence loop:
  recorded → folded → persisted → recalled in full). A monotonic accumulation (bounded by the
  saturation cap) means a restored game never *forgets* a grudge it already formed.

## Determinism & calibration-neutrality (the hard requirement — read before building)

This feature touches the **jury vote**, which is the exact thing the `juryReach` calibration gate and
the UAT measure. It MUST NOT perturb them unless explicitly enabled:

- **Opt-in + isolated rng ⇒ byte-identical when off.** With `ORWELL_JURY_HOUSE` unset (the calibration
  harness never sets it — the 0085/0086 precedent), **no jury-house stretch runs, no draw is taken on
  any stream, and no grudge adjustment is applied** — so `tests/property/juryReach.property.test.ts`,
  `juryReachAggregate`, and the full-game UAT are **byte-identical** to today. This is the same guard
  0085/0086 hold (`ORWELL_CAMPAIGNS` off ⇒ no draws ⇒ identical), and it is the gate this spec must
  pass before merge.
- **Dedicated rng even when on.** The jury-house society draws from its **own** seeded stream (never
  the main off-screen tick's), so enabling it cannot shift the *main* house's seeded competition/vote
  outcomes out of phase — only the (hidden) jury lean changes, and only at the finale.
- **Must not break the existing jury calibration when on.** When enabled, the grudge adjustment is
  **bounded and sized to read as texture** (the 0086 ruling-#1 discipline): a *new* `juryReach`-class
  measurement of the with-jury-house distribution is required at build, asserting the EARNED-wins
  property still holds (playing the game still converts; a passive player does not start *winning* off
  a bitter jury, nor losing a finale they earned). The grudge sharpens an already-bitter jury and pays
  off a clean game — it never flips the calibrated outcome of *good play*.
- **Seeded end to end.** Same seed + same history + flag-on ⇒ identical jury house, identical grudge
  adjustments, identical votes. A failure is always a real behavior change, never noise.

## ADR 0003 fit (the conversation is the game)

This is engine-side hidden state + a richer (still hidden) lean — it adds **no** framing to a game
turn, **no** script for the model to recite, and **no** UI that replaces a chat interaction. It serves
behavioral fidelity (mandate #1) by making the jury house *real*, and it surfaces only as the model
voicing a juror's bearing from the juror's own (Vault-free) texture — exactly the "hand the model facts
to voice, never scripts to recite" rule. The player's read of *why* a juror is cold stays the human's
to form (ADR 0003 principle: lingering/observation is play; paranoia is theirs). It is justified by the
four fixes: it deepens **memory** (the grudge accumulates and persists, the opposite of the old
context-window thinning) and **fidelity** (the dead jury house comes alive) without leaking, without
sycophancy, and without flattening the open set.

## Acceptance criteria (role-only; HARD rules)

- **The jury house lives:** once jurors exist and the flag is on, sequestered jurors produce hidden
  juror↔juror scenes (multiple natures, not one canned verb) between turns — a *separate* society from
  the (still evictee-excluding) main house. Bounded per juror arrival (one short stretch each, #1932); seed-deterministic.
- **The player is the subject, never the recipient:** jury-house gossip is *about* the player, but no
  jury-house pathway ever terminates at the player during sequester — the player's knowledge is
  unchanged by it (the player is not in the jury house). A sentinel sweep finds no jury-house scene
  content and no grudge number on any player **or admin** projection.
- **Bitterness is contagious and bounded:** a player-betrayed juror's grievance can diffuse to a
  second juror and lower that juror's (hidden) read of the player — confidence-scaled, capped by the
  saturation bound, never runaway. A juror with no pathway to the grievance is unmoved (the omniscience
  ban: a juror's read never reflects a grudge they had no pathway to).
- **Accumulated treatment shifts the final vote (engine-owned):** across seeds, a finalist whose
  goodbyes left a *bitter, well-connected* jury wins **less** than the frozen-at-eviction snapshot
  alone would predict, because the jury house hardened the room; a clean exit holds or improves. The
  shift flows through the **same** `juryLean`/`castJuryVote`/`tallyJuryVote` path — most votes wins,
  last-evicted juror breaks a tie — the LLM never grades it (asserted with a seeded fake narrator).
- **Behavior-only surfacing:** at the finale a soured juror reads colder and a swayed vote lands; the
  player is never shown a lean, a tally before the reveal, a grudge, or a "they're bitter" marker. The
  *why* is the human's to infer.
- **Secret ballots stay sealed:** per-voter attribution still unseals **only** in the 0048
  retrospective; the staged reveal stays anonymized. This feature changes the lean *input*, never the
  reveal timing or anonymity.
- **Calibration-neutral when off:** with `ORWELL_JURY_HOUSE` unset, no draw and no lean change ⇒
  `juryReach` / UAT byte-identical (the gate to merge). When on, a fresh `juryReach`-class run shows the
  EARNED-wins property still holds (good play still converts; the jury house sharpens bitterness and
  rewards clean exits, it never flips the calibrated outcome of good play).
- **Non-degradation:** the grudge accumulates monotonically (bounded) and persists across a restart;
  a game restored mid-jury resumes with the jury house's bitterness intact, never re-rolled.
- **Anti-sycophancy & isolation:** the grudge is engine-computed from sealed state on a seeded
  dedicated rng, never narrated convenience; no number crosses; one user's jury house never bleeds into
  another's (0021).

## Open questions / defaults (resolve at build)

1. **Stretch cadence & size.** *(Resolved by owner ruling 2026-11-02, #1922 / PR #1932: the jury-house stretch runs once per new juror arrival, 1–3 scenes, a fast-forward limbo; the earlier per-tick 1–2-scene default was dropped. Tune against `juryReach`.)*
2. **Grudge-adjustment magnitude & saturation.** The bounded per-juror cap and the diffusion
   transmit/decay. Default: reuse `GOSSIP` transmit/decay; size the adjustment cap *under* `MANNER_LEAN`
   so it deepens (never swamps) the eviction-manner baseline. Calibrate (felt, never deterministic;
   never flattens variance — the 0086 ruling-#1 discipline).
3. **Does the finale "mend" appeal reach a jury-house-hardened grudge?** v1: the finale appeal stays
   exactly as bounded as today (0037) — a strong "mend" can still tip a *close* juror, but a jury house
   that hardened a *lead* is (correctly) hard to undo. A louder "the room turned on you in there" beat
   at the finale is a possible enrichment (deferred).
4. **Player-as-juror (0037/0046).** When the **player** is on the jury, they are in the jury house too
   — but the engine never models the player's *own* grudge (the player forms their own read, ADR 0003 /
   0086 ruling #3). v1: the player-juror still casts their **own** vote (0037); the jury house computes
   only the *NPC* jurors' grudges. The player simply *experiences* the jury house as more in-character
   life around them (a fidelity win), with no engine-set lean of their own.
5. **Show the grudge book at 0048 unsealing?** The retrospective is the sanctioned place to reveal,
   post-game, *who soured and why* (secret ballots are unsealed there anyway). v1 scopes 0100 to the
   hidden mechanic + behavior-only finale surfacing; an 0048 "jury-house grudge book" view is a natural
   sequel (deferred).
6. **Pre-jury evictees.** The first five evictees are pre-jury (0014 §3) and do not vote — they are
   **not** in the jury house and get no grudge society (no vote to color). Confirmed by the existing
   `slice(-9)` jury definition; no change.

## Traceability

`docs/features/0014-jury-and-endgame.md` (the jury & the vote model), `0037-live-jury-vote-choreography.md`
(recorded eviction manner + the engine-legible finale), `0045-endgame-structure.md` (late-eviction
manner), `0038-live-offscreen-society.md` + `docs/decisions/0002-relationship-model.md` (the off-screen
society + gossip pathways this reuses), `docs/decisions/0003-conversation-is-the-game.md` (engine adds
serve the four fixes), `docs/decisions/0005-split-authority-by-openness.md` (the engine tallies, the
model voices); `src/engine/jury.ts` / `juryConstants.ts`, `src/engine/gossip.ts` / `offscreen.ts`,
`src/engine/liveSeason.ts` (`mannerByEvictee` / `edgeAsJuryRel`), `composition/orchestrator.ts`
(`defaultApply`); `CLAUDE.md` (jury management is a real mechanic; secret ballots; the last-evicted
juror breaks a tie). **Tracks #882.**
