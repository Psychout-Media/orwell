# 0202 - Leverage both ways, sneaky as well as blunt (ORW-645)

Summary: Ryne approved this on 2026-11-17 (Fable 4.2): leverage "as long as that's not like the only way that it can be done. Leverage doesn't have to be aggressive or assertive. It could just be a little bit sneakier." Theme 4 (secrets).
- A houseguest who holds a secret about someone can lean on them **blunt** (an explicit demand) or **sneaky** (quiet pressure: letting them know you know, a favour that quietly becomes a debt), chosen by character and situation.
- It is one tool among many. Most holders on most days keep what they hold; trading (0099), exposing (0093) and the rest are unchanged.
- It works NPC to NPC, NPC to the player, and the player to NPCs.

Flag `ORWELL_LEVERAGE_PLAYS`, default ON (`=0` means no plays, and a `manner` on the player's leverage is ignored: byte-identical). Played games only. Engine-only records.

## What already existed (built on, not duplicated)
- 0093 gave the player a blunt press through `makeDeal`'s `leverage` descriptor, with the strength, refusal floor and squeeze backlash in `src/engine/leverage.ts`. This slice reuses all three verbatim.
- 0099's off-screen barter moves facts between NPCs. Nothing let an NPC press a held secret on a person, and the player had only the blunt register.

## The decision (`src/engine/leveragePlay.ts`, pure)
- **Once a day** (the off-screen tick, `leveragePlayTick`), each awake houseguest looks at the facts they hold about living houseguests (the player included) and takes the one they most want to lean on.
- **Desire** is the holder's stakes (on the block counts fully), their wariness of the target, how sharp the secret is (its public kind, never its text) and how little they like the target. Below `desireFloor` nothing happens. Above it, a roll against `playChance` decides; most days it fails.
- **Register** is a second roll weighted by the holder's nerve (steady holders lean blunt), the warmth of the bond (a warm bond leans sneaky) and how shrewd the target is (a suspicious target leans sneaky).
- **Cap:** `maxPlaysPerDay` across the house, given to the strongest wants (never to whoever sorts first by id). A holder does not press the same target on the same fact again inside `cooldownDays`.
- Every roll comes from a stream keyed on game seed, holder, week and day (never the shared rng), so it is deterministic and reorders no other draw.

## The consequence
- **Against an NPC** it resolves at once through the existing machinery:
  - blunt: the 0093 strength and refusal floor decide. Met: the target is bound a little tighter (the strategy fold). Refused: the target's read of the holder sours by the 0093 squeeze times `bluntRefusalMult` (an open demand turned down costs more).
  - sneaky: the target may notice (more likely the more suspicious they are). Noticed: it backfires, the target's read of the holder sours. Unnoticed: it works and leaves a quiet debt (trust and alignment toward the holder rise a little, scaled by how hard it landed).
- **Against the player** it is an open approach. The engine does nothing on the player's behalf:
  - a deal made with that houseguest answers it;
  - ignored for `answerDays`, a blunt demand closes as refused (the holder's read of the player sours by the squeeze) and a hint just lapses.
- Records are append-only (`live.leveragePlays`, engine-only, persisted with the season). They hold fact ids, so they never reach a view.

## The player's side
No new lever. `makeDeal`'s `leverage` descriptor takes an optional `manner` (`blunt` is the default and the 0093 behaviour; `sneaky` is quiet pressure). The model proposes the manner; the engine keeps the magnitude and decides whether it is noticed. A sneaky press is recorded as a play by the player. The FE schema (`tool_schemas.py`) and the shape-only parse (`_parse_secret_lever`) carry the field; no new tool, so no five-place wiring.

## What the narrator gets
A houseguest in the room who is pressing the player carries `leansOnYou: { manner }` in the present-knowledge block: who, and blunt or sneaky. Never what they hold, never why, never a number. The prompt states the rule (the manner meanings, never decide for the player how to answer) with no sample lines. NPC-to-NPC plays are off-screen and surface only through behaviour.

## Vault Wall
A play record holds fact ids and ids of houseguests; the narrator fact holds a manner word. The secret's content is never read into either (`tests/unit/leveragePlay.test.ts` plants a sentinel and checks both).

## Not in this slice (follow-ups) (ORW-825)
- A refused or exposed blunt demand does not yet make the holder decide to spread the secret (Theme 4 slice 4.2's last line).
- `confront` as an explicit way for the player to answer an approach (a deal is the only answer today).
- Favours that become debts across days (the sneaky debt is a single small fold today, not a tracked owing).
- NPC-to-NPC plays leave no observable tell yet beyond edge shifts.

## Amendment 2026-11-19 (ORW-688): the facts houseguests hold now say who they are about

Every consumer here keys on a held fact's `subject` (who it is about), but the records the houseguests actually held had none: the confidant's origin belief for a thread rumor, a pre-show tie observation and a confidence was lodged without it (only the copy handed to the player carried it), and a secret the player exposed or traded was lodged under a fresh id per recipient (so no two houseguests ever held one lineage) with the subject only on a separate, lineage-less copy. So plays, breaks and barters found almost nothing to match in a played game.
- The origin beliefs now carry the subject; a thread rumor diffused along the graph carries it on every hop; a scene rumor (graph path) names the one who is not the teller.
- An exposed or traded secret is lodged under the player's own fact id as its lineage, so the whole house holds ONE lineage with the subject on it (and a secret already exposed is known to be out, so 0204 does not re-break it).
- `surfaceInformationTo` takes an optional `factId` so a record with a subject also has a lineage.
- An old save is backfilled on load from the record's own fields (a scene rumor's lineage id names its origin and its undrifted text names the pair), append-only, no rng.
- Flag `ORWELL_RUMOR_SUBJECTS` (default ON, `=0` = subject-less, byte-identical). Played games only. The subject is engine-only (Vault class): only a fact the player was told reaches them, with its source. Test `tests/unit/rumorSubjects.test.ts`; report `tests/calibration/secretSubjectReport.test.ts` (`ORWELL_SECRET_SUBJECT_REPORT=1`).
- Not done: an overheard fragment (presence) is still subject-less. (ORW-825)
