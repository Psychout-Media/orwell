# tests/realpath/ — tests that go through the real path

A card that says its feature must be proven "through the real path" keeps that test here (ORW-758, part A5).

A real-path test reaches the state it checks **by playing the game**, the way a person and the front end do:
it builds a game with `tests/support/sandbox.ts` or `GameSessionRegistry`, then drives it only through the
session / MCP API (`createCharacter`, `advanceGame`, `submitDecision`, `recordInteraction`, `noteMessage`,
`turnIn`, the player tools such as `surfaceInformationTo({...})` and `diaryRoom`, or `McpServer.callTool`).
It may read anything (`s.snapshot().live.week` inside an `expect`), pick seeds, and switch feature flags.
It never writes hidden or engine state by hand. If the test needs a state it cannot reach by playing, it is
not a real-path test and belongs in `tests/unit/`.

Why: a card marked Done on a test that sets the state directly proves the code works on a state the game
may never produce. Fifteen cards were once closed that way.

## What the guard forbids

`tests/unit/realPathGuard.test.ts` reads every `.ts` file here (and the heavy played-season files
`tests/uat/realPath*.test.ts`, which stay in the heavy lane for their run time) and fails, naming
`file:line`, on any of these (comments and string contents are ignored):

| Rule | Example it catches |
|---|---|
| `live-assign` | `s.live.week = 3`, `live(s).beliefs ??= {}`, `(s as any).live.pending = undefined` |
| `live-incdec` | `core.live.week++` |
| `live-mutator` | `s.live.evictionOrder.push(...)`, `live(s).bonds.set(...)` |
| `live-delete` | `delete s.live.pending` |
| `object-assign-state` | `Object.assign(s.live, {...})`, `Object.assign(rel.edge(a, b), {...})` |
| `edge-write` | `rel.edge(a, b).trust = 0.9` |
| `relationship-writer` | `rel.applyImpactDirected(...)`, `relationships.load(...)` |
| `knowledge-writer` | `knowledge.seedBelief(...)`, `knowledge.surfaceInformationTo(...)`, `addSuspicion`, `transmitGossip`, `recordDiaryRoom` |
| `vault-writer` | `vault.writeHidden(...)`, `replaceHidden(...)` |
| `event-writer` | `events.record(...)`, `restoreRecord(...)` |
| `soul-writer` | `recordToSoul(...)`, a store `load(...)` of a hand-made snapshot |
| `admin-override` | `applyOverride(...)` |
| `sandbox-planter` | the sandbox helpers that plant content (`addConfessional`, `surfaceHiddenFactToPlayer`, ...) |
| `planting-helper` | importing a support module that sets state (`liveSentinelPlanting`, `favorsSeam`, `triadsSeam`, `longNightDriver`, `vaultSentinelAnnouncementsHarness`, `dayTwoMorning`, `napWorld`) |

**As shipped (ORW-827).** Every file here runs the game at its deploy defaults: the unit-lane setup file
(`tests/support/premiereTestDefault.ts`) leaves `tests/realpath` like the heavy lanes, so the premiere entrances and the bedtime gate are on.
Turning a switch OFF (`set...Enabled(false)`, `process.env.ORWELL_* = "0"`) needs a reason the guard can see, on that line or the line above:
`// not as shipped: <why>` (the guard's `flag-off-unstated` rule). Unsetting a variable returns it to its default and is allowed.

Allowed: reads, seeds, feature flags (`set...Enabled(`, `process.env.ORWELL_* =`, admin `configure` knobs),
the session / MCP calls above, infrastructure resets (`resetSaveSyncLimiterForTests`, `setStallTimerForTests`),
and fake front-end providers (an LLM or image stub).

The guard is a line-level text check, so an alias (`const L = s.live; L.week = 1`) or editing a snapshot
and restoring it escapes it. Reviewers still read the test. There is no escape hatch in the guard.

`playedSeason.ts` holds the shared stop (ORW-810): `playUntil(seed, stopWhen)` plays a season with the scripted talking player
(`tests/support/whatFired/player.ts`) on the production runtime, at the deploy defaults (the premiere entrances and the bedtime gate on), and stops
at the first message where `stopWhen` (a pure read) holds; the test then acts through the player's MCP channel (`at.call(...)`). A test that
needs more than about a minute of play goes to the heavy lane (`tests/uat/realPath*.test.ts`) instead.

## Seeds and sandbox names (ORW-852)

A played game is fixed by its seed AND its sandbox name: the name keys the player-action stream and the off-screen tick, so the same seed under
another name is another season (ORW-841). Pin both. Every played-season driver takes the name next to the seed (`user:` in `playUntil`, `playSeason`,
`playedGame` and `playMixGame` options; the third argument of `bootNatural`), and a name is fixed: never random, time-based, or a counter that moves
with test order. The guard's `sandbox-unpinned` and `sandbox-unfixed` rules enforce it.

The folder decides two shipped flags (the premiere entrances and the bedtime gate; `tests/support/premiereTestDefault.ts`): on in `tests/realpath`,
`tests/uat`, `tests/property` and `tests/calibration`, off everywhere else. Either one changes the season, so search for a seed from the folder that
will run the test (or from `tests/realpath`), never from a scratch folder, and pin the sandbox name you searched with.

Roles only in tests (HOH, nominee, NPC, player), never names.
