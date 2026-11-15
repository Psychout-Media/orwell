# 0094 — Distorted gossip has consequences (acting on a wrong belief burns you)

> **Status:** ✅ **BUILT (2026-07-06).** Built with a **narrowed scope** — see
> `docs/features/README.md`'s 0094 row for the full account. The spec's "closed-set move" (nomination /
> vote / a confronting fold) is built as a NEW dedicated lever, `confront(npcId, factId)` (the
> `confide`/`accuseTie` sibling) — retrofitting `nominate`/`vote` themselves was assessed as touching a
> hard, calibration-load-bearing invariant out of scope for a bounded build, and is left for a dedicated
> owner-scoped change. The dramatic-irony reveal and the behavioral-uncertainty texture ride the
> EXISTING 0002/0038 factId-lineage/hedge-phrase machinery verbatim. `src/engine/beliefReliability.ts`,
> wired in `cucumber.cjs`, gated by `ORWELL_GOSSIP_CONSEQUENCE` (**default ON** since 2026-11-06, ORW-16 follow-up; `defaultOn` in `src/featureFlags.ts`, `=1` in the deploy defaults; corrected 2026-11-12, ORW-286 item 8).
> **Tracks #865.**
>
> **Deploy status (2026-11-03):** only the **distorted-belief consequence** (the misfire/fold on a materially distorted belief) is intentionally OFF in the deployed profile. `ORWELL_GOSSIP_CONSEQUENCE` (GOSSIP_CONSEQUENCE family) is not emitted by `deploy/orwell-env-defaults.sh` and is kept dark for the first playtest by owner direction. The `confront` lever itself stays live: it still validates the cited fact against what the player holds, and with the flag off it always lands with no fold, so a distorted belief cannot misfire.
> **Depends on:** 0001 (Vault Wall), 0002 (event visibility & pathway propagation — the gossip
> belief model `src/engine/gossip.ts` ALREADY carries per-rumor `distortion` / `confidence` /
> `source` / `factId` / `hops`, and `KnowledgeService.knownTo` is where the player's beliefs live),
> 0017/0026 (the relationship math a belief-driven move reads and folds into), 0023 (the consequence
> & memory loop — acting on a belief folds a hidden impact and persists), 0044 (strategic
> noms/votes — the closed-set decisions a distorted belief can mis-aim). **Sibling of** 0075
> (trust-gated confidences — there a houseguest *plants* a lie face-to-face; here an *honestly
> retold* rumor degrades into a falsehood across the social graph, and BOTH let the player get
> burned by a belief the engine privately knows is false). **Bounded by:** mandate #1 (behavioral
> fidelity — dramatic irony is the genre's most compelling texture), mandate #2 (Vault Wall — the
> engine never reveals *which* belief is wrong; it only lets reality differ, and the player's own
> belief is already their knowledge, not Vault content), mandate #3 (anti-sycophancy — the engine
> owns whether a belief is true and owns the divergent outcome; it never softens reality to spare
> the player a bad read), mandate #4 (non-degradation — the corrected belief and the burn are
> durable recorded events that deepen, never thin).

## Why (the gap #865 names)

The belief model is already remarkably rich. When a hidden NPC↔NPC scene becomes a rumor, it
diffuses along the affinity graph one hop per round, and **every retelling already drifts**
(`distort()` in `src/engine/gossip.ts`) and already decays `confidence` per hop — so what finally
reaches the player can be a *distorted* belief, held with a `source`, a `confidence`, `hops` from
the origin, and a `distortion` that grows with each retelling. The `KnowledgeFact` even keeps the
undistorted `originalContent` alongside the drifted `content` (`src/domain/knowledge.ts`).

**But that distortion is invisible where it matters: in outcomes.** Today a wrong rumor and a true
one are *mechanically identical*. A fifth-hand whisper that someone is "about to turn on you" reads,
plays, and pays off exactly like a thing the player witnessed with their own eyes. The player can
act on a badly-distorted, low-confidence belief and the world simply... agrees, because nothing in
the game ever lets the belief *be wrong in consequence*. So the single most _Big Brother_ moment
that information asymmetry can earn — **trusting the wrong rumor, making your move, and getting
burned, then discovering the truth a week later** — does not exist.

This feature closes that gap by making the distortion the belief model already tracks **matter in
play**: the player can act on a low-confidence / distorted belief and **get burned**, then **learn
the truth later** (dramatic irony). It is *not* a new belief system — it is **consequence + surfacing
shaping** layered onto the existing one.

## The dramatic-irony retention value (why this is worth building)

Dramatic irony — the audience (the player) holds a belief the world quietly knows is wrong — is the
texture reality-competition TV runs on. The viewer leaning at the screen because a houseguest is
about to make a move on bad information is the whole appeal. Right now the player can *be* that
houseguest only by accident, and they never feel the floor drop out, because the engine never lets
the bad information cost them anything. Three things this unlocks, all retention-grade:

1. **A reason to weigh a rumor instead of swallowing it.** When a distorted belief can backfire, the
   player starts *reading* the texture of how sure they are — and forms their own paranoia about
   second-hand information (the human's job, 0017/0020). That is the game getting deeper, not a
   dashboard.
2. **The gut-punch of the reveal.** "The thing you were *sure* of — and moved on — wasn't true."
   The later true pathway landing is the emotional payoff that distortion has been silently setting
   up for weeks. This is the 0023 loop working: a happening (acting on the belief) → recorded →
   folded → recalled, and *then* contradicted.
3. **It makes the existing off-screen society legible as drama, not noise.** The gossip diffusion
   (0002/0038) already runs; today it mostly produces vague flavor. Giving a distorted belief teeth
   turns that machinery into the engine of irony it was always shaped to be.

## The mechanic (consequence + surfacing shaping — NOT a new belief layer)

The belief already exists with `confidence` and `distortion`. This feature adds three things, all of
which read those existing fields:

### 1. The belief is **surfaced with its uncertainty — behaviorally, never as a number**

When the player acts in a scene that *relies on* a belief they hold (they bring it up, scheme on it,
confront someone over it), the engine knows that belief's `confidence` / `distortion` / `hops` /
`source`. It hands the model a **Vault-safe uncertainty texture** — *how* the player came to "know"
it, and how shakily — so the narration can voice the shape of the knowledge ("you *heard*, third-hand
and through a wall, that…"; "you saw it yourself, so…") **without ever printing a number**. A
high-confidence witnessed fact reads as settled; a low-confidence, many-hops, high-distortion rumor
reads as a hunch dressed up as a fact — *because of how it is voiced*, not because a meter says 0.3.
This is the anti-sycophancy / Vault rule the whole project runs on: the *feeling* is the human's, and
the engine hands the belief, never the certainty score (ADR 0002 knowledge-vs-suspicion; 0017).

### 2. **Outcomes diverge when the player relies on a distorted fact** (the burn)

When the player commits a **closed-set** move (a nomination, a vote, a confrontation that forces a
relationship fold — 0044/0023) whose justification is a belief the engine privately knows is
**materially distorted or false**, the move lands against **reality**, not against the player's belief:

- The targeted houseguest **isn't actually** the schemer the rumor said → the move misfires: the
  accusation doesn't stick, the supposed ally the player burned was loyal, the "obvious" target had
  no such plan. Reality is what the engine already holds (the `originalContent` / the sealed truth
  of the scene the rumor degraded from) — the engine is simply **allowed to make the outcome match
  the truth instead of the belief**.
- The consequence **folds for real** (0023): burning a loyal ally on a bad rumor moves *their* read
  of the player (a betrayal-grade trust hit, computed and seeded — they know they were wronged even
  if the player doesn't yet know they were wrong), and can ripple to anyone who witnessed it.
- **A true, high-confidence belief still pays off** — acting on something the player actually
  witnessed (or a rumor that survived intact) lands as expected. The divergence is *specifically*
  the gap between belief and reality; a faithful belief has no gap, so nothing changes for it. This
  is what keeps the feature honest: it is not "rumors randomly fail," it is "*wrong* rumors fail."

Crucially, the engine **never tells the player the move misfired *because* the belief was wrong** —
it just lets the outcome be what reality dictates. The player experiences a move that didn't go how
they expected; *why* is theirs to figure out (and the reveal in step 3 is what eventually answers it).

### 3. **The truth surfaces later** (the dramatic-irony reveal)

The existing pathway machinery already carries the fix: a later **genuine** pathway (an NPC who was
actually there tells the player, the player witnesses the real thing, a higher-confidence retelling
arrives) delivers `originalContent` / the real fact. When that lands, the player's belief is
**corrected in place** — the same `factId` lineage the gossip model already tracks lets the engine
recognize "this is the truth of the thing you believed wrong" and flip it. And because the player
*acted* on the wrong version, the correction is a *recognition* beat: the engine can fold the
realization (the betrayed ally was loyal all along; the "threat" was never a threat) — the gut-punch.

> **This is surfacing + consequence shaping on top of 0002, not a parallel system.** No new belief
> store, no new distortion field, no new confidence field — `gossip.ts` already produces all of them.
> What's new is: (a) reading them to *shape narration* (uncertainty texture), (b) letting the engine
> resolve a belief-justified move against *reality* when belief ≠ truth, and (c) recognizing the
> corrective pathway via the existing `factId` lineage and folding the realization.

## ADR 0005 fit (split authority by openness)

This sits exactly on the line ADR 0005 draws, and on the right side of it:

- **The closed set the engine dictates:** whether a held belief is true or false, *what reality is*
  (it already holds it), and **the divergent outcome** of a belief-justified closed-set move (the
  nomination misfires, the vote doesn't land, the loyal ally's trust craters). There is no creative
  content to lose in "the accusation didn't stick because it wasn't true" — that is a fact, and the
  engine owns it absolutely (also mandate #3: the engine never bends the outcome to flatter the
  player's read).
- **The open set the engine only records & voices:** *how the player feels about* their belief,
  *how* they act on it, the prose of the scene, the texture of the eventual reveal. The model is the
  right interpreter of the player's uncoded move and the right author of the irony's prose. The
  engine hands it the Vault-free uncertainty *shape* to voice; it never normalizes the player's
  creative play into a bucket, and the desync guard stays fenced to closed-set board claims only
  (it must never "correct" a player's creative thread merely because they're acting on a hunch).

The litmus (ADR 0005): this change keeps the open set recordable / consequenceable / recallable /
narratable in full, and only ever constrains the closed set (the outcome of a belief-justified
*board move* must match reality, not belief).

## ADR 0003 fit (the conversation is the game)

This is squarely one of the four degradations 0003 exists to fix — it deepens the *information*
texture without adding a dashboard. It **hands the model a fact to voice** (the Vault-safe
uncertainty shape of a belief) and lets it improvise the irony; it never scripts the reveal. It
*augments* the conversation (the narration can carry "you heard, third-hand…") and never replaces a
chat interaction. A wrong belief getting burned is the conversation getting *more* dynamic, not less.

## Vault-safety (the bright line — read first)

A distorted belief is **already the player's own knowledge** (it reached them through a modeled
pathway and lives in `KnowledgeService.knownTo(PLAYER)`), so surfacing it back to the player is not a
Vault read — it is reading the player's own (mis)belief. The Wall is preserved structurally:

1. **The engine never reveals which beliefs are wrong.** No surface ever says "this belief is false"
   or "confidence 0.3" or shows `distortion`. The only thing that ever crosses is the *behavioral*
   uncertainty texture (how the player came to believe it) and — eventually, through a *genuine
   pathway* — the *true* content as ordinary new knowledge. The wrongness is expressed **only as a
   divergent outcome and a later honest correction**, never as a marker.
2. **Reality is engine-owned and never handed to the model pre-reveal.** The model voicing the burned
   move is given only that the move landed differently, in the open-set sense — it is never handed
   "the rumor was false, here is the truth" until the truth surfaces through a real pathway (the same
   rule 0075 holds: the model can't leak what it isn't handed).
3. **Admin / God Mode is walled identically.** No admin surface exposes the truth-value of a player's
   belief, the `distortion`/`confidence` numbers as player state, or "which of the player's beliefs
   are wrong." The human operator must not be able to spoil the irony either (mandate #2 — God Mode
   is walled from the Vault). The sole sanctioned exception remains `producerVault` (out-of-band,
   explicit-unseal), untouched and un-widened by this feature.

## Anti-sycophancy & non-degradation

- **Anti-sycophancy (mandate #3):** the engine owns the truth-value and the divergent outcome,
  seeded and bounded; it **never** quietly makes a distorted belief come true to spare the player a
  bad read, and **never** softens the burn to please them. The fold for burning a loyal ally is the
  same computed, seeded relationship math (0026), not narrative convenience.
- **Non-degradation (mandate #4):** the corrected belief, the misfired move, and the realization are
  ordinary recorded 0002/0023 events on the existing `factId` lineage — durable, recalled in full,
  and **deepening** the record (the player's history now holds both the wrong belief *and* its
  correction). Detail accumulates; nothing thins.

## Determinism & calibration-neutrality

- **Opt-in / isolated ⇒ the seeded calibration spine is byte-identical.** Like 0085/0086, this is
  gated (an env flag, e.g. `ORWELL_GOSSIP_CONSEQUENCE`) on a **dedicated rng draw** so that with it
  **off**, no belief-vs-reality divergence is computed and no extra fold is applied ⇒
  `tests/property/juryReach.property.test.ts` and the full-game UAT are **byte-identical**. The
  diffusion itself (0002) is unchanged; this only reads its output.
- **Seeded & deterministic when on:** same seed + same history ⇒ the same belief distortions, the
  same belief-vs-reality classification, and the same divergent outcomes. No new unseeded randomness.

## Engine seams (where this would land — for the build, not this spec)

- `src/engine/gossip.ts` — **unchanged as a producer**; this feature *reads* its `confidence` /
  `distortion` / `hops` / `originalContent` / `factId`. A small pure helper (`beliefReliability(...)`
  / `isMateriallyDistorted(...)`) classifies a held belief vs. its origin truth (pure, no I/O, no
  Vault handle — handed the already-read belief + the truth).
- A single tunable `GOSSIP_CONSEQUENCE` constants module (the `GOSSIP`/`THREAD`/`CONFIDENCE` sibling
  pattern — the B59 grep gate covers it): the distortion/confidence thresholds at which a
  belief-justified move diverges, and the realization fold weights.
- `GameSessionAdapter` — when a closed-set move (nomination / vote / confronting fold) is justified
  by a player belief, classify belief-vs-reality (engine-side, reading the sealed truth it already
  holds) and resolve the **outcome against reality**, folding the consequence (0023). The Vault-safe
  uncertainty texture rides the existing moment-prompt / `npcVoice` projection (reason + shape word
  only; no number). The corrective surfacing reuses `surfaceInformationTo` with the existing `factId`
  lineage to flip the belief and fold the realization.
- `src/engine/momentPrompts.ts` — the relevant moments gain the Vault-safe belief-uncertainty
  texture (voiced as how-you-heard-it; never a number, never "this is false"). No new player lever is
  strictly required — the divergence keys off the *existing* belief-justified moves — though a build
  may add one if the model needs an explicit "act on this belief" hook.

## Persistence (0007/0030 — non-degradation)

- No new persisted belief fields — `confidence` / `distortion` / `hops` / `originalContent` /
  `factId` already serialize in `KnowledgeSnapshot`.
- The corrected belief and the realization fold are ordinary recorded events + soul folds, already
  durable. A restored game remembers both the wrong belief the player acted on and its later
  correction.

## Acceptance criteria

1. **Acting on a distorted belief can backfire** — a player who commits a closed-set move
   (nomination / vote / a confronting fold) justified by a materially-distorted or false belief gets
   an outcome that matches **reality**, not the belief: the move misfires and the real consequence
   folds (e.g. the wrongly-burned ally's trust craters), seeded and deterministic.
2. **A true / high-confidence belief still pays off** — the same move justified by a faithful belief
   (witnessed, or a rumor that survived intact) lands as expected; the divergence is *specifically*
   the belief-vs-reality gap, never "rumors fail."
3. **Uncertainty is surfaced behaviorally, never as a number** — the player's belief is voiced with
   *how* they came to hold it (witnessed vs. third-hand-through-a-wall), with **no** confidence /
   distortion number, marker, or "this is false" ever shown.
4. **The truth surfaces later (dramatic irony)** — a genuine later pathway delivers the true content
   on the same `factId` lineage; the player's belief is corrected in place, and because they acted on
   the wrong version, the realization folds (the recognition beat).
5. **Vault Wall holds (player AND admin)** — no surface reveals which beliefs are wrong, the
   truth-value of a held belief, or the raw `distortion`/`confidence`; admin/God Mode is walled
   identically.
6. **Anti-sycophancy** — the engine never makes a distorted belief come true to spare the player,
   and never softens the burn; the truth-value and the divergent outcome are engine-owned, seeded.
7. **Calibration byte-identical when off** — with the feature flag unset, no belief-vs-reality
   divergence and no extra fold ⇒ `juryReach` / UAT byte-identical.
8. **Determinism** — same seed + same history ⇒ same belief distortions, same belief-vs-reality
   classification, same divergent outcomes.

## Open questions / defaults (resolve at build)

1. **The divergence threshold.** At what `distortion` / `confidence` (or `hops`) does a
   belief-justified move start to diverge from belief toward reality? Default: gate on *both* high
   `distortion` and low `confidence` so only genuinely-degraded beliefs burn (a one-hop, intact,
   high-confidence rumor should NOT misfire); tune against the UAT so it reads as drama, not
   randomness.
2. **Partial divergence vs. binary.** Does a moderately-distorted belief misfire *fully*, or
   *partially* (the accusation half-sticks)? Default: start binary above the threshold (clean,
   testable), enrich to graded later if it reads too sharp.
3. **Scope of the divergence.** v1 limited to player **closed-set** moves (nominate / vote /
   confront-fold) so the outcome ownership is unambiguous; a chattier "the player just *says* the
   wrong thing socially" case is open-set and stays purely narrated (no forced misfire) — deferred.
4. **The loudness of the reveal.** v1 surfaces the correction through the existing passive pathways
   (a later true telling flips the belief). A louder, explicit "you realize the rumor was wrong"
   recognition beat (the 0075 open-Q #4 sibling) is a possible enrichment — but it must still come
   through a genuine pathway, never as the engine announcing "your belief was false."
5. **NPCs acting on their own distorted beliefs.** The gossip model already folds NPC receipts
   confidence-scaled (`GOSSIP_HEARD`), so NPCs partly already do this. Whether NPC↔NPC moves should
   *also* visibly misfire on distortion (mutual irony the player witnesses) is a natural sequel —
   deferred to keep v1 to the player's own beliefs.

> **Tracks #865.**
