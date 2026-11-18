# 0025 — Reserve twists (Vault-sealed, engine-timed)

> **Status:** Built. **REACTIVE REDESIGN (PO ruling 2026-07-06)** — see §0. A **curated pool of classic,
> non-structural twists** held **in reserve**. The engine decides **if and when** one fires — and the twist
> (what *and* when) is **sealed in the Vault so neither the player NOR the admin knows in advance**. Variety
> and surprise without breaking the jury-9 → final-2 core.
> **Executable spec:** [`0025-reserve-twists.feature`](./0025-reserve-twists.feature)

## 0. Reactive redesign (PO ruling 2026-07-06) — the current, built model

The original model (below, §1–§12) **pre-scheduled** at most one twist at setup and only ever implemented
the **double eviction** live. The PO redesigned it so **all three** twists (double eviction, secret veto,
returning-juror battle-back) are **real and live**, and the whole pool is **reactive**:

- **A standing pool, not a pre-pick.** All three twists sit armed from game start, each **watching the live
  house**; a twist fires when the house reaches a state that *earns* its trigger — never a week chosen at t=0.
- **Dynamic, per-season triggers.** Each twist's threshold is **re-rolled every season** (double eviction
  targets a seeded house size; secret veto waits for a seeded lopsided-eviction streak; battle-back opens in
  a seeded early-jury window), so the same conditions **do not recur** across playthroughs — reducing
  predictability. Within one season everything stays **reproducible** under the seed (saves + tests).
- **Hold-back.** Even an earned trigger can be **held back** by a seeded per-season arming roll, so some
  seasons stay quiet and twists stay special.
- **All three, each at most once.** A season can see **0–3** twists; one arms per week roll (a cooldown that
  spaces them), and none blocks another.
- **The player plays their own.** A secret veto the **player** secretly holds is **theirs** to play (pull
  off the block) or hold — surfaced as a real `secret-veto` decision; a battle-back the player is in, they
  **compete** in. NPC-held twists are engine-resolved.
- **The three mechanics.** Double eviction = the existing compressed second cycle. Secret veto = a one-time
  **safety**: when the holder is on the block they come off, the HOH names a replacement — still exactly one
  eviction that week. Battle-back = the recently-evicted **jurors compete and one re-enters**; the returnee's
  first eviction is voided and they can be re-evicted, so the finale still closes at **jury-9 → final-2**.
- **Still sealed from player AND admin**, still **format-preserving**, still **deterministic**, still
  **durable** (the sealed plan rides the persisted loop state).

Gated behind **`ORWELL_REACTIVE_TWISTS`** (default **off** ⇒ the legacy §1–§12 pre-scheduled path is
byte-identical, so the tuned calibration baseline is untouched; **on** ⇒ the reactive pool). Built in
`src/engine/reserveTwists.ts` (`planReserveTwists`/`triggeredTwist`) + `src/engine/liveSeason.ts` (the three
mechanics) + `src/adapters/engine/GameSessionAdapter.ts` (arming + the `secret-veto` player decision).
Gates: `tests/unit/reserveTwistsReactive.test.ts`, `tests/unit/reactiveTwistsLive.test.ts`, and the
reactive `0025-reserve-twists.feature`.

---

*The original pre-redesign spec follows (§1–§12), retained for provenance — the legacy flag-off path.*

## 1. Summary

Reality *Big Brother* runs on the occasional production twist. Orwell keeps **1–2** in **reserve**
per game (admin-enabled count, 0016) drawn from a **curated pool** of **non-structural** twists —
a secret veto, a double eviction, a returning-juror battle-back, and the like. The engine, seeded,
decides **whether** a reserved twist is in play and **when** it fires (a dramatic beat). Until it
fires, the choice and its timing are **Vault-sealed** — a genuine surprise to the player, and
**also unknown to the admin** (mandate #2: the human has never read the Vault, *including* the
admin who switched twists on). When it fires it becomes a witnessed in-game event; only then is it
known.

## 2. Scope

**In:** the curated reserve **pool**; the engine's seeded **if/when** firing at a dramatic beat;
**Vault-sealing from both player and admin**; the **reveal-as-event**; the **format-preserving**
constraint (twists never break the core arc or the hard rules).

**Out:** the core weekly loop (**0011**); eligibility/legality (**0005** — invariant *under* twists,
already tested); the admin **enable knob** (**0016** — it sets the *count*, never the content); the
Vault-Wall mechanics themselves (**0001** — reused on both surfaces).

## 3. The pool (curated, non-structural)

A small, curated set of **classic, format-preserving** twists. Illustratively (the implementer
curates the exact pool):

- **Secret veto** — a houseguest secretly holds a one-time power (e.g. a special veto, a vote
  nullifier, a power to save) they may play at a key moment.
- **Double eviction** — a compressed week where two houseguests leave.
- **Returning-juror battle-back** — an evicted juror earns their way back via a competition.

Every pool entry is **non-structural**: the season still lands at **jury-9 → final-2**, and the
hard rules (0005) still hold. Twists add variance *along the way*, never a new backbone.

## 4. Engine-timed & seeded

- **Whether:** at most the admin-enabled count (0016) is in play; often **none**. The engine seeds
  whether a reserve twist is loaded for this game.
- **When:** the engine fires it at a **dramatic beat** (a close vote, a power shift, a milestone),
  decided by the seeded `RandomnessSource` — so the same seed reproduces the same twist + timing,
  and the distribution is testable. Rare by construction.

## 5. Vault-sealed — from the player AND the admin

The chosen twist(s) + their trigger/timing are **Vault content** (engine-only). They never reach:

- **the player** — that is the surprise; and
- **the admin / God Mode** — the admin who set "reserve twists: 1" (0016 §5) does **not** learn
  *what* it is or *when* it fires. The engine **generates and seals** it; even God Mode can't peek
  (mandate #2 — spoilers ruin the game above all else).

So a reserve twist is the cleanest demonstration of the Vault Wall protecting **everyone**: the
producer's secret no human has read.

## 6. Reveal (firing)

When the engine fires a twist it becomes a **dramatic, witnessed in-game event** — the narrator
voices it (0018), it enters knowledge (0002), and the mechanic applies. Before firing it is silent
and sealed; after firing it is simply part of the game's history. There is no "a twist is coming"
tell on any surface.

## 7. Format-preserving (the hard guarantee)

A firing twist **never** breaks: the **Vault Wall** (0001 — its existence wasn't leaked, its
mechanic obeys the wall), **eligibility/legality** (0005 — e.g. the outgoing-HOH and veto-winner
rules still hold even in a double eviction), or the **core arc** (still 16 → jury-9 → final-2). The
0005 invariants are explicitly required to hold *under* a reserve twist.

## 8. Contracts (stack-agnostic)

```
# Vault content (engine-only) — sealed; surfaced to NO ONE until it fires:
ReserveTwist { kind, trigger, /* when */ }              # in the Vault (0001); count bounded by admin enable (0016)

# Engine, per beat (seeded):
maybeFireTwist(state, rng) -> TwistEvent | none         # fires at a dramatic beat; rare; deterministic by seed
# On fire: record a witnessed reveal event (0002) + apply the (format-preserving) mechanic.
```

**Invariants:** a sealed twist is **sentinel-clean on BOTH the player and the admin surfaces** until
it fires; enabling twists (0016) reveals neither content nor timing; firing is **seed-deterministic**
and **rare** (≤ the enabled count); a fired twist is a recorded event; eligibility (0005) and the
core arc hold under any twist.

## 9. Test strategy

- **Sealed from everyone:** with a reserve twist loaded, across seeded play **no** player surface
  **and no admin surface** reveals it until it fires (extends the 0001 canary to *both*, and
  cross-checks 0016 §5 — the admin who enabled it stays blind).
- **Fires rarely, deterministically:** over many seeds, at most the enabled count fires, at a
  dramatic beat; same seed ⇒ same twist + timing.
- **Reveal is an event:** a fired twist produces a witnessed event and applies its mechanic.
- **Format-preserving:** under a fired twist, the 0005 eligibility invariants still hold and the
  season still reaches jury-9 → final-2 (cross-checks 0005/0011).
- **No tell:** no surface hints a twist is pending before it fires.

## 10. Definition of Done

- [ ] A reserve twist (content + timing) is **Vault-sealed** and provably invisible to **both** the
      player and the admin until it fires (sentinel-clean on both; ties 0016 §5).
- [ ] Firing is **seed-deterministic**, **rare** (≤ the admin-enabled count), at a dramatic beat.
- [ ] A fired twist is a **recorded, witnessed event**; the narrator can voice it (0018).
- [ ] Eligibility (0005) and the core arc (16 → jury-9 → final-2) **hold under** any twist.
- [ ] No surface tells that a twist is pending.

## 11. Dependencies

**0001** (Vault Wall — the twist is sealed, on player *and* admin surfaces), **0016** (admin enables
the *count*, never the content/timing — 0025 is its consumer), **0005** (eligibility invariant under
twists), **0011** (the loop a twist perturbs), **0002** (the reveal becomes knowledge), **0018**
(the narrator voices the reveal), seeded `RandomnessSource`.

## 12. Traceability

`CLAUDE.md` ("Classic format, no core-structure twists — one or two production twists may be held
in reserve"; God Mode walled from the Vault even for the admin); `docs/features/0005` (1–2
Vault-held reserve twists; invariants hold under them); `docs/features/0016` §5 (enable without
learning content/timing); mandate #2 (the human/admin has never read the Vault).

## 13. Amendment (2026-11-18, ORW-652): the double eviction is one long night

Ryne (11-17): the double eviction should play as one fast, chaotic night: the first eviction, an instant Head of Household, hurried nominations, a rushed veto, the second eviction, all in one evening.
Checked in a played game first. Before this change the format was right (new HOH, nominations, veto and vote in the same week, the same hard rules) but the clock was not: the second cycle charged full
hours per beat, so a night that began at the evening eviction ran past the 8am wake; the day then rolled in the middle of the second ballot reveal, and the schedule gate held the second eviction until
the next evening (a 480-minute hold), with an extra 60-minute draw-to-competition hold inside the night.

**What changed (played games only, flag `ORWELL_LONG_NIGHT`, default ON; off or headless is byte-identical):**

- While the second cycle runs (`longNightRunning`: the twist is `double-eviction`/`running` in a played game), every beat charges a fraction of its usual hours (`LONG_NIGHT_BEAT_SCALE`, a quarter), and the
  clock never rolls the day: the whole night ends around three hours after the first eviction, and the one day roll is the ordinary morning after.
- The schedule treats each ceremony of the second cycle as due the moment the one before it ends (no afternoon to wait for, no draw-to-competition gap), so the advance gate never holds the night.
- Nobody can turn in mid-night: `turnIn` is held (typed, nothing commits) until the second eviction is done; the bedtime is the player's own again the moment the night ends.
- The narrator is handed one per-turn board line (third person, public facts only: who has just been evicted, who holds the instant crown, who is on the block once named). It is a fact to voice, never a script.

**Unchanged on purpose:** every roll and draw (the same seed yields the same evictees and Heads of Household with the compression on or off, pinned in `tests/unit/longNight.test.ts`), the eligibility rules (the
outgoing HOH cannot take the second crown), the presentation-over-one-roll staging of competitions and ceremonies, and the player's agency in every seat (instant HOH, nominee, evicted in either eviction).
Gate: `tests/unit/longNight.test.ts` + the three `long night:` scenarios in `0025-reserve-twists.feature`.
