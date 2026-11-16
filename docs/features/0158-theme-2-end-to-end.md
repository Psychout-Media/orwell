# 0158 - Theme 2 end to end (slice 9)

Card: ORW-330. Executable spec: `0158-theme-2-end-to-end.feature`. Plan: the vault note "Theme 2 Slice Plan", slice 9.
(0157 is the rumor-mill retrospective, so the end-to-end scenario takes the next free number.)

One scenario, one seeded game (seed 7), the real adapter through a registry sandbox, no mocks. It chains the rules of 0149 (the claims core), 0151 (what the player hears),
0152 (who told you that), 0154 (caught in a lie) and 0156 (house meetings) and checks the seams between them, not just each rule alone:

1. A liar tells a houseguest a false "targets you" claim and swears they voted to keep the houseguest: both become refutable beliefs with the liar as source.
2. The houseguest trusts the player, they are alone, and the engine has the houseguest confide the belief: the narrator gets `tellsYou` (kind, names, certainty band) only.
3. The player asks "Who told you that?" through `resolvePlayerMove`: the houseguest names the liar, and the player now holds a `told-by` fact.
4. The public count is unanimous against the houseguest (`evictionCountPublic`): the vote claim's belief is refuted and a lied-to-me belief about the liar appears.
5. The houseguest calls a house meeting (`holdHouseMeeting`): the narrator gets the `houseMeeting` line as the speakers' words, and each listener's belief about the accusation is set.

Across every step the narrator views (moment prompt, game state, the player MCP reads) never carry `isTrue`, an intent, a claim id, a lied-to-me belief or a ballot, and
`claimsThePlayerHeard()` is exactly the claims the player was the listener of. The scenario goes red if any stage is cut (trust gate, source naming, the count refuting, the meeting's belief update, a truth leaking into a view).
