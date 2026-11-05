# 0122 — Deeper, daily NPC confessionals (richer interiority, on the in-game clock)

> **Status:** ✅ Built (BDD/TDD-first; BDD-gated in `cucumber.cjs`). **Expands 0040** (NPC Diary Room confessionals) per the PO review
> (2026-07-12). 0040 gives every NPC a *real, private, engine-grounded* read — but today it is **thin**
> (biggest threat + most-trusted ally + a mood) and **rare** (only the 3–5 houseguests standing in a
> ceremony confess, plus one random off-screen confessor per tick). This feature makes NPC confessionals
> **deeper** (five new grounded facets) and **daily** (a once-per-in-game-day sweep where *most* living
> houseguests confess, unless their game is bare). Everything stays **Vault-only** (sealed from the player
> AND admin) and **calibration-safe** (default-off flag + dedicated randomness ⇒ byte-identical until the
> deploy turns it on).
> **Executable spec:** [`0122-deeper-daily-npc-confessionals.feature`](./0122-deeper-daily-npc-confessionals.feature)
> **Also proven by:** `tests/unit/deeperConfessionals.test.ts`

## 1. Summary

Real _Big Brother_ cuts to the Diary Room constantly — most houseguests, most days, saying what they
actually think: their plan, whether they feel safe, who wronged them, how a conversation just landed, and
their reaction to what happened to the people they care about. 0040 built the *mechanism* (an NPC's private,
engine-true read, walled from everyone) but wired it thin and rare. This feature closes the gap the PO named
in review:

- **Deeper.** A confessional today says *"{target} is my biggest threat, {ally} is the one I trust."* We add
  five more grounded facets it *can* draw on: their **plan**, their **standing**, a **grudge**, the
  **aftermath of a big conversation**, and their reaction to an **adjacent move** (something that happened to
  an ally / showmance / target). **These are NOT a checklist** — a confessional carries **only the facets the
  moment actually triggers**, so depth is *earned by situation*: the **HOH and the nominees** (real power, real
  danger) naturally get the **deepest** confessionals — a plan to voice, a safe-or-exposed read — while a
  houseguest coasting in the middle says less. Nothing happening to you ⇒ a short read (or, if truly bare,
  none).
- **Daily.** Instead of only ceremony-standers + one random off-screen confessor, once per **in-game day**
  (the 0066/0117–0119 clock) *most* living houseguests confess — **unless their game is bare** (nothing
  meaningful happened to them **and** they hold no clear target or ally). An active player confesses daily; a
  true wallflower stays quiet until the house touches them.

The hard line is unchanged from 0040: every facet is **queried from engine truth, never invented**
(anti-sycophancy #3), recorded **Vault-only** — witnessed by the confessing NPC alone, reaching **no one**,
player or admin (Vault Wall #1/#2) — and **folded into the soul** so the NPC's later voice stays consistent
(non-degradation #4). It only deepens the hidden interiority the player *feels* through behavior, never sees.

## 2. What exists today (the gap this closes)

| | Today (0040 + 0089/0090/E55) | After 0122 |
|---|---|---|
| **Content** | biggest threat + most-trusted ally + reactive opener + coarse mood, in-voice | + **plan**, **standing**, **grudge**, **big-conversation aftermath**, **adjacent move** |
| **Who confesses** | only ceremony-standers (HOH + noms + veto-involved), ~3–5/week; **plus** one random off-screen confessor per tick | **most living houseguests, once per in-game day** (bare games skipped) |
| **Anchor** | ceremony beats + off-screen ticks | + the **in-game day boundary** (0117–0119 clock) |

- The composer `confessionalFor` (`src/engine/confessionals.ts`) already takes a rich `ConfessionalContext`
  (trigger, mood, voice, recent-event gists, player-as-subject, name resolver) — this feature **extends the
  content it can voice**, it does not rebuild it.
- No per-day, per-NPC confessional sweep exists anywhere. There is no "bare game" gate. The five new facets
  do not exist in any form (0089 adds a reactive *opener*, not strategic substance; 0090 is phrasing only;
  0115 is the *player's* diary room — a different feature).

## 3. Scope

**In:**
- **Five new grounded facets** on the confessional content, each surfaced only when the engine actually
  supports it (no invented stance), all Vault-safe (no number, no other houseguest's sealed state):
  1. **plan** — the confessor's intended next move, grounded in their **target** + their live **role**
     (HOH → "my noms go at {target}"; veto-holder → veto intent; nominee → "I need to win to save myself";
     otherwise → "if I get power, {target} is the name").
  2. **standing** — do they feel **safe or exposed**, grounded in **public role state they witnessed**
     (on the block ⇒ exposed; HOH / veto-holder / just came off the block ⇒ safe; else ⇒ reading the room).
     *Never* read from other houseguests' hidden threat-of-me edges (that would cross the wall).
  3. **grudge** — the peer they hold the strongest **betrayal-shock** against (0026 signal), surfaced as a
     wound **distinct from** their current target when a different peer qualifies; omitted when none.
  4. **big-conversation aftermath** — the most salient recent **social** scene they were in and **how it
     sat** with them (the partner + the direction their read moved: warmed vs. put on edge).
  5. **adjacent move** — a reaction to a recent **public beat** (comp/ceremony/eviction they witnessed) whose
     participant is a **relation of theirs**, read through that bond ("my ally took power"; "they put my
     closest ally on the block"; "the one I'm gunning for just won HOH").
- **A once-per-in-game-day confessional sweep** for the living NPCs, anchored to the in-game **day boundary**
  (0066/0117–0119), with a **bare-game skip** (an NPC with no recent salient witnessed event **and** no clear
  target/ally records nothing that day).
- **Calibration safety:** the whole feature is behind a **default-ON** flag `ORWELL_CONFESSIONAL_DEPTH` (`=0` opts out) and
  drives a **dedicated** seeded rng (the `confessional:` family already used for phrasing/recency) — never the
  shared society/vote stream — so with the flag off the confessional stream + the seeded spine are
  **byte-identical** to 0040. Turned on in the real deploy (`smoke.sh` + `orwell-install.sh`, per the
  0117/0120/0121 pattern). The daily sweep only runs when the **in-game clock is live**
  (`perConversationClockLive()`), which was pinned off in the (since-decommissioned, 2026-07-21) golden driver; clock-off neutrality is now guarded by
  `perConversationClockNeutral`.

**Out:**
- The **player's** Diary Room (0013/0115 — separate, OOC, player-facing). Untouched.
- Surfacing confessionals to **anyone** (still Vault-only — the whole point). No new player/admin surface.
- Any change to NPC **decisions/outcomes** — confessionals remain a *read* of engine truth, never an input to
  it. The seeded competition/vote/deal spine is not touched (byte-identical off; dedicated rng on).
- Narration wording quality (the engine supplies the grounded facts; the FE/LLM may only *voice* a
  confessional when legitimately recalling for **that same NPC**, never leak it to another).

## 4. Design

- **Facets are TRIGGERED, not templated (the core principle).** A confessional is **not** a fixed 7-slot
  form. Each facet has a **trigger condition**; it renders **only** when that condition is met, so a
  confessional's depth tracks the confessor's real situation. Depth is *earned*:

  | Facet | Triggered when… | So the deepest confessionals belong to… |
  |---|---|---|
  | target / ally (0040) | they hold any clear threat/bond read | anyone with a real read |
  | **plan** | they hold **power or a live move** (HOH, veto-holder, or a clear target to act on) | **the HOH** |
  | **standing** | their **public role changed their safety** (on the block, or just took/lost power) | **the nominees** (exposed) & the HOH (safe) |
  | **grudge** | a peer wronged them (a real betrayal-shock signal), distinct from the target | anyone recently betrayed |
  | **big-conversation aftermath** | they just had a **significant social scene** that moved a bond | anyone in a charged talk |
  | **adjacent move** | a **relation of theirs** was in a recent public beat (ally won power, showmance nominated) | anyone whose people just moved |

  A houseguest with power *and* danger *and* a fresh betrayal confesses a rich, multi-part read; a quiet
  middle-of-the-pack houseguest with only a target confesses a short one; a bare game confesses nothing.

- **Facet builders (pure, grounded).** Extend `confessionalFor` (or a sibling `deepConfessionalFacets`) to
  compute the five facets from the confessor's **own** relationship edges + **public** role/beat state only:
  - `plan` reads `target` (already computed) + the live `hoh/vetoHolder/nominees` role → a bounded phrase.
  - `standing` reads only **public** role state the confessor witnessed (nominated / HOH / veto-holder /
    off-the-block) → safe|exposed|reading. No hidden edge of anyone toward the confessor is read.
  - `grudge` reads the confessor's own edges for the strongest betrayal-shock peer (0026), prefers a peer
    ≠ `target`, omits when none is meaningfully present.
  - `bigConversationAftermath` picks the top recent **social** event the confessor witnessed
    (`selectRecentForConfessional` already ranks these), names the **partner**, and reads the **direction**
    of the confessor's edge toward them (warmed/cooled) → an aftermath line.
  - `adjacentMove` scans the confessor's recent **witnessed public beats** for a participant that is the
    confessor's ally/target/strong-bond → a relational reaction line.
  Each facet is **optional**: it renders only when grounded, so the content grows/shrinks with the NPC's real
  game (bare ⇒ little to say). No facet ever carries a number or another houseguest's sealed read.
- **The daily sweep.** A new `dailyConfessionalSweep` runs at the **in-game day rollover** (detected off the
  0117–0119 clock in `GameSessionAdapter` / the orchestrator tick): for each living NPC, build the deep
  confessional; **skip** it if bare (`isBareGame(npc)` — no recent salient witnessed event **and** no clear
  target/ally); record the rest Vault-only + fold to soul (exactly the 0040 recording path). Bounded to **one
  confessional per NPC per in-game day**. Uses a **dedicated** day-keyed seeded rng.
- **Bare-game gate (`isBareGame`).** True when the NPC has **no** recent salient witnessed event
  (`selectRecentForConfessional` returns nothing above `flavor`) **and** their reads name **neither** a clear
  target **nor** a clear ally. Anyone with any real hook confesses; a pure wallflower waits.
- **The wall (unchanged, structural).** Every confessional — deep or shallow — is recorded `hidden: true`,
  `witnessSet:[npc]`; the player is **never** a witness (0002), and the admin surface reads no events
  (0001/0016). The five new facets add **content**, not **reach**: they are still sealed from everyone. The
  0001 sentinel canary already covers confessional content on both surfaces; this feature keeps it green.

## 5. Contracts (stack-agnostic)

```text
confessionalFor(npc, others, rel, ctx): Confessional     // ctx gains grounded role/beat inputs; content may
                                                         // now carry plan / standing / grudge / aftermath /
                                                         // adjacent-move facets — each optional, engine-true
isBareGame(npc, rel, recentFacts): boolean               // no salient recent witnessed event AND no clear
                                                         // target/ally ⇒ the NPC stays quiet this day
dailyConfessionalSweep(...): void                        // once per in-game day, most living NPCs confess
                                                         // (bare skipped); records Vault-only + folds to soul
flag: ORWELL_CONFESSIONAL_DEPTH (default ON; =0 opts out)            // off ⇒ byte-identical to 0040; dedicated rng only
gate: perConversationClockLive()                         // the daily sweep only runs when the clock is live
                                                         // (clock-off ⇒ sweep inert; guarded by perConversationClockNeutral)
wall: record{ hidden:true, witnessSet:[npc] }            // player NEVER a witness; admin reads no events (0040)
```

## 6. Definition of Done

- [x] **Deeper content, TRIGGERED not templated:** a confessional can voice **plan / standing / grudge /
      big-conversation aftermath / adjacent move**, each **grounded** in the NPC's own edges + public state
      (a flip of the underlying truth flips the facet; nothing is invented), and each rendered **only when its
      trigger fires** — so an **HOH / nominee** (power / danger) gets a **deep** confessional while a coasting
      middle houseguest gets a **short** one, and a bare game gets none. No fixed multi-slot form.
- [x] **Daily frequency:** once per in-game day, **most living houseguests** record a confessional (not only
      ceremony-standers); a **bare game** NPC records **none** that day.
- [x] **Vault-sealed from everyone (unchanged):** no confessional content reaches the **player** or
      **admin/God Mode**; witness set excludes the player (0002); the 0001 canary stays clean on both surfaces.
- [x] **Feeds the soul + voice:** each confessional appends to the soul (monotonic, 0024/0007) and is
      recall-able to keep that NPC's later voice consistent (as 0040 already does).
- [x] **Calibration-neutral:** with `ORWELL_CONFESSIONAL_DEPTH` **off**, the confessional stream + the seeded
      competition/vote/deal spine are **byte-identical** to 0040 (juryReach / gradient / UAT unchanged); the
      daily sweep draws a **dedicated** rng and runs only when the in-game clock is live (clock-off neutrality guarded by
      `perConversationClockNeutral`).
- [x] Seed-deterministic; persisted (0030); name-agnostic (roles only); added to `cucumber.cjs`;
      `npm test` + `npm run test:arch` green; FE `pytest -m "not browser"` green.

## 7. Dependencies & traceability

Deepens **0040** (NPC confessionals — `confessionalFor` / `recordConfessional` / the ceremony + off-screen
call sites), reusing **0089** (recent-event selection), **0090** (voice phrasing), and **E55** (structured
context) as-is. Grounded in **0017/0026** (relationship reads + betrayal-shock) and **0024** (`SoulStore`
recall), sealed by **0001** (Vault Wall, incl. **0016** God-Mode walling) + **0002** (witness-derived hidden
visibility), and **paced by the in-game clock** (**0066** + the **0117–0119** pivot — the daily anchor).
Surfaces (still Vault-only) into the **0048** retrospective through the same soul/event path 0040 feeds.
Calibration-neutral by construction: default-off flag + dedicated rng + clock-live gate ⇒ byte-identical to
0040 until the deploy turns it on (the **0117/0120/0121** shipped-flag pattern).
