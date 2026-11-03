# 0115 — The Diary Room as a strategic confessional (narration grounding + weighted prompts + retrospective)

> **Status:** Built (BDD/TDD-first; BDD-gated in `cucumber.cjs`). Builds out **0036/0013**: the Diary Room exists and is walled, but
> writing in it does **nothing** — it's an expressive log with no mechanical teeth. This feature gives it
> three, all **player-facing**: (1) the player's DR intent **grounds the GM's narration** so the game
> narrates the player's *real* strategy (the irony of a lie) instead of sycophantically believing the
> player's public mask; (2) the producer's DR invitations become **pointed, beat-specific questions**; and
> (3) the player's confessionals resurface in the **post-season retrospective** (0048) as their side of the
> story. **The wall is the hard constraint and stays structural:** no houseguest ever learns DR content, and
> no NPC behavior is ever driven by it.
> **Executable spec:** [`0115-diary-room-strategic-confessional.feature`](./0115-diary-room-strategic-confessional.feature)
> **Also proven by:** `tests/unit/diaryRoomStrategic.test.ts`

## 1. Summary

The mandate's #3 (anti-sycophancy) says the LLM must narrate from ground truth, never "remember" and bend
to please. Today that protects against the *player* being flattered — but the GM still **believes the
player's own lies**: if the player publicly tells a houseguest "you're my ride-or-die" while privately
gunning for them, the narration echoes the friendship at face value. The Diary Room is where the player
records their *real* strategy — so it is the natural ground truth for the player's true intent. This feature
routes that truth to three **player-facing** surfaces while keeping the house deceived:

1. **Narration grounding (the core).** The player's recent DR intent rides into the narrator's GAME CONTEXT
   as a **PRIVATE steer** (`playerDiaryRoom`, rendered fenced): *you the GM know it, the houseguests do
   NOT — narrate the player's scenes with the irony of the mask, never voice it, never let a houseguest act
   on it.* The GM stops believing the player's public performance and narrates from their strategy.
2. **Weighted production prompts.** `producerPrompt(beat)` returns a **pointed, beat-specific question**
   (nomination / veto-ceremony / eviction / position-shift), not the generic `dramatic beat: X` label — a
   real confessional prompt the FE can voice at the dramatic beat.
3. **Retrospective through-line.** The post-season retrospective (0048) surfaces the player's DR entries as
   their **own confessional**, alongside the unsealed hidden truth — the player's side of the story.

## 2. The wall (the non-negotiable) — what stays structural vs. prompt-guided

> ⚠️ **KNOWN RISK — "POTENTIAL WALL LEAK" (owner-flagged, 2026-07-10).** The narration-grounding layer
> (row 3 below) is **prompt-guided, not a hard code wall** — it is the deliberate, accepted price of the
> GM knowing the player's real strategy. If a houseguest is ever seen *voicing or acting on* Diary-Room
> content in the future, **start debugging at the `⚠️ POTENTIAL WALL LEAK` marker in
> `src/engine/momentPrompts.ts` `renderGameContext`** (the one place DR is fed to the model), plus the FE
> reasoning/`npc:`-leak scrub — NOT the structural wall (rows 1–2), which is proven clean by
> `diaryRoomStrategic.test.ts` and the live sentinel sweep.


| Layer | Sees DR? | Enforcement |
|---|---|---|
| **NPC knowledge** (what any houseguest knows) | **Never** | **Structural** — `deriveNpcKnowledge` strips every `NO_NPC_PATHWAY` fact (0013, unchanged); DR events witness the player alone. |
| **NPC behavior** (votes, noms, approaches, gossip) | **Never** | **Structural** — NPC decisions read seeded rules + relationship state, which never contains DR; the per-NPC voicing projection (0036/B65) is built from NPC knowledge, never from `playerDiaryRoom`. |
| **The GM's narration *to the player*** (subtext, irony) | **Yes** | **Prompt-guided + tested** — `playerDiaryRoom` is fenced in the GAME CONTEXT as private/do-not-voice; the existing narrator anti-leak rule is strengthened; the reasoning/`npc:`-leak scrub still runs; a targeted test plants a DR secret and asserts no NPC line/knowledge echoes it. This layer is model-voiced prose, so it cannot be a hard code wall — but the thing that protects the player (the NPC staying deceived) is fully structural above. |

## 3. Scope

**In:**
- A Vault-free `playerDiaryRoom?: string[]` on `GameStateView` (most-recent-first, capped), sourced from the
  player's OWN `NO_NPC_PATHWAY` knowledge — **never a Vault read** (`readsVault: false` preserved).
- `renderGameContext` renders it as a fenced PRIVATE steer (mirrors the existing archetype "private voice
  cue" pattern); the base prompt's DR guidance is strengthened to name the mask/irony case.
- `producerPrompt(beat)` returns a beat-specific question (a small `DRAMATIC_PROMPTS` map); `diaryRoomInvite.reason`
  carries it.
- `RetrospectiveView` gains a `playerConfessionals: string[]` populated from the player's DR entries.

**Out:** the DR wall logic itself (0013 — reused, unchanged); NPC confessionals (Vault-only, never here);
letting DR touch NPC knowledge or behavior (**forbidden** — the whole point); a new UI (the 0036 DR panel +
the recap/retrospective surfaces already render these payloads; any polish is a small FE follow-up).

## 4. Contracts (stack-agnostic)

```
GameStateView.playerDiaryRoom?: string[]          // player's own DR intent, Vault-free, most-recent-first, capped; absent when empty
renderGameContext(view): string                   // renders playerDiaryRoom as a fenced PRIVATE, do-not-voice steer
producerPrompt(beat): { invite, reason? }         // reason is now a pointed beat-specific question (DRAMATIC_PROMPTS)
RetrospectiveView.playerConfessionals: string[]   // the player's DR entries, surfaced post-season (0048)
```

## 5. Definition of Done

- [x] **Grounding:** after the player records DR intent, `renderGameContext` contains it, **fenced as private
      / do-not-voice**; the base prompt names the mask-vs-truth case.
- [x] **Wall (structural):** a planted DR secret appears in `playerDiaryRoom` + the narration context + the
      retrospective, but in **no** NPC's knowledge and **no** per-NPC voicing projection; `deriveNpcKnowledge`
      still strips it; the live Vault-sentinel sweep stays green; `npm run test:arch` green.
- [x] **Weighted prompts:** dramatic beats yield a pointed, beat-specific question; routine beats still yield
      no invite.
- [x] **Retrospective:** the post-season retrospective returns the player's confessionals; null/empty while
      the season is live or when the player recorded none.
- [x] Name-agnostic tests (roles only); BDD-gated in `cucumber.cjs` (no repeat of 0036's E87a deviation);
      `npm test` green; heavy calibration sims **byte-identical** (DR never touches the seeded spine).

## 6. Dependencies & traceability

Builds out **0036** (the live DR tool) and **0013** (`recordDiaryRoom` / `NO_NPC_PATHWAY` — the wall,
reused unchanged), grounding the narrator (**0027**/momentPrompts) in the player's own strategy under
**0001** (Vault Wall), **0002** (knowledge pathways), and mandate #3 (anti-sycophancy). Surfaces through the
recap-adjacent narration and the **0048** retrospective. Vault-free by construction; never touches NPC
behavior, so the seeded calibration spine is untouched (byte-identical).
