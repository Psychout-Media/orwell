# 0102 — Weekly recap + cliffhanger (each HOH-week is an episode)

> **Status:** ✅ **BUILT (engine side), 2026-07-05 — the REDESIGNED daily recap (#884).** Per the owner's
> 2026-06-27 redesign below, this shipped as a **daily "day in review" digest** fired at the player's own
> in-game **bedtime** (`turnIn`, ADR 0006) — REPLACING the weekly-recap mechanic this file originally
> proposed (the scenarios further down describe that superseded weekly design; treat the summary here as
> authoritative). Engine seams: `src/ports/GameSession.ts` (`DailyRecapView`/`DailyRecapHook`,
> `AdvanceView.dailyRecap`, the `dailyRecap()` read), `src/engine/liveSeason.ts` (`LiveSeasonState`'s
> `dayNumber`/`dailyRecapEventCursor`/`dailyRecapKnowledgeCursor`/`lastDailyRecap`), and
> `src/adapters/engine/GameSessionAdapter.ts` (`materializeDailyRecap`/`buildDailyRecapHook`, wired into
> `turnIn()`; `dailyRecap` is also a player MCP tool for re-fetching the same day's digest). A
> `momentPrompts.ts` glossary bullet frames the narration rules (facts to voice; the hook is a
> possibility, never a committed outcome). Vault-free by construction (reads only the same
> witnessed-event + `playerKnowledgeReader` projections `seasonRecap()`/`freshSurfacedFacts()` already
> serve — no `VaultStore` import); the hook rides a DEDICATED `daily-recap:<day>` side rng (never the
> season/vote/jury stream) so it perturbs no seeded outcome. Gate: `tests/realpath/dailyRecap0102.test.ts`
> (13 cases — dormancy, witnessed+surfaced-only, the Vault sweep, the non-committal hook, reproducibility,
> the MCP boundary dispatch). **Not built:** a literal FE **pop-up window** surface (the "window kit" the (ORW-824)
> PO note below imagines) — the digest is delivered as an **in-fiction narrator beat in the chat** per the
> original design's own R1 recommendation (ADR 0003: augment, never a dashboard the player must dismiss);
> a dedicated FE window remains optional future follow-on if the owner still wants one. This filename
> remains a misnomer (kept as-is to avoid colliding with the numbering-collision cleanup already
> in flight — see 0111's renumbering note in `docs/features/README.md`); do not re-file this as a
> weekly mechanic.
>
> **Original PO ruling (2026-06-27), preserved for context:** 🟢 **PO REVIEW RESOLVED — REDESIGNED.** Now a
> **daily "day in review" pop-up window** (window kit) fired at the player's in-game **bedtime** (0066),
> **replacing the weekly recap**; Vault-safe (the player's witnessed/known events only); the "tomorrow…"
> forward-nod stays non-committal and suppresses on a quiet day. See `docs/decisions/PO-DECISIONS-LOG.md`
> (2026-06-27) + #884. **Tracks #884.**
> **Depends on:** 0001 (Vault Wall — the whole safety argument), 0002 (event visibility & the
> `surfaceInformationTo` pathway model — what counts as the player's knowledge), 0048 (the
> post-season recap precedent — `seasonRecap()` is the structural template this generalizes to a
> *week*), 0018/0019 (the narration moment seam — `momentPrompts` / `getMomentPrompt`,
> `renderStoryFacts`). **Sibling/companion of:** **0103** (the edit-bay foreshadowing spec — 0102
> stitches the *closed* recap of the week just played; 0103 is the *forward* tease woven into live
> narration. They share the Vault-safety rule in R2 and should be read together). **Bounded by:**
> mandate #1 (behavioral fidelity — this is *texture*, the episode shape a real _BB_ season has),
> mandate #2 (Vault Wall — **witnessed + already-surfaced material only**; no Vault read, no admin
> hole), mandate #3 (anti-sycophancy — the recap is the *record* recalled, never a flattering
> re-telling), mandate #4 (non-degradation — it reads the durable event store, which only deepens),
> ADR 0003 (the conversation is the game — it surfaces *in fiction*, augments and never replaces
> play), ADR 0005 (split authority by openness — the cliffhanger may foreshadow an in-motion
> *open-set* thread but may never **commit the engine** to a *closed-set* outcome).

## Why

A real _Big Brother_ season is **bingeable because it is episodic**. Each HOH-week is a self-
contained arc with a shape: a cold open, the comp, the scheming, the ceremonies, the eviction — and
then the hook that makes you start the next one ("next week, an alliance cracks…"). That episode
rhythm is most of what makes the format *moreish*; without it a season is an undifferentiated stream
of beats and the player loses the satisfying sense of "a chapter just closed."

Today the engine has the **post-season** payoff (0048: `seasonRecap()` assembles the public arc from
the event record, and the retrospective unseals the hidden story once the season is over) but nothing
gives a **single week** that episodic shape *during* play. When a week rolls over — an eviction
resolves, the next HOH begins — the player crosses the seam with no "previously, and here's where it
left us" beat. The week that just happened is in the store, recalled only if the player asks.

This feature gives each completed HOH-week a short, **Vault-safe weekly digest** — stitched from the
player's **witnessed events** plus **gossip that has already surfaced to them** — that ends on a
**cliffhanger hook** anchored to a thread *already in motion*. It is the weekly analog of 0048's
season recap: same structural source (the event store, not narrator memory), same Vault-free
guarantee, narrower scope (one reign), and a forward-looking tail the season recap doesn't have.

## Episodic-retention value (why this earns its tokens against ADR 0003)

ADR 0003's litmus: *does this keep the model creative and the context light while strengthening one of
the four fixes?* This earns it on **memory** and **sameness**:

- **Memory (fix #3 → mandate #4).** The recap is the **store recalled, never the chat remembered**
  (ADR 0003 principle #6 / 0048 principle #7). A player returning after days away, or after a fresh
  context window, crosses the week-seam and is *correctly* re-grounded in what they actually lived —
  the digest is rebuilt from the durable record every time, so it can never thin or drift.
- **Sameness (fix #4).** Two seasons produce two different weekly arcs because the *events* differ;
  the episode shape is identical but its content is whatever genuinely happened. The cliffhanger,
  anchored to a real in-motion thread, makes each week's hook specific to *that* season.
- **It augments, never replaces (ADR 0003 principle #4).** A recap reflects play that already
  happened and frames the seam between episodes; it builds or progresses *nothing*. The player makes
  no decision in it, and skipping it costs them no agency — it is pure texture over the closed week.

## The mechanic

### 1. The unit: a *completed* HOH-week

A "week" is one HOH reign (`CLAUDE.md`: HOH comp → eviction). The recap fires **on the week-roll** —
the moment an eviction resolves and the next HOH beat is about to begin — because that is exactly the
episode boundary. It is a **lifecycle beat** (B62 family: a server-initiated re-entry / recap moment),
*not* a panel the player opens and *not* a thing the model invents mid-week.

### 2. The recap body: stitched from witnessed + already-surfaced material only

A new engine read — call it **`weeklyRecap(week)`** — assembles a short digest of the week that just
closed, drawn from exactly two Vault-free sources, both already first-class in the engine:

- **The player's witnessed ceremony + scene events** for that week — the same structural filter
  `seasonRecap()` already uses
  (`!e.hidden && (e.id.startsWith("season:") || e.type === "deal" || e.type === "betrayal")`),
  **scoped to the week**: the HOH win, the nominations, the veto and its ceremony, the eviction, plus
  the player's own recorded scenes/deals (0002/0023 — all player-witnessed by construction).
- **Gossip that has already surfaced to the player** — facts that reached the player's knowledge
  through a modeled pathway (0002: a houseguest told them, they overheard, `surfaceInformationTo`
  terminated at them). These are *already the player's knowledge* (Journal-visible), so re-stating
  them in a recap crosses no wall. A rumor still diffusing in the hidden layer that has **not** reached
  the player is **excluded** — the recap can only retell what the player already holds.

The read returns **facts** (the `SeasonRecapView` / `renderStoryFacts` shape — content strings),
never prose. The narrator voices them in the recap beat. This is ADR 0003 principle #2 (*hand the
model facts to voice, never scripts to recite*) and 0005 (the open-set texture is recorded losslessly
and recalled in full; the recap reads it back, it does not normalize it).

### 3. The cliffhanger: a hook over a thread *already in motion* — never a commitment

The episodic payload is the **hook**. The recap ends on a forward tease ("next time, a secret comes
out…", "the alliance you just watched form is already cracking…"). This is the most delicate part and
is the subject of **PO ruling R2**. The hard rule:

- The teaser may **only foreshadow a pathway the player can already perceive is in motion** — a
  witnessed tension, a deal under strain the player is party to, a rumor that has *already surfaced to
  them*. It dramatizes *what the player already knows is brewing*; it reveals nothing new.
- The teaser **never reads the Vault** — no undisclosed secret, no off-screen NPC-to-NPC scene the
  player never witnessed, no hidden relationship number, no unfired reserve twist.
- The teaser **never commits the engine to an outcome** (ADR 0005, closed set). "A secret may come
  out" / "watch this rivalry" is a *mood*, not a result. It may **not** say who wins next HOH, who
  goes on the block, who is evicted, or how a vote lands — the **seed still decides** all of that, and
  the desync guard (`_narration_claims_outcome`) already treats a narrated closed-set outcome as a
  defect. The cliffhanger lives entirely in the **open set**: it foreshadows *texture*, never *the
  board*.

The engine supports this by handing the recap beat a small, **Vault-free `hook` cue** — derived only
from in-motion, player-perceivable threads (a strained deal the player holds, a surfaced rumor, a
freshly-witnessed conflict) — that names *what to tease*, framed as a possibility, never a fact. The
model dresses it into a teaser line. With no eligible in-motion thread, there is simply **no hook**
(the recap closes on the week without a forward tease — a clean, valid beat), so the engine never
manufactures a cliffhanger out of nothing.

> **Why this is structurally safe, not prompt-safe (the 0048/0001 argument).** Like the post-season
> retrospective's gate, the safety here lives **in code**: `weeklyRecap` reads the *witnessed +
> surfaced* projection (the same Vault-free sources `seasonRecap()` / `getVisibleStateFor` already
> serve) and the hook is computed from *already-surfaced* threads only — there is no Vault handle on
> the path, so the model **cannot leak what it never receives**. The teaser's no-commitment property
> is the same line ADR 0005 already draws and the desync guard already enforces for live narration.

## Engine seams (where this lands)

- `src/adapters/engine/GameSessionAdapter.ts` — a new **`weeklyRecap(week)`** read (Vault-free),
  modeled directly on the existing `seasonRecap()`: same event filter, **scoped to the given week**,
  plus the already-surfaced-gossip slice from the player's knowledge (`knows[]` / the
  `getVisibleStateFor` projection) and the optional, in-motion **`hook`** cue. It reads **no**
  `VaultStore` — by construction it touches only the same projections the live player surfaces
  already consume.
- `src/ports/GameSession.ts` — a `WeeklyRecapView` (the `SeasonRecapView` sibling: `week`,
  `highlights: string[]`, `surfaced: string[]`, optional `hook?: { thread, framing }` — all
  Vault-free strings) + the `weeklyRecap(week)` method on the port.
- `src/engine/momentPrompts.ts` — a **`weekly-recap`** moment fragment + (when the recap is delivered
  as a server-initiated beat) a `renderStoryFacts`-style block that hands the model the recap facts +
  the hook cue to voice. The fragment carries the **hard rules** as framing (recap only what the
  player lived / was told; the cliffhanger teases an in-motion thread as a *possibility*, never an
  outcome, never a secret) — but the safety is the engine projection above, not this text (mandate
  #2: prompts are framing, never the Wall).
- **No new write-back.** This is a **read** + a narration beat — it does **not** mutate game state, so
  it is *not* an FE-driven write-back (the four-place gotcha does not apply). It surfaces as a
  lifecycle moment / a read tool the narrator pulls on the week-roll.
- **FE (companion, pytest-gated, no source change in this spec):** the agent loop / week-roll seam
  delivers the recap beat at the episode boundary (the same family as the re-entry beat), and — per
  R1 — surfaces it **in the chat as an in-fiction narrator recap**, never as a separate dashboard
  panel.

## Determinism & non-degradation

- **Reproducible (anti-sycophancy):** the recap is a pure function of the recorded events for the
  week + the player's surfaced-knowledge set — same record ⇒ same digest. It never re-tells the week
  more favorably than it happened (the eviction count, the betrayals, the losses stand exactly as
  recorded — the same honesty the eviction-reveal prompt already enforces).
- **The hook is seeded where any choice is involved:** if more than one in-motion thread is eligible,
  the selection rides the seedable `RandomnessSource` so the same seed + history ⇒ the same hook. The
  hook **never** consults a future roll (it cannot, by R2 — it commits to no outcome), so it perturbs
  no downstream seeded competition / vote (the staged-comp byte-identity discipline applies: a recap
  is presentation over the record, it resolves nothing).
- **Non-degradation (mandate #4):** the recap reads the durable event store, which **accumulates**
  over the season; a week recapped now and re-recapped after a restart is identical, and later weeks'
  recaps are richer because the record is richer — it deepens, never thins.

## Acceptance criteria

- [ ] **Stitched from witnessed + surfaced only.** `weeklyRecap(week)` returns only (a) the player's
      witnessed ceremony/scene/deal events for that week and (b) gossip that has **already surfaced**
      to the player. A rumor still in the hidden layer (un-surfaced) never appears; no off-screen
      NPC-to-NPC scene the player didn't witness appears.
- [ ] **Vault Wall (player AND admin).** A sentinel sweep over the recap view + the assembled recap
      prompt + the hook cue finds **no** Vault content — no undisclosed secret, no hidden number, no
      unfired twist — at any time, on the player surface and (the recap is not an admin feature) with
      no admin / God-Mode path to Vault data through it. `weeklyRecap` imports no `VaultStore`
      (dependency-cruiser stays green).
- [ ] **The cliffhanger commits to no outcome (ADR 0005).** The hook foreshadows an in-motion,
      player-perceivable thread framed as a *possibility*; it never asserts who wins, is nominated,
      or is evicted next, nor any vote tally — the seed still decides. A recap with no eligible
      in-motion thread closes cleanly with no hook (no fabricated cliffhanger).
- [ ] **Stores, not memory (ADR 0003 #6 / mandate #4).** The recap is assembled from the event
      record; a re-entry after a fresh context window / a restore reproduces the same week's recap.
- [ ] **Augments, never replaces (ADR 0003 #4).** The recap progresses no game state, takes no
      player decision, and skipping it costs the player no agency; play resumes unchanged.
- [ ] **Determinism.** Same seed + same recorded history ⇒ same recap body and same hook choice;
      roles-only tests.

## PO review — owner rulings needed

> Two decisions gate the build. Recommendations are given; the owner decides.

### R1 — WHERE the recap surfaces

**Recommendation: an in-fiction narrator recap beat in the chat — NOT a panel or dashboard.** By
ADR 0003 ("the conversation is the game"), the episode-boundary recap should be delivered *in
character*, as production's "previously on / where we left off" voice woven into the chat at the
week-roll (the same family as the re-entry beat in `momentPrompts`). It must **augment, never
replace** play (ADR 0003 principle #4): it frames the seam between episodes and then drops the player
straight into the new week's first live beat — it is never a screen the player has to dismiss before
they can play, and it never becomes the way the game is read. A standing UI panel would turn the
episodic *feeling* into a *dashboard*, which 0003 forbids. *(If the owner wants a lightweight,
optional "recap" affordance the player can re-summon, that is a thin augmentation — but the **default
delivery** should be the in-fiction beat, not a panel that replaces the conversational recap.)*

### R2 — The cliffhanger must be Vault-safe AND non-committal

**Recommendation: a teaser may foreshadow ONLY a pathway already in motion, from witnessed/surfaced
material, and may NEVER commit the engine to an outcome.** Two hard constraints, both structural:

1. **Vault-safe (mandate #2).** The hook is computed only from threads the player can already perceive
   are brewing — a witnessed tension, a deal the player holds under strain, a rumor *already surfaced
   to them*. It reads no Vault: no undisclosed secret, no off-screen scene, no hidden number, no
   unfired twist. "Next time, a secret comes out…" is allowed **only** when the *pathway* to that
   secret is already in motion in the player's perception — it dramatizes the brewing, it does not
   reveal the secret.
2. **No commitment (ADR 0005, closed set).** The teaser foreshadows *texture / mood*, never *the
   board*. It may not state or imply who wins next HOH, who is nominated, who is evicted, or how a
   vote lands — **the seed still decides**, and the desync guard already treats a narrated closed-set
   outcome as a defect. The cliffhanger lives entirely in the open set.

This is the same Vault-safety rule the **companion edit-bay foreshadowing spec (0103)** must hold —
0102 and 0103 should share one ruling here so live foreshadowing and the weekly hook can never drift
apart on what may be teased.

*(Open sub-question for the owner: cadence — does the recap fire **every** week-roll, or only when the
week had enough substance to be worth recapping (skip a quiet rest week)? Recommendation: every
week-roll, but suppress the **hook** when no in-motion thread is eligible, so a thin week gets a short
recap with no manufactured cliffhanger.)*

## Tracks #884

## ORW-1165: the recap is its own message, and the digest covers the day

- Delivery: the turnIn result's `dailyRecap` is saved by the front end as its own chat row (`metadata.kind = "day-recap"`, header "Day N in review"), between the night and the morning, once per day (a replayed turn start saves a missed day before that turn's reply). The narrator is told it is already shown and does not voice it. No model call builds the card.
- Content: `buildDayDigest` keeps one line per moment the player witnessed, by kind (arrival, toast, bed, deal, alliance, strategy, bond, talk, gossip, clash, betrayal, ceremony, overheard, house). Before, only ceremony, deal and betrayal events counted, so a premiere day had none. Talks are described by who they were with and how they went, never by what was said. Each line lists the recorded events it was built from (`digest[].eventCursor`), all witnessed and none hidden.
- Re-issue: the engine keeps the record slice each recap read (`dailyRecapRangeCursor`); `dailyRecap {rebuildDay}` rebuilds a closed day as a pure read. `frontend/scripts/reissue_day_recap.py` (dry run by default) calls the admin route `POST /api/admin/ops/reissue-day-recap`.
