# 0016 — God Mode (the administrator port)

> **Status:** Built (see the [README status index](./README.md#index)). The **third channel** (admin / God Mode), alongside player-level and
> in-character (`CLAUDE.md`). The administrator configures the sandbox, overrides **non-Vault**
> mechanics, and inspects **non-Vault** state — and is **walled from the Vault even for the
> admin**. Extends the existing `AdminPort` (`src/surfaces/admin/AdminPort.ts`) and `ADMIN_TOOLS`.
> **Executable spec:** [`0016-god-mode-admin.feature`](./0016-god-mode-admin.feature)
> **Also proven by:** `tests/unit/godMode.test.ts`

## 1. Summary

God Mode is the administrator's meta-channel: inspect the running sandbox, tune knobs, override
non-Vault mechanics, and manage the game (advance, reset, save). It is **out-of-character** and
**per-sandbox**. Its defining constraint is the mandate's strongest, least-intuitive rule:
**the admin is walled from the Vault too.** *"The human has never read it and must not be able
to — spoilers ruin the game above all else"* (mandate #2). God Mode is therefore the **second
walled surface** (after the player), and the Wall is proven on it **independently** — structurally
(no admin module imports `VaultStore`/`VectorIndex`) and by capability allowlist (`readsVault:
false`), per 0001.

## 2. Why a dedicated feature

0001 establishes that admin is walled; 0016 makes God Mode a **real, useful surface** without ever
weakening that wall. It pins what the admin **can** do (inspect/override/configure non-Vault) and,
just as importantly, what it **structurally cannot** (read the Vault, author or read reserve-twist
*content*, reveal hidden attributes). A powerful admin that still can't spoil the game is the
whole trick.

## 3. Scope

**In:** non-Vault inspection; non-Vault mechanic overrides; sandbox lifecycle (advance / reset /
save) and config knobs; the Vault wall on the admin surface (structural + capability); per-sandbox
isolation; the **"enable but don't author/read" rule for reserve twists**.

**Out:** the Vault-Wall mechanics themselves (**0001** — reused here); the player surfaces
(**0001**, gameplay features); the specific mechanics being overridden (their own features);
character authoring (**0015**).

## 4. What the admin can do (all non-Vault)

- **Inspect** non-Vault game state: week, phase, public houseguest roles/status, config, schedule,
  non-secret counters. Never hidden attributes, confessionals, off-screen events, or twist content.
- **Override** a non-Vault mechanic in the sandbox: advance/replay a phase, force a (legal)
  transition, adjust a tunable constant (temperature/relationship config, 0006/0017), toggle the
  daily-event scheduler — engine-mediated, the same way player action tools are (0009).
- **Manage** the sandbox: create / reset / save / load this game's namespace; each game is its own
  isolated sandbox (`CLAUDE.md`).

## 5. What the admin cannot do (the wall, even in God Mode)

- **No Vault read.** No tool returns hidden attributes, confessionals, off-screen events, or
  reserve-twist content. There is no "reveal the Vault" capability; the allowlist forbids one by
  construction (`readsVault: false` is a literal type — registering a Vault reader is a compile
  error). Inspection output is **sentinel-clean** (extends the 0001 canary test to the admin
  surface).
- **No authoring or reading of reserve-twist *content*.** The admin may **enable** reserve-twist
  *slots* and tune **knobs** (e.g. "reserve twists: 2", surfacing rates), but the **specific twist,
  its trigger, and its timing are engine-generated and Vault-sealed** — so even the admin who
  switched them on **does not know what they are or when they fire**. This is what keeps *"the
  human has never read the Vault"* literally true while still allowing configuration (twists are
  Vault-held per 0005).
- **No outcome-spoiling inference.** Overrides operate on visible/config state; none returns a
  Vault-derived value, so an override can't be used to *probe* the Vault (the 0001 inference
  clause, on the admin surface).

## 6. Contracts (stack-agnostic)

```
AdminPort (God Mode) — depends on GameStateRepository / config, NEVER on VaultStore/VectorIndex:
    inspect(query)            -> AdminVisibleState     # NON-VAULT only (already implemented)
    overrideMechanic(change)  -> AdminVisibleState     # non-Vault mechanic change; returns updated non-Vault state
    configure(knobs)          -> AdminVisibleState     # tunables: temperature/relationship config, reserve-twist COUNT (not content)
    manageSandbox(op)         -> AdminVisibleState     # create | reset | save | load — this sandbox only

# ADMIN_TOOLS registry (src/surfaces/tools/registry.ts): fixed allowlist, every entry readsVault: false.
#   No entry reads the Vault, reveals hidden attributes, or returns reserve-twist content.
```

**Invariants:** no admin-facing module has a dependency edge to `VaultStore`/`VectorIndex`
(dependency-cruiser, as 0001); the admin tool set is a fixed allowlist with **no** Vault reader;
admin output is sentinel-clean; admin actions affect **only** their own sandbox; enabling reserve
twists never exposes their content to the admin.

## 7. Test strategy

- **Admin inspection works:** returns week/phase/public roster and config (non-Vault).
- **Admin is Vault-clean (sentinel):** across seeded runs with a fully populated Vault, **no
  sentinel** appears in any admin inspection/override/config output (extends the 0001 canary to
  the admin surface).
- **Capability allowlist:** enumerate `ADMIN_TOOLS`; assert it is fixed, every entry is
  `readsVault: false`, and no entry reads the Vault or returns twist content; obtaining a Vault
  reader fails (compile-time + runtime).
- **Architecture:** dependency-cruiser proves **no** admin module imports `VaultStore`/
  `VectorIndex`/the engine root (the 0001 forbidden-edge rule, covering `surfaces/admin`).
- **Override takes effect (non-Vault):** an admin override of a non-Vault mechanic changes the
  observed non-Vault state; an attempt to override into a Vault read has no such capability.
- **Reserve twists: enable without spoiling:** the admin enables reserve twists; the twist content
  is generated and Vault-sealed; **no** admin surface returns what/when (sentinel-clean), yet the
  twist can still fire in play (cross-checks 0005).
- **Sandbox isolation:** an admin action in one sandbox leaves another sandbox unchanged.

## 8. Definition of Done

- [ ] All scenarios pass, name-agnostic, on the **admin** surface.
- [ ] Admin can inspect/override/configure/manage **non-Vault** state usefully.
- [ ] Admin inspection/override/config output is **provably Vault-free** (sentinel + dependency
      tests, as 0001 — on the admin surface).
- [ ] The admin tool allowlist is fixed and contains **no** Vault reader (capability test).
- [ ] Reserve twists can be **enabled** by the admin without the admin learning their content/timing.
- [ ] Sandboxes are isolated; admin actions don't cross sandbox boundaries.

## 9. Dependencies

**0001** (the Vault Wall — reused, now proven on the admin surface; the fixed allowlist; the
dependency rule), **0005** (reserve twists are Vault-held — admin enables, never authors/reads),
**0006 / 0017** (the tunable constants the admin may configure), **0011** (the phase machine an
override advances). Builds directly on the existing `AdminPort` and `ADMIN_TOOLS`.

## 10. Traceability

`CLAUDE.md` ("Administrator / God Mode — admin-only meta port … walled from the Vault even for the
admin"; three channels); `docs/bb-sim-spec.md` §5, §12 (God Mode walled); mandate #2 (the human
has never read the Vault and must not be able to); `docs/CLAUDE_CODE_INSTRUCTIONS.md` §2 (the
permission boundary; God Mode walled); 0001 (structural enforcement reused here).

## 11. Amendment (B57 / audit H4) — admin save/load vs the 0007 ratchet

`manageSandbox(save | load)` must respect the **0007 monotonic non-degradation ratchet**: an
admin **load may not silently regress persisted detail** (counts stay non-decreasing across the
save lineage; nothing thins). The sanctioned rollback is **restore-to-checkpoint** — an explicit,
recorded operation that starts from a known checkpoint without destroying the later history it
rolls past. An admin "load" that quietly discards accumulated events/souls would violate
mandate #4.

## Amendment (2026-11-03) — `configure` / `overrideMechanic` reach the live game

The 2026-10-25 audit (band A, finding 3) found both tools wrote only the admin's own projection, which the live game never reads — the admin
saw success for a no-op. They now forward the **count knobs the engine honors** — `reserveTwists` (the reserve-twist COUNT, 0 up to the reserve-pool size; **legacy twist mode only** — with `ORWELL_REACTIVE_TWISTS=1` the reactive planner arms the standing pool and ignores a count, so the knob is reported not applied there), `tieBudget`
and `showmanceBudget` (the pre-game tie / showmance COUNTS, 0–6) — to the live session through a per-sandbox, Vault-free delegate. They shape
the **next** season's setup (a season in flight keeps what it was dealt) and are re-applied if a user's sandbox is rebuilt. Every response now
carries `knobsApplied` and `knobsNotApplied`; anything the engine owns or does not expose (`phase`, `week`, `temperature`, …) is still recorded in
the inspectable config but reported as **not applied**, so the admin is never told a no-op worked. Counts and names only — never twist or tie content.
Gate: `tests/unit/godModeLiveKnobs.test.ts`.
