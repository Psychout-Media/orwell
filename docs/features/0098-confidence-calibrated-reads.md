# 0098 — Confidence-calibrated reads (bold correct reads pay off; blind faith burns)

> **RETIRED 2026-11-11 (owner ruling, "retire and remove").** This feature is not planned and its unused code and tests are removed (card ORW-267). The text below is history only.

> **Status:** ❄️ **FROZEN** (owner-parked "not planned" 2026-06-27; reaffirmed by the owner 2026-11-03; [`docs/features/README.md`](./README.md) is the authoritative status index). It is **not reopened**. A domain term built 2026-07-12 is preserved but DEFAULT-INERT and not live: the domain mechanic is built &
> property-green — `Competitor.conviction?` (default `1`) in `src/domain/competitionOutcome.ts` +
> `convictionVarianceGain`/`convictionVarianceCap` in `src/domain/temperatureConstants.ts`;
> `tests/unit/confidenceCalibration.test.ts` (10 cases) proves BYTE-IDENTICAL at conviction 1/undefined,
> variance-monotonic + MEAN-PRESERVING as conviction falls (var(0)≈4×var(1)), bounded, non-finite refusal.
> **⚠️ STANDING-PRINCIPLE CONFLICT — HELD FOR OWNER RE-RATIFICATION:** the freeze recorded a *standing principle*
> ("a player input must never modulate a seeded outcome distribution — not the direction, and NOT even the
> variance") that this mechanic contradicts. It is therefore built **DEFAULT-INERT**: NO live caller passes a
> `conviction`, so the live game + every heavy-sim seed stay byte-identical. The live adapter pass-through
> (deriving `conviction` from the 0002 belief `confidence`) is DELIBERATELY WITHHELD pending explicit owner
> re-ratification of R1. GOLDEN-NEUTRAL. *(Previously: ❄️ FROZEN — parked 2026-06-27; #879 closed not planned;
> a 2026-07-12 "Everything" sweep built the inert term, but the freeze stands.)*
> Owner ruling + **standing principle for all future specs:** a player input must never modulate a seeded
> outcome distribution — not the direction, and **not even the variance**. The certainty is the human's to
> feel; the game must not model "how sure you are" and let it touch outcomes. See
> `docs/decisions/PO-DECISIONS-LOG.md` (2026-06-27). The original design note + `.feature` follow unchanged.
> **Builds on (does NOT duplicate):** the 0002 belief model — every belief the player holds already
> carries a per-belief **`confidence`** (and a `distortion`) on `KnowledgeFact`
> (`src/ports/KnowledgeService.ts`, lodged by `src/engine/gossip.ts`'s diffusion / decay and by
> `surfaceInformationTo`); the **competition outcome model** (`src/domain/competitionOutcome.ts` — the
> single seeded `resolveCompetition` roll, with its bounded per-moment temperature draw); the
> **temperature model** (`src/domain/temperatureConstants.ts` — the single tunable `bound`/`outcome`
> block). **Depends on:** 0002/0026 (the belief + relationship reads, with confidence), 0028 (the
> temperature/outcome constants this widens a band within), 0044 (the seeded strategic decisions —
> `src/engine/decisions.ts` / `decisionConstants.ts` — the other "act on a read" surface), 0023 (the
> consequence fold — a calibrated swing still records + persists like any outcome). **Sibling of**
> 0066's hidden-`restPenalty` pattern (an opt-in, default-`0`, byte-identical-at-zero competition term)
> and 0094 (distorted-gossip consequences — the belief whose low confidence this reads).
> **Vault Wall (mandate #2 — symmetric):** confidence is hidden engine state; the widened band, the
> roll, and the player's own confidence number are **never** shown to the player **or** the admin /
> God Mode — the player feels only the *bigger swing*, never a number or a "you were unsure" marker.
> **Anti-sycophancy (mandate #3):** the engine widens a **symmetric, seeded** band — it never *aims*
> the result, never "rewards" a correct read or "punishes" a wrong one; the seeded roll falls where it
> falls inside the wider window.

> **Owner direction (Tracks #879):**
> *"When the player ACTS on a low-confidence / uncertain belief, raise the variance of the outcome —
> bold correct reads pay off bigger, blind faith is punished harder; memorable swings instead of flat
> certainty."*

## Why

Right now, when the player acts on what they *believe*, the strength of that belief does nothing to
the outcome. A read the player holds with rock-solid certainty (they witnessed it; an ally they have
genuinely earned told them straight) and a read they're acting on out of a half-heard, fifth-hand
rumor (`distortion` high, `confidence` low — 0002/0094) feed the engine **identically**: the seeded
roll is the same width either way. So the game has only one texture of outcome — flat, even certainty
— and the most human, most _Big Brother_ feeling there is goes missing: **the gamble.** The player who
*reads the house right when nobody else did* and rides it to a huge week; the player whose
**blind faith in a thing they only half-knew** blows up in their face on national television.

0098 makes the player's **conviction** a real input to the variance (never the *direction*) of what
happens. The shakier the belief the player chooses to act on, the **wider the seeded swing** — so a
bold correct read pays off bigger than a safe one, and acting on near-nothing can crater. It does
**not** make the engine kind to good guesses or cruel to bad ones (that would be sycophancy inverted);
it makes the *stakes* of a read scale with how much the player actually knows, and lets the seeded roll
decide. The certainty becomes a *choice with consequences*, and the outcomes become **memorable swings
instead of flat lines.**

### The risk/reward retention value

A flat outcome distribution is forgettable; a **swingy** one is the story players retell. Risk/reward
is the deepest engagement loop a competition game has — "do I bet the house on this read?" is a
decision the player makes with their gut, and the bigger the variance the bigger the dopamine on the
hit and the gut-punch on the miss. Crucially this hook **rewards earning real information** (the 0075
confidence, the witnessed scene, the trustworthy ally) with *lower* variance — a calm, reliable
outcome — while a desperate gamble on a rumor is genuinely volatile. It gives **paying attention** and
**doing the social work** a felt mechanical payoff, without ever telling the player a number — exactly
the loop that makes a player say "one more week."

## The bright line this feature respects (read first)

A "the outcome depends on my belief" feature looks, at a glance, like it (a) leaks the player's hidden
confidence and (b) lets the engine *protect or punish* the player narratively — both mandate
violations. It does neither, and the reasons are structural, not prompt wording:

1. **The engine widens a SYMMETRIC, SEEDED band — it never aims the result (mandate #3).** Conviction
   maps to the *width* of the existing bounded temperature draw, **not** its sign. A wider band makes a
   big win *and* a big loss more likely in equal measure; the **seeded roll** — the same
   `RandomnessSource` that already decides every outcome — falls where it falls inside the wider
   window. The engine never reads "this belief is true" and nudges toward success, never reads "this
   belief is false" and nudges toward failure. It does not even *know* whether the player's read is
   "correct" at the moment of the roll — it knows only how *confident* the player is, and confidence
   sets variance, full stop. "Bold correct reads pay off bigger" is an **emergent** property of a wider
   symmetric band landing on the good side this seed — never an engine that rewards correctness.

2. **The player's confidence is hidden state and never crosses — to player OR admin (mandate #2).**
   `KnowledgeFact.confidence` already lives in the (engine-side) knowledge layer and is never on a
   player projection. 0098 reads it engine-side to set a band width; it adds **no** new player-facing
   or admin/God-Mode surface. The player sees the *result* (a bigger swing); they never see their
   confidence, the band width, the roll, or a "you were acting on a hunch" marker. Judging how sure
   they are is the human's job (mandate #2; paranoia is theirs to form, 0017/0020).

3. **A calibrated outcome is still recorded, folded, and persisted (mandate #4 / 0023).** A swing is an
   ordinary outcome: `runCompetition` (the single outcome authority) and the seeded decisions still
   record their result, fold the hidden consequence (0023), and persist it. Non-degradation holds —
   the swing deepens memory, it does not thin it.

4. **Default-off ⇒ byte-identical (the calibration spine is protected).** Like 0066's `restPenalty`,
   the conviction term is an **opt-in scalar that defaults to the no-op value**, so with the feature
   disabled (or with a fully-confident read) the band width is **exactly today's** and the seeded
   `juryReach` / gradient / UAT outcomes are **byte-identical**. See *Determinism & calibration-
   neutrality* — this is the load-bearing guard and a hard release gate.

## The mechanic

### 1. The input — the player's CONVICTION in the read they are acting on (engine-side)

When the player takes an action **grounded in a belief**, the engine reads that belief's existing,
hidden **`confidence`** (0002 — `KnowledgeFact.confidence ∈ [0,1]`; a witnessed scene ≈ 1, a
decayed/distorted rumor low, a hedged 0075 confidence in between, a bare suspicion capped low) and
derives a **`conviction ∈ [0,1]`** for the action: `1` = rock-solid (acting on something the player
*knows*), `0` = near-blind faith (acting on near-nothing).

- **`conviction` is derived ONLY from existing signals** — the belief's `confidence` (and its
  `distortion`, which already grows with hops). No new hidden attribute is minted; 0098 reads the
  number the belief layer already carries.
- **What counts as "acting on a belief"** is the open question for PO review (R3) — see below. The
  conservative v1 default is **the player's competition intent when it is grounded in a read** (e.g.
  "I'm throwing this comp because I believe I'm safe" / "I'm going all-out because I think they're
  coming for me") and, behind the same flag, **the player-initiated strategic move keyed to a belief**
  (acting on a read about who to trust / target). The model proposes *which* belief an action is
  grounded in (open-set interpretation, ADR 0005); the engine owns the *magnitude* of the resulting
  variance (closed-set). No belief reference ⇒ no conviction term ⇒ **byte-identical** (a generic,
  un-grounded action is unchanged).
- **`conviction` is NEVER shown** (Vault / anti-sycophancy). It only sets a band width.

### 2. The map — conviction widens the SEEDED variance band (the whole mechanic)

The competition outcome already draws **one bounded, seeded temperature** per competitor
(`temperatureRoll`, bounded by `temperatureConstants.bound = {min:-1, max:1}`, scaled by
`outcome.temperature`). 0098 makes the **width of that draw for the player's grounded action** scale
**inversely with conviction**:

| Conviction | Band width applied to the player's grounded roll | Felt result |
|---|---|---|
| `1` (acts on what they KNOW) | the **baseline** width — exactly today's | calm, reliable outcome (no change) |
| mid | a **widened** band (bounded) | a real gamble — bigger up, bigger down |
| `→ 0` (blind faith) | the **widest** bounded band (capped) | a coin-flip swing — huge win or crater |

Concretely the term is a **bounded multiplier on the temperature span** (a `convictionVarianceGain`
in the constants, sibling to `sleepPenalty`): `effectiveSpan = baseSpan × (1 + gain × (1 − conviction))`,
clamped to a hard ceiling so even total blind faith can never blow past a bounded swing (temperature
**never** overrides hard rules or archetype weighting — `CLAUDE.md`, 0028). At `conviction = 1` the
multiplier is `1` and the roll is **byte-identical**. The widening is **symmetric** about the same
center the roll already has — it does not shift the mean, only the spread. The result is then resolved
by the **same seeded roll** through the **same `resolveCompetition`** — 0098 supplies a wider *range*
for that one draw, never a different *center* and never a thumb on the scale.

> **Why this is anti-sycophancy-safe, restated:** widening a symmetric band around an unchanged center,
> then letting the existing seeded `RandomnessSource` draw, cannot favor the player. Over many seeds a
> low-conviction action has the **same expected outcome** as a high-conviction one — only a **higher
> variance**. "Pays off bigger / punished harder" is the *tails getting fatter*, not the *mean
> moving*. The engine is not protecting or punishing; it is making the bet bigger.

### 3. Strategic decisions — the same widening, on the seeded decision (behind the same flag)

The seeded strategic layer (0044 — `voteChoice` / `nominationStrategy`, all **bounded nudges** on the
threat-primary read) is the other place the player "acts on a read." Where a **player-authored**
strategic action is grounded in a belief, the same conviction-driven variance applies to the
**seeded** part of that decision's resolution (e.g. the temperature/jitter band on the outcome of a
contested move), never to the **direction** the player chose and never to the **hard legality** (0005 —
legality binds downstream of every read, untouched). This rides the existing seeded decision stream,
adds **no new decision term** beyond a band width, and is **default-off ⇒ byte-identical**. *(PO review
R3 decides whether v1 includes this surface or holds it to competitions only.)*

### 4. What the model does — proposes WHICH belief, voices the swing; never sets the variance (ADR 0005)

This is a clean ADR 0005 split — the model does the **open-set interpretation** (reading *which* belief
the player's action is grounded in, anchored in the specific scene), the engine owns the **closed-set
magnitude** (the band width + the seeded roll):

- When the player's action is grounded in a read, the model may propose the **belief reference** (the
  `factId` / the read being acted on) the same way it proposes a `consequence` *shape* today (PR #355) —
  open-set, scene-grounded, **never a number**. The engine validates it against the player's actual
  `knownTo` set + confidence and owns the variance entirely. A proposal can **never** widen (or narrow)
  the band beyond the engine's bounded map — exactly as a `consequence` proposal can never set
  magnitude.
- The model **voices the swing** as drama, never as machinery: it narrates the gamble and its result
  (the clutch win, the stunning upset) the way it narrates any outcome — it does **not** announce "your
  confidence was low so variance was high," does **not** state the band, does **not** tell the player
  they were unsure. The roll is the engine's; the *meaning* is the model's; the *number* is nobody's
  the player can see.

> **The no-leak / no-aim guarantee is structural:** confidence is read engine-side from the (engine-
> only) knowledge layer; the band is a symmetric width on a draw the engine already owns; the result is
> the existing seeded roll. There is no projection — player or admin — that returns the conviction, the
> band, or the roll, and no path by which the model sets the variance.

## Engine seams (where this lands)

- `src/domain/competitionOutcome.ts` *(extend — mirror the `restPenalty` shape exactly)* — `Competitor`
  gains an optional **`conviction?: number` (0..1, default `1` = byte-identical)**. `resolveCompetition`
  widens **only that competitor's** temperature span by the bounded
  `convictionVarianceGain × (1 − conviction)` multiplier (clamped to the ceiling), draws the **same
  seeded** `rng.next()` into the wider span, and is otherwise unchanged. **At `conviction = 1` (or
  `undefined`) the score is byte-identical to today** — the same guard the `restPenalty` default holds.
  Non-finite ⇒ the same loud refusal the other fields get (anti-sycophancy: malformed input is a
  refusal, never a silent fix).
- `src/domain/temperatureConstants.ts` *(extend the single tunable)* — `OutcomeWeights` gains
  **`convictionVarianceGain`** (the bounded inverse-confidence gain) and the constants block gains a
  hard **`convictionVarianceCap`** (the ceiling on the widened span). `0` gain ⇒ feature inert ⇒
  byte-identical; the cap keeps even blind faith bounded (temperature never overrides hard rules).
- `GameSessionAdapter` (the live `runCompetition` / decision path) *(extend)* — when the player's
  grounded action carries a validated belief reference, resolve the player's **`conviction`** from that
  belief's `KnowledgeFact.confidence` (engine-side, via the knowledge layer it already holds) and pass
  it into `resolveCompetition` (and, behind the flag, the seeded decision band). All engine-side; no new
  projection. Gated by the feature flag (below) ⇒ unset/absent ⇒ no conviction passed ⇒ byte-identical.
- `src/engine/decisions.ts` / `decisionConstants.ts` *(extend, behind the flag, if R3 includes it)* — the
  seeded part of a player-authored strategic decision reads the same conviction band; **no new decision
  term**, only a width on the existing seeded variance; bounded; legality untouched.
- `src/engine/momentPrompts.ts` *(extend)* — the relevant moments let the model propose *which belief*
  an action is grounded in (open-set) and voice the swing as drama; the manifest states plainly: the
  engine owns the variance and the roll; never announce a confidence, a band, or a number; never claim
  a read was "right" or "wrong" — narrate what happened.
- **The model reach (FE)** *(follow-on, sibling of the 0055 `consequence` plumbing)* — the optional
  belief-reference rides the existing grounded-action call the way `consequence` does today; validated
  against the living roster + the player's `knownTo`, falling back to no-reference (byte-identical) when
  nothing valid remains, and **forbidden from proposing any variance number** (the magnitude stays
  engine-owned). Built FE-side, pytest-gated.
- **Vault:** the conviction read + the band live in engine-only state; dependency-cruiser proves no
  outward import. No player **or** admin projection returns the conviction, the band, or the roll.

## Persistence (0007/0030 — non-degradation)

- 0098 mints **no new durable state of its own** — `conviction` is *derived at the moment of action*
  from the belief's already-persisted `confidence` (0002 knowledge is already durable). A restored game
  recomputes the same conviction from the same persisted belief ⇒ a save/restore is transparent.
- The **outcome** of a calibrated swing is an ordinary recorded result (the comp result, the decision,
  the 0023 fold) — already durable; it **deepens** memory (a memorable swing is a recalled beat), never
  thins it.
- Pre-0098 saves restore with no conviction field ⇒ the byte-identical default ⇒ no migration, fully
  back-compatible.

## Determinism & calibration-neutrality (the load-bearing guard — this is the calibration caveat)

**This feature touches the calibration spine and must be defended by the heavy sims.** The competition
and eviction *distributions* are calibrated against `tests/property/juryReach.property.test.ts`, the
calibration gradient, and the full-game UAT. 0098 changes the *width* of a seeded draw, so an
incautious build could shift those distributions. The neutrality is guaranteed structurally and is a
hard release gate:

- **Opt-in / default-`1` ⇒ byte-identical (the `restPenalty` pattern, the firm guarantee).** With the
  feature flag unset — **or** for any fully-confident (`conviction = 1`) read, **or** for any action
  not grounded in a belief — the band width is exactly today's and the seeded `resolveCompetition` /
  decision outcomes are **byte-identical** to the pre-0098 model. `tests/unit/stagedTrajectoryNeutral`
  -style byte-identity is the template; a dedicated byte-identity test pins it, and the heavy sims run
  **unchanged** with the flag off.
- **Symmetric, mean-preserving by construction.** The widening is a symmetric multiplier on the span
  around an unchanged center — so over many seeds the **expected** outcome is unmoved; only the variance
  rises. A property test asserts: across seeds, a low-conviction action's **mean** outcome ≈ the
  high-conviction baseline within tolerance, while its **variance** is strictly higher (the headline
  claim, proven structurally — fatter tails, same center).
- **Bounded — temperature never overrides hard rules.** The widened span is hard-capped
  (`convictionVarianceCap`); even total blind faith cannot produce an unbounded swing, flip a hard
  legality, or override archetype-grounded weighting (0028 / `CLAUDE.md`). A favorite acting on a hunch
  is *more* upset-prone but the stat still anchors the center.
- **Seeded + reproducible.** Same seed + same history + same conviction ⇒ same roll, same swing. The
  variance is deterministic given the inputs.
- **Heavy-sim defense (the explicit caveat).** Because this is calibration-sensitive, the PR **must**
  run the full `juryReach` / gradient / UAT lanes with the feature **both off (byte-identical) and on**,
  and the on-run must show the *mean* eviction/jury distribution still inside the calibrated band (only
  variance widens) — the `EARNED_WINS` guard stays green. **If the on-run shifts the mean, the feature
  is mis-built** (it has aimed the result, not just widened the band) and does not ship.

## ADR fit

- **ADR 0005 (split authority by openness).** Selecting *which belief* an action is grounded in and
  voicing the swing are **open-set, model-narrated** and recorded losslessly; the **band width + the
  seeded roll** are **closed-set, engine-owned, bounded, seeded**. 0098 widens what the model may
  *propose* (a belief reference) without widening what it may *magnitude* — the exact shape ADR 0005's
  generative-consequence path takes. It never collapses creative play into a bucket and never lets a
  proposal set variance.
- **ADR 0003 (the conversation is the game).** This adds **no dashboard, no dice, no "confidence
  meter"** — the player experiences the gamble purely as a bigger *outcome*, narrated in conversation.
  It serves the four fixes by deepening **behavioral fidelity** (the risk/reward texture of a real
  season) while keeping the context light and handing the model a *fact to voice* (the swing), never a
  *script to recite* — the certainty is the player's to feel, the variance the engine's to own.
- **ADR 0002 (organic relationship model).** Conviction is read from the belief's own organic,
  decaying `confidence` — never a stored flag. A read earned through real pathways (a witnessed scene, a
  trusted ally's confidence) carries high confidence and so *low* variance; a fifth-hand distorted
  rumor carries low confidence and so *high* variance — the relationship/knowledge layer's own honesty
  about how much the player knows, made mechanically felt.

## Acceptance criteria

1. When the player acts on a belief, the **lower** that belief's hidden `confidence`, the **wider** the
   seeded outcome band for that action — a property test shows variance rising monotonically as
   conviction falls, with the **mean outcome unchanged** across seeds (symmetric, mean-preserving).
2. A **confident** read (witnessed / high-confidence, `conviction = 1`) resolves at the **baseline**
   width — **byte-identical** to today; a **bold correct** read can therefore pay off bigger purely
   because the wider symmetric band landed well on that seed (emergent, never an aimed reward).
3. **Blind faith burns harder** symmetrically: a low-conviction action has fatter tails on **both**
   sides — bigger crater *and* bigger win — capped by the hard variance ceiling; it never produces an
   unbounded swing, flips no hard legality, and overrides no archetype weighting.
4. The engine **never aims** the result (anti-sycophancy): it does not read whether the belief is true
   and nudge toward success/failure; over many seeds a low-conviction action's expected outcome equals
   the high-conviction baseline within tolerance.
5. **Vault Wall (player AND admin):** no player-facing **and no admin/God-Mode** projection returns the
   conviction, the band width, or the roll; the player feels only the swing, with no "you were unsure"
   marker — a sentinel sweep over every projection is clean, and no number ever crosses.
6. **The model owns interpretation, not magnitude (ADR 0005):** the model may propose *which belief* an
   action is grounded in (validated against the player's `knownTo`) and voices the swing, but cannot set
   the band; an invalid/absent reference falls back to no-conviction ⇒ byte-identical.
7. **Determinism / calibration-neutral (the load-bearing gate):** with the feature flag unset — or for
   any fully-confident read, or any un-grounded action — the seeded competition/decision outcomes are
   **byte-identical** to the pre-0098 model and `juryReach` / gradient / UAT pass unchanged; enabled,
   the *mean* distributions stay inside the calibrated band (only variance widens) and the run stays
   seeded + reproducible.
8. **Persistence / non-degradation:** 0098 mints no new durable state; conviction is recomputed from
   the persisted belief on restore (transparent), the swing's outcome is recorded/folded/persisted like
   any result, and pre-0098 saves restore to the byte-identical default.

## PO review — owner rulings needed

This is a **PO-review spec** because it is the first feature to let a player-side input modulate the
**seeded outcome distribution** — the calibration spine. The mechanic is designed to be anti-sycophancy-
safe (symmetric, mean-preserving, seeded) and default-off byte-identical, but the following are owner
calls, not implementer calls:

- **R1 — May player confidence modulate SEEDED outcomes at all, and is the symmetric-band shape the
  right guardrail?** The proposal lets the player's hidden conviction set the **variance** (not the
  direction) of a seeded roll: a symmetric, mean-preserving widening, then the existing seeded
  `RandomnessSource` decides. The engine never reads whether the read is "correct" and never aims the
  result — "bold correct reads pay off bigger" is an emergent property of fatter tails landing well,
  not an engine reward; "blind faith burns" is the same tails landing badly. **Ruling needed:** does
  the owner accept conviction→variance under the anti-sycophancy mandate, and is *symmetric / mean-
  preserving* (vs. any asymmetric shape) the required guardrail? *(Recommendation: yes, symmetric only —
  asymmetry would be the engine protecting or punishing, which mandate #3 forbids.)*

- **R2 — The magnitude stays engine-owned + seeded (confirm the bound + ceiling).** The band width is a
  bounded multiplier on the existing temperature span, hard-capped by `convictionVarianceCap`; the
  model may propose *which belief* an action is grounded in but **never** a variance number, and no
  number crosses to player or admin. **Ruling needed:** confirm magnitude + bound + ceiling stay
  entirely engine-owned and seeded (the model proposes only the *belief reference*, open-set), and set
  the appetite for the maximum swing (how fat the blind-faith tails may get before the cap).

- **R3 — Which decision classes does this apply to?** Candidates: **(a)** the player's **competition
  intent grounded in a read** (the conservative v1 — clearest "I'm betting on this read"); **(b)**
  **player-authored strategic moves** keyed to a belief (noms/votes the player drives — the seeded part
  only, never the direction or legality); **(c)** anything broader. **Ruling needed:** v1 = **(a) only**,
  **(a)+(b)**, or wider? *(Recommendation: ship **(a)** first — smallest calibration surface, clearest
  player intent — and gate **(b)** behind the same flag as a fast-follow once the heavy sims confirm
  the mean holds.)*

- **R4 — The load-bearing calibration guarantee (this one touches calibration — flag it).** The whole
  feature is **opt-in / default-`1` ⇒ byte-identical** (the 0066 `restPenalty` pattern): flag off, or
  any fully-confident read, or any un-grounded action ⇒ the seeded `juryReach` / gradient / UAT
  outcomes are **byte-identical** and the calibration spine is unmoved. Enabled, the build is **mean-
  preserving** — only variance widens — and the PR **must** run the heavy sims both off (byte-identical)
  and on (mean still inside the calibrated band; `EARNED_WINS` green). **Ruling needed:** ratify that
  this is a calibration-sensitive feature defended by the heavy sims, that it ships behind a flag
  default-off until the on-run is verified, and that **a mean shift in the on-run blocks the ship** (it
  would mean the band was aimed, not widened).

## Open questions / defaults (resolve at build)

1. **The `convictionVarianceGain` + `convictionVarianceCap` magnitudes.** How much the band widens per
   point of lost confidence and the hard ceiling on the swing — tuned against the UAT so a low-
   conviction action feels like a *real* gamble without flattening the seeded variance into noise or
   shifting the mean (the campaign-calibration lesson: felt, never mean-moving). Start: a modest gain
   with a firm cap; widen only if play reads as too flat.
2. **The `confidence → conviction` curve.** Linear (`conviction = confidence`) vs. a shaped curve
   (e.g. only *low* confidence widens much, mid-to-high stays near baseline so "pretty sure" still
   feels reliable). Start: near-linear with a soft floor so a bare suspicion is a true coin-flip.
3. **Which belief anchors a multi-read action.** When an action is grounded in several beliefs, take the
   *lowest* confidence (the weakest link — most honest about the gamble), an average, or the model's
   proposed primary. Start: the model proposes the primary; the engine takes the lower of that and any
   it can corroborate.
4. **The 0044 strategic-decision band (R3-(b)).** Exactly which seeded sub-terms of a player-authored
   strategic decision the band applies to (the outcome jitter only, never the direction/legality) —
   deferred to the build behind the flag, pending R3.
5. **Player-confidence visibility (firmly out of scope).** Ever showing the player a conviction cue
   (even a vague "you're not sure about this") is **out of scope and likely a Vault/anti-sycophancy
   violation** — the certainty is the human's to feel. Listed only to mark it explicitly closed.

— Tracks #879.
