# 0106 — Whole-house events are exclusive set-pieces

> **Status:** ✅ **BUILT** (2026-06-26 — `GameSessionAdapter.houseEventInSession` + the `houseEvent`
> block on `whereabouts`, a player-movement gate, and a narrator framing section in `momentPrompts.ts`;
> gated by `tests/unit/exclusiveComps0106.test.ts` + `leverManifest`). **Gate:** engine (Vitest +
> dependency-cruiser). **Calibration:** read-projection + a player-action gate only — the seeded sim is
> never touched, so `juryReach`/UAT are **byte-identical** (re-verified). **From:** playtest feedback
> (2026-06-26) — a competition that ran *while the player was in a side conversation*, with the HOH card
> popping into an unrelated scene and the narration then continuing as if nothing had happened.

## The problem (from playtesting)

A competition is supposed to be the show's centrepiece — the whole house gathered, everyone competing or
watching. In play it wasn't: the social/lingering loop (0049/0038) ran **straight through** the comp, so
the player was held in a one-on-one conversation *while competing*, and afterward the narration **resumed
the prior scene as if the comp had never interrupted it**. The immersion broke on three fronts: (1) the
comp wasn't exclusive (side scenes ran alongside it), (2) the decision card popped into an unrelated
moment, and (3) the before/after weren't segmented — the scene was stitched over the top of the event.

## Owner rulings (2026-06-26)

1. **Non-competitors are SPECTATORS** — present, watching, forming opinions as it goes; **the outgoing
   HOH is a spectator** (they sit out the next HOH).
2. **A card popping mid-scene is FINE** — if a comp/ceremony is set for "this afternoon," being pulled
   into it at any point that day is expected; the interruption itself is not the problem.
3. **Do NOT resume the prior scene as if uninterrupted** — the gathering was real; the narration must
   acknowledge it and move forward from where it left everyone (the before and after are distinct beats).
4. **This applies to any whole-house event** — competitions AND the nomination / veto / eviction
   ceremonies (and any house meeting), "largely the same."

## The model — a whole-house event in session

`houseEventInSession()` reports when a whole-house event is the live, unresolved beat — a **competition**
(its `comp-intent`/`comp-round` is pending, or it is staging) or a **ceremony** (a pending `nominations`,
`veto-decision`/`replacement`/`houseguests-choice`, or `eviction-vote`/`tie-break`/`final-eviction`).
While one is in session, `whereabouts` reports the house **gathered**:

- `present` = the **whole house** (everyone is at the event); `nearby` = `[]` (no side rooms to slip into).
- a **`houseEvent`** block: `kind` (`hoh-competition` | `veto-competition` | `nominations` |
  `veto-ceremony` | `eviction`) and, **for a competition only**, the `competing` / `spectating` split
  (the outgoing HOH always among the spectators) + `youAreCompeting`. A ceremony carries `kind` alone —
  the whole house simply attends.
- The player **cannot wander off** mid-event: `movePlayer` is a no-op that keeps them gathered.

The narrator framing (`momentPrompts`) makes the rest true in prose: the event is the ONLY thing
happening (no side conversations during it); the card **may** interrupt mid-scene (expected, not set up
beforehand); and once it's over the narration **acknowledges the interruption and moves forward**, never
resuming the prior scene as if it never happened.

This is **purely observational + a player-action gate** — it overrides the player-facing presence *read*
and refuses a player move, but never mutates `this.presence`/`presenceBase` or any seeded stream, so the
off-screen society, votes, and competition outcomes are **byte-identical** (the `juryReach` gate holds).

## Testability (role-only)

- **The whole house is gathered:** during a comp/ceremony, `whereabouts.present` is the whole house and
  `nearby` is empty.
- **Competitors vs spectators (comp):** the `competing`/`spectating` split is correct and the **outgoing
  HOH is a spectator**; for the veto only the drawn six compete.
- **Ceremonies gather too:** a pending ceremony surfaces a `houseEvent` with no competitor split.
- **No wandering off:** `movePlayer` during an event is a no-op that keeps the player gathered.
- **Off ⇒ normal:** with no event in session there is no `houseEvent` block and side rooms are visible.
- **Framing pinned:** the narrator section names the exclusivity, the outgoing-HOH spectator, and the
  "never resume as if uninterrupted" rule.
- **Calibration byte-identical:** the seeded sim is untouched (`juryReach` within band).

## Out of scope (noted)

- **Spectators forming *real* (seeded) opinion folds from a comp** — e.g. threat ▲ toward a dominant
  winner — would be a calibration-sensitive sim change; deferred to a separate gated feature. Today (ORW-824)
  spectators "form opinions" only in narration (the existing comp-win/comp-loss folds are unchanged).
- **An ad-hoc "house meeting"** has no engine beat; the narrator may frame one, but only the real
  ceremonies/comps drive the structural gather.
