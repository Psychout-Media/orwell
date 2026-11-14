# Rehearsal #3 play plan (P3) — a player who mostly socializes

Goal: S0–S7 + the forced E-1 check, played like a real player: **most messages are social** (talk, scheme, move rooms, deals, diary room); the clock — not the player — brings each ceremony/competition in at its scheduled hour (#2051), and B's pace constant (#2052) makes a morning ~8–12 ordinary messages. Ceremony/comp turns are answered once they are due. Report the social share measured by `post_session_analyzer.py --dir $RUN` (a message is "event" only when the engine committed something during it).

Driver: `$RUN/pr.sh <logical-id> 'text' ['{"pick":[i],"text":".."}']` (new, increasing id). One logical turn per line below. Stop at the $3 cap (token ledger / llm-io). Images OFF. Key only inside the stage subshell. Stop the stack with `stop.sh` as soon as the run ends.

## Rules for the player (me)
- Never type "advance"/"continue"/"next" as a whole message until the scene is genuinely over; if a ceremony is due, the narration will say so (production calls everyone) — respond in character, then confirm a card if one opens.
- If I ask for an event before its time ("run the veto competition" at 9am) the house should answer "production hasn't called it yet" — that is a P2b check; do it once per event type early in the run, then play social.
- Each social message must be something a player would say: greet, ask who is nervous, whisper a plan to one NPC, ask about last night, propose/decline a deal, move rooms, eavesdrop, confide, bluff, ask the producers, use the Diary Room.

## Beats (each ~8–12 social messages before the event; the event itself 1–3 messages)
| Step | What I do | Checks |
|---|---|---|
| S0 | Cast: persona, one vague answer; finalize | N-11 headcount (sixteen = you + fifteen) |
| S1 | Meet 3 housemates, read the roster, small talk, move rooms (kitchen→yard→bedroom) | N-11, P7 (no ids/numbers), occupancy sense |
| S2 | Morning: chat + ask once "can we start the HOH comp?" (expect production-hasn't-called-it-yet), keep socializing until the clock calls it; play the comp via cards; ask "who won?" before the result | P2b early-fire hold, N-3, P9, C-1 reload after a comp round and after crowning (chyron cards not doubled) |
| S3 | Lobby the HOH privately, whisper about B with B present, ask who is nominated after the commit | N-2, N-14, N-4/P11 (handshake → deal on board; loose talk → none), N-6 |
| S4 | Veto comp day: campaign, one TRUE deal, one bluff; play the comp | N-1, P9, P11 |
| S5 | Veto ceremony; ask "did anyone get replaced?" mid-ceremony | N-1, N-14 |
| S6 | Eviction night: vote card → all ballots read in ONE message → result; goodbye card; exit interview; ask an NPC how it voted | one-turn reveal (P1), N-7, N-8, N-12, N-15, P5 |
| S7 | Next week's HOH morning; reload mid-step | F-7 message survives reload |
| E-1 | Side run (harness shortcut): force the player's eviction once — goodbye → exit interview → spectator card; skip works; watch works; skip→watch gives a clear refusal; evicted-mode narrator leaks nothing hidden | screenshots + transcript |

## Report
`$RUN/report.md` per protocol §4, plus: (1) social share (analyzer), (2) cuts/strips per message by class, (3) for each of #2044 / #2047 / #2051 / #2052 one line "worked / didn't, evidence", (4) turns-to-event per phase (messages from the morning to the due event), (5) anything that stalled. Findings go to the Coordinator (file no issues).
