# 0097 — The suspicion ledger (a player-private "called it / wrong" scorecard)

> **RETIRED 2026-11-11 (owner ruling, "retire and remove").** This feature is not planned and its unused code and tests are removed (card ORW-267). The text below is history only.

> **Status:** ❄️ **FROZEN** (owner-parked "not planned" 2026-06-27; reaffirmed by the owner 2026-11-03; [`docs/features/README.md`](./README.md) is the authoritative status index). It is **not reopened**. A pure engine core built 2026-07-12 is preserved in the tree but is unwired and not live: the pure ledger core is built & unit-green
> (`src/engine/suspicionLedger.ts` + `suspicionConstants.ts`, `tests/unit/suspicionLedger.test.ts`) — logging
> (verbatim/lossless), the sanctioned-reveal matcher (`resolveAgainstReveal`: a model-proposed verdict COMMITTED,
> or the deterministic keyword/about/topic floor; frozen-on-resolve; NEVER a live Vault read), and the 0048
> `scorecard`. GOLDEN-NEUTRAL. **Follow-up lane (not yet built):** the FE-driven write-back wiring
> (`logSuspicion`/`getSuspicionLedger` — the 4-place port/adapter/registry-`INFRA_LEVERS`/McpServer + a `callTool`
> boundary test), snapshot persistence (field `suspicionLedger`, distinct from `knowledge.suspicions`), the
> resolution-at-reveal hooks, and the BDD wiring. *(Previously: ❄️ FROZEN — parked 2026-06-27; #878 closed not
> planned; a 2026-07-12 "Everything" sweep built the core, but the freeze stands.)*
> Owner ruling: not load-bearing, and it risks the game over-telling the player / paranoia-as-spreadsheet
> (ADR 0003; "the feeling is theirs", 0017/0020). **If revived,** the chosen shape is on record: a DR-style
> OOC surface (R1), reveal-time-only scoring (R2), and player-authored player-knowledge with `NO_NPC_PATHWAY`
> (R3). See `docs/decisions/PO-DECISIONS-LOG.md` (2026-06-27). The original PO-review spec follows unchanged.
> **Depends on:** 0013 (the **Player Diary Room** — the OOC, player-knowledge-only channel this
> generalizes, and whose `NO_NPC_PATHWAY` wall it inherits wholesale), 0001 (the Vault Wall),
> 0002 (event visibility & pathway propagation — the only way a fact legitimately becomes the
> player's knowledge), 0048 (the **post-season Vault unseal** — the big-payoff reveal moment),
> 0075 (trust-gated confidences — a *lie* the player logged a hunch about, later caught). **Bounded
> by:** mandate #2 (Vault Wall — scoring **never** reads the Vault live; it compares the player's
> stated hunch to truth **only** at a sanctioned reveal moment, where the truth has *already*
> legitimately become surfaced), mandate #3 (anti-sycophancy — a hunch is scored against ground
> truth, never graded to flatter; the game never "lets the player be right"), mandate #4
> (non-degradation — every logged hunch + its eventual verdict persists, accumulating into a
> permanent personal record). **ADR fit:** 0003 (the conversation is the game — this is an OOC
> *augment* the player drives in their own words, **not** a dashboard the game plays for them),
> 0005 (split authority by openness — a hunch is free-text open-set content recorded losslessly;
> the only closed-set act is the engine stamping a `called-it` / `wrong` verdict at a reveal).

## Why — externalize the detective fantasy, and pay it off

*Big Brother* is, for the viewer at home and the strategist inside, a **detective game**. Half the
fun is forming theories from fragments — *"they're lying about who they voted for," "there's a
final-two I'm not in," "the veto winner is about to flip"* — and then watching the season **prove
you right or make a fool of you.** Today the player can *think* all of that, but the game keeps no
record of it, so the single most satisfying beat in reality TV — **"I CALLED IT"** (or the humbling
"...I was so wrong") — never happens. The hunch evaporates the moment it's formed; there is no
scorecard, no payoff, no reckoning.

The 0013 Diary Room already gives the player a private, out-of-character place to **process and
theorize** — but it is write-only catharsis: nothing ever comes back and tells the player whether
their read was true. This feature closes that loop. It gives the player a **suspicion ledger**: a
private list of explicit, stated hunches that the game later **pays off or refutes against the
hidden truth**, producing a personal *"called it / wrong"* scorecard. It turns the player's paranoia
and pattern-matching — which the four mandates deliberately leave entirely to the human (0017/0020:
"the feeling is theirs") — into a **rewarded, remembered** mechanic, without ever telling the player
what to feel or whether they're right *until the fiction has earned the reveal.*

### Retention value (why this is worth a spec)

- **A reason to pay attention to texture.** Off-screen scheming (0038), distorted gossip (0094), and
  drives (0086) produce a rich hidden layer the player only glimpses. A ledger gives the player a
  **stake** in noticing those glimpses — every fragment is now potential evidence for a logged
  theory.
- **A self-authored cliffhanger.** A logged hunch is an open question the player *wants* to see
  resolved — it pulls them forward to the next eviction, the next veto, the post-season unseal.
- **A permanent, deepening record (mandate #4).** The ledger accumulates across a season and is
  preserved in the retrospective — the player's *detective track record* becomes part of the story
  they replay, the opposite of memory-thinning.
- **It costs the engine almost nothing creative.** The hunch is the player's own words (open set,
  lossless); the engine only stamps a verdict at a moment the truth is already legitimately known.

## The bright line this feature must respect (read first)

A "called it / wrong" verdict looks, at a glance, like it must **peek at the Vault** — how else
would the game know the player was right about a secret? **It must not, and does not.** The Vault
Wall is preserved by one structural rule, enforced in code, never by prompt:

> **Scoring compares the player's stated hunch to truth ONLY at a *sanctioned reveal moment* — a
> point in the fiction where that truth has *already* legitimately become surfaced/known. The
> scorer reads the **revealed fact** (now player-knowledge or post-season-unsealed), never a live
> Vault read.**

There are exactly two classes of sanctioned reveal, and **both already exist**:

1. **In-game sanctioned reveals** — a fact that legitimately becomes the **player's knowledge**
   through a modeled 0002 pathway *or* a committed closed-set outcome: an eviction vote tally
   surfaced at the ceremony, a veto used/saved, an alliance that becomes observable, an NPC who
   *confides* the real thing (0075, recorded via `surfaceInformationTo`), gossip that terminates at
   the player (0094). At that instant the truth is **no longer secret** — it is the player's
   knowledge — so comparing a prior hunch to it reads no Vault state at all; it reads the player's
   own (now-true) knowledge.
2. **The post-season Vault unseal (0048)** — the **one** place the Wall sanctions opening the Vault,
   *after* the season is `finished`, because there is no game left to spoil. Hunches the season
   never confirmed in-play (the secret final-two that quietly fizzled, the off-screen scheme the
   player only suspected) get their verdict **here**, in the retrospective.

A hunch that **neither** an in-game reveal nor the post-season unseal ever touches stays **`open`
forever** — *the game never resolves it from the Vault to close the loop.* "Unresolved" is a real,
honest ledger state, not a defect. This is the whole Vault-safety argument: **no verdict is ever
produced by reading sealed state; a verdict only ever reads an already-revealed fact.**

## The mechanic

### 1. Logging a hunch (the player's own words — open set, lossless)

The player logs a hunch in their **own free-text**, exactly as they already speak in the Diary Room
(0013) — *"I think the HOH is lying about their vote," "there's a final-two between the two of them
that I'm not in," "the veto winner is going to flip the noms."* A hunch is recorded as a
**player-knowledge, OOC, `NO_NPC_PATHWAY` event** — it inherits the 0013 Diary Room wall wholesale
(see ruling **R3**): it is the player's knowledge, it may inform the engine's *read of player
strategy*, and it **never** derives any NPC knowledge or behavior.

```
SuspicionEntry {
  id:        EntryId
  text:      string            // the player's verbatim hunch — open-set, stored LOSSLESS (ADR 0005)
  about?:    EntityId | EntityId[]   // optional, player-tagged subject(s) — a hint for matching, never required
  topic?:    "vote" | "alliance" | "target" | "secret" | "showmance" | "twist" | "free"  // optional self-tag
  loggedAt:  BeatRef           // when (week/phase/beat) — for the timeline + "how early did I call it"
  status:    "open" | "called-it" | "wrong" | "partial"   // engine-stamped ONLY at a sanctioned reveal
  resolvedAt?: BeatRef         // when the verdict landed (a reveal beat, or the post-season unseal)
  evidence?:  EventRef         // the revealed fact that resolved it (an in-game reveal event, or an unseal entry)
}
```

- `text` is **open-set** and stored **losslessly** (ADR 0005 §"open set"): the player's words are
  never normalized, truncated, or mapped onto an enum. `about` / `topic` are **optional** player-
  supplied hints that *help* matching; the feature works without them (a free hunch is still
  loggable and resolvable).
- `status` starts `open` and is **only ever** moved by the engine at a sanctioned reveal (below).
  The player can **edit/withdraw** an `open` hunch (it's their private scratch space); a **resolved**
  hunch is frozen — the verdict is part of the permanent record (mandate #4, anti-sycophancy: the
  player can't retroactively "fix" a wrong call).

### 2. Resolution — stamping a verdict at a sanctioned reveal (the closed-set act)

This is the **only** place the engine touches the ledger, and it never reads the Vault. When a
sanctioned reveal fires (a reveal event becomes player-knowledge, or the 0048 unseal runs), the
engine runs a **matcher** between the *open* hunches and the *now-revealed* fact:

- The matcher compares a hunch's `text` (+ optional `about`/`topic`) against the **revealed fact's
  own structured description** — e.g. the eviction event's `{ kind: vote, evictee, tally }`, the
  veto event's `{ used, savedNominee }`, the 0075 confidence's recorded `{ truthful, content }`, the
  0048 unseal's surfaced scheme/confessional/twist. **It reads the reveal, not the Vault.**
- A match stamps `called-it`; a logged hunch the reveal **contradicts** stamps `wrong`; a hunch the
  reveal partly bears out stamps `partial`. **No match ⇒ the hunch stays `open`** (an unrelated
  reveal must never touch an unrelated hunch).
- **How the match is computed is a build decision, not a Vault question** (see Open questions §1):
  the leading option is the **front-end's own LLM** doing the semantic comparison of *the player's
  text* vs *the already-revealed, Vault-free fact* and proposing a verdict the engine records —
  symmetric with the 0055 `_auto_record_scene` / ADR 0005 generative pattern (the model *proposes*
  open-set interpretation; the engine *commits* the closed-set verdict). Crucially the model is
  handed **only already-revealed facts**, never sealed state — it "cannot leak what it never
  receives," and a wrong match is a cosmetic mis-score, never a Vault breach.

> **Anti-sycophancy is structural here (mandate #3).** The verdict is computed against **ground
> truth as revealed**, never tuned to please. The game does **not** nudge a borderline hunch toward
> `called-it`; it does **not** soften a `wrong`; and it **never** surfaces the truth *early* just to
> let the player be right. A reveal fires when the *fiction* earns it (a ceremony, a confession, the
> finale unseal) — the ledger rides that schedule, it does not accelerate it.

### 3. The payoff — the "called it / wrong" moment (player-facing, Vault-safe)

When a hunch resolves, the player gets the satisfying beat:

- **In-game reveal:** at the ceremony / confession where the truth surfaced, the player's matching
  hunch is marked **"✓ Called it"** (or **"✗ Wrong"** / **"~ Partly right"**) — *referencing only
  the fact that just legitimately surfaced.* The verdict adds **no** information the player doesn't
  now legitimately have; it only annotates *their own prior theory* against *the now-public fact*.
- **Post-season (0048):** the retrospective's unseal segment runs the ledger one final time against
  the unsealed hidden story, then presents the **season scorecard** — *"You called 6 of 11. You
  spotted the final-two in week 3. You never caught the lie about the votes."* This is the
  detective-fantasy payoff at full volume, and it is **exactly** the sanctioned-reveal context 0048
  already establishes (the Wall opens because the season is over).
- **Unresolved hunches** are shown honestly as **"never confirmed"** — not graded, not guessed.

The scorecard is a **recap of the player's own record + already-revealed truth** — it is Vault-free
*by construction* because every datum in it is either the player's own logged text or a fact the
reveal already made non-secret.

## ADR 0003 fit — augment, never a dashboard (this is the load-bearing design tension)

ADR 0003 principle #4 is explicit: *UI may **augment** the conversation but never **replace** an
interaction that builds or progresses the game*, and principle #1: *prefer removing context to
adding it; don't turn talking-to-a-houseguest into operating a dashboard.* A "scorecard" is exactly
the kind of feature that could metastasize into a stats dashboard. The design holds the line:

- **Logging is conversational, in the player's own words**, through the existing OOC Diary-Room
  channel (0013) — *"log this: I think there's a final-two I'm not in."* It is **not** a form, a
  dropdown, or a structured-input UI. The player theorizes in prose; the engine just remembers it.
- **The ledger builds/progresses *nothing* in the game.** It casts no vote, moves no relationship
  edge, changes no NPC, alters no outcome. It is a **pure reflection** of the player's own
  knowledge + already-revealed facts — precisely the "memory wall / reflect-it" category ADR 0003
  *permits* as augmentation, never the "play the game for me" category it forbids.
- **It adds zero context to the game turn.** A hunch is OOC player-knowledge with `NO_NPC_PATHWAY`;
  it never enters an NPC's voicing context, never gets handed to the narrator as a "fact to voice,"
  never bends a scene. The narration LLM does not see the ledger when playing the house.

See ruling **R1** for the owner decision on the *surface* (a quiet Diary-Room-style OOC view vs. a
persistent HUD) — the recommendation below keeps it firmly on the "augment" side.

## Engine seams (where this lands — hexagonal)

- `src/engine/suspicionLedger.ts` *(new, pure)* — the `SuspicionEntry` type, `logHunch(...)`
  (append), `withdraw/editHunch(...)` (open-only), and the **matcher** `resolveAgainstReveal(entries,
  revealedFact, proposedVerdict?)` → the verdicts to stamp. **No I/O, no Vault handle** — it is
  handed the *already-revealed* fact and (optionally) a model-proposed verdict; it owns the closed-
  set commit (which entries move to which status), never magnitude-of-truth.
- `src/engine/suspicionConstants.ts` *(new)* — the single tunable (matcher thresholds if rule-based,
  the per-season scorecard shape, the optional topic enum). Sibling of `THREAD`/`GOSSIP`/`CONFIDENCE`
  (the B59 grep gate covers it).
- **`GameSession` port + `GameSessionAdapter`** (the four-place FE-driven write-back, per `CLAUDE.md`
  / `SOUL.md` — ports + adapter + registry `PLAYER_TOOLS`&`INFRA_LEVERS` + `McpServer` dispatch, with
  a `McpServer.callTool` boundary test, because the static gates miss a missing #4):
  - `logSuspicion(text, about?, topic?)` — records the hunch as a **0013 Diary-Room-class** OOC
    knowledge event (`NO_NPC_PATHWAY`), returns the new `SuspicionEntry`. (FE-driven write-back: the
    player's words come from the FE; the engine stays the source of truth.)
  - `getSuspicionLedger()` — a **Vault-free** read of the player's own entries + verdicts (for the
    surface). Carries **no** secret and **no** number-of-truth — only the player's text + the
    engine-stamped status + the revealed-fact reference.
  - **Resolution is engine-internal, hooked into existing reveals** — *not* a new player tool. On a
    sanctioned reveal (an eviction/ceremony event committed, a 0075 confidence recorded, gossip
    terminating at the player, the 0048 unseal running) the adapter calls
    `suspicionLedger.resolveAgainstReveal(...)` with the **revealed fact** and records the stamped
    verdicts. The verdicts persist as ordinary 0030 state.
- **0048 retrospective integration** — `seasonRetrospective()` runs the final resolution pass over
  any still-`open` hunches against the unsealed story and assembles the **season scorecard** (counts,
  earliest correct call, biggest miss). This is the **only** moment the ledger sees the unsealed
  layer, and it is **already** the one sanctioned Vault-reading seam (0048's gate), so no *new*
  outward Vault handle is introduced.
- **No narrator/NPC seam.** The ledger never appears in `npcVoice`, `getMomentPrompt`, or any NPC
  context. (Asserted — see Testability.)

## Persistence (0007/0030 — non-degradation, mandate #4)

- Every `SuspicionEntry` — text, the logging beat, the eventual verdict + its evidence reference —
  persists in the session snapshot and is **monotonic**: a resolved hunch is frozen and never lost,
  edited, or down-graded across saves/restarts. The detective record **accumulates and deepens**
  over a season (the explicit opposite of the old version's thinning store).
- The lossless free-text `text` is the open-set content ADR 0005 protects — stored verbatim, never
  normalized.

## Determinism & anti-sycophancy

- **Deterministic given the reveals.** Resolution is a function of *which sanctioned reveals fired*
  and *what they revealed* — both already deterministic/seeded upstream. A rule-based matcher is
  fully deterministic; an LLM-proposed verdict is recorded as a **one-time stamp at the reveal**
  (frozen thereafter), so a replay with the same reveals + the same logged hunches reproduces the
  same scorecard. The ledger introduces **no new rng**.
- **No number of truth ever crosses.** The player sees their own text + a verdict word + a reference
  to the already-public fact — never a sealed value, never a confidence/relationship number
  (mandate #2/#3). The game never bends a verdict to flatter (mandate #3).

## Acceptance criteria (role-only; HARD rules)

- **Logging:** a hunch logs as the player's own OOC knowledge, verbatim (lossless), tagged
  `NO_NPC_PATHWAY`; it appears in `getSuspicionLedger()` and **never** in any NPC's knowledge or
  voicing context.
- **No live Vault read (the load-bearing test):** a logged hunch about a secret stays `status:
  open` and **nothing about the secret appears on any player surface** until a sanctioned reveal
  legitimately surfaces that truth. A sentinel sweep proves the ledger + scorecard carry no sealed
  premise and no number pre-reveal; resolution **reads the revealed fact, never the Vault** (the
  scorer is handed the reveal, not a Vault handle).
- **Payoff at the reveal:** when a sanctioned in-game reveal makes a truth player-knowledge, a
  matching prior hunch flips to `called-it` (a contradicted one to `wrong`, a partial to `partial`),
  referencing **only** the now-revealed fact.
- **Post-season scorecard (0048):** after the season is `finished`, the unseal pass resolves still-
  `open` hunches against the unsealed story and produces a scorecard (counts + earliest correct
  call), **only** for that finished season, **never** for a live or another user's game (cross-user
  isolation, 0021).
- **Unresolved is honest:** a hunch no reveal ever touches stays `open` / "never confirmed" — the
  game never closes it by peeking at the Vault.
- **Never drives NPC behavior (the 0013 wall):** across seeded play, no NPC's knowledge gains a
  ledger entry and no NPC decision changes because of one (cross-checks the 0013/0002 scenario).
- **Anti-sycophancy:** verdicts are computed against revealed ground truth; a borderline hunch is
  **not** nudged to `called-it`, a `wrong` is **not** softened, and no reveal is surfaced early to
  let the player be right; a resolved hunch is frozen (no retroactive "fixing").
- **Non-degradation:** every hunch + verdict survives save/restart, monotonic; the record deepens.
- **Determinism:** same reveals + same logged hunches ⇒ same scorecard; the ledger adds no rng.

## PO review — owner rulings needed

This spec is **blocked on three owner decisions.** A recommendation is given for each; please
confirm or redirect.

### R1 — WHERE the ledger lives: a Diary-Room-style OOC surface, or a HUD?

The detective scorecard is exactly the kind of feature that could drift into a **stats dashboard**,
which ADR 0003 (#1 "don't turn it into a dashboard," #4 "augment, never replace") warns against. The
question is whether the ledger is a **quiet OOC surface** the player visits in the Diary-Room flow,
or a **persistent always-on HUD** element.

> **Recommendation: a Diary-Room-style OOC surface (NOT a persistent HUD).** Logging is
> conversational, in the player's own words, through the existing 0013 OOC channel ("log this: …");
> the ledger is *viewed* in that same OOC, pressure-free space (and the **"✓ Called it"** beat is
> surfaced inline at the reveal it belongs to — a momentary annotation, not a standing panel). This
> keeps it firmly on the **augment** side of ADR 0003: it reflects the player's own theorizing and
> already-revealed facts, it never occupies game-play real estate, and it never tempts the player to
> "operate" it instead of *playing the house*. A persistent HUD risks turning paranoia into a
> spreadsheet — the opposite of "the feeling is theirs" (0017/0020). *(If the owner wants more
> visibility, a middle option is a single unobtrusive "🔎 N open hunches" affordance that opens the
> OOC view — still not a live data panel.)*

### R2 — Scoring compares STATED hunch to truth ONLY at a sanctioned reveal, never a live Vault read.

The tempting-but-forbidden implementation is to score a hunch the moment it's logged by peeking at
the Vault ("is the player right *right now*?"). That would be a **Vault Wall breach** (mandate #2)
and a spoiler engine — and it would also break anti-sycophancy/anti-spoiler (#3): the game would
*know* the answer and be one bug away from leaking it.

> **Recommendation: confirm reveal-time-only scoring (NEVER a live Vault read).** A verdict is
> stamped **only** when the truth has *already* legitimately become surfaced — an in-game reveal that
> makes the fact player-knowledge (0002 pathway / committed closed-set outcome), or the post-season
> 0048 unseal. The scorer is handed the **revealed fact**, never a Vault handle; the matcher module
> (`suspicionLedger.ts`) has no `VaultStore` import (dependency-cruiser proves it). A hunch no reveal
> ever touches stays honestly `open`. This is the *only* design that keeps the Wall absolute *and*
> preserves the suspense the whole feature exists to reward. **Strongly recommend accept** — there is
> no Vault-safe alternative.

### R3 — Confirm the ledger stays player-knowledge and NEVER feeds NPC behavior (the 0013 DR rule).

The ledger is the player's private hunches — structurally the same shape as Diary-Room content,
which 0013 mandates is the player's own knowledge with **`NO_NPC_PATHWAY`**: it may inform the
engine's *read of player strategy* but **never** derives any NPC's knowledge or behavior. The risk
is that a "the player suspects X" signal quietly leaks into how X (or anyone) is voiced — turning a
private theory into something the house can react to, which would be both a 0013 violation and a
soft anti-sycophancy hole (NPCs "playing along" with the player's guesses).

> **Recommendation: confirm — the ledger is player-knowledge with `NO_NPC_PATHWAY`, full stop.** It
> inherits the 0013 Diary-Room wall verbatim: it is the player's knowledge, it may at most inform the
> *player-strategy read* (the same OOC consumers 0013 already names — producer prompts, the tagline,
> the 0048 retrospective), and `deriveNpcKnowledge` **excludes** it entirely. No NPC ever knows the
> player logged a hunch; no NPC behavior changes because of one. The 0013 "DR → no NPC" sentinel test
> is extended to cover ledger entries. **Strongly recommend accept** — anything else re-opens a wall
> 0013 already closed.

## Open questions / defaults (resolve at build)

1. **Matcher implementation — rule-based vs. LLM-proposed (default: LLM-proposed, engine-committed).**
   Resolving "does this free-text hunch match this revealed fact?" is open-set interpretation. The
   recommended path mirrors ADR 0005 / 0055 `_auto_record_scene`: the **FE's own LLM** proposes the
   verdict from *the player's text* vs *the already-revealed (Vault-free) fact*, and the engine
   **commits** the stamp (closed-set). The model is handed **only revealed facts** — a wrong match is
   a cosmetic mis-score, never a leak. A deterministic keyword/`about`/`topic` fallback covers the
   no-model case (the engine's floor stands). Either way the *stamp* is frozen once recorded
   (determinism).
2. **What counts as an "in-game sanctioned reveal."** Start with the unambiguous, already-committed
   ones: eviction tally at the ceremony, veto used/saved, a 0075 confidence recorded as
   true/false, gossip that terminates at the player (0094), an alliance becoming observable. Widen
   cautiously — every reveal class must be a point where the truth is *already* legitimately
   player-knowledge (never a Vault peek).
3. **Partial credit.** Whether to support `partial` ("right that there's a final-two, wrong about
   who") in v1 or ship binary `called-it`/`wrong` first. Default: include `partial` (it's the honest
   reality-TV verdict), but the matcher may collapse to binary if tuning proves `partial` noisy.
4. **Editing/withdrawing.** Default: `open` hunches are freely editable/withdrawable (private
   scratch space); **resolved** hunches are frozen (mandate #4 / anti-sycophancy — no retroactively
   "fixing" a wrong call). Confirm at build.
5. **Player-vs-NPC asymmetry (consistent with 0086 #3).** The ledger is **player-only** — the engine
   never models a "houseguest's hunch ledger" for NPCs (NPC suspicion already lives in the
   relationship `confidence`/`threat` reads + drives). This feature is purely the human's detective
   scorecard.
