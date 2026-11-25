# 0099 — Secrets as a tradeable currency (information becomes diplomacy)

> **Status:** 🟢 **PO REVIEW RESOLVED (owner, 2026-06-27) — BUILD-READY.** Build TOGETHER with 0093 (#862) as one *secrets-as-power* mechanic (leverage / expose / **trade**); **deception + player bluff first-class**. See § "PO review" + `docs/decisions/PO-DECISIONS-LOG.md` (2026-06-27) + #880.
> Tracks **#880**. This is a *design proposal awaiting decisions*; it is the **sibling / extension of
> 0093** (secrets as strategic levers) and **very likely shares one build spec with 0093** — "learn →
> leverage → expose → **trade**" is one mechanic, and 0099 should be specced/built **alongside 0093**
> rather than as a parallel system. Nothing here is implemented.
> **Builds on (does NOT duplicate):** **0093** (secrets as levers — the `leverage`/`exposeSecret` lever
> family + `usedAs`; this adds the *trade* use), **0075** (trust-gated confidences — how a player/NPC
> *learns* a real secret; `src/engine/confidence.ts`, the `confide` lever, `mayConfide`), **0039**
> (deals & promises — the first-class `Deal` / `DealLedger`, the `makeDeal` lever; `src/engine/deals.ts`),
> **0002** (event visibility & pathway propagation / `surfaceInformationTo`; the `KnowledgeFact` /
> `factId` model, `KnowledgeService.knownTo`), **0017/0026** (the directed relationship model +
> betrayal-shock fold), **0023** (the consequence & memory fold), **0038/0094** (off-screen gossip
> diffusion + distortion — the substrate the *NPC↔NPC* barter rides). **Bounded by:** mandate #2 (Vault
> Wall — player **and** admin), mandate #3 (anti-sycophancy — the engine owns the bounded, seeded
> *magnitude*; the model never bends an outcome), mandate #4 (non-degradation), ADR **0005** (split
> authority by openness — the model proposes *shape*, the engine keeps *magnitude*), ADR **0003** (the
> conversation is the game).

## Why — the gap this closes

0093 makes a *learned* secret a **lever** the player can wield against its **subject** — leverage in a
deal with that person, or an expose that damages them. That is the *vertical* use of information:
pressure on the one it's about. It leaves the *horizontal* use untouched — the most _Big Brother_ thing
information does: **you trade it.** You tell an ally what you overheard so they'll vote your way; you
sell a name for a name; you barter a juicy secret to a third party for safety, a comp throw, or a slot
in their final-two. The secret you hold is rarely *about* the person you want something from — its value
is precisely that you can **give it away** to someone who wants it.

Today none of that exists as a mechanic. The player can *learn* secrets (0075/0002) and, with 0093, can
*use one against its subject*. But information has **no exchange value**: there is no way to hand a held
secret to another houseguest *as consideration* for a concession, and NPCs do not barter secrets with
each other in the hidden layer. Information is an asset you can spend *on its subject* (0093) but never
**trade** to a third party. This feature adds the trade layer — a thin economy over the existing
knowledge-facts + relationship + deal machinery — so information becomes **diplomacy**: alliances of
convenience, double-crosses, and the irony of a secret you sold coming back around.

### Retention / "why an information economy makes a returning player keep playing"

0093's retention argument was *a learned secret is a bankable asset you can cash in on its subject.* 0099
multiplies that: a held secret is now **liquid** — spendable on *anyone who wants it*, not just the one
it's about. That turns information-gathering from a single-payoff act into a portfolio the player manages
across a whole season: *who wants what I know, and what will they give me for it?* It is the loop that
rewards the patient, social, eavesdropping style _BB_ rewards, and it deepens the 0023 "the house
remembers" promise from the player's side — **you** remember what you traded, to whom, and the
double-cross it set up three weeks later. An economy of secrets is a reason to keep playing the long game,
not just to collect atmosphere.

## The core idea — a held secret is *consideration* a third party will pay for

Two symmetric halves, both riding existing machinery:

### 1. The player trades a held secret to a third party for a concession (the player-driven half)

A `KnowledgeFact` the player **already holds** (any real fact in `KnowledgeService.knownTo(player)` —
about a houseguest, an off-screen scene the player learned, an overheard plan) can be **offered to a
*recipient* houseguest as consideration** for a concession the player wants from *them*. The trade is a
two-sided exchange: *give X to get Y.*

- **What the player gives:** a specific held `factId` (or, symmetrically, a concession of their own — a
  vote, safety, a comp throw — but the *novel* currency this feature adds is the **secret**).
- **What the player asks for:** a concession from the recipient — most naturally **a deal** (0039:
  safety, a vote, a final-two, target-someone-else), but also a one-off (a comp throw, a piece of intel
  in return — a *secret-for-secret* swap).
- **How the engine resolves it:** the **value of the offered secret to *this recipient*** (a bounded,
  seeded `tradeValue`, below) colors how likely the recipient is to **accept** the exchange and, when the
  ask is a deal, how likely they are to **honor** it — *exactly* the way 0093's `leverage` colors a deal.
  The recipient can always **refuse** (the secret may be worthless to them, or they may distrust the
  player); a bad trade can even *cost* the player standing (peddling gossip reads as untrustworthy to
  some archetypes). It is barter, not a vending machine.

The crux that distinguishes this from 0093: in 0093 the secret's power is **over its subject**; here the
secret's power is **to a recipient who is not its subject** — its value is *what that recipient would do
with it* (a rival's secret is worth a lot to that rival's enemy; worthless to that rival's ally). The
engine computes `tradeValue(fact, recipient)` from the **recipient's own reads** of the secret's subject
(do they want leverage on them? are they threatened by them?) — perspective-bound, never omniscient.

### 2. NPCs barter secrets with each other, hidden (the off-screen half)

In the hidden layer, NPCs **trade secrets among themselves** as part of their off-screen scheming: a
houseguest who holds a juicy fact about a rival *spends* it with an ally to cement a bond or buy a vote,
exactly as a human player would. This is **not a new disclosure path** — it is the existing 0038/0094
gossip diffusion **given a motive and a price**: today a hidden fact diffuses NPC→NPC somewhat
mechanically (along the social graph, distorting); 0099 lets a *trade* be one driver of that diffusion (an
NPC chooses to pass a fact *because* it buys them something), and records the resulting **relationship
fold** (the recipient owes the giver; a bond firms). The trade itself, its price, and the magnitudes are
**Vault-only**, surfacing to the player only if a pathway later terminates at them (overhear, an NPC tells
them, the recipient weaponizes it in a scene the player witnesses), at which point it becomes the player's
knowledge exactly as any surfaced fact does (0002).

> The NPC↔NPC barter makes the house's information economy *feel real* from the outside: secrets visibly
> move (a houseguest suddenly knows something they shouldn't, a bond firms for no public reason the player
> can see), and the player can be *outmaneuvered* in the economy — someone trades a secret about the
> player before the player can spend it first. It is the same "off-screen NPC-to-NPC scheming the player
> never witnesses" the #1 mandate demands, applied to information as currency.

### What stays exactly as-is (so this is additive, not a rewrite)

- **Learning a secret is unchanged.** 0099 adds **no** new way to learn secrets — it consumes what
  0075/0002 already record (player side) and rides 0038/0094 diffusion (NPC side). No new disclosure
  path, no new Vault read.
- **Deals are the host, unchanged in shape.** A traded-for concession is, in the common case, a 0039
  `Deal`; the offered secret rides *alongside* `makeDeal` as an optional consideration — with no secret
  offered, deal formation is **byte-identical** to 0039 / 0093. (See R4.)
- **The relationship/jury folds are reused** (0026 trust/affinity/threat moves, the betrayal-shock for a
  trade that backfires, 0014 jury demerits). A trade's consequence is the *existing* folds applied from a
  new trigger — no new hidden authoring.
- **0093's lever family is reused, not duplicated.** 0099 adds a *trade* use of a held secret on top of
  0093's *leverage*/*expose* uses; they share the `usedAs` marker, the season cap pattern, the `factId`
  ownership check, and the `LEVERAGE`/`SECRET_TRADE` constants sibling. (See R2 — likely one build spec.)

## The mechanic (ports / modules — Definition of Ready, pending the PO rulings)

> Exact signatures firm up at build after R1–R4. Sketch only, to prove hexagonal fit. These are **model
> levers**, engine-decided — like `confide` / `makeDeal` / `exposeSecret`, **not** FE-driven write-backs —
> so the four-place FE-write-back wiring discipline does not apply. **If built with 0093, these land in the
> same modules** (`leverage.ts` / `leverageConstants.ts`), not new files.

- **`src/engine/secretTrade.ts`** *(pure, no I/O, no Vault handle — likely folded into 0093's `leverage.ts`)* —
  the decision core:
  - `tradeValue(fact, recipientRead, subjectRead, rng) → number` — a bounded, seeded factor in `[0,1]`:
    how much the **recipient** values this secret, from *already-read* signals — the secret's **severity
    class** (the public `kind` of the underlying `HiddenElement`, never its text — the 0075/0093 class
    gloss), how much the recipient **wants leverage on / is threatened by the secret's subject** (the
    recipient's *own* directed edges toward the subject, 0026), and the recipient's read of the player
    (a recipient who distrusts the player discounts the offer). A secret about someone the recipient
    doesn't care about has near-zero value. **No raw number ever crosses to the player.**
  - `tradeOutcome(fact, recipient, ask, rng) → { accepted, recipientFold, traderBacklash?, ... }` — the
    bounded, seeded resolution: whether the recipient takes the trade, the relationship fold it produces
    (the recipient warms / owes the giver), and any backlash on the trader (peddling can read as
    untrustworthy). Pure; the adapter delivers folds through the 0039 `ReconcileSink` pattern.
  - `npcBarterStep(holder, candidateRecipients, board, rng) → BarterMove?` *(hidden half)* — the
    perspective-bound, seeded choice of whether a holder *spends* a held fact with a recipient to buy a
    bond/vote; returns the chosen `factId` + recipient + the fold, **Vault-only**. This is a **driver of**
    the existing 0038/0094 diffusion (motive + price), not a second diffusion engine.
- **`src/engine/secretTradeConstants.ts`** *(likely folded into `leverageConstants.ts`)* — the single
  tunable `SECRET_TRADE` module (severity → value weights, the trade-to-deal factor cap, the
  backlash bands, the per-season trade cap, the NPC-barter rate). The `CONFIDENCE` / `LEVERAGE` /
  `DEAL_IMPACTS` sibling; the B59 grep gate covers it.
- **`GameSessionAdapter`:**
  - `makeDeal` (0039) gains an **optional, Vault-free `tradedSecret` descriptor** — a *reference* to a
    `factId` the player already holds, offered to the **recipient** (a third party, not necessarily the
    secret's subject) as consideration. Validated against `KnowledgeService.knownTo(player)` (the player
    can only trade what they actually learned). The engine computes `tradeValue` and folds it into the
    (bounded, seeded) formation/honoring likelihood. Absent ⇒ 0039/0093 unchanged. *(This is the
    recommended R4 shape: 0099 is leverage's sibling option on the same `makeDeal`, differing only in
    that the secret is valued **to the recipient**, not **over the subject**.)*
  - optionally a new action **`tradeSecret(factId, toNpcId, askKind, terms)`** on the `GameSession` port /
    `PLAYER_TOOLS` for a *secret-for-X* swap that is **not** a standing deal (e.g. a one-off comp throw, a
    secret-for-secret exchange): validates the `factId` is the player's own knowledge, resolves
    `tradeOutcome`, folds the relationship change (0026), **records the trade as a witnessed event** (0002
    — the recipient now *knows* the traded fact via `surfaceInformationTo`, with lineage), increments the
    season trade cap, and returns `{ accepted, narratable, ... }` — **no number**, only what the model may
    voice. Single authority, like `runCompetition` / `confide` / `makeDeal` / `exposeSecret`. *(Whether
    this is a distinct lever or just `makeDeal` with `tradedSecret` is an R4 sub-call.)*
  - `campaignTick` / the off-screen society tick (0038) calls `npcBarterStep` for active holders (behind
    the same off-screen flag the society already runs under), folding the hidden bond and recording the
    NPC→NPC knowledge transfer in the **Vault** — surfacing to the player only via the existing pathways
    (0002/0094). On the dedicated side-rng ⇒ calibration byte-identical when off.
- **`src/engine/momentPrompts.ts`** — the social moment + the lever manifest gain the `makeDeal`
  `tradedSecret` option (and `tradeSecret` if a distinct lever): *when* to call them (the player is
  offering something they know in exchange for something they want), that the **engine decides whether the
  recipient bites and how the relationship moves**, and **never invent a trade outcome the lever didn't
  return**. The value is voiced as texture ("they'd kill to know that"), never as a number.

## ADR 0005 — magnitude vs. shape (the anti-sycophancy spine)

This feature lives squarely on ADR 0005's line and must not cross it (identical discipline to 0093):

- **Open set (the model proposes shape).** *Which* secret is being traded, *to whom*, *for what* (the ask),
  and the *prose* of the negotiation — the model's to interpret and voice, as rich as the player's play.
  The free-text content rides through unchanged (lossless); the NPC↔NPC barter's *flavor* is the model's
  when it later surfaces in a scene.
- **Closed set (the engine owns magnitude).** *How much* a traded secret is worth to a recipient, *how
  far* it moves a deal's accept/honor likelihood, *how hard* a backfire bites, and *which* hidden bond an
  NPC barter firms — all **bounded, seeded, engine-owned**. The model never proposes an amount; a held
  secret can never be *pumped* to force a yes (mandate #3). With no `tradedSecret`/`tradeSecret`/barter
  invoked, every existing fold is **byte-identical** — the `expressiveNonCollapse` gate stays the proof
  the open set isn't being normalized.

## The Vault Wall (player AND admin) — why this is safe

A "trade" looks, at a glance, like the player wielding secret state across the house. It does not breach
the Wall, for the same structural reasons 0075/0093 don't:

1. **The player only ever trades a secret they ALREADY legitimately learned.** The trade operates over the
   player's own `KnowledgeFact` set (`KnowledgeService.knownTo(player)`, 0002) — content that already
   crossed via a modeled pathway and is already Journal-visible. **No undisclosed Vault content is read**
   to make a trade available; the engine consumes what is *already the player's knowledge*. The
   `tradedSecret`/`tradeSecret` calls validate the `factId` against the player's knowledge and **reject**
   anything else — the player cannot trade what they were never told (no minting ground truth, sibling to
   `surfaceInformationTo`'s lineage check, and to 0093's `factId` guard). **(R4 — the ownership check is
   the bright line.)**
2. **Surfacing a traded secret to the recipient (and any NPC↔NPC barter) is a modeled pathway, never a
   Vault read (R3).** When the player trades a secret to a recipient, the recipient learns it through
   `surfaceInformationTo` (a recorded *told* event with lineage), exactly as a confidence or gossip
   crosses — the engine never hands any surface the Vault; it records a new knowledge event whose origin
   is the player's trade. The NPC↔NPC barter writes the transfer in the **Vault** and reaches the player
   **only** when a pathway later terminates at them (0002/0094) — never as a Vault read.
3. **No number ever crosses, to player OR admin.** `tradeValue`, the deal-likelihood factor, the trade
   magnitudes, the NPC-barter folds, and every relationship/jury delta are Vault-hidden. Player surfaces
   show the *fact* of the trade and **observable** fallout (behavior) — never a value, never a fold size.
   **God Mode / admin is walled identically** (mandate #2): no admin projection exposes the trade value,
   the hidden barter, or the standing deltas; the load-bearing test sweeps the assembled admin/player
   surfaces for any sealed magnitude *and* for any NPC↔NPC traded fact the player has no pathway to.

## Determinism / calibration-neutrality

- **Seeded + deterministic.** Same seed + same history + same trade call ⇒ same `tradeValue`, same outcome,
  same folds; the NPC barter uses the dedicated side-rng so the order/choice of barters is reproducible.
  `secretTrade.ts` is pure (handed the already-read signals; rng injected).
- **Calibration byte-identical when unused.** With no `tradedSecret`/`tradeSecret` and the NPC-barter flag
  off, the 0039/0026/0094 folds and the seeded vote/eviction distributions are **byte-identical** — the
  feature adds no rng draw on the untouched path. The `juryReach` / UAT gates stay green unperturbed (the
  same discipline 0093/0086/0085 hold behind their flag). *(Build decision: whether the player-side trade
  and the NPC barter sit behind a flag — `ORWELL_SECRET_TRADE`, or fold into `ORWELL_CAMPAIGNS` for the
  off-screen half — is a build detail shared with 0093; the byte-identity guard is the requirement either
  way.)*

## Persistence (0007/0030 — non-degradation)

- A learned secret the player has **traded** carries (via 0093's sealed, monotonic `usedAs` marker,
  extended with a `traded` value) so the knowledge layer remembers exactly which secrets the player has
  spent and how. A secret can be traded to multiple recipients (sharing it widens who knows) — the
  *recipients* are recorded as ordinary 0002 knowledge events; what persists is that the player *used* it.
- The per-season **trade count** persists in the snapshot (sibling to 0093's expose count / 0075's lie
  count / `surfacedThreadCount`).
- The NPC↔NPC barter's resulting knowledge transfers + bond folds persist as ordinary Vault state /
  recorded events — already durable; the knowledge layer **deepens, never thins**.

## ADR 0003 fit — the conversation is still the game

This *augments* conversation, it does not move play into UI (ADR 0003 principle #4). The player **learns**
the secret in conversation (0075), **decides** to trade it in conversation (the model calls the lever from
the player's negotiation), and the **fallout is narrated** from engine truth. The lever is a *fact handed
to the model to voice* ("you have something they'd want; offer it for the vote"), never a script or a
dashboard "sell" button that replaces the scene. The NPC↔NPC barter is exactly the off-screen scheming the
#1 mandate demands. It earns its tokens against the four fixes: it strengthens **behavioral fidelity** (the
missing information-as-diplomacy beat + richer off-screen society) without touching leaks/sycophancy/memory
(all preserved by the structure above).

## Acceptance criteria (role-only; HARD rules — to firm up at build)

- [ ] **A held secret is tradeable to a third party.** A `KnowledgeFact` the player holds can be offered
      to a **recipient** (not necessarily the secret's subject) as consideration in a `makeDeal` and/or a
      `tradeSecret` swap; a secret the player has *not* learned (no pathway) offers **no** trade (the call
      is rejected).
- [ ] **The trade is valued *to the recipient*, and colors — never forces — the concession.** Offering a
      secret a recipient *wants* raises (bounded, seeded) the likelihood they accept/honor; a secret they
      don't care about, or distrust the source of, may be refused (and a bad trade may cost the trader
      standing). With no traded secret, deal formation is byte-identical to 0039/0093.
- [ ] **NPCs barter secrets with each other, hidden.** Off-screen, NPCs trade held secrets to buy
      bonds/votes; the trade, its price, and the magnitudes are **Vault-only**, surfacing to the player
      only via an existing pathway (0002/0094) — never as a Vault read. (Behind the off-screen flag.)
- [ ] **Vault Wall (player AND admin).** No undisclosed secret is read to make a trade available; the
      player can only trade their own learned facts; surfacing to the recipient/house is a modeled pathway
      (R3), never a Vault read; **no number** crosses to player or admin, and no NPC↔NPC traded fact
      reaches the player without a pathway (load-bearing sentinel sweep over both surfaces).
- [ ] **Anti-sycophancy (ADR 0005).** The engine owns the bounded, seeded magnitude; the model proposes
      only *which secret / to whom / the ask / the prose*. A trade can never be pumped to force an outcome.
- [ ] **Non-degradation.** `usedAs` (extended with `traded`) + the season trade count persist and survive
      a restart; trading a secret deepens the knowledge layer (recipients now know), never thins it.
- [ ] **Determinism + calibration-neutrality.** Seeded/deterministic; byte-identical `juryReach`/UAT on
      the untouched (no-trade, barter-off) path.

## PO review — owner rulings needed (before build)

This spec is deliberately a **proposal** and is the **sibling of 0093**. Four decisions shape the build and
want an owner ruling first. **Recommendation up front:** spec and build **0099 alongside 0093 as one build
spec** — "learn (0075) → leverage/expose (0093) → **trade** (0099)" is a single coherent
information-as-power mechanic over one set of modules (`leverage.ts`/`secretTrade.ts`,
`leverageConstants.ts`/`SECRET_TRADE`), one `usedAs` marker, one `factId` ownership check, and one
`makeDeal` host. Splitting them risks two parallel "use a secret" systems.

- **R1 — How much may a *trade* move the CLOSED set (the deal/vote/standing it buys)?** The engine keeps
  the bounded, seeded *magnitude* (anti-sycophancy — the model never bends an outcome; ADR 0005). The
  owner call is the **ceiling**: how strongly may a wanted secret push a recipient toward accepting/honoring
  a deal (a gentle nudge vs. a near-certain yes), and how much may an NPC↔NPC barter firm a hidden bond?
  *Recommendation:* keep it **firmly bounded and felt, never deterministic** — a traded secret is *pressure
  + incentive*, and the recipient can always refuse (worthless secret, distrusted source) — so it reads as
  diplomacy, not an "I win" button, and never flattens the seeded variance (the `juryReach` band stays the
  guard). Mirror 0093 R1 exactly so the two uses share one ceiling.

- **R2 — How does 0099 compose with 0093 (leverage/expose) AND 0039 (deals) so "learn → leverage → trade"
  is ONE coherent mechanic?** *Recommendation (strong): build 0099 **inside / alongside 0093's build spec.***
  0093's `leverage` (a secret used **over its subject** to color *that subject's* deal) and 0099's `trade`
  (a secret used **to a third-party recipient** to color *that recipient's* concession) are the **same
  shape** — an optional, Vault-free, `factId`-referencing descriptor on the **existing `makeDeal`** that
  the engine values (bounded, seeded) and folds into deal likelihood. They differ only in *whose* reads set
  the value (the subject's, for leverage; the recipient's, for a trade) and they share `expose` as the
  third use. Keep **one deal object, one ledger, one `usedAs` marker, one constants module, one ownership
  check** — leverage / trade / expose are three *uses* of a held `factId`, not three systems. A `tradeSecret`
  *swap* lever (secret-for-a-non-deal-concession) is the only piece that may warrant a distinct lever; the
  owner ruling is whether even that collapses into `makeDeal` (recommended) or stands alone.

- **R3 — Confirm surfacing stays a modeled pathway, never a Vault read.** When the player trades a secret to
  a recipient, the recipient must learn it through `surfaceInformationTo` (a recorded *told* event with
  lineage); the NPC↔NPC barter writes to the Vault and reaches the player only via an existing pathway
  (0002/0094) — the engine never hands any surface the Vault, and the player can only trade facts they
  already legitimately hold. *Recommendation: confirm* — this is the structural reason the Wall holds
  (sibling to 0075/0093); the build's load-bearing test pins it (including that no NPC↔NPC traded fact
  reaches the player without a pathway).

- **R4 — The player can only trade a `factId` they legitimately hold (confirm the bright line).** Every
  trade call (`tradedSecret` on `makeDeal`, or `tradeSecret`) must validate the offered `factId` against
  `KnowledgeService.knownTo(player)` and **reject** anything not in the player's own knowledge — no minting
  ground truth, no trading a secret you only *suspect* or never learned (sibling to `surfaceInformationTo`'s
  lineage check and 0093's R4 ownership guard). *Recommendation: confirm* — this is what keeps the trade an
  **information-economy move over already-Journal-visible knowledge**, not a Vault hole; the load-bearing
  test rejects an unheld/`suspicion`-only `factId`.

**If ruled as recommended, the build is (shared with 0093):** the trade `tradeValue`/`tradeOutcome` +
`npcBarterStep` folded into `src/engine/leverage.ts` (or a thin `secretTrade.ts`), the `SECRET_TRADE`
constants beside `LEVERAGE`, an optional `tradedSecret` descriptor on `makeDeal` (recipient-valued sibling
of 0093's `leverage`), the NPC↔NPC barter as a motive/price driver of the existing 0038/0094 diffusion,
the reused 0026/0014 folds, the extended `usedAs` (`traded`) + season-trade-count persistence, and the
gates below — a focused build spec shared with 0093 rather than a parallel system.

## Testability (role-only; HARD rules)

- **Vault Wall (the load-bearing test):** a secret the player has not learned offers no trade (the
  `tradedSecret`/`tradeSecret` call referencing it is rejected); a `suspicion`-only belief is not a
  tradeable `factId`; no trade value or hidden standing/barter delta appears on any player **or admin**
  projection; a sentinel sweep over the assembled player/admin surfaces finds no sealed magnitude **and**
  no NPC↔NPC traded fact the player has no pathway to.
- **Information becomes diplomacy:** a player holding a learned secret a recipient *wants* gains a concrete
  trade option that a player without it does not — asserted structurally on the available levers, not on
  prose.
- **Valued to the recipient, colors not forces:** a trade offering a secret the recipient *wants* raises
  the (bounded, seeded) deal accept/honor likelihood; the *same* secret offered to a recipient who doesn't
  care about its subject moves the likelihood ~nothing; a distrustful recipient can refuse (and a bad trade
  can cost the trader standing); with no trade, deal formation is byte-identical to 0039/0093.
- **NPC↔NPC barter is hidden + folds consequence:** off-screen, a holder trades a held fact to a recipient,
  firming a hidden bond and transferring the knowledge in the Vault; the player learns it only via a
  pathway (0002/0094); the barter is capped/rate-limited per the constants and seed-deterministic.
- **Anti-sycophancy:** no number crosses; the engine owns the magnitude; the model cannot pump a trade to
  force a deal (ADR 0005 — the `expressiveNonCollapse` sibling gate stays green on the untouched path).
- **Non-degradation:** `usedAs` (`traded`) + the trade count persist and survive a restart; recipients of
  a traded secret durably hold it (the knowledge layer deepens).
- **Determinism / calibration-neutral:** same seed + history ⇒ same trade value + outcome + barter
  sequence; byte-identical `juryReach`/UAT on the untouched (no-trade, barter-off) path.

## Dependencies & traceability

Builds on **0093** (secrets as levers — the lever family + `usedAs` this trade use extends), **0075** (the
learn-a-secret pathway), **0039** (deals — the trade host), **0002** (pathway propagation /
`surfaceInformationTo` + the `KnowledgeFact`/`factId` model + `knownTo` ownership check — how a trade
reaches the recipient/house), **0038/0094** (off-screen gossip diffusion + distortion — the substrate the
NPC↔NPC barter rides), **0017/0026** (relationship + betrayal-shock folds), **0023** (consequence fold),
**0014/jury** (jury demerits), persisted by **0007/0030**, under **0001** (Vault Wall) and **0021**
(isolation), on ADR **0005** (shape vs. magnitude) and ADR **0003** (the conversation is the game). Tracks
**#880**. Turns a learned secret from an asset spendable *on its subject* (0093) into a **liquid currency**
tradeable *to anyone who wants it* — an information economy of alliances and double-crosses, valued and
adjudicated by the deterministic core, never the narrator. Likely shares one build spec with 0093.

## Amendment 2026-11-18 (ORW-614, P-11): houseguests trade secrets about the player

The off-screen barter tick excluded the player as a subject, so no houseguest ever held, valued or passed on a secret about the player (the player had the lever; houseguests did not). With `ORWELL_SECRET_BARTER_PLAYER` (default ON, played games only, needs `ORWELL_SECRET_BARTER`) a belief a houseguest holds ABOUT THE PLAYER is tradeable like any other: same strict-argmax value core, the recipient's own read of the subject (here the player) sets the value, same hidden `told-by` transfer witnessed by giver and recipient only. The Vault Wall is unchanged: the player never witnesses the trade, the content appears on no player or admin surface, and it reaches the player only through a later in-game pathway with a source. Gate: `tests/unit/orw614SecretsAboutPlayer.test.ts` (parity, hidden/unwitnessed, planted-sentinel wall, off and unplayed = today, persistence). `=0` is byte-identical.

## Amendment 2026-11-19 (ORW-688): the facts houseguests hold now say who they are about

Every consumer here keys on a held fact's `subject` (who it is about), but the records the houseguests actually held had none: the confidant's origin belief for a thread rumor, a pre-show tie observation and a confidence was lodged without it (only the copy handed to the player carried it), and a secret the player exposed or traded was lodged under a fresh id per recipient (so no two houseguests ever held one lineage) with the subject only on a separate, lineage-less copy. So plays, breaks and barters found almost nothing to match in a played game.
- The origin beliefs now carry the subject; a thread rumor diffused along the graph carries it on every hop; a scene rumor (graph path) names the one who is not the teller.
- An exposed or traded secret is lodged under the player's own fact id as its lineage, so the whole house holds ONE lineage with the subject on it (and a secret already exposed is known to be out, so 0204 does not re-break it).
- `surfaceInformationTo` takes an optional `factId` so a record with a subject also has a lineage.
- An old save is backfilled on load from the record's own fields (a scene rumor's lineage id names its origin and its undrifted text names the pair), append-only, no rng.
- Flag `ORWELL_RUMOR_SUBJECTS` (default ON, `=0` = subject-less, byte-identical). Played games only. The subject is engine-only (Vault class): only a fact the player was told reaches them, with its source. Test `tests/unit/rumorSubjects.test.ts`; report `tests/calibration/secretSubjectReport.test.ts` (`ORWELL_SECRET_SUBJECT_REPORT=1`).
- Not done: an overheard fragment (presence) is still subject-less. (ORW-824)

## Amendment 2026-11-19 (ORW-688, part 2): a houseguest's own brake on trading

With subjects on the facts, off-screen barters rose about threefold per season (about 15 to about 45) and pushed the whole-season mix toward gossip. The fix keeps the subjects (leverage plays and secret breaks now fire) and brings barter volume back with a brake that comes from the houseguests, not a cap.
- `appetite = 1 / (1 + satietyWeight x sated) x (1 - burnWeight x burn)`, a pure read of recorded state, in `secretBarterConstants.ts` (`BARTER_APPETITE`, a reason on each constant).
- `sated` is the holder's own recent trading: a count that grows by one with each barter they make and halves every `satietyHalfLifeTicks` off-screen ticks (it comes back with the days). It is saved with the season (`secretBarterRecent`, a small map; absent on an older save, engine-only, never outward).
- `burn` is how much a broken deal, an exposed secret, a betrayal in a scene or a deal made behind their back still weighs on them: the NPC memory ledger's salience over everyone, at the holder's own decay (a grudge-holder stays wary longer). A burned houseguest still trades, warily.
- The brake scales the fire chance AFTER the dedicated stream's draws: the same draw is compared against `barterRate x appetite`, so the draw count is identical on or off and the stream is byte-identical.
- Flag `ORWELL_BARTER_APPETITE` (default ON; `=0` = the volume before the brake). Played games only; headless sims are untouched. No new projection: nothing about appetite or wariness reaches the player, the narrator or admin.
- Test `tests/unit/barterAppetite.test.ts`; before/after numbers from `tests/calibration/secretSubjectReport.test.ts` are in the PR notes of ORW-688.

## Amendment 2026-11-19 (ORW-688, part 3): the house mix, measured, and the gate that fixed it

With subjects populated the 12-season house mix (bonding/strategy/gossip/conflict) read 27.8/29.1/34.4/8.7 against main alone about 29.1/34.6/26.7/9.6 (the guard failed on strategy). Switching pieces off showed it was NOT the barters, leverage or breaks, and NOT the threat term in the spread motive (gating that term alone moved nothing: 28.1/29.8/33.4/8.8). It was the `heard-rumor` belief claim the same-room spread now records for a retelling that has a subject: the claim moves the listener's relationship edges (rumor distrust), which feeds more gossip scenes. Gate (`copresenceSpread.ts`, a few lines): a retelling whose lineage is rumor-origin (`fact:`, `thread-belief:`, `tie-belief:`, `confide:`) records no `heard-rumor` claim, as before it had a subject. The subject stays on the fact, so leverage, breaks and barters are unchanged. No new state, no rng. Result: 28.7/34.7/27.1/9.5 (guard passes, reference untouched). Per season after the gate (8 seeds x 1500 messages): leverage plays 9.0, secret breaks 3.9, barters 16.8 (same as before the gate). `tests/unit/rumorOriginMotive.test.ts`. ORW-702 may revisit (the claim, and the threat term) when it rebalances the whole season.
