# 0116 — Model-authored cast genesis inside an engine validation envelope (phase 2 of the casting upgrade)

> **Status:** ✅ **BUILT (2026-07-12, #1403; engine envelope #1485, FE driver #1540) and BDD-gated in `cucumber.cjs`.** Casting has since been reworked by the One Casting Bible (#1780): a seeded `FacetLedger` is dealt before any model call, genesis runs one 15-wide wave (`GENESIS_CHUNK_SIZE` 5 to 15), and a generic closed-facet-diff validator guards `recordCastProfile`; read the phasing and chunking language below as the original design. *(Original status:)* 📝 **SPEC — drafted 2026-07-11; the seven genesis design questions are OWNER-DECIDED
> (2026-07-11) and baked in below as decided, not open.** Phase **2** of the casting upgrade: phase 1
> (in flight, branch `claude/cast-authoring-upgrade`) re-routes **deep** authoring (0058) to the
> narration model at temperature 1.1 under the **strict enrichment policy**; this spec re-routes the
> **skeleton itself** — the model proposes the ENTIRE 15-NPC cast, and the engine validates, clamps,
> and commits it inside an envelope it owns.
> **Historical (pre-build) requirement:** the spec once required owner sign-off on the [ruling #1 amendment](#5-ruling-1-amendment-owner-sign-off-required)
> below before build. The feature has since been built; §5 and §9 #1 are retained as the original sign-off ask,
> and the formal ruling-doc ratification is tracked in the audit ledger / `PO-REVIEW-LEDGER.md`, not here.
> **Builds on (does NOT duplicate):** **0004** (replayability & naming — amended by this spec),
> **0058/0065** (deep profiles + the pre-warm/`recordCastProfile` write-back seam — the model already
> authors the *depth*; this extends the same propose→validate→seal discipline to the *skeleton*),
> **0063** (the diversity floors + `repairDiversityLayer` — **the direct mechanical precedent**: an
> LLM-proposed identity layer the engine validates/repairs against engine-owned targets),
> **0059/0095** (seeded pre-show ties + their exposure model — the tie graph is now in the proposal's
> scope), **0084** (voice fingerprints), **0091** (trigger arming), ADR **0013** (cast photos require
> a model-authored identity — the same "no synthetic-feeling floor" instinct, now applied to the
> whole person), ADR **0016** (model selection). **Generalizes** ADR **0005** (split authority by
> openness) **to world-generation**: character *identity* is open-set creative content the engine
> must record faithfully and never normalize; character *power* (stats, magnitudes, seeded weights)
> is closed-set and stays engine-dictated. **Bounded by:** mandate #2 (Vault Wall — hidden proposal
> material seals engine-side and never reaches player OR admin), mandate #3 (anti-sycophancy — **no
> model number escapes the clamp**, and genesis is **player-blind by construction**), mandate #4
> (non-degradation — the committed genesis is the persisted world-gen artifact), and the testing HARD
> rules (roles only, never names — unchanged).

## 1. Why — the gap this closes (the owner's ruling)

Today `CharacterFactory` (`src/engine/characterFactory.ts`) generates the cast skeleton from **finite
pools** under a seeded RNG: ~500 given names × ~800 surnames (vendored corpora), a **12-value
archetype enum** with fixed stat biases (±0.05 jitter), 20 demeanors, 5 wordings per hidden-element
pool, 4 tie natures, ~12-entry appearance pools. The L28/G24/0063 waves added *caps and floors* so a
single season spreads well — but across seasons the generator's **support is the same finite set**,
and the owner has ruled the result feels redundant:

> *"people look similar because they are generated from a finite pool of data at inception."*

Phase 1 (in flight) fixes the **texture**: deep profiles, biographies, and secrets become
model-authored at high temperature instead of pool-drawn. But the **skeleton underneath** — who these
fifteen people *are*: their identity concept, their persona, which secrets they carry, who knew whom
before the show, how their competitive power is shaped — still comes from the same twelve archetypes
and five secret wordings. A model-authored biography wrapped around a pool-drawn skeleton is a better
paint job on the same chassis. Phase 2 makes the chassis model-authored too.

## 2. The design — propose → validate → commit (owner-decided shape)

**Call shape (DECIDED #1): cast-sketch + 15 deep calls.** One **cast-LEVEL sketch call** designs the
ensemble — who exists, the spread, the pre-show tie graph, the house dynamics-to-be — then the
in-flight **phase-1 deep pass runs unchanged**: fifteen per-NPC deep-authoring calls at temperature
1.1 (`recordCastProfile`, parallel, resumable, backoff/give-up, portraits gated behind authoring —
the 0063 pipeline order *identity → author → shoot* keeps holding). The deep pass receives each NPC's
committed sketch identity **verbatim as its brief**, so depth is written onto the sketch's ground
truth, never invented beside it.

**Player-blind (DECIDED #2).** The genesis calls carry **zero knowledge of the player** — no casting
intake, no name, no profile field crosses into the sketch or deep prompts. Sycophancy-proof by
construction: a cast cannot be bent toward (or against) a player it has never seen. Because an
accidental near-duplicate is still possible by chance, a **post-hoc validator** compares the
committed proposal to the player's intake and **nudges** (re-rolls the colliding facet of) any NPC
that lands too close (name collision, or the same vocation+hometown combo — the L28 non-mirroring
rule, now a validator instead of a construction property).

**The seeded season brief (DECIDED #5) — how the seed stays meaningful.** The engine's seeded RNG
generates a short **casting brief** for the sketch call — a demographic skew, a regional flavor, an
ensemble vibe ("skew older this season; a heavy Gulf-coast contingent; a house built for slow-burn
grudges") — drawn from engine-owned dimensions on a dedicated side-stream. Same seed ⇒ same brief, so
the brief is **seed-dependent and replayable**, and different seeds **steer different casting
directions** (the brief-dimension space is finite, so distinct seeds can occasionally deal similar
briefs — the brief steers variety; the model's open-ended generation on top of it is what breaks
pool-sameness, not a brief-uniqueness guarantee). The brief is derived only from the seed —
player-blind like everything else in genesis.

**Scope (DECIDED #7): skeletons + the tie graph.** The sketch call proposes, per NPC and cast-wide:

- **Names** — full model freedom, validated not pooled (uniqueness, plausibility shape, the
  legacy-Bible ban list, **no player-name collision**) — see the envelope (DECIDED #4).
- **Freeform identity** — a per-NPC concept in the model's own words. The **archetype enum becomes a
  DERIVED mechanical tag**, not a generative constraint: the proposal carries the freeform identity
  *plus* its nearest canonical `Archetype` mapping, and the engine keeps the tag only as the coupling
  key for the systems that consume it (0084 voice biasing, 0085 influence minting, campaign
  aggression). The freeform identity is stored **verbatim alongside** the tag — the tag never
  replaces it (ADR 0005 principle 2, applied to world-gen).
- **Public persona** — background, vocation, hometown, demeanor, appearance/physical
  characteristics, age, presentation; the 0063 descriptive identity facets (heritage/ethnicity,
  gender presentation, orientation + disclosure).
- **Hidden elements** — per-NPC secrets in the model's own words, each carrying one of the existing
  **closed** `HiddenElementKind` values (the *kinds* are mechanical couplings and stay a closed set;
  the *details* are open-set prose).
- **The pre-show tie graph** (0059/0095) — 0–2 proposed pairs with a nature + a freeform tie
  backstory, engine-validated for graph sanity, sealed with `exposure: sealed`.
- **Orientation fields** (0059/0063) — public (`outOrientation`) vs. private (Vault-sealed); these
  feed the engine's own orientation-aware showmance seeding downstream.
- **Voices** — a per-NPC 0084 `VoiceProfile` proposal within the structured dial shape.
- **Per-NPC stat proposals** — **banded variable totals** (DECIDED #3; the envelope's centerpiece).

**Explicitly OUT of scope (DECIDED #7):** week-1 drives, campaigns, and every other dynamics layer
stay engine-side, seeded off the committed cast exactly as today. (Model-proposed opening dynamics
are a *possible phase 3*, noted, not specced.)

The engine **validates the whole proposal against an envelope it owns**, repairs or re-rolls what
fails, splits public from hidden, **seals the hidden half into the Vault**, and commits the cast.
The committed cast is byte-stable from that moment exactly like today's (0007/0031 superset guard).

### What stays engine-only (never proposable — the anti-sycophancy hard line)

No proposal field may set a **hidden game weight**. The following remain engine-seeded off the
committed cast, exactly as today: 0085 `influence` (persuasiveness/susceptibility), 0091 trigger
arming + `volatility` numbers (the model may *write* a volatile secret; the engine decides arming on
its own side-rng), the 0058 Day-1 perception of the player, soul baselines
(`emotionalBaseline`/`volatility`), 0059 **showmance seeds** (a showmance seed is outcome-adjacent
dynamics, not identity — it stays an engine draw over the committed, orientation-aware cast), the
`TIE_AFFINITY_BIAS` magnitude, week-1 drives/campaigns (0086/0085), and every relationship-edge
number. The model authors **who people are**; the engine keeps **how much anything weighs**.

## 3. The envelope contract

| Proposal field | Model proposes | Engine validates / owns | On violation |
|---|---|---|---|
| **Cast shape** | 15 NPCs, exactly | Count, id assignment; **player-blind input** (no player field in any genesis prompt — a structural gate, not a convention) + the **post-hoc near-duplicate nudge** (name / vocation+hometown collision with the player re-rolls that facet) | re-roll |
| **Names** | **Full model freedom** — freeform full names | **Validated, not pooled**: per-house uniqueness (given, surname, full — #853), plausible shape (two+ tokens, length caps, no digits/markup), the **legacy-Bible deny-list** (the 0004 BDD ban, unchanged), **no player-name collision**, cross-season prior-name exclusion (NAME-1/#547), C8-style length caps | re-roll the offending NPC |
| **Identity / persona prose** (identity concept, background, vocation, hometown, demeanor, appearance, biography seed) | Freeform | **Recorded faithfully, never normalized** (ADR 0005 open set); C8 length caps + `neutralizeForPrompt` on any prompt-echoed value; the L28 **caps** (≤2 per vocation, region spread, ≤2 per demeanor, ≤2 per build) and 0063 **floors** validated cast-wide (`repairDiversityLayer` precedent — repair where repair is identity-preserving, else re-roll); coherence with the **seeded season brief** is steering, never a validator (the brief guides; only the engine's own caps/floors bind) | repair, else re-roll |
| **Archetype tag** | The nearest canonical mapping for each freeform identity | Tag ∈ the existing 12-value enum; tag is a **derived coupling key** — the freeform identity is stored verbatim beside it and is what the narrator voices | re-derive engine-side |
| **Stats** | **Banded variable totals** (DECIDED #3): each NPC's total + its distribution — who is strong at what, and *how strong they are overall* | **The engine owns the band**: each NPC's stat total must land in an engine-owned band — default **70–100% of the engine's reference maximum** (`GENESIS_TOTAL_MAX`, pinned at build on the [0,1]³ scale; band = `[0.70 × max, max]`) — so **real comp beasts AND real floaters exist** by design; per-stat **[min, max] clamps** (default ~[0.2, 0.9]); and a **cast-wide variance floor** — a real spread of totals and per-stat dispersion across the cast (no super-cast, no dud-cast, no fifteen identical mid-liners). Out-of-band numbers are **clamped/renormalized inside the band**, never accepted raw — **no model number escapes the clamp**. Exact constants live in a tunables module (the 0028 precedent) | clamp/renormalize; cast-wide variance failure ⇒ re-roll |
| **Hidden elements** | Freeform `detail` per element, kind ∈ the existing closed `HiddenElementKind` set | Per-NPC count in `HIDDEN_ELEMENT_RANGE` (3–6); the **C9 consistency gates** (a concealed aptitude must be genuinely stat-backed AND publicly concealed; ≤1 secret motive); **Vault routing via the existing write-back seam** — hidden details never land on the public `Character`, never in any projection; no stat-key substring / bare-float leak in any *public* string (the deepProfile no-leak discipline) | strip/re-roll the offending element |
| **Pre-show tie graph** (in scope, DECIDED #7) | 0–2 pairs, nature + freeform backstory | **Graph sanity**: the 0059 **sparseness budget** (0–2, sparse-by-design), valid distinct pairs, no NPC in more than one tie, never a tie to the player; sealed into the Vault with `exposure: sealed` (0095); the affinity fold magnitude stays `TIE_AFFINITY_BIAS`, engine-owned | drop excess / re-roll |
| **Orientation & identity facets** | Ethnicity/heritage, gender presentation, orientation + disclosure | The full **0063 pipeline unchanged**: floors/caps via `repairDiversityLayer`, `skinTone` re-grounded from final heritage, **private orientation Vault-sealed**, public `outOrientation` only when out; descriptive only — never a game weight | repair (0063's own semantics) |
| **Voices** | 0084 `VoiceProfile` dials + signature prose | Dial values within the structured shape; register spread cast-wide; byte-stable post-commit (voice is identity) | re-derive engine-side |
| **Hidden game weights** | **NEVER** | Influence, trigger arming/volatility, Day-1 perception, soul baselines, showmance seeds, week-1 drives/campaigns, all magnitudes: engine-seeded off the committed cast, exactly as today | proposal fields ignored + flagged |

## 4. Failure semantics — async pre-warm, bounded re-roll, then LOUD before finalize

**Latency (DECIDED #6): genesis runs ASYNC during the casting interview** — the `preSeedCast`
pre-warm pattern (0065). The sketch call fires when the interview opens; validation, re-rolls, and
the deep pass overlap the player answering casting questions, so the felt latency is **zero** on the
happy path.

Validation returns **structured violations** (which NPC, which field, which rule). The FE driver
echoes them into a **bounded re-roll** (≤N attempts, N a tunable; violations quoted back to the model
the same way `ignoredCastingKeys` echoes a mis-filed casting answer). Re-rolls are **per-NPC where
the violation is per-NPC** (one bad stat line re-rolls one houseguest, not fifteen); cast-wide
violations (variance floor, diversity floors, tie-graph sanity) re-roll the cast-level slice.

When the budget is exhausted, behavior forks on the **strict enrichment policy** (phase 1, in
flight — whose shipped precursor is the **#1313 house-entry authoring gate**, PO ruling 2026-07-10:
*the deterministic seeded floor is never a viable cast identity in prod*, 15/15, no un-authored NPC
enters the house):

- **Strict (a real model is wired — the prod path):** genesis failure is **LOUD**, and it must
  surface **BEFORE casting finalize** (DECIDED #6): `createCharacter` is **held/refused** while
  genesis is failed-strict — the player is told during the interview, with the operator-visible
  refusal naming the last violation set (the `[house-entry-gate]` HOLD surface). The game does
  **not** start on the deterministic floor, and the failure is never discovered only *after* the
  player commits their character. Never a silent floor.
- **Floor-permitted lanes (keyless CI / `ORWELL_ALLOW_FLOOR_START=1` / the `soft` policy only):** the
  deterministic factory **simply stands** — the same fail-soft contract as every FE-driven write-back,
  which is what keeps the test floor byte-neutral (§7). *(Amended 2026-11-11, ORW-260, Ryne BDD card 30
  option B: under the default `strict` policy the cast skeleton AND the deeper backstories (0058, cast
  authoring) are REQUIRED — "I don't want a fallback". A failed authoring run latches
  `orwell_cast_authoring.strict_failed`, and the pre-finalize gate in `do_create_character` refuses the start once,
  loudly, with a ledger entry. The world snapshot and the off-screen detail stay fail-soft.)*

## 5. RULING #1 AMENDMENT (owner sign-off required)

> *Historical: this was the pre-build sign-off ask. The feature is built; read the "Ask" below as the original request, not an open blocker.*

**Product ruling #1 (2026-06-10, "no fixed cast")** currently binds the *mechanism*: NPC names are
**seeded samples from the vendored real-name corpora** — corpora as raw material, no hard-coded
full-name+persona pairing, the legacy Bible's names banned. This spec **amends the mechanism while
preserving — and strengthening — the intent** (per owner decision #4: full model freedom on names,
inside validators):

- **Mechanism change:** names (and the whole skeleton) become **model-generated,
  engine-validated** rather than corpus-sampled. The name validators keep everything the ruling
  actually protects: per-house + cross-season uniqueness, the **legacy-Bible deny-list** (unchanged,
  still test-guarded), plausibility shape, **no collision with the player's name**, and no possible
  hard-coding — **per-season generation makes a fixed cast structurally impossible**: there is no
  longer any static pairing *to* hard-code, which is a strictly stronger guarantee than sampling
  from a fixed pool.
- **What survives verbatim:** the vendored corpora remain, powering the **test-lane deterministic floor**
  (§7; not a prod fallback), so the 0004 `isCorpusName` inverse-realism gate becomes **floor-scoped** rather than
  universal. The legacy-name ban applies to **both** paths (the deny-list moves from "excluded from
  the corpora" to "excluded from the corpora AND enforced by the genesis name validator").
- **Testing rule UNCHANGED:** roles only, never names, in tests. Sample saves stay format-only.

**Ask:** the owner ratifies this as *ruling #1 (amended)* — "no fixed cast" enforced by
**validation + per-season generation** instead of **pooling**, with the deny-list and the roles-only
test rule intact.

## 6. Cost & call classes

The decided shape adds **one** cast-level sketch call per game start (~1–2k in / ~3–6k out ≈
$0.01–0.05 at the current ADR 0016 defaults — `z-ai/glm-5.2` narrator / Qwen 3.6 Flash utility, per
its 2026 amendment) plus bounded re-roll attempts, on top of
the fifteen already-budgeted phase-1 deep calls. The sketch joins the 0069 token-policy table as its
own call class (admin-editable `max_tokens_budget`, metered + ledgered like every LLM boundary
crossing). The rejected alternative — one combined skeleton+depth mega-call — was declined by the
owner: a ~25–40k-token output with fifteen chances to fail one validator, a whole-payload re-roll
cost, and it would bypass the entire shipped phase-1 pipeline (per-NPC backoff/give-up, the 15/15
gate, portrait gating, the `recordCastProfile` cross-character guards).

## 7. Test floor, determinism & the recorded artifact

- **The deterministic factory remains**, verbatim, as the floor for **test lanes only** (never a prod fallback: under `strict` a failed genesis refuses the game start — ORW-286 item 3, Ryne BDD card 30): stubbed lanes, keyless CI,
  calibration/heavy sims (and, historically, the golden replay, decommissioned 2026-07-21). **No model wired ⇒ byte-identical** cast generation to
  today (the fail-soft write-back contract; the byte-neutrality gate in §8).
- **Genesis output is RECORDED into the save as the world-gen artifact.** Replays read the store,
  never re-call the model — the same pattern the non-degradation spine (0007/0030: recall, never
  regenerate) and the (now decommissioned, 2026-07-21) 0108 golden record/replay seam enforced; `castGenesisByteNeutral` is the current guard. The committed cast carries a
  provenance marker (the `deepProfileAuthored` / `worldSnapshot.source` precedent) so the 0031
  superset check can tell "authored skeleton" from "thinned floor" exactly once, then holds
  byte-stability forever. The **seeded season brief** is part of the artifact (recorded with the
  proposal it steered).
- **Golden-fixture staleness (historical):** this note once required a serialized re-record of the
  committed golden fixture; the golden-path replay apparatus (0108) was decommissioned 2026-07-21,
  so no re-record is owed.
- **Calibration:** the seeded spine runs on the floor and is untouched by construction. But a
  committed genesis cast *plays*, and the banded-variable-totals envelope deliberately admits a
  **wider power spread** than today's archetype table — so the build owes a **genesis-shaped
  property gate** (§8): seeded-random envelope-passing casts through the jury sim must keep the
  `EARNED_WINS` band, and the band constants are tuned until they do.

## 8. Testability (role-only; HARD rules)

- **The banded-totals clamp:** a stat proposal whose total lands outside the engine's band commits
  **clamped/renormalized inside the band** — **no model number escapes**; per-stat values inside
  [min, max]; a top-of-band NPC and a bottom-of-band NPC are both *legal* (comp beasts and floaters
  exist by design).
- **Cast-wide variance floor:** a flat super-cast (or dud-cast, or fifteen identical mid-liners)
  proposal is refused/re-rolled; the committed cast clears the dispersion floor.
- **Names validated, not pooled:** a duplicate name, an implausible shape, a legacy deny-list name,
  and a player-name collision are each refused with a structured violation.
- **Player-blind, structurally:** the genesis prompts contain **zero player fields** (a structural
  gate over the assembled prompt, not a convention); an accidental near-duplicate of the player is
  caught by the post-hoc validator and its colliding facet re-rolled.
- **The seeded season brief:** same seed ⇒ same brief (byte-equal); the brief derives only from the
  seed (player-INDEPENDENT); it steers but never binds (a proposal ignoring the brief but passing
  every validator still commits).
- **Archetype derived, identity verbatim:** the committed tag is a legal enum member driving the
  mechanical couplings; the freeform identity is stored **byte-equal** and is what projections
  voice (the expressive-non-collapse pattern, applied to world-gen).
- **Vault routing:** committed hidden elements, tie backstories, and private orientations appear on
  **no player or admin projection** (sentinel sweep, both surfaces); the public `Character` carries
  no hidden field; the genesis payload is never logged verbatim (0071 redaction) and never re-enters
  narrator context after commit.
- **Tie-graph sanity:** a proposal with three ties, a self-tie, a duplicate pair, an NPC in two
  ties, or a tie to the player is repaired/re-rolled to the 0059 budget; committed ties seal with
  `exposure: sealed` and fold only the engine-owned bias.
- **Bounded re-roll:** an invalid proposal re-rolls ≤N times with violations echoed; per-NPC
  violations re-roll only that NPC.
- **Loud failure BEFORE finalize (strict):** re-rolls exhausted with a real model wired ⇒ casting
  finalize (`createCharacter`) is **held/refused** with a visible refusal naming the violations,
  surfaced during the interview — asserted **not silently floored** and **not discovered
  post-finalize**.
- **Test-floor byte-neutrality:** with no model wired (stubbed lane), cast generation is
  **byte-identical** to today's deterministic factory across seeds.
- **Recorded artifact / non-degradation:** reload reads the committed genesis (brief included) from
  the store — never re-generates; the superset gate accepts the one-directional floor→authored
  transition and refuses any later thinning.
- **Boundary test (the four-place gotcha):** the genesis write-back dispatches through
  `McpServer.callTool` end-to-end (the `castPrewarm`/`worldSnapshotBoundary` template — a pre-game
  tool, so `HttpMcpServer`'s `SANDBOX_CREATING_TOOLS` too).
- **Calibration property gate:** seeded-random envelope-*passing* casts through the jury sim keep
  the `EARNED_WINS` band (the genesis-shaped analog of `juryReach`).

## 9. Open decisions (PO) — what remained after the 2026-07-11 answers (historical; the feature is built)

1. **Ratify the ruling #1 amendment** (§5) — the blocking decision.
2. **Exact envelope constants** (`GENESIS_TOTAL_MAX`, the 70–100% band edges, per-stat clamps,
   dispersion floor, re-roll budget N, brief dimensions) — firmed in a tunables module at build time
   (the 0028 precedent), tuned against the §8 calibration property gate.
3. **Seam shape:** extend `preSeedCast` (which already warms a pre-game cast and matches the decided
   async-during-interview lifecycle) vs. a new `proposeCastGenesis` write-back. Recommendation:
   extend `preSeedCast` — same lifecycle, fewer four-place surfaces.
4. **Whether the calibration property gate (§8) blocks the build PR** or lands as a follow-on
   heavy-sims lane.
5. *(Phase 3, noted only)* model-proposed opening dynamics (week-1 drives/campaigns) — explicitly
   out of scope here per owner decision #7.

## 10. Dependencies & traceability

Extends the 0058/0065 write-back discipline (propose → validate/repair → split → seal) from depth to
skeleton; runs the 0063 `repairDiversityLayer` pipeline unchanged; brings the 0059/0095 tie graph
into the proposal under engine graph-sanity validation; keeps 0084 voice byte-stability, 0091
engine-side arming, and every hidden weight engine-seeded. Amends ruling #1 (§5) and generalizes ADR
0005 to world-generation: **identity is open-set (model-authored, recorded faithfully); power is
closed-set (engine-dictated, banded, clamped, seeded).** Player-blind by construction; steered by a
seeded season brief so the seed stays meaningful. Under 0001 (Vault Wall) and 0021 (isolation);
metered under 0069; failure semantics governed by the phase-1 strict enrichment policy (#1313
precedent) with the loud-before-finalize gate. Source: owner ruling on cross-season cast redundancy
("generated from a finite pool of data at inception") + the seven owner design decisions, 2026-07-11.
