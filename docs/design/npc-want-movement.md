# A10 - NPC movement from one internal WANT (design; builds on A8 `desireClock.ts`)

PO (Ryne, card 14): "movement strength should be higher. There should be an 'internal motivation' to these NPCs." One want drives BOTH where an NPC goes and when they approach the player.

## Current state (measured)
- Deployed `MOVEMENT_INTENT.moveIntentStrength = 0.15` (global constant). `tests/unit/movementDeployedStrength.test.ts` (#2080): a motive-holder is with its target 0.117 of ticks vs 0.079 motiveless = x1.48 over 20 ticks.
- A8 (`desireClock.ts`): per-NPC `desireFor(milestone, role)` -> campaign | plea | probe | check-in, `urgency(drive, hoursUntil, hoursSinceApproach)` in ~0..2, spent by an approach (hours cooldown). Used for approaches/interruptions only.

## Proposal
1. `movementIntentFor(npc)` (GameSessionAdapter, today relationship-only) gains the WANT: target = the player or the NPC the want points at (campaign/plea -> the HOH or veto holder; probe -> the nominee/swing vote; check-in -> the strongest bond), `weight = baseWeight(drive) * wantScale(urgency)` where `wantScale(u) = 1 + k * min(1, u / threshold)` (k = the new knob, flag `ORWELL_WANT_MOVEMENT`, default OFF).
2. Strength: `moveIntentStrength` becomes `base 0.15` x `wantScale` - near a deadline an NPC with an unsatisfied want has up to (1+k) x the pull; once they have approached (A8 `desireApproachedAt`) the want is spent and the pull falls back to baseline. No NPC's pull ever drops below today's.
3. Same want, same state (`live.desireApproachedAt`): an NPC who just approached is not also sprinting at the player.
4. Observable result: the board's names-only whereabouts shows purposeful movement ("Sam heads for the HOH room before nominations"); no number crosses.
5. Isolation: movement draws no rng of its own (0078); the base pass is unchanged, only the weighted player-facing pass reads the want -> `movementStreamIsolation` stays the gate.

## Measurement plan (BEFORE flipping; a runner job, not local)
- Co-presence multiple: motive-holder vs motiveless at k in {0, 1, 2, 4} (extend `movementDeployedStrength.test.ts`): target >= x2.5 at the chosen k near the deadline.
- PO bands: passive/solid F2 and win over the 300-seed gate (`calibrationPoTarget`) with the flag ON vs OFF; the rule is no band regresses and `juryReach`/gradient stay green; S8's pinned seed-1 outcome is expected to move and is re-pinned deliberately.
- `movementStreamIsolation` seeds [1,2,3,4,22] identical.

## Rollback
Flag `ORWELL_WANT_MOVEMENT` (default OFF) + the single knob `k`; off is byte-identical (nothing read, nothing written).
