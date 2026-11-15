# P0d - live clock smoke (dev, once #2145 is deployed there)

Goal: prove, as a real player, that the clock moves +5 in-game minutes per message (plain chat included), nothing 409s, a hang-out does not make the next message free, and nothing fires early. About 15 messages, mostly chat. Images off. Spend cap $0.5.

**Precondition (not mine to create):** dev has login on (it redirects to /login). I do not create accounts or enter credentials on hosted boxes, so someone must hand me an already-logged-in session (the Coordinator or Ryne starts it and gives me the cookie), or run this themselves. Start from a fresh game that has finished the premiere day-break (morning, 8:00 clock running).

**After every message** run: `python3 ~/orwell-playtest/rehearsal-kit/p0d_read.py http://<dev> '<cookie>'` and note `minutesUntil`, `due`, `timeOfDay`. Also tail the dev front-end log for `stale-beat` / `409` (read-only: `journalctl -u orwell-frontend --since "-10 min" | grep -ci "stale-beat"`).

## The ~15 lines (send in order; wait for the reply to finish before the next)
| # | Player line | Type |
|---|---|---|
| 1 | Hey everyone, good morning. How did you all sleep? | chat |
| 2 | I'll grab some coffee and sit with whoever's up. | chat |
| 3 | So who do you think is going to win the first competition? | chat |
| 4 | What's your game plan this week? | chat |
| 5 | I really like your energy. Want to team up? | chat (alliance-flavored, no card) |
| 6 | Tell me about where you're from. | chat |
| 7 | I'm going to wander out to the backyard. | move (one tool call) |
| 8 | Anyone out here want to talk? | chat |
| 9 | I'll hang out until something happens. | hang-out |
| 10 | (the very next message) What did I miss? | chat - must still cost 5 min |
| 11 | Would you be willing to promise me safety this week? | deal offer |
| 12 | Okay, I'll think about it. Let's keep chatting. | chat |
| 13 | What do you think of the other houseguests? | chat |
| 14 | Anything strange going on in the house? | chat |
| 15 | I'm going to relax for a bit. | chat |

## What to expect and the pass/fail table
Let M0 be `minutesUntil` before line 1 (minutes until the first scheduled event, noon).
| Check | Expect | Pass if |
|---|---|---|
| Plain chat steps the clock | each plain-chat line (1-6, 8, 12-15) lowers `minutesUntil` by exactly 5 | every one is -5 (+/- 0) |
| A tool-call message bills once | line 7 (move) lowers it by 5, not 10 | -5 |
| Hang-out spends its own time | line 9 lowers it by the hang-out length (15-30 min per beat, up to 8 beats) or stops early with a stated reason | a stop reason is narrated; time moved |
| **Hang-out does not make the next message free** | line 10 lowers it by exactly 5 | -5 (a 0 is the bug B fixed; a 0 here is a FAIL) |
| Deal offer | line 11 costs 5; any card/refusal is the NPC's own choice | -5 |
| No 409 | zero `stale-beat` lines in the dev FE log for the window, or at most a handful already reconciled with no lost reply | 0 (or reconciled, no missing message) |
| Nothing fires early | `due` stays false and no competition card appears while `minutesUntil` > 0 | no comp before it is due |
| Noon flip | if `minutesUntil` reaches 0 during the run, `due` becomes true on that message and the competition is offered in the afternoon, not before | only at 0 |
| Disclosure | no fabricated confession, no early result | none |

Report in ONE screen: the table filled with PASS/FAIL, the `minutesUntil` series (M0, then after each line), the 409 count, cost, and anything odd (quote the line).

## Notes
- The state read shows no wall of hours; `minutesUntil` is the clock signal. If a hang-out reaches the event, `due` flips true and the afternoon comp is offered (that is correct).
- If any plain-chat line leaves `minutesUntil` unchanged, #2145's announcement is not reaching the engine: check the FE log for `noteMessage` errors (the FE logs a debug line only on failure).
- Do not file issues from this run; report to the Coordinator.
