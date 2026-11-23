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

Allowed: reads, seeds, feature flags (`set...Enabled(`, `process.env.ORWELL_* =`, admin `configure` knobs),
the session / MCP calls above, infrastructure resets (`resetSaveSyncLimiterForTests`, `setStallTimerForTests`),
and fake front-end providers (an LLM or image stub).

The guard is a line-level text check, so an alias (`const L = s.live; L.week = 1`) or editing a snapshot
and restoring it escapes it. Reviewers still read the test. There is no escape hatch in the guard.

Roles only in tests (HOH, nominee, NPC, player), never names.
