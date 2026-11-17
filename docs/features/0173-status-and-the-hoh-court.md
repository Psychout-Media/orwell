# 0173 - Status, informal leaders and the HOH court (Theme 3 slice 11) - BUILT (flag ORWELL_HOH_COURT, default ON, played games only)

Executable spec: `0173-status-and-the-hoh-court.feature`. Unit gate: `tests/unit/hohCourt.test.ts`. Pure core: `src/engine/hohCourt.ts` (all constants in `HOH_COURT`).

## What it adds
- **Status (hidden).** Once an in-game day (`statusTick`, from the house-life stretch) a coarse tier per houseguest is derived from wins (the game resume), allies (the bond reader's mutual ties and the house graph's hubs) and respect (how the others' bonds read). Saved as `live.status` (coarse tiers, the informal leader, lieutenants, an open vacuum, a monotonic count and a bounded history). Never a number, a rank or a roster on any surface.
- **Informal leader and lieutenants.** The top scorer is the leader only with at least two followers; up to three lieutenants. A sitting leader is held until a challenger leads by `challengeMargin`.
- **The HOH court.** After their own goal steps, a houseguest goes to the sitting HOH with a small keyed chance per hour (`courtBase`), and far more when on the block or read as a threat by the HOH (`courtDanger`). The HOH room's tenure is already tracked (ORW-561). A court step toward the player-HOH becomes an approach through the desire clock's own path and guards.
- **Power vacuum.** When the leader is out, the surviving lieutenants contest; a keyed roll (`splitChance`) may split the group: the lesser lieutenant leaves the alliance they shared (`removeMember`, so the 0161 alliance history records it as a hidden event).
- **ORW-610 (the player plugged in).** The player, when the HOH reads them as a threat, carries the same protective pitch as an NPC in the HOH's nomination tilt (weighed only: never voiced or recorded as the player's act, never a deal). When the player is HOH the would-be lobbyists come to them as approaches.
- **ORW-577.** Campaigns, drives and competition intent read the agenda: an active committed get-them-out goal seeds an evict campaign (outside the 4-campaign cap, which keeps limiting threat-seeded campaigns), sets the drive's target, and a committed win-power goal keeps a houseguest competing. The third-person actions (campaign-against, drive-a-wedge, lobby-for, count-votes) move the listener's read of the named person by a bounded step on a keyed stream.

## Owner questions
- Courting changes the HOH's reads and approaches only; it never changes nominations directly.
- The player's protective pitch is weighed automatically (the same rule as NPCs). Does the owner want the player's pitch to need the player's own say first?
- Goal-seeded campaigns are exempt from the cap of 4: confirm "drop the cap" (ORW-577) is meant that way.
