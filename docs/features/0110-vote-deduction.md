# 0110 — Vote deduction (process of elimination): the secret ballot becomes a deduced belief

> **Current default (AMEND 2026-11-06):** `ORWELL_VOTE_DEDUCTION` is **default ON** in the engine (`src/featureFlags.ts`, `defaultOn`; `=0` turns it off, and the deploy profile sets it too). The "default off" / "opt-in" wording below records how it was built and calibrated (byte-identical OFF), not today's default.

> **Status:** ✅ **BUILT (2026-06-28) and BDD-gated in `cucumber.cjs`** (`tests/unit/voteDeduction.test.ts`; flag `ORWELL_VOTE_DEDUCTION`, code default off, ON in the deploy profile). Originally drafted 2026-06-28 during the PO-review sweep. Realizes **option B** of the
> PO's secret-vote-grudge ruling (0023 review): the jury grudge must not enact off the *true* secret
> ballot. Instead the evictee **deduces** who moved against them by **process of elimination**, and the
> grudge folds on that (possibly wrong) belief.
> **Builds on (does NOT duplicate):** **0047** (eviction night — the secret ballot: `voteRecord` is
> engine-only, the reveal is anonymized, the **count** is public, attribution unseals only at 0048),
> **0002** (the belief model — a fact reaches a houseguest only via a pathway, held with a **source +
> confidence**, and **can be wrong**), **0037/0014** (the jury grudge / `mannerByEvictee` the finale
> reads), **0026** (the betrayal-shock relationship fold), **0017** (directed, asymmetric reads).
> **Bounded by:** mandate #2 (Vault Wall — player **and** admin), mandate #3 (anti-sycophancy — the
> engine owns the bounded, seeded magnitude; the model never bends an outcome), mandate #4
> (non-degradation), ADR **0003** (the conversation is the game).

## Why — the gap this closes

Eviction votes are **secret ballots** (0047): the tally is engine-only, the reveal is anonymized, and
per-voter attribution unseals only in the 0048 retrospective. **But the jury grudge cheats.** At each
eviction the engine folds the evictee's grievance against:

```
recordEvictionManner(s, evictee, [s.hoh, ...votesToEvict], ctx)   // votesToEvict = the ACTUAL secret voters
```

So the evictee resents the *exact* people who voted them out — using secret-ballot data they should not
officially have. The HOH/nominations part is fine (public). The `...votesToEvict` part is not: **a secret
vote — including the player's own — creates a jury consequence, contradicting the secret ballot.** (PO,
0023 review: *"the effects shouldn't enact if it's a secret."*)

## The idea (PO): process of elimination

Real _Big Brother_ threads this exact needle. The **count is announced** ("evicted 5–2"); the **who** is
not. Jurors then **deduce** the defectors from what they *do* know — and sometimes they are **wrong**.
This is not perfect knowledge and it is not zero knowledge; it is a **deduced belief with a confidence**,
which is precisely what the 0002 model already represents.

## The mechanic

At an eviction, each evictee runs a **pure, engine-only deduction** over what is legitimately available:

- **Public constraints:** the voter pool (who was eligible to vote — everyone except the HOH and the two
  nominees, 0005), and the **count** for each nominee (already public via the anonymized 0047 reveal).
- **The evictee's own reads (0017):** their **loyalty priors** (who they trusted "wouldn't" move on them)
  and **suspicions** (who they already read as a threat).

From these it derives a **belief set** — the houseguests the evictee *believes* voted against them, each
with a **confidence**:

- **Fully-constrained** (a unanimous vote, or a count that forces specific people given the eligible pool) →
  **high-confidence, correct** deduction.
- **A trusted ally the count *forces* to have flipped** (you had two loyalists and still lost 5–2 in a house
  of seven → at least one loyalist must have turned) → a **high-confidence betrayal** deduction (the 0026
  betrayal-shock grade).
- **Ambiguous** (several equally-plausible arrangements) → a **low-confidence** belief that **can be wrong**
  (0002): it may finger a non-voter or **miss** the real defector.

### What changes downstream (option B, realized)

The jury grudge (`recordEvictionManner` / the 0037 `mannerByEvictee`) folds on the **deduced belief set**,
**not** on `votesToEvict`:

- **A deducible defector** earns the grudge (as today — but *earned by deduction*, not handed the tally).
- **An undeducible secret vote earns NO grudge** — secrecy is honored (the option-B fix; a player's quiet
  vote only costs jury goodwill if the evictee can actually work it out).
- **A wrong deduction misattributes** the grudge — resenting the wrong person, or missing the real
  traitor. **Dramatic irony**, straight out of the 0002 belief-can-be-wrong model.

The **public** responsibility (HOH + nominations) keeps driving grudges exactly as today — only the
**secret vote** half is routed through deduction.

### What stays exactly as-is (additive, not a rewrite)

- **The truth is still recorded.** `voteRecord` (the real tally) is unchanged and still unseals in the 0048
  retrospective — the *belief* is a separate, engine-only layer beside it.
- **0047's reveal is unchanged** — the count was already public; attribution is still never shown.
- **Deduction OFF ⇒ byte-identical** to today's perfect-knowledge grudge (see calibration).

## The Vault Wall & anti-sycophancy

- **Engine-only, player AND admin.** The deduction, the belief set, and every confidence are hidden state.
  No projection shows who the evictee *thinks* voted, or a confidence number. A sentinel sweep over the
  assembled player/admin surfaces finds no belief or magnitude.
- **The player sees only** the public count and, later, **observable juror behavior** (a juror who runs
  cold at the finale). They **infer**; the game never tells them the deduction.
- **The engine owns the magnitude.** The grudge size is the seeded 0026/0037 fold; the model only voices.

## Persistence (0007/0030 — non-degradation)

The per-evictee deduced belief (suspected defectors + confidence) persists with `mannerByEvictee`/the soul
layer and survives a restart (lossless). A pre-0110 save loads with no belief layer and resolves at the
current model until the flag is on.

## Calibration (the load-bearing guarantee)

This **changes who the jury resents**, which feeds the jury vote and the "playing pays off" band. So it
ships **opt-in** behind a dedicated flag (e.g. `ORWELL_VOTE_DEDUCTION`, code default **off**; the deploy profile sets it ON), on its own seeded
sub-stream:

- **Off ⇒ byte-identical** — `recordEvictionManner` folds `[s.hoh, ...votesToEvict]` exactly as today; the
  `juryReach`/UAT/gradient sims are unmoved (the byte-identity gate).
- **On ⇒ re-baselined** — the heavy jury sims run **on and off**; the EARNED-WINS guard must stay green
  (deduction must not gut jury management, only make it faithful). The deduction consumes bounded seeded
  uncertainty on its own sub-rng, never the shared streams.

## Testability (role-only; HARD rules)

- **Count public, attribution secret** — reaffirms 0047: the count is available to the deduction; no
  projection names a voter.
- **Fully-constrained ⇒ correct, high-confidence** deduction; **ambiguous ⇒ low-confidence, sometimes
  wrong** (misattributes or misses).
- **A forced trusted-ally flip reads as a betrayal** (0026 grade).
- **Grudge folds on the BELIEF, not the truth:** an **undeducible** secret vote folds **no** grudge (the
  option-B guarantee); a **deducible** one does.
- **Dramatic irony:** a wrong deduction folds the grudge on a houseguest who did **not** vote against the
  evictee (and/or spares one who did).
- **Truth preserved:** the real `voteRecord` is unchanged and still unseals at 0048, whatever the belief.
- **No belief/number crosses** to player OR admin (sentinel sweep).
- **Determinism / calibration-neutral OFF:** seeded; byte-identical `juryReach`/UAT on the untouched path.

## Dependencies & traceability

Routes the 0037/0014 jury grudge (`recordEvictionManner`) through a new deduction over 0047's public count +
0002's belief model; folds via 0026/0017; the truth still lives in `voteRecord` (0048 unseal). Under 0001
(Vault Wall) and 0021 (isolation). Source: PO ruling during the 2026-06-28 review sweep (0023) — option B,
via the PO's process-of-elimination idea. Turns "who voted me out?" from an engine cheat into an
**earned, fallible deduction** — honoring the secret ballot while keeping jury management real.
