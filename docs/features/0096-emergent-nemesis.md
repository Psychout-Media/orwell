# 0096 — Emergent nemesis (a personal villain to outlast)

> **Status:** ✅ **BUILT (2026-07-06).** `selectNemesis`/`NEMESIS` in `src/engine/campaigns.ts` (pure, no
> rng of its own), wired into `GameSessionAdapter.campaignTick` (selection + drive/campaign escalation)
> and `npcVoice` (the Vault-safe `rivalry` tone hint). Default ON behind the existing `ORWELL_CAMPAIGNS` (`=0` opts out).
> Wired in `cucumber.cjs`.
> **Builds on (does NOT duplicate):** 0085 (NPC campaigns — `src/engine/campaigns.ts`,
> `GameSessionAdapter.campaignTick` / `campaignTiltFor`), 0086 (houseguest drives — the **`target`**
> motivation, `deriveDrive` / `ownBallotLean`, `sessionSnapshot.drives`), and the relationship model's
> **threat** edge (0002/0026). **This is NOT a new targeting system** — it is the *sustained, narrated
> elevation* of an existing high-threat `target` drive into a coherent through-line. **Depends on:**
> 0002/0026 (the threat edge it reads, with recency/decay), 0085 (the campaign it biases), 0086 (the
> drive it elevates + its stickiness), 0041 (the soul the rivalry colors and that colors it back),
> 0038/0049/0036 (the pathways + presence the rivalry is *felt* through), 0048 (the retrospective
> unseal of who was gunning for whom). **Sibling of** 0085/0086.
> **Vault Wall (mandate #2 — symmetric):** the nemesis is hidden engine state, derived from each
> houseguest's OWN threat reads; it reaches the player only through **behavior**, never as a number, a
> flag, or a name on a panel — **and never to the admin / God Mode either.**

> **Owner direction (Tracks #881):**
> *"Elevate the NPC carrying the highest SUSTAINED threat-toward-player into a FELT recurring antagonist —
> escalating, personal moves (targeting you in noms/votes, recruiting against you, needling you socially) —
> a personal villain to outlast."*

## Why

A real _Big Brother_ season has a **personal villain** — the one houseguest who has it in for *you*,
keeps coming for you week after week, recruits against you, gets under your skin, and whom surviving
becomes a season-long arc. It is one of the most retention-defining beats the genre has: a stake that
is **about you**, not the abstract board.

Today Orwell has every ingredient and none of the *through-line*. 0085 runs campaigns and one of them
may target the player; 0086 gives every houseguest a `target` drive and the threat edge already names
who reads the player as dangerous. But these are **per-tick, re-derivable, and undifferentiated** — the
houseguest gunning for the player this week is mechanically identical to any other campaign owner, and
nothing makes the *same* antagonist **persist, escalate, and read as personal** across the season. The
player feels "the house is scheming" but rarely "*that one* is **my** problem." 0096 closes exactly
that gap — **not** by inventing new targeting, but by recognizing when an existing high-threat `target`
drive has become **sustained**, elevating that one NPC into a felt, coherent nemesis, and biasing their
*existing* campaign/drive/behavior toward the player so the rivalry escalates and is *witnessed*.

### The personal-stakes retention value

A board threat is abstract; a **nemesis is a relationship**. The arc — first needling, then a
nomination, then catching them recruiting against you, then the gut-satisfaction of outlasting (or the
gut-punch of being taken out by) them — is a *story the player is the protagonist of*. It is the
single strongest hook for "I want to play one more week," and it costs no new system: it is the
**emergent narration** of machinery that already exists.

## The bright line this feature respects (read first)

The nemesis is **not** a board fact, a label, or a number the player (or admin) is ever shown. It is a
**hidden engine read** that biases hidden behavior; the player learns of it the *only* way they learn
anything — by what their antagonist *does* (mandate #2, ADR 0002, and the 0086 symmetric-perspective
ruling that drives surface "only through behavior + a pathway, never as a number"). Three structural
facts keep the Wall intact, none of them prompt wording:

1. **The engine owns who, whether, and how-hard — seeded, anti-sycophancy (ADR 0005, mandate #3).**
   Whether *any* NPC has crossed into nemesis status, *which* NPC, and *how hard* they press are
   computed by the engine from the existing threat edges + drives, on a **dedicated seeded stream**.
   The model never *picks* a villain and never *invents* a rivalry the engine didn't elevate — it only
   *voices* the behavior the engine already biased into being.
2. **The read is behavior-only, never crossed — to player OR admin.** No projection — player-facing
   *or* admin/God-Mode — returns "X is your nemesis," a threat number, a hostility score, or an
   escalation tier. The player infers the rivalry from the *pattern of moves* exactly as they infer any
   relationship (mandate #2: "God Mode / admin is walled from the Vault too").
3. **It is an elevation of existing state, not new state.** The nemesis is *the* sustained high-threat
   `target` drive (0086) belonging to the NPC with the highest persistent threat-toward-player edge
   (0002). 0096 adds **selection + a bounded escalation bias + the narration hook** — it does **not**
   add a parallel targeting model, a new vote term beyond the 0085/0086 tilt it sharpens, or a new
   hidden authoring layer.

## The mechanic

### 1. Selection — the sustained-threat read (the gate)

The engine identifies **at most one** active nemesis-of-the-player at a time, chosen from the living
house by a **sustained** (not instantaneous) threat-toward-player signal:

- **Sustained threat, not a spike.** The relationship model already decays/recencies the **threat**
  edge (0002/0026). 0096 reads the NPC's `threat(npc → player)` edge **plus** the persistence of their
  `target`-the-player drive (0086 drives are *sticky* — they already hold a target across ticks until
  the board genuinely shifts). The nemesis is the NPC whose threat-toward-player has stayed **at or
  above a `nemesis` threshold across multiple ticks** *and* whose sticky drive is `target` aimed at the
  player. A one-week flash of hostility is **not** a nemesis; a held, re-committed grudge is.
- **At most one, and only when earned.** If no NPC clears the sustained bar, there is **no nemesis** —
  this is a *rare, special* elevation, not a slot that is always filled (mirrors 0059/0075 sparseness:
  the house isn't all rivalries). The cap is one concurrent nemesis-of-the-player so the arc stays
  legible and singular (a "personal villain," not a mob).
- **Derived, never authored.** Selection reads ONLY existing signals — the threat edge + the sticky
  `target` drive — through a pure helper. No new hidden attribute is minted per NPC; nothing is stored
  that the threat/drive layers don't already hold.

### 2. It can SHIFT — the nemesis is organic, never fixed (the headline guarantee)

The nemesis is **emergent and revisable**, exactly like every relationship read in this game. The
threat landscape moves, and the nemesis moves with it:

- If the current nemesis is **evicted**, the player **wins comp and crowns themselves safe** so the
  rival's threat-toward-player decays, or the rival's drive **re-aims** off the player (0086 stickiness
  releases on a real board change), the nemesis status **lapses**.
- A **different** NPC whose sustained threat-toward-player overtakes the field can **become** the new
  nemesis (an arc can hand off — you outlast one villain and another rises). Hysteresis (sibling of
  0086's `DRIVE.hysteresis`) keeps it from flip-flopping week to week: the held nemesis stays until
  their sustained read genuinely drops or a clear successor sustains past them.
- It is legitimately possible to play a whole season with **no** nemesis (a beloved player nobody
  fixates on) — and that, too, is correct emergent output, not a defect.

### 3. The escalation bias — sharpen the EXISTING campaign/drive toward the player

Once an NPC is the nemesis, 0096 **biases their already-running 0085 campaign and 0086 drive toward the
player** — it does not spawn a second mechanism. The bias is bounded, seeded, and rides the existing
tilt:

| Surface that already exists | 0096's bounded bias |
|---|---|
| **0086 `target` drive** | the nemesis's sticky drive is **held on the player** (extends the existing hysteresis) and runs at the **upper** of its bounded intensity band — escalating *within* the existing bound, never past it |
| **0085 campaign (`evict` the player)** | the nemesis is **prioritized** to hold an active `evict`-the-player campaign under the existing `maxConcurrent` cap (it does not raise the cap), so their lobbying against the player persists and adapts (`replan`) week to week |
| **the seeded vote (`campaignTiltFor` / `ownBallotLean`)** | the nemesis's vote-against-the-player effect is the **existing** 0085 campaign tilt / 0086 own-ballot lean — 0096 only ensures *that NPC* is the one carrying it, scaled by their persuasiveness as today. **No new vote term.** |
| **noms / replacement noms / veto** (0044 seeded decisions) | when the nemesis holds power, their **existing** decision weights already favor evicting their `target` — 0096's contribution is that the target is *durably the player*, so the pressure recurs rather than scattering |
| **social needling** (presence/voice 0049/0036/0084) | the nemesis's voice + approaches carry a **personal, adversarial framing toward the player** (texture, not a new pathway) — they seek the player out to needle, position against them in the room, cluster with the player's rivals |

The crux for calibration: **0096 chooses the subject and sharpens the intensity *within* the existing
bounded knobs.** It must **not** add magnitude beyond what 0085/0086 already apply — the eviction math
stays the seeded math, fed by a campaign/drive that now reliably points at the player. *Felt, never
deterministic:* a strong, sustained nemesis raises the player's danger but never guarantees an outcome
(the player can win comps, build a counter-bloc, flip the nemesis's allies — outlasting them is the
game).

### 4. The narration hook — the model VOICES the rivalry, never invents it (ADR 0005)

The model is handed a **Vault-safe, behavior-only hint** so it can *voice* an escalating personal
rivalry the engine has already biased into being — the open-set narration of a closed-set selection
(ADR 0005: the engine owns selection + magnitude; the model narrates the meaning):

- When the player is in a scene with the nemesis, `npcVoice` carries an optional, read-only
  **`rivalry` hint** — **a tone word only** (e.g. `{ adversarial: true }` or a coarse heat band like
  `"simmering" | "open"`), **never** a number, never "this is your nemesis," never the threat edge.
  It tells the model *how* this houseguest carries themselves toward the player, the same way
  `mayConfide` (0075) carries a reason-word and not the secret.
- The hint appears **only inside a live scene with that houseguest** (no cold-open arc announcement,
  sibling of 0075's no-cold-open guarantee) and only while the nemesis status holds. The narrator
  leans into needling, cold shoulders, pointed positioning — *texture*, never a stated motivation
  ("she's your nemesis" is forbidden hand-holding; paranoia is the human's to form, 0017/0020/0086).
- The model **never authors the rivalry's existence or its consequence.** It does not decide who the
  nemesis is, does not move the vote, does not invent a nomination — the engine's biased campaign/drive
  does all of that. The model only gives the *felt surface* of a fight the engine is already running.

> **The no-omniscience / no-leak guarantee is structural:** `rivalry` is attached to `npcVoice` (which
> the model calls only when the player is already engaging that houseguest), carries a tone word and no
> sealed content, and is computed from the *nemesis's own* threat read (perspective-bound — the same
> symmetric-perspective spine 0085/0086 hold). There is no projection, player or admin, that lists the
> nemesis or its tier.

## Engine seams (where this lands)

- `src/engine/campaigns.ts` *(extend — no new module)* — a pure
  `selectNemesis(actors, threatTowardPlayer, priorNemesis, c)` that returns the at-most-one nemesis
  EntityId (or `undefined`) from the sustained-threat read + the sticky `target` drive, with hysteresis
  to hold/hand-off. Sits beside `deriveDrive`/`formCampaigns`; perspective-bound; pure; seeded inputs
  only. New tunables in the existing `NEMESIS` constants block (sibling of `DRIVE`/`CAMPAIGN`): the
  sustained-threat threshold, the sustain window (how many ticks of held threat qualify), the
  hysteresis margin, and the escalation intensity band the nemesis's drive runs at.
- `GameSessionAdapter.campaignTick` *(extend the existing tick — no second loop)* — after deriving
  drives, compute the (sticky) nemesis from `threatReadsOf(...)` toward the player + the just-derived
  drives; persist it; then **bias** the existing campaign/drive for that NPC toward the player (hold
  the `target` drive on the player at the upper intensity; prioritize their `evict`-player campaign
  under the unchanged cap). All on the **dedicated campaign rng** ⇒ no new draw structure on the
  calibration stream. **No-op (zero draws) when `ORWELL_CAMPAIGNS` is unset** — same guard 0085/0086
  hold ⇒ `juryReach`/UAT byte-identical.
- `GameSessionAdapter` `npcVoice` *(extend)* — the optional, Vault-safe `rivalry` tone-word hint,
  present only for the held nemesis inside a live player scene. No sealed content, no number; reuses the
  threat read the adapter already holds engine-side.
- `src/engine/momentPrompts.ts` *(extend)* — the `social` moment voices the `rivalry` tone as
  adversarial *texture* (when to lean into needling/positioning; that the engine decides the rivalry;
  never invent a nemesis or a move the engine didn't bias). The tone is voiced as flavor, never stated
  as a fact or number.
- **Vault:** the nemesis read lives in engine-only state (beside drives/campaigns); dependency-cruiser
  proves no outward import. No player **or** admin projection returns it.

## Persistence (0007/0030 — non-degradation)

- The current nemesis (an EntityId or none) + its sustained-threat history persist in the snapshot
  (sibling of `sessionSnapshot.drives` / `campaignTickCount`), so the arc **survives a save/restore and
  a fresh context window** — the rivalry is recalled, never re-guessed, and **accumulates** across the
  season (non-degradation #4: a long rivalry's history deepens, never thins). Absent on a pre-0096 save
  ⇒ no nemesis ⇒ re-derived on the next campaign tick (back-compatible).
- The arc's unseal (who was gunning for whom, and from when) belongs to the **0048 retrospective** —
  during play it is only ever *felt*.

## Determinism & calibration-neutrality (the load-bearing guard)

- **Opt-in / isolated ⇒ byte-identical.** Like 0085/0086, the whole feature lives behind
  `ORWELL_CAMPAIGNS` and runs only on the **dedicated campaign rng** (never the shared society/vote
  stream). Unset ⇒ no nemesis is computed, no bias is applied ⇒ `juryReach`/UAT **byte-identical** (the
  same guard the campaign layer already passes).
- **No magnitude beyond the existing tilt.** 0096 selects the *subject* and sharpens intensity *within*
  the 0085/0086 bounded knobs; it introduces **no new vote/decision term**. The eviction distribution
  must shift only because a campaign/drive now reliably points at the player — never because 0096 added
  raw magnitude. A property test asserts a *sustained nemesis raises the player's danger vs. baseline*
  **and** that with the layer off the seeded outcomes are unchanged (the campaign-tilt calibration
  lesson — ride the existing stream, don't re-phase it).
- **Seeded + reproducible.** Same seed + same history ⇒ same nemesis (or none), same escalation. The
  selection is a deterministic read of seeded inputs.

## ADR fit

- **ADR 0005 (split authority by openness).** Selection + magnitude are **closed-set, engine-owned**;
  the *meaning* of the rivalry — how it reads, how it's voiced — is **open-set, model-narrated** and
  recorded losslessly. 0096 never collapses creative play into a bucket; it hands the model a tone word
  and lets it write the fight.
- **ADR 0003 (the conversation is the game).** This is **emergent narration of existing machinery** —
  it adds no dashboard, no "nemesis tracker," no UI surface. The player experiences the villain purely
  *in conversation* (needling, noms, recruiting felt through pathways). It serves the four fixes by
  deepening **behavioral fidelity** (the most human BB beat) without adding framing the model doesn't
  need or scripting what it should improvise — the model gets a *fact to voice* (an adversarial tone),
  never a *script to recite*.
- **ADR 0002 (organic relationship model).** The nemesis is read through the holder's own threat edge,
  asymmetric and uncertain — never a stored ally/enemy flag. It is the relationship model's threat
  signal, sustained and narrated, exactly as the ADR intends labels to be "organic and emergent, read
  through the holder's own framing, never stored."

## Acceptance criteria

1. The engine elevates **at most one** living NPC to nemesis-of-the-player, and **only** when their
   **sustained** threat-toward-player (held across the sustain window) + a sticky `target`-the-player
   drive clear the `nemesis` bar; below the bar there is **no** nemesis.
2. The nemesis can **shift**: it lapses when the rival is evicted / their threat decays / their drive
   re-aims, and a different sustained-threat NPC can take over (with hysteresis to prevent flip-flop);
   a whole season with **no** nemesis is valid output.
3. The rivalry is **behavior-only**: no player-facing **and no admin/God-Mode** projection returns the
   nemesis identity, a threat number, a hostility score, or an escalation tier — a sentinel sweep over
   every projection (player + admin) is clean.
4. The escalation **biases the existing 0085 campaign + 0086 drive toward the player** (held `target`,
   prioritized `evict`-player campaign under the **unchanged** cap, the existing vote tilt carried by
   *that* NPC) and adds **no new vote/decision magnitude** beyond what 0085/0086 already apply.
5. `npcVoice` carries the Vault-safe `rivalry` tone word **only** for the held nemesis **inside a live
   player scene** — never a number, never a stated motivation, never a cold-open announcement.
6. **Determinism / calibration-neutral:** with `ORWELL_CAMPAIGNS` unset, no nemesis and no bias ⇒
   `juryReach`/UAT byte-identical; enabled, a sustained nemesis raises the player's danger vs. baseline
   while the run stays seeded.
7. **Persistence / non-degradation:** the nemesis + its history survive a save/restore and a fresh
   context window, and accumulate across the season; pre-0096 saves restore to "no nemesis" and
   re-derive cleanly.

## Open questions / defaults (resolve at build)

1. **The sustain window + `nemesis` threshold.** How many ticks of held threat-toward-player qualify,
   and the threshold height. Start: a window of ~2–3 ticks at/above a threshold a notch over
   `CAMPAIGN.threatThreshold` (so a nemesis is rarer than a campaign target), tuned against the UAT so
   nemeses read as special, not routine.
2. **The escalation band.** The upper intensity the nemesis's drive runs at (within the existing bound)
   and how strongly to prioritize their `evict`-player campaign under the cap — felt, never flattening
   the eviction variance (the campaign-calibration lesson). Default: hold at the top of the existing
   drive band; prioritize but never exceed `maxConcurrent`.
3. **Hand-off cadence.** How sharply a successor must overtake the incumbent to take the nemesis slot
   (hysteresis margin). Start: sibling of `DRIVE.hysteresis`.
4. **`rivalry` hint granularity.** A single `adversarial: true` flag vs. a coarse heat band
   (`simmering` / `open`). Start: a coarse 2–3-step band (still a *word*, never a number), so the model
   can escalate the texture as the arc deepens.
5. **Mutual rivalry (out of scope v1).** The player reciprocating — *their* sustained targeting of the
   nemesis becoming a tracked two-way feud — is a natural sequel; v1 is the NPC→player arc only (the
   player's side stays player-knowledge, as 0085/0086 keep player drives/campaigns).
6. **Multiple simultaneous antagonists (deferred).** v1 caps at one nemesis for legibility; a secondary
   "rising rival" beneath the primary is a possible enrichment, not v1.

— Tracks #881.
