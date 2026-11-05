# 0120 — Strategic-drive off-screen cadence (sharper players scheme a touch more often)

> **Current default (AMEND 2026-11-04):** `ORWELL_STRATEGIC_CADENCE` is now **default ON** — the code default
> (`src/featureFlags.ts`, `defaultOn`) and the deploy profile (`deploy/orwell-env-defaults.sh`) both enable it. Setting
> it to off/0/false still restores the byte-identical uniform draw (and the calibration harness pins it off). The
> "default OFF" wording below is the original rollout history, kept as written.

> **Status:** Built (BDD/TDD-first). **PO expansion of the 0038 review** (2026-07-12): the off-screen
> society (0038) already varies *who* pairs up (by relationship) and *what* the scene is (by the initiator's
> read), but every houseguest initiates at the **same rate**. This adds a **slight** personality/intelligence
> variance to the *cadence*: a sharper, more-strategic houseguest **initiates the hidden scheming a touch
> more often** than a passive one — "slight variance, never a wild skew" (the owner's note).
> **Calibration-safe by construction:** opt-in behind a dedicated flag (default OFF); off ⇒ the uniform draw
> exactly (byte-identical seeded spine). Enabled in the live deploy alongside the other living-house layers.
> **Executable spec:** [`0120-strategic-drive-offscreen-cadence.feature`](./0120-strategic-drive-offscreen-cadence.feature)
> **Also proven by:** `tests/unit/strategicCadence.test.ts`

## 1. Summary — the gap this closes

In the off-screen society (`richOffscreenStretch`), the scene **initiator** is drawn **uniformly** from the
eligible (co-present) houseguests: `a = rng.pick(initiators)`. So a brilliant schemer and a passive floater
step forward to start a plot equally often. This feature weights that one draw by each houseguest's
**strategic drive** — a bounded blend of their **Mental** stat (strategic intelligence) and their
**strategyStyle** (personality) — so the sharper players drive the hidden game a little more, exactly as a
real _BB_ house feels. It is deliberately **slight** (the sharpest schemes under ~3× the most passive), so
it colors the texture without letting one archetype dominate.

## 2. The mechanic — one weighted draw, gated

- `strategicDriveWeight(mental, style)` — a pure, bounded, always-positive weight: `floor + mentalSlope·mental`,
  nudged up for a scheming-forward style (`strategic`/`aggressive`) and down for a passive one
  (`under-the-radar`/`loyal`). Tunable in one place (`STRATEGIC_CADENCE`).
- `GameSessionAdapter.initiatorDrive(id)` maps a houseguest to that weight (from their Mental stat +
  strategyStyle). Engine-internal — the off-screen society is hidden, so this is **never a player-facing
  number**.
- `richOffscreenStretch` takes an optional `initiatorDriveOf`; when supplied it draws the initiator with a
  single-draw `weightedPick` instead of the uniform `rng.pick`.
- The orchestrator passes `initiatorDriveOf` **only when `strategicCadenceEnabledNow()`**
  (`ORWELL_STRATEGIC_CADENCE`, default ON; `=0` opts out).

### Why it is calibration-safe (the guarantee)

- **Off (the default / the calibration + UAT harness):** no `initiatorDriveOf` is passed, the initiator is
  the exact uniform `rng.pick` — the off-screen society is **byte-identical**, so `juryReach`/gradient/UAT are
  unchanged. This is the same dedicated-flag discipline as `ORWELL_TRAJECTORIES`/`ORWELL_CAMPAIGNS`.
- **On (the live deploy):** it swaps `rng.pick` for a **single-draw** `weightedPick` — the SAME one
  `rng.next()` — so the seeded competition/vote stream stays **in phase** (draw count/order unchanged);
  only *which* eligible initiator this one draw lands on shifts. Like the other living-house layers, when on
  it colors outcomes within the tolerance band (heavy-sim'd together), never byte-identically.
- **Vault Wall intact:** the weighting is engine-internal; the player never sees who schemed more, only the
  later behavior. The off-screen scenes stay hidden (witness set excludes the player).

## 3. Scope

**In:** `strategicDriveWeight` + `STRATEGIC_CADENCE` (offscreen.ts), `initiatorDrive` + the
`strategicCadenceEnabled` flag/getter/setter (GameSessionAdapter), the orchestrator pass-through, and the
deploy opt-in (`ORWELL_STRATEGIC_CADENCE=1` in `orwell-install.sh` + `smoke.sh`).

**Out:** changing *who pairs* (partner draw — unchanged, still tie-weighted) or *the scene nature*
(unchanged); any player-facing surface; the 0085 campaign layer (a separate, deeper strategic layer). No
change to the seeded spine when off.

## 4. Contracts (stack-agnostic)

```
strategicDriveWeight(mental, style?): number          // bounded, positive, slight; pure
STRATEGIC_CADENCE: { floor, mentalSlope, styleBonus } // tunable
GameSessionAdapter.initiatorDrive(id): number         // this houseguest's initiate weight (engine-internal)
GameSessionAdapter.strategicCadenceEnabledNow(): boolean
richOffscreenStretch({ …, initiatorDriveOf? })        // weighted initiator draw when supplied; uniform when not
```

## 5. Definition of Done

- [x] **Slight, monotonic variance:** a sharper mind / scheming style weighs more than a passive one; every
      weight is positive; the skew is bounded (sharpest < ~3× most passive). *(`strategicCadence.test.ts`; BDD 1.)*
- [x] **Off is byte-identical:** with the flag off the off-screen initiator is the uniform draw — same seed ⇒
      identical society; the seeded calibration band (`juryReach`) is unchanged. *(BDD 2 + unit; juryReach re-run.)*
- [x] **On has effect + stays deterministic:** turning it on changes the initiator pattern; same seed ⇒
      identical society either way. *(unit; BDD 3.)*
- [x] **Vault-free:** the weighting is engine-internal; no off-screen scene is witnessed by the player;
      `npm run test:arch` green. *(unit.)*
- [x] Name-agnostic tests (roles only); BDD-gated in `cucumber.cjs`; deploy opt-in wired; `npm test` green.

## 6. Dependencies & traceability

Extends **0038** (the live off-screen society — the initiator draw it re-weights) using the seeded
`RandomnessSource`, gated behind a dedicated flag like **0087** (trajectories) / **0085** (campaigns) so the
calibration spine stays byte-identical when off. Enabled in the deploy beside those living-house layers. PO
expansion approved in the 0038 review (2026-07-12): "slight variance to NPC personality / strategic
intelligence."
