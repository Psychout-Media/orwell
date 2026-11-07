#!/usr/bin/env bash
#
# orwell — Proxmox provisioner for GitHub Actions self-hosted CI runners.
#
# Runs on the Proxmox HOST (uses `pct`). Spins up N unprivileged Debian/Ubuntu LXCs, each running
# one auto-restarting GitHub Actions runner agent registered to Psychout-Media/orwell with the default
# `self-hosted` label — exactly what `.github/workflows/ci.yml` (`runs-on: self-hosted`) targets.
# With several runners the engine, heavy-sims shards, coverage, deploy-smoke and front-end jobs
# fan out in parallel instead of queuing on a single box.
#
# Mirrors deploy/orwell.sh house style: `set -euo pipefail`, inline colour that auto-disables off a
# TTY / under NO_COLOR / TERM=dumb, whiptail-with-plain-fallback, env-overridable defaults, the
# Proxmox host guards, and the no-secret-on-a-command-line discipline (the PAT and the registration
# token are pushed into the container via `pct push` of a 0600 temp file, never on a `pct exec` arg).
#
# !! NEVER attach self-hosted runners to a PUBLIC repo: a pull request chooses its own `runs-on:`,
# !! so any PR could run arbitrary code on these boxes. The script REFUSES a public repo unless you
# !! pass --allow-public-repo, and registers every runner --ephemeral (one job, then de-registered).
#
# THE PAT IS NEVER BAKED INTO A CONTAINER. The host uses it only to mint a SHORT-LIVED runner
# REGISTRATION TOKEN per runner (POST …/actions/runners/registration-token, ~1h TTL); only that
# token is passed inside, and `./config.sh` consumes it immediately. Same for --remove (a remove
# token). The PAT stays on the host, read from env or an existing data/.env (git-ignored).
#
# Quick start (on the Proxmox host shell):
#   export GIT_TOKEN=github_pat_xxx          # repo + admin (self-hosted runner registration) scope
#   bash deploy/runners/orwell-provision-runners.sh                 # 6 runners, defaults
#   bash deploy/runners/orwell-provision-runners.sh --count 3       # 3 runners
#   bash deploy/runners/orwell-provision-runners.sh --remove        # unregister + destroy them all
#
set -euo pipefail

TITLE="orwell runners"

# ── Presentation (inline — this script stays standalone; it does not source the TUI lib, mirroring
# orwell.sh). Colour auto-disables off a TTY / under NO_COLOR / TERM=dumb. Pure echo. ─────────────
if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" ]]; then
  C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'; C_GRN=$'\e[32m'; C_RED=$'\e[31m'; C_CYN=$'\e[36m'; C_OFF=$'\e[0m'
else
  C_BOLD=""; C_DIM=""; C_GRN=""; C_RED=""; C_CYN=""; C_OFF=""
fi
msg()  { echo -e "${C_CYN}▸${C_OFF} $*"; }
warn() { echo -e "${C_RED}!${C_OFF} $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# ── Constants ───────────────────────────────────────────────────────────────────────────────────
OWNER_REPO="${OWNER_REPO:-Psychout-Media/orwell}"
REPO_URL="https://github.com/${OWNER_REPO}"
API="https://api.github.com/repos/${OWNER_REPO}"
RUNNER_LABELS="self-hosted"          # the label .github/workflows/ci.yml targets (runs-on: self-hosted)
RUNNER_USER="runner"                 # the NON-root user the agent runs as inside each LXC
RUNNER_HOME="${RUNNER_HOME:-}"       # derived per-repo AFTER flag parse (default /opt/actions-runner[-<repo>])

usage() {
  cat <<EOF
${C_BOLD}orwell-provision-runners.sh${C_OFF} — provision GitHub Actions self-hosted runners as Proxmox LXCs.

Run on the Proxmox HOST (needs ${C_BOLD}pct${C_OFF}/${C_BOLD}pveam${C_OFF}). Each runner registers to
${OWNER_REPO} with the default '${RUNNER_LABELS}' label, ${C_BOLD}--ephemeral${C_OFF} (one job, then GitHub
de-registers it; re-run this script to refill the pool), as a systemd service.

${C_RED}${C_BOLD}WARNING${C_OFF}: never use self-hosted runners on a PUBLIC repo — a PR picks its own runner and can
run arbitrary code on it. Public repos are refused unless ${C_BOLD}--allow-public-repo${C_OFF} is given.

${C_BOLD}USAGE${C_OFF}
  $(basename "$0") [options]
  $(basename "$0") --remove [options]      unregister + destroy the runner LXCs

${C_BOLD}AUTH${C_OFF} (one of, in order)
  GIT_TOKEN env, or --token <pat>, or a GIT_TOKEN= line in --env-file (default data/.env).
  Needs a PAT with ${C_BOLD}repo${C_OFF} + self-hosted-runner-registration scope
  (classic: repo + admin:org / repo admin; fine-grained: Administration: Read & write).
  The PAT NEVER enters a container — it only mints a short-lived registration token per runner.

${C_BOLD}OPTIONS${C_OFF} (env var in parens; flag overrides env)
  --count N            Number of runners to provision           (COUNT, default 6)
  --cores N            vCPU per runner                          (CORES, default 2)
  --mem-mb N           RAM per runner, MB                       (MEM_MB, default 3072)
  --disk-gb N          Root disk per runner, GB                 (DISK_GB, default 20)
  --ctid-base N        Starting CTID; runner i uses base+i-1    (CTID_BASE, default 9100)
  --bridge NAME        Network bridge                           (BRIDGE, default vmbr0)
  --net VALUE          'dhcp' or a per-runner static CIDR base  (NET, default dhcp)
  --gateway IP         Gateway (only for a static --net)        (GATEWAY)
  --storage NAME       rootfs storage                           (STORAGE, auto-detected)
  --template-storage N vztmpl storage                           (TEMPLATE_STORAGE, auto-detected)
  --template NAME      Ubuntu LXC template name or storage:ref  (TEMPLATE)
  --name-prefix S      CT hostname / runner name prefix         (NAME_PREFIX, default orwell-runner)
  --runner-version V   actions/runner version, no 'v' (e.g. 2.319.1); empty = latest (RUNNER_VERSION)
  --token PAT          GitHub PAT (prefer GIT_TOKEN env)        (GIT_TOKEN)
  --reg-token TOK      Pre-minted registration token (Settings → Actions → Runners → New runner);
                       provisions with NO PAT — one token registers all runners  (REG_TOKEN_IN)
  --repo OWNER/NAME    Target repository (default Psychout-Media/orwell)            (OWNER_REPO)
  --add-to-existing    Add a co-tenant runner for --repo onto the EXISTING CTIDs (ADD_EXISTING)
                       (reuses each box's Node/Python/chromium; own dir+service)
  --env-file PATH      Read GIT_TOKEN= from here                (ENV_FILE, default <repo>/data/.env)
  --allow-public-repo  DANGEROUS: proceed even if --repo is PUBLIC (any PR can run code on the
                       runners). Without it a public (or unverifiable) repo is refused.  (ALLOW_PUBLIC_REPO=1)
  --remove             Unregister each runner + destroy its LXC (REMOVE=1)
  --yes                Skip the confirmation prompt             (ORWELL_NONINTERACTIVE=1)
  -h, --help           This help

${C_BOLD}EXAMPLES${C_OFF}
  export GIT_TOKEN=github_pat_xxx
  $(basename "$0")                          # 6 runners, 2 vCPU / 3 GB / 20 GB each
  $(basename "$0") --count 4 --cores 4 --mem-mb 6144
  $(basename "$0") --remove --count 6 --ctid-base 9100

Verify in the GitHub UI: ${C_BOLD}${REPO_URL}/settings/actions/runners${C_OFF}
EOF
}

# ── Defaults (env overrides; flags override env) ────────────────────────────────────────────────
COUNT="${COUNT:-6}"
CORES="${CORES:-2}"
MEM_MB="${MEM_MB:-3072}"
DISK_GB="${DISK_GB:-20}"
CTID_BASE="${CTID_BASE:-9100}"
BRIDGE="${BRIDGE:-vmbr0}"
NET="${NET:-dhcp}"
GATEWAY="${GATEWAY:-}"
STORAGE="${STORAGE:-}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-}"
TEMPLATE="${TEMPLATE:-}"
NAME_PREFIX="${NAME_PREFIX:-}"       # derived per-repo AFTER flag parse
RUNNER_VERSION="${RUNNER_VERSION:-}"
GIT_TOKEN="${GIT_TOKEN:-}"
REG_TOKEN_IN="${REG_TOKEN_IN:-}"
REMOVE="${REMOVE:-0}"
ADD_EXISTING="${ADD_EXISTING:-0}"
ALLOW_PUBLIC_REPO="${ALLOW_PUBLIC_REPO:-0}"

# data/.env (git-ignored) sits at <repo>/data/.env; this script lives at <repo>/deploy/runners/.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo .)"
ENV_FILE="${ENV_FILE:-${SELF_DIR}/../../data/.env}"

# ── Parse flags ─────────────────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)            usage; exit 0 ;;
    --count)              COUNT="${2:?--count needs a value}"; shift 2 ;;
    --cores)              CORES="${2:?--cores needs a value}"; shift 2 ;;
    --mem-mb)             MEM_MB="${2:?--mem-mb needs a value}"; shift 2 ;;
    --disk-gb)            DISK_GB="${2:?--disk-gb needs a value}"; shift 2 ;;
    --ctid-base)          CTID_BASE="${2:?--ctid-base needs a value}"; shift 2 ;;
    --bridge)             BRIDGE="${2:?--bridge needs a value}"; shift 2 ;;
    --net)                NET="${2:?--net needs a value}"; shift 2 ;;
    --gateway)            GATEWAY="${2:?--gateway needs a value}"; shift 2 ;;
    --storage)            STORAGE="${2:?--storage needs a value}"; shift 2 ;;
    --template-storage)   TEMPLATE_STORAGE="${2:?--template-storage needs a value}"; shift 2 ;;
    --template)           TEMPLATE="${2:?--template needs a value}"; shift 2 ;;
    --name-prefix)        NAME_PREFIX="${2:?--name-prefix needs a value}"; shift 2 ;;
    --runner-version)     RUNNER_VERSION="${2:?--runner-version needs a value}"; shift 2 ;;
    --token)              GIT_TOKEN="${2:?--token needs a value}"; shift 2 ;;
    --reg-token)          REG_TOKEN_IN="${2:?--reg-token needs a value}"; shift 2 ;;
    --repo)               OWNER_REPO="${2:?--repo needs a value (owner/name)}"; shift 2 ;;
    --add-to-existing)    ADD_EXISTING=1; shift ;;
    --allow-public-repo)  ALLOW_PUBLIC_REPO=1; shift ;;
    --env-file)           ENV_FILE="${2:?--env-file needs a value}"; shift 2 ;;
    --remove)             REMOVE=1; shift ;;
    --yes|-y)             ORWELL_NONINTERACTIVE=1; shift ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# ── Repo-scoped derivation (AFTER flags, so --repo wins) ──────────────────────────────────────────
# Re-derive the repo URLs from the (possibly --repo-overridden) OWNER_REPO, and pick per-repo
# NAME_PREFIX / RUNNER_HOME defaults. The point: a co-tenant runner for a DIFFERENT repo on the same
# box gets its OWN install dir + runner name → its OWN systemd service, so it never clobbers the
# runner already there. Explicit --name-prefix / RUNNER_HOME env still win.
REPO_URL="https://github.com/${OWNER_REPO}"
API="https://api.github.com/repos/${OWNER_REPO}"
REPO_NAME="${OWNER_REPO##*/}"
if [[ "$OWNER_REPO" == "Psychout-Media/orwell" ]]; then
  NAME_PREFIX="${NAME_PREFIX:-orwell-runner}"
  RUNNER_HOME="${RUNNER_HOME:-/opt/actions-runner}"
else
  NAME_PREFIX="${NAME_PREFIX:-${REPO_NAME}-runner}"
  RUNNER_HOME="${RUNNER_HOME:-/opt/actions-runner-${REPO_NAME}}"
fi

# ── Host guards (mirror orwell.sh) ──────────────────────────────────────────────────────────────
[[ "$(id -u)" -eq 0 ]] || die "run this on the Proxmox host as root."
command -v pct   >/dev/null 2>&1 || die "this must run on a Proxmox VE host (pct not found)."
command -v pveam >/dev/null 2>&1 || die "this must run on a Proxmox VE host (pveam not found)."
command -v curl  >/dev/null 2>&1 || die "curl is required on the host (for the GitHub API)."

# ── Validate inputs ─────────────────────────────────────────────────────────────────────────────
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
for pair in "COUNT=$COUNT" "CORES=$CORES" "MEM_MB=$MEM_MB" "DISK_GB=$DISK_GB" "CTID_BASE=$CTID_BASE"; do
  name="${pair%%=*}"; val="${pair#*=}"
  is_uint "$val" || die "${name} must be a positive integer (got '${val}')."
done
(( COUNT >= 1 ))      || die "COUNT must be >= 1."
(( CORES >= 1 ))      || die "CORES must be >= 1."
(( MEM_MB >= 512 ))   || die "MEM_MB must be >= 512."
(( DISK_GB >= 4 ))    || die "DISK_GB must be >= 4."
(( CTID_BASE >= 100 ))|| die "CTID_BASE must be >= 100 (Proxmox reserves 0-99)."
[[ "$NET" == "dhcp" || "$NET" =~ / ]] || die "--net must be 'dhcp' or a CIDR (e.g. 192.168.1.50/24)."

# ── Resolve the PAT (env / flag, then data/.env). NEVER printed, NEVER passed into a container. ──
load_token() {
  [[ -n "$GIT_TOKEN" ]] && return 0
  if [[ -r "$ENV_FILE" ]]; then
    local t
    t="$(sed -n 's/^GIT_TOKEN=//p' "$ENV_FILE" | tail -n1 || true)"
    [[ -n "$t" ]] && { GIT_TOKEN="$t"; msg "using GIT_TOKEN from ${ENV_FILE}"; return 0; }
  fi
  return 1
}
# A pre-minted REGISTRATION TOKEN (--reg-token, copied from Settings → Actions → Runners → "New
# self-hosted runner") lets you provision with NO PAT at all — one such token registers many runners
# within its ~1h TTL. A PAT is then needed ONLY for --remove (to mint a remove-token).
if [[ -n "$REG_TOKEN_IN" && "$REMOVE" != "1" ]]; then
  msg "using a supplied --reg-token; no PAT needed for provisioning."
else
  load_token || die "no GitHub credential — either pass --reg-token <token> (from Settings → Actions → Runners → New self-hosted runner; no PAT, provisioning only), or set GIT_TOKEN / --token / GIT_TOKEN= in ${ENV_FILE} with repo + runner-registration scope."
fi

# Mint a registration ("registration-token") or removal ("remove-token") token via the REST API.
# The PAT is sent in an Authorization header only — never on a command line that lands in `ps`.
mint_token() {  # kind: registration|remove  -> prints the short-lived token, or dies
  local kind="$1" url body tok
  case "$kind" in
    registration) url="${API}/actions/runners/registration-token" ;;
    remove)       url="${API}/actions/runners/remove-token" ;;
    *) die "mint_token: bad kind '${kind}'" ;;
  esac
  body="$(curl -fsSL -X POST \
            -H "Authorization: Bearer ${GIT_TOKEN}" \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            "$url" 2>/dev/null || true)"
  # Parse the JSON {"token":"...","expires_at":"..."} without a jq dependency.
  tok="$(printf '%s' "$body" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  [[ -n "$tok" ]] || die "GitHub API did not return a ${kind} token — check the PAT scope (repo + admin:org/repo-admin) and that it can manage runners on ${OWNER_REPO}."
  printf '%s' "$tok"
}

# ── Public-repo guard ───────────────────────────────────────────────────────────────────────────
# A PR to a PUBLIC repo chooses its own `runs-on:`, so it can run arbitrary code on a self-hosted
# runner. Refuse unless the repo is verifiably private (or --allow-public-repo). Anything we cannot
# verify fails CLOSED. Not applied to --remove: tearing runners down must always work.
repo_visibility() {  # -> prints: public | private | unknown
  local resp code body
  # The PAT (if any) goes in via a curl config on stdin, never on a command line that lands in `ps`.
  resp="$( { [[ -n "$GIT_TOKEN" ]] && printf 'header = "Authorization: Bearer %s"\n' "$GIT_TOKEN" || true; } \
            | curl -sSL -K - -w '\n%{http_code}' -H "Accept: application/vnd.github+json" "$API" 2>/dev/null || true)"
  code="$(printf '%s' "$resp" | tail -n1)"
  body="$(printf '%s' "$resp" | sed '$d')"
  case "$code" in
    200) case "$(printf '%s' "$body" | sed -n 's/.*"private"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -n1)" in
           false) echo public ;;  true) echo private ;;  *) echo unknown ;;
         esac ;;
    # 404 is NOT proof of "private": a proxy, a misrouted/unavailable API or a typo'd repo all look the
    # same. Only an authenticated 200 with "private": true counts, so fail closed.
    404) echo unknown ;;
    *)   echo unknown ;;
  esac
}
require_non_public_repo() {
  if [[ "$ALLOW_PUBLIC_REPO" == "1" ]]; then
    warn "--allow-public-repo: skipping the public-repo check for ${OWNER_REPO}. Any PR can run code on these runners."
    return 0
  fi
  case "$(repo_visibility)" in
    private) ;;
    public)  die "${OWNER_REPO} is PUBLIC. Refusing: a pull request picks its own runner and could run arbitrary code on these self-hosted boxes. Use GitHub-hosted runners, or pass --allow-public-repo if you accept that risk." ;;
    *)       die "could not verify that ${OWNER_REPO} is private (GitHub API unreachable, rate-limited, or no access). Refusing; fix that, or pass --allow-public-repo to skip the check." ;;
  esac
}

# ── Template resolution (mirror orwell.sh helpers; Ubuntu by default for the Playwright deps) ────
storage_for() { pvesm status --content "$1" 2>/dev/null | awk 'NR>1 && $3=="active"{print $1; exit}' || true; }
available_ubuntu() {
  pveam available --section system 2>/dev/null | awk '{print $2}' \
    | grep -E '^ubuntu-(24|22)\.[0-9]+-standard' | sort -V || true
}
STORAGE="${STORAGE:-$(storage_for rootdir)}";                   STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-$(storage_for vztmpl)}";  TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"

TEMPLATE_NAME=""
if [[ -n "$TEMPLATE" ]]; then
  if [[ "$TEMPLATE" == *:vztmpl/* ]]; then
    TEMPLATE_STORAGE="${TEMPLATE%%:*}"; TEMPLATE_NAME="${TEMPLATE##*/}"
  else
    TEMPLATE_NAME="${TEMPLATE##*/}"
  fi
fi
ensure_template() {
  if [[ -z "$TEMPLATE_NAME" ]]; then
    msg "resolving newest ubuntu-standard template"
    pveam update >/dev/null 2>&1 || true
    TEMPLATE_NAME="$(available_ubuntu | tail -n1)"
  fi
  if [[ -z "$TEMPLATE_NAME" ]]; then  # offline fallback: newest already on the template storage
    TEMPLATE_NAME="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '{print $1}' \
      | sed 's#.*/##' | grep -E '^ubuntu-(24|22)\.[0-9]+-standard' | sort -V | tail -n1 || true)"
  fi
  [[ -n "$TEMPLATE_NAME" ]] || die "no ubuntu-standard template available or downloaded — check internet / 'pveam available', or pass --template."
  if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -qF "$TEMPLATE_NAME"; then
    msg "downloading template ${TEMPLATE_NAME} → ${TEMPLATE_STORAGE} (first run only)"
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_NAME"
  fi
  TEMPLATE="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_NAME}"
}

ct_exists()  { pct status "$1" >/dev/null 2>&1; }
ct_running() { [[ "$(pct status "$1" 2>/dev/null)" == *running* ]]; }

# Push a small payload into the container as a 0600 file (never on a `pct exec` command line, so it
# can't appear in host `ps` — the same rule orwell.sh uses for GIT_TOKEN). Prints the in-CT path.
push_secret() {  # ctid content dest-path
  local ctid="$1" content="$2" dest="$3" tmp
  tmp="$(mktemp /tmp/orwell-runner-XXXXXX)"; chmod 600 "$tmp"
  printf '%s' "$content" > "$tmp"
  pct push "$ctid" "$tmp" "$dest" --perms 0600
  rm -f "$tmp"
  printf '%s' "$dest"
}

wait_for_net() {  # ctid -> echoes the first IP (or "<container-ip>")
  local ctid="$1" ip="" _
  for _ in $(seq 1 30); do
    ip="$(pct exec "$ctid" -- bash -c "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)"
    [[ -n "$ip" ]] && break
    sleep 2
  done
  printf '%s' "${ip:-<container-ip>}"
}

# The in-container provisioner (templated per runner; runs over `pct exec`). Installs deps, the
# Playwright chromium system libraries, Node 22, Python 3.12 + venv, the runner agent; registers
# non-interactively as a NON-root user; installs the auto-restarting systemd service.
install_in_container() {  # ctid runner-name token-path
  local ctid="$1" name="$2" tokpath="$3"
  pct exec "$ctid" -- env \
      RUNNER_USER="$RUNNER_USER" RUNNER_HOME="$RUNNER_HOME" REPO_URL="$REPO_URL" \
      RUNNER_NAME="$name" RUNNER_LABELS="$RUNNER_LABELS" RUNNER_VERSION="${RUNNER_VERSION:-}" \
      TOKEN_PATH="$tokpath" \
      bash -s <<'INCT'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "▸ apt deps + Playwright chromium system libraries"
apt-get update -qq || { sleep 5; apt-get update -qq; }
# Base toolchain + the chromium runtime libs Playwright needs to launch headless. We name the apt
# set explicitly (rather than only `playwright install-deps`) so the browser tests get their libs
# even before a venv exists, and `install-deps` later is a no-op top-up.
apt-get install -y -qq \
  curl ca-certificates gnupg git tar jq sudo build-essential \
  python3 python3-venv python3-pip \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
  libxkbcommon0 libatspi2.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 fonts-liberation \
  2>/dev/null \
  || apt-get install -y -qq \
       curl ca-certificates gnupg git tar jq sudo build-essential \
       python3 python3-venv python3-pip \
       libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
       libxkbcommon0 libatspi2.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
       libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-liberation

echo "▸ Node 22 (NodeSource apt repo; signed-by, no curl|bash as root)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  install -d -m 755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi

echo "▸ non-root runner user '${RUNNER_USER}'"
id -u "$RUNNER_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$RUNNER_USER"
install -d -o "$RUNNER_USER" -g "$RUNNER_USER" "$RUNNER_HOME"

echo "▸ Playwright chromium top-up (idempotent; non-fatal)"
python3 -m pip install --quiet --break-system-packages playwright >/dev/null 2>&1 || true
python3 -m playwright install-deps chromium >/dev/null 2>&1 || true

echo "▸ download the actions/runner agent"
ARCH="linux-x64"
VER="${RUNNER_VERSION:-}"
if [[ -z "$VER" ]]; then
  # Resolve the latest release tag (e.g. v2.319.1 -> 2.319.1). Fall back to a known-good pin.
  VER="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest 2>/dev/null \
         | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)"
  VER="${VER:-2.319.1}"
fi
TARBALL="actions-runner-${ARCH}-${VER}.tar.gz"
URL="https://github.com/actions/runner/releases/download/v${VER}/${TARBALL}"
if [[ ! -x "${RUNNER_HOME}/config.sh" ]]; then
  curl -fsSL -o "/tmp/${TARBALL}" "$URL"
  tar -xzf "/tmp/${TARBALL}" -C "$RUNNER_HOME"
  rm -f "/tmp/${TARBALL}"
fi
# installdependencies.sh tops up any remaining runner libs (idempotent; non-fatal here).
[[ -x "${RUNNER_HOME}/bin/installdependencies.sh" ]] && bash "${RUNNER_HOME}/bin/installdependencies.sh" >/dev/null 2>&1 || true
chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_HOME"

REG_TOKEN="$(cat "$TOKEN_PATH")"; rm -f "$TOKEN_PATH"

# An --ephemeral runner de-registers itself after its one job but leaves its systemd unit behind, and
# svc.sh install refuses an existing unit. Drop any leftover service before (re-)registering.
if [[ -x "${RUNNER_HOME}/svc.sh" ]]; then
  (cd "${RUNNER_HOME}" && ./svc.sh stop >/dev/null 2>&1 || true; ./svc.sh uninstall >/dev/null 2>&1 || true)
fi

echo "▸ register runner '${RUNNER_NAME}' (labels: ${RUNNER_LABELS}) — --replace is idempotent; --ephemeral = one job, then de-registered"
sudo -u "$RUNNER_USER" -H bash -c "cd '${RUNNER_HOME}' && ./config.sh \
  --url '${REPO_URL}' \
  --token '${REG_TOKEN}' \
  --name '${RUNNER_NAME}' \
  --labels '${RUNNER_LABELS}' \
  --work _work \
  --unattended --replace --ephemeral"
unset REG_TOKEN

echo "▸ install + start the systemd service (svc.sh)"
# svc.sh writes /etc/systemd/system/actions.runner.*.service (boot-enabled, restarts on crash). The
# runner is --ephemeral: after its ONE job it de-registers itself, so re-run this script to refill.
cd "$RUNNER_HOME"
./svc.sh install "$RUNNER_USER"
./svc.sh start
echo "✓ ${RUNNER_NAME} online"
INCT
}

# ── Per-runner net0 (mirror orwell.sh; static = base IP + (i-1) on the last octet) ───────────────
net0_for() {  # index
  local i="$1"
  if [[ "$NET" == "dhcp" ]]; then
    printf 'name=eth0,bridge=%s,ip=dhcp' "$BRIDGE"
    return
  fi
  # Static CIDR base, e.g. 192.168.1.50/24 -> runner i gets .(.50 + i-1).
  local ip="${NET%%/*}" mask="${NET##*/}" pre last addr
  pre="${ip%.*}"; last="${ip##*.}"
  addr="${pre}.$(( last + i - 1 ))/${mask}"
  printf 'name=eth0,bridge=%s,ip=%s%s' "$BRIDGE" "$addr" "${GATEWAY:+,gw=${GATEWAY}}"
}

runner_name_for() { printf '%s-%s' "$NAME_PREFIX" "$1"; }

# ── Modes ───────────────────────────────────────────────────────────────────────────────────────
declare -a SUMMARY=()

do_remove() {
  msg "REMOVE: unregister + destroy ${COUNT} runner LXC(s) from CTID ${CTID_BASE}"
  local i ctid name rmtok tokpath
  for (( i=1; i<=COUNT; i++ )); do
    ctid=$(( CTID_BASE + i - 1 )); name="$(runner_name_for "$i")"
    if ! ct_exists "$ctid"; then
      SUMMARY+=("${ctid}  ${name}  absent (skipped)")
      continue
    fi
    msg "removing ${name} (CTID ${ctid})"
    if ct_running "$ctid"; then
      # Best-effort: unregister cleanly so GitHub drops the runner, not just orphans it offline.
      rmtok="$(mint_token remove 2>/dev/null || true)"
      if [[ -n "$rmtok" ]]; then
        tokpath="$(push_secret "$ctid" "$rmtok" /tmp/orwell-runner-remove)"; unset rmtok
        pct exec "$ctid" -- bash -c "cd '${RUNNER_HOME}' 2>/dev/null && ./svc.sh stop 2>/dev/null; \
          ./svc.sh uninstall 2>/dev/null; \
          sudo -u '${RUNNER_USER}' -H bash -c \"cd '${RUNNER_HOME}' && ./config.sh remove --token \$(cat '${tokpath}')\" 2>/dev/null; \
          rm -f '${tokpath}'" 2>/dev/null \
          || warn "${name}: in-container unregister failed (will still destroy the LXC; remove it in the GitHub UI if it lingers)"
      else
        warn "${name}: could not mint a remove token (PAT/scope?) — destroying anyway; remove it in the GitHub UI if it lingers"
      fi
      pct stop "$ctid" >/dev/null 2>&1 || true
    fi
    pct destroy "$ctid" >/dev/null 2>&1 && SUMMARY+=("${ctid}  ${name}  destroyed") \
      || { warn "${name}: pct destroy failed"; SUMMARY+=("${ctid}  ${name}  destroy FAILED"); }
  done
}

do_provision() {
  ensure_template
  msg "config: COUNT=${COUNT} CORES=${CORES} MEM_MB=${MEM_MB} DISK_GB=${DISK_GB} CTID_BASE=${CTID_BASE}"
  msg "        STORAGE=${STORAGE} TEMPLATE=${TEMPLATE} BRIDGE=${BRIDGE} NET=${NET}"
  msg "        repo=${OWNER_REPO} labels=${RUNNER_LABELS} prefix=${NAME_PREFIX}"

  if [[ -z "${ORWELL_NONINTERACTIVE:-}" && -t 0 && -t 1 ]] && command -v whiptail >/dev/null 2>&1; then
    whiptail --title "$TITLE" --yesno \
      "Provision ${COUNT} GitHub Actions runner LXC(s) for ${OWNER_REPO}?\n\n  CTIDs ${CTID_BASE}..$(( CTID_BASE + COUNT - 1 ))\n  ${CORES} cores · ${MEM_MB} MB · ${DISK_GB} GB each\n  storage ${STORAGE} · bridge ${BRIDGE} · net ${NET}\n  label: ${RUNNER_LABELS}\n\nProceed?" 18 72 \
      || die "cancelled."
  fi

  local i ctid name net0 regtok tokpath ip
  for (( i=1; i<=COUNT; i++ )); do
    ctid=$(( CTID_BASE + i - 1 )); name="$(runner_name_for "$i")"; net0="$(net0_for "$i")"
    echo
    msg "── runner ${i}/${COUNT}: ${name} (CTID ${ctid}) ──"

    if ct_exists "$ctid"; then
      # Idempotent: re-register the existing container in place rather than erroring out. config.sh
      # --replace cleanly supersedes a prior registration of the same name.
      msg "CTID ${ctid} exists — re-provisioning in place (idempotent --replace)"
      ct_running "$ctid" || pct start "$ctid"
    else
      msg "creating LXC ${ctid}"
      pct create "$ctid" "$TEMPLATE" \
        --hostname "$name" \
        --cores "$CORES" --memory "$MEM_MB" \
        --rootfs "${STORAGE}:${DISK_GB}" \
        --net0 "$net0" \
        --features nesting=1 \
        --unprivileged 1 \
        --onboot 1
      pct start "$ctid"
    fi

    ip="$(wait_for_net "$ctid")"
    msg "container network: ${ip}"

    # Registration token, pushed in as a 0600 file. With --reg-token, reuse the operator-supplied
    # one for every runner (a single UI token registers many within its TTL); otherwise mint a fresh
    # short-lived one per runner from the PAT.
    if [[ -n "$REG_TOKEN_IN" ]]; then regtok="$REG_TOKEN_IN"; else regtok="$(mint_token registration)"; fi
    tokpath="$(push_secret "$ctid" "$regtok" /tmp/orwell-runner-token)"; unset regtok

    install_in_container "$ctid" "$name" "$tokpath"
    SUMMARY+=("${ctid}  ${name}  ${ip}  online")
  done
}

# Add a SECOND (co-tenant) runner for --repo onto the EXISTING runner LXCs (CTID_BASE..+COUNT).
# Reuses each box's already-installed Node/Python/chromium; installs a fresh runner into a per-repo
# RUNNER_HOME with a per-repo name, so it co-exists with the runner already there (own svc).
do_add_existing() {
  msg "ADD co-tenant runners for ${OWNER_REPO} onto EXISTING CTIDs ${CTID_BASE}..$(( CTID_BASE + COUNT - 1 ))"
  msg "    home=${RUNNER_HOME} prefix=${NAME_PREFIX} labels=${RUNNER_LABELS}"
  if [[ -z "${ORWELL_NONINTERACTIVE:-}" && -t 0 && -t 1 ]] && command -v whiptail >/dev/null 2>&1; then
    whiptail --title "$TITLE" --yesno \
      "Add a SECOND runner for ${OWNER_REPO} to ${COUNT} EXISTING LXC(s)?\n\n  CTIDs ${CTID_BASE}..$(( CTID_BASE + COUNT - 1 ))\n  install dir ${RUNNER_HOME} · label ${RUNNER_LABELS}\n\nEach co-exists with the runner already on the box (own dir + service).\nProceed?" 16 72 \
      || die "cancelled."
  fi
  local i ctid name regtok tokpath ip
  for (( i=1; i<=COUNT; i++ )); do
    ctid=$(( CTID_BASE + i - 1 )); name="$(runner_name_for "$i")"
    echo
    msg "── co-tenant ${i}/${COUNT}: ${name} (CTID ${ctid}) ──"
    if ! ct_exists "$ctid"; then
      warn "CTID ${ctid} does not exist — skipping (provision the base runners first)"
      SUMMARY+=("${ctid}  ${name}  absent (skipped)")
      continue
    fi
    ct_running "$ctid" || pct start "$ctid"
    ip="$(wait_for_net "$ctid")"
    if [[ -n "$REG_TOKEN_IN" ]]; then regtok="$REG_TOKEN_IN"; else regtok="$(mint_token registration)"; fi
    tokpath="$(push_secret "$ctid" "$regtok" /tmp/orwell-runner-token)"; unset regtok
    install_in_container "$ctid" "$name" "$tokpath"
    SUMMARY+=("${ctid}  ${name}  ${ip}  online")
  done
}

# ── Run ─────────────────────────────────────────────────────────────────────────────────────────
[[ "$REMOVE" == "1" ]] || require_non_public_repo
if [[ "$REMOVE" == "1" ]]; then
  do_remove
elif [[ "$ADD_EXISTING" == "1" ]]; then
  do_add_existing
else
  do_provision
fi

# ── Summary ─────────────────────────────────────────────────────────────────────────────────────
echo
echo "${C_GRN}╶───────────────────────────────────────────────────────────╴${C_OFF}"
if [[ "$REMOVE" == "1" ]]; then
  echo "  ${C_BOLD}${C_GRN}runner removal complete${C_OFF}"
elif [[ "$ADD_EXISTING" == "1" ]]; then
  echo "  ${C_BOLD}${C_GRN}${COUNT} co-tenant runner(s) added for ${OWNER_REPO}${C_OFF}"
else
  echo "  ${C_BOLD}${C_GRN}${COUNT} runner(s) provisioned for ${OWNER_REPO}${C_OFF}"
fi
printf '  %-6s %-22s %-16s %s\n' "CTID" "NAME" "IP" "STATUS"
for row in "${SUMMARY[@]}"; do
  # row = "ctid  name  [ip]  status"
  echo "  ${row}"
done
echo
echo "  ${C_DIM}verify:${C_OFF}  ${REPO_URL}/settings/actions/runners"
echo "          ${C_DIM}(Settings → Actions → Runners — each shows 'Idle' with the '${RUNNER_LABELS}' label)${C_OFF}"
echo "  ${C_DIM}enter:${C_OFF}   pct enter <CTID>    ${C_DIM}status:${C_OFF} systemctl status 'actions.runner.*'"
echo "${C_GRN}╶───────────────────────────────────────────────────────────╴${C_OFF}"
