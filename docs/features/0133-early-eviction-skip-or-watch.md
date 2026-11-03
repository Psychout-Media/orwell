# 0133 — Early eviction: skip to the finale or watch the skeleton season, and still be in the finale

> **Status:** ✅ **Built** (2026-11-03, #1986; engine + FE card). **Amends 0046** (player eviction & the juror's seat) for the
> **pre-jury** path, and shares its spectator machinery with the player-as-juror work (A-13).
> **PO ruling (Ryne, 2026-11-03):** when the player is evicted before the jury forms, offer BOTH a **skip to
> the season-finale reveal** and a **keep-watching** option; "watch" is a deliberately **skeleton** version of
> the rest of the season (condensed weekly beats, not a full click-through); and **either way** the evicted
> player still takes part in the finale — at minimum an interview.
> **Executable spec:** [`0133-early-eviction-skip-or-watch.feature`](./0133-early-eviction-skip-or-watch.feature)
> (wired into `cucumber.cjs`).

## 1. Summary

Today a pre-jury eviction ends the player's experience at the goodbye (0046 `player.status = "evicted"`,
`moment = "evicted"`; 0130's exit interview is the last beat). The narrator "may recap if they want to watch",
but nothing structural lets the player choose, nothing paces the rest of the season, and the player has no
part in the finale. Losing early is the **most common ending**; it should feel like *Big Brother*: you leave,
you choose how to follow the rest, and you are back on stage for the finale.

## 2. Scope

**In:** the **spectator choice** (`skip` | `watch`), the **condensed weekly digest** ("watch"), the
**fast-forward to the finale** ("skip"), the **finale-night interview** for a pre-jury evictee, and the
Vault/recording guarantees for all three.

**Out:** offering skip/watch to **jurors** (held for the PO — it may conflict with the "jurors experience the sequestered jury house" ruling); the sequestered **jury house** and the juror's own experience through the finale vote (A-13, built on
the same machinery); the self-evicted (0061) forfeit stays terminal and gets **no** choice or finale slot;
changing how NPCs are evicted or how the season is simulated.

## 3. Design

- **State.** `LiveSeasonState.spectator?: { mode: "watch" | "skip"; sinceWeek: number }`, set when the player
  answers the choice. Persisted in the snapshot; absent for an active player.
- **`spectator-choice` decision** (card-only kind — see the 2026-11-03 PO log: new kinds are card-only by
  default). Raised once, right after the pre-jury evictee's goodbye / exit interview (0130). Answers:
  `{ kind: "spectator-choice", vote: "watch" | "skip" }` (the shared single-pick field `vote`, not a `mode` field). A **watch → skip**
  switch is allowed at any later week through the same decision kind; **skip is irreversible**: a later `watch` after `skip` is refused with a typed
  `EngineRefusal` (a clear reason the narrator can voice), never a silent no-op, and the state is unchanged.
- **Watch = the skeleton season.** The engine, not the model, runs the player-less weeks. Each completed week
  produces ONE `week-digest` carried on the view (`weekDigests`): HOH, nominees, veto holder and whether it was
  used, who left, and the new jury size — **public broadcast facts only** (the same set a sequestered juror
  sees under 0046). The digest lives in `live.weekDigests` (persisted season state), **not** an EventStore event: it is a public
  projection of the already-recorded ceremony beats, so nothing is narrated that is not recorded. The narrator voices it in a few lines; it never adds a result.
- **Skip = the same fast-forward, run to the finale in one commit.** It returns the list of skipped weeks'
  digests (so a recap is one read away) and lands at the finale reveal.
- **Determinism (calibration-neutral).** The player has no decisions in either mode, so the NPC-only path draws
  **exactly the RNG it draws today**. No new rng, no new seeded state: `watch`, `skip` and the pre-feature
  behavior produce the same evictions, finalists, jury and **winner** for a seed (pinned by a test).
- **Finale participation — the finale-night interview.** Once the jury has voted and the winner is crowned, a
  pre-jury evictee gets a `finale-interview` pending (card-only): `stance` (`gracious | defiant | bitter`, the 0130
  shape) plus optional `words`. It is raised **after the crowning is recorded** (the season is already finished),
  so it can never move a vote or the winner and **cannot block the crowning**: `advanceGame` is a no-op once the
  season is finished, an unanswered card simply stays open, and a late answer is still accepted and recorded. The
  answer is recorded as a **witnessed public event**, voiced in the reunion beat, and carried into the 0048
  retrospective. This is the **finale-night** interview, separate from the 0130 **eviction-night** exit interview
  (the existing post-eviction beat), which still happens at the eviction.
- **Vault Wall.** The digest and the skip summary come from the public ceremony record. The hidden story stays
  sealed until the crowning (0048 unsealing is unchanged and is the only door). The 0001 canary is extended to
  the spectator, digest and finale-interview projections.
- **Narrator.** `MOMENT_PROMPTS.evicted` is rewritten around the choice: present the card and wait; in watch
  mode voice the engine's digests (never invent results); at the finale host the interview.

## 4. Contracts (stack-agnostic)

```
GameStateView += player.spectator?: "watch"|"skip", weekDigests?: WeekDigestView[]      // Vault-free, public facts only
PendingDecisionView.kind += "spectator-choice" | "finale-interview"
SubmitDecisionReq += { kind: "spectator-choice", vote: "watch"|"skip" } | { kind: "finale-interview", stance, words? }
advanceGame (spectator active) → runs one WHOLE player-less week, returns its digest;  skip → runs to the finale
```

## 5. Definition of Done

- [x] A pre-jury eviction raises the `spectator-choice` card; `watch` and `skip` both complete the season.
- [x] `watch` yields one public `week-digest` per EVICTION NIGHT after the player's own (a double-eviction week has two rows with the same week number); `skip` lands at the finale with the `skip` lands at the finale with the
      digests available.
- [x] Same seed ⇒ same evictions, finalists, jury and winner across {watch, skip, pre-feature}.
- [x] Both modes end in a `finale-interview` raised after the crowning; the answer is recorded, voiced, in the
      retrospective, moves no vote, and an unanswered card never blocks anything.
- [x] A self-evicted player gets none of it (0061 forfeit unchanged).
- [x] Vault canary green for the new projections; no hidden story before the crowning.
- [x] FE: the two new kinds have decision cards; `DECISION_KINDS` and the card-only gate (A-6) cover them.
