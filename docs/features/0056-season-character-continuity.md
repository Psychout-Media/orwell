# 0056 — Season-to-season character continuity (the soft re-run of casting)

> **Status:** Engine carry-over **built** (TDD; the "keep" path + D1/R1 hinge reuse) and the FE
> **restart-door relay** threads `keepCharacter` through (`/new-game` + `orwell_engine.create_character`;
> `playerName` optional when keeping). The in-chat **keep/recreate UX** + the per-season **portrait**
> keep/upload toggle (§4) **shipped via 0057 chunk 3** — the persistent post-season "New season"
> surface (`frontend/static/js/orwellNewSeason.js`) is the keep/recreate choice + the shared G26/G27
> portrait studio; it routes "keep" through `POST /api/orwell/next-season {keep:true}`. Extends
> **0050** (the casting interview) and the **one
> sanctioned restart door** (audit D1/R1) so that starting a **new season** offers the player a
> **soft re-run of character creation**: **keep the existing houseguest** (the same person
> returns to a brand-new cast) or **recreate** (run the casting interview again from scratch),
> with the **profile picture** kept / re-uploaded / regenerated per season. Pairs with the
> post-season guard from **0055 / audit R4-04/R4-05** (a new season starts only through the
> sanctioned door — never improvised in-chat).
>
> **Gate:** the engine carry-over is **unit-gated** (`tests/unit/seasonContinuity.test.ts`),
> following the 0054/0055 convention (no standalone `.feature`); the §5 invariants are the
> assertions there. The FE choice + per-season portrait (§4) land FE-side with pytest coverage.

## 1. Summary

A season ends; the player wants to play again. Today the only way to start season 2 is a
confirmed restart that **always re-runs casting from zero** — there is no way to bring the same
houseguest back. Real returning-player seasons are a staple of the format, and a player who
invested a backstory and a persona shouldn't have to retype it to play another season.

So the **new-season hand-off offers a choice**:

- **Keep the existing character.** The same houseguest walks back into a **brand-new house**. Their
  **static `CHARACTER` is carried over byte-for-byte** — name, archetype, strategy, the authored
  persona/backstory/motivation/private-strategy, the seeded appearance, and (engine-side, never
  shown) the balanced hidden aptitudes. Only the **cast changes** (a new seed → new NPCs), and the
  **dynamic `SOUL`/relationships reset** to a fresh move-in (it is a new game with new people — the
  returning player carries their *self*, not last season's grudges).
- **Recreate.** The **casting interview runs again** from a clean slate (0050), producing a new
  character exactly as a first-time OOBE would.

Either way a **new profile picture** may be kept, uploaded, or regenerated for the new season
(0051 lane; FE-owned image provider).

This is **not a new restart path** (audit D1/R1 forbids a second door): both choices route through
the **one sanctioned hinge** — `registry.resetUser` → `Orchestrator.forgetUser` + save-dir rotation
— exactly as the admin reset and the confirmed player restart already do. The choice only decides
**what the fresh sandbox is seeded with**: the carried-over character (keep) or an empty casting
intake (recreate).

## 2. Why "keep" is byte-faithful and cheap

The player's static `CHARACTER` is, by construction (0015/0050, `characterFactory.runPlayerOOBE`),
a **pure function of their authored fields** — it does **not** depend on the game seed:

- aptitudes are `spec.bias` for the authored archetype (fixed; the player never min-maxes past the
  NPC bounds, 0006 anti-sycophancy),
- the public appearance is **not** seeded from the name or the game seed: the human authors no look, so `appearance` stays empty (no name-hash, #529) and the portrait is never improvised from one (corrected 2026-11-12, ORW-286 item 8),
- a returning player's **season notoriety** (0104; Vault-free, derived by the registry from the prior seasons' open-set outcome records) is carried into the new season separately from the authored fields; it is not part of the static `CHARACTER` and never a number to the player,
- persona / backstory / motivation / private-strategy / interview notes are the authored material.

Only the **NPC cast** consumes the game seed. Therefore "keep" needs **no special character
storage**: the engine simply **re-supplies the prior player's authored fields** to the new
season's `createCharacter` with a **fresh seed**, and the identical static `CHARACTER`
regenerates while a different house is drawn. This is the non-degradation guarantee (0007) read
across a **season boundary**: the carried `CHARACTER` is byte-stable; the `SOUL` starts fresh and
then deepens again.

## 3. The engine surface

- **`CreateCharacterReq.keepCharacter?: boolean`** — on a **confirmed restart** (`confirmRestart:
  true`) of an existing game, the engine captures the prior player's authored fields **before** the
  reset and merges them into the new season's creation (explicit `req` fields still override
  field-by-field, so the player may tweak on the way through — e.g. a new strategy for the new
  season — while keeping everything they don't touch). A fresh entropy **seed** is drawn unless one
  is given (a new cast; E39/D8). With `keepCharacter` **false/absent**, a confirmed restart behaves
  as today (the new season starts from whatever `req`/intake provides — i.e. a re-run interview).
- **Carry-over is `CHARACTER`-only.** The dynamic `SOUL` (emotional state, accumulated memory,
  relationship beliefs) is **not** carried — the new season starts at move-in. The original
  **casting interview material** (motivation + interview notes) is reconstructed from the prior
  player so the new season's Soul memory re-seeds identically to a first run.
- **Recreate = reset to casting.** Choosing "recreate" resets the sandbox to a **pre-game** state
  (empty intake, no house) so the **casting interview re-runs** in-chat (0050). It uses the same
  `resetUser` hinge; it just does **not** immediately finalize a character.
- **No number crosses.** The carry-over moves only authored, Vault-free fields; the engine
  re-derives the hidden aptitudes. The new-season casting card is qualitative, as in 0050.

## 4. The experience (FE, ADR 0003 — in the chat, no modal)

At the **post-season** hand-off (0055 reunion moment), once the player signals they want to play
again, the producer asks the **keep-or-recreate** question **in the chat** and, on "keep", offers
to **refresh the cast photo** (keep last season's / upload a new one / regenerate). The FE drives
the choice to the engine: **keep** → `createCharacter({confirmRestart:true, keepCharacter:true})`
(optionally with tweaks); **recreate** → reset-to-casting, then the normal interview → finalize.
The **profile picture** is handled by the FE image pipeline (0051): keep the stored avatar, accept
an upload, or regenerate from the new season's portrait prompt.

The post-season prompt's existing guard (R4-04) stays intact: the model still must **not**
improvise a season — it routes the player through this sanctioned choice.

## 5. Invariants / what tests must show

- **Keep recreates the identical static `CHARACTER`** (archetype, balanced aptitudes, strategy,
  persona, backstory, motivation, private strategy, appearance) under a **new cast** (different
  NPCs), with the **`SOUL` reset** to move-in.
- **Carry-over across the season boundary does not degrade** the static `CHARACTER` (0007 read at
  the boundary): byte-stable identity; a fresh, then-deepening soul.
- **One hinge only** (D1/R1): both keep and recreate route through `resetUser`; season 2 commits
  clean and survives an engine restart; a refused commit throws typed (no second door).
- **No number crosses** on carry-over or in the new casting card.
- **Recreate** yields a genuinely fresh casting intake (the prior character is gone).
- **The post-season guard holds** (R4-04): a new season is reachable only through the sanctioned
  choice, never an improvised in-chat interview.
