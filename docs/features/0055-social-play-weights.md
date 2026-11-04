# 0055 — Social play MUST move the weights (the politics is the game)

**Status:** spec requirement (owner ruling, 2026-06-18). Extends the consequence loop (0023) /
relationship math (0026). Surfaced by live play-through: substantive social scenes were being
NARRATED but never RECORDED, so they folded zero impact into the hidden relationship model.

## The requirement (owner, verbatim spirit)

> Ongoing social play can change weights in the game engine — the roleplay/politicking
> **manipulates the outcome of the game**. That is a huge part of the game, if not most of it.
> Since Big Brother is politics, this game is politics. The ongoing social play and role-playing
> element **must have an impact on the weights/perceptions other houseguests hold, in relational
> ways** — and through those perceptions, on who wins comps thrown their way, who gets nominated,
> and who is voted out.

So: a conversation in which the player works an ally, reads a threat, makes a promise, plants a
seed, or burns a bridge is **not flavor** — it must move the directed, graded relationship beliefs
(trust / affinity / threat) the engine holds NPC→player and player→NPC, drift third-party reads
through gossip, and thereby bend the deterministic outcomes the engine computes. The change stays
**hidden** (Vault Wall): the player never sees a number, only the later behavior. That is the point
of the game (CLAUDE.md, "the consequence & memory loop").

## The mechanism already exists (0023) — the gap is reliability

`EngineCommandsAdapter.recordInteraction` already folds hidden impact into the relationship model
(`foldHiddenImpact(this.rel, …)`), `makeDeal` records binding promises, and `surfaceInformationTo`
moves a fact along its pathway. The weights→outcomes wiring (0006/0026/0028/0044) is built and green.

**The gap:** in live play the GM reliably **under-calls** these recording tools. It narrates a
real scene — the player builds a shield alliance, campaigns a veto holder — and logs NOTHING, so
the scene has **zero consequence and no memory**. This is the exact failure CLAUDE.md forbids
("never ship an action that is narrated but never recorded"), and it is the same class as the
advance-stall (the model knows the tool, the prompt instructs it, the model skips it).

## The fix — consequence-loop error-correction (mirrors the advance-nudge)

Per the owner's progression ruling (engine error-correction in the loop, not engine-authored
content): when a LIVE-game turn is **substantive social play that engaged a houseguest** and the
model narrated a scene but fired **no** recording tool (`recordInteraction` / `makeDeal` /
`surfaceInformationTo`), nudge the model in-loop to log the scene so its impact folds — gentle
first, escalating across turns, capped, tunable. Plus a prompt reinforcement that recording a
player↔houseguest scene is **not optional**: a scene the engine never received cannot change a
single mind.

Complementary to the advance-nudge by design:
- a **lull** + an advance-phase + no progress → *advance* the beat (seize the moment);
- **engagement** + a houseguest scene + no record → *record* the scene (bank the consequence).

## Status / diagnosis (2026-06-18 play-through)

- The mechanism is built (0023): recordInteraction → `foldHiddenImpact` moves the weights; the
  schema lets the model PROPOSE a `kind` (bonding/betrayal/conflict/strategy/alliance/gossip/
  showmance) and the engine owns the magnitude. **Ceremony/vote/off-screen beats already fold
  automatically** (engine-driven), so the relationship model DOES evolve over a season.
- The gap is **specifically the player's ad-hoc social scenes**: across ~6 substantive scenes the
  GM (deepseek-v4-pro) called recordInteraction **zero** times, even under a forceful nudge — it
  avoids the tool entirely (not an args failure). So a player can "build an alliance" in chat with
  no weight movement at all.
- **FIX SHIPPED — FE-guaranteed auto-record (`_auto_record_scene`, agent_loop.py).** A prompt nudge
  proved insufficient (the model avoids the tool), so the front-end now GUARANTEES the fold: when a
  live-game turn was an engaged player↔houseguest scene (engagement, not a lull, not a beat-advance)
  and the model recorded nothing, the FE makes a separate CONSTRAINED EXTRACTION call that returns
  ONLY `{withIds, kind, content}` (the model proposes a direction-correct `kind`; the engine owns the
  magnitude), validates the ids against the roster, and calls recordInteraction itself. Model-driven
  recording always takes precedence (a fired record tool suppresses the auto path). The recording is
  invisible to the player (hidden weights — Vault Wall intact). Verified live: a bonding scene with a
  houseguest auto-recorded `{withIds:[npc], kind:bonding}` and folded. Robustness notes: the extract
  call gives reasoning models headroom (max_tokens) and scans the whole response for the answer JSON,
  since an early/stripped parse returned empty on deepseek-v4-pro.

## Testability

- Unit/source-pin: the recording-tool set, the substantive-engagement gate (the inverse of the
  lull gate), the cap + cross-turn escalation, and the reset-on-record.
- Behavioral (play-through harness): a substantive player↔NPC scene results in a recordInteraction
  (or makeDeal) call, and a follow-up read of that NPC reflects the moved belief in BEHAVIOR
  (never a number) — e.g. the ally later acts on the bond, the burned bridge later bites.
- Vault-Wall: the fold stays hidden; no number or secret crosses to the player surface (the
  2026-06-18 Vault-leak audit confirmed the boundary is clean — keep it so).

## Amendment (2026-11-04, AMEND 0012/0055/0023 #4): forced-advance banking and the "talk still counts" rule

- **#1959 (forced-advance banking).** When the FE's belt FORCES an `advanceGame` (the L39b forced-advance rung), the turn's scene is banked through `_bank_scene_consequences` regardless of the lull gate - a forced advance used to skip the auto-record belt and lose the scene's only consequence fold.
- **Idempotency.** `_bank_scene_consequences` is idempotent: a scene the model already recorded (`_recorded`) or that the per-turn nudge cap already covered is never folded twice, and a deal/confide/expose/trade back-fill still runs first.
- **The rule (Ryne 2026-11-04):** *any real talk counts, whoever advances.* A message that carries a real player<->houseguest talk AND a readiness cue ("...let's move on") is still banked; a turn that also advanced (the model's `advanceGame`/`submitDecision`, or a pre-resolve) is banked like any other. The constrained extraction decides whether anyone was genuinely engaged (a comp-resolution turn with no real scene returns `{withIds: []}` and records nothing). Built as P4e (#2093); the real-loop tests cover chat+advance = one fold, chat+nothing = one, solo = none, already-recorded = none extra.
