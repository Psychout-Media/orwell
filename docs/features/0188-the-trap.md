# 0188 - The trap, and the overheard plant (ORW-619, ORW-627)

Summary: Ryne approved both on 2026-11-17.
- **The trap:** a suspicious houseguest who doubts someone's discretion tells them, and only them, a made-up secret (a canary), then watches whether it comes back from anyone else. If it does, they know who leaked; if it never does, the suspect passed. Houseguests can trap the player, and the player can trap a houseguest by talking.
- **The overheard plant:** a story planted in a room is a scene other people there can overhear.

Flag `ORWELL_TRAPS`, default ON (`=0` means no traps and no overheard plants). Played games with the belief layer only. Engine-only.

## The trap
- **It extends conviction's "tests what they doubt" (0160).** A doubt about someone's *discretion* (an unsure rumor that they talk or lie, or an unsure "they lied to me") can be tested by a trap, not only by asking around.
- **Who sets one:** a houseguest who is suspicious by nature (credulity below 0.45), with no trap already running, on their own seeded daily roll (`TRAP.setChance`).
- **The canary** is "X is going after me", made up:
  - X is the houseguest the setter fears most among those the claim would be **false** about (the engine checks its own records);
  - it is not picked from a list;
  - it is told to the suspect alone (a claim) and seeded as a fact they hold, so slice 9's co-presence spread can carry it on.
- **When it comes back** from anyone but the suspect (a told claim the setter now holds, or the fact reaching them through the spread), the trap springs:
  - the setter's trust in and warmth toward the suspect fall;
  - the setter holds, as their own deduction, that the suspect talks behind their back.
  - This also feeds 0180's house norms and scapegoats.
- **When it never comes back** in `TRAP.watchDays` (3), the suspect passed and the setter trusts them a little more.

## The player in both directions
- **Houseguests trap the player.** The canary is said to the player the next time the setter is with them, as an ordinary confidence. The narrator gets the same fields as for any confidence, with no tell. If the player repeats it and it reaches the setter through someone else, it springs on the player, the same as on anyone.
- **The player traps a houseguest by talking.** The player tells one houseguest a made-up claim (ORW-612's player claims, #2975). Houseguests pass on what they hold (the leak speech, the spread). When someone tells it back to the player, the player draws their own conclusion: the engine never tells the player who leaked.

## The overheard plant (ORW-627)
- A house-life plant (a lie planted with someone) happens in a room. Anyone else in that room who is awake may overhear it, each on their own keyed roll (`OVERHEAR_PLANT.chance`, 0.35).
- **A houseguest who overhears it** holds that the planter is talking about the target behind their back (origin `overheard`).
- **The player who overhears it** hears the words, as a scene they were in. They never learn whether it is true.

## Wall
- Traps, canaries and overhearing rolls are engine-only, and no view shows a trap.
- The narrator voices a canary as an ordinary confidence and an overheard plant as the words only.
- Nothing is shown as a number.

Code: `src/engine/trap.ts` (pure); the adapter's `trapTick`, `plantCanary`, `sayPendingCanary`, `springTrap` and `overhearPlant`; the orchestrator calls `trapTick` once a day. Tests: `tests/unit/trap.test.ts`, `0188-the-trap.feature`.
