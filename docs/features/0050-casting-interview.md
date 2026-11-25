# 0050 — The casting interview (producer-led character creation)

> **Status:** Built (see the [README status index](./README.md#index); spec drafted with the
> implementation). Evolves **0015** (the OOBE) from a form intake
> into a **conversation**: the model, in the producer's voice, conducts a fun "get to know the
> cast" interview that ends in the player's character type, strategy, and a qualitative read of
> their strengths — and seeds the prompt + datastore with the building blocks of who the player
> is coming into the game.
> **Executable spec:** [`0050-casting-interview.feature`](./0050-casting-interview.feature)

## 1. Summary

Character creation **is the game's first scene** (ADR 0003 — the conversation is the game). When
a player exists but no game has started, the chat itself becomes the **pre-season casting
interview**: Orwell speaks as the **producer** conducting a warm, fun, reality-TV intake — who
are you, what's your life outside, why Big Brother, how do you think you'll come across, how do
you actually plan to play. The producer **records each answer as it lands** (`updateCasting`);
the engine tracks which building blocks are in — OOBE can be none, half, or fully populated —
and that status determines the interview's **next step**. The interview **ends** with a
finalizing `createCharacter` call; the **engine** (never the model) derives the
canonical archetype-driven, balanced P/M/S aptitudes (0015 §5A unchanged) and returns a
**casting card** — character type, strategy style, and a producer's *qualitative* read of their
strengths. **No number ever crosses the wall.**

The interview's authored material does not evaporate: it seeds the **datastore** (the static
`Character` backstory, the player-only private strategy, and the player's `Soul` memory carries
the interview as their own pre-game memories) and the **prompt** (the player card the game
master voices all season).

## 2. Scope

**In:** the engine-managed **casting-interview moment prompt** (producer persona + interview
coverage + the canonical archetype/style **manifest** + the ending protocol + the live casting
status); the **incremental intake** (`updateCasting` + the engine-computed status that picks
the next step; durable pre-game state); the extended, finalize-from-intake `createCharacter`;
soul-memory seeding; the **casting card** projection; the front-end pre-game framing (inject
the interview prompt when the engine is up and no game is started) and the no-modal hand-off
(holding cards for genuine blockers only; the composer prefill seats the player).

**Out (unchanged):** stat derivation and the anti-sycophancy bound (**0015 §5A** — derived &
balanced, never allocated); NPC generation (**0004**); how NPCs learn about the player
(**0002**); the no-wipe restart guard (B36 — `createCharacter` on a started game stays a no-op).

## 3. The flow (incremental — OOBE can be half-done)

OOBE is **not one atomic call**. The producer records each answer **as it lands**; the engine
accumulates the building blocks, and its captured/missing status **determines the interview's
next step**. A half-done interview is durable state: it survives a restart and resumes where it
left off (the producer never re-asks what's on file).

```
no game started
  → the chat's system prompt IS the casting-interview moment (producer persona, OOC),
    carrying the live CASTING STATUS: what's on file, what's missing, the engine's next step
  → the producer interviews the player, a question or two at a time (their words, their pace),
    and files each answer the moment it lands:
       updateCasting({ any subset of: playerName, backstory, motivation,
                       personaArchetype/personaStrategyStyle (their OWN words),
                       privateStrategy, interviewNotes[] (append-only),
                       archetype/strategyStyle (the producer's canonical mapping) })
         → returns { known, missing, next, ready }   # the ENGINE picks the next step
  → … the interview may pause here, half-done — the intake persists (0030) and the next
    session's prompt shows what's already on file …
  → when ready (a name is on file) and the picture is complete, the producer finalizes:
       createCharacter()        # uses everything recorded; args may fill gaps or override
  → the ENGINE validates, derives balanced stats from the canonical archetype (0015 §5A),
    seeds the Soul memory with the interview, casts the house around the player (0004)
  → the creation return carries the CASTING CARD: character type, strategy style,
    qualitative strength reads (words, never numbers), their story & motivation
  → the producer reveals the card in voice — "here's who walked into the house" — and the
    premiere begins.
```

A `createCharacter` before any name is recorded is **rejected** (the engine, not the model,
gates the start); once a season exists, casting is **closed** and both tools **refuse honestly**
rather than no-op silently (audit R4-05): `updateCasting` returns `ready:false` with
`refused: "in-progress" | "over"`, and a `createCharacter` without `confirmRestart` returns the
prior season's view flagged `createRefused` — so the model can never read an unchanged view as a
fresh season (a new season starts only through the sanctioned restart door — the menu / a
confirmed restart). `updateCasting` also echoes any `ignoredKeys` it didn't understand (R4-01),
so an answer filed under the wrong field — `name` instead of `playerName` — is never silently lost.
There is **no separate data-entry surface**: every building block arrives through the
conversation (ADR 0003 — UI may augment the chat, never replace the interaction).

**OOC, witnessed by no one (0015 invariant kept):** the interview happens before the house is
cast. It produces **no witnessed event**; no NPC starts the game knowing anything said in it.
The player's `privateStrategy` and `motivation` stay player-only (`NO_NPC_PATHWAY`, 0013).

## 4. The interview manifest (anti-drift)

The model must map the player's free-text self-description onto the engine's **canonical**
archetypes and strategy styles — so the moment prompt embeds the manifest **generated from the
single source of truth** (`ARCHETYPES` in `characterFactory.ts`), never a hand-copied list.
A drift test asserts every canonical archetype and style appears in the interview prompt. The
player's own words are always preserved (`personaArchetype` / `personaStrategyStyle`) and are
what the narrative voices; the canonical mapping only drives hidden stats.

## 5. The casting card (the reveal — and the wall)

The user-facing payoff is "your stats, strategy and character type" — delivered **qualitatively**:

- `characterType` — the canonical archetype the engine accepted (their words shown alongside).
- `strategyStyle` — the canonical style.
- `strengths` — per-aptitude **tier words** (e.g. *standout / solid / scrappy*), derived from the
  same balanced stats that drive competitions. Words, never values: the numeric stats stay
  engine-side (mandate #2/#3; the player card already promises "NO numeric stats cross the wall").
- `story` / `motivation` — the player's own authored material, played back.

The card is part of the player's own `GameStateView.player`, so the producer can re-show it any
time; it carries nothing about any NPC.

## 6. Seeding the datastore (non-degradation, 0007)

- `backstory` → static `Character.background` (byte-stable for the save).
- `privateStrategy` → the player's authored hidden material (player-only; no NPC pathway).
- `motivation` + `interviewNotes[]` → the player's **`Soul.memory`** as their own pre-game
  memories (prefixed as interview material), so the house's long-term memory starts with who
  the player said they were — recallable, persisted, and a **superset base** for everything the
  season adds. Snapshot round-trip must retain every field (0030).

## 7. Contracts (delta over 0015/0019)

```
updateCasting(req) -> CastingStatusView          # NEW (incremental intake)
  # req: any subset of { playerName, archetype, strategyStyle, personaArchetype,
  #                      personaStrategyStyle, backstory, motivation, privateStrategy,
  #                      interviewNotes[] (append-only) }
  # -> { known: {field: value}, missing: [field…], next: string|null, ready: bool }
  # callable any number of times pre-game; durable (SessionCore.casting, 0030);
  # no-op reporting done once the season starts

GameStateView (pre-game) +=
  casting: CastingStatusView                     # the prompt renders it (resume, next step)

CreateCharacterReq:                              # finalizes FROM the intake
  playerName?: string           # now optional — the recorded name suffices; one is REQUIRED
  backstory?: string            # → Character.background
  motivation?: string           # why they came — player-only, seeds Soul memory
  privateStrategy?: string      # how they actually plan to play — player-only (0013)
  interviewNotes?: string[]     # distilled get-to-know answers — seed Soul memory
  personaArchetype?: string     # the player's OWN words (display/narrative)
  personaStrategyStyle?: string

GameStateView.player +=
  castingCard: {
    characterType, strategyStyle,            # canonical
    strengths: { physical, mental, social }, # TIER WORDS, never numbers
    story?, motivation?                      # the player's authored material
  }

MOMENT_PROMPTS["character-creation"]  → the full producer-interview operating manual
                                        (persona, coverage, manifest, ending protocol)
```

Front-end: `apply_game_framing` also injects the moment prompt when the engine is up and **no
game is started** (today the pre-game chat has no game framing at all — the reason creation was
a form); the onboarding overlay reduces to a **gate** ("the producers will see you now") that
opens the interview instead of collecting fields.

## 8. Test strategy

- **Interview prompt:** pre-game `getMomentPrompt` returns the producer-interview manual; the
  manifest contains **every** canonical archetype and style (drift test); the ending protocol
  names `createCharacter`.
- **Distillation:** an interview-shaped `createCharacter` (canonical mapping + own words +
  deepeners) yields stats within NPC bounds (0015 §5A holds); the player's own words survive on
  their card; an unknown archetype falls back exactly as 0015 does.
- **Casting card:** present on creation and on later reads; strengths are tier words; the
  serialized player-facing payload contains **no numeric stat** (sentinel scan).
- **Seeding:** backstory/motivation/notes persist; `Soul.memory` carries the interview; a
  snapshot round-trip (0030) retains all of it (superset).
- **OOC wall:** creation produces no witnessed event; no NPC knowledge at game start contains
  any interview material (extends 0015's DR-wall scenario).
- **No-wipe guard intact:** a second `createCharacter` with interview fields on a started game
  is still a no-op (B36).

## 9. Open evolution (expected — this mechanic will grow)

This is v1 of an evolving mechanic. Anticipated next steps (none block v1): richer derived
signals (the engine reading aptitude hints from interview answers rather than archetype alone —
must keep the §5A bound); NPC pre-game "casting tapes" the player can watch; producer callbacks
mid-season that reread the interview (built as the 0210 producer pushback, ORW-666) ("you said you'd never lie…"). Keep the distillation seam
(`CreateCharacterReq`) the single funnel so evolution stays engine-validated.

## 10. Definition of Done

- [ ] All scenarios pass, name-agnostic; `cucumber.cjs` lists the feature.
- [ ] Pre-game chat is the interview (FE injects the moment prompt; gate replaces the form).
- [ ] The casting card reveals type/strategy/strength **words** — no numbers anywhere player-facing.
- [ ] Interview material seeds Character/Soul and survives restart (0030 superset).
- [ ] 0015's invariants all still green (balanced bounds, OOC, no-carryover, no protection).
- [ ] FE tool schema's archetype enum matches the engine's canonical list (drift closed).

## 11. Dependencies

**0015** (the OOBE contract this evolves), **0018** (moment prompts), **0019** (agent tool
surface), **0004** (canonical archetypes), **0013** (player-only material), **0030** (durable
persistence), ADR **0003** (the conversation is the game).

## 12. Traceability

`docs/bb-sim-spec.md` §7 (OOBE); ADR 0003 ("UI may augment the chat but never replace an
interaction that builds the game" — character creation is exactly such an interaction);
mandate #2 (no numbers cross), #3 (engine decides), #4 (authored detail persists).

## Amendment (0065) — the cast photo is the FIRST casting step (photo-first OOBE)

> **Status:** Built. Engine + tests + this note (the FE Python relay and the in-chat photo box
> are sibling FE work to the same contract).

The casting interview now **opens on the cast photo** — "producers ask what you look like before
anything else." It is the engine's casting **step #1**: `castPhoto` is the **first entry of
`CASTING_COVERAGE`** (`src/engine/castingIntake.ts`), so on a fresh interview the casting status's
`next` (and `missing[0]`) points at the cast photo before the name or any other question. The
casting-interview moment prompt opens the producer on the 📷 panel accordingly (`momentPrompts.ts`).

- **Contract.** New scalar field `castPhoto` on `UpdateCastingReq` (camelCase string). The FE sets
  it when the in-chat photo box closes: `"uploaded"` (a cast photo was finalized) or `"skipped"`
  (the player declined). Any non-empty string marks the step **handled** (it leaves `missing` and
  `next` advances). It is an **ordinary scalar** — merge/overwrite/capture/status all flow it
  automatically (they iterate `CASTING_COVERAGE`); persistence rides the existing `casting` intake
  snapshot (no per-field plumbing).
- **Optional / skippable.** `castPhoto` does **NOT** gate casting `ready` (which stays **name-only**):
  the photo never blocks the interview or `createCharacter`, whether uploaded or skipped. Producers
  are told not to push past a clear "no" and to move on once it's handled.
- **Vault Wall.** `castPhoto` is the player's **own** metadata (what they look like) — Vault-free,
  never secret, no NPC pathway. It crosses no boundary it shouldn't (it rides the same Vault-free
  `UpdateCastingReq` every other casting field does; no allowlist/schema strips it — `updateCasting`
  takes the request wholesale and the MCP `requireShape` has no field allowlist for it).

## Amendment 2026-11-19: the producer asks the player's pronouns once (standing rule: ask, never assume)

- While the player's pronouns are not on file, the casting status carries `askPronouns` and the casting context gets one per-turn board line ("PRONOUNS: not on file"): the producer asks once, in its own voice, before it finalizes. No question text is authored by the engine.
- **Recorded as an engine fact.** The answer lands in `genderPresentation` (the same field as before; `view.player.genderPresentation` renders as the PRONOUN LOCK). A skip or "rather not say" is recorded as `unstated`: it counts as on file, so the ask ends for good, and the narrator keeps "address as you". `unstated` never reaches the character.
- **The front end records what the player said when the model did not file it** (`fill_stated_player_gender`): the player's own typed words are read by the closed detector in `orwell_player_gender.py`, on `updateCasting` and the `createCharacter` finalize. A model-filed gender that disagrees with the player's words stays dropped; a name never implies a gender.
- Never blocks casting: `ready`/`finalizable` are unchanged. Flag `ORWELL_CASTING_PRONOUN_ASK` (default ON; `=0` restores the old casting context byte for byte). Tests: `tests/unit/castingPronounAsk.test.ts`, `frontend/tests/test_orw476_player_gender_stated_only.py`.
