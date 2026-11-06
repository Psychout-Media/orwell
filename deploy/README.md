# deploy/ — one-liner Proxmox install & update

Spec: [`docs/features/0010-deployment-one-liner.md`](../docs/features/0010-deployment-one-liner.md).

The scripts target the engine's standard contract — **`npm run build` + `npm start`** — and the
in-container installer **verifies that contract before building** (a not-yet-runnable checkout
fails clearly instead of half-installing). One Proxmox LXC runs both tiers as systemd services:

```
 LXC (Debian)
   ├─ orwell-engine.service     Node:   npm start  -> MCP server on 127.0.0.1:${ORWELL_ENGINE_PORT}
   └─ orwell-frontend.service   Python: uvicorn app:app on ${ORWELL_BIND_HOST}:${ORWELL_PORT}  (LAN by default; see below)
   data: /opt/orwell/data       .env (secrets) + the save (SQLite + souls); preserved across updates
```

> **LAN vs behind a proxy.** The installer **asks** whether to expose the UI on your LAN and
> **persists** the answer as `ORWELL_BIND_HOST` in `data/.env` (so a reboot/rebuild stays reachable).
> The default — and the `--default` non-interactive answer — is **LAN (`0.0.0.0`)**: reach the game
> directly at `http://<lan-ip>:${ORWELL_PORT}`. The systemd unit's *built-in* default stays
> `127.0.0.1` (safe if `.env` is somehow missing); the `EnvironmentFile` value wins. Choose **"Behind
> proxy"** (or set `ORWELL_BIND_HOST=127.0.0.1`) to keep loopback for a reverse proxy / HTTPS / tunnel.
>
> **Putting it on the internet?** Front it with a TLS-terminating reverse proxy / tunnel (Cloudflare
> Tunnel is the recommended option) — that path pins the FE to loopback. See [`expose/`](./expose/)
> and `docs/INSTALL.md → Public deployment (any domain)`. Enabling local HTTPS (`orwell https`) also
> re-pins `ORWELL_BIND_HOST=127.0.0.1` (the terminator becomes the only LAN entrypoint).
>
> **WebSocket transport is ON by default.** WS Phase-1 (ADR 0017, `GET /api/ws/session`) is active
> while `ORWELL_WS_TRANSPORT=1` is set in `data/.env` (the default). Every terminator here (direct uvicorn, Caddy,
> Cloudflare Tunnel, Pangolin/Newt) passes the WebSocket `Upgrade` transparently — no extra config.
> **LAN / loopback turn-on is safe today; PUBLIC turn-on is not yet** — the WS handshake lacks the
> `Origin`/CSRF guard (a CSWSH surface on a public terminator; guard in flight on
> `claude/ws-origin-guard`). The turn-on ops steps, the LAN-vs-public prerequisite, and a verify
> one-liner are in [`expose/README.md`](./expose/README.md#websockets-through-the-perimeter-ws-phase-1-turn-on).

## Recommended specs

**Baseline: 4 vCPU / 8 GB RAM** (12 GB disk) — the installer defaults (overridable via `CORES`,
`RAM_MB`, `DISK_GB`). The LLM is **remote**, so CPU is spent on the front-end + engine + **local
embeddings** (fastembed / ONNX, warmed at boot). Give it **more RAM** if you also run in-character
**image generation**, or run several concurrent games. A 2 vCPU / 2 GB box (the old default) is
enough to boot but tends to stall under the embedding warm-up + a live turn — symptoms are a
hung-feeling turn and a brief front-end 502 while the engine catches up.

## Usage

The repo is **private** (ruling #17, 2026-06-10). You authenticate **once, ever**: the
first-install one-liner carries a fine-grained PAT (scope: this repo, **Contents: Read-only**,
nothing else). The installer persists it to the container's `data/.env` (`GIT_TOKEN=…` — the one
file every reset preserves) and wires a git **credential helper** that reads it at use time, so
updates and resets never re-prompt and the token never lands in a remote URL or `.git/config`.

```bash
# install — on the Proxmox host shell (THE one authenticated moment).
# EXPORT the token (in `VAR=x bash -c "$(curl …$VAR…)"` the substitution runs in the OUTER shell
# before VAR= applies, so curl gets an EMPTY token → 404/401). Fetch via the contents API, not
# raw.githubusercontent.com (which 404s for fine-grained PATs). Works with fine-grained OR classic.
export GIT_TOKEN=github_pat_xxx
bash -c "$(curl -fsSL -H "Authorization: Bearer $GIT_TOKEN" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/kevinhirsch/orwell/contents/deploy/orwell.sh?ref=main")"

# update — host or inside the container: run the LOCAL checked-out copy (no GitHub fetch)
bash /opt/orwell/deploy/orwell-update.sh
```

After install, **every maintenance command is the local copy** — `bash
/opt/orwell/deploy/<script>.sh` inside the container, or the same script from a checkout on the
host (it bridges into the LXC via `pct` and, with no local file, runs the **in-container
checked-out copy**). No script fetches branch tips from GitHub anymore (audit E84): the only
GitHub traffic is `git fetch/pull` itself, authenticated by the credential helper.

For an **existing install** that predates the private flip, set the token once:

```bash
bash /opt/orwell/deploy/orwell-update.sh --set-token     # prompts; or GIT_TOKEN=… non-interactive
```

Fine-grained PATs cap at one year — `--set-token` is also the annual rotation (still "once," per
year). Variant for never rotating: a read-only **deploy key** (SSH) pasted into GitHub once and an
SSH `REPO=` URL; the PAT-in-`.env` path is the default because the preserve-`.env` infrastructure
already exists.

The update script works **either** on the Proxmox host **or** inside the container: the app and
its git checkout live in the LXC (the host has no `git` / no app dir), so when run on the host the
script locates the orwell container (by hostname `orwell`) and re-runs itself inside it via `pct` —
the same bridge the installer uses. Override the target with `CTID=<id>` (or `CT_HOSTNAME=<name>`)
if you renamed the container or run more than one. A container provisioned **before** the
`bbai → orwell` rename (app in `/opt/bbai`, `bbai-*` services) is auto-detected and updated in place
— the engine and front-end still honor the deprecated `BBAI_*` env, so its `data/.env` keeps working
untouched.

### Fast updates: what an update skips (ORW-229)

An update reinstalls and rebuilds only what the new commit actually changes. After every update that
fully succeeds, `orwell-update.sh` records in `dist/.orwell-deps-stamp` (root-owned, beside the
`dist/.orwell-build-sha` build stamp) what each step consumed (the git ids of the lockfiles and sources
it reads, plus the node/npm/python versions) and what it left on disk (npm's
`node_modules/.package-lock.json`, the engine build, the venv's installed packages). On the next update:

| What changed since the last successful update | Engine (`node_modules` + `dist/`) | Front-end venv |
|---|---|---|
| Nothing the engine reads (front end, deploy scripts, docs, tests, CI) | kept as is: no `npm ci`, no rebuild | kept if `frontend/requirements*.txt` are unchanged |
| Engine code only (`src/`, …), same `package.json` / `package-lock.json` / `patches/` | only the build tools that `npm prune` removed come back, from the local npm cache (`npm install --include=dev --no-save --prefer-offline`), then build + prune | same as above |
| `package.json`, `package-lock.json`, `patches/`, or the node/npm version | full `npm ci` (as before) | same as above |
| `frontend/requirements.lock.txt` / `requirements.txt`, or the venv's Python | (per the rows above) | `pip install` (as before) |

Everything is reinstalled in full when there is no record: the first update with this updater, a
fresh install, or right after an update or rollback that failed, was reverted or was interrupted (the
record is deleted when a run starts and written only at its commit point). It is also redone:
- when the disk no longer matches the record, for example after someone ran `npm` or `pip` by hand on
  the box;
- once after `orwell-update.sh` itself changes (its own text is part of the record);
- when the record, `dist/`, `node_modules` or `frontend/.venv` is not owned by root, or is writable by
  anyone else (the ownership pass then fixes the tree, and the next update can skip again).

To force a full reinstall, delete `dist/.orwell-deps-stamp`.

The React `/play` app (`frontend/web`, when the commit has it) is built by the update too, and never
fails it: a failed build logs a warning and `/play` keeps its current build (or its "not built yet"
page). It builds from a clean export of the commit in a temp dir (`npm ci --prefer-offline
--ignore-scripts && npm run build`; no dependency install scripts run) and is swapped into
`frontend/web/dist` only after the update commits, so `/play` keeps serving the old build while the new
one builds, and a failed update never changes it. It is skipped when nothing under `frontend/web` or
`frontend/static/js` (the classic markdown module it imports) changed. The previous build is kept in
`frontend/web/dist.prev`, which `--rollback` puts back when it matches the commit it rolls back to.

## Control panel — the `orwell` menu

After install, **`orwell`** (a launcher for `orwell-menu.sh`, installed to `/usr/local/bin/orwell`)
opens a **whiptail** menu over every task below — update, doctor, backup, restore, the two reset
tiers, and the readiness check — so you don't have to remember script paths or flags. It opens on an
ASCII **ORWELL** banner and runs each action with sectioned, step-by-step status lines (`▸` working,
`✓` done, `✗` failed); the installer and the login health panel share the same banner + glyphs. The
login health panel advertises it.

> `/usr/local/bin` is ensured on the login-shell `PATH` via `/etc/profile.d/orwell-path.sh`
> (dropped idempotently by install/update), because `pct enter` minimal login shells omit it —
> otherwise `orwell` is "command not found". On a live box that predates this, the one-shot
> workaround is `export PATH="/usr/local/bin:$PATH"`.

```bash
orwell                      # the interactive menu (inside the container)
orwell doctor --status      # or a direct subcommand (skips the menu — good over SSH / in scripts)
orwell change-port 80       # move the UI port (handles the privileged-port cap drop-in)
orwell https --mode local   # local HTTPS — trusted on the LAN, no browser warning (feature 0074)
orwell reset-game --yes     # destructive subcommands require --yes off the menu
```

`orwell https` stands up a Caddy TLS terminator in front of the front-end driven by the tunable
`ORWELL_TLS_*` variables in `data/.env` (`orwell-https.sh` is the single apply engine, shared with the
in-app Admin "Local HTTPS" card via the `orwell-ops-tls.*` root seam). It covers `orwell.lan`,
`orwell.local`, and the LAN IP with an internal CA (download the root from `/orwell-local-ca.crt` and
trust it once per device), and can additionally serve a public domain with a publicly-trusted DNS-01
cert. See `docs/INSTALL.md → Local HTTPS` and ADR 0014.

The menu only **dispatches** to the scripts in this directory (the single source of truth for each
task), collecting input through dialogs — a deploy-token password box, a backup picker, a
type-`RESET` confirmation for the resets. The scripts themselves also show inline whiptail dialogs
when run directly on a terminal (the updater's action menu + token box, the doctor's mode picker,
the resets' confirm) and remain **fully non-interactive** for automation, CI, and the
host→container `pct exec` bridge (which has no PTY) — exactly today's flags/env. `whiptail` is
installed by `orwell-install.sh`; without it (or off a TTY) every prompt falls back to plain text.
Shared dialog helpers — and the matching presentation helpers (`ow_logo` / `ow_section` /
`ow_step` / `ow_ok` / `ow_warn` / `ow_fail`, colour auto-disabled off a TTY or under `NO_COLOR`) —
live in `orwell-tui.sh` (sourced; it changes no shell options); `orwell.sh` (the curl-bootstrapped
installer) and `orwell-install.sh` keep their own inline copies — they must each stay one
standalone file.

### Factory reset (back to OOBE, **keep the API-key / LLM config**)

Returns the box to a fresh first-run state — every game sandbox (saves, souls, the hidden Vault
layer) **and** the whole front-end store (accounts, chats/sessions, memory, MCP configs, uploads,
**every cast portrait / avatar / headshot**, presets, and every other user setting) — while
**keeping your LLM credentials**: the **API keys** + the **provider endpoint**. The **selected
models reset to the OOB defaults** (the ADR 0016 two-tier pair: narrator `z-ai/glm-4.7` + utility
`qwen/qwen3.6-flash` on OpenRouter, portrait `gemini-3.1-flash-image`) — a stale/placeholder pick
never rides across a reset (issue #860).
Run it either **on the Proxmox host** (it bridges into the LXC, like `orwell-update.sh`) or
**inside the container as root**:

```bash
# from the Proxmox host (auto-locates the orwell LXC; CTID=<id> if not named "orwell");
# run from a host checkout, or any local copy of the script — it bridges into the LXC
bash deploy/orwell-factory-reset.sh
bash deploy/orwell-factory-reset.sh --dry-run
bash deploy/orwell-factory-reset.sh --yes

# or directly inside the container
bash /opt/orwell/deploy/orwell-factory-reset.sh             # prompts: type RESET
bash /opt/orwell/deploy/orwell-factory-reset.sh --dry-run   # preview what would be removed
```

`data/.env` — including the deploy `GIT_TOKEN` **and the public-deployment / SSL profile** written
by the admin **Connect to the internet** wizard (`ORWELL_PUBLIC`, `ALLOWED_HOSTS` /
`ALLOWED_ORIGINS`, `SECURE_COOKIES`, `AUTH_ENABLED`, …) — survives the scrub, so updates keep
working without a re-prompt **and a box that was reachable on the internet stays reachable**. The
`data/ops/` apply record the admin page reads back is preserved too, and the OS-level
**cloudflared** tunnel/service is never touched.

It stops the services, removes the data, and restarts — the next visit begins at first-run
onboarding **with an LLM already configured**. This is **identical** to the in-app admin
**Factory Reset (OOBE)** button and to `orwell reset-oobe`: the script delegates to
`orwell-oobe-reset.sh` (the keep-the-LLM-config tier documented just below) so the two can never
drift. A factory reset deliberately **keeps** your provider config — to also wipe the keys, remove
`frontend/data/.app_key`, `.key`, `api_keys.json`, and `app.db` by hand.

> **The engine save dir matters.** The engine writes per-user saves (and the hidden Vault layer)
> to `ORWELL_DATA_DIR`, **defaulting to `./.orwell-data`** if unset. Fresh installs now pin
> `ORWELL_DATA_DIR=<app>/data` so the save lives in `data/`; older installs that predate that pin
> keep their save in `<app>/.orwell-data`. The reset script **resolves the real save dir from
> `.env` and handles both layouts** — an earlier version only scrubbed `data/` and so left the
> game intact on default installs.

### OOBE reset (back to first-run, **keep the API-key / LLM config**)

The "clear everything but my LLM setup" tier — and the one the admin status page's **Factory
Reset (OOBE)** button runs. It wipes **exactly** what a factory reset does (every game sandbox
*and* the whole front-end store — all accounts, chats, sessions, memory, MCP server configs,
uploads, portraits, and every user setting) **except** it preserves the configuration an
operator should never have to re-enter:

* the configured **LLM / image providers** (the `model_endpoints` table in the FE `app.db`),
* the **LLM-selection settings** (which endpoint/model is the default for chat / utility /
  research / vision / image),
* the **encryption keys** that decrypt them (`frontend/data/.app_key`, `.key`) and the legacy
  `frontend/data/api_keys.json`,
* and — like every reset — the engine config **`data/.env`** (ports, tokens, the deploy
  `GIT_TOKEN`, LLM keys, **and the public-deployment / SSL profile**: `ORWELL_PUBLIC`,
  `ALLOWED_HOSTS` / `ALLOWED_ORIGINS`, `SECURE_COOKIES`, `AUTH_ENABLED`, …), which is **never
  touched**, plus the **`data/ops/` public-deployment apply record**. The OS-level **cloudflared**
  tunnel is untouched too — so a box that was made **public on the web stays public** across the
  reset.

So after the reset the app sits at first-run onboarding (account creation / casting) **with an
LLM already configured**. Same host-aware bridge and flags as the other resets:

```bash
# from the Proxmox host (auto-locates the orwell LXC; CTID=<id> if not named "orwell")
bash deploy/orwell-oobe-reset.sh
bash deploy/orwell-oobe-reset.sh --dry-run
bash deploy/orwell-oobe-reset.sh --yes

# or directly inside the container
bash /opt/orwell/deploy/orwell-oobe-reset.sh             # prompts: type RESET
bash /opt/orwell/deploy/orwell-oobe-reset.sh --dry-run   # preview what would be removed

# or from the control panel
orwell reset-oobe --yes
```

The selective FE-store surgery (export the `model_endpoints` rows + the LLM-selection settings,
wipe the rest, rebuild a fresh `app.db` / `settings.json`) is done by the quarantined Python
helper `frontend/scripts/oobe_reset.py`; the shell script orchestrates the service stop, the
file keep-list, the engine-save scrub, and the restart. The encrypted provider keys are carried
**verbatim** (no re-encryption, no plaintext ever materialized) so they still decrypt under the
preserved `.app_key`. Use the **factory reset** (below) when you want the LLM config gone too.

### Update + Reset (update first, then OOBE — **keep the API-key / LLM config**)

The combined **middle** tier of the three maintenance controls — **Update · Update + Reset ·
Reset** — for when you want a freshly-pulled build **and** a clean first-run box in one action. It
**composes** the two existing scripts (it re-implements neither): it runs the update with restart
suppressed (`orwell-update.sh --no-restart` — pull → rebuild engine → refresh FE deps) and **only
if that succeeds** proceeds to the OOBE reset (`orwell-oobe-reset.sh --yes` — wipe to first-run,
preserving the LLM/provider config, never touching `data/.env`), ending in the **single** final
restart.

**Fail-closed** (the safety contract of a destructive combo): if the **update** fails, the wipe
does **not** run (the box stays on its previous build and nothing is removed); if the reset helper
is missing it refuses up front, removing nothing — so your **API keys are never at risk**. Same
host-aware bridge and flags as the other resets:

```bash
# from the Proxmox host (auto-locates the orwell LXC; CTID=<id> if not named "orwell")
bash deploy/orwell-update-reset.sh
bash deploy/orwell-update-reset.sh --dry-run   # preview both phases; change nothing
bash deploy/orwell-update-reset.sh --yes

# or directly inside the container
bash /opt/orwell/deploy/orwell-update-reset.sh             # prompts: type RESET
bash /opt/orwell/deploy/orwell-update-reset.sh --no-restart # update + scrub, leave services down

# or from the control panel
orwell update-reset --yes
```

This is the script the admin **Update + Reset (OOBE, keep API keys)** button runs. Destructive —
prompts for `RESET` unless `--yes`; `--dry-run` previews. Use the plain **Update** when you only
want the new build (no wipe), or the plain **OOBE reset** when you only want a clean box (no pull).

### Game reset (new season, keep accounts + LLM config)

The lighter sibling of the factory reset: it removes **only game progression** — every per-user
engine sandbox (saves, souls, the hidden Vault layer, in-flight casting intake) — and preserves
**everything else**: `data/.env` (ports, tokens, LLM keys, **and the public-deployment / SSL
profile**) *and* the entire front-end store (accounts, sessions, settings, including the LLM
endpoint config), plus the **`data/ops/` public-deployment apply record** and the OS-level
**cloudflared** tunnel. Players keep their logins, the box keeps its LLM setup **and stays public
on the web if it was**; the next visit starts a brand-new game at the casting interview.
Same host-aware bridge and flags as the factory reset:

```bash
# from the Proxmox host (auto-locates the orwell LXC; CTID=<id> if not named "orwell")
bash deploy/orwell-game-reset.sh
bash deploy/orwell-game-reset.sh --dry-run
bash deploy/orwell-game-reset.sh --yes

# or directly inside the container
bash /opt/orwell/deploy/orwell-game-reset.sh             # prompts: type RESET
bash /opt/orwell/deploy/orwell-game-reset.sh --dry-run   # preview what would be removed
```

It resolves the engine save dir exactly the way the factory reset does (all three `ORWELL_DATA_DIR`
generations), stops the services while it scrubs, and restarts them after. Use the **factory
reset** instead when you also want accounts/settings gone (full OOBE).

### Rebuild (destroy + re-provision, keep only the deploy token)

The heaviest "nuke and pave" tier: **destroy the orwell LXC and re-provision a fresh one** (fresh
OS + fresh code), preserving **only** the deploy `GIT_TOKEN`. The rebuilt box lands at first-run
OOBE — you re-enter the LLM key once. Unlike the reset tiers it does **not** keep accounts, saves,
or the LLM/provider config — it is a brand-new container. Reach for it when the **container
itself** is wedged (a corrupt rootfs, a botched OS upgrade, drifted system state) and resetting
the app data is not enough; for a clean app with a working container, prefer the reset tiers above.

**Host-only.** It destroys an LXC, so it runs **on the Proxmox host** (it needs `pct`); a container
cannot destroy itself, so it refuses if run inside the LXC — and the in-container `orwell` control
panel can't host it for the same reason.

```bash
# from the Proxmox host (auto-locates the orwell LXC; CTID=<id> if not named "orwell")
bash deploy/orwell-rebuild.sh             # prompts: type RESET
bash deploy/orwell-rebuild.sh --dry-run   # preview EXACTLY what it would destroy + recreate; change nothing
bash deploy/orwell-rebuild.sh --yes       # no prompt (automation)
```

**Fail-safe ordering — it never destroys without a recovered token AND a backup.** Before touching
the old container it (1) salvages `GIT_TOKEN` from the old `data/.env` (read without ever printing
it; supply `GIT_TOKEN=<pat>` explicitly to rebuild a box whose `.env` lost it), and (2) writes a
**timestamped safety-net backup** of the old `data/` (engine `.env` + saves) and `frontend/data/`
to the host at `/var/lib/orwell-backups/orwell-rebuild-<ctid>-<UTC>.tgz` (override the dir with
`ORWELL_REBUILD_BACKUP_DIR`). If **either** step fails it **aborts and leaves the old container
untouched**. The old container's resources (cores, RAM, rootfs size, `net0`/bridge, hostname) and
UI port (`ORWELL_PORT`) are captured from `pct config` + the old `data/.env` and mapped onto
`orwell.sh`'s env overrides so the new box matches the old one; the re-provision invokes the
**local** sibling `deploy/orwell.sh --default` (never a GitHub fetch), passing the token via env.

> **Public box caveat.** Token-only preservation does **not** carry over the
> cloudflared/SSL/public-deployment profile. If the old box was reachable on the internet, re-run
> the admin **Connect to the internet** wizard after the rebuild.

### Web-triggered update (the admin status page)

The admin status page can trigger `orwell-update.sh` and watch its output live. The web tier
runs inside the E85-hardened unit (`User=orwell`, every capability dropped) and structurally
cannot `systemctl` or self-update — so it never executes anything. Instead it drops a **flag
file** (`data/ops/update-requested`; content ignored — **existence only**, never parsed or
executed) and the root-side **path unit** `orwell-ops-update.path` reacts by running the **one
fixed script** (`deploy/orwell-update.sh`) via a oneshot root service, appending stdout+stderr
to `data/ops-update.log` — the same `data/*.log` surface the status page already tails (G1b).
The runner removes the flag *before* the run (a finished run never re-triggers; a request that
lands mid-run earns exactly one follow-up run) and holds a `flock` so overlapping triggers
no-op. The web tier chooses *when*, never *what*.

The **OOBE reset** (keep-API-keys, above) is web-triggerable through the **same pattern**: the
admin status page's **Factory Reset (OOBE)** button (`POST /api/admin/factory-reset`,
admin-gated, demanding a typed **`RESET`** in the browser first) drops the existence-only flag
`data/ops/factory-reset-requested`, and the root-side path unit `orwell-ops-factory-reset.path`
runs the **one fixed script** `deploy/orwell-oobe-reset.sh --yes` via its oneshot root service,
appending output to `data/ops-factory-reset.log`. The full-wipe **factory reset**
(`orwell-factory-reset.sh`, which also drops the LLM config) is deliberately **not**
web-triggerable — only via the shell / control panel.

The combined **Update + Reset** button (`POST /api/admin/update-reset`, admin-gated, demanding a
typed **`RESET`** first) is web-triggerable through the **same pattern**: it drops the
existence-only flag `data/ops/update-reset-requested`, and the root-side path unit
`orwell-ops-update-reset.path` runs the **one fixed script** `deploy/orwell-update-reset.sh --yes`
via its oneshot root service, appending output to `data/ops-update-reset.log`. The script is
fail-closed (a failed update never proceeds to the wipe), so the button is safe to expose. On the
status page the three controls render as a set — **Update Orwell · Update + Reset · Factory Reset
(OOBE)** — and the combined button shows an "Updating + resetting… returning to OOBE" state, then
polls `/api/admin/health` and reloads once both services answer again (the same reconnect path as
the Update button).

The status page also carries a prominent **"Update Orwell (pull + rebuild + restart)"** button
(`POST /api/admin/update`, admin-gated, fixed command — no user input). It confirms first, then
shows an "Updating… reconnecting" state and polls `/api/admin/health`, reloading once both
services answer again. The endpoint runs the update through one of two privilege doors, in
priority order — and never silently 403s on `systemctl`:

1. **The flag trigger (default, recommended).** When `data/ops/` exists (the installer creates
   it), the endpoint just drops the existence-only flag above and the root path unit runs the
   script. **The web tier holds zero privilege; nothing extra is required.**
2. **The detached direct run (opt-in).** Set `ORWELL_UPDATE_DIRECT=1` to force, and
   `ORWELL_UPDATE_SUDO=1` to wrap the run as `sudo -n bash orwell-update.sh`. This path runs the
   fixed script with `subprocess.Popen(start_new_session=True)` (its own session, so the restart
   of `orwell-frontend` can't kill it) and returns `{started:true}` immediately. **Operator
   prerequisites for this path** — because the FE user is non-root and `systemctl`/`git
   pull`/`/etc/systemd` are otherwise denied:
   * Install the scoped sudoers drop-in: re-run `orwell-install.sh` with `ORWELL_UPDATE_SUDO=1`
     (writes `/etc/sudoers.d/orwell-update`, validated with `visudo -c`; grants the `orwell`
     user NOPASSWD for **exactly** `bash orwell-update.sh`, nothing else — see
     `deploy/sudoers/orwell-update`).
   * Clear `NoNewPrivileges=yes` for the FE unit (it blocks setuid `sudo`): add a drop-in
     `/etc/systemd/system/orwell-frontend.service.d/20-update-sudo.conf` with
     `[Service]\nNoNewPrivileges=no`, then `systemctl daemon-reload && systemctl restart
     orwell-frontend`. This relaxes one hardening knob for the FE unit, which is why the
     **flag-trigger door (1) is preferred** — it needs none of this.

Path/log are overridable for tests/dev via `ORWELL_UPDATE_SCRIPT` (default
`/opt/orwell/deploy/orwell-update.sh`) and `ORWELL_UPDATE_LOG` (default
`/opt/orwell/data/update.log`); the command itself is always fixed.

### File ownership (least privilege)

The **code tree is root-owned** and never group/world-writable — the checkout, `deploy/`, `dist/`,
`node_modules`, `frontend/.venv`, `.git`. The root-run ops units execute scripts out of `deploy/`, and
the app units are sandboxed read-only outside their `ReadWritePaths`, so the `orwell` service user
needs no write access to code. Only the directories the services legitimately write belong to it:
`data/` (or a custom `DATA_DIR`), `frontend/data`, `backups/` (the nightly backup unit runs as
`orwell`) and `.orwell-data` (the engine's default save dir when `ORWELL_DATA_DIR` is unset). Both
`orwell-install.sh` and `orwell-update.sh` apply this through one function, `orwell_apply_ownership`
(kept byte-identical in the two files; a test pins it), so **an update on an existing box migrates
a previously `orwell`-owned code tree back to root** — including when the update is triggered by the
root ops unit. A custom `DATA_DIR` is honored by passing it in the environment of the install/update.

Root also never trusts a path under the `orwell`-writable tree. `orwell-oobe-reset.sh` and
`orwell-game-reset.sh` resolve every directory they delete or chown (the engine save dir comes from
`data/.env`) and refuse anything that does not land inside the app's data dirs — never `/`, the app
dir, or anything above it. The ops runners (`orwell-ops-tls.sh`, `orwell-ops-public-deployment.sh`,
`orwell-https.sh`, `orwell-ops-progress.sh`) never follow a symlink under `data/` / `data/ops`: the
side files (config, token) are first *claimed* — renamed into a private root-owned temp dir, which moves
a symlink itself rather than its target — and only then checked, read and shredded there; `.env` and
status files are replaced by `mktemp` + rename, or written/chowned/chmod'ed through an `O_NOFOLLOW` fd.
Values from those side files are allow-listed / control-character-checked before they reach `data/.env`.

**Still open:** the ops units' `StandardOutput=append:/opt/orwell/data/ops-*.log` run logs live in the
`orwell`-writable `data/`, and systemd opens them as root. Moving them somewhere root-owned means
touching the admin log viewer, `logrotate`, and the installer/updater `touch` lines together.

### The login health panel

Entering the container (`pct enter`, ssh) greets you with a live one-glance panel — both
units, both HTTP health probes, whether the tiers agree, the recall provider and model
cache, save count, load/mem, and the play URL — installed automatically by
install/update (`/usr/local/bin/orwell-panel`, hooked for interactive shells only). It is
hard-bounded (1s probe timeouts, ~100ms typical) and can never block a login. Run it any
time with `orwell-panel`.

### Doctor / bounce (when the game misbehaves)

When the chat says **"the live feeds are down"**, the engine banner shows, or things just look
wrong, run the doctor. Like update/factory-reset it is **host-aware**: run it on the **Proxmox
host** and it locates the orwell LXC (hostname `orwell`; `CTID=<id>` / `CT_HOSTNAME=<name>` to
override) and re-runs itself inside, or run it directly **inside the container** (legacy `bbai-*`
units auto-detected):

```bash
# from the Proxmox host (a local copy of the script; it bridges into the LXC)
bash deploy/orwell-doctor.sh
bash deploy/orwell-doctor.sh --status
CTID=112 bash deploy/orwell-doctor.sh --bounce

# or directly inside the container
bash /opt/orwell/deploy/orwell-doctor.sh             # diagnose; restart whatever is unhealthy; verify
bash /opt/orwell/deploy/orwell-doctor.sh --status    # diagnose only — no restarts
sudo bash /opt/orwell/deploy/orwell-doctor.sh --bounce  # force-restart engine + front-end; verify
```

It checks the full chain — units active → engine `/health` → the engine actually **serves tools**
→ the front-end's `/api/orwell/health` reports `engine:true` (the two tiers agree) — flags the
classic `ORWELL_ENGINE_MCP_URL` ↔ `ORWELL_ENGINE_PORT` mismatch in `data/.env`, restarts in
dependency order (engine first), and prints the failing unit's recent journal when a restart
doesn't cure it. Exit `0` means healthy. It also reads `systemd-analyze security` for both units
and warns when a unit's exposure score drifts above the hardening floor (audit E85; override with
`ORWELL_SECURITY_FLOOR=<score>`).

### Known harmless log noise (A11)

The engine's semantic-recall provider (fastembed / onnxruntime) logs, **twice at boot/prefetch**:

```
pthread_setaffinity_np ... error code: 22
```

This is **harmless and expected inside an LXC** whose cgroup cpuset doesn't grant the host CPU
indexes onnxruntime tries to pin its thread pool to. The threads simply run **unpinned** —
inference is unaffected, and it appears **once** (one session, one thread pool, created once),
never per inference. `fastembed-js` doesn't expose ORT's `intraOpNumThreads` to silence it, and
widening the container's cpuset is a worse trade, so there is **nothing to fix** — ignore it.
`orwell-doctor.sh` filters this exact line out of the failing-unit journal tail (and notes how many
lines it hid), and `orwell-install.sh` / `orwell-update.sh` filter it from the model-prefetch output,
so it can never be mistaken for the actual crash reason.

### Dependency advisories (npm audit)

`npm audit` on the host reports advisories, but **every one is in the dev/build/test toolchain, not
the deployed runtime** — esbuild/vite/vitest (bundler + test runner; the esbuild advisory is its dev
server, which we never run), `@cucumber/*`→uuid (BDD tests), and `tar` (pulled in by `fastembed` only
to extract the pinned model from its trusted HuggingFace source at prefetch). The engine runs as a
**bundled `dist/main.js` + the 3 pinned native deps** (`better-sqlite3`, `fastembed`, `sqlite-vec`);
none of the flagged packages sit in its request path.

- **Do NOT run `npm audit fix --force`** — it would downgrade `fastembed` 2.1.0→1.0.0 (a pinned
  ADR-0004 recall migration) and major-bump vitest/cucumber/esbuild (risking the test/build gates).
- The install/update scripts run **`npm prune --omit=dev` after a successful build**, so the deployed
  host carries only the runtime tree — the dev-chain advisories aren't present on the box at all. The
  residual (`tar` via `fastembed` model extraction from a trusted pinned source) is accepted.

## Config UX (community-scripts style)

On a TTY the installer shows a **whiptail menu** with every field pre-populated:

- **Use Defaults** — accept the detected/sensible values and go.
- **Advanced** — step through CTID, hostname, cores/RAM/disk, **rootfs & template storage**
  (auto-listed from `pvesm`), bridge, IP (`dhcp` or a static CIDR + gateway), UI port, branch,
  **OS template** (auto-listed from `pveam available`, newest highlighted), and the **LLM
  provider** (an Ollama host URL — written only into the container's `data/.env` — or "configure
  later"; Anthropic and every other provider `frontend/src/llm_core.py` supports are configured
  post-install via the admin **Settings -> Services/AI** panel, not this installer menu — see
  `ANTHROPIC_API_KEY` below).

**The OS template is resolved and downloaded automatically** (`pveam update` → newest
`debian-12-standard` → `pveam download`, with an offline fallback to one already on disk). This
is the fix for the common `volume 'local:vztmpl/debian-12-standard_…' does not exist` error —
templates are no longer hard-pinned or assumed pre-downloaded.

Non-interactive (piped, or `--default` / `USE_DEFAULTS=1` / `ORWELL_NONINTERACTIVE=1`) uses
defaults. **Every setting is also an env override**, so the same run is fully scriptable:

| Env var | Default | Purpose |
|---|---|---|
| `CTID` | next free id | container id |
| `CT_HOSTNAME` | `orwell` | hostname |
| `CORES` / `RAM_MB` / `DISK_GB` | `4` / `8192` / `12` | resources (recommended baseline 4 vCPU / 8 GB — see **Recommended specs**) |
| `STORAGE` | first `rootdir` storage → `local-lvm` | CT rootfs |
| `TEMPLATE_STORAGE` | first `vztmpl` storage → `local` | where the template is stored |
| `TEMPLATE_NAME` / `TEMPLATE` | newest `debian-12-standard` | pin a specific template |
| `BRIDGE` / `NET` / `GATEWAY` | `vmbr0` / `dhcp` / — | network (`NET` = `dhcp` or a CIDR) |
| `ORWELL_PORT` | `8080` | front-end UI port — ports **below 1024 (e.g. 80) are supported**: the installer/updater grant the hardened unit `CAP_NET_BIND_SERVICE` via a systemd drop-in (removed again when the port moves ≥1024) |
| `CT_ROOT_PASSWORD` | — | optional container **root password for console login** (≥5 chars; fed via stdin, never on a command line). Without it the LXC console rejects every login — use `pct enter <CTID>` from the host, or set one later with `pct exec <CTID> -- passwd` |
| `BRANCH` / `REPO` | `main` / this repo | source to install |
| `GIT_TOKEN` | — | the deploy PAT (private repo; → `data/.env`, never committed) |
| `OLLAMA_HOST` | — | LLM provider (→ `data/.env`, never committed) |

`ANTHROPIC_API_KEY` is **not** an `orwell.sh`/`orwell-install.sh` env var — `write_config()` never
reads it. Configure Anthropic (or any other provider) after first boot via the admin **Settings ->
Services/AI** panel (`POST /api/model-endpoints`), which the front-end supports natively
(`frontend/src/llm_core.py` `_detect_provider`). An earlier revision of the installer's whiptail
menu offered an "Anthropic API key" option that silently discarded whatever was typed in — it was
removed rather than fixed, since wiring it up is a front-end change, not a deploy-script one.

**Behavioral-fidelity flags (the "living house" layers).** The installer writes these into `data/.env`
so a stock box runs the full social texture — each is an opt-in, calibration-neutral-when-off engine
layer, and all five + campaigns were heavy-sim'd ON together (juryReach band + calibrationGradient
active≥passive both hold): `ORWELL_CAMPAIGNS` (0085 NPC campaigns/scramble), `ORWELL_COMP_INTENT` (0006b
compete/throw/play-safe), `ORWELL_TRAJECTORIES` (0087 warming/cooling arcs), `ORWELL_TRIGGERS` (0091
secret→house-event eruptions), `ORWELL_SECRET_PACING` (0092 paced secret drip), `ORWELL_JURY_HOUSE`
(0100 jury grudge book), `ORWELL_SEEDED_TIE_SURFACING` (0059 §5 pre-show ties surfacing). Each defaults
**ON in code** (the 2026-11 default flip: the seeded calibration gates, the UAT and the deploy all play the same game; `ORWELL_<FLAG>=0` turns one
off, and `ORWELL_FLAGS_OFF=1` is the single diagnostic switch that forces the whole flipped set OFF — the legacy profile) and the installer still writes them to `data/.env` explicitly. `ORWELL_FLAGS_OFF=1` also wins over the front-end's persisted time-of-day setting (the engine ignores the FE's clock push under it), so it reliably restores the legacy all-off profile. The
engine's `GET /health` reports the live set in a `flags` block, and `orwell doctor` prints an
`info — behavioral flags ON: …` line. Admins can flip any layer at runtime — no restart — from the
God-Mode **setBehavioralFlags** dial (overrides the env default per-sandbox). ADR 0006's
`ORWELL_TIME_OF_DAY` in-game clock is also written ON by the deploy (and backfilled by `orwell-update.sh`); the PO ruling of 2026-11-02 makes it ON everywhere, tests included, with the engine/test default flip tracked separately from this doc — so a
restarted engine boots with the clock running; the front-end re-pushes its own clock setting every
few minutes.

```bash
# fully non-interactive example (the 4 vCPU / 8 GB baseline is the default — shown here explicitly)
export GIT_TOKEN=github_pat_xxx
CTID=104 CORES=4 RAM_MB=8192 DISK_GB=12 NET=dhcp ORWELL_PORT=8080 \
  bash -c "$(curl -fsSL -H "Authorization: Bearer $GIT_TOKEN" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/kevinhirsch/orwell/contents/deploy/orwell.sh?ref=main")" --default
```

## Layout

| File | Role |
|---|---|
| `orwell.sh` | Host-side: create the Proxmox LXC, bootstrap the **git checkout** inside it (persisting `GIT_TOKEN` + the credential helper — A4), then run the **checked-out** in-container installer. |
| `orwell-install.sh` | apt + Node 22 (apt-signed repo, no `curl \| bash`) + Python; checkout; verify + `npm run build`; front-end deps from the **pinned `requirements.lock.txt`** (E83); write `.env` (engine token, multi-user mode); register + start services. Also installs **`qemu-guest-agent`** (Proxmox guest tools). |
| `orwell-update.sh` | `git pull` → `npm run build` → restart — **never touches `data/`** (the save). **A failed update leaves a runnable app:** on any failure after it starts, up to the final service restart (fetch, npm, pip, env/unit reconcile; a service that fails to START after the commit point is NOT reverted — the new build stays and the failure is reported), it restores the previous SHA, reinstalls that SHA's engine + front-end dependencies, restores its `dist`, and **verifies the restored build starts** before it says "reverted" (exit 1; exit 3 = the revert itself failed, said plainly). The `--rollback` pair (`data/.update-prev` + a SHA-stamped `dist.prev`; a build made by the installer or a pre-stamp update has no stamp, so the first `--rollback` rebuilds from source and needs build tooling/network) is replaced only after a fully successful update, so the two always match; `REF=<tag\|sha>` pins (tag, full or abbreviated SHA). One shared `flock` (`/run/orwell-update.lock`) stops the web Update, Update + Reset and a manual run from working in the same tree at once (a second run exits 75). Rollback restores **code, not save-format changes** — a save written by a newer build is not migrated back. Host-aware: on a Proxmox host it bridges into the LXC (`pct`) via its **local copy** (or the in-container copy — never a GitHub fetch); inside the container it runs directly. `--set-token` persists/rotates the deploy PAT. Auto-detects the app dir (`/opt/orwell`, or legacy `/opt/bbai`) and the matching service names. |
| `orwell-factory-reset.sh` | **Wipe back to OOBE.** Stops the services, removes every per-user game sandbox (saves/souls/Vault under `data/<user>/`) and the entire front-end store (`frontend/data/` — DB, settings, uploads, app key), then restarts so the next visit starts at first-run onboarding. **Preserves `data/.env`** (config). Destructive — prompts for `RESET` unless `--yes`; `--dry-run` previews. |
| `orwell-oobe-reset.sh` | **Wipe back to OOBE, but KEEP the API-key / LLM config.** Same scrub as the factory reset (all accounts, chats, memory, MCP configs, settings, uploads, and every game) **except** it preserves the configured LLM/image providers (`model_endpoints`), the LLM-selection settings, and the keys that decrypt them (`.app_key`, `.key`, `api_keys.json`) — so an LLM is still configured at OOBE. Never touches `data/.env`. Delegates the FE-store surgery to `frontend/scripts/oobe_reset.py`. This is the script the admin **Factory Reset (OOBE)** button runs. Destructive — prompts for `RESET` unless `--yes`; `--dry-run` previews. |
| `orwell-update-reset.sh` | **Update, THEN OOBE reset — the combined middle tier (keep the API-key / LLM config).** Composes the two scripts above (re-implements neither): runs `orwell-update.sh --no-restart` (pull → rebuild → refresh FE deps), and **only if it succeeds** runs `orwell-oobe-reset.sh --yes` (wipe to first-run, preserve the LLM config, single final restart). **Fail-closed** — a failed update never wipes (and if the update's own automatic revert failed, it says so instead of claiming the box is on its previous build); a missing reset helper refuses up front. Holds the shared update lock across both phases. Never touches `data/.env`. This is the script the admin **Update + Reset** button runs. Host-aware bridge + `--yes` / `--dry-run` / `--no-restart`; prompts for `RESET` unless `--yes`. |
| `orwell-rebuild.sh` | **DESTROY the LXC and re-provision a fresh one — keep ONLY the deploy token.** Host-only (needs `pct`; refuses inside a container). Captures the old container's cores/RAM/disk/`net0`/hostname + UI port, salvages `GIT_TOKEN` (without printing it), writes a timestamped safety-net backup of `data/` + `frontend/data/` to the host (`/var/lib/orwell-backups/`), then — **only if both the token and the backup succeeded** — `pct stop`/`pct destroy`s the old box and re-runs the local `orwell.sh --default` with the captured params. Lands at OOBE (re-enter the LLM key once; re-run the public-exposure wizard if the box was public). Destructive — prompts for `RESET` unless `--yes`; `--dry-run` previews. |
| `frontend/scripts/oobe_reset.py` | The keep-API-keys FE-store surgery: export `model_endpoints` + the LLM-selection settings, rebuild a fresh `app.db` / `settings.json` carrying ONLY those, so no other table survives. Stdlib-`sqlite3` only (no SQLAlchemy/`core`); idempotent; honors `DATA_DIR` / `DATABASE_URL`. |
| `systemd/orwell-engine.service` | `npm start` (the MCP server). |
| `systemd/orwell-frontend.service` | `uvicorn app:app` (Orwell), reads `ORWELL_ENGINE_MCP_URL`. |
| `systemd/orwell-ops-update.path` | Root-side watcher (G19b): `PathExists=` on `data/ops/update-requested` (written by the sandboxed FE) → starts the runner. Existence-only — flag content is never parsed or executed. |
| `systemd/orwell-ops-update.service` | Oneshot **root** runner (G19b — deliberately unsandboxed; the unit documents why): removes the flag first, takes a `flock`, runs **only** `deploy/orwell-update.sh`, output appended to `data/ops-update.log` (tailed live by the status page). |
| `systemd/orwell-ops-factory-reset.path` | Root-side watcher for the admin **Factory Reset (OOBE)** button: `PathExists=` on `data/ops/factory-reset-requested` → starts the reset runner. Existence-only, same contract as the update watcher. |
| `systemd/orwell-ops-factory-reset.service` | Oneshot **root** runner: removes the flag first, takes a `flock`, runs **only** `deploy/orwell-oobe-reset.sh --yes` (the browser already confirmed `RESET`), output appended to `data/ops-factory-reset.log`. |
| `systemd/orwell-ops-update-reset.path` | Root-side watcher for the admin **Update + Reset** button: `PathExists=` on `data/ops/update-reset-requested` → starts the combined runner. Existence-only, same contract as the other watchers. |
| `systemd/orwell-ops-update-reset.service` | Oneshot **root** runner: removes the flag first, takes a `flock`, runs **only** `deploy/orwell-update-reset.sh --yes` (update with restart suppressed, then OOBE reset with the single final restart; fail-closed), output appended to `data/ops-update-reset.log`. |
| `orwell-backup.sh` | Snapshot `data/` (engine `.env` + saves) + `frontend/data/` (FE SQLite + uploads) to `<app>/backups/orwell-backup-<timestamp>.tar.gz`. Also prunes backups older than `ORWELL_BACKUP_RETENTION_DAYS` (default `30`; `0` disables pruning) every time it runs — manual (`orwell backup`) or scheduled. |
| `orwell-restore.sh` | Restore a snapshot written by `orwell-backup.sh` (stops services, extracts, restarts). |
| `systemd/orwell-backup.timer` | **DEPLOY-9 (2026-07-05):** runs `orwell-backup.service` daily (`RandomizedDelaySec=30m`, `Persistent=true` — a box that was off at the scheduled time catches up at next boot). This is the ONLY automated backup trigger; before this, backups were 100% manual. |
| `systemd/orwell-backup.service` | Oneshot, runs as the unprivileged `orwell` user (same E85 posture as the app units): `bash deploy/orwell-backup.sh` with no arguments (default dest + retention). No `[Install]` section — only the `.timer` is ever enabled directly, same pattern as the ops path units above. |
| `logrotate/orwell` | **DEPLOY-13 (2026-07-05):** installed verbatim to `/etc/logrotate.d/orwell` — weekly rotation, keep 4, compress, of the five `data/ops-*.log` files (the G19b trigger units append to these forever otherwise). |
| journald cap | **DEPLOY-14 (2026-07-05):** `orwell-install.sh`'s `log_management()` writes `/etc/systemd/journald.conf.d/orwell.conf` with `SystemMaxUse=${ORWELL_JOURNAL_MAX_USE:-300M}` so the two long-running services' journal entries can't slow-burn toward disk exhaustion on a small LXC disk. |

## Proxmox guest tools

`qemu-guest-agent` is installed by `orwell-install.sh`, but it is a **VM-only** transport
(virtio-serial) that does not exist in an LXC. The installer therefore **enables it only when that
transport is present** (a real VM); in an LXC it stays installed-but-dormant — the Proxmox host
already manages the container directly (IP in the UI, `pct shutdown`, vzdump backups all work
without an agent), and this avoids a perpetually-failing systemd unit. If a VM deploy mode is added
later, set `qm set <vmid> --agent enabled=1` host-side and the pre-installed agent activates.

## Validation & remaining wiring

- **Automated smoke:** [`deploy/smoke.sh`](./smoke.sh) builds + starts the engine, probes the HTTP
  MCP surface, exercises the player game tools (`createCharacter` → `getGameState` →
  `getMomentPrompt` → `runCompetition`, and proves the removed `resolveCompetition` is refused —
  audit E20), proves channel isolation, and simulates an update (rebuild + restart) — asserting
  **behaviorally** that the pre-update game resumes from disk and the update script never deletes
  the save (E80), that no hidden-layer NUMBER (`physical`/`mental`/`social`/`trust`/`affinity`/
  `threat`) leaks from a player surface, that the **A4 credential helper** hands git the `.env`
  token, and that no deploy script fetches from `raw.githubusercontent.com` (E84). It runs
  offline, locally and in CI (`.github/workflows/ci.yml`).
- **On-host validation** (the full Proxmox-LXC provisioning: provision → one-liner install → curl the
  UI → update → assert the save survived) is **WON'T-DO** — owner ruling 2026-07-14: no hardware
  validation will be run, so the previously-owed real-Proxmox `orwell.sh`/`orwell-update.sh` host smoke
  (#0010) is **retired, not owed**. The `pct`/`pvesh` host-bridge paths (provision, systemd, chown)
  are covered by `install.sh`-parity tracing + the deploy-reconcile drift test, not by a live host run.
  Everything that CAN run without hardware runs in CI (the automated smoke above, offline).
- Two pieces complete the end-to-end game and are owned outside these scripts:
  1. the engine's **HTTP MCP transport** + `build`/`start` entrypoint (the implementer);
  2. the **Orwell → engine MCP** client wiring (`frontend/INTEGRATION.md`).
  The scripts already provision and run both services and pass the engine endpoint via
  `ORWELL_ENGINE_MCP_URL`; once 1 & 2 land, the one-liner yields a playable game.

All secrets live in `/opt/orwell/data/.env` — never committed.
