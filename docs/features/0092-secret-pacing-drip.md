# 0092 — Secret-pacing drip (the paced "I knew it" payoff)

> **Status:** ✅ **BUILT (2026-06-27).** `src/engine/secretPacing.ts` + `secretPacingConstants.ts` (the
> pure pacing core + the `SECRET_PACING` tunable), `GameSessionAdapter.pacingDrip` (the pass, run before
> 0060's surface decision in the bounded tick; routes a ripe top candidate into 0060's existing anchored
> `surfaceThread` via the new `force` channel), the per-week drip counter + per-thread `lastDrippedWeek`
> persisted in the snapshot, the dedicated `ORWELL_SECRET_PACING` flag (default ON, `=0` opts out, calibration-neutral).
> Gated by `tests/unit/secretPacing.test.ts` (ripeness/budget/routing/Vault-sentinel) +
> `tests/unit/secretPacingNeutral.test.ts` (the load-bearing recording-rng byte-identity gate) + BDD
> `0092-secret-pacing-drip.feature` (wired in `cucumber.cjs`).
> **Tracks #861.**
> **Depends on:** 0001 (Vault Wall), 0002 (event visibility & **pathway propagation** —
> `surfaceInformationTo` with content-lineage anchoring; the only way a sealed fact legitimately
> becomes player knowledge), 0038 (off-screen society + `gossip.ts` `diffuseGossip` — the chains
> a drip rides), 0058 (deep profiles — where the richest sealed secrets are authored), 0026
> (relationship math — the **proximity + tension** reads the pacing schedules on), 0060 (the
> story-thread scheduler — the per-tick `dormant → active → surfaced` walk this **paces**, not
> replaces). **Sibling of** 0075 (trust-gated confidences — a houseguest *deliberately telling* the
> player is one of the in-game pathways a drip can terminate on; 0092 schedules *which* secret is
> ripe, 0075 owns the *act* of telling). **Bounded by:** mandate #1 (behavioral fidelity — the paced
> reveal is the social texture), mandate #2 (Vault Wall — a drip surfaces ONLY through a modeled
> pathway, never a Vault read by player OR admin), mandate #3 (anti-sycophancy — the engine owns the
> schedule + the seeded eligibility roll; the model never decides which secret drips and never invents
> one), mandate #4 (non-degradation — a dripped fact is a durable recorded belief that deepens, never
> thins, and an un-dripped secret is retained in the Vault forever).

## Why (the gap #861 names)

Trace the hidden layer of a real season and most sealed secrets share one status: **`(never
surfaced)`**. (`src/domain/humanize.ts:127` literally renders a `dormant` thread that way in the
post-season unsealing; `deepProfile.ts` `threadStatusClause` reads "never surfaced" for the same.)
The cast is born deep — 3–6 `hiddenElements` each (0058 authors the richest), each a sealed
`StoryThread` — but the **surfacing odds are flat and thin**. 0060's per-tick scheduler rolls a flat
`surfaceProb` (0.15) and, of a surfacing, a flat `surfaceToPlayerProb` (0.4) against a season cap
(`maxSurfacedPerSeason` 6), with **no preference for which secret or whose**. The result is that the
secrets that reach the player are effectively *random* — and any individual rich backstory is still
unlikely to ever land.

So the single most satisfying _Big Brother_ information beat barely exists: the slow build where a
secret about **someone the player has been circling** — an ally they're close to, a rival they're at
odds with — finally edges into the open *for them*, at a pace that lets the dread accumulate, landing
as **"I knew it."** Today a secret either pops as a vague rumor (no build, no relevance) or stays
buried forever (no payoff). What's missing is a **schedule**: a paced, relationship-aware policy that
makes ~1–2 secrets per week *eligible* to drift toward this particular player — about the people who
matter to this player's game — through the **pathways that already exist**.

This feature is **not a new disclosure system.** It adds **no** new way for a secret to cross the
Wall. It is a thin **pacing + eligibility layer** that biases *which* dormant threads 0060 surfaces
toward the player, and *how fast*, so the existing organs (overhear, a 0075 confidant's slip, a
gossip chain terminating at the player) deliver a **paced, earned, relevant** stream instead of a
flat trickle.

### The retention value: a variable-ratio reveal you could have foreseen

A paced secret-drip is a **variable-ratio reinforcement** schedule — the most engaging schedule
there is (the same contract 0091 names for eruptions). The player cannot predict *which* week a
given secret lands, only that the people they're close to and the people they're fighting carry
things, and that the house keeps *almost* letting one slip. The payoff (a secret about someone
relevant clicking into place) arrives on an unpredictable cadence. Crucially it is a **fair**
surprise: the drip is anchored to **proximity + tension the player can feel** — you've been tight
with this person, or wary of that one — so when the secret lands the honest reaction is *"I knew
something was off"*, not *"that came from nowhere."* That is the difference between a **plant that
pays off** and a cheap reveal — and it is exactly ADR 0003's "earned and anchored, never a cold
pop-up," now applied to the **pacing** of information, not just its content.

The pace itself is the feature. A flat firehose of secrets is noise (the L40 lesson); a flat trickle
is forgettable. **~1–2 ripe-toward-the-player per week** — bounded, seeded, relationship-weighted —
is the rhythm that makes each one register.

## The bright line this respects (read first)

At a glance, "deliberately schedule secrets toward the player" sounds like it weakens the Wall. It
does not, and the reason is the whole architecture (§ "The event/visibility model" in `CLAUDE.md`,
ADR 0002), the *same* license 0060 and 0075 already operate under:

> **A drip changes only *eligibility and pacing* in the hidden layer. A secret still becomes the
> player's knowledge ONLY when a modeled in-game pathway actually terminates at them** — an overhear,
> a confidant telling them, a gossip chain reaching them. The scheduler never hands the player (or
> admin) a secret directly and never reads the Vault to a surface.

Four structural facts hold the Wall, none of them prompt wording:

1. **The drip is a hidden-layer scheduler, not a channel.** `secretPacing` runs entirely inside the
   engine adapter, reads only sealed state, and its **output is a re-weighting of 0060's existing
   surface decision** — *which* dormant thread is most ripe to push toward the player this tick, and
   *whether the weekly drip budget allows it*. It emits **nothing to any projection**. It cannot
   leak what it never writes outward.
2. **Crossing is still pathway-only, still content-lineage-anchored.** When the schedule picks a
   ripe secret, the actual surfacing goes through the **unchanged** 0002 / 0038 / 0075 organs:
   `diffuseGossip` along the affinity graph (a chain *may* reach the player), or
   `surfaceInformationTo` with a paraphrase that is a genuine **fragment of real content** (E9/C2/C3),
   or — when the player is pressing a 0075 confidant — the existing `confide` lever. An unanchored
   attempt is still downgraded to a *suspicion* (never knowledge). The drip selects; it never mints
   ground truth.
3. **What crosses is a belief, never the premise.** Exactly as today: the player ends with a
   **paraphrased belief held with source + confidence** (possibly gossip-drifted), never the verbatim
   sealed premise and never a fact-on-a-projection. The 0031 leak sweep stays strict about exact
   strings — the drip adds no new string that crosses.
4. **Admin is walled identically.** The pacing schedule, the per-secret ripeness, and the weekly
   drip budget are sealed engine state — never on the God-Mode/admin surface (the dependency-cruiser
   default-deny forbids any outward import of `VaultStore`/`SoulProvider`; the drip lives behind it).
   The admin "secret-free" guarantee stays literally true.

A drip is therefore the **pacing companion** to 0060 (which owns the *lifecycle*) and 0075 (which
owns the *deliberate telling*): 0092 decides **which sealed secret is ripe to edge toward THIS player,
and at what cadence** — and then hands the actual crossing to the organs that already preserve the
Wall.

## The mechanic

### 1. Ripeness — relationship proximity × tension (engine-owned, sealed)

For each `active` (or activate-eligible) story thread whose **source** is still in the house, the
scheduler computes a sealed `ripeness(thread → player) ∈ [0,1]` — *how ready this secret is to edge
toward this player now* — from signals that **already exist** (no new hidden authoring):

```
ripeness(thread, player) =
      proximity(source, player)        // closeness — the player is in this person's orbit
    + tension(source, player)          // friction — the player is circling / clashing with them
    + recency(thread)                  // a freshly-active thread is hotter than a stale one
    − alreadyToldPenalty(thread)       // a secret already dripped is far less ripe (no spam)
```

- **`proximity(source → player)`** reads the **0026 relationship edges both ways**: a strong mutual
  bond (the player ↔ source trust + affinity) means the player is *around* this person enough for a
  secret to plausibly reach them (a confidant slips, a close ally lets something show). This is the
  channel a 0075 confidence rides.
- **`tension(source → player)`** reads the *friction* edges: high `threat`/low `affinity` in either
  direction — the player is **suspicious of** this person, or this person is **wary of** the player.
  A secret about a rival you're already side-eyeing is the most satisfying one to catch (the "I knew
  it" lands hardest on someone you doubted). This channel rides **gossip** (a third party, sensing
  the friction, brings the player something).
- **`recency(thread)`** favors freshly-activated threads over ones that have simmered for weeks
  (a hot secret is more likely to slip than an old one) — reuses the thread's `active` age 0060
  already tracks.
- **`alreadyToldPenalty`** reads the **monotonic `disclosedToPlayer` state 0075 already persists**
  (`none`/`partial`/`full`) and 0060's `surfaced` flag, so a secret the player has already caught
  wind of is far less ripe — the drip moves *on*, it never re-spams the same reveal.

`ripeness` is **never shown** (anti-sycophancy / Vault). It only **re-ranks** which thread 0060
considers for surface-to-player; the *crossing odds and content* stay 0060/0002's. All magnitudes
live in one tunable `SECRET_PACING` constants module (the `THREAD`/`GOSSIP`/`CONFIDENCE` sibling; the
B59 grep gate covers it).

### 2. The weekly drip budget — the pace (the heart of the feature)

The pacing is a **per-week budget**, not a per-tick probability. The scheduler maintains a sealed,
per-week counter and a target band:

- **`dripsPerWeek` target ≈ 1–2** (`SECRET_PACING.weeklyTargetMin`/`Max`). Across a week, the
  scheduler aims to let **one or two** ripe secrets edge toward the player — no more (a firehose is
  noise), and it tolerates a quiet week (not every week must drip; sometimes the house keeps its
  secrets, which is itself realistic and makes the next reveal land harder).
- **A hard weekly ceiling** (`maxDripsPerWeek`, default 2) — once spent, **no further secret edges
  toward the player this week**, however ripe. Surplus ripe threads still do their normal 0060
  off-screen NPC↔NPC surfacing/resolution; only the *player-bound* channel is paced. This is the
  direct analogue of 0060's `maxSurfacedPerSeason` and 0059's "≤2 ties / ≤2 showmances" sparseness —
  applied as a *cadence* (per week) rather than a season total.
- **The season cap still binds.** The drip budget is a **rate limiter layered under** 0060's
  `maxSurfacedPerSeason`: a drip counts against the season cap exactly like any other surface-to-
  player. The weekly budget can never push the season total past 0060's ceiling — it only **shapes
  the distribution** of those scarce reveals into a satisfying *pace* (spread across weeks, weighted
  toward relevant people) instead of a flat random scatter.

So the weekly counter is what turns "a few secrets reach the player per season, at random" into
"about one a week, about people you care about" — the same scarce payoff, *paced*.

### 3. Triggering — paced, anchored, **never a cold pop-up**

A drip is never a free-floating scheduler pop. It is selected on the **existing bounded off-screen
tick** (the same tick 0060's scheduler, `whisperPairings`, `campaignTick`, and the day event already
ride in `src/composition/orchestrator.ts`), and it only ever surfaces through a pathway anchored to a
real source:

- **Per tick**, if the **weekly drip budget is not spent**, the scheduler ranks the ripe player-bound
  threads by `ripeness` and rolls a single bounded, seeded eligibility check on the top candidate
  (`SECRET_PACING.dripEligibilityRate`). On a pass, it **hands that thread to 0060's existing
  surface-to-player path** — which crosses it via gossip-chain / `surfaceInformationTo` / a confidant
  slip exactly as today. On a miss, nothing crosses (the secret stays ripe for a later tick this
  week, or rolls over).
- **Proximity-ripe secrets prefer the confidant channel** (a close source is more likely to *tell*
  the player — routing through the 0075 path when the player is in a scene with them); **tension-ripe
  secrets prefer the gossip channel** (a third party brings it). Either way the crossing is the
  unchanged anchored organ — the drip only **chooses and paces**, it never authors the line.

> **The no-cold-open guarantee is structural and inherited:** the drip rides the same bounded tick
> 0060 does and crosses through the same anchored pathways; there is no scheduler path that *starts a
> scene* to deliver a secret. A proximity drip surfaces only if the player is actually around that
> source (the 0075 path requires a live scene); a tension drip arrives as ordinary gossip. The player
> experiences a paced, relevant *stream of belief*, never a pop-up.

### 4. Where it runs — the bounded per-turn tick, calibration-neutral

The pacing pass is **one function called once per bounded off-screen tick**, **before** 0060's
surface-to-player decision (it *re-weights* and *gates* that decision; it adds no second loop, no new
clock). It runs on a **dedicated side rng inside the session** (hashed off
`seed:secret-pacing:<tick>`), exactly the pattern 0060's scheduler and `whisperPairings` use, so it
never perturbs the seeded society/vote/jury stream.

> **The drip MUST NOT perturb any seeded competition, vote, or jury outcome.** It draws only on its
> own dedicated rng; the only thing it changes is *which already-Wall-safe surface* 0060 picks and
> *whether the weekly budget allows it*. With the feature **off** (an `ORWELL_SECRET_PACING` flag,
> sibling to `ORWELL_CAMPAIGNS`/`ORWELL_TRIGGERS`), **zero pacing draws happen and 0060 behaves
> exactly as today** ⇒ the `juryReach` / UAT / gradient calibration gates are **byte-identical**.
> This is the load-bearing determinism guarantee. (Default-off until the cadence is tuned against the
> UAT; promotable to default-on once the band is calibrated, like 0060's own posture.)

## Engine seams (where this lands)

- `src/engine/secretPacing.ts` *(new)* — pure: `ripeness(thread, relReads, recency, alreadyTold)`
  (the proximity + tension + recency − already-told score), `rankPlayerBoundThreads(threads, ...)`
  (seed-stable ranking), and `dripBudget(weekState)` (the weekly counter / ceiling logic). No I/O,
  no Vault handle — it is handed the already-read relationship edges + the threads' sealed status.
- `src/engine/secretPacingConstants.ts` *(new)* — the single `SECRET_PACING` tunable (the proximity/
  tension/recency weights, the already-told penalty, `weeklyTargetMin`/`Max`, `maxDripsPerWeek`,
  `dripEligibilityRate`). The `THREAD`/`GOSSIP`/`CONFIDENCE` sibling; no decorative constant (audit
  E53 — every weight has a real consumer).
- `src/composition/orchestrator.ts` (or the existing 0060 scheduler call site) — in the bounded tick,
  **before** 0060's surface-to-player decision, run the pacing pass on the **dedicated session rng**:
  rank ripe player-bound threads, check the weekly budget, and on an eligible top candidate, **route
  it into 0060's existing surface-to-player path** (gossip / `surfaceInformationTo` / confidant slip).
  Self-gated by `ORWELL_SECRET_PACING` ⇒ no draws when off (calibration byte-identical); 0060's own
  flat path is the fallback when off.
- `GameSessionAdapter` — exposes the sealed reads the pass needs (the both-way relationship edges per
  source, each thread's `active` age + `disclosedToPlayer`/`surfaced` status), all engine-side;
  persists the **per-week drip counter** + the **per-thread `lastDrippedWeek`** in the snapshot.
- `src/engine/momentPrompts.ts` — **no new lever.** A dripped secret reaches the player as the same
  shape gossip/confidences already produce (a belief, or — on the confidant channel — a 0075
  `confide` disclosure). The narrator voices what the surfaced belief gives it; the manifest note:
  voice the belief at its confidence, never state the sealed premise, never invent the source.

This is a **scheduling/pacing change to an existing organ (0060), not a new FE-driven write-back** —
so it is **not** the four-place MCP wiring gotcha. No new player tool, no new MCP dispatch case; the
drip surfaces through 0060's already-wired pathways.

## Engine-owned schedule vs. model-narrated delivery (ADR 0005)

Authority splits by **openness**, exactly as ADR 0005 requires:

- **Closed set (engine-dictated, no dynamism to lose):** *which* secret is ripe, *whether* the weekly
  budget allows a drip, *whether* the seeded eligibility roll passes, *which* pathway it prefers, and
  the seeded magnitude of any fold the crossing applies. All sealed + seeded. The model moves none of
  it.
- **Open set (model-narrated, never normalized):** the *texture* of the moment the belief lands — how
  the confidant phrases the slip, how the gossip is framed, how the player's scene plays. The engine
  hands a Vault-safe paraphrase/belief (or the 0075 disclosed text) + the Vault-free board; the model
  voices it richly. Nothing the model writes feeds back into the closed schedule (the
  `expressiveNonCollapse` contract holds — no creative prose is collapsed into a bucket that changes
  what can be played next).

The drip is a **pure scheduling decision over the closed set**; it never interprets the player's
open-ended words into a bucket, so it sits cleanly on ADR 0005's correct side of the line.

## ADR 0003 fit (the conversation is the game)

This adds **no dashboard and no new UI** — a dripped secret arrives in the chat as a belief, a piece
of gossip, or a confidant's confession, the same surfaces every other information beat already uses.
It deepens the *conversation*: the player catches a paced stream of secrets about the people they're
actually circling, reacts in-character, and acts on it. It is the engine doing exactly its job under
ADR 0003 — fixing a degradation (rich sealed secrets sat **`(never surfaced)`** and inert; the old
chat-only game would have had the LLM *spontaneously decide* which secret to reveal and when —
ungrounded, sycophantic, and un-paced) and otherwise getting out of the model's way (hand it a
Vault-safe belief to voice, never a script). Long-term memory is the store recalled, never the chat
remembered: a dripped belief is a durable recorded 0002 fact, so a fresh context window loses none of
what the player has caught.

## Persistence (0007/0030 — non-degradation)

- The **per-week drip counter** and a **per-thread `lastDrippedWeek`** persist in the snapshot
  (siblings to 0060's `surfacedThreadCount` / 0075's lie-count), so the weekly cadence and the
  already-told penalty survive a restart — the pace resumes, it never resets.
- A dripped fact is an ordinary recorded 0002 belief — already durable; it **deepens** the player's
  knowledge, never thins.
- An **un-dripped** secret is retained in the Vault forever (0060 already keeps `dormant`/`expired`
  threads as a superset, never deleted) — non-degradation: a secret that never got its moment is
  still part of the season's history and is unsealed in the 0048 retrospective.

## Testability (role-only; HARD rules)

- **Vault Wall (the load-bearing test):** the pacing schedule, per-thread ripeness, and the weekly
  drip counter never appear on `npcVoice`, any player projection, **or the admin/God-Mode surface** —
  a sentinel sweep over the assembled prompt + every surface finds no sealed premise and no number,
  before *and after* a drip. What crosses is the unchanged anchored paraphrase/belief, never the
  premise.
- **A secret reaches the player only via a pathway:** a dripped secret becomes the player's knowledge
  only after a modeled pathway (gossip chain / `surfaceInformationTo` / a 0075 confidant slip)
  terminated at them and recorded a content-lineage-anchored belief; an *unanchored* attempt is still
  downgraded to a suspicion, never knowledge.
- **Pacing cap holds:** over a seeded week, the count of secrets that edge toward the player never
  exceeds `maxDripsPerWeek`; over a season the drip total never exceeds 0060's `maxSurfacedPerSeason`
  (the drip *shapes* the scarce reveals into a cadence, it never adds payoff past the season ceiling).
- **Relevance / proximity + tension:** of the secrets that drip to the player, a measurable share
  concern sources the player has a strong bond *or* high tension with (the schedule prefers relevant
  people) — asserted as a richness threshold over seeds, like 0003/0060's plays-out coverage; a
  source the player has no proximity *and* no tension with is far less likely to drip.
- **No cold open:** a drip rides the bounded tick and crosses through an anchored pathway; no
  free-floating scheduler *starts a scene* to deliver a secret; a proximity drip on the confidant
  channel requires a live scene with that source.
- **No re-spam:** a secret already dripped (its `disclosedToPlayer`/`surfaced` state set) drops in
  ripeness and is not re-dripped at the same tier — the schedule moves on (non-degradation +
  anti-spam).
- **Anti-sycophancy:** the model never selects which secret drips and never invents one; ripeness +
  the budget are engine-computed from the relationship reads + the cadence, never narrated
  convenience; a drip never fires *more* generously to please the player (the seeded schedule
  dictates it).
- **Determinism + calibration-neutral:** same seed + same history ⇒ same ripeness ranking + same
  drip decisions; and with `ORWELL_SECRET_PACING` off, **zero pacing draws** ⇒ 0060 behaves exactly
  as today and `juryReach` / UAT / gradient are byte-identical (no comp/vote/jury outcome perturbed).
- **Durable cadence:** the per-week counter + per-thread `lastDrippedWeek` survive a save round-trip
  (the pace resumes, never resets); an un-dripped secret is retained in the Vault forever.

## Open questions / defaults (resolve at build)

1. **Default weekly band:** start `weeklyTargetMin = 1`, `weeklyTargetMax = 2`, `maxDripsPerWeek = 2`,
   tuned against the UAT so the cadence feels *paced and earned* (about one a week, the occasional
   quiet week), never a soap opera. The season ceiling stays 0060's `maxSurfacedPerSeason`.
2. **Default `dripEligibilityRate`:** start modest so the weekly target is usually-but-not-always met
   (a quiet week is a feature, not a bug — it makes the next reveal land harder), tuned live.
3. **Proximity vs. tension weighting.** Whether close-bond secrets or rival secrets should drip more
   often (the "I knew it" payoff arguably lands hardest on a *doubted* rival; the *betrayal* payoff
   lands hardest on a *trusted* ally). Start balanced; tune which channel the cadence favors against
   playtest feel.
4. **Rollover policy.** Whether an unspent weekly drip rolls into the next week or is simply lost
   (start: lost — a missed week is a quiet week, and the season cap is the real ceiling anyway).
5. **Interaction with 0075's `confide`.** When the schedule marks a proximity secret ripe *and* the
   player is actively pressing that confidant, the drip should defer to / route through the 0075
   `confide` decision (which owns the tier + the lie path) rather than a parallel gossip surface —
   confirm the precedence (recommend: 0075 takes precedence; the drip only *raises the readiness*,
   0075 owns the *act*).
6. **Player-bound vs. NPC↔NPC pacing.** This feature paces only the **player-bound** channel; the
   off-screen NPC↔NPC surfacing/diffusion stays 0060/0038's flat behavior (the house's own secrets
   keep churning untouched). A later phase could pace the NPC-side too — held out of scope to keep
   this feature to the player's experience.
7. **A louder "you realize it now" beat.** v1 lands a dripped secret as the ordinary belief/gossip/
   confidence surface. A more explicit "the pieces click into place" framing (the variable-ratio
   payoff made legible) is a possible enrichment — flag for product before building, and keep it
   belief-level, never a number.
