# 0037 — Live jury-vote choreography (the interactive finale)

> **Status:** ✅ **Built & green** (engine in `cucumber.cjs`; **front-end UI done — B26 + C11, §8**). The
> **live realization of 0014 §5–6** — the Final 2 finale as an interactive,
> staged sequence inside the running game, not a single auto-resolved winner. The pure jury logic
> (`src/engine/jury.ts` — `juryLean`, `castJuryVote`, `finalePerformance`, `tallyJuryVote`, `runFinale`)
> is **green (0014)** but the live loop ignores almost all of it: `liveSeason.runFinale` hard-codes a
> crude `trust+affinity` comparison, never records eviction **manner**, never surfaces the **statements /
> questions**, never calls **`finalePerformance`**, and announces the winner in **one** beat. 0037 wires
> the built logic into the live loop and adds the missing choreography — the same "built-in-isolation,
> wire-it-live" pattern as **0034 / 0035 / 0036**.
> **Executable spec:** [`0037-live-jury-vote-choreography.feature`](./0037-live-jury-vote-choreography.feature)

> **Amendment (Wave 2 — symmetric jury management, audit A5 + A6).** Two asymmetries that made the
> finale **inert against / sycophantic toward the player** are closed (`liveSeason.ts`):
> - **A5 — manner applies to the player.** `recordEvictionManner` no longer exempts the player: when the
>   player is a **responsible** houseguest (the HOH who nominated, or a voter who voted to evict), the
>   evictee records their manner (betrayed / blindsided / respected) toward the **player** like anyone else
>   (§4.2). So a juror the player blindsided on the way out weighs that against them at the player's own
>   finale — jury management, the signature mechanic, now cuts **both** ways. (It also folds the
>   evictee→player resentment into the hidden relationship layer at eviction, per 0023.)
> - **A6 — each juror questions BOTH finalists (18 Q&A), so the symmetry is structural.** Per the
>   queue ruling, `runFinale` no longer alternates which finalist a juror addresses: **every juror
>   questions both finalists** (9 jurors × 2 finalists = 18), which keeps CLAUDE.md's "one question per
>   juror *per finalist*" canon. The **player-finalist answers all 9 jurors themselves**; the NPC finalist
>   answers all 9 with its `bestAppeal`. Because no `(finalist, juror)` pair is ever left unanswered, the
>   engine never has to fill a slot for one side — the sycophantic/asymmetric back-fill **cannot fire**
>   (the `appealMade` fallback is kept only as a never-hit safety guard), and player and NPC finalists are
>   scored by the **same** `appealEffect`. The jury/finale magnitudes are extracted to
>   `src/engine/juryConstants.ts` (`JURY_WEIGHTS`, the manner-lean shifts, the manner thresholds, the
>   appeal magnitudes) — extraction only, no number change.

## 1. Summary

At Final 2 the live game must stage the finale, not skip to a winner:

1. **Opening statements** — each finalist gives one (the player writes theirs when a finalist).
2. **Question round** — each of the **9 jurors** asks one question; when the player is a finalist they
   **answer every question** (the "Full" choreography), each answer carrying a **structured appeal** the
   engine scores; the NPC finalist's answers are auto-voiced.
3. **The vote** — when the player sits on the **jury** they cast their **own** vote (the other jurors are
   engine-decided); when the player is a finalist all 9 jurors are engine-decided.
4. **Staged reveal** — votes are revealed **one at a time** in the engine's reveal order, then the winner.

The vote stays **engine-decided** (mandate #3): **jury management dominates** — relationship +
**recorded eviction manner** (blindside / betrayal / disrespect / respect) — and the finale **sways close
jurors but never overturns a clear lead**. The finale sway is driven by the player's **engine-legible
structural choices** (which appeal they make to which juror), **never** by the LLM grading prose. The
**last-evicted juror** breaks a tie (0005/0014).

## 2. The three product decisions (resolved)

| Decision | Choice | Consequence |
|---|---|---|
| Player-finalist interactivity | **Full** | Player gives a statement **and** answers **every** juror question; each answer is a binding `submitDecision` carrying an appeal. |
| Finale sway model | **Engine-legible** | The sway is `appealEffect(appeal, rel, manner)` — a structured enum scored by the engine, **bounded** by `JURY_WEIGHTS.finale`. The LLM voices jurors + narrates answers but **never** scores them. |
| Player-as-juror | **Interactive** | When the player is a juror they ask a question (flavor) and **cast their own vote** via `submitDecision`; the other 8 are engine-decided; an illegal vote is rejected. |

## 3. Scope

**In:** record **eviction manner** on each live eviction (so jury management has live effect); drive the
finale as a staged sub-loop in `liveSeason` (statements → questions → vote → one-at-a-time reveal); new
**Vault-free** player decisions (`finale-statement`, `finale-answer`, `juror-vote`) through the existing
`advanceGame` / `submitDecision` seam (0034); the **engine-legible** appeal scoring + bounded finale sway
wired into the live tally via `castJuryVote` / `juryLean` / `finalePerformance` (0014 — reused);
**persist** an in-progress finale so it survives restart (0030); **sentinel-clean** finale surface (0001).

**Out:** the pure jury math (built — 0014; reused, not changed); the front-end UI that renders the
statements/questions/reveal in chat (a small follow-up on the 0032 game build, like 0036's C10 — the
agent can already drive it through the tools); NPC **confessional** content (Vault-only).

## 4. Design

### 4.1 Engine-legible appeals (the anti-sycophancy crux) — `jury.ts`
A small structured enum the player picks per answer; the engine scores it against **that juror's** state.
The LLM voices the exchange but the **number comes from the engine**.

```
type FinaleAppeal = "own-game" | "mend" | "connect" | "discredit-rival"
appealEffect(appeal, rel: JuryRel, manner: EvictionManner): number   // quality in [0,1]
  own-game        : lands with jurors who respect the game (some threat, not betrayed); backfires on the betrayed
  mend            : lands ONLY where there is a grievance (blindsided/betrayed/disrespected) to address; wasted otherwise
  connect         : scales with affinity
  discredit-rival : small generic lift; backfires with a juror loyal to the rival
```
`finalePerformance` (0014) already averages `{ quality }`; the per-juror `quality` is `appealEffect(...)`.
The sway stays bounded by `JURY_WEIGHTS.finale = 0.3` (well below `relationship 1.0` + `manner 0.8`), so a
strong finale tips **close** jurors and **never** overturns a clear lead.

### 4.2 Eviction manner — recorded live (`liveSeason.ts`)
On each `applyEviction`, record, per evictee, an `EvictionManner` toward each **responsible** houseguest
(the HOH who nominated them, and every voter who voted to evict): a houseguest the evictee **trusted**
(`edge(evictee, h).trust > τ`) who moved against them ⇒ **betrayed**; an eviction the evictee did not see
coming (no prior threat read) ⇒ **blindsided**. Stored on the live state, persisted (0030). At the finale
`juryLean(juror, finalist)` reads `manner[juror][finalist]`, so how the finalist treated each juror on the
way out genuinely shapes the vote.

### 4.3 Live finale sub-loop (`liveSeason.ts`)
A `finale` sub-state machine advanced one step per `advance()`:
- **statements**: player-finalist ⇒ `pending: finale-statement` (free-text flavor; no score); NPC ⇒ auto beat.
- **questions**: for each juror question, player-finalist ⇒ `pending: finale-answer { juror }` carrying an
  appeal; NPC-finalist answers auto. The chosen appeal is recorded.
- **vote**: player-juror ⇒ `pending: juror-vote`; all others computed via `castJuryVote` with
  `leanOf = juryLean(edge, manner)` and per-`(juror,finalist)` `perfOf = appealEffect(...)`.
- **reveal**: emit one `finale-reveal` beat per juror in `revealOrder`, then a `finale-result` beat naming
  the winner; tie → last-evicted juror (`tallyJury`, reused).

Binding choices change state **only** through `submitDecision` (0034); illegal choices are rejected.

### 4.4 Outward surface (`GameSession` port + adapter) — Vault-free
`PendingDecisionView.kind` gains `"finale-statement" | "finale-answer" | "juror-vote"`; `AdvanceView`
optionally carries the Vault-free `finale` projection (current stage, the juror asking, the finalists by
name, the reveal-so-far). `SubmitDecisionReq` gains `statement?`, `appeal?` (and reuses `vote?` for the
juror vote). **No leans, no vote tallies, no manner, no souls** ever cross — the player sees names,
prompts, the appeal options, and the reveal as it is narrated. `readsVault: false`; extend the 0001 canary.

## 5. Contracts (stack-agnostic)

```
appealEffect(appeal, rel, manner) -> number in [0,1]          // engine-legible; LLM never grades
recordEvictionManner(evictee, responsible[], rel)             // on each live eviction; persisted (0030)
advanceGame(): AdvanceView                                    // now steps the finale; pauses for finale decisions
submitDecision({ kind:"finale-statement", statement })        // player-finalist opening (flavor)
submitDecision({ kind:"finale-answer", appeal })              // player-finalist answer → bounded sway
submitDecision({ kind:"juror-vote", vote })                   // player-juror vote; illegal rejected
   → tally = castJuryVote per juror (leanOf=juryLean(edge,manner), perfOf=appealEffect); tie→last juror
   → reveal one juror at a time (revealOrder); finished:true + winner at the end
```

## 6. Definition of Done

- [ ] **Staged finale:** at Final 2 the live loop surfaces statements + a per-juror question round + a
      one-at-a-time reveal — not a single auto-resolved winner.
- [ ] **Full interactivity (finalist):** the player gives a statement and answers **every** juror question;
      each is a validated `submitDecision` (never parsed from prose).
- [ ] **Interactive juror:** when the player is a juror they cast their **own** vote; the other 8 are
      engine-decided; an illegal vote is rejected, state unchanged.
- [ ] **Jury management dominates:** across seeds, a finalist who **blindsided/betrayed** jurors wins less;
      recorded eviction manner measurably lowers those jurors' leans (property test).
- [ ] **Engine-legible, anti-sycophantic sway:** a strong finale **sways close jurors but never overturns a
      clear lead** (calibrated, bounded by `JURY_WEIGHTS.finale`); the appeal is a **structured choice** the
      engine scores — the LLM never grades prose into a win (asserted with a seeded fake).
- [ ] **Tally + tie-break:** most votes wins; a tie breaks to the **last-evicted juror** (reused 0014).
- [ ] **Vault-free:** the finale surface is **sentinel-clean** under a populated Vault (extend the 0001
      canary); no leans/tallies/manner leak before the reveal; `readsVault:false`; `npm run test:arch` green.
- [ ] **Persist + recall:** a finale in progress persists and resumes at the exact stage after a restart (0030).
- [ ] **Deterministic:** same seed + same player choices ⇒ identical finale and winner.
- [ ] Name-agnostic `.feature` (roles only — finalist/juror/evictee) added to `cucumber.cjs`; `npm test` green.

## 7. Dependencies & traceability

The **live realization of 0014** (jury & endgame), reusing `jury.ts` (`juryLean`/`castJuryVote`/
`finalePerformance`/`tallyJuryVote`/`runFinale`) and `season.tallyJury` (0005 tie-break) verbatim, wired
through the **0034** `advanceGame`/`submitDecision` seam, persisted by **0030**, under **0001** (Vault Wall),
**0002** (jury leans = relationship signals), and **0021** (isolation). Pairs with **B21/0018** (the lever
manifest must name the finale decisions). Front-end consumption (render statements/questions/reveal in
chat) is a small follow-up on the **0032** game build — the agent can already drive it through the tools.

## 8. Front-end UI (C11) — rendering the finale to the player

The engine + decision seam are **built and green**; what's missing is the player-facing **presentation**.
Today `advanceGame` returns the `finale-statement` / `finale-answer` / `juror-vote` decisions and a
`FinaleView`, but **nothing renders them** — the finale plays out only as chat-agent narration, with no
visual of the staged vote reveal. This is the **direct parallel to 0036's C10** (the social panel): a
self-contained, Vault-free, fail-open surface, built in the same patterns as `orwellStatusPanel.js` /
`orwellSocial.js`.

### 8.1 Small engine prerequisite — a Vault-free finale read (B-item)
`FinaleView` is currently only attached to `AdvanceView.finale` (returned by `advanceGame`), so a polling
panel can't read the staged finale without advancing. Promote the existing private
`GameSessionAdapter.finaleView()` to a **read tool** `finaleView(): FinaleView | null` on the `GameSession`
port + `PLAYER_TOOLS` + `McpServer` (`readsVault: false`; classified **infra**, like `gameStatus`/
`playerTagline`, so the lever-manifest drift guard doesn't require naming it). Sentinel-clean (extend the
0001 canary). It returns the **same Vault-free projection** already proven on `AdvanceView.finale`:
**names + current stage + the reveals SO FAR only** — never a lean, tally, eviction manner, or the
pre-reveal winner.

### 8.2 Front-end route
`GET /api/orwell/finale` → `{ finale: FinaleView | null }` (mirrors `/status`; an `orwell_engine.finale_view`
client method). **Fail-open:** `{ finale: null }` on any error — the page never blocks on it.

### 8.3 The finale panel (`orwellFinale.js`)
A self-contained polling panel (sibling to the status/social panels), shown **only while a finale is
staging** (`finale != null`):
- **Finalists** — the two finalist names, side by side.
- **Stage** — `statements | questions | vote | reveal` (a quiet header).
- **The vote reveal** — each `{ juror → finalist }` from `reveals[]` rendered **in reveal order, as they
  appear** (the drama). A running per-finalist tally of the **revealed** votes only — never a count of
  unrevealed jurors, never the winner before the reveals complete. On completion, `AdvanceView.winner`
  (the crown moment) lands through the normal advance.
- **The player's turn** — when `advanceGame` yields a finale decision, surface it the same way `orwellSocial`
  surfaces approaches (consistent + low-risk): a `finale-statement` offers a "make your case" composer
  prefill; a `finale-answer` shows the juror's question + the legal `appeals[]` as **composer-prefill
  shortcuts**; a `juror-vote` offers the two finalists. Binding submission still flows through the
  chat-agent `submitDecision` seam (as nominations/votes do today) — the panel only **presents** the legal
  options; the engine validates and scores (the prose/statement carries no score — anti-sycophancy).

### 8.4 Constraints (carry the engine's guarantees into the UI)
- **Vault-free:** render **only** the `FinaleView` / pending payloads; never a lean, tally, manner, or
  pre-reveal winner.
- **Fail-open:** finale read errors ⇒ hide the panel; never block the chat.
- **0032 keep-set:** a game surface, gated to a live finale; survives the prune; `orwellFinale.js` adds no
  new module deps (browser-smoke safe), script-tagged after the social panel.

### 8.5 Definition of Done (C11) — ✅ done (B26 + C11)
- [x] **Engine (B26):** `finaleView(): FinaleView | null` is a Vault-free player read tool (`PLAYER_TOOLS`,
      `McpServer`, classified **infra** so the lever-manifest drift guard doesn't require naming it); the
      B42 sentinel sweep covers it across the live finale; `npm run test:arch` green.
- [x] **Route:** `GET /api/orwell/finale` returns `{ finale: FinaleView | null }`, **fail-open** (`{finale:
      null}` on any error).
- [x] **Panel (`orwellFinale.js`):** during a finale it shows the finalists, the stage, and the **vote
      reveal in order** with a tally of the **revealed votes only** (no pre-reveal winner/tally); hidden
      otherwise. A self-contained, fail-open, draggable/minimizable sibling of `orwellSocial.js` (no new
      module deps; script-tagged after the social panel).
- [x] **Player decisions** (statement / answer-appeal / juror-vote) are surfaced as composer-prefill
      shortcuts (player-finalist → statement/appeals; player-juror → finalist vote); the binding submission
      still flows through the chat-agent `submitDecision` seam, which advances the staging.
- [x] Name-agnostic (roles only — finalist/juror); `python3 -m pytest tests/` green (184, +3 finale route);
      the 0032 headless-browser keep-set gate stays green (`orwellFinale.js` loads cleanly); engine gate
      unaffected (352 unit + 256 BDD).

> **Amended 2026-11-04 (BDD audit AMEND 0037, Ryne-approved; Sprint 2):** (1) the "jury management dominates" scenario now has explicit roles — the NPC finalist is the LEADER (strong accumulated relationships), the PLAYER is the UNDERDOG and plays EVERY legal appeal (incl. the engine's strongest, `bestAppeal`); the leader must win > 85% against each (the step used to play the weakest appeal as the leader); (2) the betrayed-vs-respected Then asserts a stated minimum gap (0.15 over 60 runs) instead of a bare `<`; (3) new scenario — a player-juror's vote card (`jurorBrief`) reflects only what their `askJuror` tellings surfaced: none before, exactly that telling after, never a fact a juror merely holds, a sealed `traitors-fury:blame` attribution, or a `told-by` fact that did not come through `askJuror`.
