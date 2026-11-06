# 0101 — NPC myth-making (you become house folklore)

> **Current default (AMEND 2026-11-06):** `ORWELL_MYTH_MAKING` is **default ON** in the engine (`src/featureFlags.ts`, `defaultOn`; `=0` turns it off, and the deploy profile sets it too). The "default off" / "opt-in" wording below records how it was built and calibrated (byte-identical OFF), not today's default.

> **Status:** ✅ **BUILT 2026-07-05.** Tracks issue **#883**.
> **Gate:** engine (`tests/unit/legends0101.test.ts` — the pure selector + adapter/calibration-neutrality
> gate; `test:arch`'s dependency-cruiser Vault boundary; BDD `0101-npc-myth-making.feature`, wired into
> `cucumber.cjs`, step defs `npc_myth_making.steps.ts`). Default ON behind `ORWELL_MYTH_MAKING` (`=0` opts out) (also a
> `setBehavioralFlags({ mythMaking })` God-Mode runtime dial) — default OFF, byte-identical to the
> pre-feature build when off. The front-end voicing path (the model repeating "people are saying you…"
> from the existing surfaced belief) rides the SAME rumor-surfacing pathway 0002/B27b already uses —
> no new front-end wiring was needed.
> **Builds directly on (does NOT duplicate):** the 0002 gossip-diffusion model already in
> `src/engine/gossip.ts` — beliefs carry `factId` lineage + `source` + `confidence` (decaying per hop)
> + `distortion` (growing per hop), diffuse NPC-to-NPC along the affinity graph, and reach the player
> **only** when a chain of tellings terminates at them. This feature adds **one new origin** for that
> existing machinery — a belief whose **subject is the player**, seeded from a notable player act — and
> reuses the diffusion, distortion, and player-terminal surfacing **wholesale**. It is not a new gossip
> system.
> **Depends on:** 0001 (the Vault Wall — the diffusing legend is hidden-layer state, surfaced only via a
> terminating pathway), 0002 (the relationship model + the gossip diffusion this rides), 0023 (the
> consequence & memory fold — a notable player act is already a recorded event with a fold; this reads
> that ledger, it does not invent a new happening), 0038 (the live off-screen society + `diffuseGossip`
> wiring in `orchestrator.ts`), 0049 (presence — co-presence is how a legend gets its first earwitnesses).
> **Sibling of** 0088 (the *living current read* — how each NPC reads the player **now**; this is the
> complementary outward arc: how the **house collectively mythologizes** the player, distorted and
> spreading) and 0094 (distorted-gossip consequences). **Bounded by:** mandate #1 (behavioral fidelity —
> your reputation becoming folklore is the most *Big Brother* thing there is), mandate #2 (the Vault Wall
> — the legend diffuses in the hidden layer, never a Vault read, never to admin), mandate #3
> (anti-sycophancy — the engine seeds the legend from what actually happened and the human forms their own
> read; a player-subject legend must **never** fold the player's own edges) and mandate #4
> (non-degradation — legends accumulate and deepen over a season, they do not thin).

> **Owner direction (Tracks #883):**
> *"As I do big things in the house, I want people to start talking about me — to build a legend. The
> reputation I earn should become house folklore: sometimes accurate, sometimes wildly exaggerated, and
> it should grow with each retelling. I want to watch myself become a character in their story."*

## The problem this fixes

The house already gossips about itself. When two NPCs scheme off-screen, `orchestrator.ts` occasionally
turns that scene into a rumor (`rumorFrom(initiator, partner, type)`) that diffuses along the affinity
graph and can reach the player — *"word around the house is that \<A\> and \<B\> are getting awfully
close, supposedly."* The belief carries provenance, decaying confidence, and growing distortion. It works.

But that machinery only ever has **NPC↔NPC scenes** as its subject. **The player is a permanent graph
node who only ever *receives* gossip — never its subject.** So the single most satisfying long-arc beat in
a social game does not exist: **the player doing something notable and the house turning it into a story
about *them*** — accurate or exaggerated, growing with each retelling, eventually circling back as *"people
are saying you…"* The player can feel how an individual NPC reads them (0088), but they never get to watch
their own reputation become **shared house folklore** — a legend with a life of its own, drifting away from
the truth as it spreads.

This is a **missing origin for an existing pathway, not a missing system** (ADR 0003 — the conversation is
the game): the diffusion already exists and already terminates at the player; we add the one source class it
was never given (the player) and let the cast voice the legend it produces. We add **no panel, no meter, no
reputation number** — the legend reaches the player as a houseguest *saying* it, in conversation.

## The core idea — your notable acts seed legends that spread and distort

```
notable player act (already a recorded 0023 event with a fold)
  → engine SEEDS a gossip belief whose SUBJECT is the player          (a "legend seed")
    (a vague, public-facing GLOSS of the act — never the verbatim scene, never a hidden cause)
  → the EXISTING 0002 diffusion carries it NPC-to-NPC along the affinity graph
    (decaying confidence, growing distortion — each retelling drifts it further from the truth)
  → it reaches the player ONLY when a chain of tellings terminates at them
    → the model voices it: "people are saying you …" — the player hears their own legend, distorted
```

Everything after "engine SEEDS" is the **unchanged** 0002 machinery. The new surface area is small and
sits entirely at the **origin**:

1. **What counts as notable** — a small, engine-side selector over the player's *already-recorded* events
   (a comp win, a veto save/use, a blindside the player orchestrated, a public blowup, a bold ceremony
   move). It reads the 0023 ledger; it invents no happening. Only **rare, genuinely notable** acts seed a
   legend (a house that mythologizes every sentence is noise, not folklore — capped, below).
2. **The legend gloss** — a vague, **public-facing** paraphrase of the act (the sibling of `RUMOR_GLOSS` /
   `rumorFrom`), keyed to the act's *observable* class, **never** the verbatim scene and **never** a hidden
   cause. *"the new HOH is running this house,"* *"won that veto out of nowhere,"* *"the one who sent \<X\>
   home,"* *"not as harmless as they look."* The gloss is the only authored string; distortion does the
   rest.
3. **The legend diffuses and distorts** via 0002 — verbatim reuse of `diffuseGossip`: the belief carries
   `subject = PLAYER`, a `factId` (so every retelling is the *same* legend across the house), decaying
   `confidence`, and per-telling `distortion`. The same legend can reach the player as several increasingly
   garbled versions — which **is** the "grows with each retelling" the owner asked for.
4. **It circles back** — the player is already a diffusion terminal; a chain terminating at them lodges the
   (distorted) legend as the player's own knowledge with full provenance, and the model voices it as a
   houseguest repeating what the house is saying about them.

### Accurate *or* distorted — the distortion is the feature

Because the legend rides the existing decay/distortion model, what comes back to the player can be:

- **Accurate** (a short chain, high confidence): *"everyone's saying you ran that whole vote."*
- **Exaggerated** (a longer chain): *"I heard you've got half the house in your pocket"* from a single
  well-played week.
- **Wrong** (a long, low-confidence chain): a legend that has drifted into something the player never did.

The player **judges which it is** — there is no truth marker, no confidence number, no "this is
exaggerated" tag (anti-sycophancy / 0017 — the read is the human's to form). Watching a true thing become a
tall tale, or a small thing become a reputation, is exactly the retention beat #883 is about.

## Why this is the outward complement to 0088 (and not a duplicate)

| | **0088 — living current read** | **0101 — myth-making (this)** |
|---|---|---|
| Question | how does **this one NPC** read you **right now**? | what is the **whole house** *saying about* you? |
| Carrier | a Vault-safe carriage word on `npcVoice` (`toward`/`drift`) — behaviour | a **gossip belief** (subject = player) diffusing in the hidden layer |
| Truth | derived live from the **real** NPC→player edge | a **distorting** legend, drifting from the truth as it spreads |
| Reaches player | as the NPC's conduct toward them (always present when voiced) | only when a **diffusion chain terminates** at them (rare, earned) |
| Builds on | the relationship edge | **the 0002 gossip diffusion** |

0088 is *one NPC's private read*; 0101 is *the house's collective story*. They compose (a houseguest can
read you warmly **and** repeat a damning legend they half-believe) and never overlap in mechanism.

## Engine seams (where this lands)

- `src/engine/gossip.ts` — add the **legend gloss** for a player act: a `LEGEND_GLOSS` table +
  `legendFrom(act): string` (the player-subject sibling of `RUMOR_GLOSS` / `rumorFrom`). Pure, no I/O, no
  Vault handle. The vague, observable-class paraphrase only — never the verbatim event, never a cause.
  Add `legendConstants` (or fold into `GOSSIP`): the seed probability, the per-season legend cap, and the
  notability threshold (the `THREAD`/`GOSSIP`/`DRIVE` one-tunable-home pattern; the B59 grep gate covers it).
- `src/engine/offscreen.ts` **or** a small `src/engine/legends.ts` *(new)* — a pure **notable-act selector**
  `notablePlayerActs(events, sinceTick)` that scans the player's *already-recorded* events for the rare,
  genuinely-notable, **player-witnessed/public** ones worth mythologizing. Reads the ledger; records nothing.
- `src/composition/orchestrator.ts` — at the **same off-screen tick** that already runs the society + the
  NPC↔NPC `diffuseGossip` (≈ the `GOSSIP.riseProb` block), add a **legend pass**: occasionally pick one
  fresh notable player act, build `legendFrom(act)`, and call the **existing** `diffuseGossip(...)` with
  `origin` = a houseguest who plausibly witnessed it (a co-present earwitness — 0049), `subject = PLAYER`,
  and **no `rel` fold** (see calibration below). This reuses the same affinity-graph build + the same
  player-terminal surfacing already in that block. The per-season cap is enforced here (sibling of
  `THREAD.maxSurfacedPerSeason`).
- `src/engine/momentPrompts.ts` — when a legend belief (subject = player) is in the player's knowledge for
  the scene, the voicer guidance: *a houseguest may repeat what the house is saying about the player —
  "people are saying you…" — as the distorted belief the engine surfaced; never assert it as fact, never
  hand the player a confidence or a truth marker, never invent a legend the diffusion didn't deliver.*
- **No new outward surface, no new port method.** The legend is an ordinary gossip belief on the existing
  knowledge layer and reaches the model through the existing surfacing — exactly where NPC↔NPC rumors
  already do. (No `readsVault` tool, no admin field, no HUD — ADR 0003.)

## Persistence (0007/0030 — non-degradation)

- A legend belief is an **ordinary 0002 knowledge fact** — already durable and already round-tripped by
  `KnowledgeService.serialize`/`load`. Legends therefore **accumulate and deepen** over a season exactly
  like every other belief; they do not thin (#4).
- The **per-season legend count** persists in the snapshot (sibling to `surfacedThreadCount` /
  `whisperPairings`'s budget), so a restored game does not re-mint the season's myth budget.
- The **seeded notable acts already exist** in the event store; the selector is a pure read over durable
  data, so a restart re-derives the same legends.

## Vault Wall (mandate #2 — symmetric: player AND admin)

- **The legend gloss is public-facing by construction.** It is keyed to the act's **observable** class (a
  comp won, a nominee saved, an eviction the player drove in the open) — never a hidden cause, never a
  verbatim hidden scene, never a sealed attribute. The 0031 leak sweep stays strict about exact strings
  because the gloss is a *paraphrase*, exactly as `rumorFrom` already is.
- **It diffuses in the hidden layer and reaches the player only via a terminating pathway** — the same
  Vault-legal rule that makes all gossip legal (0002): a belief becomes the player's knowledge only when an
  in-game chain of tellings ends at them, recorded with provenance. No legend is ever *handed* to the player
  out of band.
- **Never a Vault read.** The selector reads the **player-witnessed / public** event ledger and the
  affinity graph — engine state, not Vault content. No part of this feature reads `VaultStore`; it adds no
  `readsVault` tool (the dependency-cruiser boundary stays green).
- **Walled from admin / God Mode too.** The diffusing legend is hidden-layer belief state; no admin /
  God-Mode surface exposes it, its `factId`, its confidence, or the diffusion graph. The "admin allowlist is
  Vault-free" guarantee is unchanged — this feature adds no admin field.

## Anti-sycophancy & determinism / calibration-neutrality (mandate #3)

This is the most important constraint and the easiest to get wrong:

- **A player-subject legend must NEVER fold the player's own edges.** `diffuseGossip` already forbids
  folding the *player-listener's* reads (`listener === PLAYER` is guarded in `foldReceipt`). 0101 keeps the
  symmetric rule: a legend *about* the player must not move how the **player** feels about anyone — the human
  forms their own reads (ADR 0003 / 0017). The engine seeds and spreads the story; it never tells the player
  what to think of it.
- **No NPC→player edge fold from a distorted legend (default), so the seeded spine stays byte-identical.**
  NPC↔NPC gossip folds the *listener→subject* read (`GOSSIP_HEARD`), which is calibration-load-bearing —
  that is why the off-screen NPC↔NPC diffusion runs on the **shared** stream. A player-subject legend is
  spread with **no `rel`/`subjects` fold** (the `whisperPairings` discipline: pass `diffuseGossip` no `rel`),
  so it **moves no edge and is byte-identical** to the calibration spine whether on or off. Letting a
  *legend* (a distorted belief) silently raise the whole house's threat read of the player would also be a
  back-door anti-sycophancy hazard (the cast turning on the player over a rumor the engine minted) and a
  calibration perturbation — so it is **out of scope for v1** (open question #3 below; if ever added it rides
  a dedicated rng, gated, and proven against `juryReach`). How each NPC *actually* reads the player still
  evolves only from **real recorded conduct** (0023/0088), never from folklore.
- **The legend pass is opt-in / isolated ⇒ byte-identical.** Like the `whisperPairings` seam, the legend
  diffusion runs on a **dedicated rng** (off the game seed + tick counter, never the shared
  society/competition/vote stream) and applies **no fold**, so the seeded `juryReach` / gradient / UAT
  outcomes are byte-identical with the feature on or off. An absent legend layer on an old save ⇒
  byte-identical behaviour.
- **Seeded.** Same seed + same history ⇒ the same notable acts selected, the same legends seeded, the same
  diffusion (the existing `diffuseGossip` is already deterministic under a fixed rng).
- **Earned, never flattering.** The legend is seeded from what the player **actually did**; the engine never
  invents a flattering reputation the play didn't earn, and a legend reaching the player is never warmer than
  the (distorted) belief the chain produced. The distortion is content drift, not sycophancy.

## ADR 0003 fit (the conversation is the game)

A textbook ADR-0003 fix: the diffusion already exists and already terminates at the player; the legend is a
**fact the engine now produces and hands the model to voice** — texture, never a script. We add no UI and
remove nothing the player plays through. It makes the chat *more* the game — the cast tells stories about
the player the player set in motion — without turning any of it into a dashboard or a reputation meter.

## ADR 0005 fit (split authority by openness)

The **closed set** here is tiny and engine-owned: *which* acts are notable, *whether* a legend seeds, the
diffusion mechanics (confidence/distortion/hops), and the per-season cap — all deterministic, seeded, and
Vault-free. The **open set** — the *meaning* of the legend, how a houseguest *voices* "people are saying
you…" — is recorded losslessly (the belief content) and narrated freely. The engine is a faithful
**recorder + spreader** of the legend, never a normalizer of how it is told; nothing collapses the player's
play into a closed bucket that changes what can be narrated next.

## Acceptance criteria

1. A **notable player act becomes a spreading legend**: after the player does a rare, notable, public thing,
   the engine seeds a player-subject gossip belief (a vague public gloss, never the verbatim act) that
   diffuses NPC-to-NPC via the existing 0002 model.
2. The legend **distorts with retelling**: a legend reaching the player over a longer chain carries lower
   confidence and greater distortion than over a short one — verifiable via the belief's `hops`/`confidence`/
   `distortion`/`factId` lineage (the same fields NPC↔NPC rumors already carry).
3. The legend **reaches the player only via a terminating pathway**: it becomes the player's knowledge only
   when a chain of tellings ends at the player, recorded with provenance (`told-by:<id>`); with no such
   chain, the player learns nothing.
4. **Vault Wall (player + admin):** the verbatim act / any hidden cause never crosses; only the public gloss
   diffuses; a sentinel sweep finds no sealed content and no number on the surfaced legend; no admin /
   God-Mode surface exposes the legend, its confidence, or the diffusion graph; no `readsVault` tool is added.
5. **Anti-sycophancy / the player forms their own read:** the surfaced legend carries no truth marker and no
   confidence number; a player-subject legend folds **no edge of the player's**; and (v1) folds **no NPC→player
   edge** either, so it cannot turn the house on the player by rumor.
6. **Determinism / calibration-neutral:** same seed + same history ⇒ the same legends + the same diffusion;
   `juryReach` / the gradient / the UAT are **byte-identical** with the feature on or off (dedicated rng, no
   fold); an absent legend layer on an old save ⇒ byte-identical.
7. **Rare and capped:** legends seed only from genuinely notable acts and never exceed the per-season cap —
   the house mythologizes the player's big moments, not every line (a property test over a full season).
8. **Non-degradation:** legends are ordinary durable beliefs — they round-trip a save and accumulate over a
   season; the per-season legend count persists so a restart does not re-mint the budget.

## Build-time resolutions (2026-07-05)

The five open questions below were resolved exactly along their documented "Start:" defaults, with no
owner deviation needed — recorded here for traceability:

1. **Notable-act set** — a small, curated five: `hoh-win`, `veto-win`, `veto-save` (excludes a self-save),
   `nominations`, `finale-win` (`src/engine/legends.ts`'s `classifyNotableAct`). A player-orchestrated
   blindside and a public conflict were left OUT of v1 (no reliable structured signal exists yet to
   attribute an eviction to the player's own campaigning without over-reaching) — a natural v2 extension
   once 0085/0086's campaign/drive layer exposes that attribution directly.
2. **Seed rate + cap** — `LEGEND.seedProb = 0.35` per eligible off-screen tick, `LEGEND.maxPerSeason = 4`
   (`src/engine/gossip.ts`).
3. **NPC→player fold** — v1 ships with **no fold at all**: `legendTick` passes neither `rel` nor `subjects`
   to `diffuseGossip`, so a legend moves no edge whatsoever (stricter than "no player edges" — no NPC edges
   either), keeping the pass calibration-neutral by construction even while enabled.
4. **Origin earwitness** — a houseguest currently co-present with the player (`societyOccupancy()`) when one
   exists, else a seeded pick from the living house.
5. **Decay tuning** — reuses `GOSSIP`'s `rounds`/`transmitProb`/`decay` wholesale (no legend-specific curve).

## Open questions / defaults (resolve at build)

1. **What counts as "notable."** The exact selector over the player's recorded events — comp wins, a
   veto save/use, an eviction the player drove, a public conflict, a bold ceremony move. Start: a small
   curated set of **public, high-salience** act classes (no hidden-only acts — those have no public gloss),
   tuned against the UAT so legends feel earned, not constant.
2. **Seed rate + per-season cap.** The per-tick legend seed probability and the season cap (start: a cap in
   the spirit of `THREAD.maxSurfacedPerSeason` / 0059's "≤2" sparseness, so folklore stays scarce and
   legible). Tune felt, never deterministic.
3. **Should a legend ever move NPC→player reads? (deferred — v1: no.)** Whether a *spreading legend* should
   raise the house's threat/affinity read of the player (the way NPC↔NPC rumors fold `GOSSIP_HEARD` toward
   their subjects). v1 keeps it **belief-only** (no fold ⇒ calibration byte-identical, and it never lets the
   engine turn the cast on the player over a rumor it minted). If ever added: a small, confidence-scaled,
   *dedicated-rng* fold proven against `juryReach`, and **never** folding the player's own edges.
4. **The origin earwitness.** Who seeds the legend — a co-present witness of the act (0049), the act's
   on-screen counterpart, or simply the most-connected houseguest. Start: a **co-present witness** so the
   legend has a real first source on content lineage (the 0002 anchoring rule), falling back to the
   best-connected node when none is recorded.
5. **Decay tuning for "grows with each retelling."** Whether legends should distort *faster* than ordinary
   rumors (a tall tale grows tall quickly) via a steeper `decay` / `distortion` for the legend pass, or reuse
   the `GOSSIP` defaults. Start: reuse `GOSSIP`; revisit if the "grows with retelling" beat reads too subtly.
6. **Interaction with 0094 (distorted-gossip consequences) and 0088.** A legend is a distorted belief; if
   0094 ever folds consequences from acting on distorted gossip, ensure a *player-subject* legend composes
   with it without folding the player's own edges. And ensure a legend (the house's story) and the current
   read (one NPC's conduct, 0088) compose as orthogonal cues rather than one flattening the other.

## Traceability

Tracks **#883**. `docs/decisions/0002-relationship-model.md` (the directed/graded edges + the gossip
diffusion this rides; labels organic, never stored) and `src/engine/gossip.ts` (`diffuseGossip` /
`rumorFrom` / `RUMOR_GLOSS` / the belief lineage this feature seeds a player-subject origin into);
`docs/decisions/0003-conversation-is-the-game.md` (a fact to voice, never a panel); `docs/decisions/0005`
(split authority by openness); 0023 (the recorded acts the selector reads); 0038 + `orchestrator.ts` (the
off-screen-tick `diffuseGossip` block this extends); 0049 (co-presence → the legend's first earwitness);
0088 (`docs/features/0088-living-current-read.md` — the sibling inward read) and 0094 (distorted-gossip
consequences).
