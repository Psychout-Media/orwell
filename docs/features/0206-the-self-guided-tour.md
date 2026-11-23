# 0206 - The self-guided tour (ORW-654)

Ryne's ruling (2026-11-18): move-in is a self-guided tour. After walking in, the player explores the house freely and the first time they step into a room they get a card for it; the houseguests mostly gather in the open common area until the champagne circle, with a few wandering, so first impressions happen there. Bed claiming follows the tour as built (0201).

## The premiere's order
1. **Entrances** - the houseguests walk in one at a time (one per `advanceGame`), as before. Until the player's own entrance the player is held.
2. **The tour** - from the player's own entrance on, the whole-house hold is lifted: the player can walk the house (`movePlayer` works). The stage is still `entrances`; the entrance board carries `tour: { open, everyoneIn }`. The last arrival does not start the circle; the house stays open.
3. **The circle is called** - the next `advanceGame` after everyone is in (the model on a lull, a ready cue from the player, or the front end's ordinary stall ladder) calls the circle: the stage goes to `toast`, `champagneCircle` is `gathered`, and the player is called to the living room (the same place every ceremony convenes). From here it is the old premiere: toast, then the bed rush (0201).
4. **No beds on the tour** - nothing is claimed before the circle closes (0201 holds); a bed claim during the tour is refused with the reason.

## Where the houseguests stand
While the tour is open each arrived houseguest stands in the common area (the living room, the kitchen or the dining room: their own spot, stable for the season) except a bounded share that wander to some other room. Where one person stands is a keyed side stream of (season seed, houseguest, step), step = arrivals so far and messages so far; it moves only the player-facing presence map, never the calibration base, and draws nothing from the season rng (`src/engine/houseTour.ts`). One place at a time holds (it is the presence map). Houseguests who have not arrived are nowhere.

## The room card
The first time the player steps into a room (any time in the game, not only the premiere; the entrance room counts at the player's own entrance) the narrator is handed a `roomCard` on the whereabouts for that turn only: the room's id, the season's own name and look for it (the house theme: a library theme or one the writer authored), who is in it and what it opens onto. Third person, number-free, Vault-free. The narrator authors the arrival moment live from these facts, once.
- **What was chosen:** no new authoring write-back. The season's house theme already carries the authored name and look of every room (a large table, or the writer's own draft accepted per season), so the engine hands the narrator those facts and the rule to author the card; nothing in the tour code is a fixed card per room or a dealt line. A per-room live write-back (a four-place change plus a front-end driver) is a follow-up if the theme look proves too thin. (ORW-825)
- **State:** `live.houseTour.seen` (the rooms entered; append-only, saved with the season, checked as a superset by the save check). The turn's card itself is memory only.
- Only the player ever triggers a card; an NPC walking into a room never does.

## Flag
`ORWELL_HOUSE_TOUR`, default ON, a played game with the staged premiere only. Off or headless: no tour record is written, the hold stands through the entrances and the circle follows the last arrival, byte-identical to before.

## Front end
While the tour is open and everyone is in, the front end stashes the entrance stage as `tour`, so the "next arrival every two messages" cadence does not fire the circle early; the ordinary lull and stall ladder still calls it. The narrator prompt carries the tour rules only on the tour turns (a per-turn board line), not in the fixed premiere text.

## Left for later
- 0205 (the circle as meet-the-cast): the circle is entered from the tour as before; if 0205 changes what the circle is, the "called" edge here (`advancePremiereEntrance`, stage `entrances` with everyone in) is the one place to change.
- A minimum tour (the engine refusing to call the circle before the player has seen some rooms) is not built; the player or the model's lull call decides. (ORW-825)
- NPCs walk to the common area in one jump at each step; a per-step walk along the floor plan is not modelled.
- A per-room authored card (write-back) instead of the theme look.
