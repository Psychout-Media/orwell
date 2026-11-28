# 0201 - The bed rush (ORW-672)

Ryne's ruling (2026-11-18): the move-in bed pick becomes a mini-competition at the start of the game. The old walk-in-order claim ran while the whole house (the player included) was held in the common area, so the player could not go and choose and could be left with none.

## Rules
- **Nothing before the toast.** No houseguest claims a bed on walking in, on the first message, or during the toast; the player's own claim is refused with the reason (the circle has not closed).
- **Release.** When the circle closes everyone is released at once. The rush runs as a few engine heats, one per `advanceGame` (`BED_RUSH.ticks` = 4, plus `graceTicks` = 2 of waiting).
- **A claim needs the room.** An NPC claims on the heat they reach their room; the player claims in their own words once they are in the room (saying "I run to room X and take a bed" walks them there first, then reads the claim). A claim from the common area is refused.
- **Arrival model (`arrivalTick`, pure).** Inputs: speed (physical aptitude), eagerness (social and mental nature plus how much they want a particular roommate: their warmest feeling for anyone in the house), distance (where they stand in the open area, a seeded side stream) and luck (a seeded side stream). Which bed they take stays the ORW-466 pick (`pickBedFor`). All streams are keyed `${seed}:bed-rush:...`; no shared rng draw and no existing draw reordered.
- **Safety floor.** While the player has no bed, an NPC claim that would leave fewer than 4 open spots, or open spots in fewer than 2 rooms, waits (`claimKeepsFloor`). It resumes when the player claims, or at their first bedtime (the leftover bed). Sixteen houseguests fit sixteen spots, so the held NPCs are exactly the reserve.
- **Trade.** Latecomers take what is left and use the ORW-466 swap and later-move rules unchanged.
- **Voice.** The narrator is handed, per heat, who reached which room, who is still racing for which room and which rooms still have beds open: third person, number-free, Vault-free. The premiere prompt tells it to author the scene itself and leave the rush-or-hang-back choice to the player.
- **Persistence.** `live.bedRush` ({ tick, plan, log, done }) is saved with the season; the tick only rises and the log only grows, so a restore mid-rush resumes to the identical assignment.
- **Flag.** `ORWELL_BED_RUSH`, default ON, a played game with the staged premiere only. Off: the claims run in entrance order once the circle has closed (amended 2026-11-28, ORW-1134; they used to run as each houseguest walked in). Headless: no beds, as ever.

## Left for later
- NPCs are not yet placed physically in the bedrooms during the rush (the facts reach the narrator; the whereabouts map is unchanged).
- A played game with the staged entrances switched off still claims on the first message.

## Amendment 2026-11-28 (ORW-1134, Ryne, product owner)
Ruling: "Beds open after the circle: nobody claims a bed until the host closes the circle and opens the bedrooms. Then everyone, you included, scrambles at the same moment."
- `ensureBeds` returns without claiming while the staged premiere is in its entrances or its toast, whatever the `ORWELL_BED_RUSH` flag says. The arrival step and the first message no longer claim (the old ORW-466 slice 2 walk-in claim is gone for a staged premiere; with the rush flag off the claims run, in entrance order, once the circle has closed).
- The first claim of the season is the rush: the host's close and bedroom call (ORW-1129) ends the circle, the next heat releases everyone, the player included, who can move and claim in that same window. The safety floor, the arrival model and the leftover-at-bedtime rule are unchanged, so every houseguest is bedded by the end of the window and the player can always reach a free bed.
- Nothing else leaned on walk-in claims: the tour placement and the narrator's BEDS facts already read "no bed yet" until the close; no front-end belt keys on early beds.
- Gates: `tests/unit/bedsAfterCircle1134.test.ts` (rush off fails without the fix); the 0201 scenario for the rush-off case changed; `bedPick`, `orw522BedClaimMove` and `bedRush` unit tests re-based on "the circle closes first".
