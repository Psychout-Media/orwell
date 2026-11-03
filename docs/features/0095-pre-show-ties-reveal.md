# 0095 — Pre-show ties as time-bombs (a sealed pre-alliance detonates when exposed)

> **Status:** ✅ **BUILT (2026-07-06).** `src/engine/seededRelationships.ts` (`exposure`/`nextTieExposure`/
> `exposedTies`), `src/engine/tieReveal.ts` (the overhear pathway) + `tieRevealConstants.ts`, and
> `accuseTie` (the `confide` sibling, four-place wired). Note: `ORWELL_SEEDED_TIE_SURFACING` (0059 §5) is
> a narrower, PRE-EXISTING precursor — ambient "seem close" suspicion only, no confirmed fact, no
> betrayal fold — and is untouched; 0095 ships as a SEPARATE pathway/flag (`ORWELL_TIE_REVEAL`), never a
> mode of §5. The "slip" pathway is deferred (no BDD scenario requires it); overhear + the
> player-reachable `accuseTie` cover the built v1. Wired in `cucumber.cjs`.
> **Tracks #867.**
>
> **Deploy status (2026-11-03):** only the automated **overhear** pathway is intentionally OFF in the deployed profile. `ORWELL_TIE_REVEAL` (TIE_REVEAL family; the off-screen overhear / tie-reveal scheduler) is not emitted by `deploy/orwell-env-defaults.sh` and is kept dark for the first playtest by owner direction. The player-reachable `accuseTie` lever is not behind that flag and stays live in the deployed profile.
> **Depends on:** 0001 (Vault Wall), 0002 (event visibility — a fact reaches the player ONLY through
> a modeled pathway; `surfaceInformationTo` / the `told-by` / overhear seam), 0017/0026 (the directed
> relationship model + the betrayal-shock the fallout reuses), 0023 (the consequence & memory fold —
> an exposure is a happening that folds + persists), **0059 (hidden seeded relationships — the source
> of the sealed [Hidden tie] this feature gives a reveal pathway and a payoff)**, 0038 (the
> off-screen society / gossip diffusion the rumor rides), **0077 (conspicuousness / house whispers —
> the diffusion-to-the-player pathway this reuses verbatim; `houseSuspicion.ts`)**, 0085/0086
> (campaigns/drives — an accusation that lands is a natural precipitant; an exposed tie re-aims who
> the house targets). **Sibling of** 0075 (trust-gated confidences — the *deliberate* way a sealed
> thing becomes player knowledge) and **0091** (trigger secrets — the *eruptive* way a sealed thing
> becomes a witnessed public consequence). 0095 is the **relationship-edge** member of that family: a
> sealed *connection between two houseguests* surfacing through a pathway, with house-shaking fallout
> on the involved edges + the wider house read. **Bounded by:** mandate #1 (behavioral fidelity — the
> exposed secret pre-alliance is one of the most electric beats in real _BB_), mandate #2 (Vault Wall
> — the tie stays sealed off player AND admin until a legitimate pathway surfaces it; the engine owns
> whether/when it surfaces and the seeded fallout magnitude), mandate #3 (anti-sycophancy — the
> exposure and its fallout are engine-decided + seeded, never narrated into being to please the
> player), mandate #4 (non-degradation — an exposed tie is a durable recorded event + a persisted
> "exposed" flag + persisted edge folds, and never thins).

## Why (the gap #867 names)

Feature 0059 seeds a small, hidden layer of **pre-show ties** — two houseguests who crossed paths in
casting, share a mutual friend, are from the same hometown, or already knew each other before the
show (`PreGameTie` in `src/engine/seededRelationships.ts`). The layer is correct as far as it goes:
sealed in the Vault (off player **and** admin), sparse (0–2 per season, often none), non-structural
(it folds only a small standing affinity bias, `TIE_AFFINITY_BIAS = 0.14`), and discovered "only
organically."

But "discovered organically" is, today, **aspirational** — there is no defined reveal pathway and no
payoff. The proof is in the engine's own retrospective prose: a tie

> *"…stayed hidden unless it came out in the house."*

— with nothing in the code that ever *makes* it come out, and nothing that *happens* if it does.
A seeded tie is, in practice, a permanently-sealed affinity nudge plus an end-of-season trivia line
in the 0048 unsealing. The single most _Big Brother_ thing a pre-show tie could earn — **a secret
pre-alliance getting exposed mid-game and detonating trust across the house** ("wait, you two *knew
each other* before this?!") — does not exist.

This feature makes a pre-show tie a **time-bomb**: it stays Vault-sealed until a legitimate in-game
pathway surfaces it (an overhear, a slip, an accusation that lands), and when it is **exposed** the
engine folds a bounded, seeded **house-shaking fallout** — a betrayal-grade blow on the involved
pair's standing with the houseguests who feel deceived, plus a wider bump in the house's read of the
two as a hidden duo (a threat to target). The player learns of an exposure only the same way anyone
does: through a pathway that terminates at them.

### The retention value: the electric twist the genre is built on

A revealed secret pre-alliance is a **franchise-defining** beat — the "you two have a *final two*
already?" / "they came in with a plan" reveal that reorders an entire season. Its pull is the same
**variable-ratio surprise** that powers 0075 (an earned confidence) and 0091 (a foreseeable
detonation): the player cannot predict *when* a tie comes out, only that the house is full of things
people are hiding, and the payoff (a sudden, board-shaking realignment) lands on an unpredictable
schedule. Crucially it is a **fair** surprise, not a cheap one — it is *foreseeable in hindsight*:
the player may have clocked the two as unusually comfortable (the affinity bias *is* observable, as
behavior), caught a whisper that "those two knew each other," or planted the accusation themselves.
When the tie blows up, the honest reaction is *"I knew something was off about them"* — a **plant
that pays off**, never a deus ex machina. The engine seeds the charge from real sealed state; the
timing is the only thing the player can't call. That is exactly the contract ADR 0003 holds for the
whole game — **earned and anchored, never a cold pop-up.**

## The bright line this respects (read first)

At a glance an exposure looks like it *breaks* the Vault Wall — the player learns real sealed state
(that two houseguests have a hidden tie). It does not, and the reason is the whole architecture
(§ "The event/visibility model" in `CLAUDE.md`, ADR 0002):

> **Visibility is per-event metadata, and a sealed fact legitimately becomes knowledge the moment it
> reaches a houseguest — or the player — through a modeled in-game pathway.** A houseguest *catching*
> a tie and *telling* others is exactly such a pathway; the player learning of it is the same seam
> 0077 already uses to tell the player about pairings they didn't witness.

Three structural facts hold the Wall, none of them prompt wording:

1. **The engine decides, not the model.** *Whether* a tie surfaces, *which* tie, *to whom* first, and
   *how big* the fallout is are all computed by the engine from the sealed 0059 layer + the
   relationship model + a seeded roll. The model is never handed the sealed tie and never selects or
   invents one — the `momentPrompts` "never invent biography beyond the card" rule already forbids
   the alternative. The model only **voices** a tie the engine has *already chosen to expose and
   recorded as exposed*.
2. **What's recorded is the exposure, surfaced through a pathway.** The instant a tie is exposed the
   engine writes the resulting belief through the **existing 0002 pathway seam** — NPC-to-NPC
   diffusion that, when a chain terminates at the player, lands a player belief (the 0077
   `diffuseGossip` → `surfaceInformationTo` path, with genuine content lineage, audit E9). So a
   surfaced tie is correctly **the holder's / the player's knowledge** (Journal-visible), not Vault
   content. This is the 0023 loop working: a happening → recorded → folded → persisted.
3. **The model is never given an *unexposed* tie.** `npcVoice`, the portrait/moment surfaces, and
   every projection still carry no sealed tie (the 0059 invariant is unchanged). The only tie text
   the model ever sees is the **public fact of an exposure the engine already committed** — exactly
   like 0059's `visibleShowmances()` only ever projects a showmance once it reaches the public
   `visible` stage. It cannot leak what it is not handed.

An exposure is therefore the **edge-layer companion** to its siblings: 0075 is a sealed *attribute*
becoming player knowledge by being *deliberately told*; 0091 is a sealed *volatility* producing a
*witnessed public consequence* with the attribute itself staying sealed; **0095 is a sealed
*relationship* becoming house-and-player knowledge by being *exposed through a pathway*,** with a
real, bounded, seeded fallout on the edges it deceived.

## The mechanic

### 1. The sealed tie gains an exposure state (the only new state)

A `PreGameTie` (0059) gains one engine-side field — a monotonic exposure state — mirroring 0075's
`disclosedToPlayer` and 0091's fired-trigger record:

```
exposure ∈ "sealed" | "surfaced-to-house" | "public"
```

- **`sealed`** — the 0059 default; invisible to player AND admin, only the affinity bias is
  observable (as behavior).
- **`surfaced-to-house`** — a pathway has carried the tie to *some* houseguests (its `knownTo` set,
  the symmetric-perspective spine 0085/0086 already use for campaigns); it is diffusing. It may have
  reached the player as a *belief* (a rumor with a source + confidence) without yet being a settled
  public fact.
- **`public`** — the tie is out in the open, the way a `visible` showmance is: naming the pair as a
  pre-show duo is now a public fact, not a Vault leak, so the narrator may voice it.

This is the **only** new sealed state. No new tie system, no new authoring: 0059 still seeds the
ties, seals them, and folds the bias; 0095 only gives an existing tie a way to *come out* and a
consequence when it does. Backward-compatible: an unexposed tie behaves exactly as it does on main.

### 2. The reveal pathways — how a tie legitimately comes out (engine-owned, gated)

A tie surfaces ONLY through a modeled in-game pathway — never exposition, never a cold pop-up. Three
pathways, each precipitated by something real and gated by a seeded roll (bounded **low** — an
exposure is a *treat*, sibling to `hiddenSurfacingRate = 0.05`):

| Pathway | Precipitant (a real spark) | Who learns first |
|---|---|---|
| **overhear** | the tied pair is conspicuously holed up together (the 0077 conspicuousness read — a private room, both lingering) and a plausibly-positioned third houseguest is around | the onlooker, then diffusion |
| **slip** | one of the pair, under strain (0041 rattled soul) or in a scene with a third party, lets the connection slip | the listener, then diffusion |
| **accusation that lands** | a houseguest (or the **player**) *accuses* the pair of a prior connection, and it **lands** — the accusation is *true* of a real seeded tie | the accuser + the room, then diffusion |

- **overhear / slip** are **off-screen NPC↔NPC** events (the 0038 society tick) — the player learns
  of them only if the resulting diffusion chain terminates at them (0077), as a belief with a source
  and a confidence, distorted with each retelling. No spark ⇒ no surfacing (the no-cold-open
  guarantee).
- **accusation that lands** is the **player-reachable** lever and the most _BB_ of the three. When
  the player presses a suspicion ("you two knew each other before this, didn't you?"), the model
  calls **`accuseTie(aId, bId)`** (the 0075 `confide` sibling — model previews/voices, **engine
  decides + commits**). The engine checks the sealed 0059 layer: if a real tie exists between the
  pair it **lands** (the tie surfaces, recorded as the player's knowledge through the pathway, fallout
  folds); if not, it **misses** — the accusation is recorded as an ordinary (possibly damaging-to-the-
  accuser) social scene, and the player has merely guessed wrong. The engine **never confirms or
  denies via a number or a tell** — the player infers a hit from the *fiction* (the pair's reaction,
  the house's shift), exactly as 0075 gives no "they're lying" marker. An NPC may equally be the
  accuser off-screen.

A surfacing also **promotes** through the states: a first pathway moves `sealed → surfaced-to-house`
(diffusing, possibly reaching the player as a rumor); sustained spread / a public confrontation moves
it to `public` (the narrator may now name the pre-show duo openly), exactly the way 0059's showmance
arc advances `spark → bond → visible` only as the live relationship genuinely develops and only at
`visible` may the narrator voice it.

All gates + the per-season exposure cap live in **one tunable `TIE_REVEAL` constants module**
(`tieRevealConstants.ts`, the `GOSSIP` / `CONFIDENCE` / `THREAD` sibling — the B59 grep gate covers
it). No constant is decorative (audit E53): every weight has a real consumer. Exposures are **rare and
capped** — a per-season cap (`maxExposuresPerSeason`, default ≤2, mirroring 0059's own "≤2 ties"
sparseness), so a house of unmasked pre-alliances is noise, not drama.

### 3. The fallout — a bounded, seeded, house-shaking consequence (0023 / 0026)

An exposure is not just narration; it **folds real consequence** along **existing pathways**, the
0023 loop. The fallout has two parts, both engine-owned and seeded (the model never proposes a
number — ADR 0005: it may voice the *drama*, the engine owns the *magnitude*):

1. **A betrayal-grade blow on the deceived edges.** A hidden pre-alliance coming out reads as
   *deception* to the houseguests who feel they were played. For each houseguest who learns of the
   tie (its `knownTo`), their directed edges toward **both** members of the pair take a fold sourced
   from the existing **`BETRAYAL_SHOCK`** (`relationshipConstants.ts`) — trust ↓, affinity ↓, threat
   ↑, reliability ↓ — scaled by that learner's *confidence* in the belief (a fifth-hand rumor barely
   registers; a public confrontation lands hard), exactly the way 0038's `GOSSIP_HEARD` already
   scales a heard rumor's fold by confidence. This is the "trust detonating across the house" — but
   **graded and bounded**, never a flat house-wide flag.
2. **A wider house read of the two as a hidden duo (a threat to target).** Beyond the betrayal sting,
   the house now *reads the pair as a unit* — a concealed bloc is a strategic threat. The threat
   signal toward both members rises for the learners, which legitimately re-aims drives/campaigns
   (0085/0086) onto the exposed duo (the engine's seeded decision weights already read the
   relationship layer — no new decision path; the exposure just moves the edges the existing vote /
   nomination / campaign logic reads).

The **player's own** reads are never asserted (anti-sycophancy / 0017): the player learns the *fact*
("the house is saying those two knew each other") and watches the houseguests' *behavior* shift; the
engine never tells the player how *they* feel about it, never shows a number, and never flags "this is
a betrayal." Paranoia and the realignment are the human's to form.

### 4. Determinism & calibration neutrality (sacred — the heavy-sims must stay byte-identical)

This is **texture, never the spine** (the 0077 / 0085 / 0086 discipline, verbatim):

- The exposure rolls + the diffusion run on a **DEDICATED rng stream** (e.g.
  `${seed}:tie-reveal:…`), **never** the shared society / competition / vote streams.
- The feature is **opt-in / isolated**: gated behind its own flag (the `ORWELL_CAMPAIGNS`-style seam)
  AND, by construction, doing nothing when no tie exists (the common case — ties are sparse and often
  none). With it off, or with no seeded tie, **no roll is taken and no edge is touched**, so the
  seeded `juryReach` + gradient + UAT outcomes are **byte-identical** (the same guard 0077/0085/0086
  hold, proven by the heavy sims).
- The fallout fold reuses the **existing** bounded `BETRAYAL_SHOCK` / `GOSSIP_HEARD` magnitudes and
  the proven 0026 update rule — no new uncapped delta. The per-call / per-beat-per-edge fold budgets
  (`MAX_FOLDS_PER_INTERACTION` / `MAX_FOLDS_PER_PAIR_PER_BEAT`) are unchanged.

This is the ADR 0005 split in miniature: the **open set** (the drama of a tie coming out, the
scene's prose) is recorded faithfully and voiced freely; the **closed set** (whether it surfaced, the
seeded fallout magnitude, the persisted exposure state) is engine-dictated and never normalized away.

## Engine seams (where this lands)

A pathway-driven fold like 0095 is **not** an FE-driven write-back; it lives engine-side beside its
0059/0077 kin (no new MCP four-place wiring for the off-screen pathways). The one player-reachable
lever (`accuseTie`) follows the 0075 `confide` shape, which *is* a `GameSession` action.

- `src/engine/seededRelationships.ts` — add the `exposure` field to `PreGameTie` (default `"sealed"`),
  a pure `nextTieExposure(state, …)` promoter (sibling to `nextShowmanceStage`), and a Vault-free
  **public** projection (`exposedTies()` — names a pair ONLY at `public`, the `visibleShowmances`
  sibling). No content/serializer change to the sealed audit form.
- `src/engine/tieRevealConstants.ts` *(new)* — the single `TIE_REVEAL` tunable (the per-pathway
  surfacing rate, the strain/precipitant gate, the confidence-scaled fallout weights that select from
  `BETRAYAL_SHOCK`, the per-season exposure cap). The `GOSSIP` / `CONFIDENCE` sibling.
- `src/engine/houseSuspicion.ts` (or a sibling `tieReveal.ts`) — the **overhear / slip** pathway:
  reuse `whisperConspicuousPairings`' onlooker + `diffuseGossip` machinery, but for a *tie* the
  diffused fact carries the exposure (and, unlike a pure position whisper, **does** carry a `rel`
  fold — the deceived-edge betrayal blow), on the dedicated rng. A chain reaching the player lands the
  belief.
- `GameSessionAdapter`:
  - the off-screen tick (`campaignTick` / the 0038 society tick) evaluates the gated overhear/slip
    pathways for any sealed tie whose pair is conspicuous / strained, promotes the exposure state,
    folds the fallout (confidence-scaled), and persists.
  - a new action **`accuseTie(aId, bId)`** on the `GameSession` port / `PLAYER_TOOLS` — the
    player-reachable lever: checks the sealed 0059 layer, **lands or misses**, records the result
    through `surfaceInformationTo` (the `setOnConfide`-style pathway seam) on a hit, folds the fallout,
    increments the exposure cap, and returns a Vault-safe `{ landed, exposure }` (no number, no tell on
    a miss). The single authority — like `confide`/`runCompetition`, the model previews/voices, the
    engine decides + commits.
  - the retrospective (0048) renders an **exposed** tie distinctly from one that stayed sealed
    ("…and it came out in week N, blowing up the house" vs. today's "…it stayed hidden") — reading
    the persisted exposure state, both ids resolved to names (the existing
    `preGameTieToRetrospectiveProse` Vault-free renderer, extended).
- `src/engine/momentPrompts.ts` — the `social` moment + the lever manifest gain `accuseTie` (when to
  call it; that the engine decides whether the accusation *lands*; never assert a tie the lever didn't
  confirm). An `exposedTies()` public fact is voiced as texture once `public`, never as a number.
- **FE follow-on (0055 sibling):** the agent loop already error-corrects the model's tool
  under-calling. A small guardrail — when the player's turn is clearly accusing a pair of a prior
  connection — can call `accuseTie` itself so an earned exposure beat is never silently dropped.
  (Spec'd here; built FE-side, pytest-gated.)

## Persistence (0007/0030 — non-degradation)

- Each tie's **`exposure`** state is persisted in the snapshot (sibling to 0059's already-persisted
  `seededRelationships` and 0075's `confideState`), monotonic (never regresses to a *less*-exposed
  state on restore — once it's out, it's out). A restored game remembers exactly which ties have come
  out and how far.
- The per-season **exposure count** persists (sibling to `surfacedThreadCount` / `confideLieCount`).
- The exposure belief + the edge folds are ordinary recorded 0002 events + 0026 edge state — already
  durable; they deepen, never thin. A pre-0095 save with no exposure field ⇒ every tie defaults to
  `sealed` (byte-identical to today).

## Testability (role-only; HARD rules)

- **Vault Wall (the load-bearing test, incl. admin):** a `sealed` tie never appears on `npcVoice`,
  the retrospective-while-sealed, any player **or** admin projection, or `exposedTies()`; a sentinel
  sweep over the assembled prompt finds no sealed tie pre-exposure. An admin/God-Mode surface returns
  no sealed tie (the producerVault DEBUG door is the only exception and is out of scope here).
- **No leak before a pathway:** with no precipitant (the pair not conspicuous, no strain, no
  accusation), no tie ever surfaces and no `exposedTies()` entry exists; the only observable remains
  the 0059 affinity bias (behavior).
- **The pathway surfaces it correctly:** when a pathway fires, the tie becomes the *learner's* (and,
  when the chain terminates at the player, the *player's*) recorded knowledge with content lineage —
  Journal-visible, never Vault content; `exposure` promotes monotonically.
- **An accusation that lands vs. misses:** `accuseTie` on a real seeded pair **lands** (surfaces +
  folds); on a pair with no tie it **misses** (no surfacing, no Vault read, recorded as an ordinary
  scene); the player surface shows **no number and no tell** distinguishing a hit from a miss beyond
  the fiction.
- **House-shaking, but bounded:** an exposure folds a betrayal-grade adverse move on the deceived
  edges (trust ↓ / affinity ↓ / threat ↑) toward **both** members for the learners, scaled by
  confidence; a fifth-hand rumor moves the edge far less than a public confrontation; the fold is
  bounded (never a flat house-wide flag), and it re-aims the existing seeded decision weights (the
  exposed duo becomes a more likely target) without a new decision path.
- **Anti-sycophancy:** the exposure + fallout are engine-computed + seeded, never narrated
  convenience; no raw number crosses; an exposure never fires more generously for the player than the
  seeded roll dictates, and the player's own read is never asserted.
- **Calibration byte-identical when off / when no tie:** with the feature flag unset, or in a season
  with no seeded tie, no roll is taken and no edge is touched ⇒ `juryReach` / gradient / UAT
  byte-identical (the 0077/0085/0086 guard).
- **Rare across a season:** the number of exposures never exceeds `TIE_REVEAL.maxExposuresPerSeason`.
- **Determinism:** seeded on a dedicated stream — same seed + same history ⇒ same exposure timing,
  same pathway, same fallout.

## ADR 0003 fit (the conversation is the game)

This is squarely on the north star: it adds **no scripted scene**, hands the model **facts to voice,
never a script** (a Vault-free public fact of an exposure, a `{ landed }` outcome — the model writes
the "wait, you two *knew each other*?" drama itself), and the play happens **in conversation** (the
player presses a suspicion; the accusation lands or misses in the dialogue). It earns its tokens
against the **sameness** fix — a seeded, hidden tie that can detonate makes seasons diverge — and the
**leaks** fix is *strengthened*, not strained: the tie reaches the player only through a modeled
pathway, recorded as their knowledge. No dashboard, no UI replacing chat — UI may at most reflect a
now-public duo on the memory wall once `public`.

## Acceptance criteria

1. A seeded pre-show tie (0059) is **sealed** by default and surfaces ONLY through a modeled pathway
   (overhear / slip / an accusation that lands); it never leaks before one, to player **or** admin.
2. When a tie is exposed, the engine folds a **bounded, seeded, confidence-scaled** betrayal-grade
   fallout on the deceived edges (trust ↓ / affinity ↓ / threat ↑ toward both members for the
   learners) and the house reads the pair as a hidden duo (a threat to target), re-aiming the
   existing seeded decision weights — with **no new decision path** and **no flat house-wide flag**.
3. The exposure reaches the player ONLY through a pathway terminating at them (a rumor with a source +
   confidence, or a landed accusation), recorded as the player's knowledge with content lineage —
   Journal-visible, never Vault content; the player is shown **no number and no tell**.
4. `accuseTie` is the single player-reachable authority — it **lands** on a real tie and **misses** on
   none; the engine decides, records, and folds; the model only voices.
5. The exposure state is **monotonic** and **persisted** (non-degradation); exposures are **rare and
   capped** per season.
6. **Calibration neutrality:** with the feature off, or in a season with no seeded tie, the seeded
   heavy-sims (`juryReach` / gradient / UAT) are **byte-identical**.

## Open questions / defaults (resolve at build)

1. **Player-as-accuser confirmation surface.** v1 gives the player only the fiction (the pair's
   reaction, the house's shift) to infer a hit — no marker. Should a *landed* accusation eventually
   read as a louder, clearly-witnessed public confrontation (a stronger "it's out now" beat) while a
   miss stays a quiet social scene? (Recommend: yes, gate the louder confrontation on the `public`
   promotion — keep v1's no-tell rule intact.)
2. **Default surfacing rates + the exposure cap.** Start the per-pathway surfacing rate **low**
   (sibling to `hiddenSurfacingRate ≈ 0.05`) and `maxExposuresPerSeason ≤ 2` (mirrors 0059's "≤2
   ties"); tune against the UAT once live — felt, never deterministic, never flattening variance.
3. **Showmances too?** 0059 also seeds hidden *showmances*, which already have an organic
   `spark → bond → visible` arc. A *pre-show* showmance exposed before it would naturally go `visible`
   is a natural extension (a hidden romance outed = an even bigger blow). Recommend: keep v1 to
   **pre-game ties** (the clean "secret pre-alliance" case #867 names); a follow-on can extend the
   same exposure machinery to a sealed early showmance.
4. **Distortion on the way to the player.** A tie that reaches the player fifth-hand should arrive as
   a *belief* ("I heard those two have history") with low confidence, not a settled fact — reuse the
   0038 gossip distortion/decay verbatim. Confirm the confidence floor at which a player belief is
   strong enough to act on (the existing knowledge/suspicion threshold, 0002).
