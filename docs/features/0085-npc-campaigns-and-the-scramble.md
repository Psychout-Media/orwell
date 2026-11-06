# 0085 — NPC campaigns & the scramble (strategy executed over time)

> **Status:** ✅ **BUILT 2026-06-25** — phased: A (model/traits/pure logic, #808) · B1 (seeded vote
> tilt, #809) · B2 (live off-screen execution + the tilt provider, behind `ORWELL_CAMPAIGNS`,
> ON since #1996 (the original flag was default-off with byte-identical calibration, #810) · C (BDD closeout: the `.feature` wired into
> `cucumber.cjs` with all 15 scenarios green, veto-escape re-aim, player-campaign isolation). Engine:
> `src/engine/campaigns.ts` (pure, Vault-sealed); `Character.influence`; `GameSessionAdapter.campaignTick`
> + `ctx().campaignTiltFor`. The calibration spine is untouched (`juryReach` green; campaigns run only
> when the deploy sets `ORWELL_CAMPAIGNS=1`).
> **Since #1937 / PR #1966:** campaigns now push the **NPC HOH's nominations, the replacement nominee and the NPC veto holder's save**, not just the eviction vote: a bounded, signed push (`campaignPushFor`; an `evict` campaign adds, a `protect` campaign subtracts, net clamped to `CAMPAIGN.base`), and `protect` counters `evict` at the vote (the scramble). Per the owner ruling 2026-11-03, **player-owned campaigns count too** (`CAMPAIGN_PUSH_INCLUDES_PLAYER_OWNED`), still bounded, and NPCs still decide; the NPC re-planner no longer rewrites a player's declared campaign. Gated by the campaigns flag, so flags-off stays byte-identical.
> **Gate:** engine (Vitest +
> property/calibration + dependency-cruiser + BDD `0085-npc-campaigns-and-the-scramble.feature`) and
> front-end (the player experiences campaigns only through existing surfaces — approaches, gossip, the
> decision card). **Depends on:** 0038 (the off-screen society tick that runs each campaign move), 0039
> (deals — a campaign's currency), 0043 (blocs — a campaign can be a bloc's shared agenda), 0044 +
> `decisions`/`decisionConstants` (the seeded nomination/vote weights a campaign tilts), 0002/0038
> (the pathways + gossip the player learns a campaign through), 0077 (conspicuousness — a campaign's
> meetings are observable even when its content is sealed), 0048 (the retrospective unseal of who was
> working whom). **Sibling of** 0084 (voice) — voice makes the texture real, campaigns make the
> strategy real. **Vault Wall (mandate #2 — symmetric):** a campaign's existence, target, and plan are
> **its owner's private knowledge** — every OTHER houseguest *and* the player learns of one only through
> the same modeled pathway (the player is just one limited perspective among sixteen; NPCs are never
> omniscient about each other's plans). The engine, not narration, tallies whether it works.

> **Owner direction (2026-06-25, this session):**
> *"NPC and character campaigning — strategy executed over a period of time: a day, a week, or multiple
> weeks. It's strategy, just executed over a period."*

## The problem this fixes

The off-screen society already schemes — but mostly in **one-tick reactions**: a scene happens, edges
move, gossip spreads. What it lacks is **temporal structure**: a houseguest deciding *"I want the comp
beast out this week"* and then **pursuing that goal across many beats** — lobbying one ally Monday,
planting a doubt Tuesday, cutting a deal Wednesday, adapting when the target wins veto — until it
resolves at the vote. Real _BB_ strategy is a **campaign**, not an impulse. Mandate #1 calls out
exactly this: *"off-screen NPC-to-NPC scheming the player never witnesses"* — this feature gives that
scheming a **spine that persists and adapts over time**, and makes it *matter* by tilting the seeded
outcome (never the narration's call — anti-sycophancy #3).

## The model — a `Campaign` (hidden, persistent, adaptive)

A **`Campaign`** is engine-only, Vault-sealed strategic state, owned by one NPC or shared by a bloc:

```
Campaign {
  owners:    EntityId[]          // one schemer, or a bloc acting together (0043)
  goal:      "evict" | "protect" | "build-alliance" | "win-power" | "discredit"
  target:    EntityId            // who it's aimed at (the evict/protect/discredit subject)
  plan:      Move[]              // the ordered, adaptable steps (lobby, plant, deal, position, throw)
  progress:  number              // how close to its goal (0..1) — Vault-only, never shown
  horizon:   "day" | "week" | "season"   // a flip vote vs. a season-long "get the threat out" crusade
  status:    "active" | "won" | "lost" | "abandoned"
  startedBeat / deadlineBeat     // the ceremony it resolves against
  confidence: number             // the owner's read of its odds (drifts with the board)
}
```

It lives beside the other hidden engine state (souls, relationships, deals) and **never crosses the
wall** — no player or admin surface returns a campaign.

### Perspective is symmetric — no one is omniscient (not even the schemers)

The Vault Wall is not "hide campaigns from the player." It is **per-entity limited perspective, and
the player is one entity among sixteen.** A campaign is its **owner's private knowledge**; a bloc
running a shared one knows it together; an ally who was lobbied knows the slice they were told.
*Everyone else — NPCs and the player, identically — is in the dark, and learns it only through the
same pathways* (witnessed move, telling, overhear, gossip). This is the existing `KnowledgeService` /
`npcVoice` model (a houseguest structurally cannot voice what they never learned) applied to strategy.

The split that makes it work (ADR 0005 — authority by openness):

- **Closed set — the engine may be omniscient, because it only TALLIES.** The seeded resolver reads
  every campaign at once *solely* to compute the vote outcome. That math has no "perspective" and is
  never voiced or shown — it is the deterministic core.
- **Open set — every houseguest acts on BELIEF, never the master list.** When an NPC chooses a move or
  is voiced, they consult **their own** picture of who is gunning for whom — built only from what
  reached them. Two houseguests in different blocs hold different, often **wrong**, pictures of the
  house's campaigns. *That asymmetry is the game.* An NPC who was never lobbied and never saw the
  meeting cannot scheme against a campaign they don't know exists — exactly as the player cannot.

**The forbidden failure mode (tested against): "omniscient NPCs"** — the off-screen sim driving a
houseguest from the global campaign ledger rather than from that houseguest's own pathway-acquired
belief. Campaign *belief* diffuses NPC→NPC only through gossip/pathways and **drifts** with each
retelling (0038), so what one houseguest "knows" about another's plan can be partial, late, or simply
mistaken — the same distorted-belief-with-a-source the relationship model already produces.

### Generation — from goals + threat-reads

NPCs form campaigns from their **deep-profile goals (0058)** crossed with the **live board**: who
threatens them (a high-threat edge, an impending nomination), who they're bonded to (an alliance to
build), a grudge to act on. A `comp-beast` left in the game spawns "evict the bigger threat";
a `mastermind` spawns "build-alliance" early and "discredit-rival" late. Seeded, archetype-weighted,
bounded in number (a house isn't all campaigns at once — scarcity keeps it legible).

### Execution — one motivated move per off-screen tick

Each off-screen tick (`simulateOffscreenStretch` / `richOffscreenStretch`, 0038), every active
campaign advances **one concrete move**, folding into the systems that already exist — *no new parallel
mechanics*:

- **lobby** — an NPC↔NPC scene pushing the target's name (fold via relationships + gossip 0038).
- **plant** — seed a doubt/rumor about the target (gossip diffusion 0038, drifting with each retelling).
- **deal** — offer/strengthen a promise toward the goal (0039).
- **position** — distance from the target, cluster with allies (presence/blocs 0049/0043).
- **throw / win** — bend a competition *intent* toward the goal (the existing intent system, 0006).

The move is **motivated, not scripted**: which move fires is chosen by the owner's character + the
board, through the seeded `RandomnessSource`. Critically, a move is chosen from the **owner's own
belief** of the board (who *they* think is a threat, who *they* trust), never an omniscient read of
every other campaign — and a move that targets or recruits another houseguest only succeeds in
*informing* that houseguest through the move's own pathway (a lobby tells the lobbied; a planted rumor
diffuses and drifts). A bystander NPC with no pathway learns nothing.

### Adaptation — the board changes, the plan re-plans

A campaign is not a fixed script. When the board shifts it **re-plans rather than evaporating**: the
target wins veto ⇒ re-aim at the replacement (or escalate); a recruited ally flips ⇒ shore up or
abandon; the owner lands on the block ⇒ the campaign pivots to self-`protect`. (Mirrors ADR 0005's
principle: a move that fits no enum still folds — strategy must never silently vanish.)

### Resolution — it tilts the *seeded* outcome (the anti-sycophancy spine)

This is the crux. A campaign's accumulated `progress` feeds the **existing seeded decision weights
(0044, `decisions`/`decisionConstants`)** — not just the eviction **vote** but the other seeded
decisions too (**nominations, the veto, replacement noms**): a well-run "evict X" campaign measurably
raises X's odds of going up *and* going home; a "protect" campaign lowers them. **The engine tallies
it; narration only voices it.** No campaign "wins" because the story wanted it to — it wins because the
seeded math, fed by real accumulated moves, landed there. The campaign resolves `won`/`lost` at its
deadline ceremony.

#### How hard it tilts is CHARACTER-mediated, not a flat knob (owner direction)

The magnitude of a campaign move's effect is **not a global constant** — it is a product of *who is
talking* and *who is listening*, so a campaign is only as strong as the people running and receiving
it. Two new static `CHARACTER` aptitudes (siblings of the comp stats; minted at cast time, byte-stable
like `voice`):

- **`persuasiveness`** — how much weight this houseguest's lobbying carries. A charismatic mastermind
  or social butterfly lands hard; a blunt loner barely moves a vote. (Correlated with the `social`
  stat + archetype, independently varied.)
- **`susceptibility`** (gullibility ↔ conviction) — how easily this houseguest is *swayed* by others'
  campaigns. A credulous follower flips on a whisper; a stubborn independent resists even a strong,
  sustained push and may need overwhelming pressure to move.

A move's per-listener tilt ≈ **`base × persuasiveness(owner) × susceptibility(listener) × trust(owner→
listener)`**, then the seeded roll (temperature). So the *same* campaign lands differently on each
member of the electorate: it flips the gullible ally, barely dents the skeptic, and lands hardest
where the lobbied already trusts the lobbyist. This is what makes a "persuasive" houseguest genuinely
dangerous and a "gullible" one a liability to their own alliance — strategy with texture, not a dial.

### The scramble — campaigns colliding at the vote

The pre-eviction **scramble** is the week's campaigns crashing together: many owners working the same
small electorate, a **hidden true vote count** that can diverge from what each houseguest says to the
player's face (secret ballots, E12). A **blindside** is precisely that divergence — the player (or the
target) believes one count; the sealed tally says another. The reveal is the staged, anonymized
eviction (E12); the per-owner attribution unseals only in the 0048 retrospective.

## The player's side

- **Experienced, never read directly.** The player never sees a campaign object. They feel it: the
  same name pushed at them by several houseguests (diffusion), an NPC who keeps **approaching** them to
  lobby (a campaign move surfaced as a 0036 social initiative), a pair conspicuously **holed up** (0077),
  a story that **contradicts** what someone else told them (a plant catching the light). They may be a
  campaign's **target** (the house quietly working them out) or an **asset** (recruited into someone's
  plan). Knowledge of a campaign arrives **only through a 0002 pathway** — what they witness, are told,
  or overhear.
- **The player runs their own.** The player can pursue their **own** campaign — declare a goal
  (out-of-character, a Diary-Room-level intent) and execute it through their real social play across
  days. It is **player-knowledge** (no in-game pathway to any NPC — like the Diary Room, mandate text),
  it **never auto-controls NPCs** (they respond through their own reads), and the house's response is
  earned through the moves the player actually makes. The engine tracks the player's campaign so the
  later board and the retrospective reflect what they tried.

## Engine seams

- New `src/engine/campaigns.ts` — the `Campaign` type, generation (`formCampaigns`), the per-tick
  `advanceCampaign` (selects + applies one move via the existing fold paths), and `replan`. Pure +
  seeded; engine-only.
- `src/engine/characterFactory.ts` — `Character` gains `persuasiveness` + `susceptibility` aptitudes
  (byte-stable, archetype-correlated, independently varied — minted beside the comp stats + 0084
  `voice`). New constants in `campaignConstants.ts` (the sibling-constants pattern) hold the trait
  ranges + the `base` tilt and the trust/temperature mix.
- `src/engine/offscreen.ts` — the society tick advances each active campaign one move (the single
  driver; no second loop).
- `src/engine/decisions.ts` / `decisionConstants.ts` — the nomination/veto/vote weighting reads a
  campaign's `progress` **scaled per-listener by `persuasiveness × susceptibility × trust`** (a new
  bounded term beside `juryManagementWeight` et al.), so a sustained, *well-pitched* campaign tilts the
  **seeded** outcome and a poorly-pitched one barely registers. **Calibration-critical:** the term must
  ride the existing decision stream
  with a controlled draw structure (the juryReach/gradient lesson) — gated by a property test that a
  campaign *shifts* the eviction distribution without de-seeding it.
- `src/adapters/engine/GameSessionAdapter.ts` / `EngineCommandsAdapter.ts` — campaign moves that touch
  the player surface route through the **existing** seams (social initiatives 0036, gossip surfacing
  0002) — the player learns a campaign only as those pathways already allow. A player-campaign intent
  is recorded as player-level OOC state (never an NPC pathway).
- Persistence: campaigns + their move history persist in `SessionCore` (0007/0030) and **accumulate**
  (non-degradation #4 — a season-long campaign's history deepens, never thins); pruned only on
  resolution/eviction.
- Vault: the `Campaign` store is engine-only; dependency-cruiser proves no outward import, exactly like
  the souls/relationships.

## Testability (role-only; HARD rules)

- **Persistent, not one-shot:** a campaign advances across **multiple** off-screen ticks and survives a
  snapshot/restore mid-run (a multi-week `season` campaign carries across a week boundary).
- **Adaptive:** when the target escapes (veto), the campaign **re-targets or pivots** rather than
  vanishing; when the owner is endangered it flips to self-protect.
- **It actually tilts the outcome (anti-sycophancy):** a property test over seeds shows a sustained
  "evict X" campaign **raises X's eviction rate vs. a no-campaign baseline** — *and* that the run stays
  seeded (same seed ⇒ same result; the calibration gates stay green; the campaign term doesn't re-phase
  the juryReach spine).
- **Character-mediated magnitude (the strategy knob):** the *same* campaign tilts **more** when its
  owner is highly `persuasive` and **less** when run by a low-persuasion houseguest; and it sways a
  **gullible** (high-`susceptibility`) listener far more than a **stubborn** one — a property test
  holds the campaign fixed and varies only owner persuasiveness / listener susceptibility and shows the
  eviction shift scale accordingly. `persuasiveness`/`susceptibility` are byte-stable across a
  snapshot/restore (static `CHARACTER`, like the comp stats).
- **Vault-sealed:** no player or admin surface returns a campaign's existence, target, plan, or
  progress — a sentinel sweep over every player/admin projection is clean; the player's only knowledge
  of a campaign arrives through a recorded pathway (lobby scene / gossip / overhear / conspicuousness).
- **Perspective is symmetric — NPCs are not omniscient (the headline guarantee):** a bystander NPC
  outside a campaign's knowledge set never voices or acts on it — their `npcVoice` projection carries
  no trace of a campaign they were never on a pathway to, and their off-screen moves are driven from
  their OWN belief, not the global campaign ledger. The proof is a sentinel like the player's, run over
  an *uninvolved NPC's* projection: a campaign two other houseguests are running must be absent from it
  until a pathway reaches them. (The owner + lobbied allies DO know their own; that is the contrast.)
- **Belief diffuses and drifts (NPC↔NPC, like the player):** once a houseguest learns of a campaign
  through a pathway, that belief spreads further only by gossip and **drifts** with retelling — so two
  houseguests can hold different, partial, or mistaken pictures of the same plan (no shared omniscient
  truth; the engine's master ledger is read only by the closed-set tally, never by a voiced NPC).
- **The blindside:** the hidden true vote count can diverge from houseguests' stated intentions; the
  staged reveal is anonymized (E12); attribution unseals only in the 0048 retrospective.
- **Content stays sealed:** the player can learn *that* a campaign exists and *who/what* it targets
  (through a pathway) without ever receiving the sealed scene content (ties 0077 conspicuousness).
- **Player campaign isolation:** a player-declared campaign is player-knowledge with **no** NPC
  pathway (it never appears in any NPC's `knows`), and it **never** auto-moves an NPC — NPCs respond
  only to the player's actual recorded moves.
- **Determinism:** seeded generation + execution ⇒ reproducible campaigns.

## Open questions / defaults (resolve at build)

1. **How many concurrent campaigns** keep the house legible without sprawl? (Start: a small per-week
   cap, archetype-prioritized; scarcity is a feature — tune from a UAT walk.)
2. ✅ **The decision-weight magnitude** — **RESOLVED (owner, 2026-06-25): it is a CHARACTER-mediated
   strategy knob, not a flat constant.** The tilt scales with the owner's `persuasiveness` × each
   listener's `susceptibility` (× trust), so "how hard a campaign tilts" is a property of *who* is
   campaigning and *who* is listening (above). Still *felt but never deterministic* — the underdog can
   survive even a strong campaign — and the `base` factor + trait ranges are calibrated against the
   existing eviction distribution; do **not** ship values that flatten variance. (Remaining work is
   tuning the ranges, not the architecture.)
3. **Bloc campaigns vs. solo** — when does a bloc (0043) adopt a *shared* campaign vs. members running
   their own? (Start: a cohesive bloc shares one; loose ties stay solo.)
4. **Player-campaign surface** — is the player's declared goal an explicit OOC "set a target" affordance
   or inferred from their Diary-Room strategy? (Start: lightweight, inferred from play + DR; resist a
   strategy dashboard — ADR 0003.)
5. **Move vocabulary** — the starting `Move` set (lobby/plant/deal/position/throw); extend only as the
   fold paths support them.
6. **Horizon mix** — how often a campaign is a single-week flip vs. a season-long crusade (affects
   pacing + how much the player can perceive over time).
