# "Hang out until X" - the safe fast-forward (`hangOut`)

PO ask (Ryne, 2026-11-04): the player can tell the narrator "hang out here and socialize until the competition starts, someone interrupts, I'm pulled, I observe anything noteworthy, etc." Under the ~5-in-game-minutes-per-message pace this is the safe way to pass time.

**Flag:** `ORWELL_HANGOUT=1` (default OFF; ships dark). Off, or the per-conversation clock off, or no game, or a decision pending => `{ ok:false, reason }` and ZERO state change (pinned by byte-identical snapshot tests).

**Engine (`src/engine/hangOut.ts` pure runner + `GameSessionAdapter.hangOut`):** up to 8 beats of 15-30 in-game minutes (side stream `hangout:<seed>:<call#>`, never the season spine). After every beat, fixed priority: (1) scheduled event due, (2) pulled (diary room / production, at most once per in-game day), (3) NPC approach (ranked by the existing `rankApproaches`, awake living NPCs only), (4) something observed in the player's eyeshot (overheard whisper / argument / someone moved - public presence only, names never ids), (5) bedtime (midnight, or sooner once the house has thinned to the player plus at most one awake NPC - the 20-24 block is prime social time; the player still owns their own bedtime). The beat is CLAMPED to the next event's hour, so it never fires or skips an event; the event itself then fires on the next normal pre-resolve (the FE runs the hang-out BEFORE the pre-resolve, so a due event fires the same turn).

**Recorded:** every call appends to `live.hangOutLog` (day, hour, beats, minutes, stopReason, public detail) and bumps `hangOutCount` (persisted; snapshot/restore keeps the stream aligned). The orchestrator runs one extra off-screen society tick per `SOCIETY_TICK_HOURS` spent (cap 3), and skips its own follow-up per-conversation step once so the call is not double-billed.

**FE:** `maybe_hang_out` (`routes/chat_helpers.py`) recognises a wait-verb + until/for-a-while phrase, calls the engine lever (FE-driven: `INFRA_LEVERS`, not in the narrator prompt), and arms a one-turn steer carrying the engine's stop reason for the narrator to voice. Fail-open.

**Known gaps (follow-ups):** an `observed` stop is voiced from public presence but is not itself a hidden-impact-folding event (no `recordInteraction`); NPC "interruption mid-conversation" (B's clock work) is a separate seam; tune `HANGOUT_*_P` against B's 5-min pace.
