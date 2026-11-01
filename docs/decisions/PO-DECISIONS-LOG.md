# PO Decisions Log

A running record of **product-owner rulings** made during development — the decisions only
the owner can make (design direction, mandate trade-offs, PO-gated tuning, priority calls).
Append-only; newest first. Each entry: date · the decision · scope/issue · rationale. This
complements the ADRs (`docs/decisions/0001…`) and the audit rulings
(`docs/audits/2026-06-10-full-product-audit.md` #1–#21) — those are architecture; this is the
live ledger of owner calls as they happen.

---

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

- **Live-LLM verification — allowlist model egress in the environment.** The 9 model-behavior items
  (#536/#540/#541/#542/#548/#549/#550/#561/#613) can't be verified while OpenRouter egress is blocked;
  the owner will allowlist egress so the guardrails can be confirmed live and closed.
