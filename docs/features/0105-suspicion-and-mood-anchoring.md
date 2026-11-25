# 0105 — Drive-anchored suspicion (the wary read behind the sealed plan)

> **Status:** ✅ **BUILT** (2026-06-25 — `src/engine/suspicion.ts` `driveSuspicion`, wired into
> `GameSessionAdapter.npcVoice.suspects` behind the live drive layer; a mood-consumer lever note in
> `momentPrompts.ts`; gated by `tests/unit/suspicion0105.test.ts` + BDD
> `0105-suspicion-and-mood-anchoring.feature`).
> **Gate:** engine (Vitest + dependency-cruiser + BDD). **Depends on:** 0086 (the `Drive` whose
> threat-read this surfaces), 0084 (the `mood` this anchors), 0002 (the `suspects` knowledge channel it
> rides). **Vault Wall (mandate #2):** the drive's PLAN stays sealed — only the houseguest's own
> subjective threat-read surfaces, framed as a behavioral hunch on their OWN voice channel, never a
> number, never the campaign, never a stated motive.

## The problem (from the post-0085 diagnostic, picked up after 0086)

The full-season diagnostic flagged two thin spots that 0086 deliberately left as follow-on, because it
first needed to build the *anchor*: houseguests read as **generically "on edge" with nothing specific to
be on edge about**, and they **never *suspect* anyone**. The `npcVoice.suspects` field existed but was
**empty in live play** — the only thing that ever populated it was the un-anchored
`surfaceInformationTo` downgrade (a rumor with no real source). Nothing *proactively* gave a houseguest a
suspicion. So the narrator had a `mood` word (0084) but no **subject** for it — "on edge" with no *who*.

0086 fixed the root: every houseguest now carries a **drive** with a `target` (a rival they read as a
threat) or a `self-preserve` posture (a danger they're watching). That read is exactly the missing
subject — this feature surfaces it.

## The core idea — the plan is sealed, the *read* is the houseguest's own

A drive is two things: a **plan** (lobby, position, tilt the vote — sealed engine machinery) and the
**threat-read that motivates it** (this person is dangerous to my game). The plan is Vault state. The
read is the houseguest's own subjective opinion — and a houseguest acts their opinions out. Surfacing
the *read* (never the plan) is precisely 0086 ruling #2: **drives surface subtly, through a wary tone,
never as data.**

So `npcVoice.suspects` gains, per active houseguest, **one drive-derived suspicion**: a behavioral hunch
naming the subject of their threat-read. The narrator now has, for each houseguest: their **mood**
(0084) *and* a **specific person that mood is about** (0105) — "on edge, and here's who about."

```
driveSuspicion(drive, subjectName) →
  target  (offensive read)  → "has been keeping a close eye on <name>"  | "has been quietly sizing up <name>"   (by intensity)
  self-preserve (defensive) → "has a wary feeling about <name>"        | "has been watching their back around <name>"
  build / lay-low / win-power → null   (warmth, lying low, ambition are not a wary read of a rival)
  no subject → null
```

`driveSuspicion` is a **pure leaf** (no id→name lookup, no Vault handle): the caller pre-resolves the
subject to a name. It emits **no number** and never the word campaign/intensity/motivation — only the
hunch an observer would infer from behavior anyway.

## Engine seams

- **`src/engine/suspicion.ts`** — `driveSuspicion(drive, subjectName)`: the pure map above. Threat-reading
  motivations only; a `FIXATED` intensity band picks the watchful-vs-fixated phrasing (a hunch, not a
  number). Deterministic.
- **`GameSessionAdapter.npcVoice`** — when building `suspects`, append the drive-derived hunch for the
  houseguest's own live drive (`this.drives.get(id)`), the subject resolved via `nameOf`. Present **only**
  for an ACTIVE houseguest with a live drive — so with `ORWELL_CAMPAIGNS` off there is **no drive ⇒ no
  hunch ⇒ a byte-identical projection**. The append is de-duped against the knowledge suspicions and rides
  the existing `VOICE_SUSPECTS_CAP`.
- **`src/engine/momentPrompts.ts`** — a mood-consumer lever note: a houseguest's `suspect` is often what a
  wary `mood` is ABOUT; let the two move **together in behavior** (a guarded glance, a clipped answer, an
  edge when that person is near), but never name the suspicion as a motive or state it as fact — it is
  their hunch to *act* on, the player's to *infer*. (Additive prose; the lever-manifest pins are untouched.)

## Testability (role-only; HARD rules)

- **A drive gives a specific suspicion:** a houseguest who reads a rival as a threat is voiced with a
  suspicion that **names that rival**; a safe, under-the-radar houseguest gets **none** (no manufactured
  paranoia).
- **Behavioral hunch, never the plan:** the suspicion string carries **no number**, no campaign, no
  intensity, no stated motive — asserted on the `suspects` projection.
- **Vault-sealed & symmetric:** the drive's plan/tilt never crosses; only the owner's own read, on the
  owner's own voice channel, as a hunch (the player infers; paranoia stays the human's to form, 0017/0020).
- **Calibration byte-identical when off:** with `ORWELL_CAMPAIGNS` unset there is no drive, so no
  drive-derived suspicion is surfaced and the seeded game is unchanged (the same guard 0086 holds).

## Out of scope (noted, not built here) (ORW-824)

- **`mayConfide` never firing (0075)** — a separate trigger-tuning item; not a drive consumer, left to its
  own pass.
- **Suspicion of being *targeted by* someone else** — that must arrive through a real pathway (gossip /
  overhear) and is already the `surfaceInformationTo` mechanism; 0105 surfaces only the houseguest's OWN
  read, which they self-evidently hold.
