# 0090 — Per-archetype voice (the cast reads as different people)

> **Status:** ✅ **BUILT (2026-06-27)** — Tracks #868. Per-archetype `signature`/`lexicon` pools +
> harder dial anchoring in `src/engine/voice.ts`, and the voice fingerprint THREADED through the
> engine-authored confessional prose (`src/engine/confessionals.ts` voice-keyed parallel pools, wired in
> `GameSessionAdapter`), with the `momentPrompts` voicing lever tightened to govern diction + cadence.
> Gates: `tests/unit/voice0090.test.ts` (per-archetype distinctiveness, voiced-confessional diction,
> byte-identical fallback, Vault-safety) + the juryReach calibration band (byte-identical — voice rides
> the isolated side rng, the confessional phrasing consumes no extra draw). The next layer on top of the **already
> shipped** 0084 voice fingerprint: 0084 *minted* a per-houseguest `VoiceProfile` and surfaced it on
> `npcVoice`; 0090 makes that voice **genuinely distinctive per archetype + per soul** AND threads it
> through the prose the **engine itself authors**. **As built, that is the confessionals ONLY** (`src/engine/confessionals.ts`, gated by `voice0090.test.ts`); the deep-profile hidden prose and the story-thread / retrospective text are **not** voiced and still read in the template voice (corrected 2026-11-12, ORW-286 item 8: this paragraph used to claim all three). **This is a
> build-ON of 0084, never a replacement** — `src/engine/voice.ts` + `src/domain/voiceProfile.ts` +
> `Character.voice` already exist and stay the carrier. **Depends on:** 0084 (the `VoiceProfile` on
> `CHARACTER` + the `npcVoice` voicing seam this extends), 0058 (deep profiles / `CharacterFactory`,
> where the static voice is minted, and the conditioned prose pools in `src/engine/deepProfile.ts`
> whose sameness this addresses), 0040 (NPC confessionals — the first engine-authored prose surface to
> gain voice), 0048 (the retrospective unsealing, where voiced confessionals/threads pay off), 0041 +
> `emotionalArc` (the soul whose live state *inflects* — never mutates — the voice). **Pairs with**
> #850 (cross-cast de-collision of the generated *text*) and #854 (the umbrella prose-template sweep).
> **Sibling of** 0084. **Bounded by:** mandate #2 (Vault Wall — voice is a public, observable facet
> and carries **no** hidden state), mandate #3 (anti-sycophancy — voice is computed deterministically
> from the seed, never bent to the player), and mandate #4 (non-degradation — voice is identity:
> byte-stable across the whole game).

> **Owner direction (2026-06-25, the audit idea this tracks, #868):**
> *"Beyond the verbatim-collision bug (#850), the templated phrasing makes confessionals/threads feel
> interchangeable across characters (shared motivation tails, identical blind-spot frames). Give each
> archetype (and ideally each soul) a distinguishable voice — diction, cadence, recurring tics — so the
> cast reads as individuals."*

## The problem (and why 0084 did not finish it)

0084 shipped the right *shape* — every houseguest carries a byte-stable `VoiceProfile`
(`src/domain/voiceProfile.ts`: six dials + a prose `signature` + a light `lexicon`), archetype-biased
at cast time in `src/engine/voice.ts` (`generateVoice` + `VOICE_ARCHETYPE_BIAS`), surfaced on
`NpcVoiceView.persona.voice`. That fixed the **live-narration** half: when the model *fetches*
`npcVoice` to voice a houseguest in a scene, it now has a fingerprint to inhabit.

Two gaps remain, and they are exactly what the #868 audit caught reading the Producer's Vault dump:

1. **The 0084 voice is NOT threaded through the prose the ENGINE authors.** Confessionals (0040),
   the deep-profile hidden prose (secrets / true-goals / blind-spots, 0058) and the story-thread /
   retrospective unsealing (0048) are composed from **shared template pools** with no voice
   inflection at all. `src/engine/confessionals.ts` is the smoking gun: every houseguest's
   confessional is drawn from the same `TARGET_LINES` / `ALLY_LINES` / `MOOD_LINES`
   (`confessionals.ts:49-65`), so a blunt comp-beast and a rambling social-butterfly confess in
   **identical phrasing** — "I need {T} gone — they're my biggest threat." The deep-profile generator
   (`deepProfile.ts`) likewise composes secrets/goals/weakness from archetype/vocation/age pools that
   carry **no voice**, and the retrospective (0048) then unseals sixteen confessions and hidden
   stories that all sound like one writer. The narration layer can voice a *live* scene through the
   fingerprint, but the engine-authored interior monologue never does — and that is the most-read
   surface at the 0048 payoff. (This is distinct from #850, which is the *verbatim collision* of the
   conditioned deep-profile text; 0090 is the **uniform-voice** problem that persists even after #850
   de-collides the words: de-collided text in one even register still reads interchangeably.)

2. **The 0084 fingerprint is only loosely archetype-anchored, so two people of the same archetype —
   and even two of *different* archetypes — can still read alike.** The bias is a single
   `BIAS_STRENGTH = 0.55` chance the archetype's lean wins each dial (`voice.ts:74`), with the
   `signature` and `lexicon` drawn from one flat pool shared by every archetype
   (`voice.ts:36-55`). So the archetype barely colors the *texture* the reader actually feels — a
   villain and a peacemaker can draw the same signature line and the same fillers. The audit asked
   for voices "keyed to archetype/soul" that are genuinely distinguishable; 0084's are keyed but not
   yet **distinctive**.

Both are **missing facts, not missing UI** — squarely ADR 0003's remit (hand the model facts to
voice; here, also voice the facts the engine itself writes).

## Why distinct voices drive attachment and retention

A reality cast is *bingeable* because its people are unmistakable — you know who is talking before
you see the name. Sameness is the enemy of attachment: when every confessional reads in one even,
articulate register, the cast blurs into "an AI playing everyone" and the player stops forming the
per-person reads that the whole social game runs on (paranoia, loyalty, the gut-punch of a betrayal).
The non-degradation mandate (#4) exists precisely to stop this kind of flattening; #868 files it as
an *immersion* defect because it is the difference between a memorable house and a forgettable one.
Distinct voices are also load-bearing for the rest of the engine: the player infers trust and threat
from *how* someone talks (0017/0020), and a houseguest who sounds the same whether calm or cornered
leaks no tell to read. Voice is the last mile that makes the deep substrate legible.

## The mechanic

0090 has two halves, mirroring the two gaps. Both are deterministic, Vault-safe, and byte-stable, and
both reuse the existing 0084 `VoiceProfile` — nothing here invents a parallel voice system.

### 1. A sharper, archetype-anchored, soul-inflected voice descriptor (CHARACTER)

The 0084 `VoiceProfile` stays the carrier; its **generation** in `src/engine/voice.ts` becomes
genuinely per-archetype distinctive, and a small **soul inflection** is layered on at voicing time
(never at mint time — see CHARACTER vs SOUL below):

- **Per-archetype `signature` + `lexicon` pools.** Instead of the single flat `VOICE_SIGNATURES` /
  `VOICE_LEXICON_POOL` shared by the whole cast, each archetype gets its *own* small pool of
  signature lines and habitual fillers that fit that archetype's diction and cadence — a comp-beast's
  clipped strut, a mastermind's measured hedge, a flirt's teasing lilt. The archetype now colors the
  **texture the reader feels**, not just the structured dials. (The flat pools remain the fallback for
  an archetype with no specific pool, so the change is additive.)
- **Stronger archetype anchoring on the dials**, tuned so an archetype's *core* dials (the one or two
  that most define how it sounds) win reliably, while the rest stay free — so two comp-beasts still
  differ, but neither reads like a peacemaker. (A tuning of 0084's `VOICE_ARCHETYPE_BIAS` /
  `BIAS_STRENGTH`, not a new mechanism.)
- **Cross-cast de-collision of the voice itself.** The cast is *dealt* signatures and lexicon with
  spread caps (the `deepProfile.ts` `spreadFacet` / `MAX_PER_*` discipline, already proven for
  hair/features and for the deep-profile pools) so no signature line or filler piles up across the
  cast. This is the voice-layer sibling of #850's de-collision; it guarantees distinctiveness even
  when the pools are small.
- **Soul inflection (the "per-soul" half), applied at read time only.** A houseguest's *current*
  voice carriage bends with their live soul **through the fingerprint's existing `stressTell`** and
  the 0084 `mood` word — a blunt houseguest who "goes quiet" under pressure reads as a real tell; a
  rattled soul tightens the cadence. The inflection is a *read* of the soul (0084's `moodWord`
  already does this), never a rewrite of the byte-stable descriptor. This keeps voice = identity
  (stable) while the *delivery* tracks the moment (dynamic) — exactly 0084's resolved split.

### 2. Thread the voice through the prose the engine authors

This is the half 0084 did not do and the one #868 is really about. The engine-authored prose surfaces
gain a **voice-aware composition path** so each houseguest's hidden-layer prose reads in *their* voice:

- **Confessionals (0040, the first and highest-value surface).** `confessionalFor` gains the
  houseguest's 0084 `VoiceProfile` (+ the live mood it already accepts) in its `ConfessionalContext`.
  When present, the target/ally/mood lines are drawn from **voice-keyed variants** (or lightly
  transformed — clipped vs. rambling phrasing, the archetype's diction, a habitual `lexicon` filler
  woven in) so a comp-beast's confessional and a social-butterfly's read as two different people even
  when they share the same engine-grounded *content* (same target, same ally — that truth never
  changes; only the *phrasing* does). The retrospective (0048) then unseals a chorus of distinct
  voices.
- **Deep-profile hidden prose + story-thread / retrospective text (0058/0048).** The same voice-keyed
  phrasing applies where the engine composes a houseguest's secrets/goals/weakness
  (`src/engine/deepProfile.ts`) and renders a thread premise or a humanized retrospective line in a
  houseguest's voice (the `src/domain/humanize.ts` pools #854 is sweeping), so the hidden story does
  not read in one uniform template voice either. This is the direct fix for the audit's "shared
  motivation tails, identical blind-spot frames."
- **The narrator contract tightens.** `src/engine/momentPrompts.ts` already tells the model to voice
  through the `voice` fingerprint "CONSISTENTLY all season" (the 0084 lines). 0090 strengthens that to
  make explicit that the fingerprint governs **diction and cadence**, not just register — and
  reconciles, again, with the standing no-catchphrase rule: a voice is a *texture* (rhythm, the way
  they hedge, a habitual "honestly"), **never** a bit repeated for laughs. The `lexicon` is a light
  seasoning, not a punchline.

The crucial invariant: **voice changes only the phrasing, never the facts.** The confessional's
target/ally is still the engine's relationship truth; a thread's premise still carries the same
secret; an outcome is still the engine's. 0090 is a *rendering* concern over already-decided content —
it cannot alter a single game fact (that would cross into the closed set, ADR 0005). The
`expressiveNonCollapse` discipline applies: voice is open-set texture; it never normalizes or moves a
closed-set value.

## CHARACTER (stable) vs SOUL (dynamic)

This feature lives almost entirely on the **static `CHARACTER`** side, which is the whole reason it is
safe and non-degrading:

- **The voice descriptor is `CHARACTER`** — minted once at cast time, byte-stable for the entire game
  (it already rides `Character.voice`, snapshotted by 0007/0030). Voice is *identity*: a person does
  not stop sounding like themselves because they got betrayed. This was 0084's resolved owner ruling
  and 0090 holds it absolutely — the descriptor never mutates, never drifts, never thins.
- **The SOUL only *inflects delivery*** — the live `emotionalState` / `volatility` (0041) bend the
  *carriage* of the voice through the existing `stressTell` and the 0084 `mood` word, computed as a
  **read** at voicing/confession time. Nothing about the soul is written into the descriptor and
  nothing about the descriptor is written into the soul. The dynamism is real (a rattled houseguest
  confesses in a tighter cadence) but it is a projection of the soul, recomputed each time, never a
  stored change to identity. This is the same two-timescale split 0084 settled: identity stable,
  affect dynamic.

## Vault-safety (voice carries no secret state)

Voice is a **public, observable** facet — how a person talks is not a secret — so it is outward-safe by
construction, the same status 0084 established:

- The descriptor rides only the **outward** projections (`NpcVoiceView.persona.voice`, the public
  card) — never a Vault handle. dependency-cruiser proves no outward module imports `VaultStore`.
- **No hidden state may be *encoded* in voice.** A houseguest's secrets, true goals, threat reads, or
  relationship numbers must NEVER be inferable from their voice descriptor or its application. The
  generation reads only the **public** `archetype` (and the *observable* mood carriage, itself
  Vault-free), never the hidden deep profile, the soul scalars as numbers, or any relationship edge.
  A sentinel sweep over the assembled voice projection and over every voiced confessional/thread that
  *crosses to the player* finds no sealed premise and no number. (Confessionals themselves stay
  Vault-only by witness set — 0040; 0090 changes only their phrasing, not their visibility, so a
  voiced confessional is exactly as sealed as before and reaches the player only at the 0048
  post-season unseal.)
- The soul inflection surfaces only the **observable carriage** (the 0084 mood word — "on edge",
  "worn but steady"), never the hidden *cause* and never a number. The player reads the delivery as
  behavior and infers the rest themselves (anti-sycophancy / 0017).

## Determinism & non-degradation

- **Deterministic from seed.** The voice descriptor is generated off a names-keyed **side rng** (the
  0084/0058 pattern), so it is reproducible — same seed ⇒ same cast voices — and **never perturbs the
  main house stream** (stats, names, outcomes stay byte-stable; the calibration spine is untouched).
  The voice-aware confessional/thread phrasing likewise runs on a seeded, **isolated** stream (the
  `deepProfile.ts` two-stream precedent: narrative text on a dedicated rng so its variable draw count
  cannot shift a single outcome). With voice application absent (a pre-0090 save, or the fallback
  pools), the seeded game is **byte-identical**.
- **Stable across the game (non-degradation #4).** A houseguest's voice is identical across a
  snapshot/restore and across every soul-evolving beat — voice is `CHARACTER`, it accumulates no
  drift. The *delivery* moves with the soul, but the *identity* never thins. A restored game's cast
  sounds exactly like itself.
- **Anti-sycophancy.** Voice is computed from the seed + the public archetype, never from the player
  or to please them. No houseguest's voice softens toward the player; no number crosses.

## ADR 0003 fit ("the conversation is the game")

0090 is a textbook ADR 0003 move: it makes the conversation *richer* by handing the model (and the
engine's own prose) **better facts to voice** — a distinctive per-person voice — rather than adding UI
or scripting lines to recite. It removes sameness (a degradation) and otherwise gets out of the
model's way: the fingerprint is texture to inhabit, never a script. The "lingering is play" and
"people must make sense" principles are served — a houseguest who *sounds* like one consistent person
all season makes more sense than one who shifts registers turn to turn — and the change is testable
structurally (distinctiveness, byte-stability, Vault-safety) per the ADR's testability section.

## Relationship to #850 and #854

These three are layers of the same "the cast reads as one writer" problem and are designed to compose:

- **#850 (de-collision bug)** removes *verbatim* repetition of the generated deep-profile **text**
  across the cast (identical motivation tails, same-sector secrets). It fixes *what words* repeat.
- **#854 (umbrella sweep)** audits *every* prose-template pool for id-token leaks, occupation
  coherence, render fidelity, and cross-cast collision — the systematic hygiene pass.
- **#868 / 0090 (this feature)** addresses the residue that survives both: even with de-collided,
  hygienic text, the cast reads alike because the *phrasing style* is uniform. 0090 gives each
  archetype/soul a distinct **voice** and **threads it through** the prose. 0090 should land **after
  or alongside** #850/#854 (it consumes the same pools and the same spread-cap discipline); it does
  not block them and is not blocked by them. Where 0090 adds voice-keyed phrasing to a pool #854 is
  sweeping, the two coordinate on that file.

## Engine seams (where this lands)

- `src/engine/voice.ts` — per-archetype `signature` + `lexicon` pools (replacing the single flat pools
  as the *biased* source; flat pools retained as fallback); stronger dial anchoring; a cast-wide
  **deal** with spread caps (`generateCastVoices(seed, npcs)` sibling of
  `dealCastPhysicalSpread`/`generateCastDeepLayer`) so signatures/fillers don't collide across the
  cast. `generateVoice` keeps its fixed draw count (calibration-neutral).
- `src/engine/voiceConstants.ts` (a new sibling of 0084's `voice.ts` data, or folded into it) — the
  per-archetype pools + the anchoring/cap constants, the single tunable (the 0026/0028
  sibling-constants pattern; the B59 grep gate covers it).
- `src/engine/confessionals.ts` — `ConfessionalContext` gains an optional `voice?: VoiceProfile`
  (+ the live mood it already accepts); voice-keyed target/ally/mood phrasing when present, the
  current shared lines as the deterministic fallback when absent (byte-identical to today).
- `src/engine/deepProfile.ts` + `src/domain/humanize.ts` — voice-aware phrasing for the secrets/goals/
  weakness composition and the thread/retrospective lines (#854 coordinates on these pools).
- `src/adapters/engine/GameSessionAdapter.ts` — pass each confessor's `CHARACTER.voice` + derived mood
  into the confessional/deep-profile context (engine-side; the voice is public, the mood is the
  Vault-free read); `npcVoice` already carries `voice` (0084) — 0090 needs no new outward field.
- `src/engine/momentPrompts.ts` — tighten the voicing-lever prose: the fingerprint governs **diction +
  cadence**; reconcile the no-catchphrase rule. Pinned in the lever-manifest drift test.
- `src/ports/GameSession.ts` — **no new outward shape required** (voice already projects via 0084);
  0090 is generation + application, not a new projection. (If a future need surfaces the per-archetype
  pool choice, it would ride the existing public `voice` facet — never a hidden field.)

## Persistence (0007/0030 — non-degradation)

- `voice` is already part of `CHARACTER` and snapshotted byte-stable (0084/0007); a round-trip leaves
  it identical. 0090 adds no new persisted state — the per-archetype pools are static data, the soul
  inflection is a derived read, and the confessional phrasing is recomputed (the confessional *event*
  it produces is already durable via 0040, and deepens — never thins — across a season).

## Testability (role-only; HARD rules)

- **Two archetypes read distinctly:** generate a cast; the confessionals (and the live 0084 `voice`
  fingerprints) of houseguests of two *different* archetypes are textually distinct in
  signature/diction (not the shared template line) — asserted role-only (a blunt-archetype houseguest
  vs. a warm-archetype houseguest), no names.
- **Distinct within an archetype too:** two houseguests of the *same* archetype still differ on at
  least their free dials / signature / lexicon (the cross-cast spread cap holds) — no two are
  voice-identical across a full cast; a seeded property test asserts low collision.
- **Voice is stable across the game (non-degradation):** a houseguest's `voice` descriptor is
  byte-identical across a snapshot/restore and across many soul-evolving beats; only the *delivery*
  (mood/stress carriage) moves.
- **Vault-safe:** a sentinel sweep over the voice projection and over any voiced prose that crosses to
  the player finds no sealed secret, no soul scalar, and no number; the generator reads only public
  facets; dependency-cruiser proves no outward module imports `VaultStore`. A voiced confessional is
  still Vault-only (witness set unchanged) and reaches the player only at the 0048 unseal.
- **Voice changes phrasing, never facts:** a confessional voiced two different ways still names the
  same engine-grounded target/ally; the `expressiveNonCollapse` discipline holds — voice never moves a
  closed-set value.
- **Deterministic from seed:** same seed + same cast ⇒ same voices and same voiced phrasing
  (reproducible); the voice-application stream is isolated, so the seeded competition/jury calibration
  is **byte-identical** whether voice application is on or off.
- **Anti-sycophancy:** no voice softens toward the player; no number ever crosses.

## Open questions / defaults (resolve at build)

1. **Per-archetype pool size.** Start small (3–5 signatures + 4–6 fillers per archetype) and tune
   against a live read; the spread caps keep even small pools distinct across a 15-cast.
2. **Phrasing transform vs. parallel pools for confessionals.** Two viable shapes: (a) voice-keyed
   *parallel* line pools (a clipped `TARGET_LINES` set, a rambling one…) or (b) a light deterministic
   *transform* of the shared lines (trim/expand by `rhythm`, weave a `lexicon` filler by `energy`).
   Recommend (a) for the highest-value confessional surface (clearest distinctiveness, easiest to
   test) and (b) where a pool is large (#854's swept pools) — decide per surface at build.
3. **How strong to anchor the dials.** 0084's `BIAS_STRENGTH = 0.55` reads slightly weak for the
   *core* dials; consider per-dial anchoring (core dials win ~0.8, free dials stay 0.5) rather than a
   single global strength — tune once it is heard.
4. **Soul inflection depth.** v1 reuses the 0084 `mood` + `stressTell` only (no new soul read). A
   louder per-soul voice shift (e.g. cadence tightening proportional to volatility) is a possible
   enrichment, gated to stay Vault-safe (carriage only, never the cause, never a number).
5. **Light regional/accent flavor.** Keep it *light* and text-respectful (cadence + word choice, never
   phonetic spelling or caricature), reconciled with 0063 (identity is one true facet, never
   reductive) — same default 0084 set.

Tracks #868.
