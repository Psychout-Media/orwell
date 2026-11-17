# 0172 - Groups: roles, nesting, spies and cracking (Theme 3 slice 6), with ORW-603 and ORW-611

Executable spec: `0172-groups-roles-and-cracking.feature` (wired into `cucumber.cjs`). Flag `ORWELL_GROUP_ROLES` (default ON, `=0` is the kill switch; played games only).

## What is built
- **ORW-603 (a bug):** a pitched alliance's roster is frozen at what the player was told (`Alliance.toldRoster`, set by `reveal(id, PLAYER, told)`); the player's pitch view shows it, never the live membership. The history keeps the live roster.
- **Roles** (engine keys: leader, strategist, shield, swing, glue, comp-threat), dealt once a day from the members' own bonds (`bondReader().tie`), the house graph (hub, broker) and the character's stats; a keyed roll, then the id, breaks a tie. Every member holds one; a member who leaves drops theirs; a newcomer is dealt one.
- **Nesting:** a triple of an alliance of four or more who stand closer to each other than to the rest is an inner circle (a record on the group, not a second alliance in the list).
- **Purpose** (survival, power, endgame) from how much of the starting cast is left; each shift is a history entry.
- **Private cut orders and the agreed target:** each member keeps their own first three names (threat to my game, comp, my tie); in survival the group's own members are off the order. The majority's target is the Borda head of the outsiders; settling on one moves each member's own threat read of them by one bounded step.
- **Spy:** an awake outsider with no alliance, close to the founder and to someone outside, is drawn on a keyed daily chance; they join, and when the group settles a target they tell the person they work for in a hidden two-person scene (`spy-report`). If the target is that person, their read of the planners turns. The player witnesses it only if they were in the room.
- **Shadow group:** the group holding the crown, with someone it means to cut who is warm with other outsiders, draws a counter-alliance of those outsiders; it is a normal alliance the first group is not part of, tagged `shadowOf`.
- **Cracking:** once the purpose has moved past survival, members whose own first cut is a fellow member split from the rest on a keyed daily chance; two or more found a new alliance, one alone leaves. The history keeps a `cracked` entry with the whole roster, a `left` per leaver and the new `formed`; nothing is deleted.
- **ORW-611, the player plugged in:** (1) a hostile plan aimed at the player (get-them-out or revenge) is an approach raised through the desire clock's own path, with no trust floor (a hostile houseguest is not pressing a request); (2) a pull-them-in goal whose target is the player pitches the player the holder's alliance through the existing pitch path; (3) a group that settles on the player sends one member to press them (the same approach path), and withdraws a pitch the player has not taken when the founder no longer wants them in or the group has settled on them (an event the player is in, naming the alliance, never a roster).

## Not built, on purpose
- The player's OWN alliances are never faded, broken, cracked or spied on (ORW-616 is the owner's pending ruling). Groups the player belongs to get no group life.
- A spy's leak reaching the PLAYER by an NPC telling them is a claim (spoken-claims and belief territory, the Auditor's); only the overheard path is built.
- The agreed target moves nominations and votes only through each member's own threat read (a bounded one-time step); no nomination code was touched.

## Vault Wall
`live.groupLife` (roles, inner circle, cut orders, spy, shadow link) and the group-life history entries are Vault-class: no view, tool result, narrator prompt or admin projection carries them (the BDD scenario checks the live surfaces). New history kinds are history-only (`GROUP_CHANGES`); the event flush skips them.

## Streams
No shared stream is drawn: every roll is a keyed `agendaRoll` (or a name draw on its own `SeededRandom`), so a flag-off season is byte-identical.
