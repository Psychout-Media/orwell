# deploy/runners/ — Proxmox GitHub Actions self-hosted runners

> ## WARNING — never register self-hosted runners on a PUBLIC repository
>
> `Psychout-Media/orwell` is **public**. On a public repo anyone can open a pull request, and a PR's
> workflow file chooses its own `runs-on:` — so a PR containing `runs-on: self-hosted` runs
> attacker-chosen code on these runners (and from there on your LAN and the Proxmox host's other
> guests). Approval settings for outside contributors narrow this; they do not remove it.
>
> - [`ci.yml`](../../.github/workflows/ci.yml) runs on GitHub-hosted `ubuntu-latest`; it does **not**
>   need these runners.
> - `orwell-provision-runners.sh` **refuses** a public repo (and one it cannot verify as private)
>   unless you pass `--allow-public-repo` (env `ALLOW_PUBLIC_REPO=1`). Don't, unless the repo is
>   private or you have accepted the risk. `--remove` is never blocked. Only an authenticated API
>   answer of `private: true` passes: with `--reg-token` (no PAT) the check cannot confirm privacy, so
>   it refuses unless `--allow-public-repo` is given.
> - Runners are registered `--ephemeral` (one job, then de-registered). That limits how long a
>   runner stays exposed to a job; it is **not** a sandbox for hostile code.

`orwell-provision-runners.sh` spins up N **GitHub Actions self-hosted runners** as Proxmox LXC
containers so a repo's CI — when its workflow targets `runs-on: self-hosted` (as
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) did before it moved to gh-hosted runners) — can run its jobs (the engine gate,
the sharded heavy-sims lanes, coverage, deploy-smoke, and the front-end Playwright job) **in
parallel** instead of queuing on one box. Default target: **6 runners**.

It mirrors the house style of [`../orwell.sh`](../orwell.sh) / [`../orwell-install.sh`](../orwell-install.sh):
`set -euo pipefail`, the Proxmox host guards (`pct`/`pveam`), inline colour that auto-disables off a
TTY, whiptail-with-plain-fallback, env-overridable defaults, and the **no-secret-on-a-command-line**
discipline — the PAT and the short-lived runner token are pushed in via `pct push` of a `0600` temp
file, never on a `pct exec` argument that would land in host `ps`.

## What it does

Runs on the **Proxmox host**. For each runner `i` in `1..COUNT` it:

1. Creates an **unprivileged** LXC (`pct create`, `nesting=1`, `onboot=1`) from an Ubuntu standard
   template, and starts it.
2. Installs inside: `curl`/`git`/`jq`, the **chromium system libraries Playwright needs** (the
   explicit apt set **plus** `python3 -m playwright install-deps chromium` as a top-up, so the
   browser tests launch headless with no per-run `sudo`), **Node 22** (NodeSource apt repo,
   `signed-by` — no `curl | bash` as root), **Python 3.12 + venv/pip**, and the latest
   **`actions/runner`** linux-x64 agent.
3. Creates a **non-root** `runner` user and registers the agent **non-interactively** as that user:
   `./config.sh --url https://github.com/Psychout-Media/orwell --token <regtoken> --name
   orwell-runner-<i> --labels self-hosted --unattended --replace --ephemeral`.
4. Installs it as a **systemd service** (`./svc.sh install runner && ./svc.sh start`). Because the
   runner is `--ephemeral` it takes **one job, then GitHub de-registers it** — re-run the script
   (idempotent, `--replace`) to refill the pool.

### The PAT never enters a container

The PAT (read from `GIT_TOKEN`, `--token`, or a `GIT_TOKEN=` line in `data/.env`) stays on the
**host**. It is used only to mint a **short-lived registration token** per runner via the GitHub
REST API (`POST /repos/Psychout-Media/orwell/actions/runners/registration-token`, ~1h TTL). Only that
token is passed inside, where `./config.sh` consumes it immediately. `--remove` mints a matching
**remove token** the same way.

## Usage

On the Proxmox host shell:

```bash
export GIT_TOKEN=github_pat_xxx          # PAT with repo + self-hosted-runner-registration scope
bash deploy/runners/orwell-provision-runners.sh                  # 6 runners (2 vCPU / 3 GB / 20 GB each)
bash deploy/runners/orwell-provision-runners.sh --count 3
bash deploy/runners/orwell-provision-runners.sh --count 4 --cores 4 --mem-mb 6144 --disk-gb 30
```

The PAT can also live in the same `data/.env` the other deploy scripts use (git-ignored); the script
reads `GIT_TOKEN=` from there automatically (override the path with `--env-file`).

**PAT scope:** `repo` **plus** self-hosted-runner registration —
- classic PAT: `repo` + `admin:org` (org runners) / repo-admin (repo runners);
- fine-grained PAT: this repo, **Administration: Read & write** (+ Contents: Read).

### Remove

```bash
bash deploy/runners/orwell-provision-runners.sh --remove --count 6 --ctid-base 9100
```

Unregisters each runner cleanly (`./config.sh remove --token <removetoken>`) and destroys its LXC.
Absent CTIDs are skipped, not errored.

### Re-runnable / idempotent

Re-running is safe: an existing CTID is **re-provisioned in place** (`config.sh --replace` cleanly
supersedes the prior registration of the same name), never an error.

## Options

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--count N` | `COUNT` | `6` | Number of runners |
| `--cores N` | `CORES` | `2` | vCPU per runner |
| `--mem-mb N` | `MEM_MB` | `3072` | RAM (MB) per runner |
| `--disk-gb N` | `DISK_GB` | `20` | Root disk (GB) per runner |
| `--ctid-base N` | `CTID_BASE` | `9100` | Starting CTID; runner `i` uses `base + i - 1` |
| `--bridge NAME` | `BRIDGE` | `vmbr0` | Network bridge |
| `--net VALUE` | `NET` | `dhcp` | `dhcp`, or a static CIDR base (runner `i` = base IP + `i-1`) |
| `--gateway IP` | `GATEWAY` | — | Gateway (static `--net` only) |
| `--storage NAME` | `STORAGE` | auto | rootfs storage (first active `rootdir`, else `local-lvm`) |
| `--template-storage N` | `TEMPLATE_STORAGE` | auto | vztmpl storage (first active `vztmpl`, else `local`) |
| `--template NAME` | `TEMPLATE` | newest Ubuntu | LXC template name, or `storage:vztmpl/name` |
| `--name-prefix S` | `NAME_PREFIX` | `orwell-runner` | CT hostname / runner name prefix |
| `--runner-version V` | `RUNNER_VERSION` | latest | `actions/runner` version (no `v`); empty = resolve latest |
| `--token PAT` | `GIT_TOKEN` | — | GitHub PAT (prefer the env var) |
| `--env-file PATH` | `ENV_FILE` | `<repo>/data/.env` | Where to read `GIT_TOKEN=` |
| `--allow-public-repo` | `ALLOW_PUBLIC_REPO=1` | off | **Dangerous.** Allow a public (or unverifiable) repo — see the warning above |
| `--remove` | `REMOVE=1` | off | Unregister + destroy mode |
| `--yes` / `-y` | `ORWELL_NONINTERACTIVE=1` | off | Skip the confirmation prompt |
| `-h`, `--help` | — | — | Help |

## Verify

After provisioning, check the GitHub UI:

**Settings → Actions → Runners** — `https://github.com/Psychout-Media/orwell/settings/actions/runners`

Each runner should appear **Idle** with the `self-hosted` label. Then any push that triggers
[`ci.yml`](../../.github/workflows/ci.yml) fans its jobs across them.

Inside a runner: `pct enter <CTID>` then `systemctl status 'actions.runner.*'`.

## Notes

- Sizing: 6 × (2 vCPU / 3 GB / 20 GB) ≈ 12 vCPU / 18 GB / 120 GB across the runners. The heavy-sims
  shards are CPU-bound; the front-end job wants the chromium libs (installed). Tune with the flags.
- These containers are **CI runners only** — separate from the application LXC that
  [`../orwell.sh`](../orwell.sh) provisions. Keep their CTID range distinct (the `9100+` default
  avoids the app's `900`/`next-id` range).
