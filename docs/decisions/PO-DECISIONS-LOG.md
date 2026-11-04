# PO Decisions Log

A running record of **product-owner rulings** made during development — the decisions only
the owner can make (design direction, mandate trade-offs, PO-gated tuning, priority calls).
Append-only; newest first. Each entry: date · the decision · scope/issue · rationale. This
complements the ADRs (`docs/decisions/0001…`) and the audit rulings
(`docs/audits/2026-06-10-full-product-audit.md` #1–#21) — those are architecture; this is the
live ledger of owner calls as they happen.

---

## 2026-11-03

- **0024 NPC memory: YES, NPCs act on what they remember.** Betrayals, favors and broken promises change
  how an NPC treats the player. Engine work that moves balance: sequenced after #1937 and before the
  default-flip re-baseline so one re-measure covers both. **PO ruling 2026-11-03: memories ON** — `ORWELL_NPC_MEMORY`
  now defaults ON (code default, `deploy/orwell-env-defaults.sh`, the `/health` registry). Measured outcome-identical
  ON vs OFF over 200 seeds x 3 arms (the residual floor lets the relationship edge already carry a fresh betrayal, so the
  memory tilt reads 0 within a season): the flip changes no trajectory today; making memories actually move decisions is a goal of the belief-centered NPC-strategy slice (#2017).
- **0128 three-part Final HOH: YES (PO ruling 2026-11-04, Ryne wants it; #2045).** Built behind `ORWELL_FINAL_HOH_THREE_PART` (#2063), then flipped to default ON
  after `juryReach` + `calibrationGradient` held their bands ON (code default, `deploy/orwell-env-defaults.sh`, the `/health` registry). Final 3 now crowns the
  Final HOH with endurance → physical+mental hybrid → quiz; the Final HOH still personally evicts one of the other two (0045).
- **0129 jury house: FULLY SEQUESTERED.** The player can talk to jurors only if the player is a juror;
  jurors mix only with other jurors. (Engine check 2026-11-03: a still-active player cannot reach a juror
  through any mutating tool, and the event store shows no juror/non-juror mixing after a juror is seated,
  barring the eviction-night departure beats. Pinned by `tests/unit/jurySequester.test.ts`. The
  player-as-juror surface itself is still the unbuilt part of the 0129 spec.)
  **Clarified same day (owner): "the jury house is fully sequestered… other than other evicted houseguests
  who are on the jury."** Only jurors belong in it; pre-jury evictees go home and never share it (as on the
  real show). The engine's jury house is now "evicted from the jury-start point onward", not the last nine
  evictees over time (which swept early evictees in until the ninth pushed them out); the juror set at the
  finale is unchanged.
- **0005 Houseguest's Choice (strategic veto draw): build it, but after the first playtest.** Bottom of
  the queue.
- **0003 reveal rate: no change.** Judged in the playtest.
- **#1909 part B, pre-game ties: broaden the tie types.** Family (siblings/cousins), exes, old friends and
  rivals/bad blood are all allowed, and the owner said "get creative, have fun": propose a few more
  plausible-for-a-Big-Brother-cast types. #1909 A+C+B is one item, after the 0024 work. Calibration stays
  neutral: background and ties never change competition odds (standing ruling).
- **Reactive twists stay OFF for the first playtest.**
- **0097 / 0098 / 0103 stay frozen.**
- **Technical call (coordinator): the diary tools (player-dossier, booth-receipts) must switch off when
  their features are off.** Folded into the default-flip PR.
- **Early eviction (0046, pre-jury): offer skip-to-finale AND keep-watching; the evicted player is still in the
  finale (Ryne).** When the player is voted out before the jury forms they are offered BOTH a skip to the
  season-finale reveal and a keep-watching option. "Watch" is a deliberately skeleton version of the rest of
  the season: condensed weekly beats, not a full click-through. Either way the evicted player takes part in the
  finale, at minimum an interview — implemented as a FINALE-NIGHT interview (separate from the 0130 eviction-night exit interview, which still happens at the eviction). Spec: `docs/features/0133-early-eviction-skip-or-watch.md`.
  Design details settled with the coordinator under the ruling and anti-sycophancy (decided, not assumed): the
  interview has no effect on the jury or the winner; skip is irreversible while watch can be switched to skip; a
  self-evicted player (0061) gets none of this. *Held for Ryne:* whether JURORS are also offered skip/watch
  (it may conflict with his "jurors experience the sequestered jury house" ruling) — not part of this ruling.

- **Big irreversible choices are confirmed on the decision card — prose never binds them (Ryne, A-6).**
  The model's `submitDecision` tool may commit only the low-stakes kinds (`comp-intent`, `comp-round`, and
  the in-chat `deal-offer` answer). Every other kind (nominations, the veto, the secret veto, eviction and
  jury votes, tie-breaks, the final eviction, goodbye and exit messages, finale picks, replacements,
  Houseguest's Choice, self-evict) binds only on the player's own confirm on its card, even when the player
  words the choice clearly in chat. The tool refuses those ("…only the player's own confirm on its decision card can commit"). Fail-closed: a new decision kind is card-only until it is added to the allow-list
  (`MODEL_SUBMITTABLE_KINDS` in `frontend/src/orwell_engine.py`). Rationale: ADR 0003 and the C20 definition
  of done ("a hedge in prose cannot bind"); a live check found the narrator submitting a competition choice
  from the player's prose, with only prompt wording holding the line for the bigger choices.
- **Player lobbying sways NPCs at every stage (owner, relayed 2026-11-03).** The player's own campaigns sway NPC
  nominations, the replacement nominee and the veto save, as well as the eviction vote — still bounded
  (`CAMPAIGN.base` per push, net clamped), and the NPCs still decide. **This supersedes the 2026-06-27 "no player
  input may modulate a seeded outcome distribution" principle (0098) ONLY for social influence the player EARNS
  through real, recorded moves and that reaches an outcome only through an NPC's own decision** (a campaign the NPC
  is aware of, bounded, character-mediated). The boundary stays: mechanics that shift seeded odds DIRECTLY (a stat,
  a roll, a threshold) remain barred, and no future outcome change is approved under this precedent. Implemented in #1937 as the single
  switch `CAMPAIGN_PUSH_INCLUDES_PLAYER_OWNED = true`. **ASSUMED, pending Ryne (technical detail):** the NPC
  campaign re-planner no longer rewrites a player's declared campaign (it used to flip a nominated player's evict
  campaign into "protect them"), so the player cannot get an unearned shield now that `protect` has effect.
- **#1909 pre-game tie natures: renamed and broadened (built 2026-11-03; the proposed set is ASSUMED, pending Ryne).** The
  preexisting-romance tie nature is now `prior-romance`, so the word "showmance" belongs only to the in-house arc (`spark → bond →
  visible → resolved`); a legacy `showmance` tie nature in an old save or an older cast-genesis prompt/output is aliased forward at
  load, and the engine and the front-end audit found no other reader of the literal. The set, per the owner's "family, exes, old
  friends and rivals/bad blood are all allowed, get creative": `casting-callback`, `mutual-friend`, `shared-hometown`,
  `old-acquaintance`, `prior-romance` (existing) plus **`family`** (siblings/cousins), **`ex`**, **`old-friend`**, **`rival`**
  (bad blood), and the proposed extras **`former-teammate`** and **`online-acquaintance`**. A nature is flavour only: every tie
  folds the same small standing affinity bias, no nature is a competition or vote input (calibration-neutral, standing ruling),
  and ties stay Vault-sealed, surfaced only through in-game pathways. Making a `rival`/`ex` tie lean NEGATIVE (a signed bias) is
  a separate balance decision for the owner.

- **#1964/#1965 (0024 review follow-ups).** `recordEvictionManner` now MERGES into an existing manner record (OR the
  booleans, strongest intensity; absent = full strength) so a `recordDealBetrayal` flag survives the eviction read. The
  veto-ceremony `replaced` fold now lands the betrayal shock only on a replacement who trusted the HOH pre-fold (graded
  by that trust, as `mannerToward` grades it). **ASSUMED, pending Ryne:** a replacement who did NOT trust the HOH takes
  the plain `nominated` conflict instead of nothing (being put up is still a slight, just not a betrayal).

- **0099 — a secret cannot be traded to someone who already knows it (Ryne).** "Once the info is spread, there's no
  putting the genie back." `resolveAndTrade` now refuses (`refused: "already-spent"`, Vault-free, no new code) a trade of
  a real secret to a recipient who already holds it — witnessed it, or was told it, including by an earlier trade of the
  same secret to them. The 5/season trade cap is unchanged; a bluff has no real fact to be "already known". Test:
  `tests/unit/secretTradeAlreadyKnown.test.ts` (fails without the fix).

- **Default flip (#1934 item 2; coordinator-assigned, Ryne-approved).** The 26 deploy gameplay flags (all of
  `orwell_optin_env_defaults` plus the in-game clock) are now CODE DEFAULTS (`src/domain/flagDefaults.ts`
  `flagDefaultOn`): ON unless the flag is `0`/`false`/`off`, and the one diagnostic switch `ORWELL_FLAGS_OFF=1` forces the whole
  flipped set OFF (the legacy profile). NOT flipped: `SHOWRUNNER_REWEIGHT`, `FORESHADOW`, `REACTIVE_TWISTS`, `TIE_REVEAL`,
  `GOSSIP_CONSEQUENCE`, `MULTI_NIGHT_FATIGUE`, `WIPEOUT_REEL`, and `NPC_MEMORY` (pending its measurement). Consequences: the
  seeded gates now measure the deployed game (juryReach and calibrationGradient both hold, unsharded, with no retune); the
  `heavy-sims-deployed` lane was retired and `heavy-sims` re-sharded into a per-file matrix (45-minute legs); `/health` and the
  admin dial report the code defaults. The seed-108 exit-interview anchor was re-captured for the new default trajectory
  (a technical re-anchor, not an owner item).

- **Difficulty retune (#1953; technical, within Ryne's ruled targets and tuning order).** Measured on the default profile
  (the flip) at 300 seeds: before, passive F2 10.7% / win 2.3%, **solid F2 29.0% / win 9.7%**, reckless 4.0% / 1.7% - solid reach was the
  only band missed. Sweeps (100 and 300 seeds, 12 parallel shards on the remote runner) over the ruled levers: the house-pressure dial
  (1.0-2.5) fixed solid *wins* but not *reach* and broke reckless/passive at the high end; "comp wins raise threat more" is what moves solid
  reach. Chosen: `COMP_WON_IMPACT.threat` 0.2 -> **0.3** with `NOMINATION_PRESSURE` unchanged at 1.0. After: seeds 1-300 passive 10.7 / 1.7,
  solid 20.7 / 5.0, reckless 3.0 / 1.0; independent seeds 301-600 passive 11.3 / 3.3, solid **20.0 / 6.3**, reckless 3.7 / 1.3 - every
  arm in band within sampling error. Note the bands are tight against the structural win-given-F2 ratio (~33% before, ~25-30% after):
  every lever that cuts reach also trims it, so solid wins sit at the band's lower edge (5-6%). The PO-target gate
  (`tests/calibration/calibrationPoTarget.test.ts`, nightly, 300 seeds) therefore judges a band violated only when it lies outside the
  measured rate's 80% interval. The old 6-seed "minimal-active >= passive" gradient claim measures a different (weaker) policy.

## 2026-11-02

- **Difficulty: reaching the Final 2 must be hard (balance targets).** Measured on the deploy profile
  (100 seeds): both a passive and an active player reach F2 about a third of the time and win 10-12%,
  and active play no longer pays off (it did in June: 6 vs 2 wins / 30). The owner's targets:
  - Passive play: reach F2 about 5-10%, win under 5%.
  - Active, smart play: reach F2 about 15-25%, win about 8-12%. **Amended same day (owner): "a tad
    harder" — active play now targets reach F2 about 12-20%, win about 6-10%.** Active must still
    clearly beat passive.
  Tuning order: (1) fix the regression that erased the active-play advantage; (2) floaters become
  targets; (3) comp wins raise threat more; measure 100 seeds per change; (4) a tougher jury only if
  needed. Never protect or punish the player by story; the house just plays smarter for everyone.
- **Difficulty settled (final balance call).** Keep house pressure at 1.0 (round 7). Measured over 100 seeds
  on the deploy profile: passive reaches F2 about 13% and wins about 3%; solid play reaches F2 about 22% and
  wins about 9%; reckless play reaches F2 about 1-6% and wins about 0-2%. The owner accepts the passive F2 rate
  above the 5-10% target as the realistic "goat" effect (NPCs drag a do-nothing player to the end because
  they are beatable), since passive wins stay under 5%. The "active" target now names a SOLID player (a steady,
  sensible social game); a RECKLESS test player checks that bad strategy doesn't beat doing nothing.
- **In-game clock (0066 / `ORWELL_TIME_OF_DAY`) is ON everywhere, tests included.** Resolves the conflict
  between the 2026-06-23 ruling (flip the default ON, #583) and the 2026-06-27 line (engine env OFF for
  calibration). The 06-27 line is retired: tests and calibration are to run with the clock ON, matching the
  deploy and real play. **This is the ruling; the code/test default flip has not landed yet** — it ships with
  the default flip (#1921 / #1922). Until then an unset `ORWELL_TIME_OF_DAY` still reads OFF in the engine;
  the balance measurements here sourced the deploy env, so they ran with the clock ON.
- **Identity and outcomes (0063 §5).** A houseguest's background (ethnicity, orientation) never changes
  a competition's odds or result. It MAY shape social play through realistic showmances (orientation
  gates who can form one, decision #3 / #840), and showmances move friendships, nominations and votes.
  The 0063 BDD golden now pins the opening competition, not the whole season's eviction order.
- **Floaters are easy NOMINATION targets: "pawns go home" (BB canon).** An unattached houseguest is a
  natural pawn, and pawns are often the ones evicted. Some houseguests even target floaters as a
  strategy (character-dependent).
- **Competition wins raise your threat level.** Comp beasts get targeted, like on the show.
- **An eviction vote is deeper than the two names on the block.** Pawns often go home because the
  vote becomes a REFERENDUM ON THE HOH: houseguests who oppose the HOH vote against the HOH's wishes,
  keeping the HOH's real target and evicting the pawn. Others protect the target (their ally) and vote
  out whoever the pawn is. Today's vote model weighs only the voter's read of the two nominees and has
  no HOH term, so this is a modeling gap to add during the difficulty tuning.

- **Finale jurors never hint at who voted against them before the season is over (#1790 / E12).** A
  juror's finale question may still carry their demeanor (`bearing` — a word, never a number), but no
  "who they believe turned on them" belief: per-voter attribution of the secret ballots unseals only in
  the 0048 retrospective. The `heldBelief` field is removed. Rationale: the game rules already keep
  ballots secret until the end, and the hint came from jury-house knowledge the player never reached
  through any in-game pathway (and could even be a different juror's grudge).
- **CodeRabbit is no longer used.** Reviews are cubic + Greptile; CodeRabbit's auto-notices are ignored
  and it is never triggered. (Uninstalling the GitHub App is an owner action in GitHub settings.)

## 2026-11-01

Rulings from the 2026-11 full-feature audit's Tier 0 review.

- **Notoriety: a NEW character is a clean slate; a RETURNING character carries its legend (0104 /
  #1791).** The new-vs-returning choice is the existing `keepCharacter` opt-in at season restart. For a
  returning character, the short legend clauses ("what the new house has heard") are PUBLIC: the
  narrator may voice them through the sanctioned slots (the game-state `notorietyLegend` field and the
  "RETURNING CAST" line, premiere + week-1 social). The reputation NUMBERS, placements and season count
  stay sealed everywhere. Rationale: a returning player having a reputation the house talks about is
  the payoff; the numbers would be a spoiler. Pinned by the 0104 BDD scenarios (#1908).
- **Eviction night takes about 2 in-game hours total, "like it plays on the show" (0047 / 0037 /
  0119).** The vote reveals, goodbyes, exit interview and result count as one ~2h event, not ~3h each.
  No forced all-nighter and no hidden tiredness penalty before the next HOH. The same applies to the
  finale. (Measured before the fix: an 8am vote ended at ~7am the next day.)
- **NPC deal offers play out inside the conversation, not as a pop-up (0123).** The engine still
  decides who approaches and what they offer (from character + relationships, anti-sycophancy). The
  narrator voices the NPC pulling the player aside, the game never blocks on it, and the player's
  in-chat yes/no is recorded as a real deal or a refusal. An ignored offer lapses at the end of the
  week, with a bounded, hidden cooling that depends on the NPC (a thin-skinned or paranoid NPC cools on
  being brushed off; an easygoing one doesn't).
- **Canon clarification (no change): goodbye messages flow FROM each remaining houseguest TO the
  evictee.** The player, while still in the house, authors their own message to each evictee; the
  evictee sees them in the 0130 exit interview. The engine already works this way; recorded so the
  ambiguous "the player authors their own goodbye" wording is never misread again.

## 2026-07-11

- **The Diary Room's thin rose chrome edge is a SANCTIONED DIEGETIC EXCEPTION to "no accent on
  chrome" (#738).** The confessional pill (`#orwell-dr-pill`, orwellDiaryRoom.js) keeps a WHISPER of
  rose as a thin, bounded EDGE only — never a rose-washed fill — as the confessional's in-world
  signature (rose = "you're in the Diary Room, the private backstage"). This is the deliberate,
  owner-ruled endpoint of the #738 item-22 tone-down ("tone down to a hint," not full-neutralise),
  now recorded explicitly so it is not re-flagged as a leak of the general "no accent on chrome" rule
  and mistakenly stripped in a future glass-legibility sweep. Scope: **this one surface only** — the
  edge is bounded (a border, `color-mix(#e06c75 ~45%, transparent)`; ~42% under `body.theme-frosted`),
  the bulk rides the ONE colourless light-glass material like every other chrome, and it goes opaque
  under `prefers-reduced-transparency`. The pin is `frontend/tests/test_738_glass_polish_8_13_22.py`
  (`test_dr_pill_keeps_a_bounded_rose_hint` — a rose EDGE is KEPT; a rose background fill is
  forbidden). Rationale: the Vault Wall / immersion mandate values a legible "you are backstage"
  affordance; a single bounded diegetic edge is not the accent-on-chrome defect class the rule targets
  (opaque tinted menu bulk / accent ink on text). Do NOT widen it to a fill, and do NOT extend the
  exception to any other surface.

## 2026-06-27

**PO-review board cleared — all nine flagged specs resolved this session** (the "PO review / owner
rulings needed" set). Companion decision notes posted on each GitHub issue; specs updated in place.

- **Secrets-as-power = ONE build (0093 #862 + 0099 #880).** Build leverage / expose / **trade** as a
  single mechanic — one ledger, one constants module, one `factId`-ownership check (do not split into
  two "use a secret" systems). Rulings: **expose is a first-class `exposeSecret` lever** (engine-resolved
  seeded standing fold + exposer backlash + recorded `surfaceInformationTo` pathway), **not** narrated-only
  (0093 R2); **leverage is an optional descriptor on the existing `makeDeal`** — no separate deal kind; the
  threat **persists while the deal is open**, **exposing spends** the secret (0093 R4); **ceiling =
  real-but-recoverable** — bounded, seeded, felt, never deterministic, for leverage *and* expose/trade
  (0093 R1 / 0099 R1 / 0099 R2 = build together); surfacing stays a modeled pathway, never a Vault read
  (0093 R3 / 0099 R3); the player may only weaponize a `factId` they legitimately hold (0099 R4) — *except*
  via the new bluff path below.

- **Deception is first-class across the secrets layer (new owner direction).** Any use — leverage /
  expose / trade — may be **truthful or fabricated**, and **both NPCs and the player can lie / bluff**
  (generalizes the already-sanctioned 0075 NPC-lie primitive). Reuses the 0075 `truthful` flag + per-season
  lie cap + the **passive lie-catch** (now pulled into this build): a lie is believed weighted by
  trust-in-source + plausibility (0094), folds on *belief* not truth, and a later contradicting pathway
  delivers a betrayal-grade, recoverable hit to the liar. **Vault-safety:** the `factId`-ownership guard
  **stays** for *real* secrets (no Vault-minting); a **bluff** is a separate sanctioned path that invents a
  claim, reads nothing from the Vault, and the engine never confirms whether a bluff happened to match a
  real truth. *Open build-tuning:* whether the player's bluffs are capped per season like 0075 confide-lies.

- **NEW — deal duration as a factor (amends 0039; new spec drafted, `docs/features/0109-deal-duration.md`).**
  A deal gains an optional negotiated duration: either an **explicit** term-count ("safe for two weeks" →
  `expiresWeek`) or simply labeled **`vague`**. Betrayal-shock (0026) **scales with remaining deal life** —
  breaking a deal with two weeks left hurts more than breaking one about to lapse, so "when do you turn on
  an ally?" becomes a weighted decision with real drama. A `vague` deal's break reads with built-in
  ambiguity (a softer, fuzzier shock); **no per-party belief tracking** (owner: *"just labeled as vague is
  enough"*). Definiteness splits along ADR 0005 — the fuzzy "how long" lives in the open-set `terms` prose,
  the engine keeps the bounded interpretation for reconciliation.

- **0097 suspicion ledger (#878) — FROZEN (parked, not deleted; closed *not planned*, reopenable).** Not
  load-bearing; risks the game over-telling the player / paranoia-as-spreadsheet (against ADR 0003 and the
  "the feeling is theirs" mandate, 0017/0020). If revived: DR-style OOC surface (R1), reveal-time-only
  scoring (R2), player-authored player-knowledge with `NO_NPC_PATHWAY` (R3).

- **0098 confidence-calibrated reads (#879) — FROZEN (parked, not deleted).** **Standing principle for all
  future specs:** *a player input must never modulate a seeded outcome distribution — not the direction, and
  not even the variance.* The certainty is the human's to feel; the game must not model "how sure you are"
  and let it touch outcomes.

- **0103 edit-bay foreshadowing (#885) — FROZEN (parked, not deleted).** Spoiler-adjacent in *feel* even
  though structurally Vault-safe; the 0102 daily-recap forward-nod already covers bounded foreshadowing, and
  this layer is the riskier of the two on the anti-spoiler mandate.

- **0102 Day-1 experience (#875; sub #905–#909).** Casting **keeps strategy but at category level only** —
  dispositions ("target the comp threats"), relationship goals ("a showmance"), alliance shapes ("all-women
  alliance"), play-style — **no houseguest-specific kill-list**; player framing + mid-season-re-read fuel,
  never an outcome lever (R1/#905/#909). Premiere = a **structured real-show sequence**: opening **mingle** →
  **living-room champagne circle** (each houseguest introduces their public persona + an observable
  vibe/body-language read, Vault-free conduct only) → second **mingle** → **first HOH** (a real seeded comp);
  "no one invisible" is satisfied by the circle, replacing the meet-all-15 gate (R2/#906/#908). Three
  sequenced PRs after the in-flight dedup/cast-gallery/responsive work (R3). Curiosity needle Vault-free
  (R4/#909).

- **0102 weekly recap → DAILY recap (#884) — redesigned.** A **daily "day in review" pop-up window** (built
  on the window kit), fired at the player's in-game **bedtime** (0066), **replacing the weekly recap**.
  Vault-safe (built only from the player's witnessed/known events); the "tomorrow…" forward-nod stays
  non-committal and suppresses on a quiet day. The `0102-weekly-recap-cliffhanger.md` filename is now a
  misnomer — rename to daily recap.

- **0104 season notoriety (#886).** A bounded open-set **`NotorietySummary`** crosses the season door
  (placement / vote record / relationship trajectory / comp wins / jury respect / short glosses — never
  Vault/soul/hidden state) (R1). Influence = **both** a bounded seeded archetype-shaded **Day-1 bias** on the
  new cast's reads of the player (direction only — never a comp/vote roll, never a number, never the player's
  own edges) **and** **narrative reference**, **modulated per-NPC by a seeded recognition level** (not everyone
  knows you; some hold a *distorted* version — 0094) so reputation matters but never rigidly overrides fresh
  discovery (R2). Per-user / per-character isolation (R3). **Opt-in is diegetic:** at a new season the player
  chooses to return as the **same character** (carry notoriety) or **create a new character** (clean slate ⇒
  byte-identical, calibration untouched); the character identity + notoriety **persist at the account level**
  across a season-reset (R4).

- **0066 Phase-2 (#1125 opened) — build all three.** Per-conversation clock advance (*build first* — most
  player-felt, pacing-only, no calibration risk), NPC next-day social fatigue, and the compounding
  multi-night fatigue meter — all behind the opt-in byte-identical discipline. Engine `ORWELL_TIME_OF_DAY`
  env default stays OFF for calibration; the FE session default stays ON for real play (ruling #583).

**Soft-tunable sweep (non-blocking "Open / to confirm" knobs):**

- **Relationship & temperature constants** (0001 / 0002 / 0017 §9 / 0006) — **leave at the current calibrated
  values**; move them only via the UAT / heavy-sim band, never hand-tweak off the calibrated floor (goal met
  2026-06-21; do not lower `gameRespect`). No change.
- **Zeitgeist capture** (0062) — confirm the **one-time 7-day offset** (the rolling alternative breaks
  sequestration), a small/bounded capture budget, and that flavor-divergence between two live captures of the
  same seed is acceptable. No change.
- **Engine double-buffer for occupancy** (ADR 0009/0011/0012) — **keep deferred** as a post-launch refactor;
  the FE-side fix is shipped, green, and zero-risk.
- **Edge auth gate** (ADR 0007) — *recommended:* add a Cloudflare Access email-OTP allow-list as
  defense-in-depth. **Approved per recommendation; ships in its own implementation PR (a deployment/security
  posture change), not this docs PR.**
- **Session TTL** (ADR 0007 / #581) — *recommended:* shorten the 7-day FE session TTL + add server-side
  revocation on logout. **Approved per recommendation; its own implementation PR.**

## 2026-06-23

- **Live-LLM verification bar to CLEAR a model-behavior issue: ≥3 passes across DIFFERING scenarios.**
  Because LLM behavior is stochastic, a single live pass is not evidence. A model-behavior / narration
  issue (the live-LLM-gated set — e.g. #536/#540/#541/#542/#548/#549/#550/#561/#613) may only be
  closed when its live-LLM verification passes **at least 3 times, each in a DIFFERENT scenario**
  (different seed, game state/phase, cast, and/or framing — not the same prompt re-run). A single
  REPRODUCE in any scenario blocks the close. Verification runs against the four engine-truth oracles;
  the guardrail must hold across the varied conditions, not just one. (Egress allowlisted + key
  provided 2026-06-23, so this is now runnable.)

- **Standardize ALL UI into kits (epic #660).** Every player-tier UI surface must be built by
  composing a shared kit (window/gadget/notice/settings-card/tabs/…), never hand-rolled — kits own
  chrome, behavior, a11y, persistence, sync, and responsiveness. Recurring spacing/behavior/mobile
  bugs are symptoms of un-kitted UI. Per-kit "done" = primitive exists + all instances migrated + a
  convention gate + satisfies the persist/mirror (#643) and responsive/touch (#644) mandates. The
  Settings window's mobile full-screen sheet is the template for kit windows on mobile; interim CSS
  fixes are stopgaps, not the standard. Tracks #640/#641/#642/#643/#644/#658/#659.

- **Blocs never cross the Vault Wall as an object — KEEP the invariant (#612, #624).** The emergent
  bloc/coalition structure stays computed-but-hidden; the player infers coalitions from observable
  behavior, never from a surfaced bloc roster/object. Closes #612 and #624 as *not planned*. Rationale:
  the Vault-Wall mandate (#2) and ADR 0002 ("ally/enemy labels are organic, never stored/surfaced")
  win over the convenience of handing the narrator a structured bloc. The 0044 invariant test stands.

- **Social / Diary-Room zeitgeist framing → player channel (#580).** Player-present beats (social,
  diary-room) use the player-channel zeitgeist framing, not the off-screen "world you moved in with"
  framing. The conflicting `zeitgeist.test.ts` assertion is updated to the new behavior (this reverses
  the earlier revert, now PO-sanctioned).

- **Flip `ORWELL_TIME_OF_DAY` default ON (#583).** Its prerequisites shipped (#537 clock pacing, #534
  narration time-of-day pin), so time-of-day is on by default.

- **Flip `owner_filter` `include_shared` default → False (#588).** Security: a NULL-owner row must not
  be readable across users by default. Owner-scheduled; now approved.

- **Reword the "Producer's Vault" term at the post-season retrospective (#607).** Drop the v0 machinery
  term from player-facing retrospective copy.

- **DWE kit program — build the shared substrate FIRST (#643).** Generalize the window kit's 0064
  layout-sync into a kit-agnostic synced-UI-state service so every kit (window/gadget/notice) inherits
  cross-session persistence + realtime two-window mirror by construction — before building #640/#642 or
  doing the #641 migrations.

- **Kit mandates (cross-cutting).** Every DWE kit MUST: (a) persist state across sessions + mirror it in
  realtime across windows/devices (#643); (b) be fully functional AND intelligently touch-adapted on
  mobile/tablet/desktop, not a shrunk desktop (#644). Inherited by every kit member.

- **Reactive twists ON for the playtest (2026-11-03, Ryne).** "I want to know if this breaks the game." `ORWELL_REACTIVE_TWISTS` is now a default-ON
  flag (engine `flagDefaultOn`, `/health` `defaultOn`, `deploy/orwell-env-defaults.sh`), superseding its "NOT flipped" listing in the default-flip entry above
  (`=0` opts out; `ORWELL_FLAGS_OFF=1` forces it off). **Invariant: the jury of 9 never changes under any twist** — gated by
  `tests/property/reactiveTwistsGuard` (50 seeds, full deployed profile, plus a production-orchestrator integrity phase) and the per-twist player-path e2e
  `tests/property/reactiveTwistsPlayerPaths`. Found + fixed on the way: a battle-back winner stayed a 0133 spectator; a battle-back lowered the persisted
  `juryHouseArrivals` counter (read as degradation: every later turn refused, circuit open). No twist can fire in week 1 (earliest battle-back wk 7,
  double eviction wk 8, secret veto wk 12 over 50 seeds). No God-Mode dial: the plan is fixed at `createCharacter`.

- **Live-LLM verification — allowlist model egress in the environment.** The 9 model-behavior items
  (#536/#540/#541/#542/#548/#549/#550/#561/#613) can't be verified while OpenRouter egress is blocked;
  the owner will allowlist egress so the guardrails can be confirmed live and closed.

- **2026-11-04 - 'Hang out until X' ON (Ryne).** `ORWELL_HANGOUT` defaults ON (code default, deploy defaults, /health registry, drift pins; `=0` opts out). Live rerun: a hang-out ran the clock 225 -> 35 -> 0 minutes and stopped EXACTLY at the scheduled HOH comp (never past it); the safety-critical stop is `event-due`. The other four stop reasons (pulled, npc-approach, observed, bedtime) are unit-proven and fail safe (they only end the wait early) but were not seen on screen in the live run.
- **2026-11-04 - Premiere entrances + champagne toast ON (Ryne, for Thursday's playtest; A9).** `ORWELL_PREMIERE_ENTRANCES` defaults ON (code default, deploy defaults, /health registry, drift pins; `=0` opts out): the premiere opens with ONE-AT-A-TIME entrances (seeded order, the player at a random slot, each a short vignette), then the living-room toast (host first, then each houseguest; the player's own speech is chat-authored), then the 48-message Day-1 morning. `juryReach` + `calibrationGradient` held their bands ON; the live premiere check found and fixed three bugs (#2086). The old champagne-circle premiere stays byte-identical under `=0`.
