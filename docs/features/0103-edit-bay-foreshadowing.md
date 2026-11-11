# 0103 — Edit-bay foreshadowing (the show is telling you something)

> **RETIRED 2026-11-11 (owner ruling, "retire and remove").** This feature is not planned and its unused code and tests are removed (card ORW-267). The text below is history only.

> **Status:** ❄️ **FROZEN** (owner-parked "not planned" 2026-06-27; reaffirmed by the owner 2026-11-03; [`docs/features/README.md`](./README.md) is the authoritative status index). It is **not reopened**. A pure engine core built 2026-07-12 is preserved but unwired (only a test imports it): the pure fit/eligibility/budget/hint core is
> built & unit-green — `src/engine/foreshadow.ts` (`foreshadowFit`, `rankForeshadowCandidates` dropping
> `dormant` + no-public-surface + below-floor, `hintBudget` weekly+season caps, the Vault-safe `buildHint`,
> `leadTimeFromWeeksOut`) + `src/engine/foreshadowConstants.ts`, `tests/unit/foreshadow.test.ts` (12 cases:
> in-motion-only, needs-a-public-observation, cadence caps, the Vault-premise sentinel sweep, determinism).
> GOLDEN-NEUTRAL (the base narrator prompt is untouched — the `editBayHint` context field ships with the
> adapter wiring). **Follow-up lane (LARGE — not yet built):** the `GameSessionAdapter` off-screen-tick wiring
> on a dedicated side-rng behind `ORWELL_FORESHADOW` (byte-identical when off), the read-only `editBayHint`
> `momentPrompts` field, persistence of the cadence counters + hint→pathway link, the 0092/0102 coordination
> (R3), and BDD wiring. *(Previously: ❄️ FROZEN — parked 2026-06-27; #885 closed not planned; a 2026-07-12
> "Everything" sweep built the core, but the freeze stands. Spoiler-adjacent in feel though structurally Vault-safe; see `docs/decisions/PO-DECISIONS-LOG.md`.)* The original proposal follows unchanged.
> Tracks **#885**. This is a *design proposal awaiting decisions*; nothing in the proposal below is wired into the game (only the unwired pure core above exists). It is
> the **anticipation companion** to **0092** (secret-pacing drip — the *payoff* arrives; 0103 plants
> the *foreshadow* that makes the payoff land as "I knew it") and to the **weekly recap 0102** (its
> sibling — the recap looks *back*, 0103 nods *forward*; § "PO review" R3 owns the coordination).
> **Builds on (does NOT duplicate):** **0092** (secret-pacing drip — the ripeness schedule + the
> weekly budget; 0103 reads the *same* in-motion threads and rides the *same* dedicated tick, it adds
> no new schedule), **0060** (story-thread scheduler — the `dormant → active → surfaced → resolved`
> lifecycle; a hint foreshadows a thread that is **already `active`** or a drive/campaign already in
> flight, never a frozen `dormant` one), **0086/0085** (drives & campaigns — an in-motion `target`
> drive / live **Campaign** is the other class of pathway-in-motion a hint can foreshadow), **0049**
> (presence & lingering — the richest hints are *observed in the room*: an NPC lingering with a rival,
> a clipped aside, a meaningful glance, all derivable from `whereabouts()` + co-presence, never
> invented), **0002** (event visibility & pathway propagation — a hint is a Vault-free *observation*,
> surfaced exactly like any witnessed co-presence fact; it carries **no** sealed content), the
> **narration seam** `src/engine/momentPrompts.ts` (where a Vault-safe hint is handed to the model to
> voice — the `mayConfide` sibling pattern). **Bounded by:** mandate #1 (behavioral fidelity — the
> "production edit" is core _BB_ texture), mandate #2 (Vault Wall — a hint NEVER leaks Vault content, to
> player OR admin), mandate #3 (anti-sycophancy — the engine owns whether a hint fires and what it may
> say; a hint is **non-committal** — the seed still decides the outcome, and a hint can deliberately
> mislead), mandate #4 (non-degradation — a fired hint is recorded and persists), ADR **0005** (split
> authority by openness — the engine schedules the closed set; the model voices the open set), ADR
> **0003** (the conversation is the game — a hint is texture in the chat, never a dashboard, never a
> script).

## Why — the gap #885 names

Reality TV has a grammar the game does not yet speak: **the edit.** A real _Big Brother_ episode
constantly *tells you something is coming* before it does — the camera lingers a half-second too long
on two houseguests in a corner, a confessional cuts away mid-sentence, a glance is held. The viewer
learns to read it: *the show is setting something up.* When the move lands a week or two later, it
lands as **"I knew it"** — not because the edit *spoiled* it (it didn't; sometimes the edit is a
**fake-out**), but because the edit made the viewer *lean in*. Anticipation, then a delayed payoff,
is among the most compulsive loops a show has.

Today the game has the *payoff* organs — 0092 drips a relevant secret toward the player, 0085/0086
run campaigns and drives toward a vote — but it has **no foreshadowing layer**. A scheme detonates
with no prior tension; a secret drips with proximity/tension behind it (0092) but no *prior nod* that
made the player watch for it. The single most _television_ beat is missing: the engine occasionally
**telling the player, in the show's own voice, that something is in motion** — a Vault-safe hint that
pays off later — so that when 0092's drip or 0085's campaign lands, it lands on a player who was
*already watching*.

This feature is **not a new disclosure system and not a new schedule.** It adds **no** way for a
secret to cross the Wall (0092/0060/0002 still own every crossing). It is a thin **foreshadowing
layer** that, when a pathway is *already in motion in the hidden layer*, occasionally emits a
**Vault-safe, non-committal hint** ("the cameras keep finding the two of them together"; "an aside you
weren't meant to catch") — the *production edit* — and records it so its later payoff can be felt.

### The retention value: a plant that pays off (variable-ratio, fair)

A foreshadow → delayed payoff is the classic **set-up/pay-off** loop, and — like 0092's drip and
0091's eruptions — it runs on a **variable-ratio** schedule (the most engaging schedule there is). The
player cannot predict *which* week a hint fires or *whether* it pays off straight; they only learn that
**the show nods when something's brewing**, and that a nod is worth watching. Two properties make it
*fair* anticipation rather than a cheap tease:

1. **It foreshadows something genuinely in motion.** A hint is only ever emitted for a pathway the
   hidden layer is *already* running — an `active` 0060 thread, an in-flight 0086 `target` drive, a
   live 0085 `Campaign`. The show is not making a promise it can't keep; it is editing footage of a
   real (hidden) story. So the payoff, when it comes (via 0092's drip, a vote that breaks, a secret
   that surfaces), is honest: *the pieces were there.*
2. **It never commits the engine to the outcome (the fake-out is a feature).** A hint says *something
   is brewing*, never *this is what happens*. The seed still decides: a foreshadowed campaign can
   **fail**; a foreshadowed secret can **stay buried**; a glance can mean nothing. A real edit
   mis-directs all the time — and a hint that can mislead is what keeps the player *reading* the edit
   instead of *trusting* it. (This is mandate #3 working: the engine never bends the outcome to honor
   its own foreshadow — that would be the worst kind of sycophancy.)

The pace is the feature. A hint every week is a spoiler-mill (and reads as the engine narrating its
own machinery); a hint that never fires is invisible. **A variable, bounded cadence — a nod now and
then, weighted toward what the player is circling — is the rhythm that trains the player to watch.**

## The bright line this respects (read first)

At a glance, "the engine drops hints about hidden schemes" sounds like it weakens the Wall. It does
not, and the reason is the whole architecture (§ "The event/visibility model" in `CLAUDE.md`, ADR
0002), the *same* license 0049 (overhearing/observation) and 0092 (pacing) already operate under:

> **A hint surfaces only a Vault-FREE *observation* — a public, in-room thing a houseguest could
> legitimately see — and it carries NO sealed content. It changes nothing in the closed set: it does
> not disclose a secret, does not move a relationship number, and does not commit any outcome. It is
> the production edit pointing the camera, not opening the Vault.**

Five structural facts hold the Wall, none of them prompt wording:

1. **A hint is an *observation*, never a disclosure.** What a hint may surface is exactly the class of
   fact 0049 already lets the player witness: **public presence + behavior** — *who is conspicuously
   together*, *that an aside was cut short*, *that a glance was held*. It is derived from
   `whereabouts()` / co-presence (0049) and the *existence* of an in-motion pathway, **never** from the
   pathway's sealed premise. The hint text contains no secret, no target identity it shouldn't, no
   number, no motive. (Compare 0092: a drip eventually crosses an *anchored belief* about the secret;
   a hint crosses *only that the camera lingered* — strictly less.)
2. **The engine decides whether a hint fires and what it may say.** Whether the show nods, *which*
   in-motion pathway it nods at, and the Vault-safe *shape* of the nod are all engine-computed from
   sealed state + the existing schedule. The model is handed the hint to voice; it never selects a
   pathway, never invents a hint, and never escalates a nod into a statement of fact (the
   `momentPrompts` "never invent biography / never state a fact a lever didn't return" rule already
   forbids the alternative).
3. **A hint never commits the outcome.** The engine emits a hint **without** binding the seed: the
   foreshadowed campaign/secret/vote resolves by its own seeded roll, and a hint may precede a
   **fake-out** (nothing happens) as readily as a payoff. There is no code path where "a hint fired" →
   "therefore the outcome is X." (This is the anti-sycophancy guarantee, made structural — see
   Testability.)
4. **A fired hint is recorded as a player observation (non-degradation, and it enables the payoff
   read).** When a hint fires it is written through the **existing** 0002/0049 observation pathway as a
   *player-witnessed* event (a Vault-free "you noticed …" fact), so it is the player's knowledge,
   persists, and can be *recalled* — which is what later lets a payoff read as "I knew it" (the player
   can be reminded they caught the nod). It mints **no** ground truth about the hidden pathway.
5. **Admin is walled identically.** The foreshadow schedule, which pathway a hint nods at, and the
   hint cadence counter are sealed engine state — never on the God-Mode/admin surface (the
   dependency-cruiser default-deny forbids any outward import of `VaultStore`/`SoulProvider`; the layer
   lives behind it). The admin "secret-free" guarantee stays literally true.

A hint is therefore the **anticipation companion** to 0092 (the payoff): 0092 paces *which sealed
secret edges toward the player and when*; 0103 occasionally *nods that something is brewing* using only
public observation, and then **gets out of the way** — the actual payoff (a drip, a vote, a surfaced
belief) is owned by the organs that already preserve the Wall.

## The mechanic

### 1. What is *in motion* — the only thing a hint may foreshadow (engine-owned, sealed)

A hint is eligible **only** for a pathway the hidden layer is *already running*. The foreshadow layer
reads the *existence and shape* of these in-motion pathways (never their sealed content):

| In-motion pathway | Already owned by | What a hint may nod at (Vault-FREE) |
|---|---|---|
| an **`active`** story thread whose source is in the house | 0060 | "the cameras keep finding \<source\> off on their own" — presence/behavior only, **never** the premise |
| an in-flight **`target`** drive / live **`Campaign`** | 0086 / 0085 | "\<owner\> and \<an ally\> keep ending up in a corner" — conspicuous co-presence (already 0077-surfaceable), **never** the target/plan |
| a **0092-ripe** secret about someone the player is circling | 0092 | the *anticipation* nod for a drip the schedule has marked ripe — "something around \<source\> feels like it's building" — **never** the secret |

- **`active`/in-flight is mandatory.** A `dormant` thread (frozen, nothing happening) is **never**
  foreshadowed — there is nothing in motion to edit footage of. This is what makes a hint honest: the
  show only nods at a real (hidden) story already underway. (0060 owns the `dormant → active`
  transition; 0103 reads the result, it never advances a thread.)
- **The hint reads only *position + the fact of motion*.** Like 0060's `triggerCondition` predicates,
  the foreshadow eligibility reads Vault-free *position* facts (who is conspicuously co-present via
  0049/0077, that a thread is `active`, that a campaign is live) — **never** the premise, target, or
  plan. A predicate is a gate on *when the world is ripe to nod*, never a content channel.

### 2. Relevance — the show edits toward what the player is circling (engine-owned, sealed)

For each in-motion pathway, the layer computes a sealed `foreshadowFit(pathway → player) ∈ [0,1]` —
*how worth nodding at, for THIS player, now* — from signals that **already exist** (no new hidden
authoring; this mirrors 0092's `ripeness`):

```
foreshadowFit(pathway, player) =
      relevance(pathway, player)     // proximity + tension to the people involved (0026 edges, both ways)
    + observability(pathway)         // is there a PUBLIC observation to hang the hint on? (0049 co-presence / 0077 conspicuousness)
    + leadTime(pathway)              // a pathway 1-2 weeks from its likely payoff edits best (not just-fired, not stale)
    − alreadyHintedPenalty(pathway)  // a pathway already foreshadowed is far less eligible (no nag)
```

- **`relevance`** reuses 0092's proximity + tension reads (the 0026 edges both ways): the show edits
  toward the people the player is close to or wary of — so a nod about a *doubted rival* or a *trusted
  ally* lands, and the eventual payoff reads as "I knew it," not "who?".
- **`observability`** requires a *public* thing to hang the hint on (0049 co-presence / 0077
  conspicuousness): the edit shows *footage*, so a hint needs a real in-room observation to point the
  camera at. A purely off-screen scheme with no public surface yet is **not** foreshadowable (there is
  nothing to edit) — which is also why a hint never has to invent an observation.
- **`leadTime`** favors a pathway *building toward* a likely payoff in the next week or two (reusing
  the thread's `active` age / a campaign's `horizon` / 0092's ripeness) over one that just resolved or
  one that's gone stale — so the foreshadow and its payoff are *correlated in time*, the whole point of
  a plant.
- **`alreadyHintedPenalty`** reads a persisted per-pathway `lastHintedWeek` so the show does not nag
  the same setup; the edit moves on.

`foreshadowFit` is **never shown** (anti-sycophancy / Vault). It only **ranks** which in-motion pathway
the show nods at. All magnitudes live in one tunable `FORESHADOW` constants module (the
`THREAD`/`GOSSIP`/`SECRET_PACING` sibling; the B59 grep gate covers it).

### 3. The cadence — a nod now and then, never every week (the heart of the feature)

The pacing is a **variable-ratio budget**, not a per-tick certainty (see § "PO review" R2):

- **`hintsPerSeason` is scarce, with a per-week ceiling.** A target band (`FORESHADOW.weeklyTarget ≈
  0–1`, a hard `maxHintsPerWeek` default 1) and a season cap (`maxHintsPerSeason`, the 0060/0092
  sparseness sibling). Most weeks get **zero or one** nod; a quiet week is a feature (the edit is not
  always nodding — that's what makes a nod *mean* something).
- **Variable ratio, not fixed.** Per eligible tick, on the top-`foreshadowFit` candidate, the layer
  rolls a single bounded, seeded eligibility check (`FORESHADOW.hintEligibilityRate`) — so the player
  cannot predict the cadence, only that the show *does* nod. On a miss, nothing surfaces.
- **Budget is independent of 0092's drip budget** (they pace different things — anticipation vs.
  payoff) but **coordinated** so a hint and its drip don't fire in the same beat (a nod *then* a wait
  *then* the payoff is the loop; see § "PO review" R3 for the exact coordination with 0092 + 0102).

### 4. Triggering — anchored to an observation, **never a cold pop-up**

A hint is never a free-floating scheduler pop. It is selected on the **existing bounded off-screen
tick** (the same tick 0060/0092 ride in `src/composition/orchestrator.ts`) and it only ever surfaces
through the **existing** 0049/0002 observation pathway, anchored to a real public co-presence fact:

- **Per tick**, if the weekly hint budget is not spent, the layer ranks eligible in-motion pathways by
  `foreshadowFit`, rolls the eligibility check on the top candidate, and on a pass **hands a Vault-safe
  hint to the narrator** via `momentPrompts` (the `mayConfide` sibling: a small, read-only
  `editBayHint` field — *the public observation + a "this is building" tone*, never a secret, never a
  number) **and** records the player's observation through the **unchanged** 0049/0002 path (a "you
  noticed the cameras keep finding them together" witnessed event).
- **The hint hangs on a live observation.** A presence hint requires the player to actually be around
  to catch the co-presence (the 0049 path); a "building" hint about a 0092-ripe secret is the
  anticipation nod the drip schedule already marked — so the player experiences the nod *in the room*,
  not as a pop-up.

> **The no-cold-open guarantee is structural and inherited:** the layer rides the same bounded tick
> 0060/0092 do and surfaces through the same anchored 0049/0002 observation pathway; there is **no**
> scheduler path that *starts a scene* to deliver a hint. The off-screen society keeps running
> untouched; this layer only **occasionally points the camera** at something already happening in the
> room.

### 5. The payoff link — what makes it "I knew it" (recorded, never committal)

A hint is recorded as a player observation (§ bright line #4) and tagged with the **id of the in-motion
pathway it foreshadowed** (engine-side only). This enables a *Vault-safe payoff read* — **without ever
committing the outcome**:

- When the foreshadowed pathway **does** pay off later (0092 drips its secret, the campaign's vote
  breaks, the thread surfaces), the existing payoff organ may note (Vault-safely) that *the player had
  caught the earlier nod* — letting the narrator land the "I knew it" beat from the player's own
  recorded observation. The engine does **not** force the payoff; it only *links* a hint to its pathway
  so a payoff that *does* happen can reference the nod.
- When the foreshadowed pathway **fizzles** (the fake-out — the campaign fails, the secret stays
  buried), nothing is owed: the nod was a real edit of a real (hidden) story that simply didn't go the
  way the edit implied. The player learns the edit can mislead — exactly the property that keeps the
  hint compulsive (§ retention value #2). No "correction," no apology, no record cleanup.

### 6. Where it runs — the bounded per-turn tick, calibration-neutral

The foreshadow pass is **one function called once per bounded off-screen tick**, **after** 0060/0092's
passes (so it reads the freshly-moved house and the freshly-marked-ripe threads) and **before** the
narration assembles. It runs on a **dedicated side rng inside the session** (hashed off
`seed:foreshadow:<tick>`), exactly the pattern 0060's scheduler / `whisperPairings` / 0092 use, so it
never perturbs the seeded society/vote/jury stream.

> **The foreshadow layer MUST NOT perturb any seeded competition, vote, or jury outcome, and MUST NOT
> commit any pathway's resolution.** It draws only on its own dedicated rng; the only things it changes
> are *which Vault-safe observation the narrator is offered* and *whether the weekly hint budget allows
> it* — it folds **no** relationship weight and advances **no** thread/campaign. With the feature
> **off** (an `ORWELL_FORESHADOW` flag, sibling to `ORWELL_CAMPAIGNS`/`ORWELL_SECRET_PACING`), **zero
> foreshadow draws happen and the rest of the engine behaves exactly as today** ⇒ the `juryReach` / UAT
> / gradient calibration gates are **byte-identical**. This is the load-bearing determinism guarantee.
> (Default-off until the cadence is tuned against the UAT — same posture as 0092/0085/0086.)

## Engine seams (where this lands)

- `src/engine/foreshadow.ts` *(new)* — pure: `foreshadowFit(pathway, player, reads)`, the
  in-motion-pathway eligibility (reads only the *existence/shape* of 0060 `active` threads / 0086 drives
  / 0085 campaigns / 0092 ripe marks, all handed in), and the **hint builder** that assembles a
  Vault-safe observation hint from a public co-presence fact (0049) + a "building" tone — **no I/O, no
  Vault handle, no secret string, no number**. It is handed already-read Vault-free signals.
- `src/engine/foreshadowConstants.ts` *(new)* — the single `FORESHADOW` tunable (the fit weights, the
  variable-ratio `hintEligibilityRate`, `maxHintsPerWeek`/`maxHintsPerSeason`, the lead-time window,
  the already-hinted penalty). The `THREAD`/`GOSSIP`/`SECRET_PACING` sibling.
- `GameSessionAdapter` — runs the pass on the dedicated session rng in the bounded tick (after
  0060/0092), exposes the sealed reads it needs (the in-motion pathway set, the 0049 co-presence facts,
  the both-way 0026 edges), records a fired hint as a **player observation** through the **existing**
  0049/0002 path (no new crossing), persists the per-week hint counter + per-pathway `lastHintedWeek` +
  the hint→pathway link in the snapshot, and **never** writes a hint, fit score, or counter to any
  projection.
- `src/engine/momentPrompts.ts` — a small, read-only, Vault-safe **`editBayHint`** field on the
  narration context (the `mayConfide` sibling: the public observation + the "this is building" tone
  word, **no** secret, **no** number, **no** committed outcome). The manifest note: voice the edit as
  texture (the cameras lingered; an aside cut short), **never** state what it means, **never** invent
  the scheme, **never** promise an outcome — the show *nods*, it does not *spoil*.
- This is a **scheduling/observation change over existing organs (0060/0092/0049), not a new FE-driven
  write-back** — so it is **not** the four-place MCP write-back gotcha. No new player tool, no new MCP
  dispatch case; the hint reaches the narrator via the existing `momentPrompts` context and the
  observation crosses via the existing 0049/0002 pathway.

## Engine-owned schedule vs. model-narrated edit (ADR 0005)

Authority splits by **openness**, exactly as ADR 0005 requires:

- **Closed set (engine-dictated, no dynamism to lose):** *whether* the show nods, *which* in-motion
  pathway it nods at, *whether* the seeded eligibility roll passes, the weekly/season budget, and the
  hint→pathway link. All sealed + seeded. The model moves none of it — and critically, the hint **does
  not move the closed set at all** (no fold, no outcome commitment), so it sits even further on the safe
  side of the line than 0092 (which does eventually cross a belief).
- **Open set (model-narrated, never normalized):** the *texture* of the edit — how the narrator phrases
  the lingering camera, the clipped aside, the held glance; how it weaves the "something's building"
  unease into the scene. The engine hands a Vault-safe observation + tone; the model voices it richly.
  Nothing the model writes feeds back into the closed schedule (the `expressiveNonCollapse` contract
  holds — no creative prose is collapsed into a bucket that changes what can be played next).

The foreshadow is a **pure scheduling/observation decision over the closed set**; it never interprets
the player's open-ended words into a bucket, so it sits cleanly on ADR 0005's correct side of the line.

## ADR 0003 fit (the conversation is the game)

This adds **no dashboard and no new UI** — a hint arrives in the chat as texture (a lingering camera, a
clipped aside, a held glance), the same surface every observation already uses (0049). It deepens the
*conversation*: the player catches the show's nod in-scene, leans in, watches, and forms their own read
— paranoia and anticipation stay the human's to feel (0017/0020). It is the engine doing exactly its
job under ADR 0003 — fixing a degradation (rich in-motion schemes detonated with **no prior tension**,
and the old chat-only game would have had the LLM *spontaneously decide* to foreshadow, ungrounded and
committal — promising a payoff the seed never agreed to) and otherwise getting out of the model's way
(hand it a Vault-safe observation to voice, never a script). Long-term memory is the store recalled,
never the chat remembered: a fired hint is a durable recorded 0002 observation, so a fresh context
window loses none of the nods the player caught — which is exactly what lets a later payoff land as
"I knew it."

## Persistence (0007/0030 — non-degradation)

- The **per-week hint counter**, each **per-pathway `lastHintedWeek`**, and the **hint→pathway link**
  persist in the snapshot (siblings to 0060's `surfacedThreadCount` / 0092's drip counter / 0075's
  lie-count) — the cadence and the payoff-read survive a restart and never reset.
- A fired hint is an ordinary recorded 0049/0002 **player observation** — already durable; it
  **deepens** the player's knowledge (the nods they caught), never thins.
- A pathway that was **foreshadowed but fizzled** keeps its recorded hint (the edit happened; the
  fake-out is part of the season's texture) — never cleaned up, never "corrected" (non-degradation).

## Testability (role-only; HARD rules)

- **Vault Wall (the load-bearing test):** the foreshadow schedule, `foreshadowFit`, the hint counter,
  and the hint→pathway link never appear on `editBayHint`, `npcVoice`, any player projection, **or the
  admin/God-Mode surface** — a sentinel planted in every in-motion pathway's premise/target/plan never
  appears in the assembled prompt + `editBayHint` + every surface, before *and after* a hint fires. What
  crosses is the public observation only, never the premise.
- **A hint foreshadows only an IN-MOTION pathway:** a hint fires only for an `active` thread / in-flight
  drive / live campaign / 0092-ripe secret — never a `dormant`, never-started pathway (asserted: with no
  in-motion pathway, no hint is eligible; a `dormant` thread is never foreshadowed).
- **A hint NEVER commits the outcome (the fake-out, anti-sycophancy):** a foreshadowed campaign can
  still fail its seeded vote; a foreshadowed secret can stay buried; a hint emits **zero** fold and
  advances **zero** thread/campaign — asserted structurally (the seeded outcome stream is byte-identical
  whether or not a hint fired for that pathway), and over seeds a measurable share of fired hints are
  **fake-outs** (the edit mis-directs, by design).
- **Cadence is bounded and variable:** over a seeded week the count of hints never exceeds
  `maxHintsPerWeek`; over a season never exceeds `maxHintsPerSeason`; and the cadence is variable-ratio
  (not a fixed every-N-weeks) — asserted as a distribution property over seeds.
- **Relevance / observability:** of the pathways foreshadowed, a measurable share involve people the
  player has a strong bond *or* high tension with, and **every** fired hint hangs on a real public
  observation (a 0049 co-presence / 0077 conspicuousness fact) — no hint without an observation to edit;
  a pathway with no public surface is never foreshadowed (richness threshold over seeds, the 0092/0060
  style).
- **No cold open:** a hint rides the bounded tick and surfaces through an anchored 0049/0002 observation
  pathway; no free-floating scheduler *starts a scene* to deliver a hint; a presence hint requires the
  player to be around to catch the co-presence.
- **The payoff read is Vault-safe and optional:** a later payoff may reference the player's recorded nod
  ("I knew it") from the player's own observation — but the link carries no sealed content, and a fizzled
  pathway leaves the nod recorded with no correction (non-degradation; no record cleanup).
- **No re-nag:** a pathway already foreshadowed (its `lastHintedWeek` set) drops in eligibility and is
  not foreshadowed again immediately — the edit moves on.
- **Anti-sycophancy:** the model never selects which pathway is hinted and never invents a hint or a
  payoff; `foreshadowFit` + the budget are engine-computed; a hint never fires *more* generously to
  please the player, and the engine never bends an outcome to honor its own foreshadow.
- **Determinism + calibration-neutral:** same seed + same history ⇒ same hints + same weeks; and with
  `ORWELL_FORESHADOW` off, **zero foreshadow draws** ⇒ the rest of the engine behaves exactly as today
  and `juryReach` / UAT / gradient are byte-identical (no comp/vote/jury outcome perturbed, no thread
  advanced, no fold applied).
- **Durable cadence:** the per-week counter + per-pathway `lastHintedWeek` + the hint→pathway link
  survive a save round-trip (the cadence resumes, never resets).

## PO review — owner rulings needed (before build)

This spec is deliberately a **proposal**, the **anticipation companion to 0092** (payoff) and the
**sibling of the weekly recap 0102**. Three decisions shape the build and want an owner ruling first.
**Recommendation up front:** spec/build 0103 **after 0092 lands** (it reads 0092's ripeness schedule
and pairs with its budget) and **coordinate its cadence with 0102's weekly recap** so the *nod → wait →
payoff → recap* loop reads as one rhythm, not three competing notifications.

- **R1 — The PRODUCTION VOICE: what may a hint reveal, and how non-committal must it be?** A hint must
  **foreshadow a pathway already in motion** in the hidden layer (an `active` thread / in-flight drive /
  live campaign / 0092-ripe secret), must surface **only a Vault-free public observation** (a lingering
  camera, a clipped aside, a held glance — derived from 0049/0077, **never** the sealed premise, target,
  or plan, **never** a number), and must **never commit the engine to an outcome** (the seed still
  decides; a hint can be a fake-out). *Recommendation:* adopt all three as **hard structural bounds**
  (each pinned by a test above): (a) **in-motion-only** — a `dormant` pathway is never foreshadowed; (b)
  **observation-only** — the hint hangs on a real public co-presence fact and carries no sealed content
  (the load-bearing Vault test); (c) **non-committal** — the hint folds nothing and advances nothing,
  the seeded outcome is byte-identical whether or not a hint fired, and a measurable share of hints are
  **deliberate fake-outs** (the edit mis-directs, by design — this is the anti-sycophancy guarantee and
  the thing that keeps the player *reading* the edit). The production voice is **suggestive, never
  declarative**: the show *nods* ("the cameras keep finding the two of them together"), it never *states*
  ("they're plotting against you"). Confirm the voice register (recommend: ambient, the 0049
  presence-strip "the edit" texture — never the narrator breaking the fourth wall to announce
  machinery).

- **R2 — Cadence / rate (variable-ratio, not every week).** How often should the show nod?
  *Recommendation:* a **scarce, variable-ratio** cadence — `weeklyTarget ≈ 0–1`, `maxHintsPerWeek = 1`,
  a season cap (`maxHintsPerSeason`, the 0060/0092 sparseness sibling, start ≈ 4–6), and a modest
  `hintEligibilityRate` so most weeks get **zero or one** nod and the player can't predict which. A
  quiet week is a feature (a nod *means* something only because the edit isn't always nodding); a
  firehose of "something's coming!" is the L40 over-surfacing lesson and reads as the engine narrating
  itself. Tune the exact band against the UAT (felt, never deterministic). Confirm the season cap and
  whether it is **shared** with 0092's surfaced-to-player cap or **independent** (recommend:
  **independent** — a nod is strictly less than a crossing, so it shouldn't spend the scarce
  *disclosure* budget; but cap each so the two together never feel like spam).

- **R3 — Coordination with 0092 (pacing) AND the weekly recap 0102 (its companion).** The three form one
  loop — **0103 nods forward, 0092 pays off, 0102 looks back** — and must not collide or double-notify.
  *Recommendation:* (a) **with 0092:** a hint and its drip must **not** fire in the same beat — the loop
  is *nod → wait (≥ a beat or two of lead time) → payoff*; the foreshadow `leadTime` term already
  prefers a pathway 1-2 weeks from its likely drip, so sequence the two passes (foreshadow reads 0092's
  ripe marks, then suppresses a hint on a pathway about to drip this very tick), and when a 0092 drip
  lands on a pathway the player was nodded at, let the drip's surface reference the recorded nod (the
  "I knew it" payoff). (b) **with 0102:** the weekly recap should be able to *fold in* a fired hint as a
  "what to watch" forward-nod (the recap's natural place for foreshadowing) and *close the loop* when a
  prior week's nod paid off ("remember the corner conversation? …") — so confirm whether 0103 **emits
  through 0102's recap surface** (one weekly forward-nod, cleaner cadence), **in-scene** via
  `editBayHint` (more immediate, the lingering-camera-in-the-room feel), **or both** (recommend:
  **both**, with the recap carrying the explicit "what to watch" framing and the in-scene `editBayHint`
  carrying the ambient texture — but gate them off **one** shared hint budget so they never
  double-count). This ruling determines whether 0103 ships **alongside 0102** (recommended if "both") or
  stands alone.

## Open questions / defaults (resolve at build)

1. **Default cadence band** (pending R2): `weeklyTarget = 1`, `maxHintsPerWeek = 1`,
   `maxHintsPerSeason ≈ 4–6`, a modest `hintEligibilityRate`, tuned against the UAT.
2. **Fake-out rate.** What share of hints should be deliberate mis-directs vs. honest set-ups? A real
   edit mis-directs *often*; too many fake-outs trains the player to ignore the edit. Start balanced
   (the edit is *usually* onto something, but not always), tune against playtest feel — and it is partly
   emergent anyway (a foreshadowed campaign that loses its seeded vote is a fake-out for free).
3. **Hint surface (pending R3):** in-scene `editBayHint` only, the 0102 recap only, or both off one
   shared budget. Recommend both, gated off one budget.
4. **Lead-time window.** The exact `leadTime` band (how many weeks before a likely payoff a hint edits
   best). Start 1-2 weeks; tune so the nod and payoff feel *correlated*, not coincidental.
5. **Pathway classes to foreshadow.** v1 covers `active` threads (0060), `target` drives / campaigns
   (0086/0085), and 0092-ripe secrets. A later phase could foreshadow other in-motion pathways (a
   brewing deal 0039, a fracturing bloc 0043) — held out of scope to keep v1 thin; each addition must
   keep the hint an **observation** gate, never a content channel.
6. **A louder "called it" payoff beat.** v1 lets a payoff *reference* the recorded nod. A more explicit
   "you saw this coming" framing (the set-up/pay-off loop made legible) is a possible enrichment — flag
   for product before building, and keep it observation-level, never a number and never committal.

> **Tracks #885.**
