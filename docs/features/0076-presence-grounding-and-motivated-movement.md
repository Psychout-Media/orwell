# 0076 — Presence grounding & motivated movement (the narrator stops inventing the room)

> **Status:** 🟢 **Built** (drafted 2026-06-22; shipped in increments, PR #515 and after). **What shipped:**
> (1) **the churn fix** — engine, `PRESENCE.companionMoveProb`: present company HOLDS the player's
> scene (was the 0.6/turn reroll), calibration-safe (weighted stream only); (2) **the occupancy feed**
> was found to ALREADY ship — `momentPrompts.renderGameContext` pushes the full `present` +
> adjacent-room occupancy every turn with binding "voice EXACTLY these, never invent" instructions;
> (3) **narrated departures** — FE, `_render_presence_movement`: NPC arrivals/departures in the
> player's room are voiced as beats, no more silent pop-outs; (4) **the presence/identity desync
> guard** — FE, `record_post_turn_presence_check`: a high-precision, post-turn, prose-untouching
> re-ground when the narration STAGES an off-scene or evicted houseguest as acting in the scene (the
> "teleport/invented room" class), gated to skip player-move turns, combining with the board guard.
> **Gates are unit + FE tests, NOT Gherkin:** engine `tests/unit/presence.test.ts` +
> `tests/unit/locationGrounding0009.test.ts` (Vitest); front-end
> `frontend/tests/test_0076_presence_desync.py`, `test_0076_presence_movement.py`,
> `test_a2_presence_wall.py` (pytest). The sibling
> [`.feature`](./0076-presence-grounding-and-motivated-movement.feature) is a **design contract**
> (spec-only, deliberately NOT wired into `cucumber.cjs`; its header names those same gates).
> **Depends on:** 0049 (house presence & lingering —
> `presence.ts`, the floor plan, `whereabouts`), 0002 (events/pathways — a move is a recorded
> happening), 0065 (the LLM↔engine sync spine — the delta-state feed + the pre-emission desync
> guard this generalizes), 0023 (consequence fold — a motivated exit can carry one). **Supersedes
> the open remainder of** ledger **L21/L24** (whereabouts cohesion / cross-message scene
> discontinuity — marked ☑ but regressed; see `docs/audits/2026-06-19-live-debug-issues.md`).
> **Frames** the follow-on `docs/audits/2026-06-22-closed-set-grounding-audit.md`.

> **Owner direction (2026-06-22, this session):**
> 1. *"I don't love a hard pinning… there should be some element that a player could get up and
>    leave. I want a realistic pathway for houseguests to leave my location and have the same agency
>    I have. But feeling based in realism."* → **no freeze; motivated, narrated departures.**
> 2. *"I don't necessarily want this fix only attached to the premiere… this seems like a challenge
>    for the entire season."* → **season-wide grounding, not a premiere patch.**
> 3. *"How are we to put guardrails on the LLM without completely compromising its ability to
>    storytell?"* → **guard the closed-set FACT, never the open-set prose** (ADR 0005). This spec is
>    the worked example; the audit doc generalizes it.

## The bug, precisely

A live move-in transcript (2026-06-22): turn 1 the narrator sets the scene — *Bedroom A: Abby +
Elias; Bedroom B: Ana + Connor; living room: Kendall, Maria, Layla*. The player walks into Bedroom
A. Turn 2 the room holds *Elias, Nia, Ana, Kendall* — **Ana and Connor crossed from Bedroom B, Nia
appeared from nowhere, Kendall walked in from the living room, Abby vanished.** The engine floor
plan makes most of this impossible (`bedroom-a`/`bedroom-b` are not adjacent — `house.ts`
`HOUSE_ADJACENCY`; `occupancyViolations` flags any non-adjacent teleport), so the moves **did not
come from the engine**. The narrator invented the room population, turn after turn, only loosely
anchored to the engine's real (and different) seeded occupancy — and once the player committed to a
room and `moveTo` returned the engine's *actual* `present` set, the invented and real pictures
collided and half-merged.

Two distinct, compounding defects:

- **(A) Invented presence (the acute one).** The model narrates *who is in the room* and *who
  exists* without grounding to `whereabouts` — a **closed-set fact** (spatial truth + roster)
  authored by the open set. This is the L21/L24 family, regressed.
- **(B) Stochastic churn (the chronic one).** `presenceTick` fires **once per player turn** —
  including pure conversation turns — at `PRESENCE.moveProb = 0.6`, so even a correctly-grounded
  room reshuffles ~60% of its NPCs every message, silently and without narration. People blink out
  and reappear with no in-fiction reason.

## The principle (so this isn't whack-a-mole) — ADR 0005

Authority splits by **openness**, not layer. *Where a houseguest is* and *who exists* are
**closed-set facts**: one right answer, engine-owned, the model must never author them. *How a
scene feels, a glance, a line's delivery, the texture of a room* is the **open set**: the model
invents it freely and the engine never normalizes it (the `expressiveNonCollapse` gate). This
feature gives presence the **same two things outcomes already have** (0065) and knowledge already
has (the knowledge-bounded `npcVoice`):

1. **Feed, don't constrain** — hand the model the live occupancy every turn so it never *needs* to
   invent it. (You can't fabricate what you're fed the truth of — the `npcVoice` lesson.)
2. **Reconcile, don't pre-censor** — a closed-set-only desync guard catches a room/roster
   contradiction *before the player sees it*, mirroring the 0065 pre-emission board guard and the
   ADR-0005 desync guard that *"may fire only on closed-set board claims, never on creative prose."*
   It touches the model's **claims about facts**, never a word of its prose.

## The mechanic

### 1. Season-wide occupancy feed (fixes A)

Every turn's GAME CONTEXT carries the player's grounded `whereabouts` — their room, who is *present*
with them, and the adjacent rooms + who is in them (the existing `{ room, present, nearby }`
projection, the L26 shape) — delivered through the **0065 delta-state feed** so it is `O(Δ)` and
always current. The moment prompt's existing *"call whereabouts first so it is the real occupancy"*
becomes a standing, every-scene contract, not a wander-beat aside: **the people in the scene are the
people the feed names — never invent a houseguest into the room, never silently drop one, never move
one the engine hasn't moved.** Identity is part of the same fact: the only houseguests who can be in
the room are living cast members the roster knows.

### 2. Motivated, narrated departures — agency, not a freeze (fixes B; owner edit #1)

Replace the per-turn stochastic reroll with **reason-driven movement**:

- **Default stay for present company.** A houseguest in the player's current scene does **not**
  relocate on a bare conversation turn. The scene holds — no silent churn.
- **But they can leave, with the same agency the player has — for a reason, voiced as a beat.** A
  houseguest departs when a *motive* fires: summoned (Diary Room, a ceremony, production), pulled
  (a stronger bond beckons from elsewhere, a soul-goal/strategy tug — read off 0017/0041), or the
  scene has *run its course for them* (low remaining engagement on their side). When one leaves it
  is **narrated as an exit** ("\<name\> pushes off the bunk — 'gonna go find food' — and ducks out")
  and **recorded** (a real `moveTo`-equivalent for the NPC; their position updates, persists, and
  may fold a small 0023 consequence). The model voices *how* they leave (open set); the engine
  decides *that* they leave and *to where* (closed set). Either side may originate it — the engine
  proposes a motivated exit in the feed, or the model narrates a natural one and the engine records
  it — but the result is always a **recorded, adjacency-legal, voiced** move, never a teleport and
  never a silent pop-out.
- **Rooms the player is NOT in still drift** on the off-screen cadence (the house lives) — that
  movement was never the immersion problem; it is unobserved and only matters when the player
  arrives. The churn fix is scoped to *observed* company.
- **Cadence + rate.** Movement is gated on a **beat/lull** signal (the same "seize the lull" pacing
  the progression nudge reads), not on every message, and the base `PRESENCE.moveProb` is retuned
  for that cadence (0.6 was tuned as if a tick were a chunk of house-time; at message cadence it is
  far too high). All magnitudes stay in `presenceConstants.ts`.

> **Calibration guard (the L21/L24 lesson — read before touching the tick).** The off-screen
> society pairs *co-present* NPCs, so the **base** occupancy is calibration-load-bearing and draws
> from the shared seeded stream; the **player-facing** positions ride the dedicated `presence-move`
> stream. This feature's retune/gating MUST stay on the player-facing (weighted) view + its
> dedicated stream and leave the base draw-count byte-identical — or `tests/property/juryReach`
> breaks (it has twice). The new tests assert that isolation explicitly.

> **Note on the desync guard (the remaining "reconcile" half) — a deliberate sequencing call.**
> The 0065 board guard works because closed-set *outcomes* (HOH/noms/veto/eviction) have **crisp
> textual claim patterns** ("X is evicted", "wins HOH", an "N–M" tally) that a narrow regex catches
> with near-zero false positives. **Presence claims in prose are diffuse** ("Ana leans against the
> window") with no such anchor, so a naive scan would either nag the model on clean turns or miss.
> The safe form is the *post-turn re-ground* mechanism (`record_post_turn_desync_check` →
> `_DESYNC_REGROUND`, never editing live prose) extended with a **high-precision** trigger — e.g. a
> houseguest given a *spoken line / scene action* whom the engine places in a **non-adjacent** room
> or as **evicted** (a hard contradiction). This is being built carefully with the Bedroom-A
> transcript as its fixture, *after* the lower-risk feed/churn/departure increments above (which
> already remove the dominant turn-to-turn reshuffle), so the guard is precise rather than rushed.

### 3. The presence/identity desync guard (closed-set only; owner edit #3 → the principle)

A pre-emission guard, sibling to the 0065 board guard, runs over the assembled narration *before the
player sees it* and checks only **closed-set spatial/roster claims** against the engine truth:

- a houseguest narrated as *present* whom the feed places elsewhere (or evicted, or not in the cast);
- a houseguest narrated as having *moved* in a way the engine didn't record / adjacency forbids.

On a hit it **error-corrects the fact** — the FE belt records the legitimate `moveTo` (the
`_auto_move_player` pattern, extended to NPCs) or re-grounds to the feed — and **never edits the
prose's voice.** It fires *only* on closed-set contradictions; the `expressiveNonCollapse` /
no-prose-normalization invariant is the permanent counter-gate (a guard that touched flavor would
fail it).

## Why this is the worked example, not the whole job

Presence is one **closed-set fact** that was left in the open set's hands; outcomes (0065) and
knowledge (`npcVoice`) already got feed-and-reconcile, presence didn't. The systemic move — so the
*next* one of these is found before it ships live — is to enumerate the closed set once and confirm
each member has a feed + a reconcile path. That is `docs/audits/2026-06-22-closed-set-grounding-audit.md`
(this spec closes the presence + roster rows; the audit tracks the rest).

## Testability (role-only; HARD rules)

- **No invented presence:** a scene narrated against a known occupancy never names a houseguest the
  feed doesn't place in (or adjacent to) the room; never drops one silently; the regression fixture
  reproduces the **Bedroom-A teleport** (a non-adjacent cross + a from-nowhere arrival) and the
  guard catches it before emission.
- **Motivated departures, not churn:** across a continuous multi-turn scene with no precipitating
  motive, present company stays; when a motive fires, the houseguest leaves to an **adjacent** room,
  the move is **recorded + persisted**, and an exit beat is present (never a silent disappearance).
  No teleports (`occupancyViolations` clean across the season).
- **Agency parity:** an NPC can leave the player's room on their own motive on a turn the player
  did not initiate movement — the player is not uniquely able to end a scene by leaving.
- **Closed-set-only guard:** the desync guard fires on a spatial/roster contradiction and is inert
  on pure flavor; `expressiveNonCollapse` + the FE expressive gate stay green (the guard never
  normalizes prose).
- **Calibration isolation:** retuning/gating leaves the shared-stream base occupancy draw-count
  byte-identical (`movementStreamIsolation`) and `juryReach` green.
- **Season-wide:** the grounding contract holds at the premiere AND mid-season (not a premiere-only
  patch) — assert on a premiere scene and a Final-N scene.
- **Determinism:** seeded — same seed + history ⇒ same departures + destinations.

## Open questions / defaults (resolve at build)

1. **`moveProb` retune target** — pick against the UAT once the lull-gating lands; start materially
   below 0.6 for observed rooms (the unobserved off-screen drift can stay livelier).
2. **Who originates a departure** — default: the engine proposes motivated exits in the feed; the
   model may also narrate a natural one, which the FE belt records. Both converge on a recorded move.
3. **Departure motive set** — start with {summoned, stronger-bond-beckons, scene-ran-its-course};
   widen from live feel.
