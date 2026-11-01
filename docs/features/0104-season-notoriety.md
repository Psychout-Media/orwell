# 0104 — Season-over-season notoriety (a reputation that precedes you into a new cast)

> **Status:** ✅ **BUILT (2026-06-27).** PO review resolved (owner, 2026-06-27 — R1 bounded open-set
> `NotorietySummary`; R2 Day-1 bias + narrative reference with **per-NPC recognition** wiggle room; R3
> per-user/per-character isolation; R4 **diegetic opt-in** — return as the same character vs. create a new
> one — the character identity + notoriety persist at the account level across a season-reset). See
> `docs/decisions/PO-DECISIONS-LOG.md` (2026-06-27) + #886. Tracks issue **#886**. Seams:
> `src/engine/notoriety.ts` (pure derive/accumulate/bias) +
> `src/engine/notorietyConstants.ts` (the single `NOTORIETY` tunable) + `src/ports/UserNotorietyStore.ts`
> (`FileUserNotorietyStore`/`InMemoryUserNotorietyStore`) + `registry.resetUser`/`setOnRestart` (derive at
> the season-end terminal, fold on a `keepCharacter`→`carriesNotoriety` restart) + the one bias term in
> `GameSessionAdapter.seedFirstImpressions`.
> **Gate (met):** engine (Vitest) — `tests/unit/notoriety.test.ts` (derive/accumulate/bias/recognition +
> the live day-one fold + the diegetic opt-in + cross-user isolation), `tests/unit/notorietyOutcomeNeutral.test.ts`
> (the **dedicated calibration-neutrality proof**: SHA256 of the seeded outcome + move-in stream, byte-identical
> off vs a fresh-character path; the NPC↔NPC layer byte-identical even WITH a notoriety), `tests/unit/notorietyVault.test.ts`
> (the Vault sentinel sweep, player AND admin) + the dependency-cruiser Vault boundary + BDD
> `0104-season-notoriety.feature` (wired in `cucumber.cjs`). The calibration spine stays the proof that it is
> opt-in/byte-identical (`tests/property/juryReach.property.test.ts` + `calibrationGradient` re-run green with the
> flag off).
> **Builds directly on (does NOT duplicate):**
> - **The seasons-as-levels / season-restart spine** — `registry.resetUser` (`src/composition/registry.ts`)
>   is the *single* season-restart door (audit E1/D1/R1): it rotates the dead season's durable saves off
>   the live path (non-degradation — they stay on disk for inspection) and forgets the orchestrator
>   baseline (`Orchestrator.forgetUser`). 0065's `nextSeasonWarm` cutover already carries *cast warm* across
>   that door. This feature carries **one more bounded thing** across the same door — a notoriety summary —
>   and adds **no second restart path**.
> - **The casting day-one reads** — `GameSessionAdapter.seedFirstImpressions` (`src/adapters/engine/GameSessionAdapter.ts`)
>   already folds each NPC's authored **`dayOnePerception`** (0058 §3 — signed `trustLean`/`affinityLean`/
>   `threatLean`, Vault-only) into the NPC→player move-in edge, orientation-aware via 0063. This feature adds
>   **one new bias term** into that exact fold; it does not invent a new seeding path.
> - **The game-session / save lifecycle (0021)** — one active game per user, unlimited users, **cross-user
>   isolation as a first-class guarantee alongside the Vault Wall**, keyed to the physical-world user
>   (`UserSaveStore`, the per-user sandbox `registry.sandboxFor`). Notoriety is **the same physical user's
>   own prior games only**, and rides the same per-user key — never a cross-user read.
> **Depends on:** 0001 (the Vault Wall — notoriety is hidden-layer bias, never a player/admin read), 0002
> (the relationship model — notoriety nudges directed NPC→player edges, never a stored label), 0021 (the
> per-user save lifecycle + cross-user isolation it rides), 0023/0007/0030 (the consequence & memory loop +
> persistence/non-degradation — the summary is *derived from the finished season's already-recorded record*,
> then persisted, never thinned), 0037/0048 (the endgame + the retrospective/unsealing — a season's outcome
> is the raw material), 0058/0063 (deep profiles + the day-one perception fold this enriches; the casting
> diversity/orientation floor it composes with). **Sibling of** 0101 (NPC myth-making — how *this* season's
> house mythologizes you; this is the *next-season* arc: how your past *precedes* you) and 0100 (the jury
> grudge-book — an *intra-*season memory; this is the *inter-*season one). **Refines** ADR 0005 (split
> authority by openness — the summary is a **closed-set** bounded fact, not a normalization of open play) and
> sits squarely inside ADR 0003 (the conversation is the game — a fresh light context that *recalls* a past
> reputation, never *remembers* a past chat). **Bounded by:** mandate #1 (behavioral fidelity — a returning
> reputation that precedes you is the long-arc heart of a *seasons-as-levels* game), mandate #2 (the Vault
> Wall, incl. admin — the notoriety bias is hidden state, surfaced only through later NPC behavior), mandate
> #3 (anti-sycophancy — the **engine still owns the magnitude**; notoriety only *biases direction*, never a
> raw number to the player, and never inflates the player's odds past the seeded floor) and mandate #4
> (non-degradation — notoriety **accumulates and deepens** across seasons; the dead season's full record
> stays on disk, the carried summary is bounded *and* monotonic in count).

> **Owner direction (Tracks #886):**
> *"When I start a new season, I want my past to come with me — a notoriety that precedes me into the new
> cast. People who've 'heard about' the player from last season, returning dynamics, callbacks to old
> games. Long-term meta-progression like this is a powerful retention hook — it makes each season a level,
> not a reset."*

## The problem this fixes

The game is already a **seasons-as-levels** machine. When a season ends, `registry.resetUser` retires the
finished season's durable saves *off the live path but keeps them on disk* (non-degradation — they exist for
inspection), forgets the orchestrator baseline, and stands up a fresh sandbox for the next season; 0065 even
carries a *pre-warmed cast* across that cutover. So the plumbing for "a new season for the same physical
user" exists and is exercised.

But **nothing of the player crosses that door.** Season N's house never witnessed Season N−1; the new cast
reads the returning player as a *blank slate* (`seedFirstImpressions` scatters the move-in edges + folds the
new cast's own authored `dayOnePerception`, which is *player-independent* by seed). So the single most
powerful retention beat in a level-based social game does not exist: **a reputation that precedes you.**
A player who ran a brutal, blindside-heavy first season *should* walk into Season 2 to a house that has
"heard things" — some wary, some impressed, some flat wrong. A quiet, beloved goat *should* walk in
underestimated. Today, every season starts from zero. That's a *reset*, not a *level*.

This feature makes the **player's earned reputation persist as a bounded, hidden notoriety summary** that
**biases the next cast's day-one reads of the player** — and *only* that. It is the inter-season sibling of
0101 (this-season folklore) and the natural payoff of the seasons-as-levels spine 0021/0065 already built.

## The bright line this feature has to respect (read first)

Carrying *anything* across a season looks, at a glance, like it threatens two mandates at once — the Vault
Wall (does a "reputation" leak old secret state into the new game?) and anti-sycophancy (does a "veteran"
player get an unearned edge?). It does neither, and the reasons are structural, not prose:

1. **What crosses is a *bounded summary*, never raw Vault state.** The carried object is a small, fixed-shape
   **notoriety summary** derived from the finished season's *already-public outcome record* (placement,
   loyalty/treachery posture, comp profile, jury respect) — facts the player *already knew*. **No Vault
   record, no soul, no hidden edge, no other houseguest's secret, no off-screen scene crosses.** A finished
   season's Vault stays sealed on disk; the summary is computed *from the open-set outcome*, not extracted
   from the hidden layer (mandate #2; see "What persists" → R1).
2. **The engine still owns the magnitude (anti-sycophancy).** Notoriety influences the new cast's
   `dayOnePerception` *leans* — it nudges the **direction** of NPC→player move-in edges (more wary of a
   known assassin, warmer toward a known loyalist). It **never** sets a raw number on a player-facing
   surface, never seeds the player's *own* edges, and — the load-bearing constraint — **never widens the
   bounded, seeded deltas the engine already owns.** It is a *direction* bias inside the existing
   `MOVE_IN.spread` envelope, exactly like `dayOnePerception` already is; the calibration floor cannot move
   (mandate #3; see R2).
3. **Cross-user isolation holds (0021).** Notoriety is keyed to the **physical-world user** and reads
   **only that user's own prior games**. No call for user A may ever fold user B's notoriety — the same
   first-class guarantee as the Vault Wall. It rides the existing per-user save key; there is no global
   leaderboard, no shared corpus (see R3).
4. **It is opt-in ⇒ byte-identical when off (anti-sycophancy / non-degradation).** With the feature flag
   unset, no summary is derived and no bias is folded, so `seedFirstImpressions` is byte-identical and the
   calibration spine (`juryReach`/UAT) is unmoved (see R4). A brand-new user with no prior season is the
   same as "off."

## The mechanic

### 1. The bounded notoriety summary — what crosses the season door

At the moment a season *finishes* (the existing endgame terminal, 0037 — `finished: true` with a winner),
the engine derives a **bounded, fixed-shape `NotorietySummary` from the finished season's open-set outcome
record** (placement, the eviction/vote record, the relationship trajectory at each eviction, the comp wins,
the jury read — all already recorded, all already the player's knowledge). The summary is **small and
capped** (the `THREAD.maxSurfacedPerSeason` sparseness sibling) — a *reputation*, not a transcript:

```
NotorietySummary {
  seasonsPlayed:  number              // monotonic — deepens, never thins (non-degradation)
  lastPlacement:  number              // 1 = winner, 2 = runner-up, … (open-set fact)
  bestPlacement:  number              // across all of THIS user's prior seasons
  reputation: {
    // a few BOUNDED, signed reputation facets in [-1,1] — derived from the open-set record,
    // NOT a Vault read. These are the dials the next cast's day-one read consults.
    loyalty:    number   // kept-deal / had-their-back record  → warmer day-one reads
    treachery:  number   // blindside / betrayal record        → warier, higher-threat reads
    competitor: number   // comp dominance                     → higher-threat, respect
    social:     number   // jury respect / bonds at eviction    → warmer, "heard you're good with people"
  }
  // a few SHORT, Vault-FREE legend clauses — the open-set "what they heard," for the narrator to voice
  // as a returning-cast callback. These are reputation *gist*, never a verbatim secret of anyone.
  legendBeats: string[]   // e.g. "ran the back half of their first season", "blindsided their own ally"
}
```

Crucially, **every field is computed from the open set** (ADR 0005): placements, votes, comp results, and
the eviction-trajectory respect the 0048 retrospective *already unseals to the player* are all facts the
player witnessed or were told. The Vault's *hidden* contents (other houseguests' secrets, off-screen scenes,
the hidden edge numbers) **do not cross** — the summary is derived *alongside* the sealed Vault, never *from*
it. `legendBeats` are short reputation glosses (the same register as 0101's player-subject rumor gloss),
authored from the open-set outcome, never a real secret.

### 2. Where it persists — the same per-user door, non-degrading

The summary is **user-account-level** (the same physical user across all their seasons), so it rides the
**existing per-user save key** (0021) — never a per-season/per-sandbox lifetime, and never the Vault. The
two clean options (an owner ruling, R1):

- **Recommended — a thin `UserNotorietyStore` port** (sibling to `UserSaveStore`, engine-only): `read(user)`
  / `accumulate(user, summary)`. It is **separate from the dead season's rotated save** so it survives
  `resetUser` by construction and is loaded once at the next `createCharacter`. It is **not** behind the
  dependency-cruiser Vault wall as secret state, but it **is** engine-only (an outward projection of it, if
  ever wanted, would be a deliberate, separate, Vault-free surface — out of scope v1). `accumulate` is
  **monotonic in `seasonsPlayed`** and merges `bestPlacement`/reputation, so notoriety *deepens* across
  seasons (mandate #4) — it never overwrites to a thinner state.
- **Alternative — a bounded field on the live snapshot** carried across the `resetUser` cutover the way
  `nextSeasonWarm` is. Simpler to wire (one field), but ties account-level reputation to the sandbox
  lifecycle; the standalone store is the cleaner concept and the recommendation.

Either way, **the dead season's full record stays on disk** (the rotation `resetUser` already does) — the
carried summary is the *bounded recall*, the disk is the *lossless archive*. Non-degradation holds twice:
the summary is monotonic, and the source is never destroyed.

### 3. How it influences the new cast — one bias term in the existing day-one fold

When the next season is created (`createCharacter` after `resetUser`), the engine **loads this user's
notoriety** and threads it into `seedFirstImpressions`. The fold is a **single new bias term beside the
existing `dayOnePerception` lean**, inside the *same* `MOVE_IN.spread` envelope:

```
// existing (0058 §3):  e.trust += MOVE_IN.spread * dayOnePerception.trustLean
// added   (0104):      e.trust += NOTORIETY.weight * notorietyTrustBias(summary, npc.character.archetype, rng)
```

- The bias is **per-NPC and archetype-shaded** (a paranoid archetype reads a known assassin as *more*
  threatening; a fan-of-the-game archetype reads a past winner with *more* respect/warmth) and **seeded** —
  same seed + same notoriety ⇒ same biased edges. It is **player-independent in shape** the way
  `dayOnePerception` is: notoriety is the *only* player-coupled input, and it enters as a bounded, signed
  direction, never a magnitude.
- `NOTORIETY.weight` is a **single tunable** in a `notorietyConstants.ts` (the `THREAD`/`GOSSIP`/`DRIVE`
  sibling, covered by the B59 grep gate) and is **bounded so the bias rides *inside* the scatter envelope** —
  it tilts the move-in distribution, it does not move the calibration floor (R2). It can be **0** (the
  off/flag-unset path), in which case `seedFirstImpressions` is byte-identical.
- The bias **never crosses to the player as a number** and is **never on any projection or admin surface**.
  A returning player feels it *only* through the new cast's behavior + the narrator's `legendBeats` callbacks
  ("a couple of them clearly recognize your name") — the read, the wariness, the warmth are the human's to
  *infer*, exactly as the Vault Wall + anti-sycophancy demand (mandates #2, #3; 0017/0020).

### 4. The returning-cast callbacks — texture, never machinery (ADR 0003)

The new cast's `dayOnePerception.read` (the prose clause) and the early-game narration may **voice** the
notoriety as a *recall*, not a remembered chat: the engine hands the narrator the Vault-free `legendBeats`
gist + the (hidden-shaped) day-one read, and the model improvises *"word is you're not someone to get on the
wrong side of."* This is the ADR 0003 spine: a fresh, light context that **recalls a past reputation from
the store**, never **remembers a past season's chat text**. The model is handed *facts to voice*, never a
*script*, and **never the raw reputation numbers** — only the gist and the (engine-decided) day-one leaning.

## Engine seams (where this lands)

- `src/engine/notoriety.ts` *(new)* — pure: `deriveNotoriety(finishedSeasonOutcome): NotorietySummary` (from
  the open-set outcome record — placement, votes, comp wins, eviction trajectory; **no Vault handle, no I/O**),
  `accumulateNotoriety(prior, fresh): NotorietySummary` (monotonic merge — non-degradation), and
  `notorietyBias(summary, archetype, signal, rng)` (the bounded, seeded, archetype-shaded day-one bias). No
  Vault handle by construction — it is handed already-read open-set facts and returns a bounded summary/bias.
- `src/engine/notorietyConstants.ts` *(new)* — the single `NOTORIETY` tunable (the day-one `weight` bound, the
  reputation-facet derivation weights, the `legendBeats` cap). The `THREAD`/`GOSSIP`/`DRIVE` sibling; the B59
  grep gate covers it.
- `src/ports/UserNotorietyStore.ts` *(new, recommended)* — `read(user)` / `accumulate(user, summary)`,
  engine-only, sibling to `UserSaveStore`, **keyed by the physical user (0021)** — never a cross-user read.
  (Or, the alternative: a bounded field on `SessionCore` carried across the `resetUser` cutover like
  `nextSeasonWarm`.)
- `src/composition/registry.ts` — at the season-end terminal, derive + `accumulate` this user's notoriety
  (best-effort, fail-soft — a failure to record notoriety must **never** block the endgame or the next
  season); at the next `createCharacter`, `read` it and hand it to the session for `seedFirstImpressions`.
  This rides the **existing** `resetUser` → `createCharacter` path (the single restart door) — **no second
  lifecycle path** is added.
- `src/adapters/engine/GameSessionAdapter.ts` — `seedFirstImpressions` gains the **one** notoriety bias term
  beside the `dayOnePerception` fold (engine-only, behind the flag, on the existing seeded rng so it is
  byte-identical when off). It reuses the deep-profile + relationship state it already holds.
- `src/engine/momentPrompts.ts` — the early-season `social`/intro moment may carry the Vault-free
  `legendBeats` gist as *texture* (a returning-cast callback the model voices) — never the numbers, never a
  script, and never asserted as fact the player must accept (ADR 0003 / 0005 — the human infers).

## Persistence (0007/0030 — non-degradation)

- The `NotorietySummary` persists at the **user-account level** (the recommended `UserNotorietyStore`, or
  the carried snapshot field) and is **monotonic in `seasonsPlayed`** and merges reputation/`bestPlacement`,
  so notoriety **deepens** across seasons and is never re-derived to a thinner state.
- The finished season's **full durable record stays on disk** (the rotation `resetUser` already performs) —
  the summary is the bounded recall; the archive is lossless. Non-degradation holds at both layers.
- A restored game in a *later* season recalls the accumulated notoriety exactly (it is loaded at season
  start and folded once); a season already in progress carries no live notoriety state to lose (the bias is
  applied once, at `seedFirstImpressions`, and is thereafter just the move-in edges — which persist normally).

## Determinism & calibration-neutrality (the load-bearing guarantee)

- **Opt-in ⇒ byte-identical.** Behind the feature flag, with `NOTORIETY.weight = 0` / no prior season, no
  summary is derived and no bias is folded ⇒ `seedFirstImpressions` is byte-identical and the calibration
  spine (`tests/property/juryReach.property.test.ts` + the UAT lane) is **unmoved**. This is the same guard
  0086/0085 hold (`ORWELL_CAMPAIGNS`); the juryReach `EARNED_WINS` floor must not move.
- **Seeded.** The bias runs on the existing day-one seeded rng — same seed + same notoriety ⇒ same biased
  edges; replays are reproducible.
- **The engine owns magnitude.** Notoriety enters as a **bounded, signed direction** inside the existing
  `MOVE_IN.spread` scatter envelope — it tilts the move-in *distribution*, it never sets a raw number and
  never widens the seeded deltas the engine already owns. A "veteran" player gets a *reputation that precedes
  them*, **not** a statistical edge in any competition or vote (anti-sycophancy).

## Testability (role-only; HARD rules)

- **Notoriety precedes the player:** a prior season finished with a *treacherous* outcome ⇒ the next cast's
  day-one NPC→player edges read **warier / higher-threat** than the same seed with no prior season; a
  *loyal/beloved* outcome ⇒ **warmer**. Asserted on the seeded move-in edges (the hidden layer), role-only.
- **Bounded — rides inside the scatter envelope:** the notoriety bias never pushes a move-in edge outside
  the existing `MOVE_IN.spread` band; the move-in *distribution* tilts, the bounds do not move (the proof it
  cannot become a calibration lever).
- **Vault Wall (incl. admin):** the `NotorietySummary` (its reputation facets, placements, season count) and
  the bias never appear on any player-facing **or** admin/God-Mode projection. **PO ruling 2026-11-01:** a NEW
  character is a clean slate; a RETURNING character (the `keepCharacter` opt-in) carries its legend, and its
  short `legendBeats` clauses are PUBLIC — but only through the sanctioned slots (the game-state
  `notorietyLegend` field and the narrator's "RETURNING CAST" line, premiere + week-1 social; #1791). The
  outward port method `notorietySummary()` is a legend-only projection. A sentinel sweep over the assembled
  day-one prompt + every projection finds no
  notoriety **number** and no sealed content from the prior season. The prior season's Vault stays sealed —
  a cross-check asserts no Vault record of season N−1 crosses into season N's summary.
- **The engine owns magnitude (anti-sycophancy):** notoriety never inflates the player's competition or vote
  odds — `runCompetition`/the seeded vote are byte-identical with vs. without notoriety at the same seed
  (notoriety touches *only* the day-one relationship edges, never an outcome roll). A "veteran" never wins
  more than the seeded floor dictates.
- **Cross-user isolation (0021):** user A's new season folds **only** user A's prior notoriety; a property
  test runs two users with different histories on the same seed and asserts A's day-one reads reflect A's
  past and **never** B's. One active game per user is unchanged (notoriety reads do not create a sandbox).
- **Non-degradation / monotonic:** `accumulate` only ever raises `seasonsPlayed` and merges
  reputation/`bestPlacement` — a later, *worse* season never thins the carried notoriety below what was
  earned; the finished season's full record remains on disk after `resetUser`.
- **Opt-in ⇒ calibration byte-identical:** with the flag unset (or no prior season / `weight = 0`),
  `seedFirstImpressions` is byte-identical and `juryReach`/UAT are unmoved — the permanent guard.
- **No new restart path:** notoriety derives + persists on the **existing** season-end terminal and folds at
  the **existing** `createCharacter`; a test asserts no second `resetUser`-equivalent door was added (the
  single-restart-door invariant, audit E1/D1/R1, holds).
- **Determinism:** seeded — same seed + same prior notoriety ⇒ same biased day-one edges + same `legendBeats`.

## Acceptance criteria

1. A finished season derives a **bounded, fixed-shape** `NotorietySummary` from the **open-set outcome
   record** (no Vault read), persisted at the **user-account level** (the same physical user), monotonic in
   `seasonsPlayed`.
2. The next season for **that same user** folds the notoriety into `seedFirstImpressions` as **one bounded,
   seeded, archetype-shaded bias term** beside the existing `dayOnePerception` lean — tilting the new cast's
   day-one NPC→player edges (warier of a known schemer, warmer toward a known loyalist).
3. The bias **never** reaches the player or admin as a number, and **no** prior-season Vault content crosses;
   the player feels it only through the new cast's behavior + the narrator's Vault-free `legendBeats`
   callbacks.
4. **Cross-user isolation holds:** a user's new season reflects **only their own** prior seasons — never any
   other user's. One active game per user is unchanged.
5. **The engine still owns outcome magnitude:** notoriety touches only day-one relationship edges; every
   competition/vote roll is byte-identical with vs. without it at the same seed (anti-sycophancy).
6. **Opt-in:** with the feature off (or no prior season), `seedFirstImpressions` is byte-identical and the
   `juryReach`/UAT calibration spine is unmoved; **no second season-restart path** is added (it rides the
   existing `resetUser` → `createCharacter` door).
7. **Non-degradation:** notoriety **deepens** across seasons (monotonic merge); the finished season's full
   durable record stays on disk (the existing `resetUser` rotation).

## PO review — owner rulings needed

This spec touches the seasons-as-levels spine, the Vault Wall, anti-sycophancy, cross-user isolation, and the
calibration floor at once, so it should not be built until the owner rules on four decisions. Each carries a
**recommendation**.

### R1 — WHAT persists across seasons (a bounded summary, not raw Vault state)

> *Decision:* What, exactly, crosses the season door — and is it ever raw Vault state?

**Recommendation: a small, fixed-shape `NotorietySummary` derived from the finished season's *open-set*
outcome record only** — placement, the vote/eviction record, the relationship trajectory at each eviction
(what the 0048 retrospective already unseals to the player), comp wins, jury respect — plus a few short
Vault-free `legendBeats` glosses. **No Vault record, no soul, no hidden edge, no other houseguest's secret,
no off-screen scene crosses.** The dead season's *full* record stays sealed on disk (non-degradation); the
summary is the bounded recall. This keeps the Vault Wall absolute (the summary is derived *alongside* the
sealed Vault, never *from* it) and is what the carry-over object should be — small, monotonic, open-set.
*(If the owner wants even tighter scope, a defensible v1 floor is placement + the four reputation facets,
deferring `legendBeats` to a fast-follow.)*

### R2 — HOW it influences a new cast's day-one reads (without breaking the calibration floor or seeded fairness)

> *Decision:* How does notoriety touch the new game — and does the engine still own the magnitude?

**Recommendation: a single bounded, seeded, archetype-shaded *bias term* inside `seedFirstImpressions`,
beside the existing `dayOnePerception` lean, riding *inside* the current `MOVE_IN.spread` scatter envelope.**
It biases the **direction** of the new cast's NPC→player move-in edges (more wary of a known assassin, warmer
toward a known loyalist) and **nothing else** — it never seeds the player's own edges, never sets a raw
number, never touches a competition or vote roll, and **never widens the bounded, seeded deltas the engine
already owns** (mandate #3). The calibration floor cannot move because notoriety touches *only* day-one
relationships, never an outcome — proven by the byte-identical `juryReach`/UAT guard. This is the cleanest
fit: it reuses the exact fold `dayOnePerception` already uses, and the engine stays the dictator of magnitude.

### R3 — cross-user isolation + one-active-game-per-user (0021)

> *Decision:* Whose notoriety can a new season read?

**Recommendation: notoriety is keyed to the *physical-world user* and reads *only that user's own prior
games* — a first-class guarantee alongside the Vault Wall, exactly as 0021 demands.** No global leaderboard,
no shared corpus, no cross-user read — user A's new season can never fold user B's notoriety. It rides the
**existing per-user save key** (the same key `UserSaveStore`/`sandboxFor` use); the recommended
`UserNotorietyStore` is per-user by construction. One active game per user is unchanged — reading notoriety
at season start does not create or resume a second sandbox. A cross-user isolation property test is a
**hard gate** (it sits beside the Vault sentinel as a non-negotiable).

### R4 — opt-in

> *Decision:* On by default, or opt-in?

**Recommendation: opt-in, behind a feature flag, ⇒ byte-identical when off.** With the flag unset (or a
brand-new user with no prior season, or `NOTORIETY.weight = 0`), no summary is derived and no bias is folded,
so `seedFirstImpressions` is byte-identical and the calibration spine is unmoved — the same discipline
0085/0086 hold behind `ORWELL_CAMPAIGNS`. This keeps the calibration floor provably safe and lets the
mechanic be tuned against the UAT before it is ever the default. *(A reasonable later step, once tuned, is to
default it on for users **with** a prior season — but v1 should ship opt-in so the byte-identity guard is the
proof.)*

---

Tracks #886.
