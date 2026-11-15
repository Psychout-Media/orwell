# Installing & updating Orwell

Orwell runs as **two co-located services in one container**:

- **engine** — TypeScript, the MCP server: game rules, the Vault, the permissioned tool API.
- **front-end** — Orwell (Python/FastAPI): the chat UI + LLM connection + agent.

They talk over **local MCP**. The Vault Wall holds: the front-end only ever receives visible
projections, never Vault data.

---

## Requirements

- **Recommended:** a Proxmox VE host (the one-liner creates an LXC for you).
- **Or** any Debian/Ubuntu box with **Node 22+**, **Python 3.12+**, and **git**.
- **An LLM:** a local **Ollama**, or an API key (Anthropic / OpenAI / OpenRouter / …).

---

## Quick install (Proxmox)

The repo is **private**: create a fine-grained PAT once (scope: `Psychout-Media/orwell`,
**Contents: Read-only**, nothing else), then run on the **Proxmox host shell** — this is the
**single authenticated moment**; the token is persisted into the container's `data/.env` and
every later update/reset reads it from there via a git credential helper (no re-prompt, never
in a URL or `.git/config`):

```bash
export GIT_TOKEN=github_pat_xxx   # fine-grained (Contents: Read-only) OR classic (repo scope)
bash -c "$(curl -fsSL -H "Authorization: Bearer $GIT_TOKEN" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/Psychout-Media/orwell/contents/deploy/orwell.sh?ref=main")"
```

This creates a Debian LXC and installs everything. Override defaults via env before the command:
`CTID`, `CORES`, `RAM_MB`, `DISK_GB`, `BRIDGE`, `STORAGE`, `ORWELL_PORT`. When it finishes it prints
the UI URL.

Fine-grained PATs cap at one year: rotate with `bash /opt/orwell/deploy/orwell-update.sh
--set-token` (also the one-time setup path for an install that predates the private flip).

---

## Configuration — `/opt/orwell/data/.env`

| Variable | Meaning | Default |
|---|---|---|
| `ORWELL_PORT` | front-end UI port | `8080` |
| `ORWELL_ENGINE_PORT` | engine MCP server (loopback) | `8765` |
| `ORWELL_ENGINE_HOST` | engine bind address | `127.0.0.1` |
| `ORWELL_ENGINE_MCP_URL` | front-end → engine | `http://127.0.0.1:8765` |
| `ORWELL_ENGINE_TOKEN` | shared secret required on every engine tool call (the installer generates one) | set by installer |
| `ORWELL_ENGINE_MULTIUSER` | reject a request with no `x-orwell-user` instead of routing to a shared `default` sandbox | `1` (set by installer) |
| `GIT_TOKEN` | the deploy PAT (private repo) — read by the git credential helper at fetch time | set by installer |
| `SECURE_COOKIES` | set `true` behind TLS: front-end session cookies get the `Secure` flag | — (off) |
| `OLLAMA_HOST` **or** `ANTHROPIC_API_KEY` | the LLM (set one) | — |

After editing: `systemctl restart orwell-engine orwell-frontend`.

> **Changing the UI port?** Use `orwell change-port <port>` (below) rather than hand-editing
> `ORWELL_PORT`. Moving to a privileged port (**<1024, e.g. 80**) needs a systemd
> `CAP_NET_BIND_SERVICE` drop-in — the hardened front-end runs unprivileged and can't otherwise
> bind below 1024 — and moving back above 1024 removes it. The script handles that hinge (and the
> restart + verify) for you; a hand-edit to `80` alone would leave the front-end unable to bind.

---

## Control panel — the `orwell` command

Inside the container, **`orwell`** opens a whiptail menu over every maintenance task — no need to
remember script paths or flags:

```bash
orwell            # menu: update · doctor · backup · restore · change-port · reset (game/oobe/factory) · readiness
```

It dispatches to the scripts below, collecting input through dialogs (a deploy-token password box,
a backup picker, a type-`RESET` confirmation for the destructive resets). Direct subcommands skip
the menu — handy over SSH or in scripts:

```bash
orwell update             # = orwell-update.sh        orwell doctor --status
orwell update-reset --yes # update, THEN OOBE reset — KEEP the API-key / LLM config (fail-closed)
orwell backup             # orwell restore [FILE]     orwell ready
orwell change-port 80     # change the UI port — handles to/from :80 (the CAP_NET_BIND_SERVICE drop-in) + restart
orwell reset-game --yes   # destructive: --yes required off the menu
orwell reset-oobe --yes   # back to OOBE, KEEP the API-key / LLM config
orwell reset-factory --yes
```

The three reset tiers, narrowest to widest: **`reset-game`** clears only the games (keeps
accounts + the LLM config); **`reset-oobe`** wipes everything back to first-run **but keeps the
API-key / LLM-provider config** (so an LLM is still configured — also the admin status page's
**Factory Reset (OOBE)** button); **`reset-factory`** is the full wipe (drops the LLM config too).
All three preserve `data/.env`.

**`update-reset`** is the combined middle tier — the maintenance controls read as a set **Update ·
Update + Reset · Reset**. It runs the update (pull + rebuild) **and then** the OOBE reset (keeping
the API-key / LLM config) in one action, and is **fail-closed**: if the update fails, the wipe does
not run and nothing is removed. It is the admin status page's **Update + Reset** button.

The individual scripts (`deploy/orwell-*.sh`) also show these dialogs when run directly on a
terminal, and stay fully non-interactive (today's flags/env) for automation, CI, and the
host→container bridge. whiptail is installed by the installer; without it (or off a TTY) the
scripts fall back to plain prompts. The launcher is `deploy/orwell-menu.sh`; the shared dialog
helpers live in `deploy/orwell-tui.sh`.

---

## Update

Run the **local checked-out copy** — no script fetches from GitHub anymore (the repo is private;
`git pull` authenticates via the credential helper + `GIT_TOKEN` in `data/.env`):

```bash
# inside the container — or from the Proxmox host with a checkout (it bridges into the LXC)
bash /opt/orwell/deploy/orwell-update.sh
```

Pulls latest, rebuilds the engine (`npm run build`), refreshes front-end deps from the pinned
`requirements.lock.txt`, and restarts both services. **Your save (`/opt/orwell/data`) is never
touched.**

---

## Manual / non-Proxmox install

```bash
# Private repo: authenticate the clone once with your PAT, then keep the token OUT of git config
# (the credential helper reads it from data/.env at fetch time — set it up below).
git -c credential.helper='!f(){ echo username=x-access-token; echo password=$GIT_TOKEN; };f' \
  clone https://github.com/Psychout-Media/orwell.git /opt/orwell && cd /opt/orwell
npm ci && npm run build                                  # engine
( cd frontend && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.lock.txt )
mkdir -p data && cp frontend/.env.example data/.env      # then edit data/.env (LLM + ports)
echo "GIT_TOKEN=github_pat_xxx" >> data/.env && chmod 600 data/.env
git config --system credential.helper \
  '!f(){ echo username=x-access-token; echo "password=$(sed -n s/^GIT_TOKEN=//p /opt/orwell/data/.env)"; };f'

# run the two services (e.g. in two shells, or use the units in deploy/systemd/):
npm start                                                # engine — MCP server
( cd frontend && ./.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8080 )  # front-end UI (loopback)
```

> The FE binds **loopback** by default (feature 0067). For a public deploy, keep it on loopback and
> put a TLS-terminating proxy / tunnel in front — see **Public deployment (any domain)** below.

Persistent setup: install the units from `deploy/systemd/` and `systemctl enable --now
orwell-engine orwell-frontend`.

---

## Services & logs

```bash
systemctl status orwell-engine orwell-frontend
journalctl -u orwell-engine -f
journalctl -u orwell-frontend -f
```

---

## Data & backups

State lives in **two** places (B72 — the old prose misstated this):

| Dir | What |
|---|---|
| `/opt/orwell/data/` | engine config — `.env` (incl. the generated `ORWELL_ENGINE_TOKEN`) — and **`saves/`** (the per-user games: JSON snapshots incl. souls + the hidden layer) |
| `/opt/orwell/frontend/data/` | the front-end SQLite (`app.db`: accounts, chats, settings) + uploads |

- **Backup:** `bash deploy/orwell-backup.sh [dest]` — one timestamped tarball covering **both** dirs.
- **Restore:** `bash deploy/orwell-restore.sh <backup.tar.gz>` — stops services, restores, fixes
  ownership, restarts.
- **Readiness:** `bash deploy/orwell-ready.sh` — not just liveness: engine reachable + front-end up
  + an LLM genuinely configured (at least one online model). Exit 0 = a player can sit down and play.
- **Update pin/rollback (B71):** `REF=<sha|tag> orwell-update.sh` pins (a tag, a full SHA, or an
  abbreviated SHA); `orwell-update.sh --rollback` returns to the previous SHA + its build. A failed
  update never restarts services: it restores the previous SHA, its dependencies and its build and
  verifies they start (the engine is booted on a throwaway port; the front-end dependencies are import-checked, not started) before reporting "reverted" (and says plainly if even that fails). Only one
  update / rollback / Update + Reset runs at a time. Rollback restores **code**, not save-format
  changes — a save written by a newer build is not migrated back.

Updates never touch either data dir (non-degradation, feature 0007).

---

## Security

- Secrets (LLM keys) live **only** in `/opt/orwell/data/.env` — never committed.
- The engine MCP server binds **loopback** (`ORWELL_ENGINE_HOST=127.0.0.1`); only the front-end UI
  port is exposed. **Engine auth is ON by default** (B67): the installer generates a shared
  `ORWELL_ENGINE_TOKEN` into `data/.env` — the engine enforces it on every tool route (401 without
  it) and the front-end sends it automatically (`Authorization: Bearer …`; `BBAI_ENGINE_TOKEN` is
  the legacy fallback). **Multi-user mode is also ON by default** (audit E32): the installer sets
  `ORWELL_ENGINE_MULTIUSER=1` — every request must assert its `x-orwell-user`, and an anonymous
  front-end call sends NO user header (it is refused, never silently collapsed into a shared
  `default` sandbox). The engine caps the asserted user id at 64 chars and compares the bearer
  token in constant time. Behind TLS, also set `SECURE_COOKIES=true`.
- Each container is its own **sandbox** (one game namespace). The **Vault Wall** keeps secret game
  state off every player-facing surface — enforced structurally, not by prompt.
- **Admin buttons that run as root** (Update, Update + Reset, Factory Reset, Local HTTPS, Public
  deployment) are guarded server-side, not just in the page: the caller must be an authenticated admin;
  the request must come from Orwell's own pages (its `Origin` / `Referer` must match the address you
  browse to — plain `http://<LAN-IP>:<port>` works); the two destructive resets also require the typed
  `RESET` to be sent with the request; and a button only reports "started" when its root watcher unit
  (`orwell-ops-*.path`) is **active** (otherwise it says so and queues nothing — fix with
  `systemctl enable --now orwell-ops-<name>.path` or re-run the updater).
  - **Auth disabled (`AUTH_ENABLED=false`, loopback-only installs):** these buttons work from a browser
    on the same machine (a direct loopback connection, e.g. `http://127.0.0.1:<port>` or an SSH
    tunnel). They are refused through a reverse proxy; either enable authentication (recommended) or
    set `ORWELL_ROOT_OPS_WITHOUT_AUTH=1` in `data/.env` if you accept that risk, or use the `orwell`
    control panel on the host.
  - **Behind a reverse proxy / tunnel:** pass the original `Host` header (`X-Forwarded-Host` is also
    honored) or list your public address in `ALLOWED_ORIGINS`; otherwise the buttons answer
    "Cross-origin request refused".

---

## Local HTTPS (trusted on every device, no domain needed)

Serve the game over **HTTPS on your LAN** — `orwell.lan`, `orwell.local`, and the box's IP — with
**no browser "your connection is not private" warning**. Feature **0074** / ADR **0014**. This works
**whether or not** the public domain below is configured, and never touches the engine (it stays
loopback-only). Manage it from the **control panel** or the **in-app Admin "Local HTTPS" card**.

```bash
orwell https                 # interactive (control-panel TUI)
orwell https --mode local    # or non-interactive: enable on orwell.lan/orwell.local + the LAN IP
orwell https --disable       # back to plain HTTP
```

This stands up a **Caddy** TLS terminator in front of the front-end (the FE stays on loopback; only
Caddy faces the LAN), sets `SECURE_COOKIES=true`, and writes the tunable knobs to `data/.env`
(`ORWELL_TLS_MODE`, `ORWELL_TLS_LOCAL_NAMES`, …). The local names use a **built-in certificate
authority**.

**Killing the warning (one time per device).** Private names can't get a public cert, so each device
trusts our CA root **once**:

1. Download it (no login needed): **`https://orwell.lan/orwell-local-ca.crt`** (or via the IP).
2. Install it as a **trusted root**: macOS → Keychain ▸ *System* ▸ *Always Trust* · Windows → *Local
   Machine* ▸ *Trusted Root Certification Authorities* · iOS → install the profile, then *Settings ▸
   General ▸ About ▸ Certificate Trust* ▸ enable · Android → *Settings ▸ Security ▸ Install a
   certificate ▸ CA certificate*.

After that, `https://orwell.lan` (and the IP) load clean on that device. Make sure the names resolve
on your network — `orwell.local` works out of the box via mDNS; `orwell.lan` needs a router/DNS entry.

**Zero per-device install (optional upgrade).** If you own a domain and a DNS provider API token, add a
**publicly-trusted** cert via a DNS-01 challenge — then there's no warning *and* no per-device install,
because the issuer is already trusted everywhere:

```bash
orwell https --mode local --domains orwell.hiorwell.com \
             --dns-provider cloudflare --dns-token <DNS_API_TOKEN>
```

Point that name at the box's LAN IP (split-horizon DNS) and it's trusted on every device with no setup.

---

## Public deployment (any domain)

Putting the player tier on the open internet — feature **0067** / ADR **0007**. Two halves: a
**hardening floor** (below, mandatory) and an **exposure layer** (recommended: **Cloudflare Tunnel +
Access**). Reference configs for every option live in **[`deploy/expose/`](../deploy/expose/)**.

**The engine never goes public.** It stays bound to loopback (`ORWELL_ENGINE_HOST=127.0.0.1`) and is
never named in any tunnel/proxy config — only the front-end is exposed, and it only ever serves
Vault-free projections of the player's own game.

### 1. Turn on the public profile (the FE refuses to boot otherwise)

In `data/.env`:

```ini
ORWELL_PUBLIC=1                                  # arms the fail-closed boot guard
AUTH_ENABLED=true                                # never disable on a public host
LOCALHOST_BYPASS=false
SECURE_COOKIES=true                              # session cookies get the Secure flag (you're behind TLS)
ALLOWED_HOSTS=your-domain.example,www.your-domain.example      # Host-header pin (TrustedHostMiddleware)
ALLOWED_ORIGINS=https://your-domain.example             # CORS
# ORWELL_BIND_HOST stays 127.0.0.1 (the default) — the proxy/connector reaches the FE on loopback.
```

With `ORWELL_PUBLIC=1`, the FE **refuses to start** if auth is off, the localhost bypass is on,
cookies aren't secure, or the Host isn't pinned — failing closed instead of serving the game in the
clear. The login throttle keys on the **real client IP** from the trusted proxy header
(`CF-Connecting-IP` / `X-Forwarded-For`), not the tunnel's `127.0.0.1`.

### 2. Expose the front-end (recommended: Cloudflare Tunnel + Access)

Outbound-only — the origin opens **zero inbound ports** — with free DDoS + WAF and an email-OTP
login wall in front. On the LXC:

```bash
cloudflared tunnel login                         # pick the your-domain.example zone
cloudflared tunnel create orwell
cloudflared tunnel route dns orwell your-domain.example
sudo cp deploy/expose/cloudflared/config.yml /etc/cloudflared/config.yml   # fill in <TUNNEL-UUID>
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

Then in the Cloudflare dashboard: enable the **WAF Free Managed Ruleset** + **Bot Fight Mode**, and
add an **Access** application over `your-domain.example` (email-OTP allow-list). Self-hosted-control
alternatives — **Pangolin on a VPS** (`deploy/expose/pangolin/`) and **plain VPS + Caddy**
(`deploy/expose/caddy/`) — are in `deploy/expose/README.md`.

### 3. Harden the host

```bash
sudo MODE=tunnel bash deploy/expose/host-hardening.sh   # ufw (deny inbound) + fail2ban + auto-updates
```

Under a tunnel, the only inbound port is SSH (key-only). Schedule `orwell-backup.sh` **off-host** and
test a restore.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `engine 'build'/'start' scripts not found` | the engine entrypoint hasn't landed on your branch — update and retry |
| UI not reachable | `systemctl status orwell-frontend`; check the firewall on `ORWELL_PORT` |
| Engine won't start | `journalctl -u orwell-engine -e`; confirm `npm run build` succeeded |
| LLM errors | confirm `OLLAMA_HOST` is reachable or `ANTHROPIC_API_KEY` is set in `.env` |

---

## See also

- [`deploy/README.md`](../deploy/README.md) — deploy internals + the engine contract.
- [`docs/features/0010-deployment-one-liner.md`](features/0010-deployment-one-liner.md) — the deployment spec.
